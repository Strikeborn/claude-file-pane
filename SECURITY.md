# Security notes: Files pane

The pane runs inside Claude Code with the user's rights: it reads and writes files, and starts programs. This file
says what it can do, what protects the user, and what was found. Keep it current: every change that touches files,
processes, paths or outside data adds a line here (and a finding when one turns up, fixed or not).

Cross-project notes (both Electron apps, checklists, tool ideas): `F:\security` (in the vault as `security/`),
especially `App security checks.md`. When this mod gains a check worth comparing, add it there too.

## What it can do

| Power | Where | Why |
|---|---|---|
| Read any file the user can | `$.fs.read`, the Node helper (pages) | browse and view |
| Write files | Node helper (`page` / `splice` / `restore`) | save edits, Put back |
| Remove one file | Node helper `rmtemp` | a diff's own temp file (picture or binary at the last commit), only `last-commit-<time>.<ext>` directly in `file-pane-cache`; and `textDiff` removes the two files it just wrote in `file-pane-cache\diff` |
| Run `node -e <HELPER>` | `helper()` | paging, backups, saves (no shell) |
| Run `git` (log, status, diff, grep, show) | `git()`, Timeline, Changes, Search | project tabs |
| Run `npm run <script>` through `cmd.exe` | Checks | only script names matching `test|build|lint|typecheck|check|tsc` |
| Run `powershell.exe` | `thumb()` | pictures through Windows imaging, path single-quoted (`'` doubled) |
| Keep a tick log (`$.store` key `ticks`: file paths and item texts from the user's Markdown, 2,000 kept) | toggleTask, `ticks` tool | "what did I finish, when, where"; stays in the mod's store under `~/.claude`, shared by the user's chats; agents read it through the `ticks` tool, nothing is sent anywhere |
| Rewrite a line into several (Split into items) | `splitBoxes` + `replaceLines` | a line holding several boxes; backup first, refused when the line changed |
| Read `deployed.json` (the loaded copy's and `~/.claude/mods/file-pane`'s) | `deployInfo()` | version / deploy time, and spotting a newer deploy; `deploy.mjs` writes it |
| Read binaries (`bininfo` / `strings` / `hex` in the helper) | binary view | what a DLL / file is, its text and bytes: read as data (64 MiB at most for Info, 1 MiB / 4 KiB pages), nothing loaded or run |
| Run `%USERPROFILE%\.dotnet\tools\ilspycmd.exe <dll>` (argv, from the helper) | C# (ILSpy) button | decompile a .NET DLL to C#; ILSpy reads the DLL, nothing in it runs. 64 MiB at most, 5 min timeout, output cached in `file-pane-cache\ilspy` by SHA-256 |
| Ask Windows for a file's thumbnail (`IShellItemImageFactory`, C# through `Add-Type` in that PowerShell) | `thumb(path, true)`, `SHELL_THUMB_PS` | 3D models and other files Explorer previews: the installed thumbnail maker reads the file, as when Explorer shows the folder |
| Run `explorer.exe` | buttons | reveal, open in its own app |
| Run `%ProgramFiles%\Heimdall3D\heimdall_probe.exe --gpu <model> <png> --size 400 --samples 16` (then, if that fails, its plain mode) (argv, from the helper `probe`) | .glb / .gltf preview | Heimdall's renderer reads the model (and the textures it names) and writes a PNG to `file-pane-cache\heimdall` (by path + size + modified time; a git temp copy by its bytes). Only that path under Program Files, one file, 60 s timeout each try. GPU mode may start Heimdall's own helper process, as its viewer does |
| Keep drawn previews (`file-pane-cache\previews\<sha1 of kind|path|size|modified>.json`, helper `pcache`) | every picture / model preview | base64 PNG / JPEG of what the pane showed, so a later chat skips the 2-6 s draw. Pictures of the user's files stay in their profile; the folder grows (nothing removes old ones: finding 8's "clear old" idea covers it) |
| Run a JDK's `javap.exe -c -p <class>` (argv, helper `javap`) | ☕ Bytecode, a class's ± Diff | only from `%ProgramFiles%\{Eclipse Adoptium, Java, Microsoft, Zulu, BellSoft}\*\bin` (not PATH or JAVA_HOME); javap reads the class, nothing in it runs; 16 MB, 30 s |
| Run `git diff --no-index` on two files | ± Diff vs a backup / before Claude's edits; binary and javap diffs (helper `textDiff`) | the helper's own two temp files go in `file-pane-cache\diff` and are removed right after; the pane's diff passes a backup and the file |
| Read a zip / jar's directory (helper `ziplist`) and two binaries whole (`bindiff`, 64 MB each) | 🗂 Files inside, binary ± Diff | read only: nothing is unpacked or run |
| Copy a file before Claude's first Edit / Write of it in a session (`snapshotBefore`, the helper's `backup`) | ± Claude's change, ↩ Put back | into the backups folder like every pane backup (32 MB at most a file); a new file gets no copy. Put back backs up the current version first |
| Write "(done <date time>)" after a ticked item (📅 Done dates, off by default, a store setting for every chat) | toggleTask | the same write as a tick: line re-read, backup first; an untick takes such a date off |
| Run `where.exe code.cmd`, then VS Code's `Code.exe <cli.js> <path>` (`ELECTRON_RUN_AS_NODE=1`) | `findVscode()`, VS Code button | open in VS Code: the two paths are read out of VS Code's own `code.cmd`, as that shim would run them, no cmd |

