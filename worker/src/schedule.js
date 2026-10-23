// When a reminder is due and what it says. Pure functions, so they can be
// tested with fixed times.

export const WINDOW_MINUTES = 15; // matches the cron schedule in wrangler.toml

// Local calendar day ("YYYY-MM-DD") and minutes past midnight in an IANA time zone.
export function localParts(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// If the reminder time falls in the cron window ending at `now`
// (reminder <= now < reminder + WINDOW_MINUTES, local time), returns the local
// day it belongs to; otherwise null. Each reminder time is due in exactly one window.
export function dueDay(record, now) {
  const [h, m] = record.time.split(':').map(Number);
  const { minutes } = localParts(now, record.timezone);
  const diff = (minutes - (h * 60 + m) + 1440) % 1440;
  if (diff >= WINDOW_MINUTES) return null;
  return localParts(now - diff * 60000, record.timezone).day;
}

export function previousDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// lastPhotoDay/streak come from the app: the latest day with a photo and the
// streak of consecutive days ending there.
// (A photo already logged today only matters for test notifications; the
// daily reminder is skipped on those days.)
export function reminderMessage(record, today) {
  if (record.lastPhotoDay === today && record.streak > 0) {
    return `Progress pic time. Day ${record.streak} streak.`;
  }
  if (record.lastPhotoDay === previousDay(today) && record.streak > 0) {
    return `Progress pic time. Day ${record.streak + 1} streak.`;
  }
  return 'Progress pic time. Start a new streak today.';
}
