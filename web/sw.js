// Service worker: the app shell works offline. Everything in SHELL is cached under a name that includes the build,
// so a new deploy replaces the whole set at once. Data never goes through here: it lives in IndexedDB (see js/store.js),
// and Supabase requests are left alone.
const BUILD = '__BUILD__';
const SHELL_CACHE = 'tt-shell-' + BUILD;
const RUNTIME = ['tt-fonts', 'tt-images'];
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'credits.json', 'images/manifest.json',
  'css/app.css',
  'js/main.js', 'js/app.js', 'js/store.js', 'js/db.js', 'js/mapping.js', 'js/catalog-order.js', 'js/dom.js',
  'js/settings.js', 'js/suggestions.js', 'js/location.js', 'js/config.js', 'js/theme.js', 'js/supabase.umd.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL_CACHE && !RUNTIME.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== location.origin) {
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(staleWhileRevalidate('tt-fonts', req));
    return;                                    // Supabase and everything else: straight to the network
  }
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { cacheName: SHELL_CACHE }).then((r) => r || fetch(req)));
    return;
  }
  if (url.pathname.includes('/images/') && !url.pathname.endsWith('manifest.json')) { e.respondWith(staleWhileRevalidate('tt-images', req)); return; }
  e.respondWith(caches.match(req, { cacheName: SHELL_CACHE, ignoreSearch: true }).then((r) => r || fetch(req)));
});