## Protections in place

- Every save backs the file up first (`%USERPROFILE%\.claude\file-pane-backups`) and is refused when the file changed
  on disk since it was opened; a section edit re-reads the lines first. Nothing is ever deleted by the pane (Revert /
  Put back restore from backups).
- Binary files are view only. Big files are paged, so a huge file can't stall drawing.
- Processes get argv arrays, not command strings. The one `cmd.exe` left is Checks (`npm run <name>`, the name from a
  fixed list, matched whole). %APPDATA% / %LOCALAPPDATA% come from `$.env.get`, not `cmd /c set`.
- Shell thumbnails: the maker Windows picks for the type (`AssocQueryString`, as Explorer resolves it) is used only
  when its DLL is under Program Files, Program Files (x86) or Windows. Any other gets `SIIGBF_INCACHEONLY`: Explorer's
  saved thumbnail or nothing, no maker asked. Tried 2026-10-31: a fresh copy of a .glb (maker under %LOCALAPPDATA%)
  got no picture; .obj / .fbx / .exr / .dds via Heimdall and .blend via BlendThumb did. The makers ran outside the
  PowerShell process (none of their DLLs in its module list): Windows runs them in its own helper. The pane never
  opens a model file itself.
- VS Code gets absolute paths only (so a path can't read as a VS Code option), as one argv entry.
- Temp files go to `%USERPROFILE%\.claude\file-pane-cache`; the helper's `rmtemp` refuses anything but the pane's own
  `last-commit-<time>.<ext>` directly in that folder (checked with `..`, look-alike names and a subfolder).
- Checks run only on the user's click (running a project's npm scripts runs that project's code: don't press Checks in
  a folder you don't trust).

## Findings

| # | Date | What | State |
|---|---|---|---|
| 1 | 2026-10-31 | **Open in VS Code** runs `cmd.exe /d /c code <path>`. `&`, `|`, `^`, `%` are legal in Windows file names, and cmd reads them as its own syntax, so a file named like `notes&calc.txt` could start a second program when the button is pressed. | fixed 2026-10-31: `Code.exe <cli.js> <path>` by argv, the paths read from VS Code's `code.cmd` (found with `where.exe`, or the usual install folders). Pane test checks the argv for `a&calc.txt`; tried on this PC with `notes&whoami.txt`: VS Code opened it, nothing else ran |
| 2 | 2026-10-31 | The image-diff temp file is removed with `cmd.exe /d /c del /q <tmp>`. The name is built by the pane (backups folder + time + the image's extension), so it's safe today, but it's a shell for a delete. | fixed 2026-10-31: Node helper `rmtemp`, limited to the pane's own name in `file-pane-cache` (the temp file moved out of the backups folder). Pane test checks the call |
| 4 | 2026-10-31 | VS Code is found through PATH (`where.exe code.cmd`), and the pane runs the two paths that `code.cmd` names. Something that can put its own `code.cmd` earlier on PATH could choose what runs, as it already could with the old `cmd /c code`. | low, accepted: only `<drive>:\…\bin\code.cmd`, the named files must exist next to it, no `..` in them |
| 7 | 2026-11-03 | `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` in `~/.claude/settings.json` makes open chats reload `~/.claude/mods/file-pane` when it changes. Anything that writes there already ran in the next chat; now it runs in the open ones at once too, with the user's rights. Only folders in `CLAUDE_CODE_PLUGIN_DIRS` are watched (just this one). | accepted (Strike's OK): write that folder only through `node deploy.mjs`, which checks first and backs up |
| 6 | 2026-11-01 | ILSpy runs from `%USERPROFILE%\.dotnet\tools`, where every .NET global tool lives: a folder any program the user runs can write to, so something could swap `ilspycmd.exe`. It runs only on the C# button, on one DLL. ModKeeper accepts the same. | accepted, low: only that one path (not PATH), on click; the DLL it reads is data to it |
| 5 | 2026-10-31 | Heimdall3D registers its .glb / .gltf thumbnail maker from `%LOCALAPPDATA%\Heimdall3D\gloss-shim\native\heim_gloss_native.dll`, a folder any program the user runs can write to. Explorer loads it for every .glb it shows, so whatever replaced that DLL would run then. Heimdall3D's problem, not the pane's. | pane: refuses that maker (cache only); since 2026-11-03 draws .glb / .gltf with `heimdall_probe` from Program Files instead. Heimdall3D: worth installing it under Program Files instead |
| 8 | 2026-11-03 | Before Claude's first Edit / Write of a file in a session the pane copies it into `~/.claude/file-pane-backups`. Every file Claude edits now has a copy there, so a `.env` or key file Claude touches is copied too, and the folder grows (nothing removes old backups). | accepted, low: it stays in the user's own profile, as every pane backup does; worth a "clear old backups" idea that asks first (nothing is deleted without asking) |
| 9 | 2026-11-03 | The .glb / .gltf preview runs Heimdall3D's `heimdall_probe` on any model the user opens; a hostile model is the renderer's to survive. Finding 5's DLL (under %LOCALAPPDATA%) is not involved: the probe is the Program Files copy. | accepted: on open only, one file, 60 s timeout, output to the cache; same trust as Heimdall's own viewer |
| 3 | 2026-10-31 | Checks runs `npm run <name>` in the session's folder: that project's scripts run with the user's rights. | by design, on click only; say so in the Checks tab |

## Rules for new features

- argv arrays, never a shell. When a shell can't be avoided, refuse inputs with shell characters rather than escaping.
- PowerShell: pass values as single-quoted literals (`'` doubled) or through environment variables, never spliced raw.
- Caches and temp files go in `%USERPROFILE%\.claude\` (e.g. `file-pane-cache`), never in the project or a synced
  folder; nothing is uploaded anywhere.
- The pane doesn't read other apps' data: Strike doesn't want Model Organizer or ModKeeper integrated (2026-11-03).
  If another app's data is ever needed, read only and from its own safe copy, never a live database.
- A `.blend` can carry Python: Blender only with `--factory-startup --disable-autoexec`, files opened with scripts off
  (Model Organizer's `worker.py` / `inspect_scripts.py` show how).
- Outside programs (Heimdall3D, 7-Zip, Blender) run only from Program Files, with a timeout, on one file at a time, and
  their output goes to the cache. A model file is untrusted input: the renderer reads it, the pane never executes it.
- No keys, tokens, emails or machine paths in anything that could be shared.
