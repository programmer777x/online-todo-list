// Service Worker Version 1.0
//
// ================================================================================================
//
// Offline cache service worker for the Online To Do List PWA.
//
// This file is a cache-first service worker for all assets except the HTML shell. The app shell
// (index.html and the root path) is network-first, so a deployed update lands on the next load
// without a manual cache clear; everything else (CSS, JS, manifest, icons) is served from the
// cache first and refreshed in the background by the install/activate cycle.
//
// Supabase API and Auth traffic is never intercepted — the fetch listener returns early for any
// request whose hostname ends in '.supabase.co', so those calls go straight to the network.
//
// When the app is updated, the CACHE_NAME string should be bumped to invalidate the old cache
// and force the new assets to be downloaded.
//
// ================================================================================================
//
// === REVISIONS ===
//
// 1.1 through 1.28 — prior rounds. See 1.29 for the current bump.
//
// 1.29 — Cache bump for the round-4 fixes: silent sequential-undo
//        failure, snackbar Undo button at the front, Sync before Theme.
//        CACHE_NAME goes from todo-cache-v38 to todo-cache-v39 so
//        returning clients fetch the updated js/store.js (applyUndoAction
//        gains a listId fallback for pre-round-2 entries;
//        undoHistoryEntry returns { ok, undone, failed, dropped } and
//        preserves failing entries instead of silently dropping them;
//        dispatches 'history-undo-failed' when any entry could not be
//        applied), js/ui.js (snackbar Undo button is now the first child
//        of the snackbar; listens for 'history-undo-failed' and shows a
//        non-undoable message so the failure is visible), and index.html
//        (Sync pill sits before Theme in the wide header to match the
//        round-3 spec).
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Implements the core PWA offline functionality.
// - Network-first branch in the fetch listener for the HTML shell.
// - Supabase bypass branch in the fetch listener.
//
// ================================================================================================
//
// === FIXES ===
//
// Every cache-bump entry below corresponds to a `chore(sw): bump cache to
// todo-cache-vN` commit that ships the named source files to returning
// clients. The entry names what the bump delivers so a future agent
// reading sw.js alone can see why the version moved. Detail for older
// rounds is preserved in the source files' own REVISIONS blocks; the
// entries below stay one line per bump to keep this file readable.
//
// - v6 → v8:  header-init fix + getClient() export.
// - v8 → v9:  mutation-sync hooks.
// - v9 → v10: precise-mutation fix.
// - v10 → v11: migration branch fallback + pushList created_at.
// - v11 → v12: dom.authPasswordInput guard + render.js current shape.
// - v12 → v13: self-contained ui.js auth DOM lookups.
// - v13 → v14: auth debug log.
// - v14 → v16: persistent-email auth modal (v15 skipped).
// - v16 → v17: offline-queue durability (boolean returns).
// - v17 → v18: offline-queue flush abort-on-failure.
// - v18 → v19: manual sync status bar.
// - v19 → v20: manual sync boolean result.
// - v20 → v22: sync-state-changed event dispatch.
// - v22 → v23: list rename sync.
// - v23 → v24: signed-out sync bar hide.
// - v24 → v25: reload sync behavior (later reverted).
// - v25 → v27: list-switcher icon sizing.
// - v27 → v28: sign-in reload (later reverted).
// - v28 → v29: sign-in reload + icon fixes.
// - v29 → v30: import sync + auth reload cleanup.
// - v30 → v31: network-first HTML shell.
// - v31 → v32: Supabase bypass in the fetch listener.
// - v32 → v33: sync-bar error state + SW update check + sign-in auto-sync.
// - v33 → v34: fetchRemoteState rethrow.
// - v34 → v35: sync-bar [hidden] CSS fix + friendly network-error handling.
// - v35 → v36: four-item feature batch (undo/menu/pill restyle/editable email).
// - v36 → v37: snackbar dispatch + history rules + sync rebuilds picker +
//              header layout + redo.
// - v37 → v38: sequential undo + header row fixes.
// - v38 → v39: silent sequential-undo failure fix + snackbar Undo first +
//              Sync before Theme.
//
// ================================================================================================

const CACHE_NAME = 'todo-cache-v39';

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

// Fetch: network-first for index.html, cache-first for everything else,
// Supabase traffic bypassed entirely.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // BYPASS: Never intercept Supabase API or Auth requests.
  // Let the browser handle them natively.
  if (url.hostname.endsWith('.supabase.co')) {
    return;
  }

  // Always fetch the HTML shell from the network so updates land immediately
  if (url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Cache-first for all other assets
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) return response;
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || event.request.method !== 'GET') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});
