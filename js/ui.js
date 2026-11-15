// UI Version 1.0
//
// ================================================================================================
//
// Event wiring, user interactions, and app initialization for the Online To Do List.
//
// Drag-to-reorder auto-scroll triggers at 28% of the viewport height on mobile, and 15% on
// desktop (screens wider than 640px).
//
// ================================================================================================
//
// === REVISIONS ===
//
// 1.1 — Supabase Stage 3. Added the auth modal wiring: auth elements cached in
//       cacheDom(), wireAuthEvents() bound in init() right after wireEvents().
//       The auth button toggles between opening the modal (signed out) and
//       confirming sign-out (signed in); the modal drives Supabase's OTP flow.
//       Header button text/title is updated from the supabase-auth-changed
//       event that sync.js dispatches.
//
// 1.2 — Auth client fix. The auth handlers previously called
//       window.supabase.auth.* -- but window.supabase is the raw UMD library,
//       not an initialized client, so window.supabase.auth was undefined and
//       clicking the Sign In button threw TypeError on getSession(). Now:
//       the click handler reads session state from window.sync.getSession()
//       (sync.js's already-initialized currentSession), and the sign-out,
//       signInWithOtp, and verifyOtp calls each construct a local
//       createClient(SUPABASE_URL, SUPABASE_ANON_KEY) instance. Supabase
//       shares session localStorage across clients per origin, so a second
//       client picks up the session sync.js manages without any wiring.
//
// 1.3 — Auth refactor (link + password). The 6-digit OTP flow is gone.
//       The modal is now link-first ("Send sign-in link") with a "Use
//       password instead" toggle that reveals a password step. All auth
//       calls route through window.sync.getClient() so sync.js's
//       onAuthStateChange listener sees every transition; the previous
//       per-call createClient() pattern let those events bypass the
//       listener and let currentSession drift.
//
// 1.4 — Header update race fix. When the page loads with a session already
//       in Supabase's storage, sync.js's initial getSession() and its
//       immediate 'supabase-auth-changed' dispatch can both resolve before
//       ui.js's init() has finished running cacheDom() and binding the
//       listener. The header button then stayed on its default "Sign in to
//       sync" label even though the user was signed in. wireAuthEvents()
//       now reads window.sync.getSession() at the end and, if a session is
//       already present, updates the button directly -- the listener path
//       still handles every transition that happens after init.
//
// 1.5 — Password input guard. The password sign-in handler used to read
//       dom.authPasswordInput.value without checking the reference exists.
//       If cacheDom() ever fails to populate that reference (a stale
//       render.js served from a service-worker cache, a rename during a
//       refactor, a typo in the id), the handler would throw a TypeError
//       in the background and the button would appear dead -- no error,
//       no visible response. The handler now checks the reference first
//       and logs "Auth Error: password input not found in DOM cache." so
//       a future version of this failure is one console line away from
//       diagnosis.
//
// 1.6 — Self-contained auth DOM cache. wireAuthEvents() now looks up every
//       auth element by id at the top of the function, instead of reading
//       them off render.js's `dom` object. `dom` is declared with a
//       top-level `const` in render.js, which does NOT attach to `window`
//       in a plain-script context -- so any diagnostic that reads
//       `window.dom.authPasswordInput` returns undefined even when the
//       cache is populated, and any code path that assumes `dom.auth*`
//       will be set can be silently broken by load order or by a stale
//       render.js from the service-worker cache. Local lookups inside
//       wireAuthEvents() close both of those failure modes at once: the
//       handler owns its own references, and it refuses to bind anything
//       if the modal markup is missing. render.js's cacheDom() still
//       populates the shared `dom` object for the rest of the app, and
//       nothing outside this function reads `dom.auth*` anymore.
//
// 1.7 — Debug log for password sign-in. A single console.log right before
//       signInWithPassword prints the exact { email, password } pair being
//       sent to Supabase. The direct-API test from PowerShell proved the
//       account and credentials work; if the frontend still fails with
//       the same creds, the two plausible causes are an empty/wrong email
//       (the password step reads from the email input that lives in the
//       prior step) or an input-side whitespace/typo. This log makes
//       both visible in one line at click time and is intended to be
//       removed once the flow is confirmed working.
//
// 1.8 — Persistent-email modal. The email input, title, subtitle, and hint
//       paragraph are now direct children of .auth-modal-content and stay
//       visible in both the link and password flows. wireAuthEvents() is
//       rewritten for that structure: clicking "Use password instead"
//       rewrites the title/subtitle text, hides the hint, swaps the step
//       containers, and disables the email input so it can't be changed
//       mid-flow; the new "Use link instead" link reverses all of that.
//       The handlers are back on `dom.*` lookups (render.js v1.4 caches
//       the new ids); the local-cache arrangement from 1.6 is dropped
//       because the structure change made a full rewrite cleaner than a
//       partial patch, and render.js and ui.js now ship the same set of
//       ids. The 1.7 debug log is removed -- its diagnostic purpose is
//       fulfilled and it should not print plaintext passwords in a modal
//       that now has a real "change email / password" flow. Input
//       validation is added on both paths: an empty email blocks the
//       Send-link click, and an empty email or password blocks the Sign-in
//       click, each with a specific error message rendered in the
//       corresponding .auth-error paragraph.
//
// 1.9 — Manual sync status bar. Wires the new #sync-status-bar button
//       directly under the header. The bar is hidden by default and
//       toggled based on session state (same source as the auth button).
//       On click, it runs window.sync.syncNow(), then checks the service
//       worker registration for a waiting update. If a worker is waiting,
//       it flips to the update-available state and waits for a second
//       tap to reload. On success, it updates the "Last synced" label
//       from the todolist.v1.lastSync key.
//
// 1.10 — Sync result handling. The status bar click handler now explicitly
//        handles the boolean return from window.sync.syncNow(). If it
//        returns false (network failure or offline queue abort), the bar
//        switches to the error state instead of assuming success. If it
//        returns true, it proceeds to check for service worker updates.
//        Manual timestamp updates in ui.js are removed because sync.js
//        now owns that responsibility.
//
// 1.11 — Initial render sync event. Dispatches a fake 'sync-state-changed'
//        event immediately after the initial renderBar() call. This
//        ensures the status bar updates its timestamp label on the first
//        page load if a sync already occurred before the listener was
//        attached.
//
// 1.12 — List rename sync fix. handleListRename() now explicitly
//        dispatches a 'sync-list-change' event with the 'update' operation
//        so sync.js can push the new name to Supabase. Previously, renaming
//        a list saved locally but never triggered the mutation hook,
//        leaving the cloud DB out of date.
//
// 1.13 — Hide sync bar when signed out. The sync status bar previously
//        showed an error state if clicked while signed out. Now, the click
//        handler checks for a session and returns early if none exists,
//        and showError() checks the session state before unhiding the bar.
//        The bar remains completely hidden when signed out.
//
// 1.14 — Force page reload on sync button click. The manual sync button
//        was failing to properly refresh the UI from the fetched data.
//        The handler now flushes the offline queue and immediately calls
//        window.location.reload(). This wipes JS memory, re-runs initSync(),
//        and guarantees fresh data and code on every tap.
//
// 1.15 — Reload page immediately after successful sign-in. When a user
//        signs in after the app has already loaded, fetchRemoteState()
//        updates the data in memory but does not re-render the UI. This
//        change makes the password sign-in handler call location.reload()
//        after success, and the magic-link auth listener reload if
//        sessionStorage's 'hasSynced' flag is not set.
//
// 1.16 — Clear hasSynced on sign-out. Adds sessionStorage.removeItem('hasSynced')
//        to the sign-out handler so that the next sign-in triggers the
//        auto-reload defined in sync.js. Without this, the reload only
//        happens once per browser session.
//
// 1.17 — Import sync and auth reload cleanup. handleImportFile() now
//        dispatches 'sync-task-change' events for every imported task so
//        they are pushed to Supabase immediately. The old sessionStorage
//        reload guard is removed from the supabase-auth-changed listener
//        since the reload is now handled directly in sync.js's auth state
//        listener to prevent double-reloads.
//
// 1.18 — Delay import sync and remove page reloads. handleImportFile()
//        now dispatches its 'sync-task-change' events inside an async
//        loop with a 150ms delay between each task, updating
//        dom.pasteStatus with "Importing N tasks to cloud..." and then
//        "Successfully imported ..." when the loop completes. This avoids
//        Supabase rate limiting on large imports that previously burst
//        hundreds of events synchronously. The password sign-in handler
//        no longer calls window.location.reload() on success; it just
//        closes the modal and lets the existing auth-state event flow
//        update the UI. The sync status bar click handler no longer
//        calls window.location.reload(); it sets syncing = true, awaits
//        window.sync.syncNow() (guarded by a typeof check), resets
//        syncing = false, and re-renders the bar. Inline syncNow()
//        failures are caught and logged rather than rethrown.
//
// 1.19 — Sync bar error state. The click handler now reads the boolean
//        returned by window.sync.syncNow(). On false or on a thrown
//        error, it calls the existing showError() helper instead of
//        falling through to the idle label. showError() already checks
//        the session before unhiding the bar, so a signed-out user still
//        sees nothing. Before this change, a failed manual sync silently
//        re-rendered to "Last synced {old time}" and the user had no
//        indication it failed.
//
// 1.20 — Service worker update check on sync bar tap. After a successful
//        syncNow(), the click handler now calls
//        navigator.serviceWorker.getRegistration() then
//        registration.update() to look for a waiting worker. If one is
//        found, updateAvailable is set to true and renderBar() shows
//        "Update available — tap to reload". A second tap while
//        updateAvailable is true calls window.location.reload() to pick
//        up the new worker. Both the getRegistration() and update() calls
//        are guarded by a 'serviceWorker' in navigator check, so file://
//        still works with no crash when the worker is absent. The
//        automatic-reload path is deliberately not used — the user may
//        be mid-typing.
//
// 1.21 — Friendly sign-in network-error handling. Both sign-in handlers
//        (send-link and password) now wrap their Supabase call in
//        try/catch. Supabase returns { error } for API-level failures
//        (wrong password, wrong email) and those paths are unchanged. A
//        network failure throws TypeError: Failed to fetch, which
//        previously propagated as an unhandled rejection — nothing was
//        shown and the button was left stuck on "Signing in..." /
//        "Sending..." disabled. On a caught failure each handler resets
//        its button and writes a friendly connection message into the
//        modal's existing .auth-error paragraph. The sync bar's
//        showError() is deliberately not used here — a failed sign-in
//        means the user is signed out, and the bar must stay hidden
//        (Item 9).
//
// 1.22 — Two-layer undo + expandable menu + editable password-step email.
//        Item 1: listens for 'history-recorded' events from store.js,
//        shows a transient snackbar with the entry summary and an Undo
//        button (auto-dismiss 5s, cleared on the next action), binds the
//        header #undo-button and Ctrl+Z / Cmd+Z to undoLast(), and
//        ignores Ctrl+Z while a text input or textarea has focus. Item 2:
//        wires the #fab-menu-button to toggle #fab-menu-panel (aria-
//        expanded kept in sync), closes the menu on tap-outside or
//        Escape, and re-renders the #history-list from
//        window.store.loadHistory() each time the menu opens and on every
//        'history-recorded' event. Each history row gets its own Undo
//        button calling undoHistoryEntry(id). Empty-state line toggled
//        against the list's child count. Item 4: the password-step
//        toggle no longer sets dom.authEmailInput.disabled = true, and
//        the empty-email message is "Please enter your email address."
//        Items 1 and 2 share history storage and ship together.
//
// 1.23 — Redo button, history list labels, sync tap rebuilds picker,
//        compact sync label. Item 5: binds the new #redo-button and the
//        Ctrl+Y / Ctrl+Shift+Z keyboard shortcuts to
//        window.store.redoLast(), same typing guard as Ctrl+Z. Item 2
//        (UI half): history rows now show the list name above each
//        summary so entries from other lists make sense. Item 3: the
//        sync bar tap now calls renderListSwitcher() alongside render()
//        after a successful syncNow(), so a new list from another
//        device appears in the picker without a reload. Item 4: sets a
//        .header-compact class on .app-header when the viewport is
//        narrow enough that the sync pill needs its shortened
//        "↻ {time}" label; the CSS handles the row-break and this code
//        only manages the label. Other sync-bar states (error, syncing,
//        update-available) keep their full text at every width.
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted the event handling and initialization logic from the original app.js.
// - Auth DOM references in cacheDom(): authButton, authModal, authClose,
//   authStepEmail, authStepCode, authEmailInput, authCodeInput,
//   authSendEmailBtn, authVerifyCodeBtn, authErrorEmail, authErrorCode.
//   (Superseded in 1.3 by the link/password set.)
// - wireAuthEvents() — binds the auth button (open modal / confirm sign-out),
//   the modal close button, the send-email button (signInWithOtp), the
//   verify-code button (verifyOtp with type 'magiclink'), and listens for
//   the supabase-auth-changed custom event from sync.js to update the
//   header button label.
// - wireAuthEvents() for the link/password flow: auth button (open modal /
//   confirm sign-out via the shared client), close button, "Use password
//   instead" toggle link, send-link button (signInWithOtp), sign-in with
//   password button (signInWithPassword), and the supabase-auth-changed
//   listener. See the 1.3 revision entry.
// - Initial-session check at the end of wireAuthEvents(): reads
//   window.sync.getSession() and updates the header button when a session
//   is already present on first load. See the 1.4 revision entry.
// - Password-input presence guard at the top of the password sign-in
//   handler: logs a specific error and returns early if
//   dom.authPasswordInput is missing, instead of letting the handler throw
//   silently. See the 1.5 revision entry.
// - Local DOM lookups at the top of wireAuthEvents(): every auth element
//   referenced by the handler is looked up by id inside the function, not
//   read off render.js's `dom` cache. A missing modal or header button
//   short-circuits the whole function with a return instead of binding
//   listeners to null. See the 1.6 revision entry.
// - Debug console.log in the password sign-in handler printing the exact
//   { email, password } sent to Supabase. See the 1.7 revision entry.
//   Removed in 1.8.
// - "Use link instead" handler on dom.authEmailToggle: swaps back to the
//   link step, re-enables the email input, and focuses it. See the 1.8
//   revision entry.
// - Input validation on both submit paths: an empty email blocks the
//   send-link click with a specific message; an empty email or password
//   blocks the password sign-in click with a specific message. See the
//   1.8 revision entry.
// - wireSyncStatusBar() — binds the new manual-sync status bar. Reads
//   initial visibility from window.sync.getSession(), listens for auth
//   changes, and handles the tap flow (syncNow -> SW update check ->
//   reload prompt). See the 1.9 revision entry.
// - Error handling in the status bar click flow for the boolean return
//   from syncNow(). See the 1.10 revision entry.
// - Initial sync-state-changed dispatch in wireSyncStatusBar(). See the
//   1.11 revision entry.
// - 'sync-list-change' dispatch in handleListRename(). See the 1.12
//   revision entry.
// - Session checks in the status bar click handler and showError(). See
//   the 1.13 revision entry.
// - Force reload logic in the status bar click handler. See the 1.14
//   revision entry.
// - location.reload() after password sign-in, and a sessionStorage-guarded
//   reload in the auth listener for magic-link sign-in. See the 1.15
//   revision entry.
// - sessionStorage.removeItem('hasSynced') on sign-out. See the 1.16
//   revision entry.
// - 'sync-task-change' dispatch inside handleImportFile() for every imported
//   task. See the 1.17 revision entry.
// - Removed the reload block from the supabase-auth-changed listener
//   since it now lives in sync.js. See the 1.17 revision entry.
// - Delayed import sync loop in handleImportFile(): dispatches one
//   'sync-task-change' per task with a 150ms await between each, writes
//   "Importing N tasks to cloud..." to dom.pasteStatus during the loop,
//   and overwrites it with "Successfully imported ..." on completion (with
//   a 5s auto-clear). See the 1.18 revision entry.
// - "go" step pattern in the import loop uses the awaited timeout, so the
//   main thread stays responsive between dispatches. See the 1.18 revision
//   entry.
// - showError() call in the sync status bar click handler when
//   window.sync.syncNow() returns false or throws. See the 1.19 revision
//   entry.
// - Service worker update check in the sync status bar click handler:
//   after a successful syncNow(), calls
//   navigator.serviceWorker.getRegistration() then registration.update(),
//   and sets updateAvailable = true if a waiting or installing worker is
//   found. Tapping the bar while updateAvailable is true calls
//   window.location.reload(). The whole update-check path is guarded by
//   'serviceWorker' in navigator so file:// does not crash. See the 1.20
//   revision entry.
// - try/catch around the send-link Supabase call, resetting
//   dom.authSendEmailBtn to its idle label and enabled state and writing
//   a friendly connection message into dom.authErrorEmail. See the 1.21
//   revision entry.
// - try/catch around the password sign-in Supabase call, resetting
//   dom.authSignInPasswordBtn to its idle label and enabled state and
//   writing the same friendly connection message into
//   dom.authErrorPassword. See the 1.21 revision entry.
// - wireUndo(): binds the header #undo-button, wires the snackbar's
//   #undo-snackbar-button to window.store.undoLast(), listens for
//   'history-recorded' to show the snackbar, and binds a document-level
//   keydown for Ctrl+Z / Cmd+Z (ignored while a text input or textarea
//   has focus). Snackbar auto-hides after 5s and its timer is cleared
//   on a new action. See the 1.22 revision entry.
// - wireFabMenu(): binds the #fab-menu-button to toggle
//   #fab-menu-panel with aria-expanded kept in sync; closes the panel
//   on tap-outside or Escape; renders #history-list from
//   window.store.loadHistory() (newest first) each time the panel opens
//   and on every 'history-recorded' event; each row gets an Undo button
//   calling undoHistoryEntry(id). Empty-state line toggled against the
//   list's child count. See the 1.22 revision entry.
// - Item 4 password-step changes: the authPasswordToggle handler no
//   longer sets dom.authEmailInput.disabled = true, and the empty-email
//   message in the password handler is now "Please enter your email
//   address." See the 1.22 revision entry.
// - Redo binding in wireUndo(): the header #redo-button and the Ctrl+Y /
//   Ctrl+Shift+Z keyboard shortcuts call window.store.redoLast(). Same
//   typing guard as Ctrl+Z. See the 1.23 revision entry.
// - renderHistoryList() adds a small list-name label above each entry's
//   summary when the entry's listId resolves to a list in state.lists.
//   See the 1.23 revision entry.
// - Sync bar tap now calls renderListSwitcher() after a successful
//   syncNow() (alongside render()), so a list created or deleted on
//   another device appears in the picker without a reload. See the 1.23
//   revision entry.
// - syncLabelCompact tracking in wireSyncStatusBar(): a boolean toggled
//   by a matchMedia listener that shortens the idle sync label to
//   "↻ {time}" on narrow viewports and keeps the full "Last synced
//   {time}" on wider ones. Error / syncing / update-available labels
//   stay full-length at every width. See the 1.23 revision entry.
// - The .header-compact class on .app-header is set by a matchMedia
//   listener at init() and on resize. See the 1.23 revision entry.
//
// ================================================================================================
//
// === FIXES ===
//
// - Replaced the custom pointer-event drag-to-reorder implementation with SortableJS.
//   SortableJS handles nested lists, touch devices, and smooth animations natively, eliminating
//   the layout-thrashing and jumpy behavior of the custom solution.
// - Added `draggable: '.task-item'` to SortableJS so it correctly identifies the `<li>` elements
//   as the draggable units, fixing the issue where items could not be dragged at all.
// - Fixed SortableJS nested drag targeting using `:scope > .task-item` and `.task-item .task-item`
//   filter. Prevents the parent list from hijacking the drag of a nested subtask.
// - Reworked `initSortable()` again: `:scope` is not reliably supported by SortableJS and
//   `filter: '.task-item .task-item'` is tested against the dragged item (so it never matched
//   top-level tasks and only blocked subtasks after the outer list had already claimed the
//   mousedown). Now uses `draggable: '> .task-item'` (SortableJS's supported direct-child
//   syntax), removes `filter` entirely, and constrains each instance with
//   `group: { pull: false, put: false }` so drags cannot transfer between lists. `onEnd` now
//   delegates to `store.reorderTask(taskId, neighborId, 'before'|'after')` instead of
//   hand-reassigning `createdAt` and mutating `section`/`parentId` — so a within-list drag is
//   persisted correctly, and cross-section/cross-parent moves remain the job of the existing
//   "Move to…" control.
// - Enabled cross-parent drag via SortableJS `group: { pull: true, put: true }`. `onEnd` now
//   detects when a task is dropped into a different `<ul>` (either a different parent's
//   `.task-children` or a different section's `.task-list`), resolves the new parent and section
//   from the DOM, and calls the new `store.reparentTask()` to persist the parent/section change
//   before calling `store.reorderTask()` to place the task at the exact dropped index. This
//   replaces the previous "Move to…" control for subtask reparenting. Cycle prevention
//   (a task cannot become its own descendant) is enforced by Sortable's DOM mechanics — a
//   dragged task is physically removed from the DOM during drag, so it never appears inside
//   its own subtree — plus a single-level `taskId === newParentId` guard in `reparentTask`.
// - Added YouTube-style auto-scroll for touch drags: `scroll: true`, `scrollSensitivity: 100`,
//   `scrollSpeed: 15`, `bubbleScroll: true`. Dragging near the top or bottom of the viewport
//   now scrolls the page, so a task can be dropped into a list that was off-screen when the
//   drag started.
// - Force fallback auto-scroll on desktop: added `forceAutoScrollFallback: true` so SortableJS
//   uses its own scroll logic rather than relying on native browser drag auto-scroll, which
//   ignores `scrollSensitivity` and `scrollSpeed`. Bumped `scrollSensitivity` from 100 to 200
//   to approximate a 30% viewport trigger zone. Tested on PC and mobile; tune the number if the
//   zone feels too aggressive or too shallow.
// - Auto-scroll trigger zone is now percentage-based: `getScrollSensitivity()` computes
//   `innerHeight * 0.28` on mobile (viewport ≤ 639px) and `innerHeight * 0.15` on desktop
//   (viewport ≥ 640px), matching the existing `ACTIONS_BREAKPOINT_PX` split. Replaces the
//   hardcoded `scrollSensitivity: 200` with the dynamic value. Because SortableJS caches
//   config at construction time, the value is re-evaluated on every `render()` — which runs
//   on resize, so orientation changes are handled.
// - Auth handlers crashed with "Cannot read properties of undefined (reading 'getSession')"
//   because they were calling window.supabase.auth.* on the raw UMD library, which has no
//   .auth until a client has been created. The click handler now reads session state from
//   window.sync.getSession() (the currentSession sync.js already tracks), and the sign-out,
//   signInWithOtp, and verifyOtp calls each build a local
//   createClient(SUPABASE_URL, SUPABASE_ANON_KEY) instance. Supabase's session storage is
//   shared across clients per origin, so the second instance picks up the session sync.js
//   manages, and sync.js's onAuthStateChange listener (next change) picks up auth events the
//   ui.js instance produces.
// - Auth events bypassed sync.js's onAuthStateChange listener. The per-call
//   createClient() instances in the 1.2 version produced auth events that only
//   their own client observed, so currentSession in sync.js could go stale and
//   the header button could lag behind the real session. All auth calls now use
//   window.sync.getClient(), the single client whose onAuthStateChange is
//   registered in sync.js -- events always reach that listener.
// - Header button stayed on "Sign in to sync" after a page load with a session
//   already stored. sync.js's initial getSession() and its immediate
//   supabase-auth-changed dispatch could both fire before ui.js's init() had
//   cached the DOM and attached the listener, so the event was lost. The fix
//   is a direct read of window.sync.getSession() at the end of wireAuthEvents()
//   that updates the button on first load; post-init transitions still flow
//   through the listener.
// - Password sign-in handler would throw silently if dom.authPasswordInput
//   was missing (typically because a stale render.js was served from the
//   service-worker cache). The handler now checks the reference first and
//   logs "Auth Error: password input not found in DOM cache." so a future
//   version of this failure is diagnosed in one console line.
// - Auth DOM references lived in render.js's `dom` cache, which is a top-level
//   `const` and therefore not visible on `window`. Any auth code that read
//   `dom.auth*` was implicitly coupled to load order between render.js and
//   ui.js, and any console diagnostic that tried `window.dom.auth*` saw
//   `undefined` even when the cache was populated. wireAuthEvents() now
//   looks up its own elements by id at the top of the function and bails out
//   cleanly if the modal markup is missing -- the handler owns what it binds.
//   Superseded in 1.8 by the persistent-email structure: the auth flow now
//   reads dom.auth* again because render.js and ui.js ship the same set of
//   ids in the same round, so cross-file coupling is no longer a live risk.
// - Password sign-in reads the email from the email input, but the email
//   input used to live in the previous step, so a user who toggled to
//   password before typing an email got a confusing silent failure. The
//   persistent-email layout puts the email input outside either step so it
//   is always visible, disables it when switching to password so it can't
//   change mid-flow, and adds specific validation messages for the two
//   empty-field cases. See the 1.8 revision entry.
// - No way to refresh on demand in the iPhone Home Screen PWA. The new
//   status bar (1.9) is the refresh control: a real button under the
//   header that re-runs the load-time sync path and, if a service worker
//   update is waiting, prompts for a reload on the next tap. It is not
//   pull-to-refresh (which conflicts with SortableJS drag-to-reorder and is
//   unreliable in iOS standalone PWAs) and it does not gate on
//   display-mode: standalone (it is for every signed-in user on every
//   device).
// - The status bar click handler assumed success. If syncNow() failed
//   (network offline, queue flush aborted), it still proceeded to the SW
//   update check and ended in the idle state, silently masking the failure.
//   It now reads the boolean return from syncNow(): false -> error state,
//   true -> SW update check and idle. See the 1.10 revision entry.
// - The status bar initial render could lag behind a sync that completed
//   before the listener was attached. Dispatches a fake event on setup. See
//   the 1.11 revision entry.
// - Renaming a list did not sync to Supabase. handleListRename() saved the
//   new name to localStorage but never dispatched a 'sync-list-change'
//   event, so sync.js had no idea the name changed and never pushed the
//   update. The handler now dispatches the event with op: 'update'. See the
//   1.12 revision entry.
// - Clicking the sync bar while signed out showed a misleading "Sync failed"
//   error. The bar was supposed to be hidden when signed out, but the
//   click handler still ran and showError() forcibly unhid the bar. The
//   click handler now checks for a session and returns early, and
//   showError() checks the session before unhiding. See the 1.13 revision
//   entry.
// - The manual sync button failed to update the DOM after fetching remote
//   data. The background fetch did not reliably rebuild the UI. It now
//   forces a window.location.reload() after flushing the queue. This wipes
//   JS memory and re-runs initSync() from scratch, guaranteeing fresh data.
//   See the 1.14 revision entry.
// - Signing in after the app already loaded did not display the cloud data.
//   fetchRemoteState() updated memory but did not re-render the UI. The
//   password handler now calls window.location.reload() after success, and
//   the auth listener reloads for magic-link sign-ins. See the 1.15 revision
//   entry.
// - The 'hasSynced' sessionStorage flag was never cleared on sign-out,
//   preventing the auto-reload from firing on the next sign-in. The
//   sign-out handler now removes it. See the 1.16 revision entry.
// - Imported tasks were not reaching Supabase. handleImportFile() created
//   the list and tasks locally but never dispatched the 'sync-task-change'
//   events that trigger pushTask(). It now loops over the imported tasks
//   and dispatches for each. See the 1.17 revision entry.
// - The supabase-auth-changed listener in ui.js was double-firing the
//   sessionStorage reload that sync.js now handles. Removed the reload block
//   from ui.js. See the 1.17 revision entry.
// - Large imports hammered Supabase and hit rate limits. handleImportFile()
//   dispatched every 'sync-task-change' synchronously, so a 100-task import
//   fired 100 upserts in a burst. The handler now runs an async loop that
//   awaits 150ms between dispatches and updates dom.pasteStatus with
//   progress text. See the 1.18 revision entry.
// - Password sign-in reloaded the page, wiping local UI state and any
//   in-progress edits. The handler now closes the modal and lets the
//   auth-state event flow update the header button and sync bar. See the
//   1.18 revision entry.
// - The manual sync button reloaded the page, which wiped JS memory and
//   made the sync feel heavy on every tap. The handler now runs
//   window.sync.syncNow(), toggles the syncing state around it, and
//   re-renders the bar in place. See the 1.18 revision entry.
// - A failed manual sync was silent. The click handler caught the error
//   (or ignored the boolean false return from syncNow()) and re-rendered
//   to the idle "Last synced {old time}" label, so the user had no way to
//   know the sync failed. It now calls showError() on either failure path,
//   which paints "Sync failed — tap to retry · Last synced {time}" and
//   leaves the bar tappable for a retry. See the 1.19 revision entry.
// - The sync bar could never show the "Update available — tap to reload"
//   state because nothing ever set updateAvailable to true, and nothing
//   called navigator.serviceWorker.getRegistration() or
//   registration.update(). The click handler now runs both after a
//   successful syncNow() and flips the flag when a waiting or installing
//   worker is present. See the 1.20 revision entry.
// - A network failure during sign-in was silent and left the button stuck.
//   Both sign-in handlers awaited the Supabase call without a try/catch
//   and only checked the returned { error } object. API-level failures
//   (wrong password, wrong email) come back in that object and were
//   handled; a network failure throws TypeError: Failed to fetch, which
//   propagated as an unhandled rejection — no message was shown, and the
//   "Signing in..." / "Sending..." disabled state was never reset because
//   the reset lines after the await never ran. Both handlers now catch
//   the throw, reset their button, and write a friendly connection
//   message into the modal's existing .auth-error paragraph. The sync
//   bar's showError() is not used here because a failed sign-in means the
//   user is signed out and the bar must stay hidden (Item 9). See the
//   1.21 revision entry.
// - No undo existed anywhere — the delete-list dialog literally said "This
//   cannot be undone." Item 1 adds two layers: a transient snackbar after
//   each edit / delete / toggle / move / reorder (with an Undo button and
//   a 5s auto-dismiss), and an always-available Recent Changes list in
//   the new FAB menu (Item 2) with per-row Undo buttons, persisted in
//   localStorage so it survives a reload. Undo is another store change
//   and syncs like any other. See the 1.22 revision entry.
// - The header was growing with every new control. Item 2 adds a ⋯ FAB
//   menu (bottom-right) that holds occasional/config actions — the
//   Recent Changes list is its first tenant. The manual refresh + last-
//   synced label stay out of the menu and visible under the header; the
//   menu closes on tap-outside, selection, or Escape. See the 1.22
//   revision entry.
// - The password step's email field was locked, so a user who typed the
//   wrong address on the link step couldn't fix it before signing in
//   with password. Item 4 drops the lock (and the email is already shared
//   across both steps in the persistent-email layout), and the empty-
//   email message is now "Please enter your email address." See the 1.22
//   revision entry.
// - The undo snackbar never appeared because store.js's recordHistory()
//   did not dispatch 'history-recorded'. The store now dispatches it;
//   no UI change was needed. See the 1.23 revision entry for the store-
//   side dispatch this pairs with.
// - History rows did not say which list they belonged to, so entries
//   from other lists looked like they had been applied to the active
//   list. renderHistoryList() now prepends a small list-name label when
//   the entry's listId resolves in state.lists. See the 1.23 revision
//   entry.
// - The sync button did not rebuild the list picker, so a list created
//   or deleted on another device did not appear until a full page
//   reload. The tap handler now calls renderListSwitcher() alongside
//   render() after a successful syncNow(), matching what the sign-in
//   path already does. See the 1.23 revision entry.
// - The header was visually unorganized on mobile portrait: the sync
//   pill sat on its own row and the ↩ glyph floated between pills. Item
//   4 reorganizes the header via a `.header-compact` class: desktop and
//   mobile landscape keep one row (List, Undo, Redo, Login, Sync,
//   Theme); mobile portrait breaks onto two rows. A matchMedia listener
//   toggles the class at init and on resize. The sync pill also shortens
//   its idle label to "↻ {time}" under the compact breakpoint; error /
//   syncing / update-available labels stay full-length. See the 1.23
//   revision entry.
// - No redo existed. Item 5 adds the ↪ button (bound to #redo-button)
//   and Ctrl+Y / Ctrl+Shift+Z (skipped while typing in an input or
//   textarea), both calling window.store.redoLast(). The store records
//   the forward action alongside the undo action on every entry, and
//   the redo stack is cleared by any new recorded action and on
//   hydrateFromRemote(). See the 1.23 revision entry.
//
// ================================================================================================

