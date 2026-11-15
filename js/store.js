// Store Version 1.0
//
// ================================================================================================
//
// State management, list management, task operations, and persistence for the Online To Do List.
//
// This file owns the `state` object and all the functions that mutate it. It handles:
//   - Loading from and saving to localStorage (with schema migration from v1 to v2).
//   - Sanitizing incoming task data to ensure it matches the expected schema.
//   - Creating, deleting, renaming, and switching between named lists.
//   - Adding, removing, moving, editing, and reordering tasks and subtasks.
//   - Building the derived render tree (numbering is computed at render time, never stored).
//   - Recording undoable actions in a capped history list and exposing undo APIs.
//   - Recording the forward action alongside the undo action for redo support.
//
// It assumes `config.js` has been loaded and its constants are available globally.
//
// ================================================================================================
//
// === REVISIONS ===
//
// 1.1 — Supabase Stage 3. Added hydrateFromRemote() so js/sync.js can replace
//       the local state with cloud data after a successful load-time fetch.
//       The function is exposed at window.store.hydrateFromRemote so the sync
//       module can call it. Cloud-empty is a no-op — local state is left
//       intact for the upcoming migration dialog to handle.
//
// 1.2 — Supabase Stage 3, mutation broadcast. saveState() now dispatches
//       'sync-list-change' and 'sync-task-change' CustomEvents on every
//       call, so js/sync.js can catch every local mutation (add, rename,
//       delete, reorder, toggle, edit) and push it to Supabase. The
//       broadcast is a lightweight fan-out (one list event, one task event
//       per task in each list), deliberately broad so no mutation path can
//       be missed; batching is deferred until mutation sync is confirmed
//       working end-to-end.
//
// 1.3 — Precise mutation broadcast. The 1.2 broad loop inside saveState()
//       fanned out every list and every task on every save, so a single
//       drag or keystroke produced hundreds of Supabase update requests
//       (observed as a delayed console and a burst of CORS-blocked
//       requests on Vercel preview). saveState() is reverted to its
//       original local-storage-only form, and each mutation function now
//       dispatches only its own change: addTask/removeTask/toggleDone/
//       updateText/moveTask/reorderTask emit sync-task-change (insert,
//       delete, or update as appropriate), and createList/deleteList emit
//       sync-list-change. Rename still emits per-list through updateText
//       on the list object's tasks only; renames of list names go through
//       handleListRename in ui.js calling saveState without a broadcast,
//       to be wired in a follow-up if needed.
//
// 1.4 — Two-layer undo history. Added HISTORY_KEY ('todolist.v1.history')
//       with a cap of HISTORY_MAX (20) entries. recordHistory(entry) is
//       called from each mutation function just before the state change
//       lands, storing the inverse operation so the UI can revert that
//       one action. undoLast() pops and applies the most recent entry;
//       undoHistoryEntry(id) applies and removes one specific entry by
//       id (used by the recent-changes list's per-row Undo). Both go
//       through the existing store mutations so the undo syncs like any
//       other change. addTask gained a historyOpts argument so bulk adds
//       (paste, import) can suppress history recording — they opt in
//       per call. loadHistory() / saveHistory() persist the list; a
//       corrupt parse falls back to an empty list rather than crashing.
//       Delete-list undo is explicitly out of scope (the dialog keeps
//       its "This cannot be undone." text).
//
// 1.5 — History dispatch + list scoping + dead-entry pruning + redo.
//       1) recordHistory() now dispatches 'history-recorded' after
//          saving, so the snackbar in ui.js fires on every recorded
//          action (Item 1 — the snackbar was never appearing because
//          the event was never sent).
//       2) Every undoAction carries a listId. applyUndoAction() reads
//          that listId and applies the change to that list, not to
//          state.activeListId, so undoing a List A action while List B
//          is active does not touch List B (Item 2 rule 1).
//       3) If the target task or list no longer exists, the entry is
//          dropped instead of left stuck (Item 2 rule 3). Undoing an
//          entry also removes later entries for the SAME task (Item 2
//          rule 4) — later entries for other tasks stay.
//       4) hydrateFromRemote() clears the history when it replaces the
//          loaded data set (Item 2 rule 2), so a fresh sign-in starts
//          with an empty history.
//       5) Every entry carries a redoAction. undoing pushes the entry
//          onto a separate redo stack; redoLast() pops and re-applies
//          it (Item 5). The redo stack is cleared on any new recorded
//          action and on hydrateFromRemote().
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted the state and data-layer logic from the original app.js.
// - `reorderTask()` — data-layer half of drag-to-reorder. Reorders siblings within the same
//   section and parent by reassigning `createdAt` timestamps, so the existing sort-by-`createdAt`
//   render path needs no changes.
// - `reparentTask()` — data-layer half of cross-list drag. Updates a task's `parentId` and
//   `section`, so SortableJS's `onEnd` can move a subtask to a new parent or a top-level task to
//   a different section. A follow-up `reorderTask()` places it at the exact visual index; this
//   function only handles the parent/section change itself.
// - `hydrateFromRemote(remoteLists, remoteTasks)` — load-time hydration path for
//   signed-in users. Replaces state.lists with cloud data, keeps the current
//   activeListId when it still exists in the new set (otherwise picks the first
//   available), saves to localStorage, and re-renders. Exposed as
//   window.store.hydrateFromRemote for sync.js to call. Cloud-empty is a no-op.
//   Clears history and redo on successful replace (Item 2 rule 2, Item 5).
// - Mutation broadcast inside saveState(): dispatches 'sync-list-change' with
//   { op: 'update', list: { id, name, created_at } } once per list, and
//   'sync-task-change' with { op: 'update', task: { ...task, listId } } once
//   per task in each list. sync.js's initSync() listens for both events and
//   forwards to pushList() / pushTask().
// - Precise mutation dispatches: addTask emits { op: 'insert', task };
//   removeTask emits { op: 'delete', task: { id } } per removed id;
//   toggleDone / updateText / moveTask emit { op: 'update', task };
//   reorderTask emits { op: 'update', task } per reordered sibling;
//   createList emits { op: 'insert', list }; deleteList emits
//   { op: 'delete', list: { id } }.
// - HISTORY_KEY constant, HISTORY_MAX cap, and a lazily-loaded history
//   array. loadHistory() parses from localStorage and falls back to []
//   on a corrupt parse; saveHistory() writes it back. recordHistory()
//   pushes a new entry (capped to HISTORY_MAX by trimming the oldest)
//   and persists. undoLast() pops and applies the newest entry;
//   undoHistoryEntry(id) applies and removes one specific entry. Every
//   mutation function calls recordHistory() before its state change.
//   addTask takes an optional historyOpts argument so bulk adds (paste,
//   import) can suppress recording. Exposed on window.store alongside
//   hydrateFromRemote.
// - recordHistory() dispatches 'history-recorded' after save. Payload is
//   { summary, id } and is what ui.js's snackbar and FAB history both
//   listen for. See v1.5.
// - redoStack (in-memory, not persisted — a reload is a fresh start).
//   undoLast() / undoHistoryEntry() push the undone entry onto it, and
//   redoLast() pops and re-applies. clearRedo() wipes it. Any new
//   recorded action, hydrateFromRemote(), or clearHistory() also clears
//   it. Exposed at window.store.redoLast and window.store.clearRedo.
// - Every entry now carries a listId on its undoAction and a
//   matching redoAction. applyUndoAction() reads the stored listId
//   instead of state.activeListId, and drops the entry if the task or
//   list no longer exists. Undoing also prunes later entries for the
//   same task. See v1.5.
//
// ================================================================================================
//
// === FIXES ===
//
// - `bootstrapFreshState()` now seeds the default list with the onboarding demo: a three-level
//   task tree (e.g. Business -> Marketing -> Reply to Sarah's email) that demonstrates unlimited
//   nesting depth, a fully-completed "Classes" branch to show how a done parent with done
//   subtasks renders, and a mix of done/undone states across the rest of the tree so the app's
//   completion styling is visible on first run. The list is named "Demo" instead of the previous
//   empty "My List" default.
// - Local mutations (add, rename, delete, reorder, toggle, edit) were saved to
//   localStorage and stopped there — sync.js never learned about them, so the
//   cloud stayed empty for a signed-in user. The saveState() broadcast closes
//   that gap: every mutation now fans out to sync-list-change and
//   sync-task-change events, which the sync engine consumes.
// - The 1.2 broadcast inside saveState() spammed Supabase. Every save (which
//   fires on every mutation, including every keystroke in a list name and
//   every drag tick) looped every list and every task and dispatched a
//   CustomEvent per item, so a single drag could produce hundreds of
//   upserts. saveState() is back to a plain localStorage write; each
//   mutation function now emits only its own change. One user action → one
//   Supabase request.
// - The undo snackbar never appeared. recordHistory() saved the entry and
//   returned, so no 'history-recorded' event was ever dispatched and the
//   snackbar in ui.js's wireUndo() waited for one that never came. The
//   History panel and Ctrl+Z both worked because they did not depend on
//   that event. recordHistory() now dispatches
//   'history-recorded' with { summary, id } after saving. See v1.5.
// - History entries were not scoped to a list. An undoAction carried only
//   { op, taskId }, so applyUndoAction() applied it to whatever list was
//   active when the user hit Undo — usually wrong after a sign-in swapped
//   the loaded set. Entries now carry listId, and applyUndoAction() reads
//   it directly. A List A action undone while List B is active is applied
//   to List A without switching the user's active list. See v1.5.
// - Dead entries never went away. If an entry's target task or list was
//   already gone (deleted by a later action, or wiped by a sign-in), the
//   undo failed silently and the entry stayed in the list forever. The
//   apply path now returns false in that case and the entry is dropped.
//   Undoing an entry also prunes later entries for the SAME task (they
//   were built on the change that just got reverted); later entries for
//   other tasks stay. See v1.5.
// - History carried stale entries across a data replacement. Signing in
//   loads a different list set, but the old history (recorded against
//   the pre-login lists) stayed in localStorage and kept referring to
//   data that was no longer there. hydrateFromRemote() now clears the
//   history (and the redo stack) when it replaces the loaded data. See
//   v1.5.
//
// ================================================================================================

