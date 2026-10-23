// Daily reminder push notifications, sent by the Cloudflare Worker in /worker.
import { PUSH_WORKER_URL } from './config.js';

const workerUrl = PUSH_WORKER_URL.replace(/\/+$/, '');
let publicKey = null;

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// 'ready' | 'unconfigured' | 'needs-install' | 'unsupported' | 'denied'
export function pushSupport() {
  if (!workerUrl) return 'unconfigured';
  if (isIOS() && !isStandalone()) return 'needs-install'; // iOS only allows push in Home Screen apps
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

async function api(path, body) {
  const res = await fetch(workerUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Server error ${res.status}`), { status: res.status });
  return data;
}

// Fetched when Settings opens, so the tap on "Enable reminders" goes straight
// to the permission prompt (iOS only shows it in direct response to a tap).
export async function prefetchPublicKey() {
  if (publicKey) return publicKey;
  const res = await fetch(`${workerUrl}/vapid-public-key`);
  if (!res.ok) throw new Error('Couldn’t reach the reminder server');
  publicKey = (await res.json()).key;
  return publicKey;
}

function keyBytes(b64url) {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function sameKey(buffer, bytes) {
  const a = new Uint8Array(buffer ?? []);
  return a.length === bytes.length && a.every((b, i) => b === bytes[i]);
}

export async function getSubscription() {
  if (!workerUrl || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// info: { time: 'HH:MM', timezone, lastPhotoDay, streak }. Must be called from a tap.
export async function enableReminders(info) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('Notifications weren’t allowed'), { code: permission });
  const [key, reg] = await Promise.all([prefetchPublicKey(), navigator.serviceWorker.ready]);
  const appKey = keyBytes(key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, appKey)) {
    await sub.unsubscribe(); // made with an older server key
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  await api('/subscribe', { subscription: sub.toJSON(), ...info });
  return sub;
}

// Updates the reminder time on the server. Returns false if reminders are off.
export async function updateReminders(info) {
  const sub = await getSubscription();
  if (!sub) return false;
  await api('/subscribe', { subscription: sub.toJSON(), ...info });
  return true;
}

// Tells the server about the latest photo so it can skip today's reminder and
// show the streak. Re-registers if the server has lost this subscription
// (for example after the browser renewed it).
export async function syncPhotos(info) {
  const sub = await getSubscription();
  if (!sub) return;
  try {
    await api('/logged', { endpoint: sub.endpoint, lastPhotoDay: info.lastPhotoDay, streak: info.streak });
  } catch (err) {
    if (err.status !== 404) throw err;
    await api('/subscribe', { subscription: sub.toJSON(), ...info });
  }
}

export async function sendTest() {
  const sub = await getSubscription();
  if (!sub) throw new Error('Reminders are off');
  return api('/test', { endpoint: sub.endpoint });
}

export async function disableReminders() {
  const sub = await getSubscription();
  if (!sub) return;
  await api('/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); // the server also drops dead subscriptions itself
  await sub.unsubscribe();
}
