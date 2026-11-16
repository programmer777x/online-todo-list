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
// 1.1 through 1.28 — prior rounds.
// 1.29 — Round 7 Item 4: History rows always render the label cell and
//        the tail cell, even when empty, so the CSS grid's four columns
//        line up across every row. Rows without a list name get an
//        empty .history-item-list span; rows without a closing quote
//        get an empty .history-item-tail span.
// 1.30 — Round 8 Item 2: History row text no longer carries a trailing
//        space before the closing quote. head.trimEnd() at the call site
//        in renderHistoryList(); splitTrailingQuote() and the snackbar
//        path are untouched.
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted event handling and initialization from app.js.
// - All prior additions carried forward unchanged.
// - Empty-cell rendering for the History grid (Item 4). See 1.29.
//
// ================================================================================================
//
// === FIXES ===
//
// - Prior rounds' fixes carried forward unchanged.
// - Rows without a list name shifted the text column left and broke
//   the shared grid alignment. The label cell is now always rendered
//   (empty when absent), and the tail cell is always rendered (empty
//   when the summary has no trailing quote). See 1.29.
// - History rows showed a space before the closing quote when the
//   recorded summary had a trailing space in its text. renderHistoryList()
//   now trims the head at the call site only, leaving the snackbar and
//   the grid layout unchanged. See 1.30.
//
// ================================================================================================

/* ================================================================================================
   SMALL HELPERS
   ================================================================================================ */

