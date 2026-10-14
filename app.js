/* ================================================================================================
   Online To Do List — app.js
   ================================================================================================
   All logic: state, rendering, numbering, localStorage persistence, paste dedupe/sort, search,
   export/import, theme switching, and multiple named lists.
   Stage 1 — client-side only, no build step, no frameworks.

   State shape (persisted to localStorage under STORAGE_KEY):
     {
       version: 2,
       theme: "twilight" | "terminal" | "paper" | "avocado",
       activeListId: string,
       lists: {
         "<listId>": {
           id: string,
           name: string,
           tasks: [ task, ... ]
         },
         ...
       }
     }

   task = {
     id: string,                    // stable internal id, never shown
     text: string,
     done: boolean,
     section: "urgent" | "todo" | "sort",
     parentId: string | null,
     createdAt: number
   }

   Numbering is DERIVED AT RENDER TIME, never stored, and is PER LIST. Within a list, one
   continuous sequence runs across URGENT -> TO DO -> TO SORT (top-level tasks share the
   sequence; subtasks nest decimally under their parent's number). Because numbers are computed
   from position, removal renumbers with no gaps automatically — no renumber pass is needed.

   Sections are ordered urgent, todo, sort. Sort (TO SORT) is the inbox and participates in the
   same continuous number sequence, per the Stage 1 build brief's numbering rule.

   Themes are global. Switching lists does not change the theme.
   ================================================================================================ */


/* ================================================================================================
   CONSTANTS
   ================================================================================================ */

const STORAGE_KEY = 'todolist.v1.state';
const STATE_VERSION = 2;

const SECTIONS = ['urgent', 'todo', 'sort'];

const SECTION_LABELS = {
  urgent: 'URGENT',
  todo: 'TO DO',
  sort: 'TO SORT',
};

const THEMES = ['twilight', 'terminal', 'paper', 'avocado'];

const DEFAULT_THEME = 'twilight';

const DEFAULT_LIST_NAME = 'Main';


/* ================================================================================================
   STATE
   ================================================================================================ */

let state = {
  version: STATE_VERSION,
  theme: DEFAULT_THEME,
  activeListId: '',
  lists: {},
};

/** Transient UI state — not persisted. */
let ui = {
  editingId: null,       // id of the task currently being inline-edited, or null
  addingSubtaskTo: null, // id of the task whose "add subtask" input is open, or null
  search: '',            // current search query (lowercased for matching)
  searchRaw: '',         // current search query as typed (for the input value)
};


/* ================================================================================================
   DOM REFERENCES
   ================================================================================================ */

const dom = {};

function cacheDom() {
  dom.listSelect = document.getElementById('list-select');
  dom.listNewButton = document.getElementById('list-new-button');
  dom.listRenameButton = document.getElementById('list-rename-button');
  dom.listDeleteButton = document.getElementById('list-delete-button');

  dom.themeSelect = document.getElementById('theme-select');
  dom.quickAddInput = document.getElementById('quick-add-input');
  dom.quickAddButton = document.getElementById('quick-add-button');
  dom.searchInput = document.getElementById('search-input');
  dom.searchClear = document.getElementById('search-clear');
  dom.sections = document.getElementById('sections');
  dom.pasteInput = document.getElementById('paste-input');
  dom.pasteAddButton = document.getElementById('paste-add-button');
  dom.pasteStatus = document.getElementById('paste-status');
  dom.exportButton = document.getElementById('export-button');
  dom.importButton = document.getElementById('import-button');
  dom.importFile = document.getElementById('import-file');

  dom.taskLists = {};
  dom.sectionCounts = {};
  for (const section of SECTIONS) {
    dom.taskLists[section] = document.querySelector(`[data-list-for="${section}"]`);
    dom.sectionCounts[section] = document.querySelector(`[data-count-for="${section}"]`);
  }
}