/* ================================================================================================
   STATE
   ================================================================================================ */

let state = {
  version: STATE_VERSION,
  theme: DEFAULT_THEME,
  activeListId: '',
  lists: {},
};

/**
 * Transient UI state — not persisted.
 *   openMenuTaskId: id of the task whose ⋯ menu is open, or null. At most one at a time.
 */
let ui = {
  editingId: null,
  addingSubtaskTo: null,
  search: '',
  searchRaw: '',
  openMenuTaskId: null,
};


/* ================================================================================================
   ID GENERATION
   ================================================================================================ */

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}


/* ================================================================================================
   LIST HELPERS
   ================================================================================================ */

function activeList() {
  const list = state.lists[state.activeListId];
  if (!list) {
    throw new Error('No active list — state is inconsistent.');
  }
  return list;
}

function listNames() {
  return Object.values(state.lists).map((l) => l.name);
}

function uniqueListName(baseName) {
  const desired = String(baseName || '').trim() || 'List';
  if (!listNames().includes(desired)) return desired;
  let n = 2;
  while (listNames().includes(`${desired} (${n})`)) n += 1;
  return `${desired} (${n})`;
}

function createList(name) {
  const id = generateId();
  const list = { id, name: uniqueListName(name), tasks: [] };
  state.lists[id] = list;
  window.dispatchEvent(new CustomEvent('sync-list-change', { detail: { op: 'insert', list: { id: list.id, name: list.name, created_at: Date.now() } } }));
  return list;
}

