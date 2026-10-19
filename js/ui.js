// UI Version 1.0
//
// ================================================================================================
//
// Event wiring, user interactions, and app initialization for the Online To Do List.
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
// - Initial creation. Extracted the event handling and initialization logic from the original app.js.
//
//
//
// ================================================================================================
//
// === FIXES ===
//
// - Replaced the custom pointer-event drag-to-reorder implementation with SortableJS.
//   SortableJS handles nested lists, touch devices, and smooth animations natively, eliminating
//   the layout-thrashing and jumpy behavior of the custom solution.
// - Added `draggable: '.task-item'` to SortableJS so it correctly identifies the `<li>` elements
//   as the draggable units, fixing the issue where items could not be dragged at all.
// - Fixed SortableJS nested drag targeting using `:scope > .task-item` and `.task-item .task-item`
//   filter. Prevents the parent list from hijacking the drag of a nested subtask.
//
// ================================================================================================

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

    const fallback = parsed.listName || deriveListNameFromFile(file.name) || 'Imported list';
    const entered = window.prompt('Name for the imported list:', uniqueListName(fallback));
    if (entered === null) return;

    const finalName = String(entered).trim() || uniqueListName(fallback);
    const sanitizedTasks = sanitizeTasks(parsed.tasks);

    const newList = createList(finalName);
    newList.tasks = sanitizedTasks;

    state.activeListId = newList.id;
    ui.editingId = null;
    ui.addingSubtaskTo = null;
    ui.openMenuTaskId = null;

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
   LIST ACTIONS
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
  ui.openMenuTaskId = null;
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
  if (Object.keys(state.lists).length <= 1) return;
  const list = activeList();
  const ok = window.confirm(
    `Delete the list "${list.name}" and all of its tasks?\n\nThis cannot be undone.`
  );
  if (!ok) return;
  deleteList(list.id);
  ui.editingId = null;
  ui.addingSubtaskTo = null;
  ui.openMenuTaskId = null;
  saveState();
  renderListSwitcher();
  render();
}


/* ================================================================================================
   DRAG-TO-REORDER (SortableJS)
   ================================================================================================ */

/**
 * Initializes SortableJS on every task list container.
 * Called after render() so the DOM elements exist.
 */
function initSortable() {
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS not loaded.');
    return;
  }

  // Apply to every `.task-list` AND `.task-children` <ul> in the DOM.
  document.querySelectorAll('.task-list, .task-children').forEach((listEl) => {
    if (listEl.sortableInstance) {
      listEl.sortableInstance.destroy();
    }

    listEl.sortableInstance = new Sortable(listEl, {
      group: 'tasks',
      
      // THE FIX: Only allow direct children to be dragged by this specific list.
      // This prevents the parent list from hijacking the drag of a nested subtask.
      draggable: ':scope > .task-item',
      
      // Fallback: explicitly filter out items that belong to a nested list.
      filter: '.task-item .task-item',
      
      handle: '.task-drag-handle',
      animation: 150,
      fallbackOnBody: true,
      swapThreshold: 0.65,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      forceFallback: true,
      
      onEnd: function (evt) {
        const taskId = evt.item.dataset.taskId;
        const task = activeList().tasks.find((t) => t.id === taskId);
        if (!task) return;

        // Figure out where it was dropped.
        const targetListEl = evt.to;
        
        // If it was dropped into a .task-children list, we need to find the parent task ID.
        let newParentId = null;
        if (targetListEl.classList.contains('task-children')) {
          const parentItem = targetListEl.closest('.task-item');
          if (parentItem) {
            newParentId = parentItem.dataset.taskId;
          }
        }

        // If it was dropped into a top-level .task-list, find the section.
        let newSection = task.section;
        const sectionEl = targetListEl.closest('.task-section');
        if (sectionEl) {
          newSection = sectionEl.dataset.section;
        } else if (targetListEl.dataset.listFor) {
          newSection = targetListEl.dataset.listFor;
        }

        // Update the task's section and parentId
        task.section = newSection;
        task.parentId = newParentId;

        // Determine the new index within the target list.
        const items = Array.from(targetListEl.querySelectorAll(':scope > .task-item'));
        const newIndex = items.indexOf(evt.item);

        // Reassign createdAt timestamps to reflect the new order.
        const siblings = activeList().tasks
          .filter((t) => t.section === newSection && t.parentId === newParentId)
          .sort((a, b) => a.createdAt - b.createdAt);

        const withoutDragged = siblings.filter((t) => t.id !== taskId);
        withoutDragged.splice(newIndex, 0, task);

        withoutDragged.forEach((t, i) => {
          t.createdAt = i + 1;
        });

        saveState();
        render();
      },
    });
  });
}


/* ================================================================================================
   EVENT WIRING
   ================================================================================================ */

function wireEvents() {
  // ---- List switcher ----
  dom.listSelect.addEventListener('change', () => handleListSwitch(dom.listSelect.value));
  dom.listNewButton.addEventListener('click', handleListNew);
  dom.listRenameButton.addEventListener('click', handleListRename);
  dom.listDeleteButton.addEventListener('click', handleListDelete);

  // ---- Theme ----
  dom.themeSelect.addEventListener('change', () => setTheme(dom.themeSelect.value));

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
  dom.importButton.addEventListener('click', () => dom.importFile.click());
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    if (file) handleImportFile(file);
    dom.importFile.value = '';
  });

  // ---- Global keyboard: Escape ----
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (ui.openMenuTaskId) {
      e.preventDefault();
      closeMenu({ returnFocus: true });
      return;
    }
    if (ui.editingId || ui.addingSubtaskTo) {
      ui.editingId = null;
      ui.addingSubtaskTo = null;
      render();
    }
  });

  // ---- Click outside closes the menu ----
  document.addEventListener('click', (e) => {
    if (!ui.openMenuTaskId) return;
    if (e.target.closest('.task-action-menu')) return;
    if (e.target.closest('.task-menu-button')) return;
    closeMenu({ returnFocus: false });
  });

  // ---- Window resize / orientation change ----
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (ui.openMenuTaskId) {
        closeMenu({ returnFocus: false });
      }
    });
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

  // Initialize SortableJS after the first render.
  initSortable();

  // Register the service worker for PWA offline support.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service Worker registration failed:', err);
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
