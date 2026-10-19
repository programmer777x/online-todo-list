// Config Version 1.0
//
// ================================================================================================
//
// Configuration constants for the Online To Do List app.
//
// This file is the single source of truth for:
//   - Storage keys and schema versions
//   - The three section identifiers and their human-facing labels
//   - The four available themes and the default
//   - The default name for newly created lists
//   - The breakpoint at which the mobile ⋯ menu replaces inline actions
//
// It defines only constants. It has no logic, no side effects, and no dependencies. It must be
// loaded before store.js, render.js, and ui.js.
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
// - Initial creation. Extracted the constants block from the original app.js.
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

const STORAGE_KEY = 'todolist.v1.state';
const STATE_VERSION = 2;

const SECTIONS = ['urgent', 'todo', 'sort'];

const SECTION_LABELS = {
  urgent: 'URGENT',
  todo: 'TO DO',
  sort: 'TO SORT',
};

/** Short human names for the move-menu items. */
const SECTION_MOVE_LABELS = {
  urgent: 'Move to Urgent',
  todo: 'Move to To Do',
  sort: 'Move to To Sort',
};

const THEMES = ['twilight', 'terminal', 'paper', 'avocado'];

const DEFAULT_THEME = 'twilight';

const DEFAULT_LIST_NAME = 'Main';

/**
 * Breakpoint (in px) below which the ⋯ action menu is used. Must match the media query in
 * css/base.css section 14. Kept here so JS and CSS agree on one number.
 */
const ACTIONS_BREAKPOINT_PX = 640;
