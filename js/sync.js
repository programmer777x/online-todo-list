// sync.js Version 1.0
// =============================================================================
// Supabase Sync Module
// =============================================================================
// This file acts as the bridge between the local store (localStorage) and the
// Supabase backend. It handles authentication, remote fetching, pushing
// mutations, and the offline queue.
//
// === REVISIONS ===
// =============================================================================
// v1.0 - Initial creation for Stage 3 sync-first integration.
// v1.1 - Wire the onAuthStateChange listener into initSync(). Every auth
//        transition (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED) now dispatches
//        a 'supabase-auth-changed' custom event on window, so the header
//        button in ui.js can update its label without polling.
// v1.2 - initSync() rewritten so the auth listener is registered before the
//        initial getSession() resolves, and the already-signed-in case
//        dispatches 'supabase-auth-changed' immediately after the first
//        fetch. Without that immediate dispatch, the header button stayed
//        on "Sign in to sync" until the next auth event fired, even when a
//        session was already in localStorage. Also: because ui.js now signs
//        in and out via its own short-lived createClient() instance, this
//        listener is what catches those transitions and keeps currentSession
//        (and the exported getSession) in sync.
// v1.3 - Exposed the initialized supabaseClient instance as
//        window.sync.getClient(). ui.js was creating its own short-lived
//        createClient() instances for every auth call, which worked only
//        because Supabase shares session localStorage per origin -- but the
//        auth events those throwaway clients produced were never delivered
//        to this module's onAuthStateChange listener, so currentSession
//        could drift and the header button could lag the real session.
//        Routing all auth calls through this single client fixes that at
//        the source and removes the duplicate-client pattern entirely.
// v1.4 - Wire the local mutation hooks. initSync() now registers
//        'sync-task-change' and 'sync-list-change' listeners (dispatched by
//        store.js's saveState()); the handlers push the corresponding task
//        or list to Supabase when a session is active. fetchRemoteState()
//        now auto-migrates on first sign-in when the cloud is empty: every
//        local list and task is pushed up, in order, before the function
//        returns without calling hydrate (there is nothing to hydrate from).
//        Without these two changes, local changes never reached Supabase
//        and a fresh sign-in with local data showed an empty cloud forever.
// v1.5 - Precise payloads. store.js no longer broadcasts whole-state on
//        every save; it dispatches one targeted event per mutation
//        (insert/update/delete with just the affected item). pushList /
//        pushTask are rewritten to accept that shape directly:
//          - insert / update: build the DB row explicitly from the fields
//            the caller sent (never spread the raw object, which could
//            carry local-only keys), and upsert.
//          - delete: the caller sends only { id }, so the handler uses
//            that id directly in the .delete().eq('id', ...) chain.
//        This pairs with store.js v1.3 to keep a single user action at a
//        single Supabase request (reorder still fans out per sibling by
//        design; see store.js v1.3 FIXES).
// v1.6 - Migration and payload fixes after the empty-cloud test. The
//        auto-migration branch in fetchRemoteState() was guarded on
//        `window.state`, which is undefined in this codebase (state is a
//        top-level `let`, not on window), so the whole branch silently
//        skipped and the cloud stayed empty on first sign-in. The branch
//        now reads a localState fallback: `typeof state !== 'undefined' ?
//        state : window.state`, so it works whether or not the global has
//        been promoted. The hydrate branch is also moved behind an early
//        return inside the migration block, so the two paths are mutually
//        exclusive. pushList's created_at fallback was missing the
//        camelCase key (only `list.created_at`), and lists in the local
//        shape have neither field -- so the insert would have sent
//        `undefined`. The payload now uses
//        `list.createdAt || list.created_at || Date.now()`. Both push
//        handlers now log the exact payload they are about to send, so a
//        console snapshot is enough to tell a column-name mismatch from a
//        network failure.
// v1.7 - Offline queue durability. pushList / pushTask used to catch their
//        own errors, call queueOfflineOperation() internally, and return
//        normally. processOfflineQueue then saw no failure, treated every
//        item as succeeded, and either replaced PENDING_KEY with an empty
//        `failed` array or removed it entirely. A flush attempted while
//        still offline therefore wiped the whole queue. Both push handlers
//        now return a boolean: true on a successful round-trip, false on
//        any failure. The inner queueOfflineOperation() call is removed --
//        re-queueing is owned exclusively by processOfflineQueue, so a
//        failure is recorded exactly once and successful items are not
//        re-queued after being drained. processOfflineQueue now checks the
//        return value per item and keeps failing items in PENDING_KEY, so
//        the queue survives a failed flush and drains on the next attempt.
// v1.8 - Revert the v1.7 re-queue split. The v1.7 change removed the
//        queueOfflineOperation() call from both push handlers and left
//        processOfflineQueue to keep any items the handlers reported as
//        failed. In practice that made the failure path bookkeeping-only:
//        a live mutation that failed while offline never entered the queue
//        (no code path called queueOfflineOperation after the failure),
//        so an offline mutation was effectively lost until the tab was
//        refreshed and a full app restart re-dispatched it -- which the
//        store does not do. The end-to-end offline test exposed this:
//        PENDING_KEY was empty after an offline add. v1.8 restores the
//        original ownership: the push handlers' catch blocks call
//        queueOfflineOperation() and then return false, so a failure is
//        persisted to PENDING_KEY from the moment it happens.
//        processOfflineQueue is rewritten to abort on the first failure:
//        when a push returns false the handler has already re-queued that
//        item, so the flush loop stops immediately and leaves the rest of
//        the queue in localStorage. The "drained" branch only runs when
//        every item in the queue pushed cleanly. This closes both the
//        durability bug (queue not wiped on a failed flush) and the
//        write-back bug (queue never got the failed item in the first
//        place). queueOfflineOperation therefore stays reachable from
//        both the mutation listeners (via pushTask/pushList on failure)
//        and the flush path.
// =============================================================================
// === ADDED ===
// =============================================================================
// - Supabase client initialization.
// - Offline queue implementation (todolist.v1.pending).
// - Initial fetch logic for lists and tasks.
// - Mutation push handlers.
// - onAuthStateChange listener in initSync(): updates currentSession,
//   dispatches 'supabase-auth-changed' to the UI, and — on a signed-in
//   transition — drains the offline queue and fetches remote state.
// - window.sync.getClient() — accessor for the single initialized client
//   instance, so ui.js (and any future UI code) can call .auth.* on the
//   exact client whose onAuthStateChange is registered here.
// - 'sync-task-change' / 'sync-list-change' listeners in initSync(), each
//   forwarding the event's op + payload to pushTask() / pushList() when a
//   session is active. See v1.4 above for the store.js side.
// - Auto-migration branch in fetchRemoteState(): when the signed-in user
//   has zero lists in the cloud AND local state has at least one list,
//   upload every local list and its tasks, log "[Sync] Migration complete",
//   and return without hydrating (the cloud was empty, so nothing to pull).
// - Console logging in pushList / pushTask: prints "Sync: Pushing list" /
//   "Sync: Pushing task" with the full payload, so a single console read
//   shows exactly what the client attempted to insert.
// - Boolean return contract on pushList / pushTask: true = the push landed,
//   false = it failed (and has already been re-queued by the handler's own
//   catch block). See v1.8 above.
// - "Sync: Offline queue drained." console line on a full successful drain,
//   and "Sync: Flush aborted. <type> still failing." on the first failure.
//   Both are new in v1.8.
// =============================================================================
// === FIXES ===
// =============================================================================
// - Auth transitions were previously only sampled once at startup via
//   getSession(). A sign-in or sign-out performed through the new auth
//   modal never updated currentSession, never dispatched any UI event, and
//   never triggered a fetch. The new onAuthStateChange listener closes
//   that gap. The initial getSession() call is still kept for the
//   first-load case where no auth event fires.
// - The already-signed-in case now dispatches 'supabase-auth-changed'
//   immediately after the first fetch. Prior code fired nothing on load,
//   so a page reload with a persisted session showed the header button
//   as "Sign in to sync" until some later auth event happened. The UI
//   therefore misreported the signed-in state on every reload.
// - ui.js was building its own createClient() for every auth action. The
//   events those clients produced bypassed this module's onAuthStateChange
//   listener, so currentSession could go stale and the header button could
//   lag the real session. All auth calls now go through window.sync.getClient(),
//   i.e. through the one client this file already manages.
// - Local mutations never reached Supabase. store.js saved to localStorage
//   and stopped; nothing told this module a change had happened, so the
//   cloud tables stayed empty for a signed-in user and a fresh sign-in with
//   local data never migrated. The 'sync-task-change' / 'sync-list-change'
//   listeners plus the auto-migration branch in fetchRemoteState() close
//   both gaps.
// - The 1.4 wiring paired with store.js's old broad broadcast, which looped
//   every list and every task on every save and produced hundreds of
//   redundant Supabase upserts per drag or keystroke. store.js v1.3 dispatches
//   only the specific changed item, and the two push handlers here now
//   consume that precise shape directly. One action -> one request.
// - Auto-migration silently skipped. The v1.5 branch tested `window.state`,
//   which is undefined here -- `state` is declared with a top-level `let`
//   and never promoted to `window`. So on a fresh sign-in with local data
//   and an empty cloud, the branch short-circuited and no push happened.
//   v1.6 uses a `typeof state !== 'undefined' ? state : window.state`
//   fallback, which resolves correctly in both load patterns. The early
//   return also splits the migration and hydrate paths cleanly, so a
//   successful migration can no longer fall through to a no-op hydrate.
// - pushList sent `created_at: undefined` for every list. Lists in this
//   codebase carry only { id, name, tasks }, so neither `createdAt` nor
//   `created_at` exists on the object, and the v1.5 payload builder set
//   the column to `undefined` -- which Postgres rejects on a NOT NULL
//   created_at. v1.6 adds `list.createdAt || list.created_at || Date.now()`,
//   so an insert always carries a real timestamp.
// - Push payloads were invisible in the console. A failed upsert looked
//   identical to a successful one from a console read alone. Both handlers
//   now log "Sync: Pushing list" / "Sync: Pushing task" with the full
//   payload, so a single screenshot is enough to confirm whether the
//   client sent the right columns and values.
// - Offline queue drained to empty on a failed flush. The v1.6 pushList /
//   pushTask catch blocks called queueOfflineOperation() and then returned
//   normally; processOfflineQueue's own try/catch therefore saw no error,
//   counted the item as succeeded, and either overwrote PENDING_KEY with
//   an empty `failed` array or removed it entirely. Every queue item was
//   lost on the first flush attempt if the network was still down. The
//   push handlers now return a boolean (true = landed, false = didn't),
//   and processOfflineQueue keeps the failed items in PENDING_KEY. The
//   inner re-queue is removed so a failure is recorded exactly once.
//   See v1.8 for the correction: the inner re-queue came back, and the
//   flush loop now aborts on the first failure instead of writing a
//   trimmed `failed` array over PENDING_KEY.
// - An offline mutation was lost, not queued. The v1.7 split removed the
//   queueOfflineOperation() call from both push handlers and left the
//   re-queue responsibility on processOfflineQueue. But processOfflineQueue
//   only runs on a flush attempt (sign-in or explicit call), not on a
//   live mutation, so a mutation that failed while offline never entered
//   PENDING_KEY at all. The end-to-end offline test showed PENDING_KEY
//   empty after an offline add. v1.8 restores the catch-block re-queue, so
//   a failed live push is durably recorded the moment it happens; and
//   processOfflineQueue is rewritten to abort on the first failure (the
//   push handler has already re-queued that item), so the flush loop
//   cannot overwrite or remove the rest of the queue after a partial
//   success.
// =============================================================================

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const PENDING_KEY = 'todolist.v1.pending';

