// UI Version 1.0
//
// ================================================================================================
//
// Event wiring, user interactions, and app initialization for the Online To Do List.
//
// Drag-to-reorder auto-scroll triggers at 28% of the viewport height on mobile, and 15% on
// desktop (screens wider than 640px).
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
// - Reworked `initSortable()` again: `:scope` is not reliably supported by SortableJS and
//   `filter: '.task-item .task-item'` is tested against the dragged item (so it never matched
//   top-level tasks and only blocked subtasks after the outer list had already claimed the
//   mousedown). Now uses `draggable: '> .task-item'` (SortableJS's supported direct-child
//   syntax), removes `filter` entirely, and constrains each instance with
//   `group: { pull: false, put: false }` so drags cannot transfer between lists. `onEnd` now
//   delegates to `store.reorderTask(taskId, neighborId, 'before'|'after')` instead of
//   hand-reassigning `createdAt` and mutating `section`/`parentId` — so a within-list drag is
//   persisted correctly, and cross-section/cross-parent moves remain the job of the existing
//   "Move to…" control.
// - Enabled cross-parent drag via SortableJS `group: { pull: true, put: true }`. `onEnd` now
//   detects when a task is dropped into a different `<ul>` (either a different parent's
//   `.task-children` or a different section's `.task-list`), resolves the new parent and section
//   from the DOM, and calls the new `store.reparentTask()` to persist the parent/section change
//   before calling `store.reorderTask()` to place the task at the exact dropped index. This
//   replaces the previous "Move to…" control for subtask reparenting. Cycle prevention
//   (a task cannot become its own descendant) is enforced by Sortable's DOM mechanics — a
//   dragged task is physically removed from the DOM during drag, so it never appears inside
//   its own subtree — plus a single-level `taskId === newParentId` guard in `reparentTask`.
// - Added YouTube-style auto-scroll for touch drags: `scroll: true`, `scrollSensitivity: 100`,
//   `scrollSpeed: 15`, `bubbleScroll: true`. Dragging near the top or bottom of the viewport
//   now scrolls the page, so a task can be dropped into a list that was off-screen when the
//   drag started.
// - Force fallback auto-scroll on desktop: added `forceAutoScrollFallback: true` so SortableJS
//   uses its own scroll logic rather than relying on native browser drag auto-scroll, which
//   ignores `scrollSensitivity` and `scrollSpeed`. Bumped `scrollSensitivity` from 100 to 200
//   to approximate a 30% viewport trigger zone. Tested on PC and mobile; tune the number if the
//   zone feels too aggressive or too shallow.
// - Auto-scroll trigger zone is now percentage-based: `getScrollSensitivity()` computes
//   `innerHeight * 0.28` on mobile (viewport ≤ 639px) and `innerHeight * 0.15` on desktop
//   (viewport ≥ 640px), matching the existing `ACTIONS_BREAKPOINT_PX` split. Replaces the
//   hardcoded `scrollSensitivity: 200` with the dynamic value. Because SortableJS caches
//   config at construction time, the value is re-evaluated on every `render()` — which runs
//   on resize, so orientation changes are handled.
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
   ------------------------------------------------------------------------------------------------
   One Sortable instance per list container (each `.task-list` and each `.task-children`), so a
   drag is always scoped to that container's own direct children. This is what makes parent
   reorder and subtask reorder independent — they are separate Sortables on separate <ul>s, not
   one Sortable trying to guess which descendant was grabbed.

   Cross-parent drag is now enabled (`group: { pull: true, put: true }`). When a task is dropped
   into a different container, `onEnd` reads the destination DOM to resolve the new parent task
   and section, then calls `store.reparentTask()` to persist that change, then
   `store.reorderTask()` to place the task at the exact dropped index. Cycles are physically
   impossible because the dragged task is removed from the DOM during drag — it never appears
   in its own subtree as a drop target.

   `scroll`, `scrollSensitivity`, `scrollSpeed`, and `bubbleScroll` add YouTube-style auto-scroll
   during drag. Dragging near the top or bottom edge of the viewport now scrolls the page, so a
   task can be dropped into a container that was off-screen when the drag started.
   `forceAutoScrollFallback: true` ensures SortableJS runs its own scroll logic on desktop
   browsers too, where native drag autoscroll would otherwise ignore the configured
   `scrollSensitivity` and `scrollSpeed`.

   `scrollSensitivity` is percentage-based (28% mobile, 15% desktop) and computed by
   `getScrollSensitivity()` against `innerHeight` at Sortable construction time — which is
   re-run on every `render()`, so orientation changes and window resizes are handled.

   Rules that still matter:

     1. `draggable: '> .task-item'` — the leading `>` is SortableJS's supported way to say
        "direct children only." `:scope > .task-item` is NOT supported (SortableJS does not
        implement `:scope` reliably) and was the cause of the subtask-does-not-drag symptom.

     2. `handle: '.task-drag-handle'` — only the handle initiates a drag; the rest of the row
        keeps its click behavior intact.

     3. `onEnd` calls the store functions and lets them handle persistence. Do not reassign
        `createdAt` or mutate `section`/`parentId` here — `reparentTask` and `reorderTask`
        already do it correctly, and duplicating the mutation desynchronizes the data.
   ================================================================================================ */

