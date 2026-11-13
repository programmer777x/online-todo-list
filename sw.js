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
// 1.4 — Cache bump for the payload/migration fix. CACHE_NAME goes from
//       todo-cache-v10 to todo-cache-v11 so returning clients fetch the
//       updated js/sync.js (migration branch reads a localState fallback
//       instead of the always-undefined window.state, pushList always
//       sends a real created_at, and both push handlers log the payload
//       they attempt to insert). Without this bump, returning users would
//       keep the v10 cache and the migration would keep silently skipping
//       because that version tests `window.state` directly.
//
// 1.5 — Cache bump for the password-input guard. CACHE_NAME goes from
//       todo-cache-v11 to todo-cache-v12 so returning clients fetch the
//       updated js/ui.js (password sign-in handler now checks
//       dom.authPasswordInput and logs a specific error instead of
//       throwing silently) and the current js/render.js (whose cacheDom()
//       does populate dom.authPasswordInput). The reason the password
//       sign-in was silently failing was a stale render.js served from
//       the v11 cache, where the reference was missing; bumping to v12
//       is what actually forces the client to pick up the current file.
//       The ui.js guard is the belt-and-braces.
//
// 1.6 — Cache bump for the self-contained auth cache. CACHE_NAME goes
//       from todo-cache-v12 to todo-cache-v13 so returning clients fetch
//       the updated js/ui.js whose wireAuthEvents() now owns its own DOM
//       lookups instead of reading off render.js's top-level `const dom`
//       object. `dom` is not on `window`, so any diagnostic that tried
//       `window.dom.authPasswordInput` saw `undefined` even when the
//       cache was populated -- and any auth code that relied on `dom.auth*`
//       was coupled to render.js load order. The 1.6 ui.js closes both
//       failure modes; this bump is what makes it reach returning clients.
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
// - Bumped CACHE_NAME from `todo-cache-v10` to `todo-cache-v11` so browsers fetch
//   the v1.6 js/sync.js -- the migration branch that reads `typeof state !==
//   'undefined' ? state : window.state`, the pushList `created_at` fallback,
//   and the "Sync: Pushing list/task" payload logging. Without this bump,
//   returning clients would keep running the v10 sync.js whose migration
//   branch is gated on `window.state` (always undefined here) and would
//   never migrate.
// - Bumped CACHE_NAME from `todo-cache-v11` to `todo-cache-v12` so browsers fetch
//   the current js/render.js (whose cacheDom() populates dom.authPasswordInput)
//   and the guarded js/ui.js. Without this bump, returning clients would stay
//   on the v11 cache and the stale render.js would keep returning `undefined`
//   for dom.authPasswordInput -- the exact failure that made the password
//   sign-in handler throw silently on click.
// - Bumped CACHE_NAME from `todo-cache-v12` to `todo-cache-v13` so browsers fetch
//   the self-contained js/ui.js whose wireAuthEvents() looks up auth elements
//   by id at function entry instead of reading them off render.js's top-level
//   `const dom`. That removes the last cross-file coupling in the auth flow
//   and the last silent failure mode it caused.
//
// ================================================================================================

const CACHE_NAME = 'todo-cache-v13';

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
