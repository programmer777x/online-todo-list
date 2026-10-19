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
// - Fixed drag targeting for nested tasks. Uses `elementFromPoint` to correctly identify subtask
//   rows, with a geometric fallback for gaps. Ensures parent tasks do not swallow their own
//   subtasks as drop targets.
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
   ------------------------------------------------------------------------------------------------
   Pointer-event driven. Only the .task-drag-handle element starts a drag; the rest of the row is
   untouched, so click / dblclick on the checkbox, text, menu, etc. still work.

   The dragged row is marked data-drag-state="dragging" (styled semi-transparent in CSS). The row
   the pointer is currently over is marked data-drop-state="before" or "after" depending on
   whether the pointer is in the top or bottom half of that row.

   On pointerup, `reorderTask()` is called with the target and the before/after decision. The
   renderer re-renders from state, so the drag state attributes are cleared automatically.

   Nothing here uses HTML5 drag-and-drop, so this works identically on touch and mouse.
   ================================================================================================ */

let dragState = null;

const DRAG_SNAP_THRESHOLD = 4; // pixels around the midpoint to prevent flickering

function wireDragToReorder() {
  // pointerdown: start a drag if the pointer went down on a drag handle.
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button only
    const handle = e.target.closest('.task-drag-handle');
    if (!handle) return;

    const item = handle.closest('.task-item');
    if (!item) return;
    const taskId = item.dataset.taskId;
    if (!taskId) return;

    // Do not start a drag if the row is currently being edited or has an open menu.
    if (ui.editingId === taskId || ui.openMenuTaskId === taskId) return;

    e.preventDefault(); // Stop the browser from selecting text / scrolling

    dragState = {
      pointerId: e.pointerId,
      handle,
      taskId,
      currentDrop: null, // { item, position }
    };

    item.dataset.dragState = 'dragging';
  });

  // pointermove: track which row (if any) is under the pointer.
  document.addEventListener('pointermove', (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    // 1. Find the element directly under the pointer.
    const elementUnder = document.elementFromPoint(e.clientX, e.clientY);
    let overItem = elementUnder ? elementUnder.closest('.task-item') : null;

    const draggedItem = document.querySelector(`.task-item[data-task-id="${cssEscape(dragState.taskId)}"]`);
    if (!draggedItem) return;
    
    const validList = draggedItem.closest('.task-list');
    if (!validList) return;

    // 2. Fallback: If we are in a gap or over the `<ul>` itself, find the nearest sibling
    //    by comparing vertical distances.
    if (!overItem || !validList.contains(overItem)) {
      let bestMatch = null;
      let bestDistance = Infinity;

      // Only look at direct children of the list (the top-level siblings)
      const siblings = validList.querySelectorAll(':scope > .task-item');

      for (const item of siblings) {
        if (item.dataset.taskId === dragState.taskId) continue;
        const rect = item.getBoundingClientRect();
        
        // Distance from mouse Y to the closest edge of this item
        const distTop = Math.abs(e.clientY - rect.top);
        const distBottom = Math.abs(e.clientY - rect.bottom);
        const dist = Math.min(distTop, distBottom);

        if (dist < bestDistance) {
          bestDistance = dist;
          bestMatch = item;
        }
      }
      overItem = bestMatch;
    }

    // 3. Calculate before/after position
    let newDrop = null;

    if (overItem && overItem.dataset.taskId !== dragState.taskId) {
      const rect = overItem.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      
      // Use a small threshold to prevent rapid flipping near the exact midpoint.
      let position;
      if (e.clientY < midpoint - DRAG_SNAP_THRESHOLD) {
        position = 'before';
      } else if (e.clientY > midpoint + DRAG_SNAP_THRESHOLD) {
        position = 'after';
      } else {
        // Within the dead zone: keep the existing position if it's the same item, 
        // otherwise default to the closest half.
        if (dragState.currentDrop && dragState.currentDrop.item === overItem) {
          position = dragState.currentDrop.position;
        } else {
          position = e.clientY < midpoint ? 'before' : 'after';
        }
      }

      newDrop = { item: overItem, position };
    }

    // 4. Update the DOM if the target or position actually changed.
    const current = dragState.currentDrop;
    const changed = 
      (!current && newDrop) ||
      (current && !newDrop) ||
      (current && newDrop && (current.item !== newDrop.item || current.position !== newDrop.position));

    if (changed) {
      if (current && current.item) {
        current.item.dataset.dropState = '';
      }
      if (newDrop) {
        newDrop.item.dataset.dropState = newDrop.position;
      }
      dragState.currentDrop = newDrop;
    }
  });

  // pointerup / pointercancel: finish the drag, call reorderTask() if we have a valid drop.
  const finishDrag = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const { taskId, currentDrop } = dragState;

    // Clear drag state on the dragged row. If we re-render, this is redundant but harmless.
    const draggedItem = document.querySelector(`.task-item[data-task-id="${cssEscape(taskId)}"]`);
    if (draggedItem) draggedItem.dataset.dragState = '';

    // Clear any lingering drop markers.
    if (currentDrop && currentDrop.item) currentDrop.item.dataset.dropState = '';

    dragState = null;

    if (!currentDrop) return;
    const targetId = currentDrop.item.dataset.taskId;
    if (!targetId) return;

    const changed = reorderTask(taskId, targetId, currentDrop.position);
    if (changed) {
      // Force a full re-render so numbering and DOM order both refresh from state.
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
  // One handler covers: canceling an inline edit, canceling add-subtask, and closing the open menu.
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
  // Attached at document level, and only acts when a menu is open. Clicks inside a menu are
  // stopped by the menu-item and menu-button handlers before reaching here.
  document.addEventListener('click', (e) => {
    if (!ui.openMenuTaskId) return;
    // If the click landed inside an open menu or on a ⋯ button, it was handled there.
    if (e.target.closest('.task-action-menu')) return;
    if (e.target.closest('.task-menu-button')) return;
    closeMenu({ returnFocus: false });
  });

  // ---- Window resize / orientation change ----
  // If the viewport crosses the breakpoint while a menu is open, close it so the menu does not
  // linger in a layout that no longer renders it.
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
