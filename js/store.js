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
// 1.1 through 1.6 — prior rounds. History recording, list scoping,
//       sequential unwind, redo stack.
// 1.7 — Round 4: silent sequential-undo wipe fix.
// 1.8 — Round 7 Item 2: history survives window/app switches.
//       hydrateFromRemote() no longer clears history unconditionally;
//       it compares the incoming list-ID set and task counts to the
//       current local state and only clears when they differ. This
//       stops the focus-driven TOKEN_REFRESHED → syncNow() →
//       fetchRemoteState() → hydrateFromRemote() chain from wiping
//       history on every window switch.
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted state and data-layer logic from app.js.
// - All prior additions carried forward unchanged.
// - datasetsEqual(localLists, remoteLists, remoteTasks) helper used by
//   hydrateFromRemote() to decide whether the incoming data set is
//   actually different. See v1.8.
//
// ================================================================================================
//
// === FIXES ===
//
// - Prior rounds' fixes carried forward unchanged.
// - Switching to another window or app and back wiped the undo history
//   because hydrateFromRemote() unconditionally cleared it. That path
//   is reached on every focus-driven TOKEN_REFRESHED event via
//   sync.js → syncNow() → fetchRemoteState(). hydrateFromRemote()
//   now compares the incoming set (list IDs + task counts) to the
//   current local state and only clears when they differ. Sign-in and
//   sign-out still clear (data sets differ); a plain focus refresh
//   does not. See v1.8.
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

  _redoStack = [];

  return item;
}

function applyUndoActionDetailed(action, fallbackListId) {
  if (!action || typeof action !== 'object') {
    return { applied: false, reason: 'no-target' };
  }
  const listId = action.listId || fallbackListId || state.activeListId;
  if (!listId) {
    return { applied: false, reason: 'no-list' };
  }
  const targetList = state.lists[listId];
  if (!targetList) {
    return { applied: false, reason: 'no-list' };
  }

  switch (action.op) {
    case 'restore-task': {
      if (!action.task) return { applied: false, reason: 'no-target' };
      if (targetList.tasks.some((t) => t.id === action.task.id)) {
        return { applied: false, reason: 'no-op' };
      }
      targetList.tasks.push({ ...action.task });
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'insert', task: { ...action.task, listId } } }));
      saveState();
      return { applied: true, reason: 'ok' };
    }
    case 'restore-many': {
      if (!Array.isArray(action.tasks)) return { applied: false, reason: 'no-target' };
      const existing = new Set(targetList.tasks.map((t) => t.id));
      let restored = false;
      for (const t of action.tasks) {
        if (existing.has(t.id)) continue;
        targetList.tasks.push({ ...t });
        window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'insert', task: { ...t, listId } } }));
        restored = true;
      }
      if (restored) saveState();
      return restored
        ? { applied: true, reason: 'ok' }
        : { applied: false, reason: 'no-op' };
    }
    case 'set-text': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return { applied: false, reason: 'no-target' };
      if (t.text === action.text) return { applied: false, reason: 'no-op' };
      t.text = action.text;
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId } } }));
      saveState();
      return { applied: true, reason: 'ok' };
    }
    case 'set-done': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return { applied: false, reason: 'no-target' };
      if (t.done === Boolean(action.done)) return { applied: false, reason: 'no-op' };
      t.done = Boolean(action.done);
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId } } }));
      saveState();
      return { applied: true, reason: 'ok' };
    }
    case 'set-move': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return { applied: false, reason: 'no-target' };
      t.section = action.section;
      t.parentId = action.parentId || null;
      window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId } } }));
      saveState();
      return { applied: true, reason: 'ok' };
    }
    case 'delete-task': {
      const t = targetList.tasks.find((x) => x.id === action.taskId);
      if (!t) return { applied: false, reason: 'no-target' };
      removeTaskSilent(action.taskId, listId);
      return { applied: true, reason: 'ok' };
    }
    case 'reorder': {
      if (!Array.isArray(action.siblings)) return { applied: false, reason: 'no-target' };
      let touched = false;
      for (const { id, createdAt } of action.siblings) {
        const t = targetList.tasks.find((x) => x.id === id);
        if (t && t.createdAt !== createdAt) { t.createdAt = createdAt; touched = true; }
      }
      if (!touched) return { applied: false, reason: 'no-op' };
      for (const { id } of action.siblings) {
        const t = targetList.tasks.find((x) => x.id === id);
        if (!t) continue;
        window.dispatchEvent(new CustomEvent('sync-task-change', { detail: { op: 'update', task: { ...t, listId } } }));
      }
      saveState();
      return { applied: true, reason: 'ok' };
    }
    default:
      return { applied: false, reason: 'no-target' };
  }
}

