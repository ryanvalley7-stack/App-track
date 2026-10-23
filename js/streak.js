// Photo streak: consecutive local days with at least one photo.

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
