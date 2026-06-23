'use strict';

const CACHE_NAME = 'schichtscan-v1.2.2-ios';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=1.2.2',
  './parser.js?v=1.2.2',
  './ics.js?v=1.2.2',
  './app.js?v=1.2.2',
  './manifest.webmanifest?v=1.2.2',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './tesseract.min.js?v=1.2.2',
  './worker.min.js',
  './tesseract-core-lstm.wasm.js',
  './deu.traineddata.gz'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', response.clone()).catch(() => {});
        return response;
      } catch (_) {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  })());
});