/* ================================================================================================
   ID GENERATION
   ------------------------------------------------------------------------------------------------
   crypto.randomUUID() needs a secure context. https:// (GitHub Pages) and file:// both qualify in
   modern browsers, but older browsers on file:// may not expose it — hence the fallback.
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

/** Returns the currently active list object. Throws if state is inconsistent. */
function activeList() {
  const list = state.lists[state.activeListId];
  if (!list) {
    // Should not happen given the load-time guarantee of at least one list, but guard anyway.
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
  const list = {
    id,
    name: uniqueListName(name),
    tasks: [],
  };
  state.lists[id] = list;
  return list;
}

function deleteList(listId) {
  // Guard: never delete the last remaining list.
  if (Object.keys(state.lists).length <= 1) return false;
  delete state.lists[listId];
  // If we deleted the active list, switch to any remaining one.
  if (state.activeListId === listId) {
    state.activeListId = Object.keys(state.lists)[0];
  }
  return true;
}

function setActiveList(listId) {
  if (!state.lists[listId]) return;
  state.activeListId = listId;
  // Clear transient per-list UI state when switching.
  ui.editingId = null;
  ui.addingSubtaskTo = null;
  // Search persists across lists intentionally (it's a UI filter, not list data).
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
    // Theme.
    if (typeof parsed.theme === 'string' && THEMES.includes(parsed.theme)) {
      state.theme = parsed.theme;
    }

    // Lists.
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

    // Active list — fall back to first available if the stored id is missing.
    if (typeof parsed.activeListId === 'string' && cleanLists[parsed.activeListId]) {
      state.activeListId = parsed.activeListId;
    } else {
      state.activeListId = Object.keys(cleanLists)[0];
    }
    return;
  }

  // Anything else — start fresh.
  bootstrapFreshState();
}

/** Ensures at least one list exists. Used on fresh load and on unrecoverable state. */
function bootstrapFreshState() {
  const id = generateId();
  state.lists = {
    [id]: { id, name: DEFAULT_LIST_NAME, tasks: [] },
  };
  state.activeListId = id;
}

/**
 * Validate and normalize a task array. Drops malformed entries and orphaned subtasks.
 * `source` may be a list's tasks array (load) or an imported file's tasks array.
 */
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

  // Drop orphaned subtasks (parentId points at a task not present in this set).
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
   THEME
   ================================================================================================ */

function applyTheme(theme) {
  const safe = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', safe);
  if (dom.themeSelect) dom.themeSelect.value = safe;
}

function setTheme(theme) {
  state.theme = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  applyTheme(state.theme);
  saveState();
}


/* ================================================================================================
   TASK HELPERS
   ------------------------------------------------------------------------------------------------
   These operate on the ACTIVE LIST. Anything that needs a specific list's tasks accesses
   `state.lists[listId].tasks` directly.
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

/**
 * Build the render tree for a section: [{ task, number, children: [...] }, ...].
 * Numbers are assigned by position: top-level tasks share one continuous sequence across
 * all sections; a task's children nest under its number (N.1, N.2, ...).
 */
function buildRenderTree(tasks, section, counter) {
  const nodes = [];
  for (const task of topLevelTasks(tasks, section)) {
    const number = String(counter.value);
    counter.value += 1;
    nodes.push({
      task,
      number,
      children: buildChildNodes(tasks, task.id, number),
    });
  }
  return nodes;
}