function deleteList(listId) {
  if (Object.keys(state.lists).length <= 1) return false;
  delete state.lists[listId];
  window.dispatchEvent(new CustomEvent('sync-list-change', { detail: { op: 'delete', list: { id: listId } } }));
  if (state.activeListId === listId) {
    state.activeListId = Object.keys(state.lists)[0];
  }
  return true;
}

function setActiveList(listId) {
  if (!state.lists[listId]) return;
  state.activeListId = listId;
  ui.editingId = null;
  ui.addingSubtaskTo = null;
  ui.openMenuTaskId = null;
  saveState();
}


/* ================================================================================================
   PERSISTENCE
   ================================================================================================ */

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('Could not read localStorage; running without persistence.', err);
    bootstrapFreshState();
    return;
  }

  if (!raw) {
    bootstrapFreshState();
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('Saved state was not valid JSON; starting fresh.', err);
    bootstrapFreshState();
    return;
  }

  // ---- Migrate from v1 (single-list) to v2 (multi-list) --------------------------------------
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks) && !parsed.lists) {
    const migratedTasks = sanitizeTasks(parsed.tasks);
    const listId = generateId();
    state.lists = {
      [listId]: { id: listId, name: DEFAULT_LIST_NAME, tasks: migratedTasks },
    };
    state.activeListId = listId;
    state.theme = THEMES.includes(parsed.theme) ? parsed.theme : DEFAULT_THEME;
    saveState();
    return;
  }

  // ---- Normal v2 load -------------------------------------------------------------------------
  if (parsed && typeof parsed === 'object' && parsed.lists && typeof parsed.lists === 'object') {
    if (typeof parsed.theme === 'string' && THEMES.includes(parsed.theme)) {
      state.theme = parsed.theme;
    }

    const cleanLists = {};
    for (const [id, list] of Object.entries(parsed.lists)) {
      if (!list || typeof list !== 'object') continue;
      const listId = typeof list.id === 'string' && list.id ? list.id : id;
      const name = typeof list.name === 'string' && list.name.trim() ? list.name : 'List';
      cleanLists[listId] = {
        id: listId,
        name,
        tasks: sanitizeTasks(Array.isArray(list.tasks) ? list.tasks : []),
      };
    }

    if (Object.keys(cleanLists).length === 0) {
      bootstrapFreshState();
      return;
    }

    state.lists = cleanLists;

    if (typeof parsed.activeListId === 'string' && cleanLists[parsed.activeListId]) {
      state.activeListId = parsed.activeListId;
    } else {
      state.activeListId = Object.keys(cleanLists)[0];
    }
    return;
  }

  bootstrapFreshState();
}

