/* ================================================================================================
   Online To Do List — app.js
   ================================================================================================
   All logic: state, rendering, numbering, localStorage persistence, paste dedupe/sort, search,
   export/import, theme switching. Stage 1 — client-side only, no build step, no frameworks.

   State shape (persisted to localStorage under STORAGE_KEY):
     {
       version: 1,
       theme: "twilight" | "terminal" | "paper" | "avocado",
       tasks: [ task, ... ]
     }

   task = {
     id: string,                    // stable internal id, never shown
     text: string,
     done: boolean,
     section: "urgent" | "todo" | "sort",
     parentId: string | null,
     createdAt: number
   }

   Numbering is DERIVED AT RENDER TIME, never stored. One continuous sequence runs across
   URGENT -> TO DO -> TO SORT (top-level tasks share the sequence; subtasks nest decimally under
   their parent's number). Because numbers are computed from position, removal renumbers with no
   gaps automatically — no renumber pass is needed.

   Sections are ordered urgent, todo, sort. Sort (TO SORT) is the inbox and participates in the
   same continuous number sequence, per the Stage 1 build brief's numbering rule.
   ================================================================================================ */


/* ================================================================================================
   CONSTANTS
   ================================================================================================ */

const STORAGE_KEY = 'todolist.v1.state';

const SECTIONS = ['urgent', 'todo', 'sort'];

const SECTION_LABELS = {
  urgent: 'URGENT',
  todo: 'TO DO',
  sort: 'TO SORT',
};

const THEMES = ['twilight', 'terminal', 'paper', 'avocado'];

const DEFAULT_THEME = 'twilight';


/* ================================================================================================
   STATE
   ================================================================================================ */

let state = {
  version: 1,
  theme: DEFAULT_THEME,
  tasks: [],
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
   ------------------------------------------------------------------------------------------------
   Cached once at startup. All elements exist in index.html; if one is missing the app throws
   loudly rather than silently no-op-ing.
   ================================================================================================ */

const dom = {};

function cacheDom() {
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
  // Fallback: timestamp + random, collision-unlikely for a single-user local app.
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}


/* ================================================================================================
   PERSISTENCE
   ================================================================================================ */

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    // localStorage may be unavailable (private mode, disabled). Run in-memory for the session.
    console.warn('Could not read localStorage; running without persistence.', err);
    return;
  }

  if (!raw) return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('Saved state was not valid JSON; starting fresh.', err);
    return;
  }

  if (!parsed || typeof parsed !== 'object') return;

  // Validate theme.
  if (typeof parsed.theme === 'string' && THEMES.includes(parsed.theme)) {
    state.theme = parsed.theme;
  }

  // Validate tasks — keep only well-formed entries, coerce the rest.
  if (Array.isArray(parsed.tasks)) {
    state.tasks = parsed.tasks
      .filter((t) => t && typeof t === 'object' && typeof t.text === 'string')
      .map((t) => ({
        id: typeof t.id === 'string' && t.id ? t.id : generateId(),
        text: t.text,
        done: Boolean(t.done),
        section: SECTIONS.includes(t.section) ? t.section : 'sort',
        parentId: typeof t.parentId === 'string' && t.parentId ? t.parentId : null,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      }));
  }

  // Drop orphaned subtasks (parentId points at a task that no longer exists).
  const ids = new Set(state.tasks.map((t) => t.id));
  state.tasks = state.tasks.filter((t) => t.parentId === null || ids.has(t.parentId));
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
   ================================================================================================ */

