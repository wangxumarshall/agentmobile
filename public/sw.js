const CACHE_NAME = 'agentmobile-v4';
// Cache only truly static assets — NOT index.html (references hashed JS bundles that change each build)
const STATIC_ASSETS = ['/icon.svg', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Skip API, WebSocket, and navigation requests (let browser handle them fresh)
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (event.request.mode === 'navigate') return;

  // Cache-first for known static assets (icon, manifest, Vite hashed bundles)
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
