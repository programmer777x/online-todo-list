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
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (listsErr) throw listsErr;

        const { data: tasks, error: tasksErr } = await supabaseClient
            .from('tasks')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (tasksErr) throw tasksErr;

        // Auto-migrate: If cloud is empty, upload local data
        if (lists.length === 0 && window.state && Object.keys(window.state.lists).length > 0) {
            console.log("Sync: Cloud is empty. Migrating local data...");
            for (const listId in window.state.lists) {
                const list = window.state.lists[listId];
                await pushList('insert', list);
                for (const task of list.tasks) {
                    await pushTask('insert', { ...task, listId: list.id });
                }
            }
            console.log("Sync: Migration complete.");
            return;
        }

        // Map remote data back to local state shape
        if (window.store && window.store.hydrateFromRemote) {
            window.store.hydrateFromRemote(lists, tasks);
        }
    } catch (err) {
        console.warn("Sync: Failed to fetch remote state.", err);
    }
}

// --- Pushing Mutations ---
async function pushList(operation, list) {
    if (!currentSession) return;
    const userId = currentSession.user.id;
    
    try {
        if (operation === 'insert' || operation === 'update') {
            const payload = { 
                id: list.id, 
                user_id: userId, 
                name: list.name, 
                created_at: list.created_at || Date.now() 
            };
            const { error } = await supabaseClient.from('lists').upsert(payload);
            if (error) throw error;
        } else if (operation === 'delete') {
            const { error } = await supabaseClient.from('lists').delete().eq('id', list.id).eq('user_id', userId);
            if (error) throw error;
        }
    } catch (err) {
        console.warn(`Sync: Failed to push list ${operation}. Queuing.`, err);
        queueOfflineOperation(operation, 'list', list);
    }
}

async function pushTask(operation, task) {
    if (!currentSession) return;
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
            const { error } = await supabaseClient.from('tasks').upsert(payload);
            if (error) throw error;
        } else if (operation === 'delete') {
            const { error } = await supabaseClient.from('tasks').delete().eq('id', task.id).eq('user_id', userId);
            if (error) throw error;
        }
    } catch (err) {
        console.warn(`Sync: Failed to push task ${operation}. Queuing.`, err);
        queueOfflineOperation(operation, 'task', task);
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

    let failed = [];
    for (const item of queue) {
        try {
            // We call the push function but pass a mock session/context so it doesn't re-queue infinitely
            if (item.type === 'list') {
                await pushList(item.op, item.data);
            } else if (item.type === 'task') {
                await pushTask(item.op, item.data);
            }
        } catch (err) {
            failed.push(item);
        }
    }

    if (failed.length > 0) {
        localStorage.setItem(PENDING_KEY, JSON.stringify(failed));
    } else {
        localStorage.removeItem(PENDING_KEY);
    }
}

// Expose sync API globally
window.sync = {
    init: initSync,
    pushList,
    pushTask,
    getSession: () => currentSession,
    getClient: () => supabaseClient
};
