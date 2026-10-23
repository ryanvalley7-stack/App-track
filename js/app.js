import * as db from './db.js';
import { createZip, readZip } from './zip.js';

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
  compare: { beforeId: null, afterId: null, mode: 'side', split: 50 },
  unit: readPref('unit', 'lb'),
  lastBackup: Number(readPref('lastBackup', 0)),
};

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
  return id;
}

async function deletePhoto(id) {
  await db.remove(id);
  dropUrls(id);
  if (state.compare.beforeId === id) state.compare.beforeId = null;
  if (state.compare.afterId === id) state.compare.afterId = null;
  await reload();
}

// ---------- navigation ----------

function go(name) {
  if (state.view === 'capture' && name !== 'capture') stopCamera();
  state.view = name;
  document.querySelectorAll('.tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  render();
}

function render() {
  view.dataset.view = state.view;
  $('#backupBtn .dot').hidden = !needsBackup();
  if (state.view === 'compare') renderCompare();
  else if (state.view === 'capture') renderCapture();
  else renderGallery();
}

// ---------- compare ----------

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

function renderCompare() {
  const { list, before, after } = resolveCompare();
  const c = state.compare;

  if (list.length === 0) {
    view.innerHTML = `${poseChips(state.pose)}
      <div class="empty">
        <div class="empty-art"><div></div><div></div></div>
        <h2>No ${poseLabel(state.pose).toLowerCase()} photos yet</h2>
        <p>Take your first progress photo. Your next one will show up right beside it.</p>
        <button class="btn primary" data-go="capture">Take a photo</button>
      </div>`;
    return;
  }

  const option = (p, selectedId) =>
    `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${fmtDate(p.takenAt)}</option>`;

  const days = Math.round((after.takenAt - before.takenAt) / 86400000);
  const wb = weightIn(before);
  const wa = weightIn(after);
  const delta = wb != null && wa != null ? Math.round((wa - wb) * 10) / 10 : null;
  const single = list.length === 1;

  view.innerHTML = `${poseChips(state.pose)}
    <div class="pickers">
      <label class="picker before"><span>Before</span>
        <select data-pick="beforeId">${list.map((p) => option(p, before.id)).join('')}</select></label>
      <button class="icon-btn" data-swap aria-label="Swap before and after">⇄</button>
      <label class="picker after"><span>After</span>
        <select data-pick="afterId">${list.map((p) => option(p, after.id)).join('')}</select></label>
    </div>

    <div class="segmented" role="tablist">
      <button data-mode="side" class="${c.mode === 'side' ? 'active' : ''}">Side by side</button>
      <button data-mode="slider" class="${c.mode === 'slider' ? 'active' : ''}">Slider</button>
    </div>

    ${c.mode === 'side' ? `
      <div class="side-by-side">
        ${[['Before', before], ['After', after]].map(([label, p]) => `
          <figure class="panel">
            <img src="${urlFor(p)}" alt="${label} — ${fmtDate(p.takenAt)}">
            <span class="badge ${label.toLowerCase()}">${label}</span>
            <figcaption><strong>${fmtDate(p.takenAt)}</strong>${p.weight != null ? `<span>${fmtWeight(p)}</span>` : ''}</figcaption>
          </figure>`).join('')}
      </div>` : `
      <div class="slider-stage" style="--split:${c.split}%">
        <img class="after-img" src="${urlFor(after)}" alt="After — ${fmtDate(after.takenAt)}">
        <img class="before-img" src="${urlFor(before)}" alt="Before — ${fmtDate(before.takenAt)}">
        <div class="slider-handle"></div>
        <span class="badge before">Before · ${fmtDate(before.takenAt, { month: 'short', day: 'numeric' })}</span>
        <span class="badge after">After · ${fmtDate(after.takenAt, { month: 'short', day: 'numeric' })}</span>
        <input type="range" min="0" max="100" value="${c.split}" data-split aria-label="Reveal before / after">
      </div>`}

    ${single ? `<p class="hint">Only one ${poseLabel(state.pose).toLowerCase()} photo so far — take another to see your progress side by side.</p>` : `
    <div class="stats">
      <div><strong>${Math.abs(days)}</strong><span>day${Math.abs(days) === 1 ? '' : 's'} apart</span></div>
      <div><strong>${delta == null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)} ${state.unit}`}</strong><span>weight change</span></div>
      <div><strong>${list.length}</strong><span>${poseLabel(state.pose).toLowerCase()} photos</span></div>
    </div>`}

    <div class="row-actions">
      <button class="btn primary" data-export ${single ? 'disabled' : ''}>Save comparison image</button>
    </div>`;
}

async function exportComparison() {
  const { before, after } = resolveCompare();
  if (!before || !after) return;
  const [imgB, imgA] = await Promise.all([loadImage(urlFor(before)), loadImage(urlFor(after))]);

  const pw = 900, ph = 1200, gap = 12, footer = 150;
  const canvas = document.createElement('canvas');
  canvas.width = pw * 2 + gap;
  canvas.height = ph + footer;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e1013';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  [[imgB, before, 'BEFORE', 0], [imgA, after, 'AFTER', pw + gap]].forEach(([img, p, label, x]) => {
    drawCover(ctx, img, x, 0, pw, ph);
    const grad = ctx.createLinearGradient(0, ph - 220, 0, ph);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.75)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, ph - 220, pw, 220);
    ctx.fillStyle = label === 'AFTER' ? '#c8ff3d' : '#ffffff';
    ctx.font = '800 44px system-ui, -apple-system, sans-serif';
    ctx.fillText(label, x + 36, ph - 92);
    ctx.fillStyle = '#ffffff';
    ctx.font = '500 34px system-ui, -apple-system, sans-serif';
    ctx.fillText([fmtDate(p.takenAt), fmtWeight(p)].filter(Boolean).join('  ·  '), x + 36, ph - 40);
  });

  const days = Math.round((after.takenAt - before.takenAt) / 86400000);
  const wb = weightIn(before), wa = weightIn(after);
  const parts = [`${Math.abs(days)} days`];
  if (wb != null && wa != null) {
    const d = Math.round((wa - wb) * 10) / 10;
    parts.push(`${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} ${state.unit}`);
  }
  parts.push(poseLabel(before.pose));
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 48px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(parts.join('   ·   '), canvas.width / 2, ph + footer / 2 + 16);

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

function renderCapture() {
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
      render();
    }
    return;
  }
  if (d.gpose) { state.galleryPose = d.gpose; return render(); }
  if (d.open) return openDetail(Number(d.open));
  if (d.mode) { state.compare.mode = d.mode; return render(); }
  if ('swap' in d) {
    const c = state.compare;
    [c.beforeId, c.afterId] = [c.afterId, c.beforeId];
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
  } else if ('upload' in t.dataset) {
    handleUpload(t.files[0]).catch(() => toast('Couldn’t read that image'));
    t.value = '';
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

const unitBtn = $('#unitToggle');
unitBtn.textContent = state.unit;
unitBtn.addEventListener('click', () => {
  state.unit = state.unit === 'lb' ? 'kg' : 'lb';
  writePref('unit', state.unit);
  unitBtn.textContent = state.unit;
  if (state.view !== 'capture') render();
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
  go(state.photos.length ? 'compare' : 'capture');
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
