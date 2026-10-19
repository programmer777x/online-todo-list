// Service Worker Version 1.0
//
// ================================================================================================
//
// Offline cache service worker for the Online To Do List PWA.
//
// This file is a cache-first service worker. It caches the app shell (HTML, CSS, JS, manifest,
// and icons) on install, and serves those cached assets in preference to network requests.
//
// When the app is updated, the CACHE_NAME string should be bumped to invalidate the old cache
// and force the new assets to be downloaded.
//
// ================================================================================================
//
// === REVISIONS ===
//
//
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Implements the core PWA offline functionality.
//
//
//
// ================================================================================================
//
// === FIXES ===
//
//
//
// ================================================================================================

const CACHE_NAME = 'todo-cache-v1';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/themes.css',
  './js/config.js',
  './js/store.js',
  './js/render.js',
  './js/ui.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

// Install: cache all core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first strategy
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cached version if found
      if (response) {
        return response;
      }
      // Otherwise fetch from network
      return fetch(event.request).then((networkResponse) => {
        // Don't cache non-successful responses or non-GET requests
        if (!networkResponse || networkResponse.status !== 200 || event.request.method !== 'GET') {
          return networkResponse;
        }
        // Cache the new asset
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});
