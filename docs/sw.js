/* ============================================================
   sw.js — Our Music service worker (PWA).
   Caches the app shell so the interface loads offline; song
   bytes and every Supabase call ALWAYS go to the network:
     * /functions/  (Edge Functions: library, playback links...)
     * /storage/    (upload staging)
     * /auth/       (login sessions)
   are never cached or served from cache — private data must
   never live in a shared cache, and playback links expire.
   Strategy: stale-while-revalidate for the static shell,
   network-first for navigations with an offline fallback.
   ============================================================ */
const VERSION = 'om-v3';
const CORE = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './ui.js',
  './om-core.js',
  './functions.js',
  './player.js',
  './equalizer.js',
  './lyrics.js',
  './sort.js',
  './browse.js',
  './library.js',
  './playlists.js',
  './admin.js',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // uploads/edits always hit the network

  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;            // data: URIs etc. — not ours to handle

  // NEVER intercept private / expiring backend traffic
  if (url.pathname.includes('/functions/') ||
      url.pathname.includes('/storage/') ||
      url.pathname.includes('/auth/')) {
    return;                                               // default network pass-through
  }

  // page navigations: network first, offline -> cached shell
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() =>
        caches.match('./index.html').then((r) => r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
      )
    );
    return;
  }

  // static assets (same origin or the two CDN scripts): stale-while-revalidate
  const isStatic = url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net';
  if (!isStatic) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
