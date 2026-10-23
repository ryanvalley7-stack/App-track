// Month-based periods for comparing ranges of photos. A period is an inclusive
// range of months: { from: 'YYYY-MM', to: 'YYYY-MM' }.
import { dayKey } from './reminders.js';

const pad = (n) => String(n).padStart(2, '0');

export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function parse(key) {
  const [y, m] = key.split('-').map(Number);
  return [y, m - 1];
}

// Every month from `from` to `to`, inclusive.
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = parse(from);
  const [ty, tm] = parse(to);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m + 1)}`);
    if (++m === 12) { m = 0; y++; }
  }
  return out;
}

// [start, end) in local time.
export function periodBounds({ from, to }) {
  const [fy, fm] = parse(from);
  const [ty, tm] = parse(to);
  return [new Date(fy, fm, 1).getTime(), new Date(ty, tm + 1, 1).getTime()];
}

// Photos inside the period, oldest first, so [0] is the one closest to its start.
export function photosInPeriod(photos, period) {
  const [start, end] = periodBounds(period);
  return photos.filter((p) => p.takenAt >= start && p.takenAt < end).sort((a, b) => a.takenAt - b.takenAt);
}

// Average bodyweight, averaging each day first so a day with several
// photos doesn't count more than a day with one.
export function avgWeight(photos, weightOf) {
  const byDay = new Map();
  for (const p of photos) {
    const w = weightOf(p);
    if (w == null) continue;
    const k = dayKey(p.takenAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(w);
  }
  if (!byDay.size) return null;
  const means = [...byDay.values()].map((ws) => ws.reduce((a, b) => a + b, 0) / ws.length);
  return { avg: means.reduce((a, b) => a + b, 0) / means.length, days: byDay.size };
}

export function monthLabel(key, opts = { month: 'short', year: 'numeric' }) {
  const [y, m] = parse(key);
  return new Date(y, m, 1).toLocaleDateString(undefined, opts);
}

export function periodLabel({ from, to }) {
  if (from === to) return monthLabel(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthLabel(from, { month: 'short' })} – ${monthLabel(to)}`;
  return `${monthLabel(from)} – ${monthLabel(to)}`;
}

// Keeps from <= to.
export function normalize(period) {
  return period.from <= period.to ? period : { from: period.to, to: period.from };
}