function bootstrapFreshState() {
  const id = generateId();

  // Load the Demo list as the default starting state.
  const demoTasks = [
    // --- URGENT ---
    { createdAt: 1761000000001, done: false, id: "demo-001", parentId: null, section: "urgent", text: "👋 Welcome! Tap the circle to complete a task." },
    { createdAt: 1761000000002, done: false, id: "demo-001a", parentId: "demo-001", section: "urgent", text: "Swipe/drag the ⋮⋮ handle to reorder." },
    { createdAt: 1761000000003, done: false, id: "demo-001b", parentId: "demo-001", section: "urgent", text: "Tap the ⋯ menu to move or edit." },

    { createdAt: 1761000000004, done: false, id: "demo-002", parentId: null, section: "urgent", text: "Check out the different themes" },
    { createdAt: 1761000000005, done: false, id: "demo-002a", parentId: "demo-002", section: "urgent", text: "(Use the dropdown at the top right)" },

    { createdAt: 1761000000006, done: false, id: "demo-003", parentId: null, section: "urgent", text: "Create a new list" },
    { createdAt: 1761000000007, done: false, id: "demo-003a", parentId: "demo-003", section: "urgent", text: "(Use the + icon next to the list name)" },

    { createdAt: 1761000000008, done: false, id: "demo-004", parentId: null, section: "urgent", text: "Try the paste box at the bottom" },

    // --- TO DO ---
    { createdAt: 1761000000009, done: true, id: "demo-005", parentId: null, section: "todo", text: "Classes" },
    { createdAt: 1761000000010, done: true, id: "demo-005a", parentId: "demo-005", section: "todo", text: "Read Chapter 4" },
    { createdAt: 1761000000011, done: true, id: "demo-005b", parentId: "demo-005", section: "todo", text: "Finish coding assignment" },

    { createdAt: 1761000000012, done: false, id: "demo-006", parentId: null, section: "todo", text: "Chores" },
      { createdAt: 1761000000013, done: false, id: "demo-006a", parentId: "demo-006", section: "todo", text: "Buy groceries" },
        { createdAt: 1761000000014, done: true, id: "demo-006a1", parentId: "demo-006a", section: "todo", text: "Milk" },
        { createdAt: 1761000000015, done: true, id: "demo-006a2", parentId: "demo-006a", section: "todo", text: "Eggs" },
      { createdAt: 1761000000016, done: false, id: "demo-006b", parentId: "demo-006", section: "todo", text: "Housework" },
        { createdAt: 1761000000017, done: false, id: "demo-006b1", parentId: "demo-006b", section: "todo", text: "Do laundry" },
        { createdAt: 1761000000018, done: false, id: "demo-006b2", parentId: "demo-006b", section: "todo", text: "Clean the kitchen" },
      { createdAt: 1761000000019, done: false, id: "demo-006c", parentId: "demo-006", section: "todo", text: "Errands" },
        { createdAt: 1761000000020, done: false, id: "demo-006c1", parentId: "demo-006c", section: "todo", text: "Drop off packages" },

    { createdAt: 1761000000021, done: false, id: "demo-007", parentId: null, section: "todo", text: "Business" },
      { createdAt: 1761000000022, done: false, id: "demo-007a", parentId: "demo-007", section: "todo", text: "Marketing" },
        { createdAt: 1761000000023, done: true, id: "demo-007a1", parentId: "demo-007a", section: "todo", text: "Reply to Sarah's email" },
      { createdAt: 1761000000024, done: false, id: "demo-007b", parentId: "demo-007", section: "todo", text: "Finance" },
        { createdAt: 1761000000025, done: false, id: "demo-007b1", parentId: "demo-007b", section: "todo", text: "Draft Q3 budget" },
        { createdAt: 1761000000026, done: false, id: "demo-007b2", parentId: "demo-007b", section: "todo", text: "Schedule team sync" },

    // --- TO SORT ---
    { createdAt: 1761000000027, done: false, id: "demo-008", parentId: null, section: "sort", text: "Plan weekend trip" },
    { createdAt: 1761000000028, done: false, id: "demo-009", parentId: null, section: "sort", text: "Call mom" }
  ];

  state.lists = {
    [id]: { id, name: 'Demo', tasks: demoTasks },
  };
  state.activeListId = id;
}