/* ================================================================================================
   PASTE BOX
   ================================================================================================ */

function normalizeForDedupe(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

function handlePasteAdd() {
  const raw = dom.pasteInput.value;
  const lines = raw.split(/\r?\n/);

  const existing = new Set(activeList().tasks.map((t) => normalizeForDedupe(t.text)));
  let added = 0;
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const key = normalizeForDedupe(trimmed);
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }

    addTask(trimmed, 'sort', null, { record: false });
    existing.add(key);
    added += 1;
  }

  dom.pasteInput.value = '';

  const parts = [];
  parts.push(`Added ${added}`);
  if (skipped > 0) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
  dom.pasteStatus.textContent = parts.join(', ');

  setTimeout(() => {
    if (dom.pasteStatus.textContent) dom.pasteStatus.textContent = '';
  }, 4000);

  render();
}


/* ================================================================================================
   EXPORT / IMPORT
   ================================================================================================ */

function handleExport() {
  const list = activeList();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    listName: list.name,
    tasks: list.tasks,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const safeName = list.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'list';
  const stamp = new Date().toISOString().slice(0, 10);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function deriveListNameFromFile(filename) {
  return String(filename || '')
    .replace(/\.json$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function handleImportFile(file) {
  const reader = new FileReader();

  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (err) {
      alert('That file is not valid JSON.');
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      alert('That JSON does not look like a To Do List export (missing "tasks" array).');
      return;
    }

    const fallback = parsed.listName || deriveListNameFromFile(file.name) || 'Imported list';
    const entered = window.prompt('Name for the imported list:', uniqueListName(fallback));
    if (entered === null) return;

    const finalName = String(entered).trim() || uniqueListName(fallback);
    const sanitizedTasks = sanitizeTasks(parsed.tasks);

    const newList = createList(finalName);
    newList.tasks = sanitizedTasks;

    state.activeListId = newList.id;
    ui.editingId = null;
    ui.addingSubtaskTo = null;
    ui.openMenuTaskId = null;

    saveState();
    renderListSwitcher();
    render();

    // Sync to Supabase with a delay to avoid rate limiting
    (async () => {
      dom.pasteStatus.textContent = `Importing ${sanitizedTasks.length} tasks to cloud...`;
      for (let i = 0; i < newList.tasks.length; i++) {
        const task = newList.tasks[i];
        window.dispatchEvent(new CustomEvent('sync-task-change', { 
          detail: { op: 'insert', task: { ...task, listId: newList.id } } 
        }));
        // Wait 150ms between each task
        await new Promise(r => setTimeout(r, 150));
      }
      dom.pasteStatus.textContent = `Successfully imported "${newList.name}".`;
      setTimeout(() => {
        if (dom.pasteStatus.textContent.startsWith('Successfully')) dom.pasteStatus.textContent = '';
      }, 5000);
    })();
  };

  reader.onerror = () => {
    alert('Could not read that file.');
  };

  reader.readAsText(file);
}


/* ================================================================================================
   LIST ACTIONS
   ================================================================================================ */

function handleListSwitch(listId) {
  setActiveList(listId);
  renderListSwitcher();
  render();
}

function handleListNew() {
  const entered = window.prompt('Name for the new list:', 'New list');
  if (entered === null) return;
  const name = String(entered).trim() || 'New list';
  const list = createList(name);
  state.activeListId = list.id;
  ui.editingId = null;
  ui.addingSubtaskTo = null;
  ui.openMenuTaskId = null;
  saveState();
  renderListSwitcher();
  render();
}

function handleListRename() {
  const list = activeList();
  const entered = window.prompt('Rename list:', list.name);
  if (entered === null) return;
  const name = String(entered).trim();
  if (!name) return;

  const others = Object.values(state.lists)
    .filter((l) => l.id !== list.id)
    .map((l) => l.name);
  let finalName = name;
  if (others.includes(finalName)) {
    let n = 2;
    while (others.includes(`${name} (${n})`)) n += 1;
    finalName = `${name} (${n})`;
  }
  list.name = finalName;
  
  // Broadcast the change to sync.js
  window.dispatchEvent(new CustomEvent('sync-list-change', { 
    detail: { op: 'update', list: { id: list.id, name: list.name, created_at: Date.now() } } 
  }));
  
  saveState();
  renderListSwitcher();
}

function handleListDelete() {
  if (Object.keys(state.lists).length <= 1) return;
  const list = activeList();
  const ok = window.confirm(
    `Delete the list "${list.name}" and all of its tasks?\n\nThis cannot be undone.`
  );
  if (!ok) return;
  deleteList(list.id);
  ui.editingId = null;
  ui.addingSubtaskTo = null;
  ui.openMenuTaskId = null;
  saveState();
  renderListSwitcher();
  render();
}


/* ================================================================================================
   DRAG-TO-REORDER (SortableJS)
   ------------------------------------------------------------------------------------------------
   One Sortable instance per list container (each `.task-list` and each `.task-children`), so a
   drag is always scoped to that container's own direct children. This is what makes parent
   reorder and subtask reorder independent — they are separate Sortables on separate <ul>s, not
   one Sortable trying to guess which descendant was grabbed.

   Cross-parent drag is now enabled (`group: { pull: true, put: true }`). When a task is dropped
   into a different container, `onEnd` reads the destination DOM to resolve the new parent task
   and section, then calls `store.reparentTask()` to persist that change, then
   `store.reorderTask()` to place the task at the exact dropped index. Cycles are physically
   impossible because the dragged task is removed from the DOM during drag — it never appears
   in its own subtree as a drop target.

   `scroll`, `scrollSensitivity`, `scrollSpeed`, and `bubbleScroll` add YouTube-style auto-scroll
   during drag. Dragging near the top or bottom edge of the viewport now scrolls the page, so a
   task can be dropped into a container that was off-screen when the drag started.
   `forceAutoScrollFallback: true` ensures SortableJS runs its own scroll logic on desktop
   browsers too, where native drag autoscroll would otherwise ignore the configured
   `scrollSensitivity` and `scrollSpeed`.

   `scrollSensitivity` is percentage-based (28% mobile, 15% desktop) and computed by
   `getScrollSensitivity()` against `innerHeight` at Sortable construction time — which is
   re-run on every `render()`, so orientation changes and window resizes are handled.

   Rules that still matter:

     1. `draggable: '> .task-item'` — the leading `>` is SortableJS's supported way to say
        "direct children only." `:scope > .task-item` is NOT supported (SortableJS does not
        implement `:scope` reliably) and was the cause of the subtask-does-not-drag symptom.

     2. `handle: '.task-drag-handle'` — only the handle initiates a drag; the rest of the row
        keeps its click behavior intact.

     3. `onEnd` calls the store functions and lets them handle persistence. Do not reassign
        `createdAt` or mutate `section`/`parentId` here — `reparentTask` and `reorderTask`
        already do it correctly, and duplicating the mutation desynchronizes the data.
   ================================================================================================ */

/**
 * Initializes a SortableJS instance on every task-list container in the current DOM.
 *
 * Called from render() after every render, so each container is torn down and re-created
 * against the freshly built <li> nodes. Because render() re-runs on window resize, the
 * percentage-based scroll sensitivity is re-evaluated whenever the viewport changes.
 *
 * The dragged item's new position is persisted through two store calls:
 *   - If dropped in a different container, `reparentTask(taskId, newParentId, newSection)` first,
 *     to update the task's parent and section.
 *   - Then `reorderTask(taskId, neighborId, 'before' | 'after')`, to place the task at the exact
 *     dropped index within its new siblings.
 */
function initSortable() {
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS not loaded.');
    return;
  }

  // Determine scroll sensitivity based on screen size (28% mobile, 15% PC).
  // We check against the existing ACTIONS_BREAKPOINT_PX (640) to match the mobile/desktop split.
  function getScrollSensitivity() {
    const isMobile = window.matchMedia(`(max-width: ${ACTIONS_BREAKPOINT_PX - 0.02}px)`).matches;
    const percentage = isMobile ? 0.28 : 0.15;
    return Math.round(window.innerHeight * percentage);
  }

  document.querySelectorAll('.task-list, .task-children').forEach((listEl) => {
    // Destroy any instance left over from the previous render before re-binding.
    if (listEl._sortableInstance) {
      listEl._sortableInstance.destroy();
      listEl._sortableInstance = null;
    }

    listEl._sortableInstance = new Sortable(listEl, {
      // Direct-child <li>s only. `>` is the supported way to scope this; `:scope` is not.
      draggable: '> .task-item',

      // Allow drags to move between lists (e.g., subtask to another parent).
      group: { name: 'tasks', pull: true, put: true },

      // Only the handle initiates a drag; the rest of the row keeps its click behavior.
      handle: '.task-drag-handle',

      animation: 150,

      // Keep the dragged row visually attached to the cursor across list boundaries.
      fallbackOnBody: true,
      swapThreshold: 0.65,

      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',

      // Move a task past the midpoint before reordering — avoids jitter on tall rows.
      invertSwap: false,

      // --- Auto-scroll ---
      scroll: true,
      forceAutoScrollFallback: true,
      scrollSensitivity: getScrollSensitivity(), // Dynamically calculated 28% / 15%
      scrollSpeed: 15,
      bubbleScroll: true,

      onEnd(evt) {
        // If dropped in the same position, nothing changed.
        if (evt.oldIndex === evt.newIndex && evt.from === evt.to) return;

        const draggedId = evt.item.dataset.taskId;
        if (!draggedId) return;

        // Determine if the task changed lists.
        const changedList = evt.from !== evt.to;

        if (changedList) {
          // Figure out the new parent and section from the target <ul>.
          let newParentId = null;
          if (evt.to.classList.contains('task-children')) {
            const parentItem = evt.to.closest('.task-item');
            if (parentItem) {
              newParentId = parentItem.dataset.taskId;
            }
          }

          // Determine the new section.
          let newSection = 'sort';
          const sectionEl = evt.to.closest('.task-section');
          if (sectionEl) {
            newSection = sectionEl.dataset.section;
          } else if (evt.to.dataset.listFor) {
            newSection = evt.to.dataset.listFor;
          }

          // Update the task's parent and section in the store.
          reparentTask(draggedId, newParentId, newSection);
        }

        // Now that the parent/section is updated, find the sibling to anchor to.
        const siblings = Array.from(evt.to.children).filter(
          (el) => el.classList && el.classList.contains('task-item')
        );

        const droppedIndex = siblings.indexOf(evt.item);
        if (droppedIndex === -1) return;

        const prevSibling = droppedIndex > 0 ? siblings[droppedIndex - 1] : null;
        const nextSibling = droppedIndex < siblings.length - 1 ? siblings[droppedIndex + 1] : null;

        let neighborId = null;
        let position = null;

        if (prevSibling) {
          neighborId = prevSibling.dataset.taskId;
          position = 'after';
        } else if (nextSibling) {
          neighborId = nextSibling.dataset.taskId;
          position = 'before';
        } else {
          // Dropped into an empty list (or as the sole child) — nothing to anchor to.
          // The reparentTask above already saved the new location, so we just render.
          render();
          return;
        }

        if (!neighborId) return;

        // Persist the new order.
        const changedOrder = reorderTask(draggedId, neighborId, position);
        if (changedOrder || changedList) {
          render();
        }
      },
    });
  });
}


/* ================================================================================================
   EVENT WIRING
   ================================================================================================ */

function wireEvents() {
  // ---- List switcher ----
  dom.listSelect.addEventListener('change', () => handleListSwitch(dom.listSelect.value));
  dom.listNewButton.addEventListener('click', handleListNew);
  dom.listRenameButton.addEventListener('click', handleListRename);
  dom.listDeleteButton.addEventListener('click', handleListDelete);

  // ---- Theme ----
  dom.themeSelect.addEventListener('change', () => setTheme(dom.themeSelect.value));

  // ---- Quick add ----
  const quickAddCommit = () => {
    const value = dom.quickAddInput.value;
    if (!value.trim()) return;
    addTask(value, 'sort', null);
    dom.quickAddInput.value = '';
    render();
  };
  dom.quickAddButton.addEventListener('click', quickAddCommit);
  dom.quickAddInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      quickAddCommit();
    }
  });

  // ---- Per-section "+" buttons ----
  dom.sections.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-to]');
    if (!btn) return;
    const section = btn.getAttribute('data-add-to');
    const text = window.prompt(`New task in ${SECTION_LABELS[section]}:`);
    if (text && text.trim()) {
      addTask(text, section, null);
      render();
    }
  });

  // ---- Search ----
  dom.searchInput.addEventListener('input', () => {
    ui.searchRaw = dom.searchInput.value;
    ui.search = ui.searchRaw.trim().toLowerCase();
    dom.searchClear.hidden = ui.searchRaw.length === 0;
    render();
  });
  dom.searchClear.addEventListener('click', () => {
    dom.searchInput.value = '';
    ui.searchRaw = '';
    ui.search = '';
    dom.searchClear.hidden = true;
    render();
    dom.searchInput.focus();
  });

  // ---- Paste box ----
  dom.pasteAddButton.addEventListener('click', handlePasteAdd);

  // ---- Export / import ----
  dom.exportButton.addEventListener('click', handleExport);
  dom.importButton.addEventListener('click', () => dom.importFile.click());
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    if (file) handleImportFile(file);
    dom.importFile.value = '';
  });

  // ---- Global keyboard: Escape ----
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (ui.openMenuTaskId) {
      e.preventDefault();
      closeMenu({ returnFocus: true });
      return;
    }
    if (ui.editingId || ui.addingSubtaskTo) {
      ui.editingId = null;
      ui.addingSubtaskTo = null;
      render();
    }
  });

  // ---- Click outside closes the menu ----
  document.addEventListener('click', (e) => {
    if (!ui.openMenuTaskId) return;
    if (e.target.closest('.task-action-menu')) return;
    if (e.target.closest('.task-menu-button')) return;
    closeMenu({ returnFocus: false });
  });

  // ---- Window resize / orientation change ----
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (ui.openMenuTaskId) {
        closeMenu({ returnFocus: false });
      }
    });
  });
}


