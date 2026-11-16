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
//       sync-list-change.
//
// 1.4 — Two-layer undo history. Added HISTORY_KEY ('todolist.v1.history')
//       with a cap of HISTORY_MAX (20) entries. recordHistory(entry) is
//       called from each mutation function just before the state change
//       lands, storing the inverse operation so the UI can revert that
//       one action. undoLast() pops and applies the most recent entry;
//       undoHistoryEntry(id) applies and removes one specific entry by
//       id (used by the recent-changes list's per-row Undo). Both go
//       through the existing store mutations so the undo syncs like any
//       other change.
//
// 1.5 — History dispatch + list scoping + dead-entry pruning + redo.
//       1) recordHistory() dispatches 'history-recorded' after saving.
//       2) Every undoAction carries a listId; applyUndoAction() reads
//          that listId and applies the change to that list, not to
//          state.activeListId.
//       3) If the target task or list no longer exists, the entry is
//          dropped instead of left stuck.
//       4) hydrateFromRemote() clears the history when it replaces the
//          loaded data set.
//       5) Every entry carries a redoAction; undoing pushes the entry
//          onto a separate redo stack, redoLast() pops and re-applies it.
//
// 1.6 — Sequential undo from newest to target. undoHistoryEntry(id) now
//       unwinds from the newest entry down to and including the target,
//       newest-first, one at a time. The round-2 same-task prune rule is
//       removed — the unwind replaces it, so undoing entry N only drops
//       the entries it actually unwound. Dead entries inside the unwind
//       are skipped (removed) and the unwind continues, so one dead
//       target does not abort the chain. Undone entries are pushed onto
//       the redo stack in unwind order, so Redo re-applies them oldest-
//       first, one per tap. undoLast() still undoes exactly the newest
//       one entry (snackbar / header ↩ / Ctrl+Z unchanged).
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted the state and data-layer logic from the original app.js.
// - `reorderTask()` — data-layer half of drag-to-reorder.
// - `reparentTask()` — data-layer half of cross-list drag.
// - `hydrateFromRemote(remoteLists, remoteTasks)` — load-time hydration path
//   for signed-in users. Clears history and redo on successful replace.
// - Precise mutation dispatches for every store mutation. See v1.3.
// - HISTORY_KEY constant, HISTORY_MAX cap, lazily-loaded history array,
//   loadHistory() / saveHistory() / recordHistory(), undoLast(),
//   undoHistoryEntry(id), and the redo stack + redoLast() / clearRedo().
//   Every mutation function records the inverse operation (and its
//   forward twin) before applying its state change. Exposed on
//   window.store alongside hydrateFromRemote.
// - recordHistory() dispatches 'history-recorded' after save. See v1.5.
// - Sequential unwind in undoHistoryEntry(id): finds the target, then
//   pops newest-first through history until (and including) the target,
//   applying each entry's undoAction to its recorded list, skipping dead
//   entries (removing them), and pushing each successfully undone entry
//   onto the redo stack in unwind order. See v1.6.
//
// ================================================================================================
//
// === FIXES ===
//
// - `bootstrapFreshState()` now seeds the default list with the onboarding demo.
// - Local mutations (add, rename, delete, reorder, toggle, edit) were saved
//   to localStorage and stopped there — sync.js never learned about them,
//   so the cloud stayed empty for a signed-in user. The saveState()
//   broadcast closes that gap.
// - The 1.2 broadcast inside saveState() spammed Supabase. saveState() is
//   back to a plain localStorage write; each mutation function now emits
//   only its own change.
// - The undo snackbar never appeared (recordHistory() did not dispatch
//   'history-recorded'). Fixed in v1.5.
// - History entries were not scoped to a list. Entries now carry listId;
//   applyUndoAction() applies to the recorded list. Fixed in v1.5.
// - Dead entries never went away. The apply path returns false and the
//   entry is dropped. Fixed in v1.5.
// - History carried stale entries across a data replacement.
//   hydrateFromRemote() now clears history. Fixed in v1.5.
// - The round-2 same-task prune rule dropped later same-task entries
//   from a single undo in ways that did not match user expectation. The
//   round-3 sequential unwind replaces it: tapping Undo on entry N
//   undoes entries newer than N plus N itself, newest-first. Nothing
//   else vanishes. Fixed in v1.6.
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

  const demoTasks = [
    { createdAt: 1761000000001, done: false, id: "demo-001", parentId: null, section: "urgent", text: "👋 Welcome! Tap the circle to complete a task." },
    { createdAt: 1761000000002, done: false, id: "demo-001a", parentId: "demo-001", section: "urgent", text: "Swipe/drag the ⋮⋮ handle to reorder." },
    { createdAt: 1761000000003, done: false, id: "demo-001b", parentId: "demo-001", section: "urgent", text: "Tap the ⋯ menu to move or edit." },

    { createdAt: 1761000000004, done: false, id: "demo-002", parentId: null, section: "urgent", text: "Check out the different themes" },
    { createdAt: 1761000000005, done: false, id: "demo-002a", parentId: "demo-002", section: "urgent", text: "(Use the dropdown at the top right)" },

    { createdAt: 1761000000006, done: false, id: "demo-003", parentId: null, section: "urgent", text: "Create a new list" },
    { createdAt: 1761000000007, done: false, id: "demo-003a", parentId: "demo-003", section: "urgent", text: "(Use the + icon next to the list name)" },

    { createdAt: 1761000000008, done: false, id: "demo-004", parentId: null, section: "urgent", text: "Try the paste box at the bottom" },

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

   Sequential undo (LIFO): undoHistoryEntry(id) finds the target in the history and
   unwinds from the newest entry down to and including the target, newest-first,
   one at a time. Each successfully undone entry is pushed onto the redo stack, so
   Redo re-applies them oldest-first, one per tap. undoLast() (snackbar / header ↩ /
   Ctrl+Z) still undoes exactly the newest one entry.

   Dead-entry handling: if an entry's target task or list is gone, the entry is
   removed from the history and the unwind continues — one dead entry does not abort
   the chain.

   Redo stack: separate in-memory stack (not persisted). Cleared on any new recorded
   action, on hydrateFromRemote(), and on clearHistory().
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

  window.dispatchEvent(new CustomEvent('history-recorded', { detail: { summary: item.summary, id: item.id } }));

  // Any new recorded action invalidates the redo stack.
  _redoStack = [];

  return item;
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

/**
 * Sequential unwind: undo the given target entry AND every entry newer than it,
 * newest-first. Each successfully undone entry is pushed onto the redo stack
 * (in that newest-first unwind order), so a subsequent Redo re-applies them
 * oldest-first, one per tap.
 *
 * A dead entry (target task or list gone) is removed and skipped; the unwind
 * continues through the rest of the chain.
 *
 * Returns true if at least one entry was undone (or removed as dead), false
 * if the target was not found.
 */
function undoHistoryEntry(id) {
  const list = loadHistory();
  const targetIdx = list.findIndex((e) => e.id === id);
  if (targetIdx === -1) return false;

  // Entries to unwind, newest-first. `list.slice(targetIdx)` is oldest-first
  // starting at the target; reversing gives newest-first including the target.
  const chain = list.slice(targetIdx).reverse();

  const undoneEntries = []; // in unwind order (newest-first)
  const deadIds = new Set();

  for (const entry of chain) {
    const ok = applyUndoAction(entry.undoAction);
    if (ok) {
      undoneEntries.push(entry);
    } else {
      // Dead target (task / list gone). Drop it from history; do not abort.
      deadIds.add(entry.id);
    }
  }

  // Rewrite history: keep entries strictly older than the target, minus any
  // that were already removed as dead in the unwind.
  const remaining = list.slice(0, targetIdx).filter((e) => !deadIds.has(e.id));

  // Push undone entries onto the redo stack in reverse-unwind order so that
  // popping the redo stack yields oldest-first (i.e. re-application order).
  // undoneEntries is newest-first; reversed is oldest-first. push() appends
  // to the end, so pushing oldest-first and then popping from the end gives
  // oldest-first re-application — wait: that would yield newest-last-popped.
  // To get oldest-first re-application on successive redoLast() calls, push
  // the LIFO order onto the stack: redoLast() pops from the end, so the item
  // pushed last is popped first. The first thing we want to pop is the
  // OLDEST undone entry. So push newest-first (which leaves the oldest at
  // the end of the array → popped first).
  for (const e of undoneEntries) {
    _redoStack.push(e);
  }

  _history = remaining;
  saveHistory();

  return undoneEntries.length > 0 || deadIds.size > 0;
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

window.store = window.store || {};
window.store.hydrateFromRemote = hydrateFromRemote;
window.store.undoLast = undoLast;
window.store.undoHistoryEntry = undoHistoryEntry;
window.store.redoLast = redoLast;
window.store.clearRedo = clearRedo;
window.store.loadHistory = loadHistory;
window.store.clearHistory = clearHistory;
window.store.recordHistory = recordHistory;
