import * as db from './db.js';
import { createZip, readZip } from './zip.js';
import { dayKey, streaks } from './streak.js';
import * as push from './push.js';
import { TIPS } from './guide.js';
import { monthKey, monthsBetween, photosInPeriod, avgWeight, monthLabel, periodLabel, normalize } from './periods.js';

const POSES = [
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
  { id: 'back', label: 'Back' },
  { id: 'flex', label: 'Flex' },
];
const MAX_DIM = 1600;
const THUMB_DIM = 480;
const KG_PER_LB = 0.45359237;

const state = {
  photos: [],          // sorted oldest → newest
  view: 'compare',
  pose: 'front',
  galleryPose: 'all',
  compare: {
    kind: readPref('compareKind', 'dates'), // dates | periods | timeline
    beforeId: null,
    afterId: null,
    mode: 'side',        // side | slider
    split: 50,
    periodKind: 'month', // month | custom
    periods: null,       // { before: {from, to}, after: {from, to} } once picked; null = default per pose
    periodPick: {},      // side → photo id chosen inside the period
    timeline: null,      // selected month keys; null = default per pose
  },
  unit: readPref('unit', 'lb'),
  lastBackup: Number(readPref('lastBackup', 0)),
  reminderTime: readPref('reminderTime', '07:00'),
  backStack: [],       // views to return to from settings/tips
};

// Pre-camera checklist: shown once per app open unless skipped for today or turned off.
const guide = { seen: false, checked: new Set() };

const camera = { stream: null, facing: 'user', timer: 0, grid: true, ghost: 0.35, busy: false };
const urls = new Map(); // photo id -> { full, thumb } object URLs

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');

// ---------- helpers ----------

function readPref(key, fallback) {
  try { return localStorage.getItem(`gp:${key}`) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(`gp:${key}`, value); } catch { /* storage unavailable */ }
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ms, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Date(ms).toLocaleDateString(undefined, opts);
}

function toDateInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDateInput(value, fallbackMs) {
  if (!value) return fallbackMs;
  if (value === toDateInput(fallbackMs)) return fallbackMs;
  return new Date(`${value}T12:00:00`).getTime();
}

function weightIn(photo, unit = state.unit) {
  if (photo.weight == null) return null;
  if (photo.unit === unit) return photo.weight;
  return unit === 'kg' ? photo.weight * KG_PER_LB : photo.weight / KG_PER_LB;
}

function fmtWeight(photo) {
  const w = weightIn(photo);
  return w == null ? '' : `${Math.round(w * 10) / 10} ${state.unit}`;
}

function poseLabel(id) {
  return POSES.find((p) => p.id === id)?.label ?? id;
}

function urlFor(photo, kind = 'full') {
  let entry = urls.get(photo.id);
  if (!entry) urls.set(photo.id, (entry = {}));
  entry[kind] ??= URL.createObjectURL(kind === 'thumb' ? photo.thumb ?? photo.blob : photo.blob);
  return entry[kind];
}

function dropUrls(id) {
  const entry = urls.get(id);
  if (!entry) return;
  Object.values(entry).forEach((u) => URL.revokeObjectURL(u));
  urls.delete(id);
}

function photosFor(pose) {
  return state.photos.filter((p) => p.pose === pose);
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function resizeBlob(blob, maxDim, quality) {
  const src = URL.createObjectURL(blob);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, quality);
  } finally {
    URL.revokeObjectURL(src);
  }
}

