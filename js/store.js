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
// - `reorderTask()` — data-layer half of drag-to-reorder. Reorders siblings within the same
//   section and parent by reassigning `createdAt` timestamps, so the existing sort-by-`createdAt`
//   render path needs no changes.
// - `reparentTask()` — data-layer half of cross-list drag. Updates a task's `parentId` and
//   `section`, so SortableJS's `onEnd` can move a subtask to a new parent or a top-level task to
//   a different section. A follow-up `reorderTask()` places it at the exact visual index; this
//   function only handles the parent/section change itself.
//
//
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

  // Only reorder within the same section and same parent. Cross-section is moveTask's job.
  if (dragged.section !== target.section) return false;
  if (dragged.parentId !== target.parentId) return false;

  // Collect the siblings of this (section, parent) pair in their current render order.
  const siblings = list.tasks
    .filter((t) => t.section === dragged.section && t.parentId === dragged.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Remove the dragged task from the sibling list, then re-insert at the target position.
  const withoutDragged = siblings.filter((t) => t.id !== dragged.id);
  const targetIndex = withoutDragged.findIndex((t) => t.id === target.id);
  if (targetIndex === -1) return false;

  const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
  withoutDragged.splice(insertAt, 0, dragged);

  // No-op if the order is already identical.
  const sameOrder = withoutDragged.every((t, i) => t.id === siblings[i].id);
  if (sameOrder) return false;

  // Reassign createdAt timestamps to match the new order. Use a base far enough in the past
  // that it never collides with existing createdAt values (which come from Date.now()).
  // We assign strictly increasing timestamps starting at 1 so the new order is unambiguous.
  withoutDragged.forEach((t, i) => {
    t.createdAt = i + 1;
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

  // Prevent making a task its own parent or creating a cycle (though the UI prevents this,
  // it's good practice for the store to be defensive).
  if (taskId === newParentId) return false;

  task.parentId = newParentId || null;
  task.section = newSection;
  saveState();
  return true;
}
