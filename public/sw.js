// The service worker: just enough for the site to install as an app and to
// open its own pages on a flaky connection.
//
// It never touches /api/ — not the event stream, not signaling, and above all
// not the screen-off audio stream, which must go straight to the network and
// would break in the strangest ways if anything here buffered it. Pages go
// network-first (a stale room page is worse than a slow one); fonts and icons
// go cache-first.

const SHELL = 'hwm-shell-v1';
const PRECACHE = ['/', '/style.css', '/app.js', '/fonts/Vazirmatn.woff2', '/favicon.svg', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const lasting = /\.(woff2|png|ico|svg)$/.test(url.pathname);
  if (lasting) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(request, copy)); }
      return res;
    })));
    return;
  }

  // Everything else: the network's answer, with the last good copy as a
  // fallback when there is no network at all.
  event.respondWith(fetch(request).then((res) => {
    if (res.ok && !url.pathname.startsWith('/r/')) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(request, copy));
    }
    return res;
  }).catch(() => caches.match(request).then((hit) => hit || caches.match('/'))));
});
