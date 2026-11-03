# Changelog: Files pane

Newest first. Version is `.claude-plugin/plugin.json`'s; deploy times are local.

## Unreleased

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