// --- Auth State ---
let currentSession = null;

async function initSync() {
    try {
        // Listen for auth changes (login, logout, token refresh)
        supabaseClient.auth.onAuthStateChange((_event, session) => {
            currentSession = session;
            
            // Tell the UI to update the button
            window.dispatchEvent(new CustomEvent('supabase-auth-changed', { detail: { session } }));
            
            if (session) {
                processOfflineQueue();
                fetchRemoteState();
            }
        });

        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        currentSession = data.session;
        
        if (currentSession) {
            console.log("Sync: User is signed in.");
            await processOfflineQueue();
            await fetchRemoteState();
            // Fire event immediately on load so the UI updates
            window.dispatchEvent(new CustomEvent('supabase-auth-changed', { detail: { session: currentSession } }));
        } else {
            console.log("Sync: User is signed out. Local only.");
        }

        // Listen for local changes to push to Supabase
        window.addEventListener('sync-task-change', async (e) => {
            const { op, task } = e.detail;
            if (currentSession) await pushTask(op, task);
        });
        window.addEventListener('sync-list-change', async (e) => {
            const { op, list } = e.detail;
            if (currentSession) await pushList(op, list);
        });
    } catch (err) {
        console.warn("Sync: Failed to initialize.", err);
    }
}

// --- Fetching ---
async function fetchRemoteState() {
    if (!currentSession) return;

    try {
        const userId = currentSession.user.id;
        
        const { data: lists, error: listsErr } = await supabaseClient
            .from('lists')
            .select('*')
            .eq('user_id', userId);

        if (listsErr) throw listsErr;

        const { data: tasks, error: tasksErr } = await supabaseClient
            .from('tasks')
            .select('*')
            .eq('user_id', userId);

        if (tasksErr) throw tasksErr;

        // Auto-migrate: If cloud is empty, upload local data
        if (lists.length === 0) {
            // Safely check for the global state object
            const localState = typeof state !== 'undefined' ? state : window.state;
            
            if (localState && Object.keys(localState.lists).length > 0) {
                console.log("Sync: Cloud is empty. Migrating local data...");
                for (const listId in localState.lists) {
                    const list = localState.lists[listId];
                    await pushList('insert', list);
                    for (const task of list.tasks) {
                        await pushTask('insert', { ...task, listId: list.id });
                    }
                }
                console.log("Sync: Migration complete.");
            }
            return; // Don't hydrate if we just migrated
        }

        // If cloud has data, hydrate the local store
        if (window.store && window.store.hydrateFromRemote) {
            window.store.hydrateFromRemote(lists, tasks);
        }
    } catch (err) {
        console.warn("Sync: Failed to fetch remote state.", err);
    }
}