/* ================================================================================================
   HEADER COMPACT (Item 4)
   ------------------------------------------------------------------------------------------------
   Toggles a `.header-compact` class on .app-header at the compact breakpoint (matches the mobile-
   portrait breakpoint — 640px is where the header goes to two rows). The class is read by
   css/base.css to break the row and to shorten the idle sync label. Error / syncing / update-
   available labels stay full-length at every width.
   ================================================================================================ */

const HEADER_COMPACT_QUERY = '(max-width: 639.98px) and (orientation: portrait)';

function wireHeaderCompact() {
  const header = document.querySelector('.app-header');
  if (!header) return;

  const mql = window.matchMedia(HEADER_COMPACT_QUERY);

  function apply() {
    header.classList.toggle('header-compact', mql.matches);
    // Re-render the sync bar so a width change can flip between the short
    // "↻ {time}" and the full "Last synced {time}" idle label.
    window.dispatchEvent(new CustomEvent('sync-state-changed'));
  }

  apply();
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', apply);
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(apply);
  }
}


/* ================================================================================================
   UNDO / REDO (Items 1, 5)
   ------------------------------------------------------------------------------------------------
   Layer 1 — snackbar: after each history-recorded action, a transient banner shows the
             entry's summary and an Undo button. Auto-hides after 5s; a new action clears
             and resets the timer. Ctrl+Z / Cmd+Z on desktop calls undoLast() directly.

   The header #undo-button and #redo-button are the persistent entry points. Ctrl+Shift+Z and
   Ctrl+Y call redoLast(). All five paths go through window.store.
   ================================================================================================ */

