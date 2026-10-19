// UI Version 1.0
//
// ================================================================================================
//
// Event wiring, user interactions, and app initialization for the Online To Do List.
//
// This file connects the DOM to the logic layer (store.js) and view layer (render.js). It handles:
//   - Wiring all user events (clicks, inputs, keyboard shortcuts).
//   - Managing the paste box (deduplication and sorting).
//   - Handling export and import of lists.
//   - Handling list creation, renaming, deletion, and switching.
//   - Pointer-event drag-to-reorder via the task drag handle.
//   - Initializing the app on load.
//   - Registering the service worker (PWA).
//
// It relies on the `state` and `ui` objects and helper functions from store.js, the rendering
// functions from render.js, and the constants from config.js.
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
// - `wireDragToReorder()` — pointer-event drag-to-reorder. Uses pointer capture on the drag
//   handle, tracks a virtual ghost, and calls `reorderTask()` on drop. Works identically on
//   desktop and touch (pointer events, not HTML5 drag-and-drop).
//
//
//
// ================================================================================================
//
// === FIXES ===
//
// - Restored `e.preventDefault()` in the drag handle's `pointerdown` handler, and removed
//   `setPointerCapture`. Preventing default on `pointerdown` is necessary to stop the browser
//   from hijacking the gesture for text selection or page scrolling. Relies on global `document`
//   listeners for tracking.
// - Overhauled drag targeting. Now caches row rects on drag start and uses an anchor offset so
//   the indicator moves based on the row's position, not the mouse pointer. Eliminates jumping
//   and fixes missing indicators for subtasks.
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
   DRAG-TO-REORDER
   ================================================================================================ */

let dragState = null;
const DRAG_SNAP_THRESHOLD = 15; // Larger dead zone for deliberate movement

function wireDragToReorder() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const handle = e.target.closest('.task-drag-handle');
    if (!handle) return;

    const item = handle.closest('.task-item');
    if (!item) return;
    const taskId = item.dataset.taskId;
    if (!taskId) return;

    if (ui.editingId === taskId || ui.openMenuTaskId === taskId) return;

    e.preventDefault();

    const dragTask = activeList().tasks.find(t => t.id === taskId);
    if (!dragTask) return;

    // 1. Cache the exact geometry of all valid siblings right now.
    const siblingElements = Array.from(document.querySelectorAll('.task-item')).filter((el) => {
      const t = activeList().tasks.find(task => task.id === el.dataset.taskId);
      if (!t || t.id === taskId) return false;
      return t.section === dragTask.section && t.parentId === dragTask.parentId;
    });

    const siblings = siblingElements.map((el) => {
      const row = el.querySelector('.task-row');
      const rect = row.getBoundingClientRect();
      return {
        item: el,
        rect,
        midpoint: rect.top + rect.height / 2
      };
    });

    // 2. Record where on the row the user grabbed the handle.
    const rowRect = item.querySelector('.task-row').getBoundingClientRect();
    const grabOffsetY = e.clientY - rowRect.top;

    dragState = {
      pointerId: e.pointerId,
      handle,
      taskId,
      currentDrop: null,
      grabOffsetY,
      siblings,
    };

    item.dataset.dragState = 'dragging';
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    // Calculate where the *top* of the dragged row currently is.
    const virtualTop = e.clientY - dragState.grabOffsetY;

    let bestMatch = null;
    let bestDistance = Infinity;

    // Find the row whose midpoint is closest to the dragged row's top edge.
    for (const sib of dragState.siblings) {
      const dist = Math.abs(virtualTop - sib.midpoint);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestMatch = sib;
      }
    }

    let newDrop = null;

    if (bestMatch) {
      let position;
      
      // If the virtual top of the dragged row is above the midpoint minus threshold -> 'before'
      // If below the midpoint plus threshold -> 'after'
      // Otherwise -> dead zone, keep existing position.
      if (virtualTop < bestMatch.midpoint - DRAG_SNAP_THRESHOLD) {
        position = 'before';
      } else if (virtualTop > bestMatch.midpoint + DRAG_SNAP_THRESHOLD) {
        position = 'after';
      } else {
        if (dragState.currentDrop && dragState.currentDrop.item === bestMatch.item) {
          position = dragState.currentDrop.position;
        } else {
          position = virtualTop < bestMatch.midpoint ? 'before' : 'after';
        }
      }
      
      newDrop = { item: bestMatch.item, position };
    }

    // Update DOM if changed.
    const current = dragState.currentDrop;
    const changed = 
      (!current && newDrop) ||
      (current && !newDrop) ||
      (current && newDrop && (current.item !== newDrop.item || current.position !== newDrop.position));

    if (changed) {
      if (current && current.item) current.item.dataset.dropState = '';
      if (newDrop) newDrop.item.dataset.dropState = newDrop.position;
      dragState.currentDrop = newDrop;
    }
  });

  const finishDrag = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const { taskId, currentDrop } = dragState;

    const draggedItem = document.querySelector(`.task-item[data-task-id="${cssEscape(taskId)}"]`);
    if (draggedItem) draggedItem.dataset.dragState = '';

    if (currentDrop && currentDrop.item) currentDrop.item.dataset.dropState = '';

    dragState = null;

    if (!currentDrop) return;
    const targetId = currentDrop.item.dataset.taskId;
    if (!targetId) return;

    const changed = reorderTask(taskId, targetId, currentDrop.position);
    if (changed) {
      render();
    }
  };

  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
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

  // ---- Drag-to-reorder ----
  wireDragToReorder();
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
