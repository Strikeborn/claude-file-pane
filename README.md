# Files pane (Claude Code mod)

A pane beside the Claude Code chat for browsing folders, reading and editing files, and keeping an eye on the project
the chat is working in. It's a Claude Code mod (hooks module), not an MCP server or an app.

Plugin name: `file-pane` · version 0.2.0 · open it with `/files` (or Claude can open it on a file with the
`mcp__file-pane__open` tool; `mcp__file-pane__ticks` lists the checkboxes ticked through it).

## What it does

**Files**
- Browse folders (the session's folder by default, any path typed in), pinned and recent files.
- Open text files whole, or page by page when they're big (a log or config of any size: pages cut at a line end, so
  neither the 4 MiB read limit nor the pane's drawing limit stops it).
- Edit and save. **Every save backs the file up first** (`~/.claude/file-pane-backups`) and is refused when the file
  changed on disk since it was opened. Revert puts the last backup back. Nothing is ever deleted.
- Binary files are view only, in three views (ideas from ModKeeper's update review):
  - **ℹ Info**: what it is from its first bytes (PE, zip / jar, Java class, Unity bundle, SQLite…). For a DLL / EXE,
    its PE headers: version info (company, file version, product), build time, x86 / x64, .NET or machine code,
    sections, exports, and the DLLs and functions it imports.
  - **🔤 Readable text**: the names and messages inside (ASCII and UTF-16), with byte offsets, 1 MiB a page.
  - **🔢 Hex**: 16 bytes a line with offsets and the printable characters, 4 KiB a page.
  - **C# (ILSpy)** on a .NET DLL (RimWorld, Unity, BepInEx mods): decompiled by `ilspycmd` (if installed: `dotnet
    tool install -g ilspycmd`), kept in `~/.claude/file-pane-cache/ilspy` by the DLL's SHA-256, and opened like a
    file (paging, Search, Wrap).
- Pictures are drawn as SVG through Windows imaging (the desktop pane has no Image).
- 3D models and other files Explorer can preview (.fbx .obj .stl .3mf .ply .dae .glb .gltf .blend .exr .hdr .dds
  .tga .tif .psd .webp .heic) show Explorer's own thumbnail, made by whatever is installed for that type (Heimdall3D,
  Blender's BlendThumb). Only thumbnail makers under Program Files or Windows are used; for any other the pane shows
  Explorer's saved thumbnail if there is one. Text formats (.obj .gltf .dae .ply) also have Edit as text.
- **↩ Wrap** (beside Files / Project, every view): long lines wrap onto more rows, or stay one row cut at the edge,
  everywhere the pane draws text (diffs side by side too, each line kept beside its pair). The editor box always wraps
  (the engine's field has no setting), so with Wrap off an open file reads as numbered code, one row a line, and
  ✎ Edit turns Wrap back on. Markdown documents always wrap (the engine's Markdown has no setting either).
- ± Diff of a file against git, side by side (a picture's last-commit copy is a temp file in
  `~/.claude/file-pane-cache`, removed after drawing).
- Open in VS Code button (runs VS Code's own `Code.exe` + `cli.js`, found from its `code` command; no shell, so any file
  name is safe), Show in Explorer, open in its own app.
- Notes per file (kept in the mod's store).

**Markdown as documents**
- `.md` files read as documents: `- [ ]` tasks are clickable, sections have ✎ to edit just that section.
- "x of y done" beside every heading that has items under it (sections and their sub-headings), and **Only open** per
  section to hide its done items.
- **Every tick is logged** (file, item, the headings above it, ticked or unticked, when) in the mod's store, shared by
  every chat: the document shows **Ticked recently**, and agents ask the **`ticks` tool** (`mcp__file-pane__ticks`:
  by file or folder, since a time) for "what did I finish, when, where". Ticks made in another editor aren't seen.
- **↶ Undo** for the last tick for ten minutes, at the top of every view; an untick says so in the warning color.
- **✎ Edit mode** (per file): rows carry no ✎; with it on, a click on an item or heading edits its text in place
  (Enter saves, Cancel; the engine has no double-click or Esc).
- A line with several boxes (`- [ ] a - [ ] b`, where only the first is a real checkbox) gets a warning and
  **Split into items** (each keeps its own tick; backup first, as every write).

**Which pane a chat runs**
- Under Files / Project: `Files pane v<version> · deployed <date time>`. A chat keeps the pane it started with; when a
  newer one has been deployed since, the pane says so (new chats get it). `node deploy.mjs` writes the stamp
  (`deployed.json` in the loaded copy); a copy run from this folder says "run from its source folder".

**Project tabs** (for the session's folder)
- **Next** and **Items** (open tasks from the project's markdown), **Timeline** (commits with their times, releases),
  **Features** and **Building blocks** (read from the changelog / docs), **Changes** (files Claude edited this
  session, from its Edit / Write / NotebookEdit calls), **Git**, **Checks** (runs the project's npm scripts through
  cmd.exe and shows the failures), **Search** (git grep), **Backups** (with Put back), a live **Log**, **Notes**.
- A band above the prompt with the project's state (can be hidden).

## Files

| File | What |
|---|---|
| `.claude-plugin/plugin.json` | manifest (name, version, description, `types`) |
| `hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` |
| `hooks/register.tsx` | the whole mod: hooks, the pane, the band, the `/files` command, the `open` tool, the Node helper |
| `hooks/project.tsx` | pure parsers: markdown sections and tasks, heading paths, several-boxes lines and their split, side-by-side diff, commits, releases, features, building blocks |
| `types/index.d.ts` | the mod's `$.state` contract (`file-pane.*` keys) and its value types |
| `tests/pane.test.tsx` | checklists (counts, a tick logged and undone, the ticks tool, Only open, Edit mode, Split) and the version line; presses every project tab and opens a file and a .md, in a non-git folder; flips ↩ Wrap through every view and draws a side-by-side diff both ways; opens a DLL in Info, Readable text, Hex and C# (ILSpy); checks that VS Code and the temp-file removal run without cmd.exe, and that a model previews through the shell thumbnail (and a refused thumbnail maker says why) |
| `tsconfig.json` | extends `.claude-plugin/types/tsconfig.json` (written by the engine when it loads the mod) |
| `deploy.mjs` | checks, then copies the mod into the folder every chat loads (not deployed itself), and writes its `deployed.json` stamp (version, time) |

## Working on it, and putting a change live

This folder is the source. Every chat loads a deployed copy, `~/.claude/mods/file-pane` (named by
`"env": { "CLAUDE_CODE_PLUGIN_DIRS": "…\\.claude\\mods\\file-pane" }` in `~/.claude/settings.json`). Edit here, then:

```
node deploy.mjs
```

It runs the three checks below, backs up the loaded copy to `~/.claude/file-pane-backups/deploy-<time>`, and copies the
mod's files over (`.claude-plugin/plugin.json`, `hooks/`, `types/`, `tests/`, `tsconfig.json`, the docs). New chats
load it. Open chats reload it too when they were started with `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"` in the `env` of
`~/.claude/settings.json` (set 2026-11-03): desktop-app chats only watch a `CLAUDE_CODE_PLUGIN_DIRS` folder with it.
A reload keeps `$.state` and the store; what's typed and not saved goes. `node deploy.mjs --check` runs the checks only. Never edit the deployed copy: the next deploy replaces it.

To put a deploy back, copy the files from that `deploy-<time>` backup into `~/.claude/mods/file-pane`.

To try a change in one session before deploying: `claude --plugin-dir "F:\claude-file-pane"`.

Node must be on PATH for paging, backups and saves of a page (a small Node helper does them, no shell).

## Checks before calling a change done

```
claude plugin validate .
npx -p typescript tsc -p . --noEmit
claude plugin test .
```

`validate` and the typecheck alone have missed real breakage (a blank pane, refused elements); always run the test.

More: `CLAUDE.md` (engine rules learned the hard way), `SECURITY.md` (what it can do, protections, findings),
`IDEAS.md` (plans), `NEXT_CHAT.md` (brief for the next agent, local or cloud).
