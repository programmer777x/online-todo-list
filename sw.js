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
// 1.7 — Cache bump for the auth debug log. CACHE_NAME goes from
//       todo-cache-v13 to todo-cache-v14 so returning clients fetch the
//       updated js/ui.js whose password sign-in handler prints
//       "Auth Debug - Sending to Supabase: { email, password }" right
//       before the signInWithPassword call. That log is diagnostic, not
//       permanent; it will be removed once the password flow is confirmed
//       working end-to-end.
//
// 1.8 — Cache bump for the persistent-email modal. The version number
//       jumps from todo-cache-v14 to todo-cache-v16 (v15 was skipped to
//       avoid a version that ever shipped in a stale state). This is the
//       bump that delivers three coordinated changes: index.html's new
//       auth modal structure (email input hoisted above both steps), the
//       js/render.js cache additions for the new ids, and the js/ui.js
//       rewrite whose handlers drive the new structure and remove the
//       v1.7 debug log. Without this bump, returning clients would keep
//       the v14 cache and the modal would still hide the email input in
//       the password step.
//
// 1.9 — Cache bump for the offline-queue durability fix. CACHE_NAME goes
//       from todo-cache-v16 to todo-cache-v17 so returning clients fetch
//       the updated js/sync.js whose pushList / pushTask return a boolean
//       and no longer re-queue internally, and whose processOfflineQueue
//       keeps failed items instead of silently clearing the queue on a
//       network failure. Without this bump, returning users would keep
//       the v16 sync.js whose queue drains to empty on the first flush
//       attempt even when every push failed — the "offline test passes"
//       failure mode.
//
// 1.10 — Cache bump for the offline-queue durability fix (final state).
//       CACHE_NAME goes from todo-cache-v17 to todo-cache-v18 so returning
//       clients fetch the corrected js/sync.js (v1.8) whose pushList /
//       pushTask re-queue on failure and whose processOfflineQueue aborts
//       on the first failed push instead of overwriting or clearing the
//       queue. The v17 bump above was authored against the v1.7 split
//       (inner re-queue removed); the v1.8 sync.js restores the catch-block
//       re-queue and the abort-on-failure flush, and this bump is what
//       guarantees that corrected file reaches every client. Verified
//       end-to-end: offline add → queued in todolist.v1.pending → online
//       flush → row in Supabase. Last-write-wins also verified: offline
//       edits to "A" then "B" → online flush → Supabase row shows "B".
//
// 1.11 — Cache bump for the manual sync status bar. CACHE_NAME goes from
//       todo-cache-v18 to todo-cache-v19 so returning clients fetch the
//       new markup (index.html), styling (css/base.css), logic
//       (js/sync.js, js/ui.js), and the bumped font size for the list
//       switcher text glyphs. Without this bump, returning clients would
//       stay on the v18 cache and never see the new manual refresh
//       button, meaning no way to pull changes from another device
//       without a full PWA restart.
//
// 1.12 — Cache bump for the manual sync fix. CACHE_NAME goes from
//       todo-cache-v19 to todo-cache-v20 so returning clients fetch the
//       updated js/sync.js (which exposes a boolean-returning
//       window.sync.syncNow()) and js/ui.js (which handles the result to
//       show success or error states). The manual sync now explicitly
//       returns success or failure instead of assuming success, and the
//       UI falls back to an error state if the network is down.
//
// 1.13 — Cache bump for the sync-event fix. CACHE_NAME goes from
//       todo-cache-v21 to todo-cache-v22 so returning clients fetch the
//       updated js/sync.js (which now dispatches 'sync-state-changed' at
//       the end of fetchRemoteState() and inside syncNow()) and js/ui.js
//       (which fires a fake event on initial load). This ensures the
//       status bar updates its timestamp and clears the syncing state,
//       resolving the stuck UI issue.
//
// 1.14 — Cache bump for the list rename fix. CACHE_NAME goes from
//       todo-cache-v22 to todo-cache-v23 so returning clients fetch the
//       updated js/ui.js where handleListRename() explicitly dispatches
//       the 'sync-list-change' event. Renaming a list now triggers the
//       mutation hook and pushes the new name to Supabase.
//
// 1.15 — Cache bump for the signed-out sync bar fix. CACHE_NAME goes from
//       todo-cache-v23 to todo-cache-v24 so returning clients fetch the
//       updated js/ui.js. The sync status bar now remains completely
//       hidden when the user is signed out, and the click handler returns
//       early if no session exists, preventing a misleading "Sync failed"
//       error state.
//
// 1.16 — Cache bump for the reload sync behavior. CACHE_NAME goes from
//       todo-cache-v24 to todo-cache-v25 so returning clients fetch the
//       updated js/ui.js and js/sync.js. The manual sync button now flushes
//       the offline queue and forces a page reload, which wipes JS memory
//       and re-runs initSync() to guarantee fresh data from Supabase.
//
// 1.17 — Cache bump for the icon size fix. CACHE_NAME goes from
//       todo-cache-v26 to todo-cache-v27 so returning clients fetch the
//       updated css/base.css. The list-switcher text glyphs (＋ and ✎)
//       are now sized at 1rem to visually match the delete button (🗑)
//       on mobile.
//
// 1.18 — Cache bump for the sign-in reload fix. CACHE_NAME goes from
//       todo-cache-v27 to todo-cache-v28 so returning clients fetch the
//       updated js/ui.js. The app now reloads immediately after a
//       successful sign-in (both password and magic-link) to ensure
//       fresh cloud data is displayed.
//
// 1.19 — Cache bump for sign-in reload and icon fixes. CACHE_NAME goes
//       from todo-cache-v28 to todo-cache-v29 so returning clients fetch
//       the updated js/sync.js (which forces a reload on sign-in via
//       sessionStorage), js/ui.js (which clears that flag on sign-out),
//       and css/base.css (which sizes the list-switcher text glyphs
//       individually to match the delete button).
//
// 1.20 — Cache bump for the import sync and auth reload fixes. CACHE_NAME
//       goes from todo-cache-v29 to todo-cache-v30 so returning clients
//       fetch the updated js/ui.js (which now dispatches sync events for
//       imported tasks and removes the old auth reload guard) and js/sync.js
//       (which moves the auth reload into the onAuthStateChange listener
//       to fix the sign-in race condition).
//
// 1.21 — Network-first HTML shell and cache bump for the delayed-import /
//       no-reload round. The fetch listener is split: requests whose
//       pathname ends in '/' or 'index.html' are network-first (fetch
//       first, fall back to caches.match('./index.html')), and every other
//       request stays cache-first. This means a returning user's HTML
//       shell is always fresh on the next load, so new script and style
//       references land without a manual cache clear. CACHE_NAME goes from
//       todo-cache-v30 to todo-cache-v31 to deliver the js/ui.js change
//       (delayed import sync loop, no reloads from password sign-in or
//       the sync bar) and the js/sync.js change (no auto-reload on
//       SIGNED_IN).
//
// 1.22 — Service worker bypass for Supabase traffic. The fetch listener now
//       returns early for any request whose hostname ends in '.supabase.co',
//       so Supabase API and Auth calls go straight to the network and never
//       touch the cache. This removes the stale-GET failure mode where the
//       cache-first branch served a pre-import task list on a repeat read,
//       which made a fully-saved import look partial. CACHE_NAME goes from
//       todo-cache-v31 to todo-cache-v32 to deliver the new sw.js logic.
//
// 1.23 — Cache bump for the sync-bar error state, SW update check, and
//       sign-in auto-sync round. CACHE_NAME goes from todo-cache-v32 to
//       todo-cache-v33 so returning clients fetch the updated js/ui.js
//       (the sync bar now shows the error state when a manual sync fails,
//       and checks for a waiting service worker update after a successful
//       sync, reloading on the next tap) and the updated js/sync.js (the
//       SIGNED_IN handler now awaits syncNow() and re-renders the list
//       switcher and task list so cloud data appears on sign-in without
//       a manual sync tap).
//
// 1.24 — Cache bump for the fetchRemoteState rethrow fix. CACHE_NAME goes
//       from todo-cache-v33 to todo-cache-v34 so returning clients fetch
//       the updated js/sync.js whose fetchRemoteState() catch block now
//       rethrows after logging. Without the rethrow, syncNow() never saw
//       the fetch failure: it wrote a fresh success timestamp and returned
//       true, and the sync bar reverted to the idle label with a time from
//       the failed sync. The Item 1 retest (offline tap shows "Sync failed
//       — tap to retry · Last synced {last good time}") depends on this
//       bump reaching returning clients.
//
// 1.25 — Cache bump for the sync-bar hidden-attribute CSS fix and the
//       friendly sign-in network-error handling. CACHE_NAME goes from
//       todo-cache-v34 to todo-cache-v35 so returning clients fetch the
//       updated css/base.css (adds `.sync-status-bar[hidden] { display:
//       none; }` so `bar.hidden = true` actually hides the bar instead of
//       being overridden by the author `display: flex` rule — this was the
//       Item 9 root cause) and the updated js/ui.js (both sign-in handlers
//       wrap their Supabase call in try/catch, reset the button, and show
//       a friendly connection message on a network failure — Item 5).
//
// 1.26 — Cache bump for the four-item feature batch. CACHE_NAME goes from
//       todo-cache-v35 to todo-cache-v36 so returning clients fetch the
//       updated index.html (undo button, undo snackbar, FAB menu shell,
//       Recent Changes panel), js/store.js (history recording + undo API
//       with a 20-entry cap persisted under todolist.v1.history),
//       js/ui.js (undo snackbar on history-recorded, Ctrl+Z / Cmd+Z
//       support, FAB toggle + tap-outside + Escape, history row rendering
//       with per-row Undo, and the Item 4 editable password-step email +
//       updated empty-email copy), and css/base.css (undo snackbar, FAB,
//       menu, history list styles, and the Item 3 sync-bar pill restyle
//       that keeps the [hidden] rule intact).
//
// 1.27 — Cache bump for the round-2 fixes: snackbar dispatch, history
//       rules, sync rebuilds picker, header layout, redo. CACHE_NAME goes
//       from todo-cache-v36 to todo-cache-v37 so returning clients fetch
//       the updated js/store.js (recordHistory dispatches
//       'history-recorded', every undoAction carries a listId, dead
//       entries are dropped instead of left stuck, undo prunes later
//       entries for the same task, hydrateFromRemote clears history and
//       redo, and every entry carries a redoAction with a separate redo
//       stack), js/ui.js (redo button + Ctrl+Y / Ctrl+Shift+Z, history
//       rows show their list name, the sync-bar tap calls
//       renderListSwitcher() alongside render(), and a .header-compact
//       class plus short "↻ {time}" idle label for mobile portrait),
//       index.html (redo button + .header-primary / .header-secondary
//       groups + .header-pill class on undo/redo/auth/sync), and
//       css/base.css (one-row/two-row header layout, undo/redo pill
//       styling, and the sync pill's reposition into the header row with
//       its old standalone-row tuning removed).
//
// 1.28 — Cache bump for the round-3 fixes: sequential undo and header
//       layout. CACHE_NAME goes from todo-cache-v37 to todo-cache-v38 so
//       returning clients fetch the updated js/store.js (undoHistoryEntry
//       now unwinds from the newest entry down to and including the
//       target, newest-first; dead entries are skipped and removed
//       without aborting the chain; undone entries are pushed onto the
//       redo stack in unwind order; the round-2 same-task prune rule is
//       removed), js/ui.js (each History row's Undo button now shows
//       "Undo N" matching the sequential unwind count; wireHeaderCompact
//       moves undo/redo between the primary and secondary header groups
//       at the compact breakpoint; the sync pill's idle label is short
//       everywhere with the full text as title/aria-label), and
//       css/base.css (shell widens to 1020px above the compact
//       breakpoint; the compact two-row header layout now places
//       List/Login on row 1 and Theme/Sync/Undo/Redo on row 2).
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Implements the core PWA offline functionality.
// - Network-first branch in the fetch listener for the HTML shell: URL
//   pathnames ending in '/' or 'index.html' bypass the cache on the happy
//   path and fall back to caches.match('./index.html') only when the
//   network fetch rejects. See 1.21 above.
// - Supabase bypass branch in the fetch listener: hostname.endsWith('.supabase.co')
//   returns without calling respondWith(), letting the browser handle the
//   request natively. See 1.22.
//
// ================================================================================================
//
// === FIXES ===
//
// - Bumped CACHE_NAME from `todo-cache-v6` to `todo-cache-v6` so browsers discard the stale v1
//   cache and fetch the current CSS/JS. This was the reason recent UI fixes were not appearing
//   even after a hard refresh — the v1 worker was serving cached assets before the network
//   request ever went out. Bump this string on every deploy that changes cached files.
// - Corrected the maskable icon filename in ASSETS_TO_CACHE to match the actual file on disk.
//   The old path caused `cache.addAll()` to reject during install, which silently aborted the
//   precache step.
// - Every cache-bump entry below corresponds to a `chore(sw): bump cache to todo-cache-vN`
//   commit that ships the named source files to returning clients. The entry names what the
//   bump delivers so a future agent reading sw.js alone can see why the version moved.
// - Bumped CACHE_NAME from `todo-cache-v6` to `todo-cache-v8` so browsers fetch the header-init
//   fix in js/ui.js and the getClient() export in js/sync.js instead of continuing to serve the
//   pre-fix versions from the old cache.
// - Bumped CACHE_NAME from `todo-cache-v8` to `todo-cache-v9` so browsers fetch the
//   mutation-sync hooks in js/store.js and js/sync.js.
// - Bumped CACHE_NAME from `todo-cache-v9` to `todo-cache-v10` so browsers fetch the
//   precise-mutation fix in js/store.js and the precise-payload pushList/pushTask in
//   js/sync.js.
// - Bumped CACHE_NAME from `todo-cache-v10` to `todo-cache-v11` so browsers fetch the v1.6
//   js/sync.js -- the migration branch that reads `typeof state !== 'undefined' ? state :
//   window.state`, the pushList `created_at` fallback, and the "Sync: Pushing list/task"
//   payload logging.
// - Bumped CACHE_NAME from `todo-cache-v11` to `todo-cache-v12` so browsers fetch the current
//   js/render.js (whose cacheDom() populates dom.authPasswordInput) and the guarded js/ui.js.
// - Bumped CACHE_NAME from `todo-cache-v12` to `todo-cache-v13` so browsers fetch the self-
//   contained js/ui.js whose wireAuthEvents() looks up auth elements by id at function entry
//   instead of reading them off render.js's top-level `const dom`.
// - Bumped CACHE_NAME from `todo-cache-v13` to `todo-cache-v14` so browsers fetch the debug-
//   logged js/ui.js. The log is temporary diagnostic scaffolding.
// - Bumped CACHE_NAME from `todo-cache-v14` to `todo-cache-v16` (skipping v15) to deliver the
//   persistent-email auth modal: new index.html markup, the render.js cache additions for the
//   new ids, and the ui.js rewrite.
// - Fixed the offline-queue flush wiping the queue on a failed attempt. The push handlers now
//   return a boolean (true = landed, false = didn't), and processOfflineQueue aborts on the
//   first failure instead of clearing the queue.
// - Bumped CACHE_NAME from `todo-cache-v16` to `todo-cache-v17` so browsers fetch the offline-
//   queue durability fix in js/sync.js.
// - Bumped CACHE_NAME from `todo-cache-v17` to `todo-cache-v18` so browsers fetch the corrected
//   v1.8 js/sync.js (catch-block re-queue + abort-on-failure flush).
// - Bumped CACHE_NAME from `todo-cache-v18` to `todo-cache-v19` so browsers fetch the manual
//   sync status bar (index.html, css/base.css, js/sync.js, js/ui.js) and the font-size fix for
//   the ＋ and ✎ list buttons.
// - Bumped CACHE_NAME from `todo-cache-v19` to `todo-cache-v20` so browsers fetch the manual
//   sync fix (boolean return from syncNow() lets the UI show the "Sync failed" state).
// - Bumped CACHE_NAME from `todo-cache-v21` to `todo-cache-v22` so browsers fetch the sync-
//   event fix (the 'sync-state-changed' event dispatched by fetchRemoteState() and syncNow()).
// - Bumped CACHE_NAME from `todo-cache-v22` to `todo-cache-v23` so browsers fetch the list
//   rename fix (handleListRename() now explicitly dispatches 'sync-list-change').
// - Bumped CACHE_NAME from `todo-cache-v23` to `todo-cache-v24` so browsers fetch the signed-
//   out sync bar fix (bar stays hidden when signed out).
// - Bumped CACHE_NAME from `todo-cache-v24` to `todo-cache-v25` so browsers fetch the reload
//   sync behavior. (Later reverted — see 1.26's manual-sync-in-place change.)
// - Bumped CACHE_NAME from `todo-cache-v26` to `todo-cache-v27` so browsers fetch the icon size
//   fix for the list-switcher text glyphs.
// - Bumped CACHE_NAME from `todo-cache-v27` to `todo-cache-v28` so browsers fetch the sign-in
//   reload fix. (Later reverted — see 1.27's no-reload round.)
// - Bumped CACHE_NAME from `todo-cache-v28` to `todo-cache-v29` so browsers fetch the sign-in
//   reload and icon fixes.
// - Bumped CACHE_NAME from `todo-cache-v29` to `todo-cache-v30` so browsers fetch the import
//   sync and auth reload fixes.
// - The HTML shell could be pinned to a stale cache entry. The fetch listener now handles
//   pathname '/' and 'index.html' requests network-first, falling back to caches.match on
//   offline only.
// - Bumped CACHE_NAME from `todo-cache-v30` to `todo-cache-v31` so browsers fetch the delayed-
//   import / no-reload round (js/ui.js and js/sync.js).
// - Imported tasks could look partial after a reload because the cache-first branch cached
//   Supabase GET responses. The fetch listener now bypasses all Supabase traffic.
// - Bumped CACHE_NAME from `todo-cache-v32` to `todo-cache-v33` so browsers fetch the sync-bar
//   error state, service worker update check, and sign-in auto-sync round.
// - A manual sync while offline looked successful. fetchRemoteState()'s catch block logged the
//   failure and returned normally; the catch now rethrows so syncNow() returns false.
// - Bumped CACHE_NAME from `todo-cache-v33` to `todo-cache-v34` so browsers fetch the
//   fetchRemoteState rethrow fix in js/sync.js.
// - The signed-out sync bar was visible because `.sync-status-bar` declared `display: flex`,
//   overriding the UA `[hidden] { display: none }`. Added a `.sync-status-bar[hidden] { display:
//   none; }` rule in css/base.css so the attribute wins when present.
// - Sign-in network failures were silent and left the button stuck. Both sign-in handlers now
//   catch the throw, reset the button, and write a friendly connection message.
// - Bumped CACHE_NAME from `todo-cache-v34` to `todo-cache-v35` so browsers fetch the two fixes
//   above: css/base.css (the `[hidden]` rule) and js/ui.js (the try/catch around both sign-in
//   handlers).
// - No undo existed anywhere. Added a two-layer undo (snackbar + Recent Changes list) backed by
//   js/store.js history recording.
// - The header grew with every new control. Added a ⋯ FAB menu (bottom-right) whose first
//   tenant is the Recent Changes list. Sync bar stays in the header row.
// - The sync bar looked like its own stray section. Restyled as a pill matching the
//   list-switcher / auth-button treatment, keeping the [hidden] rule.
// - The password step's email field was locked. Dropped the lock and updated the empty-email
//   copy to "Please enter your email address."
// - Bumped CACHE_NAME from `todo-cache-v35` to `todo-cache-v36` so browsers fetch the four-item
//   feature batch: index.html, js/store.js, js/ui.js, and css/base.css.
// - The undo snackbar never appeared because store.js's recordHistory() did not dispatch
//   'history-recorded'. recordHistory() now dispatches it.
// - History entries were not scoped to a list. Every undoAction now carries a listId, and
//   applyUndoAction() applies to that list.
// - Dead history entries stayed in the list forever. applyUndoAction() now returns false in
//   that case and the entry is dropped.
// - History carried stale entries across a data replacement. hydrateFromRemote() now calls
//   clearHistory() when it replaces the loaded data.
// - The sync button did not rebuild the list picker. The sync-bar tap now calls
//   renderListSwitcher() alongside render() after a successful syncNow().
// - The header was visually unorganized on mobile portrait. The markup now groups the header
//   into .header-primary and .header-secondary, and a .header-compact class stacks the groups
//   into two rows in portrait.
// - No redo existed. Every entry now records a redoAction alongside the undoAction, and a
//   separate redo stack is pushed on undo and cleared on any new recorded action or on
//   hydrateFromRemote(). The header ↪ button and Ctrl+Y / Ctrl+Shift+Z call
//   window.store.redoLast().
// - Bumped CACHE_NAME from `todo-cache-v36` to `todo-cache-v37` so browsers fetch the round-2
//   fixes: js/store.js, js/ui.js, index.html, and css/base.css.
// - Undoing an older entry left later entries stuck in the history. The per-entry skip model
//   is replaced by sequential unwind: undoHistoryEntry(id) now undoes entry N and every entry
//   newer than it, newest-first, one at a time. The round-2 same-task prune rule is removed.
//   Dead entries inside the unwind are skipped and removed without aborting the chain, and
//   undone entries are pushed onto the redo stack in unwind order.
// - The History row Undo button used to just say "Undo". Each row now shows "Undo N" where N is
//   the number of entries the sequential unwind will undo.
// - The header controls could not fit one row on desktop because the shell was capped at 760px.
//   The shell widens to 1020px above the compact breakpoint, and the sync pill uses a short
//   idle label ("↻ {time}") at every width with the full text as the button's title /
//   aria-label.
// - The compact header layout put Undo and Redo on row 1 with the list and login, leaving no
//   room for Login on a narrow screen. wireHeaderCompact now moves Undo and Redo into
//   .header-secondary at the compact breakpoint, so row 1 is List + Login and row 2 is Theme +
//   Sync + Undo + Redo.
// - Bumped CACHE_NAME from `todo-cache-v37` to `todo-cache-v38` so browsers fetch the round-3
//   fixes: js/store.js (sequential unwind), js/ui.js ("Undo N" button + header group flip in
//   compact + short sync label everywhere), and css/base.css (wider shell on desktop /
//   landscape + compact two-row header). Without this bump, returning clients would stay on
//   v37 and none of the sequential-undo or header-layout changes would reach them.
//
// ================================================================================================

const CACHE_NAME = 'todo-cache-v38';

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
