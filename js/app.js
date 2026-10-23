import * as db from './db.js';
import { createZip, readZip } from './zip.js';
import { dayKey, streaks } from './streak.js';
import * as push from './push.js';
import { TIPS } from './guide.js';
import { monthKey, monthLabel, photosInPeriod, avgWeight } from './periods.js';

const POSES = [
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
  { id: 'back', label: 'Back' },
  { id: 'flex', label: 'Flex' },
];
const MAX_DIM = 1600;
const THUMB_DIM = 480;
const KG_PER_LB = 0.45359237;
const DAY = 86400000;
const QUICK = [['all', 'First vs latest'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];
const TITLES = { compare: 'Compare', capture: 'Camera', gallery: 'Gallery', meals: 'Meals', settings: 'Settings', tips: 'Photo tips' };

const state = {
  photos: [],          // sorted oldest → newest
  view: 'compare',
  pose: 'front',
  galleryPose: 'all',
  compare: {
    picks: {},         // pose → { before: id|null, after: id|null } once chosen; otherwise defaults
    mode: 'side',      // side | slider
    split: 50,
  },
  unit: readPref('unit', 'lb'),
  lastBackup: Number(readPref('lastBackup', 0)),
  reminderTime: readPref('reminderTime', '07:00'),
  backStack: [],       // views to return to from tips
};

// Pre-camera checklist: shown once per app open unless skipped for today or turned off.
const guide = { seen: false, checked: new Set() };

const camera = { stream: null, facing: 'user', timer: 0, grid: true, ghost: 0.35, busy: false };
const urls = new Map(); // photo id -> { full, thumb } object URLs

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const ICONS = {
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  share: '<path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  flip: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9 13a3 3 0 0 1 5.2-2M15 13a3 3 0 0 1-5.2 2M14.5 9.5v1.7h-1.7M9.5 16.5v-1.7h1.7"/>',
  upload: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  meals: '<path d="M7 3v6a2 2 0 0 0 4 0V3M9 11v10M17 21V3c-2 1-3.5 3.5-3.5 7v3H17"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

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

const shortDate = (ms) => fmtDate(ms, { month: 'short', day: 'numeric' });

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

const round1 = (n) => Math.round(n * 10) / 10;

function fmtWeight(photo) {
  const w = weightIn(photo);
  return w == null ? '' : `${round1(w)} ${state.unit}`;
}

function fmtDelta(d) {
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} ${state.unit}`;
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

function photoById(id) {
  return id == null ? null : state.photos.find((p) => p.id === id) ?? null;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 2000);
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

// Big segmented pose tabs. `action` is the data attribute the buttons carry.
function poseTabs(active, { includeAll = false, action = 'pose' } = {}) {
  const opts = includeAll ? [{ id: 'all', label: 'All' }, ...POSES] : POSES;
  return `<div class="pose-tabs" role="tablist" aria-label="Pose">${opts.map((p) => `
    <button class="${p.id === active ? 'active' : ''}" data-${action}="${p.id}" role="tab" aria-selected="${p.id === active}">${p.label}</button>`).join('')}
  </div>`;
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
  for (const pick of Object.values(state.compare.picks)) {
    if (pick.before === id) pick.before = null;
    if (pick.after === id) pick.after = null;
  }
  await reload();
  syncPush();
}

// ---------- navigation ----------

function go(name, { isBack = false } = {}) {
  if (state.view === 'capture' && name !== 'capture') stopCamera();
  if (name !== 'tips') state.backStack = [];
  else if (!isBack && state.view !== name) state.backStack.push(state.view);
  const changed = state.view !== name;
  state.view = name;
  view.scrollTop = 0;
  document.querySelectorAll('.tabbar .tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  render();
  if (changed && !reducedMotion.matches) {
    view.classList.remove('view-enter');
    void view.offsetWidth; // restart the animation
    view.classList.add('view-enter');
  }
}

function render() {
  view.dataset.view = state.view;
  renderHeader();
  $('.tab-dot').hidden = !needsBackup();
  if (state.view === 'compare') renderCompare();
  else if (state.view === 'capture') renderCapture();
  else if (state.view === 'gallery') renderGallery();
  else if (state.view === 'meals') renderMeals();
  else if (state.view === 'settings') renderSettings();
  else if (state.view === 'tips') renderTips();
}

function renderHeader() {
  $('#title').textContent = TITLES[state.view] ?? '';
  $('[data-back]').hidden = state.view !== 'tips';
  document.body.dataset.view = state.view;
  const actions = $('#headerActions');
  if (state.view === 'compare' && state.photos.length) {
    const { current, doneToday } = streaks(state.photos);
    actions.innerHTML = `<span class="streak ${doneToday ? 'done' : ''}" title="${current}-day streak">
      <span aria-hidden="true">${current ? '🔥' : '💤'}</span>${current ? `${current}-day streak` : 'No streak'}${doneToday ? ' ✓' : ''}</span>`;
  } else {
    actions.innerHTML = '';
  }
}

view.addEventListener('animationend', () => view.classList.remove('view-enter'));

// ---------- compare ----------

// The photos in the Before and After slots for the current pose. Defaults to
// first vs latest; a pose with one photo fills only Before.
function comparePair(pose = state.pose) {
  const list = photosFor(pose);
  const ids = new Set(list.map((p) => p.id));
  const pick = state.compare.picks[pose];
  if (pick) {
    return {
      list,
      before: ids.has(pick.before) ? photoById(pick.before) : null,
      after: ids.has(pick.after) ? photoById(pick.after) : null,
    };
  }
  return { list, before: list[0] ?? null, after: list.length > 1 ? list[list.length - 1] : null };
}

function setPick(pose, side, id) {
  const { before, after } = comparePair(pose);
  const pick = { before: before?.id ?? null, after: after?.id ?? null };
  const other = side === 'before' ? 'after' : 'before';
  if (pick[other] === id) pick[other] = pick[side]; // choosing the other slot's photo swaps them
  pick[side] = id;
  state.compare.picks[pose] = pick;
}

// Quick picks: latest photo as After, and as Before either the first photo or
// the one taken closest to 30/90 days ago.
function quickPair(kind, list) {
  if (list.length < 2) return null;
  const latest = list[list.length - 1];
  if (kind === 'all') return { before: list[0].id, after: latest.id };
  const target = Date.now() - Number(kind) * DAY;
  let best = null;
  for (const p of list) {
    if (p.id !== latest.id && (!best || Math.abs(p.takenAt - target) < Math.abs(best.takenAt - target))) best = p;
  }
  return { before: best.id, after: latest.id };
}

function slotHtml(side, photo, compact = false) {
  const label = side === 'before' ? 'Before' : 'After';
  return `
    <button class="slot ${side} ${photo ? 'filled' : 'empty'} ${compact ? 'compact' : ''}" data-slot="${side}" aria-label="${label}: ${photo ? fmtDate(photo.takenAt) : 'choose a photo'}">
      ${photo ? `<img src="${urlFor(photo, compact ? 'thumb' : 'full')}" alt="">` : `<span class="slot-plus">${icon('plus')}</span>`}
      <span class="slot-label">${label}</span>
      ${photo ? `<span class="slot-meta"><strong>${shortDate(photo.takenAt)}</strong>${photo.weight != null ? `<span>${fmtWeight(photo)}</span>` : ''}</span>`
        : `<span class="slot-meta"><span>Tap to choose</span></span>`}
    </button>`;
}

function todayBanner() {
  if (!state.photos.length) return '';
  const { current, doneToday } = streaks(state.photos);
  if (doneToday || readPref('bannerDismissed', '') === dayKey(Date.now())) return '';
  return `
    <div class="today-banner" role="status">
      <div class="today-text"><strong>No photo yet today</strong><span>${current ? `Keep your ${current}-day streak` : 'Start a streak today'}</span></div>
      <button class="btn primary sm" data-go="capture">Take photo</button>
      <button class="icon-btn" data-banner-dismiss aria-label="Dismiss for today">✕</button>
    </div>`;
}

function renderCompare() {
  const c = state.compare;
  const { list, before, after } = comparePair();
  const both = before && after;
  const slider = c.mode === 'slider' && both;

  let stats = '';
  if (both) {
    const days = Math.round(Math.abs(after.takenAt - before.takenAt) / DAY);
    const wb = weightIn(before), wa = weightIn(after);
    stats = `<div class="compare-stats">
      <div><strong>${days}</strong><span>day${days === 1 ? '' : 's'}</span></div>
      <div><strong>${wb != null && wa != null ? fmtDelta(round1(wa - wb)) : '—'}</strong><span>weight</span></div>
    </div>`;
  } else {
    stats = `<p class="compare-hint">${list.length === 0
      ? `No ${poseLabel(state.pose).toLowerCase()} photos yet. Take one to start.`
      : list.length === 1 ? `Take another ${poseLabel(state.pose).toLowerCase()} photo to compare.` : 'Tap a slot to choose a photo.'}</p>`;
  }

  const activeQuick = QUICK.find(([k]) => {
    const q = quickPair(k, list);
    return q && both && q.before === before.id && q.after === after.id;
  })?.[0];

  view.innerHTML = `
    ${todayBanner()}
    ${poseTabs(state.pose)}
    ${slider ? `
      <div class="slider-stage" style="--split:${c.split}%">
        <img class="after-img" src="${urlFor(after)}" alt="After, ${fmtDate(after.takenAt)}">
        <img class="before-img" src="${urlFor(before)}" alt="Before, ${fmtDate(before.takenAt)}">
        <div class="slider-handle"></div>
        <span class="slot-label before">Before</span>
        <span class="slot-label after">After</span>
        <input type="range" min="0" max="100" value="${c.split}" data-split aria-label="Reveal before or after">
      </div>
      <div class="slots compact">${slotHtml('before', before, true)}${slotHtml('after', after, true)}</div>`
    : `<div class="slots">${slotHtml('before', before)}${slotHtml('after', after)}</div>`}
    ${stats}
    <div class="quick" role="group" aria-label="Quick compare">
      ${QUICK.map(([k, label]) => `<button class="${activeQuick === k ? 'active' : ''}" data-quick="${k}" ${list.length < 2 ? 'disabled' : ''}>${label}</button>`).join('')}
    </div>
    <div class="compare-actions">
      <div class="segmented" role="tablist" aria-label="View">
        <button data-mode="side" class="${c.mode === 'side' ? 'active' : ''}" role="tab" aria-selected="${c.mode === 'side'}">Side by side</button>
        <button data-mode="slider" class="${c.mode === 'slider' ? 'active' : ''}" role="tab" aria-selected="${c.mode === 'slider'}" ${both ? '' : 'disabled'}>Slider</button>
      </div>
      <button class="icon-btn filled" data-export ${both ? '' : 'disabled'} aria-label="Save comparison image">${icon('share')}</button>
    </div>`;
}

function openPicker(side) {
  const pose = state.pose;
  const { list, before, after } = comparePair(pose);
  const current = side === 'before' ? before : after;
  const other = side === 'before' ? after : before;
  const otherLabel = side === 'before' ? 'After' : 'Before';
  const newest = list.slice().reverse();
  openSheet(`
    <div class="picker-sheet">
      <div class="sheet-head">
        <h2>${side === 'before' ? 'Before' : 'After'} photo <span>${poseLabel(pose)}</span></h2>
        <button class="btn ghost-btn sm" data-close>Done</button>
      </div>
      ${newest.length ? `<div class="pick-grid">${newest.map((p) => {
        const isOther = other?.id === p.id;
        return `
        <button class="pick ${current?.id === p.id ? 'selected' : ''} ${isOther ? 'other' : ''}" data-pick-photo="${p.id}" data-side="${side}" aria-pressed="${current?.id === p.id}">
          <span class="pick-img"><img src="${urlFor(p, 'thumb')}" alt="" loading="lazy">
            ${current?.id === p.id ? `<span class="pick-check">${icon('check')}</span>` : isOther ? `<span class="pick-tag">${otherLabel}</span>` : ''}</span>
          <span class="pick-date">${shortDate(p.takenAt)}</span>
          <span class="pick-sub">${p.weight != null ? fmtWeight(p) : new Date(p.takenAt).getFullYear()}</span>
        </button>`;
      }).join('')}</div>` : `
      <div class="empty small"><p>No ${poseLabel(pose).toLowerCase()} photos yet.</p></div>`}
      <button class="btn primary wide" data-go-camera>Take a new photo</button>
    </div>`, null, { tall: true });
}

async function exportComparison() {
  const { before, after } = comparePair();
  if (!before || !after) return;
  const imgs = await Promise.all([before, after].map((p) => loadImage(urlFor(p))));

  const pw = 900, ph = 1200, gap = 12, footer = 150;
  const canvas = document.createElement('canvas');
  canvas.width = pw * 2 + gap;
  canvas.height = ph + footer;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0c0f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const font = (weight, size) => `${weight} ${size}px system-ui, -apple-system, sans-serif`;

  [before, after].forEach((p, i) => {
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
    ctx.fillText(fmtDate(p.takenAt), x + 36, ph - 84, pw - 72);
    if (p.weight != null) {
      ctx.font = font(500, 32);
      ctx.fillStyle = '#d4d8de';
      ctx.fillText(fmtWeight(p), x + 36, ph - 36, pw - 72);
    }
  });

  const days = Math.round(Math.abs(after.takenAt - before.takenAt) / DAY);
  const wb = weightIn(before), wa = weightIn(after);
  const footerText = [`${days} days`, wb != null && wa != null && fmtDelta(round1(wa - wb)), poseLabel(before.pose)].filter(Boolean).join('   ·   ');
  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, 46);
  ctx.textAlign = 'center';
  ctx.fillText(footerText, canvas.width / 2, ph + footer / 2 + 16, canvas.width - 80);

  const blob = await canvasToBlob(canvas, 0.92);
  const file = new File([blob], `progress-${toDateInput(before.takenAt)}-to-${toDateInput(after.takenAt)}.jpg`, { type: 'image/jpeg' });
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
      <p class="muted">Keep these the same every time.</p>
      <ul class="checklist">${TIPS.map((t) => `
        <li><button class="check-item ${guide.checked.has(t.id) ? 'done' : ''}" data-check="${t.id}" aria-pressed="${guide.checked.has(t.id)}">
          <span class="box" aria-hidden="true">${icon('check')}</span><span>${t.check}</span></button></li>`).join('')}
      </ul>
      <label class="toggle-row plain"><input type="checkbox" class="switch" data-guide-skip><span>Don’t show again today</span></label>
      <button class="btn primary wide" data-guide-continue>${done === TIPS.length ? 'All set, open camera' : `Open camera <span class="progress">${done}/${TIPS.length}</span>`}</button>
      <button class="link-btn" data-go="tips">Why these matter</button>
    </div>`;
}

function renderCapture() {
  if (shouldShowGuide()) return renderGuide();
  const ghost = ghostPhoto();
  view.innerHTML = `${poseTabs(state.pose)}
    <div class="cam-frame ${camera.grid ? 'show-grid' : ''}">
      <video id="camVideo" playsinline muted autoplay></video>
      <img class="ghost" id="ghostImg" alt="" ${ghost ? `src="${urlFor(ghost)}"` : 'hidden'} style="opacity:${camera.ghost}">
      <div class="grid-overlay"></div>
      <div class="countdown" id="countdown" hidden></div>
      <div class="cam-msg" id="camMsg" hidden></div>
      <div class="cam-tools">
        <button class="cam-tool ${camera.grid ? 'on' : ''}" data-grid aria-label="Grid" aria-pressed="${camera.grid}">${icon('grid')}</button>
        <button class="cam-tool ${camera.timer ? 'on' : ''}" data-timer aria-label="Timer">${icon('timer')}<b>${camera.timer ? `${camera.timer}s` : ''}</b></button>
      </div>
      <label class="ghost-ctl ${ghost ? '' : 'disabled'}">
        <span>Ghost</span>
        <input type="range" min="0" max="0.8" step="0.05" value="${camera.ghost}" data-ghost ${ghost ? '' : 'disabled'} aria-label="Ghost overlay of your last photo">
      </label>
    </div>
    <div class="cam-actions">
      <label class="cam-round" aria-label="Upload from library">${icon('upload')}
        <input type="file" accept="image/*" data-upload hidden>
      </label>
      <button class="shutter" data-shutter aria-label="Take photo"><span></span></button>
      <button class="cam-round" data-flip aria-label="Switch camera">${icon('flip')}</button>
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
      ? 'Camera permission was denied. Allow it in Settings, or upload a photo instead.'
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
let sheetTimer = null;

function openSheet(html, cleanup, { tall = false } = {}) {
  closeSheet({ immediate: true });
  const body = $('.sheet-body', sheet);
  body.innerHTML = `<div class="sheet-grabber" aria-hidden="true"></div>${html}`;
  body.classList.toggle('tall', tall);
  body.scrollTop = 0;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  void sheet.offsetWidth; // start the slide-up from the closed position
  sheet.classList.add('open');
  sheetCleanup = cleanup;
}

function closeSheet({ immediate = false } = {}) {
  clearTimeout(sheetTimer);
  if (sheet.hidden) return;
  sheet.classList.remove('open');
  document.body.classList.remove('sheet-open');
  const finish = () => {
    sheet.hidden = true;
    $('.sheet-body', sheet).innerHTML = '';
    sheetCleanup?.();
    sheetCleanup = null;
  };
  if (immediate || reducedMotion.matches) finish();
  else sheetTimer = setTimeout(finish, 260);
}

function openReview(blob, takenAt) {
  const preview = URL.createObjectURL(blob);
  const prev = ghostPhoto();
  openSheet(`
    <form class="review" data-review>
      <div class="sheet-head"><h2>Save photo</h2></div>
      <div class="review-pair ${prev ? '' : 'solo'}">
        ${prev ? `<figure><img src="${urlFor(prev, 'thumb')}" alt=""><figcaption>Last · ${shortDate(prev.takenAt)}</figcaption></figure>` : ''}
        <figure><img src="${preview}" alt="New photo"><figcaption class="new">New</figcaption></figure>
      </div>
      <fieldset class="pose-tabs" aria-label="Pose">
        ${POSES.map((p) => `<label class="${p.id === state.pose ? 'active' : ''}"><input type="radio" name="pose" value="${p.id}" ${p.id === state.pose ? 'checked' : ''}>${p.label}</label>`).join('')}
      </fieldset>
      <div class="field-row">
        <label class="field">Date <input type="date" name="date" value="${toDateInput(takenAt)}" max="${toDateInput(Date.now())}"></label>
        <label class="field">Weight (${state.unit}) <input type="number" name="weight" inputmode="decimal" step="0.1" min="0" placeholder="Optional"></label>
      </div>
      <label class="field">Note <input type="text" name="note" maxlength="140" placeholder="Optional" enterkeyhint="done"></label>
      <div class="row-actions">
        <button type="button" class="btn ghost-btn" data-close>Retake</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`, () => URL.revokeObjectURL(preview));

  const form = $('[data-review]', sheet);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'pose') form.querySelectorAll('.pose-tabs label').forEach((l) => l.classList.toggle('active', l.firstElementChild.checked));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const weight = parseFloat(data.get('weight'));
    const pose = data.get('pose');
    form.querySelector('[type=submit]').disabled = true;
    try {
      const id = await savePhoto({
        blob,
        pose,
        takenAt: fromDateInput(data.get('date'), takenAt),
        weight: Number.isFinite(weight) ? weight : null,
        note: String(data.get('note') || '').trim(),
      });
      closeSheet();
      state.pose = pose;
      // The new photo becomes After; a pose's first photo becomes Before.
      if (photosFor(pose).length === 1) state.compare.picks[pose] = { before: id, after: null };
      else setPick(pose, 'after', id);
      toast('Saved');
      go('compare');
    } catch (err) {
      console.error(err);
      toast('Couldn’t save — storage may be full');
      form.querySelector('[type=submit]').disabled = false;
    }
  });
}

function openDetail(id) {
  const p = photoById(id);
  if (!p) return;
  openSheet(`
    <div class="detail">
      <img src="${urlFor(p)}" alt="${poseLabel(p.pose)}, ${fmtDate(p.takenAt)}">
      <div class="detail-meta">
        <strong>${fmtDate(p.takenAt, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}</strong>
        <span>${poseLabel(p.pose)}${p.weight != null ? ` · ${fmtWeight(p)}` : ''}</span>
        ${p.note ? `<p>${esc(p.note)}</p>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn ghost-btn" data-set="before" data-id="${p.id}">Set as Before</button>
        <button class="btn ghost-btn" data-set="after" data-id="${p.id}">Set as After</button>
      </div>
      <div class="row-actions">
        <button class="btn danger" data-delete="${p.id}">Delete</button>
        <button class="btn primary" data-close>Done</button>
      </div>
    </div>`, null, { tall: true });
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
  const days = Math.floor((Date.now() - ms) / DAY);
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
  $('.tab-dot').hidden = true;
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
      <div class="sheet-head"><h2>Backup &amp; restore</h2><button class="btn ghost-btn sm" data-close>Close</button></div>
      <p class="muted">Photos are only stored on this phone. Save a backup to Files or iCloud Drive so you don’t lose them.</p>
      <p class="backup-status ${needsBackup() ? 'warn' : ''}" data-backup-status>${backupStatus()}</p>
      <div data-backup-slot>
        <button class="btn primary wide" data-backup-create ${n ? '' : 'disabled'}>Create backup</button>
      </div>
      <h3>Restore</h3>
      <p class="muted">Pick a backup .zip. Photos already here are skipped.</p>
      <label class="btn ghost-btn wide">Restore from backup
        <input type="file" accept=".zip,application/zip" data-restore hidden>
      </label>
      <p class="muted small" data-restore-status></p>
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

// ---------- push reminders ----------

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const PUSH_NOTES = {
  unconfigured: 'Reminders need the free reminder server set up first: follow worker/README.md, then put its URL in js/config.js.',
  'needs-install': 'On iPhone, notifications only work in the installed app. In Safari tap Share → Add to Home Screen, then open Gym Progress from that icon. Needs iOS 16.4 or later.',
  unsupported: 'This browser doesn’t support push notifications.',
  denied: 'Notifications are blocked. Allow them in your phone’s Settings → Notifications → Gym Progress.',
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
        <button class="btn ghost-btn" data-push-test>Send test</button>
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
    renderPushControls('Reminders are on. Tap “Send test” to check.');
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

// ---------- settings ----------

function renderSettings() {
  view.innerHTML = `
    <h2 class="group-title">Daily reminder</h2>
    <section class="group">
      <label class="row">Remind me at <input type="time" value="${state.reminderTime}" data-reminder-time></label>
      <div class="row-block push-controls" data-push><p class="muted small">Checking…</p></div>
    </section>

    <h2 class="group-title">Photos</h2>
    <section class="group">
      <button class="row" data-go="tips"><span>How to take good progress photos</span>${icon('chevron')}</button>
      <label class="row"><span>Checklist before the camera</span>
        <input type="checkbox" class="switch" data-guide-enabled ${readPref('guideEnabled', '1') === '1' ? 'checked' : ''}></label>
    </section>

    <h2 class="group-title">Weight unit</h2>
    <section class="group pad">
      <div class="segmented">
        <button data-unit="lb" class="${state.unit === 'lb' ? 'active' : ''}">Pounds</button>
        <button data-unit="kg" class="${state.unit === 'kg' ? 'active' : ''}">Kilograms</button>
      </div>
    </section>

    <h2 class="group-title">Data</h2>
    <section class="group">
      <button class="row" data-backup-open>
        <span>Backup &amp; restore${needsBackup() ? '<i class="dot" aria-label="New photos not backed up"></i>' : ''}</span>
        <span class="row-detail">${fmtAgo(state.lastBackup)}${icon('chevron')}</span>
      </button>
    </section>`;
  renderPushControls();
}

function renderTips() {
  view.innerHTML = `
    <p class="muted intro">Progress is slow, so small changes in how you take the photo can hide it or fake it. Keep everything the same and the only thing that changes is you.</p>
    <ol class="tips">${TIPS.map((t) => `
      <li class="card"><h3>${t.title}</h3><p class="tip-do">${t.check}</p><p>${t.why}</p></li>`).join('')}
    </ol>`;
}

// ---------- gallery ----------

function renderGallery() {
  const list = (state.galleryPose === 'all' ? state.photos : photosFor(state.galleryPose)).slice().reverse();
  const months = [];
  for (const p of list) {
    const key = monthKey(p.takenAt);
    if (months[months.length - 1]?.key !== key) months.push({ key, photos: [] });
    months[months.length - 1].photos.push(p);
  }
  view.innerHTML = `${poseTabs(state.galleryPose, { includeAll: true, action: 'gpose' })}
    ${months.length ? months.map((m) => {
      const avg = avgWeight(photosInPeriod(state.photos, { from: m.key, to: m.key }), (p) => weightIn(p));
      return `
      <section class="month">
        <h2 class="month-head"><span>${monthLabel(m.key, { month: 'long', year: 'numeric' })}</span>
          <span class="muted">${m.photos.length} photo${m.photos.length === 1 ? '' : 's'}${avg ? ` · avg ${round1(avg.avg)} ${state.unit}` : ''}</span></h2>
        <div class="grid">${m.photos.map((p) => `
          <button class="tile" data-open="${p.id}" aria-label="${poseLabel(p.pose)}, ${fmtDate(p.takenAt)}">
            <img src="${urlFor(p, 'thumb')}" alt="" loading="lazy">
            <span class="tile-meta">${shortDate(p.takenAt)}${state.galleryPose === 'all' ? ` · ${poseLabel(p.pose)}` : ''}</span>
          </button>`).join('')}
        </div>
      </section>`;
    }).join('') : `
      <div class="empty"><h2>No photos yet</h2><p>Photos you take are stored privately on this phone.</p>
      <button class="btn primary" data-go="capture">Take a photo</button></div>`}`;
}

// ---------- meals ----------

function renderMeals() {
  view.innerHTML = `
    <div class="empty">
      <div class="empty-icon">${icon('meals')}</div>
      <h2>Meals are coming soon</h2>
      <p>This tab is reserved for meal tracking.</p>
    </div>`;
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-close]');
  if (!t || t.disabled) return;
  const d = t.dataset;

  if ('close' in d) return closeSheet();
  if ('backupOpen' in d) return openBackup();
  if ('back' in d) return go(state.backStack.pop() ?? 'settings', { isBack: true });
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
  if (d.go) { closeSheet({ immediate: true }); return go(d.go); }
  if ('goCamera' in d) { closeSheet(); return go('capture'); }

  if (d.pose) {
    state.pose = d.pose;
    if (state.view === 'capture') {
      // Update in place so the camera stream keeps running.
      document.querySelectorAll('[data-pose]').forEach((c) => {
        c.classList.toggle('active', c.dataset.pose === d.pose);
        c.setAttribute('aria-selected', c.dataset.pose === d.pose);
      });
      const ghost = ghostPhoto();
      const img = $('#ghostImg');
      const ctl = $('[data-ghost]');
      if (ghost) img.src = urlFor(ghost); else img.removeAttribute('src');
      img.hidden = !ghost;
      ctl.disabled = !ghost;
      ctl.closest('label').classList.toggle('disabled', !ghost);
    } else {
      render();
    }
    return;
  }
  if (d.gpose) { state.galleryPose = d.gpose; return render(); }
  if (d.open) return openDetail(Number(d.open));
  if (d.slot) return openPicker(d.slot);
  if (d.pickPhoto) {
    setPick(state.pose, d.side, Number(d.pickPhoto));
    closeSheet();
    return render();
  }
  if (d.quick) {
    const q = quickPair(d.quick, photosFor(state.pose));
    if (q) state.compare.picks[state.pose] = q;
    return render();
  }
  if (d.mode) { state.compare.mode = d.mode; return render(); }
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
    t.setAttribute('aria-pressed', camera.grid);
    $('.cam-frame').classList.toggle('show-grid', camera.grid);
    return;
  }
  if ('timer' in d) {
    camera.timer = { 0: 3, 3: 10, 10: 0 }[camera.timer];
    t.classList.toggle('on', !!camera.timer);
    t.querySelector('b').textContent = camera.timer ? `${camera.timer}s` : '';
    return;
  }
  if (d.set) {
    const p = photoById(Number(d.id));
    state.pose = p.pose;
    setPick(p.pose, d.set, p.id);
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
  if ('upload' in t.dataset) {
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
  try {
    localStorage.removeItem('gp:reminderSaved'); // left over from calendar reminders
    localStorage.removeItem('gp:compareKind');   // left over from Dates/Periods/Timeline
  } catch { /* storage unavailable */ }
  syncPush();
})();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Tapping a reminder notification while the app is open.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-capture') go('capture');
  });
}