function splitTrailingQuote(text) {
  const s = String(text || '');
  if (s.endsWith('"')) {
    return { head: s.slice(0, -1), tail: '"' };
  }
  return { head: s, tail: '' };
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

    addTask(trimmed, 'sort', null, { record: false });
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

    (async () => {
      dom.pasteStatus.textContent = `Importing ${sanitizedTasks.length} tasks to cloud...`;
      for (let i = 0; i < newList.tasks.length; i++) {
        const task = newList.tasks[i];
        window.dispatchEvent(new CustomEvent('sync-task-change', {
          detail: { op: 'insert', task: { ...task, listId: newList.id } }
        }));
        await new Promise(r => setTimeout(r, 150));
      }
      dom.pasteStatus.textContent = `Successfully imported "${newList.name}".`;
      setTimeout(() => {
        if (dom.pasteStatus.textContent.startsWith('Successfully')) dom.pasteStatus.textContent = '';
      }, 5000);
    })();
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

  window.dispatchEvent(new CustomEvent('sync-list-change', {
    detail: { op: 'update', list: { id: list.id, name: list.name, created_at: Date.now() } }
  }));

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

function initSortable() {
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS not loaded.');
    return;
  }

  function getScrollSensitivity() {
    const isMobile = window.matchMedia(`(max-width: ${ACTIONS_BREAKPOINT_PX - 0.02}px)`).matches;
    const percentage = isMobile ? 0.28 : 0.15;
    return Math.round(window.innerHeight * percentage);
  }

  document.querySelectorAll('.task-list, .task-children').forEach((listEl) => {
    if (listEl._sortableInstance) {
      listEl._sortableInstance.destroy();
      listEl._sortableInstance = null;
    }

    listEl._sortableInstance = new Sortable(listEl, {
      draggable: '> .task-item',
      group: { name: 'tasks', pull: true, put: true },
      handle: '.task-drag-handle',
      animation: 150,
      fallbackOnBody: true,
      swapThreshold: 0.65,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      invertSwap: false,
      scroll: true,
      forceAutoScrollFallback: true,
      scrollSensitivity: getScrollSensitivity(),
      scrollSpeed: 15,
      bubbleScroll: true,

      onEnd(evt) {
        if (evt.oldIndex === evt.newIndex && evt.from === evt.to) return;

        const draggedId = evt.item.dataset.taskId;
        if (!draggedId) return;

        const changedList = evt.from !== evt.to;

        if (changedList) {
          let newParentId = null;
          if (evt.to.classList.contains('task-children')) {
            const parentItem = evt.to.closest('.task-item');
            if (parentItem) {
              newParentId = parentItem.dataset.taskId;
            }
          }

          let newSection = 'sort';
          const sectionEl = evt.to.closest('.task-section');
          if (sectionEl) {
            newSection = sectionEl.dataset.section;
          } else if (evt.to.dataset.listFor) {
            newSection = evt.to.dataset.listFor;
          }

          reparentTask(draggedId, newParentId, newSection);
        }

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
          render();
          return;
        }

        if (!neighborId) return;

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
  dom.listSelect.addEventListener('change', () => handleListSwitch(dom.listSelect.value));
  dom.listNewButton.addEventListener('click', handleListNew);
  dom.listRenameButton.addEventListener('click', handleListRename);
  dom.listDeleteButton.addEventListener('click', handleListDelete);

  dom.themeSelect.addEventListener('change', () => setTheme(dom.themeSelect.value));

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

  dom.pasteAddButton.addEventListener('click', handlePasteAdd);

  dom.exportButton.addEventListener('click', handleExport);
  dom.importButton.addEventListener('click', () => dom.importFile.click());
  dom.importFile.addEventListener('change', () => {
    const file = dom.importFile.files && dom.importFile.files[0];
    if (file) handleImportFile(file);
    dom.importFile.value = '';
  });

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

  document.addEventListener('click', (e) => {
    if (!ui.openMenuTaskId) return;
    if (e.target.closest('.task-action-menu')) return;
    if (e.target.closest('.task-menu-button')) return;
    closeMenu({ returnFocus: false });
  });

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
   HEADER COMPACT
   ================================================================================================ */

const HEADER_COMPACT_QUERY = '(max-width: 639.98px) and (orientation: portrait)';

function wireHeaderCompact() {
  const header = document.querySelector('.app-header');
  const primary = document.querySelector('.header-primary');
  const secondary = document.querySelector('.header-secondary');
  if (!header || !primary || !secondary) return;

  const theme = document.getElementById('theme-select');
  const loginBtn = document.getElementById('auth-button');
  const syncBtn = document.getElementById('sync-status-bar');
  const undoBtn = document.getElementById('undo-button');
  const redoBtn = document.getElementById('redo-button');
  const pillGroup = undoBtn ? undoBtn.closest('.header-pill-group') : null;

  const mql = window.matchMedia(HEADER_COMPACT_QUERY);

  function apply() {
    header.classList.toggle('header-compact', mql.matches);

    if (mql.matches) {
      if (theme && theme.parentNode !== secondary) {
        secondary.insertBefore(theme, secondary.firstChild);
      }
    } else {
      if (theme && theme.parentNode !== primary) {
        if (loginBtn && loginBtn.parentNode === primary) {
          primary.insertBefore(theme, loginBtn);
        } else {
          primary.appendChild(theme);
        }
      }
    }

    if (syncBtn && syncBtn.parentNode !== secondary) {
      secondary.appendChild(syncBtn);
    }
    if (pillGroup && pillGroup.parentNode !== secondary) {
      secondary.appendChild(pillGroup);
    }
    if (loginBtn && loginBtn.parentNode !== primary) {
      primary.appendChild(loginBtn);
    }

    window.dispatchEvent(new CustomEvent('sync-state-changed'));
  }

  apply();
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', apply);
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(apply);
  }
}


/* ================================================================================================
   UNDO / REDO
   ================================================================================================ */

const SNACKBAR_DURATION_MS = 5000;

function wireUndo() {
  const undoBtn = document.getElementById('undo-button');
  const redoBtn = document.getElementById('redo-button');
  const snackbar = document.getElementById('undo-snackbar');
  const snackbarText = document.getElementById('undo-snackbar-text');
  const snackbarTail = document.getElementById('undo-snackbar-tail');
  const snackbarBtn = document.getElementById('undo-snackbar-button');
  if (!snackbar || !snackbarText || !snackbarBtn) return;

  let snackbarTimer = 0;

  function hideSnackbar() {
    if (snackbarTimer) {
      clearTimeout(snackbarTimer);
      snackbarTimer = 0;
    }
    snackbar.hidden = true;
  }

  function showSnackbar(text, { hideButton = false } = {}) {
    const { head, tail } = splitTrailingQuote(text || 'Action applied');
    snackbarText.textContent = head;
    if (snackbarTail) snackbarTail.textContent = tail;
    snackbar.hidden = false;
    snackbarBtn.hidden = Boolean(hideButton);
    if (snackbarTimer) clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => {
      snackbarTimer = 0;
      snackbar.hidden = true;
      snackbarBtn.hidden = false;
    }, SNACKBAR_DURATION_MS);
  }

  function doUndo() {
    const store = window.store;
    if (!store || typeof store.undoLast !== 'function') return;
    const ok = store.undoLast();
    if (ok) {
      hideSnackbar();
      renderListSwitcher();
      render();
    }
  }

  function doRedo() {
    const store = window.store;
    if (!store || typeof store.redoLast !== 'function') return;
    const ok = store.redoLast();
    if (ok) {
      renderListSwitcher();
      render();
    }
  }

  window.addEventListener('history-recorded', (e) => {
    const detail = e && e.detail ? e.detail : null;
    if (!detail) return;
    showSnackbar(detail.summary || 'Action applied');
  });

  window.addEventListener('history-undo-failed', (e) => {
    const detail = e && e.detail ? e.detail : {};
    const failed = Number(detail.failedCount || 0);
    const undone = Number(detail.undoneCount || 0);
    const msg = failed > 0
      ? `Couldn't undo ${failed} change${failed === 1 ? '' : 's'}${undone > 0 ? ` (${undone} undone)` : ''}`
      : 'Undo failed';
    showSnackbar(msg, { hideButton: true });
  });

  snackbarBtn.addEventListener('click', () => {
    doUndo();
  });

  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      doUndo();
    });
  }

  if (redoBtn) {
    redoBtn.addEventListener('click', () => {
      doRedo();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z' || e.key === 'Z') {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (e.key === 'y' || e.key === 'Y') {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      doRedo();
    }
  });
}