// Draw an image into a box like CSS object-fit: cover.
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.videoWidth;
  const ih = img.naturalHeight || img.videoHeight;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function poseChips(active, { includeAll = false, action = 'pose' } = {}) {
  const opts = includeAll ? [{ id: 'all', label: 'All' }, ...POSES] : POSES;
  return `<div class="chips" role="tablist">${opts.map((p) => {
    const count = p.id === 'all' ? state.photos.length : photosFor(p.id).length;
    return `<button class="chip ${p.id === active ? 'active' : ''}" data-${action}="${p.id}" role="tab" aria-selected="${p.id === active}">
      ${p.label}${count ? `<span class="count">${count}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

// ---------- data ----------

async function reload() {
  state.photos = (await db.getAll()).sort((a, b) => a.takenAt - b.takenAt);
}

async function savePhoto({ blob, pose, takenAt, weight, note }) {
  const thumb = await resizeBlob(blob, THUMB_DIM, 0.8);
  const record = { pose, takenAt, weight, unit: state.unit, note, blob, thumb, createdAt: Date.now() };
  const id = await db.add(record);
  await reload();
  syncPush();
  return id;
}

async function deletePhoto(id) {
  await db.remove(id);
  dropUrls(id);
  if (state.compare.beforeId === id) state.compare.beforeId = null;
  if (state.compare.afterId === id) state.compare.afterId = null;
  await reload();
  syncPush();
}

// ---------- navigation ----------

function go(name, { isBack = false } = {}) {
  if (state.view === 'capture' && name !== 'capture') stopCamera();
  if (name !== 'settings' && name !== 'tips') state.backStack = [];
  else if (!isBack && state.view !== name) state.backStack.push(state.view);
  state.view = name;
  window.scrollTo(0, 0);
  document.querySelectorAll('.tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  render();
}

function render() {
  view.dataset.view = state.view;
  $('#backupBtn .dot').hidden = !needsBackup();
  if (state.view === 'compare') renderCompare();
  else if (state.view === 'capture') renderCapture();
  else if (state.view === 'settings') renderSettings();
  else if (state.view === 'tips') renderTips();
  else renderGallery();
}

// ---------- streak & today banner ----------

function homeHeader() {
  if (!state.photos.length) return '';
  const { current, best, doneToday } = streaks(state.photos);
  const showBanner = !doneToday && readPref('bannerDismissed', '') !== dayKey(Date.now());
  return `
    <div class="streak ${doneToday ? 'done' : ''}">
      <span class="flame" aria-hidden="true">${current ? '🔥' : '💤'}</span>
      <div class="streak-text">
        <strong>${current ? `${current}-day streak` : 'No streak yet'}</strong>
        <span>${doneToday ? 'Today’s photo is done ✓' : current ? 'Take today’s photo to keep it going' : 'Take a photo today to start one'}${best > current ? ` · Best ${best}` : ''}</span>
      </div>
    </div>
    ${showBanner ? `
    <div class="today-banner" role="status">
      <div><strong>No photo yet today</strong>
        <span>${current ? `Don’t lose your ${current}-day streak.` : 'A quick photo keeps your progress on track.'}</span></div>
      <button class="btn primary sm" data-go="capture">Take photo</button>
      <button class="icon-btn sm" data-banner-dismiss aria-label="Dismiss for today">✕</button>
    </div>` : ''}`;
}

// ---------- compare ----------

const KINDS = [['dates', 'Dates'], ['periods', 'Periods'], ['timeline', 'Timeline']];
const round1 = (n) => Math.round(n * 10) / 10;

function fmtDelta(d) {
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} ${state.unit}`;
}

function fmtAvg(a) {
  return a ? `${round1(a.avg)} ${state.unit}` : '—';
}

function resolveCompare() {
  const list = photosFor(state.pose);
  const ids = new Set(list.map((p) => p.id));
  const c = state.compare;
  if (!ids.has(c.beforeId)) c.beforeId = list[0]?.id ?? null;
  if (!ids.has(c.afterId)) c.afterId = list[list.length - 1]?.id ?? null;
  return {
    list,
    before: list.find((p) => p.id === c.beforeId),
    after: list.find((p) => p.id === c.afterId),
  };
}

function datesSides() {
  const { before, after } = resolveCompare();
  return [before, after].map((p, i) => ({
    side: i ? 'after' : 'before',
    photo: p,
    title: fmtDate(p.takenAt),
    sub: fmtWeight(p),
    short: fmtDate(p.takenAt, { month: 'short', day: 'numeric' }),
  }));
}

// For each period: the pose's photos inside it, the chosen photo (closest to
// the period's start unless one was picked), and the average bodyweight.
function periodSides(before, after, picks = {}) {
  const list = photosFor(state.pose);
  return [['before', before], ['after', after]].map(([side, period]) => {
    const inside = photosInPeriod(list, period);
    const photo = inside.find((p) => p.id === picks[side]) ?? inside[0] ?? null;
    const avg = avgWeight(photosInPeriod(state.photos, period), (p) => weightIn(p));
    const label = periodLabel(period);
    return {
      side, period, inside, photo, avg,
      title: label,
      short: label,
      sub: photo ? [`Photo ${fmtDate(photo.takenAt, { month: 'short', day: 'numeric' })}`, avg && `Avg ${fmtAvg(avg)}`].filter(Boolean).join(' · ') : '',
      empty: `No ${poseLabel(state.pose).toLowerCase()} photo in ${label}`,
    };
  });
}

// Until the user picks periods, default to the first and last month with a photo of this pose.
function currentPeriods() {
  const c = state.compare;
  if (c.periods) return c.periods;
  const list = photosFor(state.pose);
  const a = monthKey(list[0].takenAt);
  const b = monthKey(list[list.length - 1].takenAt);
  return { before: { from: a, to: a }, after: { from: b, to: b } };
}

function timelineMonths() {
  const list = photosFor(state.pose);
  if (!list.length) return [];
  return monthsBetween(monthKey(list[0].takenAt), monthKey(list[list.length - 1].takenAt)).map((key) => {
    const period = { from: key, to: key };
    const inside = photosInPeriod(list, period);
    return { key, period, photo: inside[0] ?? null, count: inside.length, avg: avgWeight(photosInPeriod(state.photos, period), (p) => weightIn(p)) };
  });
}

// Selected months, oldest first. Defaults to the first and last month with a photo.
function timelineSelection(months) {
  const withPhoto = months.filter((m) => m.photo).map((m) => m.key);
  const sel = state.compare.timeline ?? (withPhoto.length > 1 ? [withPhoto[0], withPhoto[withPhoto.length - 1]] : withPhoto);
  return sel.filter((k) => withPhoto.includes(k));
}

function timelineSides() {
  const sel = timelineSelection(timelineMonths()).slice().sort();
  if (sel.length < 2) return null;
  return periodSides({ from: sel[0], to: sel[0] }, { from: sel[1], to: sel[1] });
}

function comparisonHtml(sides) {
  const c = state.compare;
  const [b, a] = sides;
  const display = `
    <div class="segmented" role="tablist">
      <button data-mode="side" class="${c.mode === 'side' ? 'active' : ''}">Side by side</button>
      <button data-mode="slider" class="${c.mode === 'slider' ? 'active' : ''}">Slider</button>
    </div>`;
  if (c.mode === 'slider' && b.photo && a.photo) {
    return `${display}
      <div class="slider-stage" style="--split:${c.split}%">
        <img class="after-img" src="${urlFor(a.photo)}" alt="After — ${a.title}">
        <img class="before-img" src="${urlFor(b.photo)}" alt="Before — ${b.title}">
        <div class="slider-handle"></div>
        <span class="badge before">Before · ${b.short}</span>
        <span class="badge after">After · ${a.short}</span>
        <input type="range" min="0" max="100" value="${c.split}" data-split aria-label="Reveal before / after">
      </div>`;
  }
  return `${display}
    <div class="side-by-side">
      ${sides.map((s) => `
        <figure class="panel">
          ${s.photo ? `<img src="${urlFor(s.photo)}" alt="${s.side} — ${s.title}">` : `<div class="panel-empty">${s.empty}</div>`}
          <span class="badge ${s.side}">${s.side === 'before' ? 'Before' : 'After'}</span>
          <figcaption><strong>${s.title}</strong>${s.sub ? `<span>${s.sub}</span>` : ''}</figcaption>
        </figure>`).join('')}
    </div>`;
}

function periodStatsHtml(sides) {
  const [a, b] = sides.map((s) => s.avg);
  const change = a && b ? round1(b.avg - a.avg) : null;
  const tile = (s) => `<div><strong>${fmtAvg(s.avg)}</strong><span>${s.title} avg${s.avg ? ` · ${s.avg.days} day${s.avg.days === 1 ? '' : 's'}` : ''}</span></div>`;
  return `
    <div class="stats">
      ${tile(sides[0])}
      ${tile(sides[1])}
      <div class="${change != null ? 'delta' : ''}"><strong>${change == null ? '—' : fmtDelta(change)}</strong><span>avg weight change</span></div>
    </div>`;
}

function exportButton(enabled) {
  return `<div class="row-actions"><button class="btn primary" data-export ${enabled ? '' : 'disabled'}>Save comparison image</button></div>`;
}

function renderCompare() {
  const c = state.compare;
  const list = photosFor(state.pose);
  const strip = $('.timeline-strip');
  const stripScroll = strip ? strip.scrollLeft : null;

  const head = `${homeHeader()}
    <div class="segmented kind" role="tablist">
      ${KINDS.map(([id, label]) => `<button data-kind="${id}" class="${c.kind === id ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    ${poseChips(state.pose)}`;

  if (list.length === 0) {
    view.innerHTML = `${head}
      <div class="empty">
        <div class="empty-art"><div></div><div></div></div>
        <h2>No ${poseLabel(state.pose).toLowerCase()} photos yet</h2>
        <p>Take your first progress photo. Your next one will show up right beside it.</p>
        <button class="btn primary" data-go="capture">Take a photo</button>
      </div>`;
    return;
  }

  if (c.kind === 'periods') view.innerHTML = head + periodsHtml();
  else if (c.kind === 'timeline') view.innerHTML = head + timelineHtml();
  else view.innerHTML = head + datesHtml(list);

  const newStrip = $('.timeline-strip');
  if (newStrip) newStrip.scrollLeft = stripScroll ?? newStrip.scrollWidth;
}

function datesHtml(list) {
  const { before, after } = resolveCompare();
  const option = (p, selectedId) =>
    `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${fmtDate(p.takenAt)}</option>`;
  const days = Math.round((after.takenAt - before.takenAt) / 86400000);
  const wb = weightIn(before);
  const wa = weightIn(after);
  const delta = wb != null && wa != null ? round1(wa - wb) : null;
  const single = list.length === 1;

  return `
    <div class="pickers">
      <label class="picker before"><span>Before</span>
        <select data-pick="beforeId">${list.map((p) => option(p, before.id)).join('')}</select></label>
      <button class="icon-btn" data-swap aria-label="Swap before and after">⇄</button>
      <label class="picker after"><span>After</span>
        <select data-pick="afterId">${list.map((p) => option(p, after.id)).join('')}</select></label>
    </div>
    ${comparisonHtml(datesSides())}
    ${single ? `<p class="hint">Only one ${poseLabel(state.pose).toLowerCase()} photo so far — take another to see your progress side by side.</p>` : `
    <div class="stats">
      <div><strong>${Math.abs(days)}</strong><span>day${Math.abs(days) === 1 ? '' : 's'} apart</span></div>
      <div><strong>${delta == null ? '—' : fmtDelta(delta)}</strong><span>weight change</span></div>
      <div><strong>${list.length}</strong><span>${poseLabel(state.pose).toLowerCase()} photos</span></div>
    </div>`}
    ${exportButton(!single)}`;
}

function periodsHtml() {
  const c = state.compare;
  const periods = currentPeriods();
  const sides = periodSides(periods.before, periods.after, c.periodPick);
  const custom = c.periodKind === 'custom';
  const allMonths = monthsBetween(monthKey(state.photos[0].takenAt), monthKey(state.photos[state.photos.length - 1].takenAt));
  const poseList = photosFor(state.pose);
  const monthOptions = (selected) => allMonths.map((k) => {
    const n = photosInPeriod(poseList, { from: k, to: k }).length;
    return `<option value="${k}" ${k === selected ? 'selected' : ''}>${monthLabel(k)} (${n})</option>`;
  }).join('');
  const periodPicker = (side) => `
    <div class="picker ${side}"><span>${side === 'before' ? 'Before' : 'After'}</span>
      <select data-period="${side}" data-end="from" aria-label="${side} ${custom ? 'start month' : 'month'}">${monthOptions(periods[side].from)}</select>
      ${custom ? `<span class="range-to">to</span>
      <select data-period="${side}" data-end="to" aria-label="${side} end month">${monthOptions(periods[side].to)}</select>` : ''}
    </div>`;
  const photoPicker = (s) => `
    <label class="picker ${s.side}"><span>${s.side === 'before' ? 'Before' : 'After'} photo</span>
      <select data-period-pick="${s.side}" ${s.inside.length < 2 ? 'disabled' : ''}>
        ${s.inside.length ? s.inside.map((p) => `<option value="${p.id}" ${p.id === s.photo.id ? 'selected' : ''}>${fmtDate(p.takenAt, { month: 'short', day: 'numeric' })}${p.weight != null ? ` · ${fmtWeight(p)}` : ''}</option>`).join('') : '<option>None</option>'}
      </select></label>`;

  return `
    <div class="segmented small" role="tablist">
      <button data-period-kind="month" class="${custom ? '' : 'active'}">By month</button>
      <button data-period-kind="custom" class="${custom ? 'active' : ''}">Custom range</button>
    </div>
    <div class="pickers ${custom ? 'ranges' : ''}">
      ${periodPicker('before')}
      <button class="icon-btn" data-swap aria-label="Swap before and after">⇄</button>
      ${periodPicker('after')}
    </div>
    ${comparisonHtml(sides)}
    <div class="pickers two">${sides.map(photoPicker).join('')}</div>
    ${periodStatsHtml(sides)}
    ${exportButton(sides.every((s) => s.photo))}`;
}

function timelineHtml() {
  const months = timelineMonths();
  const sel = timelineSelection(months).slice().sort();
  const sides = sel.length === 2 ? periodSides({ from: sel[0], to: sel[0] }, { from: sel[1], to: sel[1] }) : null;

  return `
    <div class="timeline-strip" role="list" aria-label="${poseLabel(state.pose)} photos by month">
      ${months.map((m) => {
        const i = sel.indexOf(m.key);
        const meta = `<span class="tl-meta"><strong>${monthLabel(m.key)}</strong><span>${[m.avg && fmtAvg(m.avg), m.count > 1 && `${m.count} photos`].filter(Boolean).join(' · ') || '&nbsp;'}</span></span>`;
        return m.photo ? `
        <button class="tl-card ${i >= 0 ? 'selected' : ''}" data-tl="${m.key}" role="listitem" aria-pressed="${i >= 0}">
          <img src="${urlFor(m.photo, 'thumb')}" alt="${monthLabel(m.key)}" loading="lazy">
          ${i >= 0 && sel.length === 2 ? `<span class="badge ${i ? 'after' : 'before'}">${i ? 'After' : 'Before'}</span>` : i >= 0 ? '<span class="badge">Selected</span>' : ''}
          ${meta}
        </button>` : `
        <div class="tl-card empty" role="listitem"><span class="tl-none">No photo</span>${meta}</div>`;
      }).join('')}
    </div>
    ${sides ? `
      ${comparisonHtml(sides)}
      ${periodStatsHtml(sides)}
      ${exportButton(true)}` : `
      <p class="hint">${months.filter((m) => m.photo).length < 2
        ? `Your timeline fills in as you add ${poseLabel(state.pose).toLowerCase()} photos in more months.`
        : 'Tap any two months to compare them side by side.'}</p>`}`;
}

// What to draw for "Save comparison image" in the current mode, or null if not ready.
function exportSpec() {
  const c = state.compare;
  const pose = poseLabel(state.pose);
  if (c.kind === 'dates') {
    const { list, before, after } = resolveCompare();
    if (list.length < 2) return null;
    const days = Math.round((after.takenAt - before.takenAt) / 86400000);
    const wb = weightIn(before), wa = weightIn(after);
    return {
      sides: datesSides(),
      footer: [`${Math.abs(days)} days`, wb != null && wa != null && fmtDelta(round1(wa - wb)), pose],
      name: `progress-${toDateInput(before.takenAt)}-to-${toDateInput(after.takenAt)}`,
    };
  }
  let sides;
  if (c.kind === 'timeline') sides = timelineSides();
  else {
    const p = currentPeriods();
    sides = periodSides(p.before, p.after, c.periodPick);
  }
  if (!sides || !sides.every((s) => s.photo)) return null;
  const [a, b] = sides;
  const slug = ({ from, to }) => (from === to ? from : `${from}_${to}`);
  return {
    sides,
    footer: [`${a.title} → ${b.title}`, a.avg && b.avg && `${fmtDelta(round1(b.avg.avg - a.avg.avg))} avg`, pose],
    name: `progress-${slug(a.period)}-vs-${slug(b.period)}`,
  };
}

async function exportComparison() {
  const spec = exportSpec();
  if (!spec) return;
  const imgs = await Promise.all(spec.sides.map((s) => loadImage(urlFor(s.photo))));

  const pw = 900, ph = 1200, gap = 12, footer = 150;
  const canvas = document.createElement('canvas');
  canvas.width = pw * 2 + gap;
  canvas.height = ph + footer;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e1013';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const font = (weight, size) => `${weight} ${size}px system-ui, -apple-system, sans-serif`;

  spec.sides.forEach((s, i) => {
    const x = i ? pw + gap : 0;
    drawCover(ctx, imgs[i], x, 0, pw, ph);
    const grad = ctx.createLinearGradient(0, ph - 300, 0, ph);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, ph - 300, pw, 300);
    ctx.fillStyle = i ? '#c8ff3d' : '#ffffff';
    ctx.font = font(800, 32);
    ctx.fillText(i ? 'AFTER' : 'BEFORE', x + 36, ph - 142);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(800, 52);
    ctx.fillText(s.title, x + 36, ph - 84, pw - 72);
    if (s.sub) {
      ctx.font = font(500, 32);
      ctx.fillStyle = '#d4d8de';
      ctx.fillText(s.sub, x + 36, ph - 36, pw - 72);
    }
  });

  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, 46);
  ctx.textAlign = 'center';
  ctx.fillText(spec.footer.filter(Boolean).join('   ·   '), canvas.width / 2, ph + footer / 2 + 16, canvas.width - 80);

  const blob = await canvasToBlob(canvas, 0.92);
  const file = new File([blob], `${spec.name}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'My progress' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- capture ----------

function ghostPhoto() {
  const list = photosFor(state.pose);
  return list[list.length - 1];
}

function shouldShowGuide() {
  return !guide.seen && readPref('guideEnabled', '1') === '1' && readPref('guideSkip', '') !== dayKey(Date.now());
}

function renderGuide() {
  const done = guide.checked.size;
  view.innerHTML = `
    <div class="guide">
      <h2>Before you shoot</h2>
      <p class="muted">Tap each one as you set up. Keeping these the same every time matters more than anything else.</p>
      <ul class="checklist">${TIPS.map((t) => `
        <li><button class="check-item ${guide.checked.has(t.id) ? 'done' : ''}" data-check="${t.id}" aria-pressed="${guide.checked.has(t.id)}">
          <span class="box" aria-hidden="true"></span><span>${t.check}</span></button></li>`).join('')}
      </ul>
      <label class="toggle-row"><input type="checkbox" data-guide-skip> Don’t show again today</label>
      <button class="btn primary wide" data-guide-continue>${done === TIPS.length ? 'All set, open camera' : `Open camera <span class="progress">${done}/${TIPS.length}</span>`}</button>
      <button class="link-btn" data-go="tips">Why these matter</button>
    </div>`;
}

function renderCapture() {
  if (shouldShowGuide()) return renderGuide();
  const ghost = ghostPhoto();
  view.innerHTML = `${poseChips(state.pose)}
    <div class="cam-frame ${camera.grid ? 'show-grid' : ''}">
      <video id="camVideo" playsinline muted autoplay></video>
      <img class="ghost" id="ghostImg" alt="" ${ghost ? `src="${urlFor(ghost)}"` : 'hidden'} style="opacity:${camera.ghost}">
      <div class="grid-overlay"></div>
      <div class="countdown" id="countdown" hidden></div>
      <div class="cam-msg" id="camMsg" hidden></div>
    </div>
    <div class="cam-tools">
      <label class="ghost-ctl ${ghost ? '' : 'disabled'}" title="Overlay your last photo to line up the same pose">
        <span>Ghost</span>
        <input type="range" min="0" max="0.8" step="0.05" value="${camera.ghost}" data-ghost ${ghost ? '' : 'disabled'}>
      </label>
      <button class="pill ${camera.grid ? 'on' : ''}" data-grid>Grid</button>
      <button class="pill ${camera.timer ? 'on' : ''}" data-timer>${camera.timer ? `${camera.timer}s` : 'Timer'}</button>
      <button class="pill" data-flip aria-label="Switch camera">Flip</button>
    </div>
    <div class="cam-actions">
      <label class="btn ghost-btn">Upload
        <input type="file" accept="image/*" data-upload hidden>
      </label>
      <button class="shutter" data-shutter aria-label="Take photo"></button>
      <span class="cam-spacer"></span>
    </div>`;
  startCamera();
}

function showCamMsg(msg) {
  const el = $('#camMsg');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    showCamMsg('Camera isn’t available here (it needs HTTPS). You can still upload photos.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camera.facing, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    const video = $('#camVideo');
    if (state.view !== 'capture' || !video) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    camera.stream = stream;
    video.srcObject = stream;
    video.classList.toggle('mirror', camera.facing === 'user');
  } catch (err) {
    showCamMsg(err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in your browser settings, or upload a photo instead.'
      : 'Couldn’t start the camera. You can upload a photo instead.');
  }
}

function stopCamera() {
  camera.stream?.getTracks().forEach((t) => t.stop());
  camera.stream = null;
}

async function shoot() {
  const video = $('#camVideo');
  if (camera.busy || !video?.videoWidth) return;
  camera.busy = true;
  try {
    if (camera.timer) {
      const cd = $('#countdown');
      cd.hidden = false;
      for (let n = camera.timer; n > 0; n--) {
        cd.textContent = n;
        await new Promise((r) => setTimeout(r, 1000));
        if (state.view !== 'capture') return;
      }
      cd.hidden = true;
    }
    // Crop the frame to 3:4 portrait so every photo lines up in the comparison.
    const vw = video.videoWidth, vh = video.videoHeight, target = 3 / 4;
    let sw = vw, sh = vh;
    if (vw / vh > target) sw = vh * target; else sh = vw / target;
    const scale = Math.min(1, MAX_DIM / sh);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d');
    if (camera.facing === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    $('.cam-frame')?.classList.add('flash');
    setTimeout(() => $('.cam-frame')?.classList.remove('flash'), 250);
    openReview(await canvasToBlob(canvas, 0.9), Date.now());
  } finally {
    camera.busy = false;
  }
}

async function handleUpload(file) {
  if (!file) return;
  const blob = await resizeBlob(file, MAX_DIM, 0.9);
  openReview(blob, file.lastModified || Date.now());
}

// ---------- sheets ----------

let sheetCleanup = null;

function openSheet(html, cleanup) {
  closeSheet();
  $('.sheet-body', sheet).innerHTML = html;
  sheet.hidden = false;
  sheetCleanup = cleanup;
}

function closeSheet() {
  sheet.hidden = true;
  $('.sheet-body', sheet).innerHTML = '';
  sheetCleanup?.();
  sheetCleanup = null;
}

function openReview(blob, takenAt) {
  const preview = URL.createObjectURL(blob);
  const prev = ghostPhoto();
  openSheet(`
    <form class="review" data-review>
      <h2>Save photo</h2>
      <div class="review-pair">
        ${prev ? `<figure><img src="${urlFor(prev)}" alt=""><figcaption>Last · ${fmtDate(prev.takenAt, { month: 'short', day: 'numeric' })}</figcaption></figure>` : ''}
        <figure class="${prev ? '' : 'solo'}"><img src="${preview}" alt="New photo"><figcaption>New</figcaption></figure>
      </div>
      <label>Pose
        <select name="pose">${POSES.map((p) => `<option value="${p.id}" ${p.id === state.pose ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
      </label>
      <div class="field-row">
        <label>Date <input type="date" name="date" value="${toDateInput(takenAt)}" max="${toDateInput(Date.now())}"></label>
        <label>Weight (${state.unit}) <input type="number" name="weight" inputmode="decimal" step="0.1" min="0" placeholder="optional"></label>
      </div>
      <label>Note <input type="text" name="note" maxlength="140" placeholder="e.g. Week 6, cutting"></label>
      <div class="row-actions">
        <button type="button" class="btn ghost-btn" data-close>Retake</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`, () => URL.revokeObjectURL(preview));

  $('[data-review]', sheet).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const weight = parseFloat(form.get('weight'));
    const pose = form.get('pose');
    e.target.querySelector('[type=submit]').disabled = true;
    try {
      const id = await savePhoto({
        blob,
        pose,
        takenAt: fromDateInput(form.get('date'), takenAt),
        weight: Number.isFinite(weight) ? weight : null,
        note: String(form.get('note') || '').trim(),
      });
      closeSheet();
      state.pose = pose;
      const list = photosFor(pose);
      state.compare.beforeId = list[0].id;
      state.compare.afterId = id;
      toast('Saved');
      go('compare');
    } catch (err) {
      console.error(err);
      toast('Couldn’t save — storage may be full');
      e.target.querySelector('[type=submit]').disabled = false;
    }
  });
}

