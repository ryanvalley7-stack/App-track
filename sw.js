// Caches the app shell so it opens offline. Photos live in IndexedDB, not here.
const CACHE = 'gym-progress-v7';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'js/app.js',
  'js/db.js',
  'js/zip.js',
  'js/streak.js',
  'js/push.js',
  'js/config.js',
  'js/guide.js',
  'js/periods.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first so updates show up, falling back to cache when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// ---------- reminder notifications ----------

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data.text() };
  }
  // iOS requires every push to show a notification.
  e.waitUntil(self.registration.showNotification(data.title || 'Gym Progress', {
    body: data.body || 'Progress pic time.',
    icon: 'icons/icon-192.png',
    tag: 'daily-reminder',
    renotify: true,
    data: { url: data.url },
  }));
});

// Opens the app on the camera screen, reusing an open window if there is one.
async function openCamera(url) {
  let target = new URL(url || './?capture=1', self.registration.scope);
  if (target.origin !== self.location.origin) target = new URL('./?capture=1', self.registration.scope);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.length) {
    windows[0].postMessage({ type: 'open-capture' });
    await windows[0].focus().catch(() => {}); // focus can be refused; the message still switches screens
    return;
  }
  await self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(openCamera(e.notification.data?.url));
});