/* ================================================================================================
   FAB MENU
   ------------------------------------------------------------------------------------------------
   History row order: [Undo N button] [list-name label] [summary text] [closing quote].
   All four cells are always rendered so the CSS grid columns line up across rows.
   ================================================================================================ */

function renderHistoryList() {
  const listEl = document.getElementById('history-list');
  const emptyEl = document.getElementById('history-empty');
  if (!listEl) return;

  const store = window.store;
  const entries = store && typeof store.loadHistory === 'function' ? store.loadHistory() : [];

  listEl.innerHTML = '';

  if (!entries || entries.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const total = entries.length;
  for (let displayIdx = 0; displayIdx < total; displayIdx++) {
    const entry = entries[total - 1 - displayIdx];
    const unwindCount = displayIdx + 1;

    const li = document.createElement('li');
    li.className = 'history-item';

    // 1. Undo button.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item-undo';
    btn.textContent = unwindCount > 1 ? `Undo ${unwindCount}` : 'Undo';
    btn.title = unwindCount > 1
      ? `Undo this entry and the ${unwindCount - 1} newer one${unwindCount - 1 === 1 ? '' : 's'}`
      : 'Undo this entry';
    btn.addEventListener('click', () => {
      const result = store.undoHistoryEntry(entry.id);
      renderHistoryList();
      if (result && result.ok) {
        renderListSwitcher();
        render();
      }
    });

    // 2. List-name label (ALWAYS rendered — empty when no list).
    const listId = entry.listId || (entry.undoAction && entry.undoAction.listId);
    const listName = listId && state.lists[listId] ? state.lists[listId].name : null;
    const labelEl = document.createElement('span');
    labelEl.className = 'history-item-list';
    labelEl.textContent = listName || '';

    // 3. Summary text (split at the trailing quote).
    const rawSummary = entry.summary || entry.kind || 'Change';
    const { head, tail } = splitTrailingQuote(rawSummary);

    const textEl = document.createElement('span');
    textEl.className = 'history-item-text';
    textEl.textContent = head.trimEnd();

    // 4. Tail (ALWAYS rendered — empty when no closing quote).
    const tailEl = document.createElement('span');
    tailEl.className = 'history-item-tail';
    tailEl.textContent = tail;

    li.appendChild(btn);
    li.appendChild(labelEl);
    li.appendChild(textEl);
    li.appendChild(tailEl);

    listEl.appendChild(li);
  }
}

function wireFabMenu() {
  const fab = document.getElementById('fab-menu-button');
  const panel = document.getElementById('fab-menu-panel');
  if (!fab || !panel) return;

  function setOpen(open) {
    if (open) {
      panel.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      renderHistoryList();
    } else {
      panel.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
    }
  }

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });

  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target)) return;
    if (e.target === fab || fab.contains(e.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      setOpen(false);
    }
  });

  window.addEventListener('history-recorded', () => {
    if (!panel.hidden) renderHistoryList();
  });
}