/**
 * Initializes a SortableJS instance on every task-list container in the current DOM.
 *
 * Called from render() after every render, so each container is torn down and re-created
 * against the freshly built <li> nodes. Because render() re-runs on window resize, the
 * percentage-based scroll sensitivity is re-evaluated whenever the viewport changes.
 *
 * The dragged item's new position is persisted through two store calls:
 *   - If dropped in a different container, `reparentTask(taskId, newParentId, newSection)` first,
 *     to update the task's parent and section.
 *   - Then `reorderTask(taskId, neighborId, 'before' | 'after')`, to place the task at the exact
 *     dropped index within its new siblings.
 */
function initSortable() {
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS not loaded.');
    return;
  }

  // Determine scroll sensitivity based on screen size (28% mobile, 15% PC).
  // We check against the existing ACTIONS_BREAKPOINT_PX (640) to match the mobile/desktop split.
  function getScrollSensitivity() {
    const isMobile = window.matchMedia(`(max-width: ${ACTIONS_BREAKPOINT_PX - 0.02}px)`).matches;
    const percentage = isMobile ? 0.28 : 0.15;
    return Math.round(window.innerHeight * percentage);
  }

  document.querySelectorAll('.task-list, .task-children').forEach((listEl) => {
    // Destroy any instance left over from the previous render before re-binding.
    if (listEl._sortableInstance) {
      listEl._sortableInstance.destroy();
      listEl._sortableInstance = null;
    }

    listEl._sortableInstance = new Sortable(listEl, {
      // Direct-child <li>s only. `>` is the supported way to scope this; `:scope` is not.
      draggable: '> .task-item',

      // Allow drags to move between lists (e.g., subtask to another parent).
      group: { name: 'tasks', pull: true, put: true },

      // Only the handle initiates a drag; the rest of the row keeps its click behavior.
      handle: '.task-drag-handle',

      animation: 150,

      // Keep the dragged row visually attached to the cursor across list boundaries.
      fallbackOnBody: true,
      swapThreshold: 0.65,

      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',

      // Move a task past the midpoint before reordering — avoids jitter on tall rows.
      invertSwap: false,

      // --- Auto-scroll ---
      scroll: true,
      forceAutoScrollFallback: true,
      scrollSensitivity: getScrollSensitivity(), // Dynamically calculated 28% / 15%
      scrollSpeed: 15,
      bubbleScroll: true,

      onEnd(evt) {
        // If dropped in the same position, nothing changed.
        if (evt.oldIndex === evt.newIndex && evt.from === evt.to) return;

        const draggedId = evt.item.dataset.taskId;
        if (!draggedId) return;

        // Determine if the task changed lists.
        const changedList = evt.from !== evt.to;

        if (changedList) {
          // Figure out the new parent and section from the target <ul>.
          let newParentId = null;
          if (evt.to.classList.contains('task-children')) {
            const parentItem = evt.to.closest('.task-item');
            if (parentItem) {
              newParentId = parentItem.dataset.taskId;
            }
          }

          // Determine the new section.
          let newSection = 'sort';
          const sectionEl = evt.to.closest('.task-section');
          if (sectionEl) {
            newSection = sectionEl.dataset.section;
          } else if (evt.to.dataset.listFor) {
            newSection = evt.to.dataset.listFor;
          }

          // Update the task's parent and section in the store.
          reparentTask(draggedId, newParentId, newSection);
        }

        // Now that the parent/section is updated, find the sibling to anchor to.
        const siblings = Array.from(evt.to.children).filter(
          (el) => el.classList && el.classList.contains('task-item')
        );

        const droppedIndex = siblings.indexOf(evt.item);
        if (droppedIndex === -1) return;

        const prevSibling = droppedIndex > 0 ? siblings[droppedIndex - 1] : null;
        const nextSibling = droppedIndex < siblings.length - 1 ? siblings[droppedIndex + 1] : null;

        let neighborId = null;
        let position = null;

        if (prevSibling) {
          neighborId = prevSibling.dataset.taskId;
          position = 'after';
        } else if (nextSibling) {
          neighborId = nextSibling.dataset.taskId;
          position = 'before';
        } else {
          // Dropped into an empty list (or as the sole child) — nothing to anchor to.
          // The reparentTask above already saved the new location, so we just render.
          render();
          return;
        }

        if (!neighborId) return;

        // Persist the new order.
        const changedOrder = reorderTask(draggedId, neighborId, position);
        if (changedOrder || changedList) {
          render();
        }
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
