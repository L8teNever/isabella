// Offline: App-Dateien je Version cachen (Version setzt der Container beim Start)
const VERSION = '__APP_VERSION__';
const CACHE = `lara-${VERSION}`;
const FILES = ['/', '/index.html', '/style.css', '/lara.js', '/bowling.js', '/score.js', '/sound.js',
  '/golf.html', '/golf.js', '/golf-course.js', '/room-scan.js', '/ui-xr.js', '/lane-fit.js',
  '/vendor/three.module.min.js', '/vendor/cannon-es.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  await Promise.all(FILES.map(async (u) => { const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) await c.put(u, r); }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('lara-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || req.url.endsWith('/sw.js')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(async () => (await caches.match('/index.html')) || Response.error()));
    return;
  }
  e.respondWith((async () => (await caches.match(req)) || fetch(req))());
});