function buildChildNodes(tasks, parentId, parentNumber) {
  const nodes = [];
  const children = childrenOf(tasks, parentId);
  children.forEach((task, index) => {
    const number = `${parentNumber}.${index + 1}`;
    nodes.push({
      task,
      number,
      children: buildChildNodes(tasks, task.id, number),
    });
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


/* ================================================================================================
   SEARCH
   ------------------------------------------------------------------------------------------------
   A task is visible if its own text matches, OR any of its descendants match. When a descendant
   matches, its ancestors are shown too.
   ================================================================================================ */

function visibleIdsForSearch(tasks, query) {
  if (!query) return null;

  const visible = new Set();
  for (const task of tasks) {
    if (task.text.toLowerCase().includes(query)) visible.add(task.id);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const id of Array.from(visible)) {
    let current = byId.get(id);
    while (current && current.parentId) {
      visible.add(current.parentId);
      current = byId.get(current.parentId);
    }
  }

  return visible;
}


/* ================================================================================================
   RENDERING
   ================================================================================================ */

function render() {
  const list = activeList();
  const tasks = list.tasks;

  const visibleIds = visibleIdsForSearch(tasks, ui.search);
  const counter = { value: 1 };

  for (const section of SECTIONS) {
    const tree = buildRenderTree(tasks, section, counter);

    const sectionTasks = tasks.filter((t) => t.section === section);
    const visibleSectionTasks = visibleIds
      ? sectionTasks.filter((t) => visibleIds.has(t.id))
      : sectionTasks;

    dom.sectionCounts[section].textContent = String(visibleSectionTasks.length);

    const listEl = dom.taskLists[section];
    listEl.innerHTML = '';

    if (tree.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'task-empty';
      empty.textContent = ui.search ? 'No matching tasks.' : 'Nothing here yet.';
      listEl.appendChild(empty);
      continue;
    }

    for (const node of tree) {
      listEl.appendChild(renderNode(node, visibleIds));
    }
  }
}

function renderNode(node, visibleIds) {
  const { task, number, children } = node;

  if (visibleIds && !visibleIds.has(task.id)) {
    return document.createDocumentFragment();
  }

  const item = document.createElement('li');
  item.className = 'task-item' + (task.done ? ' is-done' : '');
  item.dataset.taskId = task.id;

  const row = document.createElement('div');
  row.className = 'task-row';

  // --- Checkbox (complete toggle) ---
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'task-check';
  check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
  check.setAttribute('aria-pressed', task.done ? 'true' : 'false');
  check.textContent = task.done ? '✓' : '';
  check.addEventListener('click', () => {
    toggleDone(task.id);
    render();
  });
  row.appendChild(check);

  // --- Number ---
  const numberEl = document.createElement('span');
  numberEl.className = 'task-number';
  numberEl.textContent = number;
  numberEl.setAttribute('aria-hidden', 'true');
  row.appendChild(numberEl);

  // --- Text, or inline edit input ---
  if (ui.editingId === task.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-edit-input';
    input.value = task.text;
    input.setAttribute('aria-label', 'Edit task text');

    const commit = () => {
      updateText(task.id, input.value);
      ui.editingId = null;
      render();
    };
    const cancel = () => {
      ui.editingId = null;
      render();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', commit);

    row.appendChild(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    const textEl = document.createElement('span');
    textEl.className = 'task-text';
    textEl.textContent = task.text;
    textEl.addEventListener('dblclick', () => {
      ui.editingId = task.id;
      render();
    });
    row.appendChild(textEl);
  }

  // --- Actions ---
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'task-action';
  editBtn.setAttribute('aria-label', 'Edit task');
  editBtn.title = 'Edit';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', () => {
    ui.editingId = task.id;
    render();
  });
  actions.appendChild(editBtn);

  const subtaskBtn = document.createElement('button');
  subtaskBtn.type = 'button';
  subtaskBtn.className = 'task-action';
  subtaskBtn.setAttribute('aria-label', 'Add subtask');
  subtaskBtn.title = 'Add subtask';
  subtaskBtn.textContent = '↳';
  subtaskBtn.addEventListener('click', () => {
    ui.addingSubtaskTo = ui.addingSubtaskTo === task.id ? null : task.id;
    render();
  });
  actions.appendChild(subtaskBtn);

  const moveSelect = document.createElement('select');
  moveSelect.className = 'task-move-select';
  moveSelect.setAttribute('aria-label', 'Move task to another section');
  moveSelect.title = 'Move to…';
  for (const s of SECTIONS) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = SECTION_LABELS[s];
    if (s === task.section) opt.selected = true;
    moveSelect.appendChild(opt);
  }
  moveSelect.addEventListener('change', () => {
    moveTask(task.id, moveSelect.value);
    render();
  });
  actions.appendChild(moveSelect);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'task-action task-action-danger';
  removeBtn.setAttribute('aria-label', 'Remove task');
  removeBtn.title = 'Remove';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    removeTask(task.id);
    render();
  });
  actions.appendChild(removeBtn);

  row.appendChild(actions);
  item.appendChild(row);

  // --- Add-subtask inline input ---
  if (ui.addingSubtaskTo === task.id) {
    const addRow = document.createElement('div');
    addRow.className = 'task-add-subtask-row';

    const subInput = document.createElement('input');
    subInput.type = 'text';
    subInput.className = 'task-add-subtask-input';
    subInput.placeholder = 'New subtask…';
    subInput.setAttribute('aria-label', 'New subtask text');

    const commitSub = () => {
      const value = subInput.value.trim();
      if (value) {
        addTask(value, task.section, task.id);
      }
      ui.addingSubtaskTo = null;
      render();
    };
    const cancelSub = () => {
      ui.addingSubtaskTo = null;
      render();
    };

    subInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitSub();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelSub();
      }
    });

    addRow.appendChild(subInput);
    item.appendChild(addRow);

    setTimeout(() => subInput.focus(), 0);
  }

  // --- Children ---
  if (children.length > 0) {
    const childList = document.createElement('ul');
    childList.className = 'task-children';
    for (const childNode of children) {
      childList.appendChild(renderNode(childNode, visibleIds));
    }
    item.appendChild(childList);
  }

  return item;
}


