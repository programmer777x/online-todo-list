// Render Version 1.0
//
// ================================================================================================
//
// DOM rendering and view-layer logic for the Online To Do List.
//
// This file is responsible for:
//   - Caching DOM references (cacheDom).
//   - Rendering the task tree (render, renderNode) and its constituent parts (inline actions, the
//     mobile ⋯ menu button, the menu itself).
//   - Positioning and toggling the mobile action menu.
//   - Rendering the list switcher dropdown.
//   - Applying the active theme to the document root.
//   - Filtering visible tasks based on search input.
//   - Rendering the drag handle and drop-target marker attributes used by drag-to-reorder.
//
// It also owns the shared `ACTIONS` dispatcher. Both the desktop inline controls and the mobile
// menu items call these action functions, ensuring there is exactly one implementation of each
// task action (edit, subtask, move, remove, toggleDone).
//
// It relies on the `state` and `ui` objects and all helper functions defined in `store.js`, and on
// constants defined in `config.js`.
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
// - Initial creation. Extracted the rendering and view-layer logic from the original app.js.
// - Drag handle element rendered at the start of every task row, and `data-drag-state` /
//   `data-drop-state` attributes on the task <li>. Enables drag-to-reorder without changing
//   the row's existing pointer-event targets.
//
//
//
// ================================================================================================
//
// === FIXES ===
//
// - Added a call to `initSortable()` at the end of `render()` so SortableJS is re-bound to the
//   freshly rendered DOM elements after every state change or re-render.
// - Action menu now renders into `document.body` instead of into the task row. The parent
//   `.task-section` has `backdrop-filter: blur()`, which creates a new CSS stacking context;
//   any `z-index` applied inside that section is therefore trapped and cannot render above
//   subsequent sections. Rendering the menu into `<body>` escapes that stacking context
//   entirely. `positionMenu()` now computes fixed viewport coordinates from the ⋯ button's
//   `getBoundingClientRect()` and applies `top`/`left` inline. The `is-flipped` class still
//   toggles the up-vs-down animation, but the geometric flip is calculated in JS. `render()`
//   now sweeps any stale `.task-action-menu` elements out of `<body>` at the top of the
//   rebuild, since clearing `listEl.innerHTML` no longer removes the menu.
//
// ================================================================================================

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