function applyUndoAction(action, fallbackListId) {
  return applyUndoActionDetailed(action, fallbackListId).applied;
}

function applyRedoAction(action, fallbackListId) {
  return applyUndoActionDetailed(action, fallbackListId).applied;
}

function undoHistoryEntry(id) {
  const list = loadHistory();
  const targetIdx = list.findIndex((e) => e.id === id);
  if (targetIdx === -1) {
    return { ok: false, undone: [], failed: [], dropped: [] };
  }

  const chain = list.slice(targetIdx).reverse();

  const undoneEntries = [];
  const failedEntries = [];
  const deadIds = new Set();
  const droppedEntries = [];

  for (const entry of chain) {
    const result = applyUndoActionDetailed(entry.undoAction, entry.listId);
    if (result.applied) {
      undoneEntries.push(entry);
    } else if (result.reason === 'no-target' || result.reason === 'no-list') {
      deadIds.add(entry.id);
      droppedEntries.push(entry);
    } else {
      failedEntries.push(entry);
    }
  }

  const remaining = list.slice(0, targetIdx).filter((e) => !deadIds.has(e.id));

  for (const e of undoneEntries) {
    _redoStack.push(e);
  }

  _history = remaining;
  saveHistory();

  if (failedEntries.length > 0) {
    console.warn('Sync: Some history entries could not be undone.',
      failedEntries.map((e) => `${e.kind} ${e.summary} (${e.id})`));
    window.dispatchEvent(new CustomEvent('history-undo-failed', {
      detail: {
        failedCount: failedEntries.length,
        undoneCount: undoneEntries.length,
        droppedCount: droppedEntries.length,
      },
    }));
  }

  return {
    ok: undoneEntries.length > 0,
    undone: undoneEntries,
    failed: failedEntries,
    dropped: droppedEntries,
  };
}

function undoLast() {
  const list = loadHistory();
  if (list.length === 0) return false;
  const result = undoHistoryEntry(list[list.length - 1].id);
  return result.ok;
}

function redoLast() {
  if (!_redoStack || _redoStack.length === 0) return false;
  const entry = _redoStack.pop();
  const ok = applyRedoAction(entry.redoAction, entry.listId);
  if (!ok) return false;
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

/**
 * Compare the incoming remote data set to the current local state.
 * Returns true if they look equivalent at the coarse level used to
 * decide whether the history should be cleared:
 *   - The set of list IDs is equal.
 *   - Per list, the task count is equal.
 *
 * This is deliberately not a field-level diff. The failure mode we're
 * guarding against is a focus-driven TOKEN_REFRESHED that refetches
 * the same data — that should NOT clear history. A genuine sign-in
 * swap changes the list ID set (different user / fresh migration) or
 * the task counts, and clearHistory() fires. A user editing a task
 * text locally while another tab edits the same task remotely is rare
 * and clearing history on that path would be a worse outcome than
 * leaving the history visible, so we tolerate the coarse check.
 */
function datasetsEqual(remoteLists, remoteTasks) {
  if (!Array.isArray(remoteLists) || !Array.isArray(remoteTasks)) return false;

  const localListIds = Object.keys(state.lists);
  const remoteListIds = remoteLists.map((l) => l && l.id).filter(Boolean);

  if (localListIds.length !== remoteListIds.length) return false;

  const localSet = new Set(localListIds);
  for (const id of remoteListIds) {
    if (!localSet.has(id)) return false;
  }

  // Task counts per list.
  const remoteTaskCounts = {};
  for (const t of remoteTasks) {
    if (!t || !t.list_id) continue;
    remoteTaskCounts[t.list_id] = (remoteTaskCounts[t.list_id] || 0) + 1;
  }

  for (const listId of remoteListIds) {
    const localTasks = state.lists[listId] ? state.lists[listId].tasks : null;
    if (!localTasks) return false;
    if (localTasks.length !== (remoteTaskCounts[listId] || 0)) return false;
  }

  return true;
}

function hydrateFromRemote(remoteLists, remoteTasks) {
  if (!remoteLists || remoteLists.length === 0) {
    return;
  }

  // Round 7 Item 2: clear history only when the data set actually changed.
  // A focus-driven TOKEN_REFRESHED runs fetchRemoteState() → this function
  // with the same data, and used to wipe history as a side effect. If the
  // incoming set matches the local one, keep the history.
  const sameSet = datasetsEqual(remoteLists, remoteTasks);

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

  if (!sameSet) {
    clearHistory();
  }

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
