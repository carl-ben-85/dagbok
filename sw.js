// Service worker: gör att appen fungerar helt utan uppkoppling.
// Höj versionen vid varje ny publicering så att telefonen hämtar de nya filerna.
const VERSION = 'v0.4.4';
const CACHE = `dagbok-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/analysis.js',
  './js/charts.js',
  './js/sync.js',
  './js/config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dagbok-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Sidladdningar: svara från cachen direkt så att appen startar offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req)),
    );
    e.waitUntil(updateCache('./index.html'));
    return;
  }

  // Övriga filer: cache först, uppdatera i bakgrunden.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});

function updateCache(path) {
  return fetch(path, { cache: 'no-store' })
    .then((res) => (res.ok ? caches.open(CACHE).then((c) => c.put(path, res)) : null))
    .catch(() => null);
}