function openDetail(id) {
  const p = state.photos.find((x) => x.id === id);
  if (!p) return;
  openSheet(`
    <div class="detail">
      <img src="${urlFor(p)}" alt="${poseLabel(p.pose)} — ${fmtDate(p.takenAt)}">
      <div class="detail-meta">
        <strong>${fmtDate(p.takenAt, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}</strong>
        <span>${poseLabel(p.pose)}${p.weight != null ? ` · ${fmtWeight(p)}` : ''}</span>
        ${p.note ? `<p>${esc(p.note)}</p>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn ghost-btn" data-set="beforeId" data-id="${p.id}">Set as Before</button>
        <button class="btn ghost-btn" data-set="afterId" data-id="${p.id}">Set as After</button>
      </div>
      <div class="row-actions">
        <button class="btn danger" data-delete="${p.id}">Delete</button>
        <button class="btn primary" data-close>Done</button>
      </div>
    </div>`);
}

// ---------- backup ----------

let pendingBackup = null; // File built by createBackup, waiting to be shared/downloaded

function needsBackup() {
  return state.photos.some((p) => (p.createdAt ?? 0) > state.lastBackup);
}

function fmtSize(bytes) {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function fmtAgo(ms) {
  if (!ms) return 'never';
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function dupKey(p) {
  return `${p.pose}|${p.takenAt}|${p.blob.size}`;
}

async function createBackup() {
  const manifest = { app: 'gym-progress', version: 1, exportedAt: Date.now(), photos: [] };
  const files = [];
  for (const p of state.photos) {
    const file = `photos/${toDateInput(p.takenAt)}_${p.pose}_${p.id}.jpg`;
    files.push({ name: file, data: new Uint8Array(await p.blob.arrayBuffer()), date: new Date(p.takenAt) });
    manifest.photos.push({
      file, pose: p.pose, takenAt: p.takenAt, weight: p.weight, unit: p.unit, note: p.note, createdAt: p.createdAt,
    });
  }
  files.unshift({ name: 'backup.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  const zip = createZip(files);
  return new File([zip], `gym-progress-backup-${toDateInput(Date.now())}.zip`, { type: 'application/zip' });
}

async function restoreBackup(file, onProgress) {
  const entries = await readZip(file);
  const manifestBytes = entries.get('backup.json');
  if (!manifestBytes) throw new Error('That zip isn’t a Gym Progress backup.');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const items = Array.isArray(manifest.photos) ? manifest.photos : [];
  const have = new Set(state.photos.map(dupKey));
  const wasBackedUp = !needsBackup();
  let added = 0, skipped = 0;

  for (const [i, m] of items.entries()) {
    onProgress?.(i + 1, items.length);
    const bytes = entries.get(m.file);
    if (!bytes || !POSES.some((p) => p.id === m.pose) || !Number.isFinite(m.takenAt)) { skipped++; continue; }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const key = dupKey({ pose: m.pose, takenAt: m.takenAt, blob });
    if (have.has(key)) { skipped++; continue; }
    await db.add({
      pose: m.pose,
      takenAt: m.takenAt,
      weight: Number.isFinite(m.weight) ? m.weight : null,
      unit: m.unit === 'kg' ? 'kg' : 'lb',
      note: String(m.note ?? '').slice(0, 140),
      blob,
      thumb: await resizeBlob(blob, THUMB_DIM, 0.8),
      createdAt: Number.isFinite(m.createdAt) ? m.createdAt : Date.now(),
    });
    have.add(key);
    added++;
  }
  if (added) syncPush();
  // Restored photos are already in a backup, so they shouldn't trigger the reminder.
  if (wasBackedUp && Number.isFinite(manifest.exportedAt) && manifest.exportedAt > state.lastBackup) {
    state.lastBackup = manifest.exportedAt;
    writePref('lastBackup', state.lastBackup);
  }
  await reload();
  return { added, skipped };
}

function markBackedUp() {
  state.lastBackup = Date.now();
  writePref('lastBackup', state.lastBackup);
  $('#backupBtn .dot').hidden = true;
  const status = $('[data-backup-status]');
  if (status) status.textContent = backupStatus();
}

function backupStatus() {
  const n = state.photos.length;
  return `${n} photo${n === 1 ? '' : 's'} on this device · Last backup: ${fmtAgo(state.lastBackup)}`;
}

function openBackup() {
  const n = state.photos.length;
  openSheet(`
    <div class="backup">
      <h2>Backup &amp; restore</h2>
      <p class="muted">Your photos are only stored on this device. Save a backup to Files, iCloud Drive or Google Drive so you don’t lose them if you switch phones or clear your browser.</p>
      <p class="backup-status ${needsBackup() ? 'warn' : ''}" data-backup-status>${backupStatus()}</p>
      <div data-backup-slot>
        <button class="btn primary wide" data-backup-create ${n ? '' : 'disabled'}>Create backup</button>
      </div>

      <h3>Restore</h3>
      <p class="muted">Pick a backup .zip. Photos already on this device are skipped, so restoring twice is safe.</p>
      <label class="btn ghost-btn wide">Restore from backup
        <input type="file" accept=".zip,application/zip" data-restore hidden>
      </label>
      <p class="muted small" data-restore-status></p>

      <div class="row-actions"><button class="btn ghost-btn" data-close>Close</button></div>
    </div>`, () => { pendingBackup = null; });
}

async function handleBackupCreate(btn) {
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    pendingBackup = await createBackup();
  } catch (err) {
    console.error(err);
    toast('Couldn’t create backup');
    btn.disabled = false;
    btn.textContent = 'Create backup';
    return;
  }
  const canShare = navigator.canShare?.({ files: [pendingBackup] });
  // Share needs a fresh tap (iOS), so the file is built first and saved from a second button.
  $('[data-backup-slot]').innerHTML = `
    <p class="backup-ready">✓ Backup ready — ${state.photos.length} photos, ${fmtSize(pendingBackup.size)}</p>
    <div class="row-actions tight">
      ${canShare ? '<button class="btn primary" data-backup-share>Save / Share…</button>' : ''}
      <button class="btn ${canShare ? 'ghost-btn' : 'primary'}" data-backup-download>Download</button>
    </div>`;
}

async function handleBackupShare() {
  if (!pendingBackup) return;
  try {
    await navigator.share({ files: [pendingBackup], title: 'Gym Progress backup' });
    markBackedUp();
    toast('Backup saved');
  } catch (err) {
    if (err.name !== 'AbortError') handleBackupDownload();
  }
}

function handleBackupDownload() {
  if (!pendingBackup) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(pendingBackup);
  a.download = pendingBackup.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  markBackedUp();
}

async function handleRestore(file) {
  if (!file) return;
  const status = $('[data-restore-status]');
  try {
    const { added, skipped } = await restoreBackup(file, (i, n) => { status.textContent = `Restoring ${i} of ${n}…`; });
    status.textContent = `Restored ${added} photo${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already here, skipped)` : ''}.`;
    $('[data-backup-status]').textContent = backupStatus();
    const createBtn = $('[data-backup-create]');
    if (createBtn) createBtn.disabled = !state.photos.length;
    const latest = state.photos[state.photos.length - 1];
    if (added && latest) state.pose = latest.pose;
    toast(added ? `Restored ${added} photo${added === 1 ? '' : 's'}` : 'Nothing new to restore');
    if (state.view !== 'capture') render();
  } catch (err) {
    console.error(err);
    status.textContent = err.message || 'Couldn’t read that backup.';
  }
}