/* ================================================================================================
   AUTH UI
   ================================================================================================ */

function wireAuthEvents() {
  const btn = document.getElementById('auth-button');
  const modal = document.getElementById('auth-modal');

  if (!btn || !modal) return;

  btn.addEventListener('click', async () => {
    const session = window.sync ? window.sync.getSession() : null;
    if (session) {
      if (window.confirm('Sign out? Local data will remain on this device.')) {
        await window.sync.getClient().auth.signOut();
        sessionStorage.removeItem('hasSynced');
      }
    } else {
      dom.authTitle.textContent = 'Sign in to sync';
      dom.authSubtitle.textContent = 'Enter your email and we\'ll send you a sign-in link.';
      dom.authEmailHint.hidden = false;
      dom.authStepEmail.hidden = false;
      dom.authStepPassword.hidden = true;

      dom.authErrorEmail.textContent = '';
      dom.authErrorPassword.textContent = '';
      dom.authSentMsg.hidden = true;
      dom.authSendEmailBtn.hidden = false;
      dom.authEmailInput.value = '';
      dom.authPasswordInput.value = '';
      dom.authEmailInput.disabled = false;

      modal.showModal();
    }
  });

  dom.authClose.addEventListener('click', () => modal.close());

  dom.authPasswordToggle.addEventListener('click', (e) => {
    e.preventDefault();
    dom.authTitle.textContent = 'Sign in with password';
    dom.authSubtitle.textContent = 'Enter the password for your account.';
    dom.authEmailHint.hidden = true;
    dom.authStepEmail.hidden = true;
    dom.authStepPassword.hidden = false;

    dom.authEmailInput.disabled = false;
    dom.authPasswordInput.focus();
  });

  dom.authEmailToggle.addEventListener('click', (e) => {
    e.preventDefault();
    dom.authTitle.textContent = 'Sign in to sync';
    dom.authSubtitle.textContent = 'Enter your email and we\'ll send you a sign-in link.';
    dom.authEmailHint.hidden = false;
    dom.authStepEmail.hidden = false;
    dom.authStepPassword.hidden = true;

    dom.authEmailInput.disabled = false;
    dom.authEmailInput.focus();
  });

  dom.authSendEmailBtn.addEventListener('click', async () => {
    const email = dom.authEmailInput.value.trim();
    dom.authErrorEmail.textContent = '';

    if (!email) {
      dom.authErrorEmail.textContent = 'Please enter your email address.';
      return;
    }

    dom.authSendEmailBtn.textContent = 'Sending...';
    dom.authSendEmailBtn.disabled = true;

    try {
      const { error } = await window.sync.getClient().auth.signInWithOtp({
        email: email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin + window.location.pathname
        }
      });

      dom.authSendEmailBtn.textContent = 'Send sign-in link';
      dom.authSendEmailBtn.disabled = false;

      if (error) {
        dom.authErrorEmail.textContent = error.message;
      } else {
        dom.authSendEmailBtn.hidden = true;
        dom.authSentMsg.hidden = false;
        dom.authPasswordToggle.parentElement.hidden = true;
      }
    } catch (e) {
      dom.authSendEmailBtn.textContent = 'Send sign-in link';
      dom.authSendEmailBtn.disabled = false;
      dom.authErrorEmail.textContent =
        "Couldn't reach the server — check your connection and try again.";
    }
  });

  dom.authSignInPasswordBtn.addEventListener('click', async () => {
    const email = dom.authEmailInput.value.trim();
    const password = dom.authPasswordInput.value;

    dom.authErrorPassword.textContent = '';

    if (!email) {
      dom.authErrorPassword.textContent = 'Please enter your email address.';
      return;
    }
    if (!password) {
      dom.authErrorPassword.textContent = 'Please enter your password.';
      return;
    }

    dom.authSignInPasswordBtn.textContent = 'Signing in...';
    dom.authSignInPasswordBtn.disabled = true;

    try {
      const { data, error } = await window.sync.getClient().auth.signInWithPassword({
        email: email,
        password: password
      });

      dom.authSignInPasswordBtn.textContent = 'Sign in';
      dom.authSignInPasswordBtn.disabled = false;

      if (error) {
        dom.authErrorPassword.textContent = error.message;
      } else {
        modal.close();
      }
    } catch (e) {
      dom.authSignInPasswordBtn.textContent = 'Sign in';
      dom.authSignInPasswordBtn.disabled = false;
      dom.authErrorPassword.textContent =
        "Couldn't reach the server — check your connection and try again.";
    }
  });

  function submitCurrentStep() {
    if (!dom.authStepPassword.hidden) {
      dom.authSignInPasswordBtn.click();
    } else {
      dom.authSendEmailBtn.click();
    }
  }

  dom.authEmailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCurrentStep();
    }
  });

  dom.authPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCurrentStep();
    }
  });

  window.addEventListener('supabase-auth-changed', (e) => {
    const session = e.detail.session;
    if (session) {
      btn.textContent = session.user.email.split('@')[0];
      btn.title = "Click to sign out";
    } else {
      btn.textContent = 'Sign in to sync';
      btn.title = "Click to sign in";
    }
  });

  const initialSession = window.sync ? window.sync.getSession() : null;
  if (initialSession) {
    btn.textContent = initialSession.user.email.split('@')[0];
    btn.title = "Click to sign out";
  }
}