function sanitizeTasks(source) {
  const cleaned = source
    .filter((t) => t && typeof t === 'object' && typeof t.text === 'string')
    .map((t) => ({
      id: typeof t.id === 'string' && t.id ? t.id : generateId(),
      text: t.text,
      done: Boolean(t.done),
      section: SECTIONS.includes(t.section) ? t.section : 'sort',
      parentId: typeof t.parentId === 'string' && t.parentId ? t.parentId : null,
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    }));

  const ids = new Set(cleaned.map((t) => t.id));
  return cleaned.filter((t) => t.parentId === null || ids.has(t.parentId));
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Could not write localStorage; changes will not persist.', err);
  }
}


/* ================================================================================================
   UNDO / REDO HISTORY
   ------------------------------------------------------------------------------------------------
   A capped list of the last HISTORY_MAX undoable actions, persisted in localStorage.
   Each entry is { id, kind, summary, listId, taskId, undoAction, redoAction } where
   undoAction is the inverse the UI applies to revert, and redoAction is the forward
   operation to re-apply it after an undo.

   List scoping: every action is recorded with the id of the list it happened in, and
   undo applies to that list — never to whichever list happens to be active when the
   user hits Undo.

   Dead-entry pruning: if the target task or list no longer exists, the entry is
   dropped rather than left stuck. Undoing an entry also prunes later entries for the
   SAME task (they were built on the change that was just reverted); later entries
   for other tasks stay.

   Redo stack: separate in-memory stack (not persisted — a reload is a fresh start).
   Every successful undo pushes the undone entry onto it; a new recorded action, a
   hydrateFromRemote() replace, or clearHistory() wipes it.

   Delete-LIST undo is out of scope for this batch — the delete-list dialog keeps its
   "This cannot be undone." text. Task-level delete IS covered.
   ================================================================================================ */

const HISTORY_KEY = 'todolist.v1.history';
const HISTORY_MAX = 20;

let _history = null;
let _redoStack = [];

function loadHistory() {
  if (_history !== null) return _history;
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) {
      _history = [];
      return _history;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      _history = [];
      return _history;
    }
    _history = parsed.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.kind === 'string');
    return _history;
  } catch (err) {
    console.warn('Could not read undo history; starting empty.', err);
    _history = [];
    return _history;
  }
}

function saveHistory() {
  if (_history === null) return;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(_history));
  } catch (err) {
    console.warn('Could not write undo history.', err);
  }
}

function recordHistory(entry) {
  const list = loadHistory();
  const item = {
    id: generateId(),
    kind: entry.kind || 'change',
    summary: entry.summary || '',
    listId: entry.listId || state.activeListId || null,
    taskId: entry.taskId || null,
    undoAction: entry.undoAction || null,
    redoAction: entry.redoAction || null,
    timestamp: Date.now(),
  };
  list.push(item);
  if (list.length > HISTORY_MAX) {
    list.splice(0, list.length - HISTORY_MAX);
  }
  _history = list;
  saveHistory();

  // Item 1: fire the event the snackbar / FAB history listen for. Without this,
  // both UI surfaces stay silent even though the entry was saved.
  window.dispatchEvent(new CustomEvent('history-recorded', { detail: { summary: item.summary, id: item.id } }));

  // Item 5: any new recorded action invalidates the redo stack.
  _redoStack = [];

  return item;
}

function pruneLaterEntriesForTask(taskId) {
  if (!taskId) return;
  const list = loadHistory();
  const filtered = list.filter((e) => e.taskId !== taskId);
  if (filtered.length === list.length) return;
  _history = filtered;
  saveHistory();
}

function applyUndoAction(action) {
  if (!action || typeof action !== 'object') return false;
  if (!action.listId) return false;
  const targetList = state.lists[action.listId];
  if (!targetList) return false;

  switch (action.op) {
    case 'restore-task': {
      if (!action.task) return false;
      if (targetList.tasks.some((t) => t.id === action.task.id)) return false;
      targetList.tasks.push({ ...action.task });
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'insert', task: { ...action.task, listId: action.listId } } }));
      saveState();
      return true;
    }
    case 'restore-many': {
      if (!Array.isArray(action.tasks)) return false;
      const existing = new Set(targetList.tasks.map((t) => t.id));
      let restored = false;
      for (const t of action.tasks) {
        if (existing.has(t.id)) continue;
        targetList.tasks.push({ ...t });
        window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'insert', task: { ...t, listId: action.listId } } }));
        restored = true;
      }
      if (restored) saveState();
      return restored;
    }
    case 'set-text': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return false;
      t.text = action.text;
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId: action.listId } } }));
      saveState();
      return true;
    }
    case 'set-done': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return false;
      t.done = Boolean(action.done);
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId: action.listId } } }));
      saveState();
      return true;
    }
    case 'set-move': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return false;
      t.section = action.section;
      t.parentId = action.parentId || null;
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId: action.listId } } }));
      saveState();
      return true;
    }
    case 'delete-task': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return false;
      removeTaskSilent(action.taskId, action.listId);
      return true;
    }
    case 'reorder': {
      if (!Array.isArray(action.siblings)) return false;
      let touched = false;
      for (const { id, createdAt } of action.siblings) {
        const t = targetList.tasks.find((x) => x.id === id);
        if (t) { t.createdAt = createdAt; touched = true; }
      }
      if (!touched) return false;
      for (const { id } of action.siblings) {
        const t = targetList.tasks.find((x) => x.id === id);
        if (!t) continue;
        window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId: action.listId } } }));
      }
      saveState();
      return true;
    }
    default:
      return false;
  }
}