const SNACKBAR_DURATION_MS = 5000;

function wireUndo() {
  const undoBtn = document.getElementById('undo-button');
  const redoBtn = document.getElementById('redo-button');
  const snackbar = document.getElementById('undo-snackbar');
  const snackbarText = document.getElementById('undo-snackbar-text');
  const snackbarBtn = document.getElementById('undo-snackbar-button');
  if (!snackbar || !snackbarText || !snackbarBtn) return;

  let snackbarTimer = 0;

  function hideSnackbar() {
    if (snackbarTimer) {
      clearTimeout(snackbarTimer);
      snackbarTimer = 0;
    }
    snackbar.hidden = true;
  }

  function showSnackbar(text) {
    snackbarText.textContent = text || 'Action applied';
    snackbar.hidden = false;
    if (snackbarTimer) clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => {
      snackbarTimer = 0;
      snackbar.hidden = true;
    }, SNACKBAR_DURATION_MS);
  }

  function doUndo() {
    const store = window.store;
    if (!store || typeof store.undoLast !== 'function') return;
    const ok = store.undoLast();
    if (ok) {
      hideSnackbar();
      renderListSwitcher();
      render();
    }
  }

  function doRedo() {
    const store = window.store;
    if (!store || typeof store.redoLast !== 'function') return;
    const ok = store.redoLast();
    if (ok) {
      renderListSwitcher();
      render();
    }
  }

  // Layer 1: snackbar shown on each recorded action
  window.addEventListener('history-recorded', (e) => {
    const detail = e && e.detail ? e.detail : null;
    if (!detail) return;
    showSnackbar(detail.summary || 'Action applied');
  });

  // Snackbar Undo button
  snackbarBtn.addEventListener('click', () => {
    doUndo();
  });

  // Header undo button (persistent entry point)
  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      doUndo();
    });
  }

  // Header redo button (Item 5)
  if (redoBtn) {
    redoBtn.addEventListener('click', () => {
      doRedo();
    });
  }

  // Ctrl+Z / Cmd+Z for undo; Ctrl+Shift+Z / Ctrl+Y for redo (desktop).
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z' || e.key === 'Z') {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (e.key === 'y' || e.key === 'Y') {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      doRedo();
    }
  });
}


