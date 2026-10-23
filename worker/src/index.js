// Gym Progress push reminder Worker.
//
//   GET  /vapid-public-key  public key the app subscribes with
//   POST /subscribe         { subscription, time: "HH:MM", timezone, lastPhotoDay, streak }
//   POST /unsubscribe       { endpoint }
//   POST /logged            { endpoint, lastPhotoDay, streak }  (sent when a photo is saved)
//   POST /test              { endpoint }  sends a notification right away
//   cron (every 15 min)     sends due reminders
//
// A subscription's endpoint is an unguessable URL, so knowing it is what
// authorizes changes to that subscription's record.
import { sendPush } from './webpush.js';
import { dueDay, isValidTimeZone, localParts, reminderMessage } from './schedule.js';

const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 8 * 1024;

function allowedOrigins(env) {
  return (env.APP_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const allowed = allowedOrigins(env);
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

function isAllowedEndpoint(endpoint, env) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  // Local testing only: lets `wrangler dev` deliver to a mock push service.
  if (env.ALLOW_LOCAL_ENDPOINTS === 'true' && url.hostname === 'localhost') return true;
  return url.protocol === 'https:' && PUSH_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s));
}

async function keyFor(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return `sub:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function vapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT secrets must be set');
  }
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}

function photoState(body, existing) {
  return {
    lastPhotoDay: DAY_RE.test(body.lastPhotoDay ?? '') ? body.lastPhotoDay : body.lastPhotoDay === null ? null : existing?.lastPhotoDay ?? null,
    streak: Number.isInteger(body.streak) && body.streak >= 0 && body.streak < 100000 ? body.streak : existing?.streak ?? 0,
  };
}

async function notify(record, env, { test = false, now = Date.now() } = {}) {
  const today = localParts(now, record.timezone).day;
  const payload = JSON.stringify({
    title: test ? 'Gym Progress (test)' : 'Gym Progress',
    body: reminderMessage(record, today),
    url: './?capture=1',
  });
  return sendPush(record.subscription, payload, vapid(env), { topic: 'daily-reminder' });
}

async function handle(request, env) {
  const cors = corsHeaders(request, env);
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET' && pathname === '/') return new Response('Gym Progress push worker is running.\n', { headers: cors });
  if (request.method === 'GET' && pathname === '/vapid-public-key') {
    if (!env.VAPID_PUBLIC_KEY) return json({ error: 'VAPID_PUBLIC_KEY secret is not set' }, 500, cors);
    return json({ key: env.VAPID_PUBLIC_KEY }, 200, cors);
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);

  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  if (origin && !allowed.includes('*') && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Request too large' }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

  if (pathname === '/subscribe') {
    const sub = body.subscription;
    if (!sub || !isAllowedEndpoint(sub.endpoint, env) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
      return json({ error: 'Invalid subscription' }, 400, cors);
    }
    if (!TIME_RE.test(body.time ?? '')) return json({ error: 'time must be HH:MM' }, 400, cors);
    if (!isValidTimeZone(body.timezone)) return json({ error: 'Invalid timezone' }, 400, cors);
    const key = await keyFor(sub.endpoint);
    const existing = await env.SUBS.get(key, 'json');
    const record = {
      subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      time: body.time,
      timezone: body.timezone,
      ...photoState(body, existing),
      lastSentDay: existing?.lastSentDay ?? null, // re-subscribing never causes a second reminder the same day
      updatedAt: Date.now(),
    };
    await env.SUBS.put(key, JSON.stringify(record));
    return json({ ok: true }, 200, cors);
  }

  if (typeof body.endpoint !== 'string') return json({ error: 'endpoint is required' }, 400, cors);
  const key = await keyFor(body.endpoint);

  if (pathname === '/unsubscribe') {
    await env.SUBS.delete(key);
    return json({ ok: true }, 200, cors);
  }

  const record = await env.SUBS.get(key, 'json');
  if (!record) return json({ error: 'Not subscribed' }, 404, cors);

  if (pathname === '/logged') {
    Object.assign(record, photoState(body, record), { updatedAt: Date.now() });
    await env.SUBS.put(key, JSON.stringify(record));
    return json({ ok: true }, 200, cors);
  }

  if (pathname === '/test') {
    const res = await notify(record, env, { test: true });
    if (res.status === 404 || res.status === 410) {
      await env.SUBS.delete(key);
      return json({ error: 'Subscription expired' }, 410, cors);
    }
    return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

// Sends every reminder that is due in the window ending at `now`, unless it was
// already sent today or a photo was already logged today.
export async function runReminders(env, now) {
  let cursor;
  let sent = 0;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const { name } of page.keys) {
      const record = await env.SUBS.get(name, 'json');
      if (!record) continue;
      const day = dueDay(record, now);
      if (!day || record.lastSentDay === day || record.lastPhotoDay === day) continue;
      let res;
      try {
        res = await notify(record, env, { now });
      } catch (err) {
        console.error('push failed', err);
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await env.SUBS.delete(name);
      } else if (res.ok) {
        record.lastSentDay = day;
        await env.SUBS.put(name, JSON.stringify(record));
        sent++;
      } else {
        console.error('push service returned', res.status, await res.text());
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return sent;
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500, corsHeaders(request, env));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, event.scheduledTime).then((n) => console.log(`sent ${n} reminder(s)`)));
  },
};
