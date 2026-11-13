// Keeps the app's own files available offline. Network first, so a new version shows as soon as
// it is reachable; the saved copy is used only when the network is not. Data is not handled here.
const CACHE = 'shared-intelligence-shell-v4';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'logic.js', 'data.js', 'crypto.js', 'icon.svg', 'icon-192.png', 'apple-touch-icon.png', 'manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && /^(signal|shared-intelligence)-shell-/.test(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL('./', location).pathname)) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
