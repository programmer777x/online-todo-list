# Online To Do List

A fast, private, offline-capable to-do list that runs entirely in your browser. No account, no
server, no build step. Your lists are saved locally and stay on your device.

**Live:** https://programmer777x.github.io/online-todo-list/

---

## What it does (Stage 1)

### Multiple lists
- The app holds several **independent lists** (e.g. `Main`, `Testing`).
- Switch lists from the header — instant, no reload. Each list has its own tasks, sections, and
  numbering. The theme is global; switching lists does not change it.
- **＋** creates a list, **✎** renames the active one, **🗑** deletes it (with a confirm).
- The last remaining list cannot be deleted. The delete control disables when only one list exists.
- The active list and all lists survive reload.

### Tasks
- **Quick add** — type a task, press Enter. It lands in TO SORT by default.
- **Three sections** — URGENT, TO DO, TO SORT. Each section header has a small **+** to add
  directly into that section.
- **Add / edit / delete** — edit inline (double-click the text, or use the ✎ button).
- **Complete vs. Remove** — two separate actions. **Complete** marks the task with ✅ and keeps it
  in the list. **Remove** takes it out entirely.
- **Global decimal numbering** — one continuous sequence across URGENT → TO DO → TO SORT, per list.
  Subtasks nest decimally (`3.1`, `3.2`, `3.1.1`). Numbers are derived from position, so removing
  a task renumbers the rest automatically with no gaps.
- **Subtasks** — the ↳ button on any task opens an inline input for a nested subtask.
- **Move between sections** — the dropdown on each task moves it to another section. This is how
  TO SORT items get sorted into the real list later.
- **Paste box** — paste many lines at once; each non-empty line becomes a TO SORT task.
  Duplicates are skipped and reported ("Added 4, skipped 2 duplicates").
- **Search** — filters visible tasks across all sections as you type.

### Data and appearance
- **Themes** — four built-in themes, switchable from the header, choice remembered globally.
- **Export / Import** — export the **active list** as JSON; import a JSON file and it becomes a
  **new list**, without touching any existing list. You're prompted for the new list's name,
  pre-filled from the file.
- **Responsive** — works on phone (down to 360px) and desktop.

Everything saves to `localStorage` on every change and is restored on load.

---

## Run it locally

**Option 1 — just open the file.** Double-click `index.html`, or drag it into a browser. Everything
works from `file://` because there are no external requests and no modules that need a server.

**Option 2 — serve it locally.** From the project folder:

```bash
python3 -m http.server
```

Then open <http://localhost:8000>. This is closer to how GitHub Pages serves it, and is the easier
path if you want to test from another device on your network.

Either way: no install, no dependencies, no build.

---

## Testing safely

The app stores your real list in your browser's `localStorage`. A wrong click during testing can
destroy real data, so follow these habits.

1. **Use a `Testing` list for anything destructive.** Create one with the **＋** in the header and
   switch to it before experimenting with remove, delete-list, or import. Your `Main` list is
   untouched while you work in `Testing`.
2. **Export a JSON backup before you test.** The **Export active list** button downloads a file you
   can re-import if something goes wrong. Do this before any import test, before deleting a list,
   and before clearing browser data.
3. **Use an incognito / private window for fresh-state tests.** It gets its own empty
   `localStorage`, so you can test the first-run experience and the migration path without risking
   your real data. Close the window and everything resets.
4. **Remember there is no undo.** Remove deletes immediately; list delete confirms but then commits.
   The only recovery is a JSON backup you made earlier. If a list matters, export it.
5. **The last list cannot be deleted.** This is deliberate — the app always has somewhere to put
   tasks. Deleting down to one list and then trying to delete that one is a safe no-op (the control
   is disabled).

---

## Deploy to GitHub Pages

The repo is set up at https://github.com/programmer777x/online-todo-list.

1. Push `index.html`, `styles.css`, and `app.js` to the `main` branch at the repo root.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Set **Branch** to `main` and **Folder** to `/ (root)`. Save.
5. Wait a minute or two. The site goes live at
   https://programmer777x.github.io/online-todo-list/.

Every push to `main` redeploys automatically.

---

## Files

| File | What it is |
|---|---|
| `index.html` | Page skeleton. No inline styles, no inline scripts. |
| `styles.css` | All layout and all four themes. |
| `app.js` | All logic: state, lists, rendering, numbering, persistence, paste, search, export/import, theme. |
| `README.md` | This file. |

---

## Themes

Four themes ship in Stage 1. Switch from the header dropdown; your choice is saved globally.

- **Twilight Brand** (default) — indigo-to-teal gradient, frosted glass cards, white text, glowing
  teal accents.
- **Midnight Terminal** — near-black background, phosphor-green accents, monospace type.
- **Clean Paper** — warm off-white, soft shadows, charcoal text, one terracotta accent.
- **LuMi Avocado** — soft cream, avocado-green accents, chunky rounded cards.

Each theme is a single block of CSS custom properties in `styles.css` under a `[data-theme="..."]`
selector. To add a fifth theme:

1. Copy any existing `[data-theme]` block in `styles.css` and rename the selector.
2. Override the tokens you want to change.
3. Add an `<option value="your-theme">Your Theme</option>` to the `#theme-select` in `index.html`,
   and add the theme name to the `THEMES` array in `app.js`.

No other file needs to change.

---

## Data and privacy

Your lists live in your browser's `localStorage` under the key `todolist.v1.state`. They never leave
your device. There is no analytics, no tracking, and no network request of any kind.

Clearing your browser's site data will clear every list. Export JSON backups periodically if the
lists matter to you.

**Storage format note:** the saved state carries a `version` field (currently `2`). An earlier
single-list format (`version: 1`) is migrated automatically on first load — an existing list is
folded into a list named `Main`, and nothing is lost.

---

## Roadmap

Stage 1 is what ships today. The rest is planned, not built.

**Stage 2 — still static, still GitHub Pages.** Due dates and browser notifications, recurring
tasks, drag-to-reorder, a Today view, tags and filters, dark mode, keyboard shortcuts, and PWA
packaging so it installs to a phone home screen and works fully offline.

**Stage 3 — backend migration.** Accounts, cross-device sync, email reminders, shared lists,
attachments, and paid tiers with usage metering. This is where a server enters the picture.

Out of scope for Stage 1 (do not expect these yet): due dates, reminders, recurring tasks,
drag-reorder, calendar views, tags, PWA/offline packaging, accounts, sync, collaboration,
attachments, and payments.

---

## License

Personal project. No license file yet — add one before making the repo public if you intend to
share or accept contributions.