/* ================================================================================================
   LIST SWITCHER RENDERING
   ================================================================================================ */

function renderListSwitcher() {
  const select = dom.listSelect;
  select.innerHTML = '';

  for (const list of Object.values(state.lists)) {
    const opt = document.createElement('option');
    opt.value = list.id;
    opt.textContent = list.name;
    if (list.id === state.activeListId) opt.selected = true;
    select.appendChild(opt);
  }

  // Disable delete when only one list remains (per the build brief: never delete the last list).
  const onlyOne = Object.keys(state.lists).length <= 1;
  dom.listDeleteButton.disabled = onlyOne;
  dom.listDeleteButton.title = onlyOne
    ? 'Cannot delete the only list'
    : 'Delete list';
}


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

    addTask(trimmed, 'sort', null);
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
   ------------------------------------------------------------------------------------------------
   Export: the ACTIVE list only, as JSON.
   Import: adds the file's tasks as a NEW list. Never touches existing lists. Name is prompted,
   pre-filled from the filename.
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

    // Pre-fill the prompt with the file's list name, or the filename if absent.
    const fallback = parsed.listName || deriveListNameFromFile(file.name) || 'Imported list';
    const entered = window.prompt('Name for the imported list:', uniqueListName(fallback));
    if (entered === null) return; // user cancelled

    const finalName = String(entered).trim() || uniqueListName(fallback);
    const sanitizedTasks = sanitizeTasks(parsed.tasks);

    const newList = createList(finalName);
    newList.tasks = sanitizedTasks;

    // Switch to the new list so the import is visible.
    state.activeListId = newList.id;
    ui.editingId = null;
    ui.addingSubtaskTo = null;

    saveState();
    renderListSwitcher();
    render();

    dom.pasteStatus.textContent =
      `Imported ${sanitizedTasks.length} task${sanitizedTasks.length === 1 ? '' : 's'} as "${newList.name}".`;
    setTimeout(() => {
      if (dom.pasteStatus.textContent.startsWith('Imported')) dom.pasteStatus.textContent = '';
    }, 5000);
  };

  reader.onerror = () => {
    alert('Could not read that file.');
  };

  reader.readAsText(file);
}


/* ================================================================================================
   LIST ACTIONS (create / rename / delete / switch)
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
  // Allow renaming to its own name; only dedupe against OTHER lists.
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
  saveState();
  renderListSwitcher();
}

function handleListDelete() {
  if (Object.keys(state.lists).length <= 1) return; // guarded, but check anyway
  const list = activeList();
  const ok = window.confirm(
    `Delete the list "${list.name}" and all of its tasks?\n\nThis cannot be undone.`
  );
  if (!ok) return;
  const wasActive = list.id;
  deleteList(wasActive);
  ui.editingId = null;
  ui.addingSubtaskTo = null;
  saveState();
  renderListSwitcher();
  render();
}


/* ================================================================================================
   EVENT WIRING
   ================================================================================================ */

function wireEvents() {
  // ---- List switcher ----
  dom.listSelect.addEventListener('change', () => {
    handleListSwitch(dom.listSelect.value);
  });
  dom.listNewButton.addEventListener('click', handleListNew);
  dom.listRenameButton.addEventListener('click', handleListRename);
  dom.listDeleteButton.addEventListener('click', handleListDelete);

  // ---- Theme ----
  dom.themeSelect.addEventListener('change', () => {
    setTheme(dom.themeSelect.value);
  });

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
  dom.importButton.addEventListener('click', () => {
    dom.importFile.click();
  });
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    if (file) handleImportFile(file);
    dom.importFile.value = '';
  });

  // ---- Global Escape ----
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (ui.editingId || ui.addingSubtaskTo)) {
      ui.editingId = null;
      ui.addingSubtaskTo = null;
      render();
    }
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
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