// --- Pushing Mutations ---
async function pushList(operation, list) {
    if (!currentSession) return false;
    const userId = currentSession.user.id;
    
    try {
        if (operation === 'insert' || operation === 'update') {
            const payload = { 
                id: list.id, 
                user_id: userId, 
                name: list.name, 
                created_at: list.createdAt || list.created_at || Date.now() 
            };
            console.log("Sync: Pushing list", payload);
            const { error } = await supabaseClient.from('lists').upsert(payload);
            if (error) throw error;
        } else if (operation === 'delete') {
            const { error } = await supabaseClient.from('lists').delete().eq('id', list.id).eq('user_id', userId);
            if (error) throw error;
        }
        return true;
    } catch (err) {
        console.warn(`Sync: Failed to push list ${operation}. Queuing.`, err);
        queueOfflineOperation(operation, 'list', list);
        return false;
    }
}

async function pushTask(operation, task) {
    if (!currentSession) return false;
    const userId = currentSession.user.id;
    
    try {
        if (operation === 'insert' || operation === 'update') {
            const payload = {
                id: task.id,
                user_id: userId,
                list_id: task.listId || task.list_id,
                text: task.text,
                done: task.done,
                section: task.section,
                parent_id: task.parentId || task.parent_id || null,
                created_at: task.createdAt || task.created_at || Date.now()
            };
            console.log("Sync: Pushing task", payload);
            const { error } = await supabaseClient.from('tasks').upsert(payload);
            if (error) throw error;
        } else if (operation === 'delete') {
            const { error } = await supabaseClient.from('tasks').delete().eq('id', task.id).eq('user_id', userId);
            if (error) throw error;
        }
        return true;
    } catch (err) {
        console.warn(`Sync: Failed to push task ${operation}. Queuing.`, err);
        queueOfflineOperation(operation, 'task', task);
        return false;
    }
}