// ---------- settings ----------

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------- push reminders ----------

const PUSH_NOTES = {
  unconfigured: 'Reminders need the free reminder server set up first: follow worker/README.md, then put its URL in js/config.js.',
  'needs-install': 'On iPhone, notifications only work in the installed app. In Safari tap Share → Add to Home Screen, then open Gym Progress from that icon and come back here. Needs iOS 16.4 or later.',
  unsupported: 'This browser doesn’t support push notifications.',
  denied: 'Notifications are blocked for Gym Progress. Allow them in your phone’s Settings → Notifications → Gym Progress, then come back here.',
};

// What the server needs to word the reminder and skip days you've already logged.
function pushInfo() {
  const latest = state.photos[state.photos.length - 1];
  return {
    time: state.reminderTime,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lastPhotoDay: latest ? dayKey(latest.takenAt) : null,
    streak: streaks(state.photos).current,
  };
}

function syncPush() {
  push.syncPhotos(pushInfo()).catch((err) => console.warn('Reminder sync failed:', err.message));
}

async function renderPushControls(note = '') {
  const el = $('[data-push]');
  if (!el) return;
  const support = push.pushSupport();
  let sub = null;
  if (support === 'ready') {
    push.prefetchPublicKey().catch(() => {});
    sub = await push.getSubscription().catch(() => null);
  }
  if (!$('[data-push]')) return; // left Settings while waiting
  el.innerHTML = `
    ${support !== 'ready' ? `<p class="push-note">${PUSH_NOTES[support]}</p>` : sub ? `
      <p class="push-status">✓ On · every day at ${fmtTime(state.reminderTime)}</p>
      <div class="row-actions tight">
        <button class="btn ghost-btn" data-push-test>Send test notification</button>
        <button class="btn ghost-btn" data-push-off>Turn off</button>
      </div>` : `
      <button class="btn primary wide" data-push-on>Enable reminders</button>`}
    ${note ? `<p class="muted small" data-push-note>${esc(note)}</p>` : ''}`;
}

