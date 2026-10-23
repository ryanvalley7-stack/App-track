// Month-based periods, used to group the gallery by month. A period is an
// inclusive range of months: { from: 'YYYY-MM', to: 'YYYY-MM' }.
import { dayKey } from './streak.js';

const pad = (n) => String(n).padStart(2, '0');

export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function parse(key) {
  const [y, m] = key.split('-').map(Number);
  return [y, m - 1];
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
