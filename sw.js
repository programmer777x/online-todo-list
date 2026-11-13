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
// 1.1 — Cache bump for the header-init fix. CACHE_NAME goes from todo-cache-v6
//       to todo-cache-v8 so returning clients fetch the updated js/ui.js
//       (which now reads window.sync.getSession() at the end of
//       wireAuthEvents() to fix the header button staying on "Sign in to
//       sync" when the initial supabase-auth-changed event fired before
//       the UI attached its listener) and the updated js/sync.js (which
//       exposes window.sync.getClient()). Without this bump, the old
//       cached ui.js / sync.js would keep serving and the fix would not
//       reach returning users.
//
// 1.2 — Cache bump for the mutation-sync hooks. CACHE_NAME goes from
//       todo-cache-v8 to todo-cache-v9 so returning clients fetch the
//       updated js/store.js (saveState() now broadcasts sync-list-change /
//       sync-task-change) and the updated js/sync.js (initSync() now
//       registers the matching listeners and fetchRemoteState() auto-
//       migrates local data on first sign-in with an empty cloud). Without
//       this bump, the mutation hooks would silently no-op on returning
//       users because the old cached store.js has no broadcast and the
//       old cached sync.js has no listener.
//
// 1.3 — Cache bump for the precise-sync fix. CACHE_NAME goes from
//       todo-cache-v9 to todo-cache-v10 so returning clients fetch the
//       updated js/store.js (broadcast moved from saveState()'s broad loop
//       into each mutation function) and js/sync.js (pushList/pushTask
//       rebuilt to accept the precise insert / update / delete payloads).
//       Without this bump, returning users would stay on the v9 cache
//       whose store.js still fired the broad loop on every save and kept
//       hammering Supabase with hundreds of upserts per drag or keystroke.
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
// - Bumped CACHE_NAME from `todo-cache-v6` to `todo-cache-v6` so browsers discard the stale v1
//   cache and fetch the current CSS/JS. This was the reason recent UI fixes were not appearing
//   even after a hard refresh — the v1 worker was serving cached assets before the network
//   request ever went out. Bump this string on every deploy that changes cached files.
// - Corrected the maskable icon filename in ASSETS_TO_CACHE from `./icons/icon-maskable-512.png`
//   to `./icons/icon-maskable-512.png`, matching the actual file on disk. The old path caused
//   `cache.addAll()` to reject during install, which silently aborted the precache step.
// - Bumped CACHE_NAME from `todo-cache-v6` to `todo-cache-v8` so browsers fetch
//   the header-init fix in js/ui.js and the getClient() export in js/sync.js
//   instead of continuing to serve the pre-fix versions from the old cache.
// - Bumped CACHE_NAME from `todo-cache-v8` to `todo-cache-v9` so browsers fetch
//   the mutation-sync hooks in js/store.js and js/sync.js. Without the bump,
//   returning clients would keep the pre-hooks store.js (no broadcast) and
//   sync.js (no listeners, no auto-migration), and local changes would never
//   reach Supabase on those devices.
// - Bumped CACHE_NAME from `todo-cache-v9` to `todo-cache-v10` so browsers fetch
//   the precise-mutation fix in js/store.js and the precise-payload
//   pushList/pushTask in js/sync.js. Without the bump, returning clients
//   would keep the broad-loop store.js from v9 and continue to hammer
//   Supabase with hundreds of upserts per drag or keystroke.
//
// ================================================================================================

const CACHE_NAME = 'todo-cache-v10';

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
  './icons/icon-maskable-512.png'
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
