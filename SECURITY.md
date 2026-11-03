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
| Remove one file | Node helper `rmtemp` | the picture diff's own temp file, only `last-commit-<time>.<ext>` directly in `file-pane-cache` |
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
| 5 | 2026-10-31 | Heimdall3D registers its .glb / .gltf thumbnail maker from `%LOCALAPPDATA%\Heimdall3D\gloss-shim\native\heim_gloss_native.dll`, a folder any program the user runs can write to. Explorer loads it for every .glb it shows, so whatever replaced that DLL would run then. Heimdall3D's problem, not the pane's. | pane: refuses that maker (cache only). Heimdall3D: worth installing it under Program Files instead |
| 3 | 2026-10-31 | Checks runs `npm run <name>` in the session's folder: that project's scripts run with the user's rights. | by design, on click only; say so in the Checks tab |

## Rules for new features

- argv arrays, never a shell. When a shell can't be avoided, refuse inputs with shell characters rather than escaping.
- PowerShell: pass values as single-quoted literals (`'` doubled) or through environment variables, never spliced raw.
- Caches and temp files go in `%USERPROFILE%\.claude\` (e.g. `file-pane-cache`), never in the project or a synced
  folder; nothing is uploaded anywhere.
- Other apps' data is read only, and from their own safe copies: Model Organizer's `backups\library-latest.db`, never
  its live `library.db`; ModKeeper's data read only. Their 18+ settings apply: hide 18+ items unless the user turns
  them on.
- A `.blend` can carry Python: Blender only with `--factory-startup --disable-autoexec`, files opened with scripts off
  (Model Organizer's `worker.py` / `inspect_scripts.py` show how).
- Outside programs (Heimdall3D, 7-Zip, Blender) run only from Program Files, with a timeout, on one file at a time, and
  their output goes to the cache. A model file is untrusted input: the renderer reads it, the pane never executes it.
- No keys, tokens, emails or machine paths in anything that could be shared.
