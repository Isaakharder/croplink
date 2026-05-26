// CropLink Service Worker — v2
// Strategy:
//   GET /api/*            → network-first, cache fallback
//   *.js / *.css assets   → cache-first (hashed filenames, long-lived)
//   navigation (HTML)     → network-first, fall back to cached shell
//   POST / PATCH etc      → pass through (offline queue handled in JS)

const CACHE_VERSION = 'croplink-v2';
const SHELL_URLS = ['/', '/mobile', '/manifest.json', '/icon-192.png', '/icon-512.png'];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Warm the shell; ignore individual failures so SW still installs
      Promise.allSettled(SHELL_URLS.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Pass through non-GET methods — offline queue handles them in JS
  if (request.method !== 'GET') return;

  // API reads: network-first, update cache on success
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  // Hashed static assets (JS/CSS/fonts/images): cache-first
  if (isHashedAsset(url.pathname)) {
    event.respondWith(cacheFirstWithNetwork(request));
    return;
  }

  // Navigation requests (HTML / SPA routes): network-first, fall back to shell
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }
});

// ── Strategy helpers ──────────────────────────────────────────────────────────

function isHashedAsset(pathname) {
  return /\/assets\/[^/]+\.(js|css|woff2?|ttf|eot|png|svg)$/.test(pathname);
}

async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirstWithNetwork(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Asset not available offline', { status: 503 });
  }
}

async function navigationHandler(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Fall back to the cached mobile shell for all navigation
    const cached =
      (await cache.match(request)) ||
      (await cache.match('/mobile')) ||
      (await cache.match('/'));
    if (cached) return cached;
    return new Response('<h1>CropLink — offline</h1>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }
}