function applyRedoAction(action) {
  if (!action || typeof action !== 'object') return false;
  return applyUndoAction(action);
}

function undoHistoryEntry(id) {
  const list = loadHistory();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const entry = list[idx];
  const ok = applyUndoAction(entry.undoAction);

  // Item 2 rule 3: dead entry — target is gone. Drop it rather than leaving it stuck.
  if (!ok) {
    list.splice(idx, 1);
    _history = list;
    saveHistory();
    return false;
  }

  // Item 2 rule 4: prune later entries for the SAME task.
  pruneLaterEntriesForTask(entry.taskId);

  // Item 5: the undone entry becomes the top of the redo stack.
  _redoStack.push(entry);

  // Remove the undone entry itself.
  const refreshed = loadHistory();
  const refreshedIdx = refreshed.findIndex((e) => e.id === id);
  if (refreshedIdx !== -1) {
    refreshed.splice(refreshedIdx, 1);
    _history = refreshed;
    saveHistory();
  }

  return true;
}

function undoLast() {
  const list = loadHistory();
  if (list.length === 0) return false;
  return undoHistoryEntry(list[list.length - 1].id);
}

function redoLast() {
  if (!_redoStack || _redoStack.length === 0) return false;
  const entry = _redoStack.pop();
  const ok = applyRedoAction(entry.redoAction);
  if (!ok) return false;
  // Re-record the entry so it can be undone again.
  const list = loadHistory();
  const redoItem = {
    id: generateId(),
    kind: entry.kind,
    summary: entry.summary,
    listId: entry.listId,
    taskId: entry.taskId,
    undoAction: entry.undoAction,
    redoAction: entry.redoAction,
    timestamp: Date.now(),
  };
  list.push(redoItem);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  _history = list;
  saveHistory();
  window.dispatchEvent(new CustomEvent('history-recorded', { detail: { summary: redoItem.summary, id: redoItem.id } }));
  return true;
}

function clearRedo() {
  _redoStack = [];
}

function clearHistory() {
  _history = [];
  saveHistory();
  clearRedo();
}


/* ================================================================================================
   TASK HELPERS
   ================================================================================================ */

function findTask(id) {
  return activeList().tasks.find((t) => t.id === id) || null;
}

function topLevelTasks(tasks, section) {
  return tasks
    .filter((t) => t.section === section && t.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function childrenOf(tasks, parentId) {
  return tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function buildRenderTree(tasks, section, counter) {
  const nodes = [];
  for (const task of topLevelTasks(tasks, section)) {
    const number = String(counter.value);
    counter.value += 1;
    nodes.push({ task, number, children: buildChildNodes(tasks, task.id, number) });
  }
  return nodes;
}

function buildChildNodes(tasks, parentId, parentNumber) {
  const nodes = [];
  const children = childrenOf(tasks, parentId);
  children.forEach((task, index) => {
    const number = `${parentNumber}.${index + 1}`;
    nodes.push({ task, number, children: buildChildNodes(tasks, task.id, number) });
  });
  return nodes;
}

/**
 * Add a task. `historyOpts.record` (default true) controls whether an undo entry is
 * recorded. Bulk adds (paste, import) pass `{ record: false }` so one bulk action doesn't
 * flood the history list. The "Add task" from quick-add / section + buttons leaves it on.
 */
function addTask(text, section, parentId, historyOpts) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  const task = {
    id: generateId(),
    text: trimmed,
    done: false,
    section: SECTIONS.includes(section) ? section : 'sort',
    parentId: parentId || null,
    createdAt: Date.now(),
  };

  const listId = state.activeListId;
  const record = !historyOpts || historyOpts.record !== false;
  if (record) {
    recordHistory({
      kind: 'add',
      summary: `Added "${trimmed}"`,
      listId,
      taskId: task.id,
      undoAction: { op: 'delete-task', listId, taskId: task.id },
      redoAction: { op: 'restore-task', listId, task: { ...task } },
    });
  }

  activeList().tasks.push(task);
  window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'insert', task: { ...task, listId: state.activeListId } } }));
  saveState();
  return task;
}

