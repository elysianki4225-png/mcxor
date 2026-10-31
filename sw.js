/**
 * MCXOR Offline PWA Service Worker
 * Uses relative scope-aware App Shell caching + automatic stale cache eviction (zero cache storage leak).
 */

const CACHE_NAME = 'mcxor-pwa-v1.0.0';

const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/main.css',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './src/vendor/fflate.js',
  './src/core/xorCrypto.js',
  './src/core/zipStream.js',
  './src/core/integrity.js',
  './src/core/archiveEngine.js',
  './src/worker/archiveWorker.js',
  './src/app/memoryGuard.js',
  './src/app/folderReader.js',
  './src/app/sampleGenerator.js',
  './src/app/theme.js',
  './src/app/pwa.js',
  './src/app/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for same-origin static assets; offline fallback to index.html for navigations
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        return cached;
      }

      const fresh = await networkPromise;
      if (fresh) return fresh;

      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }

      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