/* ================================================================================================
   FAB MENU (Item 2)
   ------------------------------------------------------------------------------------------------
   ⋯ button bottom-right. Toggles #fab-menu-panel with aria-expanded kept in sync. The
   Recent Changes list inside the panel is rendered from window.store.loadHistory() (newest
   first) each time the panel opens and on every 'history-recorded' event. Each row carries
   its own Undo button calling undoHistoryEntry(id), and a small list-name label so entries
   from other lists make sense.
   ================================================================================================ */

function renderHistoryList() {
  const listEl = document.getElementById('history-list');
  const emptyEl = document.getElementById('history-empty');
  if (!listEl) return;

  const store = window.store;
  const entries = store && typeof store.loadHistory === 'function' ? store.loadHistory() : [];

  listEl.innerHTML = '';

  if (!entries || entries.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  // Newest first
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const li = document.createElement('li');
    li.className = 'history-item';

    // Item 2 (UI): small list-name label so entries from other lists make sense.
    const listId = entry.listId || (entry.undoAction && entry.undoAction.listId);
    const listName = listId && state.lists[listId] ? state.lists[listId].name : null;
    if (listName) {
      const labelEl = document.createElement('span');
      labelEl.className = 'history-item-list';
      labelEl.textContent = listName;
      li.appendChild(labelEl);
    }

    const textEl = document.createElement('span');
    textEl.className = 'history-item-text';
    textEl.textContent = entry.summary || entry.kind || 'Change';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item-undo';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => {
      const ok = store.undoHistoryEntry(entry.id);
      if (ok) {
        renderHistoryList();
        renderListSwitcher();
        render();
      } else {
        // Dead entry was dropped; re-render the list so the row disappears.
        renderHistoryList();
      }
    });

    li.appendChild(textEl);
    li.appendChild(btn);

    listEl.appendChild(li);
  }
}

