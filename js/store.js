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
//   - Adding, removing, moving, and editing tasks and subtasks.
//   - Building the derived render tree (numbering is computed at render time, never stored).
//
// It assumes `config.js` has been loaded and its constants are available globally.
//
// ================================================================================================
//
// === REVISIONS ===
//
//
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted the state and data-layer logic from the original app.js.
//
//
//
// ================================================================================================
//
// === FIXES ===
//
//
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
  return list;
}

function deleteList(listId) {
  if (Object.keys(state.lists).length <= 1) return false;
  delete state.lists[listId];
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
  state.lists = {
    [id]: { id, name: DEFAULT_LIST_NAME, tasks: [] },
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

function addTask(text, section, parentId) {
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

  activeList().tasks.push(task);
  saveState();
  return task;
}

function removeTask(id) {
  const list = activeList();
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
  saveState();
}

function toggleDone(id) {
  const task = findTask(id);
  if (!task) return;
  task.done = !task.done;
  saveState();
}

function updateText(id, text) {
  const task = findTask(id);
  if (!task) return;
  const trimmed = String(text).trim();
  if (!trimmed) return;
  task.text = trimmed;
  saveState();
}

function moveTask(id, section) {
  if (!SECTIONS.includes(section)) return;
  const task = findTask(id);
  if (!task) return;
  task.section = section;
  saveState();
}