/**
 * Internal remove without recording history — used by the undo layer's own
 * `add` reversal so an undo does not generate a new history entry.
 */
function removeTaskSilent(id, listIdOverride) {
  const list = (listIdOverride && state.lists[listIdOverride]) || activeList();
  const toRemove = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of list.tasks) {
      if (t.parentId && toRemove.has(t.parentId) && !toRemove.has(t.id)) {
        toRemove.add(t.id);
        grew = true;
      }
    }
  }
  list.tasks = list.tasks.filter((t) => !toRemove.has(t.id));
  toRemove.forEach((rid) => {
    window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'delete', task: { id: rid } } }));
  });
  saveState();
}

function removeTask(id) {
  const list = activeList();
  const snapshot = list.tasks.find((t) => t.id === id);
  if (!snapshot) return;

  const toRemove = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of list.tasks) {
      if (t.parentId && toRemove.has(t.parentId) && !toRemove.has(t.id)) {
        toRemove.add(t.id);
        grew = true;
      }
    }
  }
  const removed = list.tasks.filter((t) => toRemove.has(t.id)).map((t) => ({ ...t }));
  const listId = state.activeListId;

  recordHistory({
    kind: 'delete',
    summary: `Deleted "${snapshot.text}"`,
    listId,
    taskId: id,
    undoAction: { op: 'restore-many', listId, tasks: removed },
    redoAction: { op: 'delete-task', listId, taskId: id },
  });

  list.tasks = list.tasks.filter((t) => !toRemove.has(t.id));
  toRemove.forEach((rid) => {
    window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'delete', task: { id: rid } } }));
  });
  saveState();
}

function toggleDone(id) {
  const task = findTask(id);
  if (!task) return;
  const previousDone = task.done;
  const listId = state.activeListId;
  recordHistory({
    kind: 'toggle',
    summary: `${previousDone ? 'Uncompleted' : 'Completed'} "${task.text}"`,
    listId,
    taskId: task.id,
    undoAction: { op: 'set-done', listId, taskId: task.id, done: previousDone },
    redoAction: { op: 'set-done', listId, taskId: task.id, done: !previousDone },
  });
  task.done = !task.done;
  window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...task, listId: state.activeListId } } }));
  saveState();
}

function updateText(id, text) {
  const task = findTask(id);
  if (!task) return;
  const trimmed = String(text).trim();
  if (!trimmed) return;
  if (trimmed === task.text) return;
  const previousText = task.text;
  const listId = state.activeListId;
  recordHistory({
    kind: 'edit',
    summary: `Edited "${previousText}"`,
    listId,
    taskId: task.id,
    undoAction: { op: 'set-text', listId, taskId: task.id, text: previousText },
    redoAction: { op: 'set-text', listId, taskId: task.id, text: trimmed },
  });
  task.text = trimmed;
  window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...task, listId: state.activeListId } } }));
  saveState();
}

function moveTask(id, section) {
  if (!SECTIONS.includes(section)) return;
  const task = findTask(id);
  if (!task) return;
  if (task.section === section) return;
  const previousSection = task.section;
  const previousParent = task.parentId;
  const listId = state.activeListId;
  recordHistory({
    kind: 'move',
    summary: `Moved "${task.text}" to ${section.toUpperCase()}`,
    listId,
    taskId: task.id,
    undoAction: { op: 'set-move', listId, taskId: task.id, section: previousSection, parentId: previousParent },
    redoAction: { op: 'set-move', listId, taskId: task.id, section, parentId: previousParent },
  });
  task.section = section;
  window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...task, listId: state.activeListId } } }));
  saveState();
}

/**
 * Reorder a task relative to a sibling in the same section and parent.
 *
 * `position` is 'before' or 'after'. Moving a task onto itself, or onto a task in a different
 * section or with a different parent, is a no-op (that is `moveTask`'s job, not this function's).
 *
 * The reorder is implemented by rewriting the `createdAt` timestamps of the affected tasks so
 * the existing sort-by-`createdAt` render path produces the desired order. The tasks' `id`s,
 * text, done state, section, and parentId are untouched. No schema change.
 *
 * Returns true if any task was reordered, false otherwise. Does not render — the caller is
 * responsible for calling render() after this returns true.
 */
