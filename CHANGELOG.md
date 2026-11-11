# Changelog: Files pane

Newest first. Version is `.claude-plugin/plugin.json`'s; deploy times are local.

## 0.4.11 (deployed 2026-11-11 17:49)
- ⊞ Open all marks each folder open on its own (any depth, until 400 rows or 300 folders), so ▾ folds any one of them
  again; in 0.4.10 it was a switch that reopened them (and stopped at an arbitrary three levels).

## 0.4.10 (deployed 2026-11-11 17:40)
- The folder tree: ⊞ Open all (every folder, three levels deep, a page of rows at a time) and ⊟ Fold all.
- Folder sizes from Everything's index when voidtools' es.exe is in `C:\Program Files\Everything\` (a few hundred ms a
  folder); folders it doesn't answer for, and every folder without es.exe, are counted by the helper as before. The
  Tools line names Everything.

## 0.4.9 (deployed 2026-11-11 17:15; after Strike's look at 0.4.8)

### The folder as a tree
- A folder's ▸ opens it in place, its rows indented under it (Git's state on nested rows too).
- Folders show their total size, counted in the background and kept 5 minutes (≥ when cut short); Size sorts by it.
- Pages of 80 rows instead of a list that grows.

### Less doubled
- No row of recent-file tabs above an open file: 🕘 Recent ▾ has them.
- 👁 Follow Claude skips Claude's own working and temp files on edits too (Claude's scratch scripts were opening and
  filling Recent), and Recent leaves them out.
- The folder view's git state comes from the kept git answers (it ran git on every redraw).

## 0.4.8 (deployed 2026-11-11 16:56; Strike's picks after 0.4.7)

### One pane again
- Files · Git · Project are the bar's first row, switched in place: no extra dock tabs to close (0.4.7's windows).

### Cards and columns
- Every part of a page is a card (title, count on the right; folded = its title row).
- Lists are tables with a header: the folder (Name | Size | Modified | Git; the header sorts, ↕ is gone), Git's files
  (File | Kind | Lines | Edited | Committed), commits (Commit | Author | When).

### Project dashboard
- Project opens on cards: Next, Items (a bar per file), Checks, Commits, Ticks today, More; a card's title opens its
  page, ← Overview goes back.

### Files
- 🕘 Recent ▾ in the bar (pinned, then the 8 opened last) instead of the lists above the folder; 🔎 in the bar opens
  the find box (a folder of more than 20 shows it by itself).

## 0.4.7 (deployed 2026-11-11 16:29; 2026-11-11 UI pass, round 3: Strike's picks after 0.4.6)

### Three windows
- 📁 Files, 🌿 Git and ☑ Project are their own panes (tabs in the dock), each with at most one row of tabs; the Files |
  Project switch and Project's groups are gone. Each bar has buttons for the other windows.
- Project: one row (Next, Items, Ticks, Timeline, Checks, Log, More ›: Search, Backups, Notes, Features, Building
  blocks).

### Git as one page
- A graph picture of every branch's newest commits (lanes, merges, branch and tag labels, ages), the commits as rows
  (▸ files, ▸ a file's diff), then folded: Uncommitted changes, Claude's edits this chat, Branches (with Compare).

### Tidier
- One toolbar row a view: a file's rarer actions (Explorer, Pin, Copy path, VS Code, Its app, Note) under its own ⋯;
  diff options in the bar's ⋯; a folder's sort and the Git list's sort are one ↕ button each; kind buttons only when
  there's more than one kind; the Git list's 🔎 only past 20 files.

### Quicker
- A tab press is one state change (it was two, so two whole redraws). Git's answers are kept and asked again in the
  background; file dates fill in in the background.

## 0.4.6 (deployed 2026-11-11 15:42; the 2026-11-11 UI pass, rounds 1 and 2: Strike's picks in NEXT_CHAT.md → Strike's directions)

### A tidier pane
- One slim top bar: Files | Project, ← → (back and forward through folders and files), ↑, the path as buttons, and ⋯
  holding Wrap, Follow Claude, Compact, Go to (a path), the version and the Tools line. The version shows outside ⋯
  only when a newer pane waits; ⋯ shows ⚠ when a tool is missing.
- Project's 13 tabs in four groups (Work, History, Run, About) with the picked group's tabs under them; Git hides
  outside a repository, Checks without a package.json.
- The folder view's own path row and ↑ Up, and each file view's ← Folder, are gone (the top bar has them).

### Follow Claude
- On by default and one setting for every chat (it was off, and per chat, so it never seemed to follow).
- Follows reads too: the file opens with a "👁 Claude read lines a–b" band holding those lines. Claude's own working
  files aren't followed, and neither edits nor reads take the pane from unsaved typing in another file.

### Pictures
- Drawn up to 800 px (was 420) and shown as wide as the pane allows. ◀ ▶ step through the folder's pictures and
  models; ⤢ Open in its app.

### Git
- Changed files: when each was edited and last committed (new ones in green), and Sort: Recently edited.
- History: the commits, 50 a page; a commit's files and each file's diff.
- Branches: last commit, ahead / behind the remote, and Compare (commits only on each side, files that differ).
- 🕘 History on an open file: its commits with this file's diff, or who changed each line (blame).

## 0.4.5 (deployed 2026-11-06 14:16)
- 📜 Log's 2 s follow timer ends itself once the Log tab hasn't been drawn for 10 s. Before, leaving it for the Files
  view or closing the pane kept it redrawing every 2 s (each Files redraw runs git status) until another Project tab.

## 0.4.4 (deployed 2026-11-05 12:24)
- Project → Git / Changes: never more than 50 rows drawn (0.4.3's ⤓ Show more still hung at 180). 📁 Folders: a
  folded tree, each folder with its file count and + / − lines (a folder holding one folder shows as one, src/ui);
  ☰ List: pages of 50 (◀ Previous / Next ▶). Kinds (All / Changed / New / Deleted, with counts), Sort (Path or
  Newest / Most lines / Kind), 🔎 find by part of a path. Each file shows + / − lines against the last commit (git
  numstat; new files counted by the helper's `lines`), and the header totals them. No Open on a deleted file.

## 0.4.3 (deployed 2026-11-05 11:53)
- Project → Timeline: each version says what it changed, a summary line from its changelog (its ### sections, else
  each point's bold lead); ▸ unfolds every point.
- Project → Git / Changes: a long list of files shows 60 at a time (⤓ Show more). A repo with 347 changed files
  (ModKeeper's) hung the desktop pane: tabs stopped changing and it kept loading. Git's file names keep their case
  (they showed in lower case).

## 0.4.2 (deployed 2026-11-03)
- Faster: the Node helper is a file (`hooks/helper.cjs`), not `node -e` with 30 KB of code; Windows took ~2.7 s to
  start each call that way, a file ~0.1 s. Every save, backup, preview-cache read and binary view gets quicker.
- 👁 Follow Claude: each file Claude edits opens with that edit's diff. A file open in the pane reloads when Claude
  edits it; with unsaved typing for it, a warning in the pane and the band instead.
- Claude's tools: `show` (a file, with its diff or one line pointed at), `backups`, `notes`. `/files <tab | path>`.
- A Tools line (Node, git, javap, ILSpy, Heimdall3D: found or not, and what a missing one is for).
- Folders: breadcrumbs, sort by name / size / date, 🔎 find, dates beside files; recent files as tabs; # Line
  numbers in diffs; ▤ Compact labels.
- Checks: `tests/helper.check.mjs` runs the helper on real samples (in `deploy.mjs --check`). GitHub: a pre-push check
  for personal data and keys, and a tag + release per deploy.

## 0.4.1 (deployed 2026-11-03 17:47)
- A jar / zip's ± Diff: each added / removed / changed file is a button for its own diff (a class by javap, text as
  text, anything else as readable text and hex), from the last commit's copy and the file now, nothing unpacked to disk.
- 🗂 Files inside a zip of more than 300 files: a 🔎 box finds files by part of their name; each match opens.
- Diffs: a backup against another backup (not only against the file now); Claude's change from one edit on (a copy is
  made before each of Claude's Edit / Write calls, not only the first), with Put back for that edit and later.

## 0.4.0 (deployed 2026-11-03 17:30)
- Binaries: 🗂 Files inside lists each file as a button (up to 300) that opens a copy of it (copied out to
  `file-pane-cache\zip`, CRC checked, read only); a zip / jar's ± Diff says which files inside were added, removed or
  changed; a class whose bytecode is the same shows what moved in its debug info (`javap -l`); a .NET DLL's ± Diff has
  **C# diff (ILSpy)** (ILSpy on both copies, on a press).
- Diffs: a text file against any of its backups (the newest 8 to pick from), or against the file opened before it
  (open one, then the other).
- A private GitHub copy of this repository (`Strikeborn/claude-file-pane`), for cloud agents.

## 0.3.2 (deployed 2026-11-03 16:10)
- Model Organizer / ModKeeper integration dropped from the plans (Strike doesn't want it).
- A cached Heimdall render says "GPU" too (Strike saw "heimdall_probe" without it on the star, which was a GPU
  render made earlier by hand); a plain fallback render is kept as `<key>-plain.png`.

## 0.3.1 (deployed 2026-11-03 15:51)
- .glb / .gltf: Heimdall's GPU render (materials, textures); 0.3.0 used its plain grey render, so they looked bare.
- Previews drawn once per file version, in the background, kept in memory and on disk (`file-pane-cache\previews`):
  Explorer's thumbnail took ~6 s on every open and every redraw before. Detailed ones go as JPEG (no more retrying
  at smaller sizes). 🔍 Closer zooms a model preview.
- `samples/star-test.glb` (and its maker script) to check previews: colors, a texture, several materials.

## 0.3.0 (deployed 2026-11-03 15:18)
- .glb / .gltf previews drawn by Heimdall3D's `heimdall_probe` (from Program Files), cached; Explorer's thumbnail when
  it can't.
- Binaries: 🗂 Files inside a zip / jar, ☕ Bytecode (javap) for a `.class`, ± Diff against the last commit (readable
  text, hex with one inserted block shown as such, and javap's bytecode diff for a class).
- Diffs: the words that changed highlighted side by side; ␣ Ignore spaces; a text file vs its newest backup or vs the
  file before Claude's edits (a copy made before Claude's first Edit / Write of it in a session), with ± Claude's
  change in Changes and ↩ Put back.
- Checklists: Project → 📅 Ticks (the tick log by day, this project or every folder); 📅 Done dates writes
  "(done <date time>)" after a ticked item.
- This folder is a git repository (local, not pushed).

## 0.2.0 (deployed 2026-11-03 14:18; wording redeploy 14:38)
- Checklists: tick log in the mod's store and the `ticks` tool, ↶ Undo, x of y per heading, Only open per section,
  ✎ Edit mode, Split for several boxes on one line.
- Version + deploy time under Files / Project, and "a newer pane was deployed" when this chat is behind.
- 14:38: deploy message and the "newer pane" note describe the folder watch (`CLAUDE_CODE_PLUGIN_DIR_WATCH=1`); first
  deploy seen reloading an open chat.

## Before 0.2.0 (2026-10-27 to 2026-11-02)
- 2026-11-01: binary view: Info (PE version info, exports, imports), Readable text, Hex, C# through ILSpy.
- 2026-10-31: ↩ Wrap toggle for every view.
- 2026-10-31: shell thumbnails for 3D models (thumbnail makers outside Program Files / Windows refused).
- 2026-10-31: Open in VS Code and temp removal without cmd.exe (SECURITY findings 1, 2 fixed); own folder
  `claude-file-pane`.
- 2026-10-27: first version: browse, open / page / edit with backups, Markdown documents, project tabs, band.