async function handlePushOn(btn) {
  btn.disabled = true;
  btn.textContent = 'Enabling…';
  try {
    // enableReminders asks for permission first, still inside this tap.
    await push.enableReminders(pushInfo());
    renderPushControls('Reminders are on. Tap “Send test notification” to check.');
  } catch (err) {
    renderPushControls(err.code === 'denied' ? '' : `Couldn’t turn on reminders: ${err.message}`);
  }
}

async function handlePushTest(btn) {
  btn.disabled = true;
  try {
    await push.sendTest();
    renderPushControls('Sent. It should arrive in a few seconds.');
  } catch (err) {
    if (err.status === 410) {
      await push.disableReminders().catch(() => {});
      renderPushControls('That subscription expired. Tap “Enable reminders” to turn reminders back on.');
    } else {
      renderPushControls(`Couldn’t send a test: ${err.message}`);
    }
  }
}

async function handlePushOff(btn) {
  btn.disabled = true;
  await push.disableReminders().catch(() => {});
  renderPushControls('Reminders are off.');
}

function handleReminderTime() {
  push.updateReminders(pushInfo())
    .then((on) => on && renderPushControls(`Reminder time changed to ${fmtTime(state.reminderTime)}.`))
    .catch((err) => renderPushControls(`Couldn’t update the reminder time: ${err.message}`));
}