/** True when the viewport is below the action-menu breakpoint. */
function isMobileActions() {
  return window.matchMedia(`(max-width: ${ACTIONS_BREAKPOINT_PX - 0.02}px)`).matches;
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
   SHARED ACTION DISPATCHER
   ------------------------------------------------------------------------------------------------
   Every task action routes through here. The desktop inline controls AND the mobile menu items
   call the same dispatcher, so there is exactly one implementation of each action.

   `closeMenuFirst` is used by the menu path to close the menu before performing the action, so
   the menu does not linger if the action re-renders the row.
   ================================================================================================ */

const ACTIONS = {
  edit: (taskId) => {
    ui.editingId = taskId;
    ui.addingSubtaskTo = null;
    ui.openMenuTaskId = null;
    render();
  },
  subtask: (taskId) => {
    ui.addingSubtaskTo = ui.addingSubtaskTo === taskId ? null : taskId;
    ui.editingId = null;
    ui.openMenuTaskId = null;
    render();
  },
  move: (taskId, section) => {
    moveTask(taskId, section);
    ui.openMenuTaskId = null;
    render();
  },
  remove: (taskId) => {
    removeTask(taskId);
    ui.openMenuTaskId = null;
    render();
  },
  toggleDone: (taskId) => {
    toggleDone(taskId);
    render();
  },
};


/* ================================================================================================
   SEARCH
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

  // Menu is body-attached (see renderNode) and is no longer cleared by listEl.innerHTML reset.
  // Sweep any stale instance before the rebuild, so at most one menu exists and the fresh one
  // is the only candidate for `document.querySelector('.task-action-menu')` in positionMenu().
  document.querySelectorAll('.task-action-menu').forEach((m) => m.remove());

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

  // Re-initialize SortableJS on the freshly rendered lists.
  if (typeof initSortable === 'function') {
    initSortable();
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
  // Set by ui.js during a drag, to style the row's dragging / drop-target states in CSS.
  // Rendered here as stable empty values so CSS can key off [data-drag-state] / [data-drop-state].
  item.dataset.dragState = '';
  item.dataset.dropState = '';

  const row = document.createElement('div');
  row.className = 'task-row';

  // --- Drag handle (initiates drag-to-reorder) ---
  // The handle is the only pointer target that starts a drag; the rest of the row keeps its
  // normal click/dblclick behavior for checkbox, edit, menu, etc.
  const dragHandle = document.createElement('span');
  dragHandle.className = 'task-drag-handle';
  dragHandle.setAttribute('aria-hidden', 'true');
  dragHandle.title = 'Drag to reorder';
  dragHandle.textContent = '⋮⋮';
  dragHandle.dataset.dragHandleFor = task.id;
  row.appendChild(dragHandle);

  // --- Checkbox (complete toggle) ---
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'task-check';
  check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
  check.setAttribute('aria-pressed', task.done ? 'true' : 'false');
  check.textContent = task.done ? '✓' : '';
  check.addEventListener('click', () => ACTIONS.toggleDone(task.id));
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
      ui.openMenuTaskId = null;
      render();
    });
    row.appendChild(textEl);
  }

  // --- Desktop inline actions ---
  row.appendChild(renderInlineActions(task));

  // --- Mobile ⋯ button and its menu ---
  row.appendChild(renderMenuButton(task));

  // Append the menu directly to the body to escape the stacking context created by
  // the section's `backdrop-filter: blur()`. This allows it to float above other sections.
  const menu = renderActionMenu(task);
  if (menu) {
    document.body.appendChild(menu);
  }

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

/**
 * Desktop inline action controls. Always rendered into the DOM; hidden by CSS below the
 * breakpoint. This keeps desktop markup byte-identical to the pre-fix version.
 */
function renderInlineActions(task) {
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'task-action';
  editBtn.setAttribute('aria-label', 'Edit task');
  editBtn.title = 'Edit';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', () => ACTIONS.edit(task.id));
  actions.appendChild(editBtn);

  const subtaskBtn = document.createElement('button');
  subtaskBtn.type = 'button';
  subtaskBtn.className = 'task-action';
  subtaskBtn.setAttribute('aria-label', 'Add subtask');
  subtaskBtn.title = 'Add subtask';
  subtaskBtn.textContent = '↳';
  subtaskBtn.addEventListener('click', () => ACTIONS.subtask(task.id));
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
  moveSelect.addEventListener('change', () => ACTIONS.move(task.id, moveSelect.value));
  actions.appendChild(moveSelect);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'task-action task-action-danger';
  removeBtn.setAttribute('aria-label', 'Remove task');
  removeBtn.title = 'Remove';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => ACTIONS.remove(task.id));
  actions.appendChild(removeBtn);

  return actions;
}

/** The ⋯ button. Hidden by CSS at/above the breakpoint. */
function renderMenuButton(task) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'task-menu-button';
  btn.setAttribute('aria-label', 'Task actions');
  btn.setAttribute('aria-haspopup', 'menu');
  const isOpen = ui.openMenuTaskId === task.id;
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  btn.textContent = '⋯';
  btn.dataset.menuButtonFor = task.id;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(task.id);
  });
  return btn;
}

/**
 * The mobile action menu. Rendered only when this task's menu is the open one — so at most one
 * exists in the DOM at a time, and no cleanup is needed when the open task changes.
 *
 * The menu is appended to `document.body` by `renderNode`, not returned into the row. That
 * placement is what escapes the `.task-section` `backdrop-filter` stacking context.
 */