/* ================================================================================================
   SYNC STATUS BAR
   ================================================================================================ */

function wireSyncStatusBar() {
  const bar = document.getElementById('sync-status-bar');
  const textSpan = document.getElementById('sync-status-text');
  if (!bar || !textSpan) return;

  const LAST_SYNC_KEY = 'todolist.v1.lastSync';
  let updateAvailable = false;
  let syncing = false;

  function formatTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function idleShortLabel() {
    const lastSync = parseInt(localStorage.getItem(LAST_SYNC_KEY), 10);
    if (!lastSync) return '—';
    return formatTime(lastSync);
  }

  function idleFullLabel() {
    const lastSync = parseInt(localStorage.getItem(LAST_SYNC_KEY), 10);
    if (!lastSync) return 'Not synced yet';
    return `Last synced ${formatTime(lastSync)}`;
  }

  function renderBar() {
    const session = window.sync ? window.sync.getSession() : null;
    if (!session) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    bar.classList.toggle('is-syncing', syncing);
    bar.classList.toggle('is-error', false);

    if (syncing) {
      textSpan.textContent = 'Syncing…';
      bar.disabled = true;
      bar.title = 'Syncing…';
      return;
    }
    if (updateAvailable) {
      textSpan.textContent = 'Update available — tap to reload';
      bar.disabled = false;
      bar.title = 'Update available — tap to reload';
      return;
    }

    const short = idleShortLabel();
    const full = idleFullLabel();
    textSpan.textContent = short;
    bar.title = full;
    bar.setAttribute('aria-label', full);
    bar.disabled = false;
  }

  function showError() {
    const session = window.sync ? window.sync.getSession() : null;
    if (!session) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.classList.remove('is-syncing');
    bar.classList.add('is-error');
    const lastSync = parseInt(localStorage.getItem(LAST_SYNC_KEY), 10);
    const label = lastSync
      ? `Sync failed — tap to retry · Last synced ${formatTime(lastSync)}`
      : 'Sync failed — tap to retry';
    textSpan.textContent = label;
    bar.title = label;
    bar.disabled = false;
  }

  async function checkForUpdate() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return false;
      await registration.update();
      return !!(registration.waiting || registration.installing);
    } catch (e) {
      console.warn('Service worker update check failed:', e);
      return false;
    }
  }

  renderBar();

  window.addEventListener('supabase-auth-changed', () => {
    renderBar();
  });

  window.addEventListener('sync-state-changed', () => {
    renderBar();
  });

  bar.addEventListener('click', async () => {
    if (syncing) return;

    const session = window.sync ? window.sync.getSession() : null;
    if (!session) return;

    if (updateAvailable) {
      window.location.reload();
      return;
    }

    syncing = true;
    renderBar();

    let ok = false;
    try {
      if (window.sync && window.sync.syncNow) {
        ok = await window.sync.syncNow();
      }
    } catch (e) {
      console.warn("Sync failed", e);
      ok = false;
    }

    syncing = false;

    if (!ok) {
      showError();
      return;
    }

    renderListSwitcher();
    render();

    const hasUpdate = await checkForUpdate();
    if (hasUpdate) {
      updateAvailable = true;
      renderBar();
      return;
    }

    renderBar();
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
  wireAuthEvents();
  wireSyncStatusBar();
  wireHeaderCompact();
  wireUndo();
  wireFabMenu();
  render();

  initSortable();

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