function pageHead(title) {
  return `<div class="page-head"><button class="icon-btn" data-back aria-label="Back">‹</button><h2>${title}</h2></div>`;
}

function renderSettings() {
  view.innerHTML = `${pageHead('Settings')}
    <section class="card">
      <h3>Daily photo reminder</h3>
      <p class="muted">Get a notification at this time every day. It’s skipped on days you’ve already taken a photo.</p>
      <label class="field-inline">Remind me at <input type="time" value="${state.reminderTime}" data-reminder-time></label>
      <div class="push-controls" data-push><p class="muted small">Checking…</p></div>
    </section>

    <section class="card">
      <h3>Photo guidance</h3>
      <button class="row-link" data-go="tips"><span>How to take good progress photos</span><span aria-hidden="true">›</span></button>
      <label class="toggle-row"><span>Show checklist before the camera</span>
        <input type="checkbox" data-guide-enabled ${readPref('guideEnabled', '1') === '1' ? 'checked' : ''}></label>
    </section>

    <section class="card">
      <h3>Weight unit</h3>
      <div class="segmented">
        <button data-unit="lb" class="${state.unit === 'lb' ? 'active' : ''}">Pounds (lb)</button>
        <button data-unit="kg" class="${state.unit === 'kg' ? 'active' : ''}">Kilograms (kg)</button>
      </div>
    </section>

    <section class="card">
      <h3>Your data</h3>
      <button class="row-link" data-backup-open><span>Backup &amp; restore</span><span class="muted small">Last backup: ${fmtAgo(state.lastBackup)} ›</span></button>
    </section>`;
  renderPushControls();
}

