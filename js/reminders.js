// Streak tracking and the daily calendar reminder. There's no server, so the
// reminder is a repeating .ics event that the phone's calendar alerts on.

const pad = (n) => String(n).padStart(2, '0');

// Local calendar day as YYYY-MM-DD.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + delta).getTime());
}

// current: consecutive days with a photo ending today, or yesterday if today's
// photo isn't taken yet (the streak is still alive until the day ends).
export function streaks(photos, now = Date.now()) {
  const days = new Set(photos.map((p) => dayKey(p.takenAt)));
  const today = dayKey(now);
  const doneToday = days.has(today);

  let current = 0;
  for (let d = doneToday ? today : shiftDay(today, -1); days.has(d); d = shiftDay(d, -1)) current++;

  let best = 0;
  for (const d of days) {
    if (days.has(shiftDay(d, -1))) continue; // only count from the start of each run
    let run = 0;
    for (let x = d; days.has(x); x = shiftDay(x, 1)) run++;
    best = Math.max(best, run);
  }
  return { current, best, doneToday };
}

function icsText(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545: lines over 75 octets are folded with CRLF + space.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const len = enc.encode(ch).length;
    if (bytes + len > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// time: "HH:MM". The start time is "floating" (no time zone), so the alert
// fires at that local time wherever the phone is.
export function buildIcs({ time, url, now = new Date() }) {
  const [hh, mm] = time.split(':').map(Number);
  const start = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(hh)}${pad(mm)}00`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gym Progress//Daily reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:daily-photo-reminder@gym-progress.app',
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${start}`,
    'DURATION:PT5M',
    'RRULE:FREQ=DAILY',
    `SUMMARY:${icsText('📸 Progress photo')}`,
    `DESCRIPTION:${icsText(`Time for today's progress photo. Open Gym Progress from your home screen.\n\n${url}`)}`,
    `URL:${url}`,
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText('Time for your progress photo')}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