// --- Offline Queue ---
function queueOfflineOperation(op, type, data) {
    let queue = [];
    try {
        const stored = localStorage.getItem(PENDING_KEY);
        if (stored) queue = JSON.parse(stored);
    } catch (e) {}

    // Simple append. Ideally we'd deduplicate, but for last-write-wins it's fine.
    queue.push({ op, type, data, timestamp: Date.now() });
    localStorage.setItem(PENDING_KEY, JSON.stringify(queue));
}

async function processOfflineQueue() {
    let queue = [];
    try {
        const stored = localStorage.getItem(PENDING_KEY);
        if (stored) queue = JSON.parse(stored);
    } catch (e) { return; }

    if (queue.length === 0) return;
    console.log(`Sync: Processing offline queue (${queue.length} items)...`);

    for (const item of queue) {
        let ok = false;
        if (item.type === 'list') {
            ok = await pushList(item.op, item.data);
        } else if (item.type === 'task') {
            ok = await pushTask(item.op, item.data);
        }
        
        // If a push fails, the push handler has already re-queued it.
        // We stop here and leave the queue in localStorage as-is so we
        // don't duplicate entries or wipe out the remaining items.
        if (!ok) {
            console.log(`Sync: Flush aborted. ${item.type} still failing.`);
            return;
        }
    }

    console.log(`Sync: Offline queue drained.`);
    localStorage.removeItem(PENDING_KEY);
}

// Expose sync API globally
window.sync = {
    init: initSync,
    pushList,
    pushTask,
    getSession: () => currentSession,
    getClient: () => supabaseClient
};
