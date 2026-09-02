// Route 9 — service worker: caches fonts and images on first visit so
// later visits load them instantly from the device instead of the network.
// Bump this version string if any of the files below ever change, so
// returning players get the new versions instead of the old cached ones.
const CACHE_NAME = 'route9-assets-v1';
const ASSETS_TO_CACHE = [
    'icon.png',
    'icon-180.png',
    '4p.webp',
    'huntersurvivor.webp',
    'fonts/SFArabic-Thin.woff2',
    'fonts/SFArabic-Ultralight.woff2',
    'fonts/SFArabic-Light.woff2',
    'fonts/SFArabic-Regular.woff2',
    'fonts/SFArabic-Medium.woff2',
    'fonts/SFArabic-Semibold.woff2',
    'fonts/SFArabic-Bold.woff2',
    'fonts/SFArabic-Heavy.woff2'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) => Promise.all(
            names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        )).then(() => self.clients.claim())
    );
});

// Cache-first for the assets above: once downloaded, they're served
// straight from cache and never re-requested from the network.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    const path = url.pathname.replace(/^\/+/, '');
    if (!ASSETS_TO_CACHE.includes(path)) return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                return response;
            });
        })
    );
});
