// Config Version 1.0
//
// ================================================================================================
//
// Configuration constants for the Online To Do List app.
//
// This file is the single source of truth for:
//   - Storage keys and schema versions
//   - Supabase project credentials (URL and publishable key)
//   - The three section identifiers and their human-facing labels
//   - The four available themes and the default
//   - The default name for newly created lists
//   - The breakpoint at which the mobile ⋯ menu replaces inline actions
//
// It defines only constants. It has no logic, no side effects, and no dependencies. It must be
// loaded before store.js, render.js, and ui.js. `js/supabase.js` (the local UMD build) must be
// loaded before this file, since the constants below refer to the global it publishes.
//
// ================================================================================================
//
// === REVISIONS ===
//
// 1.1 — Supabase Stage 3. Added SUPABASE_URL and SUPABASE_ANON_KEY for the
//       supabase-sync branch. The UMD client itself is hosted locally as
//       js/supabase.js (loaded before this file) to preserve the brief's
//       no-build-step / no-ES-modules / file:// constraints. Existing
//       STORAGE_KEY and STATE_VERSION are unchanged.
//
// ================================================================================================
//
// === ADDED ===
//
// - Initial creation. Extracted the constants block from the original app.js.
//
// - SUPABASE_URL and SUPABASE_ANON_KEY. The publishable key format
//   (sb_publishable_...) replaces the older anon key; the Supabase UMD client
//   accepts it as-is. These are public client credentials by design; access
//   control lives in the database's Row Level Security policies, not in the
//   secrecy of this key.
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

// Supabase Configuration
const SUPABASE_URL = 'https://jtofjiuukafazzalptdv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wRn0IHPpVqzLqvBLug56XQ_ktnlgZrV';

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