function renderTips() {
  view.innerHTML = `${pageHead('How to take good progress photos')}
    <p class="muted intro">Progress is slow, so small changes in how you take the photo can hide it or fake it. Keep everything the same and the only thing that changes is you.</p>
    <ol class="tips">${TIPS.map((t) => `
      <li class="card"><h3>${t.title}</h3><p class="tip-do">${t.check}</p><p>${t.why}</p></li>`).join('')}
    </ol>`;
}

// ---------- gallery ----------

function renderGallery() {
  const list = (state.galleryPose === 'all' ? state.photos : photosFor(state.galleryPose)).slice().reverse();
  view.innerHTML = `${poseChips(state.galleryPose, { includeAll: true, action: 'gpose' })}
    ${list.length ? `<div class="grid">${list.map((p) => `
      <button class="tile" data-open="${p.id}">
        <img src="${urlFor(p, 'thumb')}" alt="${poseLabel(p.pose)} — ${fmtDate(p.takenAt)}" loading="lazy">
        <span class="tile-meta"><strong>${fmtDate(p.takenAt, { month: 'short', day: 'numeric' })}</strong>
        <span>${poseLabel(p.pose)}${p.weight != null ? ` · ${fmtWeight(p)}` : ''}</span></span>
      </button>`).join('')}</div>` : `
      <div class="empty"><h2>Nothing here yet</h2><p>Photos you take are stored privately on this device.</p>
      <button class="btn primary" data-go="capture">Take a photo</button></div>`}`;
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-close]');
  if (!t) return;
  const d = t.dataset;

  if ('close' in d) return closeSheet();
  if ('backupOpen' in d) return openBackup();
  if ('back' in d) return go(state.backStack.pop() ?? 'compare', { isBack: true });
  if ('bannerDismiss' in d) { writePref('bannerDismissed', dayKey(Date.now())); return render(); }
  if (d.check) {
    if (guide.checked.has(d.check)) guide.checked.delete(d.check); else guide.checked.add(d.check);
    return renderGuide();
  }
  if ('guideContinue' in d) {
    if ($('[data-guide-skip]')?.checked) writePref('guideSkip', dayKey(Date.now()));
    guide.seen = true;
    return renderCapture();
  }
  if ('pushOn' in d) return handlePushOn(t);
  if ('pushTest' in d) return handlePushTest(t);
  if ('pushOff' in d) return handlePushOff(t);
  if (d.unit) {
    state.unit = d.unit;
    writePref('unit', state.unit);
    return render();
  }
  if ('backupCreate' in d) return handleBackupCreate(t);
  if ('backupShare' in d) return handleBackupShare();
  if ('backupDownload' in d) return handleBackupDownload();
  if (d.view) return go(d.view);
  if (d.go) return go(d.go);

  if (d.pose) {
    state.pose = d.pose;
    if (state.view === 'capture') {
      // Update in place so the camera stream keeps running.
      document.querySelectorAll('[data-pose]').forEach((c) => c.classList.toggle('active', c.dataset.pose === d.pose));
      const ghost = ghostPhoto();
      const img = $('#ghostImg');
      const ctl = $('[data-ghost]');
      if (ghost) img.src = urlFor(ghost); else img.removeAttribute('src');
      img.hidden = !ghost;
      ctl.disabled = !ghost;
      ctl.closest('label').classList.toggle('disabled', !ghost);
    } else {
      state.compare.timeline = null;
      state.compare.periodPick = {};
      render();
    }
    return;
  }
  if (d.gpose) { state.galleryPose = d.gpose; return render(); }
  if (d.open) return openDetail(Number(d.open));
  if (d.mode) { state.compare.mode = d.mode; return render(); }
  if (d.kind) {
    state.compare.kind = d.kind;
    writePref('compareKind', d.kind);
    return render();
  }
  if (d.periodKind) {
    const c = state.compare;
    c.periodKind = d.periodKind;
    if (d.periodKind === 'month') {
      const p = currentPeriods();
      c.periods = { before: { from: p.before.from, to: p.before.from }, after: { from: p.after.to, to: p.after.to } };
    }
    return render();
  }
  if (d.tl) {
    const sel = timelineSelection(timelineMonths());
    const i = sel.indexOf(d.tl);
    if (i >= 0) sel.splice(i, 1);
    else if (sel.push(d.tl) > 2) sel.shift();
    state.compare.timeline = sel;
    return render();
  }
  if ('swap' in d) {
    const c = state.compare;
    if (c.kind === 'periods') {
      const p = currentPeriods();
      c.periods = { before: p.after, after: p.before };
      c.periodPick = { before: c.periodPick.after, after: c.periodPick.before };
    } else {
      [c.beforeId, c.afterId] = [c.afterId, c.beforeId];
    }
    return render();
  }
  if ('export' in d) {
    t.disabled = true;
    try { await exportComparison(); } finally { t.disabled = false; }
    return;
  }
  if ('shutter' in d) return shoot();
  if ('flip' in d) { camera.facing = camera.facing === 'user' ? 'environment' : 'user'; return startCamera(); }
  if ('grid' in d) {
    camera.grid = !camera.grid;
    t.classList.toggle('on', camera.grid);
    $('.cam-frame').classList.toggle('show-grid', camera.grid);
    return;
  }
  if ('timer' in d) {
    camera.timer = { 0: 3, 3: 10, 10: 0 }[camera.timer];
    t.classList.toggle('on', !!camera.timer);
    t.textContent = camera.timer ? `${camera.timer}s` : 'Timer';
    return;
  }
  if (d.set) {
    const p = state.photos.find((x) => x.id === Number(d.id));
    state.pose = p.pose;
    resolveCompare();
    state.compare[d.set] = p.id;
    state.compare.kind = 'dates';
    closeSheet();
    return go('compare');
  }
  if (d.delete) {
    if (!confirm('Delete this photo? This can’t be undone.')) return;
    await deletePhoto(Number(d.delete));
    closeSheet();
    toast('Deleted');
    return render();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.pick) {
    state.compare[t.dataset.pick] = Number(t.value);
    render();
  } else if (t.dataset.period) {
    const c = state.compare;
    const p = currentPeriods();
    const side = t.dataset.period;
    const next = { ...p[side], [t.dataset.end]: t.value };
    if (c.periodKind === 'month') next.to = next.from;
    c.periods = { ...p, [side]: normalize(next) };
    c.periodPick = { ...c.periodPick, [side]: null };
    render();
  } else if (t.dataset.periodPick) {
    state.compare.periodPick = { ...state.compare.periodPick, [t.dataset.periodPick]: Number(t.value) };
    render();
  } else if ('upload' in t.dataset) {
    handleUpload(t.files[0]).catch(() => toast('Couldn’t read that image'));
    t.value = '';
  } else if ('reminderTime' in t.dataset) {
    if (!t.value) return;
    state.reminderTime = t.value;
    writePref('reminderTime', state.reminderTime);
    handleReminderTime();
  } else if ('guideEnabled' in t.dataset) {
    writePref('guideEnabled', t.checked ? '1' : '0');
  } else if ('restore' in t.dataset) {
    handleRestore(t.files[0]);
    t.value = '';
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if ('split' in t.dataset) {
    state.compare.split = Number(t.value);
    t.closest('.slider-stage').style.setProperty('--split', `${t.value}%`);
  } else if ('ghost' in t.dataset) {
    camera.ghost = Number(t.value);
    $('#ghostImg').style.opacity = camera.ghost;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheet.hidden) closeSheet();
});

document.addEventListener('visibilitychange', () => {
  if (state.view !== 'capture') return;
  if (document.hidden) stopCamera(); else startCamera();
});

// ---------- boot ----------

(async () => {
  navigator.storage?.persist?.().catch(() => {});
  try {
    await reload();
  } catch (err) {
    console.error(err);
    view.innerHTML = '<div class="empty"><h2>Storage unavailable</h2><p>This browser blocked on-device storage (private mode?). Photos can’t be saved.</p></div>';
    return;
  }
  const latest = state.photos[state.photos.length - 1];
  if (latest) state.pose = latest.pose;
  // ?capture=1 comes from a reminder notification and the home-screen shortcut.
  const params = new URLSearchParams(location.search);
  if (params.has('capture')) history.replaceState(null, '', location.pathname);
  go(params.has('capture') || !state.photos.length ? 'capture' : 'compare');
  try { localStorage.removeItem('gp:reminderSaved'); } catch { /* left over from calendar reminders */ }
  syncPush();
})();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Tapping a reminder notification while the app is open.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-capture') go('capture');
  });
}