function wireFabMenu() {
  const fab = document.getElementById('fab-menu-button');
  const panel = document.getElementById('fab-menu-panel');
  if (!fab || !panel) return;

  function setOpen(open) {
    if (open) {
      panel.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      renderHistoryList();
    } else {
      panel.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
    }
  }

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });

  // Tap-outside closes
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target)) return;
    if (e.target === fab || fab.contains(e.target)) return;
    setOpen(false);
  });

  // Escape closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      setOpen(false);
    }
  });

  // Re-render history whenever an action is recorded and the panel is open
  window.addEventListener('history-recorded', () => {
    if (!panel.hidden) renderHistoryList();
  });
}


/* ================================================================================================
   AUTH UI
   ================================================================================================ */

function wireAuthEvents() {
  // Safely cache auth elements here to ensure they are bound
  const btn = document.getElementById('auth-button');
  const modal = document.getElementById('auth-modal');
  
  if (!btn || !modal) return; // Prevent errors if markup is missing

  // Open modal / Sign out
  btn.addEventListener('click', async () => {
    const session = window.sync ? window.sync.getSession() : null;
    if (session) {
      if (window.confirm('Sign out? Local data will remain on this device.')) {
        await window.sync.getClient().auth.signOut();
        sessionStorage.removeItem('hasSynced');
      }
    } else {
      // Reset to Link step
      dom.authTitle.textContent = 'Sign in to sync';
      dom.authSubtitle.textContent = 'Enter your email and we\'ll send you a sign-in link.';
      dom.authEmailHint.hidden = false;
      dom.authStepEmail.hidden = false;
      dom.authStepPassword.hidden = true;
      
      dom.authErrorEmail.textContent = '';
      dom.authErrorPassword.textContent = '';
      dom.authSentMsg.hidden = true;
      dom.authSendEmailBtn.hidden = false;
      dom.authEmailInput.value = '';
      dom.authPasswordInput.value = '';
      dom.authEmailInput.disabled = false;
      
      modal.showModal();
    }
  });

  // Close modal
  dom.authClose.addEventListener('click', () => modal.close());

  // Toggle to Password Step — Item 4: email stays editable on this step.
  dom.authPasswordToggle.addEventListener('click', (e) => {
    e.preventDefault();
    dom.authTitle.textContent = 'Sign in with password';
    dom.authSubtitle.textContent = 'Enter the password for your account.';
    dom.authEmailHint.hidden = true;
    dom.authStepEmail.hidden = true;
    dom.authStepPassword.hidden = false;
    
    // Item 4: keep the email input editable. (Pre-1.22 it was disabled here.)
    dom.authEmailInput.disabled = false;
    dom.authPasswordInput.focus();
  });

  // Toggle back to Link Step
  dom.authEmailToggle.addEventListener('click', (e) => {
    e.preventDefault();
    dom.authTitle.textContent = 'Sign in to sync';
    dom.authSubtitle.textContent = 'Enter your email and we\'ll send you a sign-in link.';
    dom.authEmailHint.hidden = false;
    dom.authStepEmail.hidden = false;
    dom.authStepPassword.hidden = true;
    
    dom.authEmailInput.disabled = false;
    dom.authEmailInput.focus();
  });

  // Send Email Link
  dom.authSendEmailBtn.addEventListener('click', async () => {
    const email = dom.authEmailInput.value.trim();
    dom.authErrorEmail.textContent = '';
    
    if (!email) {
      dom.authErrorEmail.textContent = 'Please enter your email address.';
      return;
    }
    
    dom.authSendEmailBtn.textContent = 'Sending...';
    dom.authSendEmailBtn.disabled = true;

    try {
      const { error } = await window.sync.getClient().auth.signInWithOtp({
        email: email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin + window.location.pathname
        }
      });

      dom.authSendEmailBtn.textContent = 'Send sign-in link';
      dom.authSendEmailBtn.disabled = false;

      if (error) {
        dom.authErrorEmail.textContent = error.message;
      } else {
        dom.authSendEmailBtn.hidden = true;
        dom.authSentMsg.hidden = false;
        dom.authPasswordToggle.parentElement.hidden = true;
      }
    } catch (e) {
      dom.authSendEmailBtn.textContent = 'Send sign-in link';
      dom.authSendEmailBtn.disabled = false;
      dom.authErrorEmail.textContent =
        "Couldn't reach the server — check your connection and try again.";
    }
  });

  // Sign in with Password — Item 4: empty-email message updated.
  dom.authSignInPasswordBtn.addEventListener('click', async () => {
    const email = dom.authEmailInput.value.trim();
    const password = dom.authPasswordInput.value;
    
    dom.authErrorPassword.textContent = '';
    
    if (!email) {
      dom.authErrorPassword.textContent = 'Please enter your email address.';
      return;
    }
    if (!password) {
      dom.authErrorPassword.textContent = 'Please enter your password.';
      return;
    }

    dom.authSignInPasswordBtn.textContent = 'Signing in...';
    dom.authSignInPasswordBtn.disabled = true;

    try {
      const { data, error } = await window.sync.getClient().auth.signInWithPassword({
        email: email,
        password: password
      });

      dom.authSignInPasswordBtn.textContent = 'Sign in';
      dom.authSignInPasswordBtn.disabled = false;

      if (error) {
        dom.authErrorPassword.textContent = error.message;
      } else {
        modal.close();
      }
    } catch (e) {
      dom.authSignInPasswordBtn.textContent = 'Sign in';
      dom.authSignInPasswordBtn.disabled = false;
      dom.authErrorPassword.textContent =
        "Couldn't reach the server — check your connection and try again.";
    }
  });

  // Listen for auth changes from sync.js
  window.addEventListener('supabase-auth-changed', (e) => {
    const session = e.detail.session;
    if (session) {
      btn.textContent = session.user.email.split('@')[0];
      btn.title = "Click to sign out";
    } else {
      btn.textContent = 'Sign in to sync';
      btn.title = "Click to sign in";
    }
  });

  // Check initial state in case sync.js finished before we attached the listener
  const initialSession = window.sync ? window.sync.getSession() : null;
  if (initialSession) {
    btn.textContent = initialSession.user.email.split('@')[0];
    btn.title = "Click to sign out";
  }
}