function renderActionMenu(task) {
  if (ui.openMenuTaskId !== task.id) return null;

  const menu = document.createElement('div');
  menu.className = 'task-action-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Task actions');

  // Edit
  menu.appendChild(menuItem('✎', 'Edit', () => ACTIONS.edit(task.id)));

  // Add subtask
  menu.appendChild(menuItem('↳', 'Add subtask', () => ACTIONS.subtask(task.id)));

  // Move group — only the OTHER sections.
  const otherSections = SECTIONS.filter((s) => s !== task.section);
  if (otherSections.length > 0) {
    const label = document.createElement('div');
    label.className = 'task-menu-group-label';
    label.textContent = 'Move to';
    menu.appendChild(label);

    for (const s of otherSections) {
      menu.appendChild(menuItem('→', SECTION_MOVE_LABELS[s], () => ACTIONS.move(task.id, s)));
    }
  }

  // Divider + remove
  const divider = document.createElement('div');
  divider.className = 'task-menu-divider';
  divider.setAttribute('role', 'separator');
  menu.appendChild(divider);

  const removeItem = menuItem('✕', 'Remove', () => ACTIONS.remove(task.id));
  removeItem.classList.add('task-menu-item-danger');
  menu.appendChild(removeItem);

  // Positioning (below / flip up, edge-clamp) happens in positionMenu, after the menu is in
  // the DOM and measurable.
  return menu;
}

function menuItem(icon, labelText, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'task-menu-item';
  btn.setAttribute('role', 'menuitem');

  const iconEl = document.createElement('span');
  iconEl.className = 'task-menu-item-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = icon;
  btn.appendChild(iconEl);

  const labelEl = document.createElement('span');
  labelEl.textContent = labelText;
  btn.appendChild(labelEl);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });

  return btn;
}


/* ================================================================================================
   MENU OPEN / CLOSE
   ================================================================================================ */

/**
 * Toggle the ⋯ menu for a task. Opening one closes any other (only one open at a time).
 * After opening, positionMenu() runs on the next frame to measure and place it.
 */
function toggleMenu(taskId) {
  if (ui.openMenuTaskId === taskId) {
    closeMenu({ returnFocus: true });
    return;
  }
  ui.openMenuTaskId = taskId;
  render();
  // Position after the menu exists in the DOM and has been laid out.
  requestAnimationFrame(() => positionMenu(taskId));
}

/**
 * Close the open menu, if any.
 *   returnFocus: move focus back to the ⋯ button for the task that had the menu open.
 */
function closeMenu({ returnFocus = false } = {}) {
  const wasOpenFor = ui.openMenuTaskId;
  if (!wasOpenFor) return;
  ui.openMenuTaskId = null;
  render();

  if (returnFocus) {
    // The button now exists in the fresh DOM. Find it by its data attribute.
    const btn = document.querySelector(`[data-menu-button-for="${cssEscape(wasOpenFor)}"]`);
    if (btn) btn.focus();
  }
}

/**
 * Position the open menu using fixed coordinates relative to the viewport, based on the
 * position of the ⋯ button that opened it.
 */
function positionMenu(taskId) {
  const menu = document.querySelector('.task-action-menu');
  const btn = document.querySelector(`[data-menu-button-for="${cssEscape(taskId)}"]`);
  if (!menu || !btn) return;

  // Reset any prior positioning so we measure the natural size.
  menu.style.top = 'auto';
  menu.style.bottom = 'auto';
  menu.style.left = 'auto';
  menu.style.right = 'auto';
  menu.classList.remove('is-flipped');

  const btnRect = btn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;

  // Default: align menu's right edge with the button's right edge, and place below button.
  let top = btnRect.bottom + 6;
  let left = btnRect.right - menuRect.width;

  // Flip up if it would overflow the bottom of the viewport.
  if (top + menuRect.height > vh - 8) {
    top = btnRect.top - menuRect.height - 6;
    menu.classList.add('is-flipped');
  }

  // Pull left if it would overflow the right edge.
  if (left + menuRect.width > vw - 8) {
    left = vw - menuRect.width - 8;
  }

  // Pull right if it would overflow the left edge.
  if (left < 8) {
    left = 8;
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

/**
 * Escape a string for use in a querySelector attribute selector. Handles ids with characters
 * that would otherwise break the selector. Falls back to CSS.escape when available.
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, '\\$&');
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

  const onlyOne = Object.keys(state.lists).length <= 1;
  dom.listDeleteButton.disabled = onlyOne;
  dom.listDeleteButton.title = onlyOne ? 'Cannot delete the only list' : 'Delete list';
}