function reorderTask(taskId, targetId, position) {
  if (taskId === targetId) return false;
  if (position !== 'before' && position !== 'after') return false;

  const list = activeList();
  const dragged = list.tasks.find((t) => t.id === taskId);
  const target = list.tasks.find((t) => t.id === targetId);
  if (!dragged || !target) return false;

  if (dragged.section !== target.section) return false;
  if (dragged.parentId !== target.parentId) return false;

  const siblings = list.tasks
    .filter((t) => t.section === dragged.section && t.parentId === dragged.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const withoutDragged = siblings.filter((t) => t.id !== dragged.id);
  const targetIndex = withoutDragged.findIndex((t) => t.id === target.id);
  if (targetIndex === -1) return false;

  const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
  withoutDragged.splice(insertAt, 0, dragged);

  const sameOrder = withoutDragged.every((t, i) => t.id === siblings[i].id);
  if (sameOrder) return false;

  const before = siblings.map((t) => ({ id: t.id, createdAt: t.createdAt }));
  const after = withoutDragged.map((t, i) => ({ id: t.id, createdAt: i + 1 }));

  withoutDragged.forEach((t, i) => {
    t.createdAt = i + 1;
  });

  const listId = state.activeListId;
  recordHistory({
    kind: 'reorder',
    summary: `Reordered "${dragged.text}"`,
    listId,
    taskId: dragged.id,
    undoAction: { op: 'reorder', listId, siblings: before },
    redoAction: { op: 'reorder', listId, siblings: after },
  });

  withoutDragged.forEach((t) => {
    window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId: state.activeListId } } }));
  });
  saveState();
  return true;
}

/**
 * Reparent a task to a new parent (or to the top level) and a new section.
 *
 * This is the data-layer half of a cross-list drag. After calling this, the caller should
 * immediately call `reorderTask()` to place the task at the exact visual index it was dropped.
 *
 * Returns true if the task was moved, false otherwise.
 */
function reparentTask(taskId, newParentId, newSection) {
  const task = findTask(taskId);
  if (!task) return false;
  if (!SECTIONS.includes(newSection)) return false;
  if (taskId === newParentId) return false;

  const previousParent = task.parentId;
  const previousSection = task.section;
  if (previousParent === (newParentId || null) && previousSection === newSection) return false;

  const listId = state.activeListId;
  recordHistory({
    kind: 'move',
    summary: `Moved "${task.text}"`,
    listId,
    taskId: task.id,
    undoAction: { op: 'set-move', listId, taskId: task.id, section: previousSection, parentId: previousParent },
    redoAction: { op: 'set-move', listId, taskId: task.id, section: newSection, parentId: newParentId || null },
  });

  task.parentId = newParentId || null;
  task.section = newSection;
  saveState();
  return true;
}


/* ================================================================================================
   SUPABASE SYNC BRIDGE
   ================================================================================================ */

/**
 * Replaces the local state with data fetched from the cloud.
 * Called by sync.js after a successful load-time fetch.
 *
 * Cloud-empty is a no-op on purpose: on a signed-in user's first run,
 * the cloud has nothing yet and the local state must not be wiped —
 * the upcoming migration dialog is what offers to upload local data.
 * Only a non-empty remote list set replaces the local state.
 *
 * Item 2 rule 2 / Item 5: when the loaded data set is replaced, the
 * history and the redo stack are cleared. A fresh sign-in starts with
 * an empty history and no redo state.
 *
 * @param {Array} remoteLists - Array of list objects from Supabase.
 * @param {Array} remoteTasks - Array of task objects from Supabase.
 */
function hydrateFromRemote(remoteLists, remoteTasks) {
  if (!remoteLists || remoteLists.length === 0) {
    return;
  }

  const newLists = {};

  remoteLists.forEach(list => {
    newLists[list.id] = {
      id: list.id,
      name: list.name,
      tasks: []
    };
  });

  remoteTasks.forEach(task => {
    if (newLists[task.list_id]) {
      newLists[task.list_id].tasks.push({
        id: task.id,
        text: task.text,
        done: task.done,
        section: task.section,
        parentId: task.parent_id,
        createdAt: Number(task.created_at)
      });
    }
  });

  let activeListId = state.activeListId;
  if (!newLists[activeListId]) {
    const listIds = Object.keys(newLists);
    activeListId = listIds.length > 0 ? listIds[0] : null;
  }

  state.lists = newLists;
  state.activeListId = activeListId;

  saveState();

  // Data set replaced — the old history refers to data that is no longer loaded.
  clearHistory();

  if (typeof render === 'function') {
    render();
  } else if (typeof renderApp === 'function') {
    renderApp();
  }
}

// Expose to the global window so sync.js can call it. The file has no window.store
// export block above (all functions are top-level and therefore already on window),
// but sync.js's load-time fetch calls window.store.hydrateFromRemote specifically,
// so this bridge is required.
window.store = window.store || {};
window.store.hydrateFromRemote = hydrateFromRemote;
window.store.undoLast = undoLast;
window.store.undoHistoryEntry = undoHistoryEntry;
window.store.redoLast = redoLast;
window.store.clearRedo = clearRedo;
window.store.loadHistory = loadHistory;
window.store.clearHistory = clearHistory;
window.store.recordHistory = recordHistory;