function findTask(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

function topLevelTasks(section) {
  return state.tasks
    .filter((t) => t.section === section && t.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function childrenOf(parentId) {
  return state.tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Build the render tree for a section: [{ task, number, children: [...] }, ...].
 * Numbers are assigned by position: top-level tasks share one continuous sequence across
 * all sections; a task's children nest under its number (N.1, N.2, ...).
 *
 * The sequence counter is passed in and threaded through so urgent -> todo -> sort is continuous.
 */
function buildRenderTree(section, counter) {
  const nodes = [];
  for (const task of topLevelTasks(section)) {
    const number = String(counter.value);
    counter.value += 1;
    nodes.push({
      task,
      number,
      children: buildChildNodes(task.id, number),
    });
  }
  return nodes;
}

function buildChildNodes(parentId, parentNumber) {
  const nodes = [];
  const children = childrenOf(parentId);
  children.forEach((task, index) => {
    const number = `${parentNumber}.${index + 1}`;
    nodes.push({
      task,
      number,
      children: buildChildNodes(task.id, number),
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

  state.tasks.push(task);
  saveState();
  return task;
}

function removeTask(id) {
  // Remove the task and all of its descendants.
  const toRemove = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of state.tasks) {
      if (t.parentId && toRemove.has(t.parentId) && !toRemove.has(t.id)) {
        toRemove.add(t.id);
        grew = true;
      }
    }
  }
  state.tasks = state.tasks.filter((t) => !toRemove.has(t.id));
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
  if (!trimmed) return; // ignore empty edits
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
   matches, its ancestors are shown too (so the path to the match is visible).
   ================================================================================================ */

function taskMatchesSearch(task, query) {
  if (!query) return true;
  return task.text.toLowerCase().includes(query);
}

/**
 * Returns the set of task ids that should be visible given the current search query.
 * Empty query -> all ids.
 */
function visibleIdsForSearch(query) {
  if (!query) return null; // null means "no filtering"

  const visible = new Set();

  // Pass 1: direct matches.
  for (const task of state.tasks) {
    if (taskMatchesSearch(task, query)) visible.add(task.id);
  }

  // Pass 2: add ancestors of any match so the tree path is intact.
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
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
  const visibleIds = visibleIdsForSearch(ui.search);
  const counter = { value: 1 };

  for (const section of SECTIONS) {
    const tree = buildRenderTree(section, counter);

    // Count: tasks in this section that are visible (post-search).
    const sectionTasks = state.tasks.filter((t) => t.section === section);
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

  // If a search filter is active and this task is not visible, skip it (and its subtree
  // was already pruned by visibleIdsForSearch — but we still check).
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
    // Focus after the row is in the DOM.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    const textEl = document.createElement('span');
    textEl.className = 'task-text';
    textEl.textContent = task.text;
    // Double-click to edit.
    textEl.addEventListener('dblclick', () => {
      ui.editingId = task.id;
      render();
    });
    row.appendChild(textEl);
  }

  // --- Actions ---
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  // Edit button (explicit control in addition to double-click).
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

  // Add subtask button.
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

  // Move-between-sections select.
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

  // Remove button.
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
    // Note: no blur-commit here, so an accidental blur doesn't silently add a subtask.

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
   PASTE BOX
   ------------------------------------------------------------------------------------------------
   Splits on newlines, trims, skips empties, dedupes against existing tasks AND against earlier
   lines in the same paste. Normalization: trim, lowercase, collapse internal whitespace.
   ================================================================================================ */

function normalizeForDedupe(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

function handlePasteAdd() {
  const raw = dom.pasteInput.value;
  const lines = raw.split(/\r?\n/);

  const existing = new Set(state.tasks.map((t) => normalizeForDedupe(t.text)));
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

  // Summary line, per the brief's wording.
  const parts = [];
  parts.push(`Added ${added}`);
  if (skipped > 0) parts.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
  dom.pasteStatus.textContent = parts.join(', ');

  // Clear the status after a few seconds so it doesn't linger.
  setTimeout(() => {
    if (dom.pasteStatus.textContent) dom.pasteStatus.textContent = '';
  }, 4000);

  render();
}


/* ================================================================================================
   EXPORT / IMPORT
   ================================================================================================ */

function handleExport() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    theme: state.theme,
    tasks: state.tasks,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `online-todo-list-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

    const ok = window.confirm(
      'Importing will REPLACE your current list with the contents of this file.\n\n' +
      'This cannot be undone. Continue?'
    );
    if (!ok) return;

    // Rebuild state from the imported payload, validating each task.
    const importedTasks = parsed.tasks
      .filter((t) => t && typeof t === 'object' && typeof t.text === 'string')
      .map((t) => ({
        id: typeof t.id === 'string' && t.id ? t.id : generateId(),
        text: t.text,
        done: Boolean(t.done),
        section: SECTIONS.includes(t.section) ? t.section : 'sort',
        parentId: typeof t.parentId === 'string' && t.parentId ? t.parentId : null,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      }));

    const ids = new Set(importedTasks.map((t) => t.id));
    const cleaned = importedTasks.filter((t) => t.parentId === null || ids.has(t.parentId));

    state.tasks = cleaned;
    if (typeof parsed.theme === 'string' && THEMES.includes(parsed.theme)) {
      state.theme = parsed.theme;
      applyTheme(state.theme);
    }

    ui.editingId = null;
    ui.addingSubtaskTo = null;

    saveState();
    render();

    dom.pasteStatus.textContent = `Imported ${cleaned.length} task${cleaned.length === 1 ? '' : 's'}.`;
    setTimeout(() => {
      if (dom.pasteStatus.textContent.startsWith('Imported')) dom.pasteStatus.textContent = '';
    }, 4000);
  };

  reader.onerror = () => {
    alert('Could not read that file.');
  };

  reader.readAsText(file);
}


/* ================================================================================================
   EVENT WIRING
   ================================================================================================ */

function wireEvents() {
  // Theme.
  dom.themeSelect.addEventListener('change', () => {
    setTheme(dom.themeSelect.value);
  });

  // Quick add — lands in TO SORT.
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

  // Per-section "+" buttons — add directly to that section.
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

  // Search.
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

  // Paste box.
  dom.pasteAddButton.addEventListener('click', handlePasteAdd);

  // Export / import.
  dom.exportButton.addEventListener('click', handleExport);
  dom.importButton.addEventListener('click', () => {
    dom.importFile.click();
  });
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    if (file) handleImportFile(file);
    // Reset so selecting the same file again re-triggers change.
    dom.importFile.value = '';
  });

  // Global Escape: cancel any open inline edit or add-subtask input.
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
  wireEvents();
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
