# Online To Do List

A fast, private, offline-capable to-do list that runs entirely in your browser. No account, no
server, no build step. Your list is saved locally and stays on your device.

**Live:** https://programmer777x.github.io/online-todo-list/

---

## What it does (Stage 1)

- **Quick add** — type a task, press Enter. It lands in TO SORT by default.
- **Three sections** — URGENT, TO DO, TO SORT. Each section header has a small **+** to add
  directly into that section.
- **Add / edit / delete** — edit inline (double-click the text, or use the ✎ button).
- **Complete vs. Remove** — two separate actions. **Complete** marks the task with ✅ and keeps it
  in the list. **Remove** takes it out entirely.
- **Global decimal numbering** — one continuous sequence across URGENT → TO DO → TO SORT.
  Subtasks nest decimally (`3.1`, `3.2`, `3.1.1`). Numbers are derived from position, so removing
  a task renumbers the rest automatically with no gaps.
- **Subtasks** — the ↳ button on any task opens an inline input for a nested subtask.
- **Move between sections** — the dropdown on each task moves it to another section. This is how
  TO SORT items get sorted into the real list later.
- **Paste box** — paste many lines at once; each non-empty line becomes a TO SORT task.
  Duplicates are skipped and reported ("Added 4, skipped 2 duplicates").
- **Search** — filters visible tasks across all sections as you type.
- **Themes** — four built-in themes, switchable from the header, choice remembered.
- **Export / Import** — export the whole list as JSON; import replaces the current list after a
  confirm dialog.
- **Responsive** — works on phone (down to 360px) and desktop.

Everything saves to `localStorage` on every change and is restored on load.

---

## Run it locally

You have two options.

**Option 1 — just open the file.** Double-click `index.html`, or drag it into a browser. Everything
works from `file://` because there are no external requests and no modules that need a server.

**Option 2 — serve it locally.** From the project folder:

```bash
python3 -m http.server
```

Then open <http://localhost:8000>. This is closer to how GitHub Pages serves it, and is the
easier path if you want to test from another device on your network.

Either way: no install, no dependencies, no build.

---

## Deploy to GitHub Pages

The repo is already set up at https://github.com/programmer777x/online-todo-list.

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
| `app.js` | All logic: state, rendering, numbering, persistence, paste, search, export/import, theme. |
| `README.md` | This file. |

---

## Themes

Four themes ship in Stage 1. Switch from the header dropdown; your choice is saved.

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

Your list lives in your browser's `localStorage` under the key `todolist.v1.state`. It never leaves
your device. There is no analytics, no tracking, and no network request of any kind.

Clearing your browser's site data will clear your list. Export a JSON backup periodically if the
list matters to you.

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
