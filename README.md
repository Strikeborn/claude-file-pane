# Files pane (Claude Code mod)

A pane beside the Claude Code chat for browsing folders, reading and editing files, and keeping an eye on the project
the chat is working in. It's a Claude Code mod (hooks module), not an MCP server or an app.

Plugin name: `file-pane` · version 0.4.12 · open it with `/files`, `/files <project tab>` (`/files ticks`, `changes`,
`git`…) or `/files <path>`.

Claude's tools: `mcp__file-pane__open` (the pane at a folder or file), `show` (a file with its diff or one line
pointed at), `backups` (a file's backup copies), `notes` (your per-file notes), `ticks` (the checkboxes ticked
through the pane).

## Install

At the prompt of a Claude Code session:

```
/plugin install file-pane --marketplace Strikeborn/claude-file-pane
```

Answer `y` to add the marketplace, then pick a scope (just you, or this project). Open the pane with `/files`.

**Needs**: Windows (built and tested there; pictures, Explorer and thumbnails go through Windows), Node.js (the helper
that pages, saves and backs up) and git (the Git page, Changes, History). These add more, each optional; the Tools line
in ⋯ says which it found:

| Tool | Adds |
|---|---|
| [Everything](https://www.voidtools.com/) with `es.exe` in `C:\Program Files\Everything\` | folder sizes at once, from its index (otherwise counted in the background) |
| A JDK under `C:\Program Files` (Adoptium, Oracle, Microsoft, Zulu, BellSoft) | ☕ Bytecode and class diffs (`javap`) |
| `ilspycmd` (`dotnet tool install -g ilspycmd`) | C# for a .NET DLL, and its C# diff |
| Heimdall3D (`heimdall_probe` under Program Files) | .glb / .gltf previews with materials |
| VS Code | Open in VS Code |

Updates: `/plugin marketplace update claude-file-pane`, then reload.

## What it does

**One pane, three pages** (0.4.8): the bar's first row is **📁 Files · 🌿 Git · ☑ Project**, switched in place (in
0.4.7 Git and Project were their own dock tabs, extra tabs to close; Strike didn't want that). Every part of a page is a
**card** (a rounded box with a bold title and its count or state on the right; a folded card is its title row), and
lists are **tables** with a header row (folder: Name | Size | Modified | Git, the header sorts; Git's files: File | Kind
| Lines | Edited | Committed; commits: Commit | Author | When).

**The Files bar**: **🔎** (a folder's find box; a folder of more than 20 shows it by itself), **🕘 Recent ▾** (pinned
files, then the 8 opened last, in a short list under the bar; the folder view no longer lists them), **← →** (back and forward through the folders and files shown),
**↑** (the folder above, or an open file's folder), the path as buttons (a long one as the drive, …, and its last three
parts) and **⋯**, which opens the rest: ↩ Wrap, 👁 Follow Claude, ▤ Compact, **Go to** (type a path), the version and
the Tools line (⋯ shows ⚠ when a tool is missing or a newer pane waits).

**Files**
- Browse folders (the session's folder by default, any path through ⋯ → Go to), pinned and recent files; sort by name,
  size or date; 🔎 finds entries by part of their name; each file shows its size and date.
- **The folder is a tree** (0.4.9): a folder's ▸ opens it in place, its rows indented under it (⊞ Open all marks every folder
  under it open, any depth, up to 400 rows / 300 folders, and each still folds on its own; ⊟ Fold all); **folders show their
  total size** (from Everything's index when voidtools' `es.exe` is in `C:\Program Files\Everything\`, a few hundred ms; otherwise
  the helper's `dirsizes`: in the background, links and junctions not followed, 15 s / 400,000 entries at
  most, "≥" when cut short, kept 5 minutes; ModKeeper's 18 folders, 16 GB, took 5 s); Size sorts folders by it too;
  Git's state reaches the nested rows. Pages of 80 rows (◀ Previous / Next ▶).
- **👁 Follow Claude** (on by default, one setting for every chat, in ⋯): each file Claude **edits** opens in the pane
  with that edit's diff, and each file Claude **reads** opens with a "👁 Claude read lines a–b" band holding those lines
  (✕ closes it). Claude's own working files (memory, transcripts, tool results, temp files) aren't followed, and it
  never takes the pane from unsaved typing in another file (a note says what Claude edited instead). Off: a file open
  in the pane still reloads when Claude edits it. When you have unsaved typing for a file and Claude edits it, the
  pane and the band warn you (your typing stays in the editor; Save is refused because the file changed). Files Claude
  makes through Bash aren't seen (only Edit / Write / Read are).
- **▤ Compact**: shorter button labels for a narrow pane.
- **Tools** (in ⋯): which outside programs are there (Node, git, javap, ILSpy, Heimdall3D) and what a missing one is
  needed for.
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
  - **🗂 Files inside** a zip / jar (and .apk, .nupkg, .vsix, .docx…): size, date and name of each entry, read from
    the zip's own directory (zip64 archives aren't listed). Up to 300 files, each is a button that opens a copy of it
    (copied out to `~/.claude/file-pane-cache/zip`, its CRC checked; editing the copy changes nothing in the archive).
    More than 300: a 🔎 box finds files by part of their name, and each match is a button.
  - **☕ Bytecode (javap)** for a Java `.class`: `javap -c -p` from a JDK under Program Files.
  - **± Diff** against the last commit, as ModKeeper's update review does it: the readable text old vs new, the hex
    around where the bytes differ (one inserted / removed block is shown as such, not every later line changed), for a
    `.class` the bytecode diff (javap on both copies; when the bytecode is the same, what moved in its debug info:
    `javap -l` line numbers and local names), for a zip / jar which files inside were added, removed or changed (press
    one for its own diff: a class by javap, text as text, else readable text and hex), and
    for a .NET DLL **C# diff (ILSpy)** on a press (ILSpy on both copies, each cached).
- Pictures are drawn as SVG through Windows imaging (the desktop pane has no Image), up to 800 px and shown up to
  twice that, as wide as the pane allows. **◀ ▶** step through the pictures and models in the same folder ("3 of 12"),
  and **⤢ Open in its app** opens one in its own app (Photos, Heimdall3D's viewer…; the engine's Button can't hold a
  picture, so the picture itself isn't a button).
- 3D models and other files Explorer can preview (.fbx .obj .stl .3mf .ply .dae .glb .gltf .blend .exr .hdr .dds
  .tga .tif .psd .webp .heic) show Explorer's own thumbnail, made by whatever is installed for that type (Heimdall3D,
  Blender's BlendThumb). Only thumbnail makers under Program Files or Windows are used; for any other the pane shows
  Explorer's saved thumbnail if there is one. Text formats (.obj .gltf .dae .ply) also have Edit as text.
- **.glb / .gltf** are drawn by Heimdall3D's own renderer (`heimdall_probe.exe --gpu` from Program Files: materials and
  textures, 400 px, 2-4 s; its plain grey render when the GPU one fails), the PNG kept in
  `~/.claude/file-pane-cache/heimdall`; when it can't, Explorer's thumbnail as above. (Their Explorer thumbnail maker
  lives in %LOCALAPPDATA%, so the pane won't load it.)
- Every picture and model preview is drawn **once per file version**: the first time in the background (the pane says
  "Drawing the preview…" and stays usable), then kept in memory for redraws and in `~/.claude/file-pane-cache/previews`
  for other chats. A detailed one is sent as JPEG so it fits the pane in one go. **🔍 Closer** zooms a model's preview
  to its middle (1.5×, 2×).
- **↩ Wrap** (beside Files / Project, every view): long lines wrap onto more rows, or stay one row cut at the edge,
  everywhere the pane draws text (diffs side by side too, each line kept beside its pair). The editor box always wraps
  (the engine's field has no setting), so with Wrap off an open file reads as numbered code, one row a line, and
  ✎ Edit turns Wrap back on. Markdown documents always wrap (the engine's Markdown has no setting either).
- ± Diff of a file, one column or ⇆ side by side (there, the words that changed inside a line are highlighted), with
  **␣ Ignore spaces** (spaces, tabs, line endings, blank lines) and **# Line numbers** (each line's number in the old and
  new file). A text file compares with **the last commit**, its
  **backups** (the newest, or any of the newest 8, against the file now or against another backup), **the file opened
  before it** (open one, then the other, and press "vs <name>"), or **the file before Claude's edits**: before each of
  Claude's Edit / Write calls on a file the pane copies it to the backups folder, so Changes has **± Claude's change**
  per file (all of this session's edits, or from one edit on) and **↩ Put back** undoes them (all, or from that edit
  on; the current version backed up first). A picture's last-commit copy is a temp file in
  `~/.claude/file-pane-cache`, removed after drawing.
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
- **📅 Done dates** (off by default; one setting for every chat): a tick also writes `(done 2026-11-03 14:50)` after
  the item, so the date travels with the file; unticking takes such a date off.
- Project → **📅 Ticks**: the tick log by day (this project's files, or every folder), each with its headings and a
  button to open the file.

**Which pane a chat runs**
- In ⋯: `Files pane v<version> · deployed <date time>`. When a newer one has been deployed and this chat didn't
  reload it, a line under the top bar says so (open a new chat to get it). `node deploy.mjs` writes the stamp
  (`deployed.json` in the loaded copy); a copy run from this folder says "run from its source folder".

**🌿 Git window** (one page, read only: nothing commits, switches or pushes):
- Where the branch stands: `On main · ↑2 vs origin/main · 3 branches · 14 uncommitted`.
- **The graph**: a picture of every branch's newest 30 commits (main and each branch in its own coloured lane, merges as
  hollow dots, branch and tag names as labels, each commit's subject and age); ◀ Newer / Older ▶ page through.
- The same commits as rows (author, age, date): ▸ a commit shows its files, ▸ a file its diff.
- Folded sections: **Uncommitted changes** (📁 a folded tree or ☰ pages of 50; kinds when there's more than one;
  ↕ one sort button: Path, Recently edited, Most lines, Kind; 🔎 past 20 files; + / − lines; when each file was
  **edited** and **last committed**), **Claude's edits this chat** (with ± Claude's change and ↩ Put back),
  **Branches** (each with its last commit and ↑ ahead / ↓ behind its remote; **Compare** shows what's only on each
  side and the files that differ since they split).
- Fast: git's answers are kept and asked again in the background (4 s), so switching back draws at once.

**🕘 History** on an open file (Files window): its commits (following renames), each with its diff of this file, or
**Who changed each line** (git blame as runs of lines from one commit: lines, commit, author, age, subject).

**☑ Project** opens on a **dashboard** of cards, each title opening its full page in place (← Overview back): **🧭 Next**
(the first next-steps section of the handoff / next / todo docs), **☑ Items** (a bar per file, the files with most
open first), **▶ Checks** (each check's last result; hidden without a package.json), **🕒 Commits** (the newest five),
**📅 Ticks today**, and **More** (Log, Search, Backups, Notes, Features, Building blocks). A full page has one row of
tabs: Next, Items, Ticks, Timeline, Checks, Log, More ›.

**One toolbar row a view**: an open file's row is its main actions (Save, Revert, ± Diff, 🕘 History…) and **⋯** for the
rest (📂 Explorer, ☆ Pin, 📋 Copy path, VS Code, ↗ Its app, 🗒 Note). A folder's sort is one **↕** button (Name, Size,
Newest). Diff options (⇆ Side by side, ␣ Ignore spaces, # Line numbers) are in the bar's ⋯.
- A band above the prompt with the project's state (can be hidden).

## Files

| File | What |
|---|---|
| `.claude-plugin/plugin.json` | manifest (name, version, description, `types`) |
| `hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` |
| `hooks/register.tsx` | the mod: hooks, the pane, the band, the `/files` command, Claude's tools |
| `hooks/helper.cjs` | the Node helper (paging, backups, saves, binaries, zips, javap, ILSpy, Heimdall's probe), run as `node -- helper.cjs <command> …`: a file, because Windows took ~2.7 s to start `node -e` with 30 KB of code |
| `hooks/scripts.ts` | the PowerShell scripts (Windows imaging, the shell thumbnail) |
| `hooks/project.tsx` | pure parsers: markdown sections and tasks, heading paths, several-boxes lines and their split, side-by-side diff, commits, releases, features, building blocks |
| `types/index.d.ts` | the mod's `$.state` contract (`file-pane.*` keys) and its value types |
| `tests/pane.test.tsx` | checklists (counts, a tick logged and undone, the ticks tool, Only open, Edit mode, Split, Done dates, the Ticks tab) and the version line; presses every project tab and opens a file and a .md, in a non-git folder; flips ↩ Wrap through every view and draws a side-by-side diff both ways; opens a DLL in Info, Readable text, Hex and C# (ILSpy), a jar's file list (a file opened from it), its diff (which files changed), a class's javap and bytecode diff (and the debug-info diff when the bytecode is the same), a DLL's C# diff; checks that VS Code and the temp-file removal run without cmd.exe, that a model previews through the shell thumbnail (and a refused thumbnail maker says why), and a .glb through Heimdall's probe; Claude's change (copy before its Edit, ± Claude's change, Put back), vs backup (any of them) / commit / the file opened before, Ignore spaces, word highlights; Follow Claude, the conflict warning, the show / backups / notes tools, `/files <tab | path>`, the Tools line, breadcrumbs, sort and find, file tabs, line numbers, Compact |
| `tests/helper.check.mjs` | the helper run for real on samples it makes in a temp folder (two small classes and jars through a JDK's javac, stand-ins without one; the test model), so the repository holds no binaries (text, backups, rmtemp's limits, PE / zip / class info, zip entries and zip-slip names, a damaged zip, jar diffs, javap, the preview cache, Heimdall's probe; ILSpy with `FILE_PANE_SLOW=1`) |
| `scripts/prepush-check.mjs`, `.githooks/pre-push` | refuses a push carrying this machine's user name, home folder, a personal email or a key-shaped string |
| `scripts/release.mjs` | a git tag and GitHub release for the version (deploy runs it when all is committed) |
| `CHANGELOG.md` | what changed, by version |
| `samples/make-test-glb.mjs` (run by the helper test; `node samples/make-test-glb.mjs [out.glb]` by hand) | a test model for previews: a yellow star (material color), a red / blue checker plate (an embedded PNG texture) and a green cube |
| `tsconfig.json` | extends `.claude-plugin/types/tsconfig.json` (written by the engine when it loads the mod) |
| `deploy.mjs` | checks, then copies the mod into the folder every chat loads (not deployed itself), writes its `deployed.json` stamp (version, time), then tags and releases the version (`--no-release` skips that) |

## Working on it, and putting a change live

This folder is the source. Every chat loads a deployed copy, `~/.claude/mods/file-pane` (named by
`"env": { "CLAUDE_CODE_PLUGIN_DIRS": "…\\.claude\\mods\\file-pane" }` in `~/.claude/settings.json`). Edit here, then:

```
node deploy.mjs
```

It runs the four checks below, backs up the loaded copy to `~/.claude/file-pane-backups/deploy-<time>`, and copies the
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
node --test tests/helper.check.mjs
```

`validate` and the typecheck alone have missed real breakage (a blank pane, refused elements); always run the tests.
The pane test answers every program call itself; the helper test is where the helper meets real files.

## GitHub

Public repository `Strikeborn/claude-file-pane` (private until 2026-11-12). In a fresh clone, turn the pre-push check on once:
`git config core.hooksPath .githooks`. Each deploy (when everything is committed) tags `v<version>` and makes a GitHub
release with that version's CHANGELOG section.

More: `SECURITY.md` (what it can do, protections, findings). On disk only, not in the repository (agent working
notes, ignored by git since 2026-11-11): `CLAUDE.md` (engine rules learned the hard way), `IDEAS.md` (plans),
`NEXT_CHAT.md` (brief for the next agent), `TRY.md` (what to look at in the real pane), `SECURITY.local.md` (this
machine's security notes: other apps, the repository's history).

## License

The Files pane is free software under the [GNU General Public License v3.0](LICENSE) (or any later version). You can
use, study, change and share it. If you distribute a modified version, it has to stay under the GPL with its source
code available.