/* ================================================================================================
   SYNC STATUS BAR
   ================================================================================================ */

const SYNC_COMPACT_QUERY = '(max-width: 639.98px) and (orientation: portrait)';

function wireSyncStatusBar() {
  const bar = document.getElementById('sync-status-bar');
  const textSpan = document.getElementById('sync-status-text');
  if (!bar || !textSpan) return;

  const LAST_SYNC_KEY = 'todolist.v1.lastSync';
  let updateAvailable = false;
  let syncing = false;

  const compactMql = window.matchMedia(SYNC_COMPACT_QUERY);
  let compact = compactMql.matches;
  function onCompactChange() { compact = compactMql.matches; renderBar(); }
  if (typeof compactMql.addEventListener === 'function') compactMql.addEventListener('change', onCompactChange);
  else if (typeof compactMql.addListener === 'function') compactMql.addListener(onCompactChange);

  function formatTime(ms) {
    if (!ms) return compact ? '—' : 'Not synced yet';
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function idleLabel() {
    const lastSync = parseInt(localStorage.getItem(LAST_SYNC_KEY), 10);
    if (!lastSync) return compact ? '↻ —' : 'Not synced yet';
    return compact
      ? `↻ ${formatTime(lastSync)}`
      : `Last synced ${formatTime(lastSync)}`;
  }

  function renderBar() {
    // Visibility: only show when signed in
    const session = window.sync ? window.sync.getSession() : null;
    if (!session) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    // State classes
    bar.classList.toggle('is-syncing', syncing);
    bar.classList.toggle('is-error', false); // Reset error unless explicitly set below

    if (syncing) {
      textSpan.textContent = 'Syncing…';
      bar.disabled = true;
    } else if (updateAvailable) {
      textSpan.textContent = 'Update available — tap to reload';
      bar.disabled = false;
    } else {
      // Idle
      textSpan.textContent = idleLabel();
      bar.disabled = false;
    }
  }

  function showError() {
    const session = window.sync ? window.sync.getSession() : null;
    if (!session) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.classList.remove('is-syncing');
    bar.classList.add('is-error');
    // Error text is never shortened — it is a state the user must read.
    const lastSync = parseInt(localStorage.getItem(LAST_SYNC_KEY), 10);
    const label = lastSync
      ? `Sync failed — tap to retry · Last synced ${formatTime(lastSync)}`
      : 'Sync failed — tap to retry';
    textSpan.textContent = label;
    bar.disabled = false;
  }

  async function checkForUpdate() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return false;
      await registration.update();
      return !!(registration.waiting || registration.installing);
    } catch (e) {
      console.warn('Service worker update check failed:', e);
      return false;
    }
  }

  // Initial render
  renderBar();

  // Listen for auth changes to update visibility
  window.addEventListener('supabase-auth-changed', () => {
    renderBar();
  });

  // Listen for successful syncs from anywhere (load-time or manual). Also
  // re-rendered on the header-compact media-query change (see wireHeaderCompact).
  window.addEventListener('sync-state-changed', () => {
    renderBar();
  });

  // Tap handler
  bar.addEventListener('click', async () => {
    if (syncing) return;
    
    const session = window.sync ? window.sync.getSession() : null;
    if (!session) return; // Do nothing if signed out

    // If we already know an update is waiting, a tap reloads immediately.
    if (updateAvailable) {
      window.location.reload();
      return;
    }

    syncing = true;
    renderBar();

    let ok = false;
    try {
      if (window.sync && window.sync.syncNow) {
        ok = await window.sync.syncNow();
      }
    } catch (e) {
      console.warn("Sync failed", e);
      ok = false;
    }
    
    syncing = false;
    
    if (!ok) {
      showError();
      return;
    }

    // Item 3: rebuild the list picker alongside the task list. SyncNow() alone
    // only re-renders tasks; a list added or removed on another device never
    // appeared in the picker until a full page reload. Sign-in already does
    // this; the button path now matches.
    renderListSwitcher();
    render();

    // After a successful sync, check for a waiting service worker update.
    const hasUpdate = await checkForUpdate();
    if (hasUpdate) {
      updateAvailable = true;
      renderBar();
      return;
    }
    
    renderBar();
  });
}


/* ================================================================================================
   INIT
   ================================================================================================ */

function init() {
  cacheDom();
  loadState();
  applyTheme(state.theme);
  renderListSwitcher();
  wireEvents();
  wireAuthEvents();
  wireSyncStatusBar();
  wireHeaderCompact();
  wireUndo();
  wireFabMenu();
  render();

  // Initialize SortableJS after the first render.
  initSortable();

  // Register the service worker for PWA offline support.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service Worker registration failed:', err);
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
