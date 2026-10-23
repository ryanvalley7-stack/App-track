import test from 'node:test';
import assert from 'node:assert/strict';
import { dueDay, localParts, previousDay, reminderMessage } from '../src/schedule.js';

const LA = 'America/Los_Angeles';
const at = (iso) => Date.parse(iso);

test('localParts converts to the subscriber time zone', () => {
  assert.deepEqual(localParts(at('2026-10-23T14:00:00Z'), LA), { day: '2026-10-23', minutes: 7 * 60 });
  assert.deepEqual(localParts(at('2026-10-24T06:30:00Z'), LA), { day: '2026-10-23', minutes: 23 * 60 + 30 });
});

test('a reminder is due in exactly one 15-minute window', () => {
  const rec = { time: '07:05', timezone: LA };
  const slots = [];
  for (let t = at('2026-10-23T00:00:00Z'); t < at('2026-10-24T12:00:00Z'); t += 15 * 60000) {
    if (dueDay(rec, t)) slots.push(new Date(t).toISOString());
  }
  // 07:05 PDT = 14:05Z, first window ending at or after it is 14:15Z.
  assert.deepEqual(slots, ['2026-10-23T14:15:00.000Z']);
});

test('on-the-boundary times fire in their own window', () => {
  assert.equal(dueDay({ time: '07:00', timezone: LA }, at('2026-10-23T14:00:00Z')), '2026-10-23');
  assert.equal(dueDay({ time: '07:00', timezone: LA }, at('2026-10-23T13:45:00Z')), null);
});

test('follows daylight saving time', () => {
  // Nov 1 2026: PDT → PST. 07:00 local is 14:00Z before and 15:00Z after.
  assert.equal(dueDay({ time: '07:00', timezone: LA }, at('2026-10-31T14:00:00Z')), '2026-10-31');
  assert.equal(dueDay({ time: '07:00', timezone: LA }, at('2026-11-02T15:00:00Z')), '2026-11-02');
  assert.equal(dueDay({ time: '07:00', timezone: LA }, at('2026-11-02T14:00:00Z')), null);
});

test('a late-night reminder caught after midnight belongs to the previous day', () => {
  // 23:55 reminder, window ending 00:00 local (07:00Z during PDT) → diff 5 min.
  assert.equal(dueDay({ time: '23:55', timezone: LA }, at('2026-10-24T07:00:00Z')), '2026-10-23');
});

test('previousDay crosses month and year boundaries', () => {
  assert.equal(previousDay('2026-03-01'), '2026-02-28');
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
});

test('message shows the streak day the next photo would make', () => {
  assert.equal(reminderMessage({ lastPhotoDay: '2026-10-22', streak: 11 }, '2026-10-23'), 'Progress pic time. Day 12 streak.');
  assert.equal(reminderMessage({ lastPhotoDay: '2026-10-20', streak: 11 }, '2026-10-23'), 'Progress pic time. Start a new streak today.');
  assert.equal(reminderMessage({ lastPhotoDay: null, streak: 0 }, '2026-10-23'), 'Progress pic time. Start a new streak today.');
  assert.equal(reminderMessage({ lastPhotoDay: '2026-10-23', streak: 12 }, '2026-10-23'), 'Progress pic time. Day 12 streak.');
});
