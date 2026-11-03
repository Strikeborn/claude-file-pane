# Changelog: Files pane

Newest first. Version is `.claude-plugin/plugin.json`'s; deploy times are local.

## Unreleased

## 0.3.1 (2026-11-03, not deployed yet)
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
