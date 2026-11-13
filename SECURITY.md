# Security notes: Files pane

The pane runs inside Claude Code with the user's rights: it reads and writes files, and starts programs. This file
says what it can do, what protects the user, and what was found. Keep it current: every change that touches files,
processes, paths or outside data adds a line here (and a finding when one turns up, fixed or not).

This machine's own notes (cross-project security notes, other apps, the repository's history) are in
`SECURITY.local.md`, kept on disk only (ignored by git). Anything about the mod itself goes here; anything about one
machine, its other apps or its people goes there.

## Reporting a vulnerability

Please report it privately through the repository's **Security** tab → **Report a vulnerability** (GitHub's private
vulnerability reporting), not as a public issue. Say what a file, folder name, model or repository has to hold, what
the pane does with it, and on which version (⋯ in the pane shows it). Expect a first answer within a week; a fix goes
in a new version, with a line in the Findings below once it's out.

## What it can do

| Power | Where | Why |
|---|---|---|
| Read any file the user can | `$.fs.read`, the Node helper (pages) | browse and view |
| Write files | Node helper (`page` / `splice` / `restore`) | save edits, Put back |
| Remove one file | Node helper `rmtemp` | a diff's own temp file (picture or binary at the last commit), only `last-commit-<time>.<ext>` directly in `file-pane-cache`; and `textDiff` removes the two files it just wrote in `file-pane-cache\diff` |
| Run `node -- <mod folder>\hooks\helper.cjs <command> …` (0.4.2; before: `node -e <HELPER>`) | `helper()` | paging, backups, saves (no shell). The file is the mod's own, written only by `deploy.mjs` (finding 7) |
| Open files in the pane from a hook or tool (`openForAgent`) | 👁 Follow Claude, a reload after Claude's edit, the `show` tool, `/files <path>` | reads the file (4 MiB / PAGE limits as a click); drops unsaved typing for another file, as a click does; never when that typing is for the edited file (a warning instead) |
| Answer Claude's `backups` and `notes` tools | Claude's tools | the backup log (paths, times) and your per-file notes go to the model of this chat; nothing is written |
| Ask Everything's index for folder sizes (`es.exe -timeout 3000 -parent <folder> /ad -size -csv -size-format 1`) | folder sizes (0.4.10) | only the es.exe in `%ProgramFiles%\Everything` (signed by voidtools; never PATH or a user folder), by argv, read only (names and sizes), 8 s timeout, at most 10 folders a count; nothing else of Everything's (no HTTP / ETP server) |
| Add up folder sizes (helper `dirsizes <folders>`) | the folder tree's Size column (0.4.9) | read only: names and sizes, no contents; links and junctions not followed (no loops, nothing outside the folder by a link); 15 s and 400,000 entries at most, then "≥"; one count at a time, in the background; a failed count is kept as unknown for 5 minutes, not asked again on every redraw |
| Count lines of new files | Node helper `lines <repo>` (Project → Git / Changes) | reads the untracked files git lists (paths on stdin, at most 5,000), only under the repo folder, each up to 16 MB, skips binary; only a number per file comes back |
| Open a picture or model in its own app (`explorer.exe <path>`) | ⤢ Open in its app (2026-11-11) | on a press, an absolute drive path only (so it can't read as an Explorer switch), one argv entry; what opens is whatever Windows has for that type, as a double click would |
| Read-only git: `log`, `show`, `branch`, `rev-list`, `blame`, `diff <a>...<b>` | Git → History / Branches / Compare, 🕘 History of a file (2026-11-11) | argv only; branch names come from git's own list (git refuses names starting with `-`); nothing commits, switches, fetches or pushes |
| Open a file in the pane after Claude's Read (👁 Follow Claude, a Read hook) | follows reads (2026-11-11) | reads what Claude just read, nothing more; skips Claude's own working files (`~/.claude/projects`, `plugins`, `shell-snapshots`, `mods`, temp folders) so memory and transcripts don't pop up; never drops unsaved typing |
| Run `node --version`, `git --version`; list `%ProgramFiles%\<JDK vendor>` folders; check for ilspycmd and heimdall_probe | the Tools line | once per chat, read only |
| Run `git` (log, status, diff, grep, show) | `git()`, Timeline, Changes, Search | project tabs |
| Run `node -- <Node's folder>\node_modules\npm\bin\npm-cli.js run <script>` (npm itself; helper `npmcli` finds it beside the Node that runs the helper) | Checks | only script names matching `test|build|lint|typecheck|check|tsc` |
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
| Read a zip / jar's directory (helper `ziplist`) and two binaries whole (`bindiff`, 64 MB each) | 🗂 Files inside, binary ± Diff (with which files inside changed, by name / CRC / size) | read only: nothing is unpacked or run |
| Copy one file out of a zip / jar (helper `zipget`) | a file button in 🗂 Files inside | into `file-pane-cache\zip\<hash>\<name>`: only the entry's last name part is used, cleaned to `[\w.-]` (no `..`, no folders from the archive, so no "zip slip"); stored or deflated only, 64 MB at most, CRC checked; opened like any file, nothing in it runs (a `.class` goes to javap, a DLL to Info) |
| Run ILSpy on two copies of a DLL (helper `csdiff`) | C# diff (ILSpy) in a DLL's ± Diff | as the C# button: one path, on a press, each copy cached by SHA-256; the last-commit copy is a temp file removed after |
| Copy a file before each of Claude's Edit / Write calls on it (`snapshotBefore`, the helper's `backup`; 0.4.1, before: only the first in a session) | ± Claude's change (all, or from one edit on), ↩ Put back | into the backups folder like every pane backup (32 MB at most a file); a new file gets no copy; the last 20 per file are listed. Put back backs up the current version first |
| Read one file inside two copies of a zip / jar (helper `zipentry`) | a changed file's own diff in a jar's ± Diff | in memory (stored / deflated, 64 MB, CRC checked); a `.class` is written to `file-pane-cache\diff` for javap and removed right after; the last-commit jar is a temp file removed after |
| Write "(done <date time>)" after a ticked item (📅 Done dates, off by default, a store setting for every chat) | toggleTask | the same write as a tick: line re-read, backup first; an untick takes such a date off |
| Run VS Code's `Code.exe <cli.js> <path>` (`ELECTRON_RUN_AS_NODE=1`) | `findVscode()`, VS Code button | open in VS Code: the two paths are read out of VS Code's own `code.cmd` in its install folders (`%LOCALAPPDATA%\Programs\Microsoft VS Code`, `%ProgramFiles%\Microsoft VS Code`; not PATH since 2026-11-12), as that shim would run them, no cmd |

## Protections in place

- Every save backs the file up first (`%USERPROFILE%\.claude\file-pane-backups`) and is refused when the file changed
  on disk since it was opened; a section edit re-reads the lines first. Nothing is ever deleted by the pane (Revert /
  Put back restore from backups).
- Binary files are view only. Big files are paged, so a huge file can't stall drawing.
- Processes get argv arrays, not command strings, and the pane starts no `cmd.exe` (since 2026-11-12: Checks runs
  npm's own `npm-cli.js` with node, the script name from a fixed list, matched whole). The only shell is
  `powershell.exe` for previews, with fixed scripts (`hooks/scripts.ts`) and the path as a quoted literal.
  %APPDATA% / %LOCALAPPDATA% come from `$.env.get`, not `cmd /c set`.
- Shell thumbnails: the maker Windows picks for the type (`AssocQueryString`, as Explorer resolves it) is used only
  when its DLL is under Program Files, Program Files (x86) or Windows. Any other gets `SIIGBF_INCACHEONLY`: Explorer's
  saved thumbnail or nothing, no maker asked. Tried 2026-10-31: a fresh copy of a .glb (maker under %LOCALAPPDATA%)
  got no picture; .obj / .fbx / .exr / .dds via Heimdall and .blend via BlendThumb did. The makers ran outside the
  PowerShell process (none of their DLLs in its module list): Windows runs them in its own helper. The pane never
  opens a model file itself.
- VS Code gets absolute paths only (so a path can't read as a VS Code option), as one argv entry.
- Temp files go to `%USERPROFILE%\.claude\file-pane-cache`; the helper's `rmtemp` refuses anything but the pane's own
  `last-commit-<time>.<ext>` directly in that folder (checked with `..`, look-alike names and a subfolder).
- Nothing the pane starts runs without an end condition (Strike, 2026-11-06): its one timer (📜 Log) stops itself
  when the tab isn't drawn; every process gets a timeout (`$.process.run` `timeoutMs`); background preview drawing is
  one job per file, guarded by a set. Lists drawn are capped (50 rows for Git / Changes), so a big repo can't stall it.
- Checks run only on the user's click (running a project's npm scripts runs that project's code: don't press Checks in
  a folder you don't trust).

## Findings

| # | Date | What | State |
|---|---|---|---|
| 1 | 2026-10-31 | **Open in VS Code** runs `cmd.exe /d /c code <path>`. `&`, `|`, `^`, `%` are legal in Windows file names, and cmd reads them as its own syntax, so a file named like `notes&calc.txt` could start a second program when the button is pressed. | fixed 2026-10-31: `Code.exe <cli.js> <path>` by argv, the paths read from VS Code's `code.cmd` (found with `where.exe`, or the usual install folders). Pane test checks the argv for `a&calc.txt`; tried on this PC with `notes&whoami.txt`: VS Code opened it, nothing else ran |
| 2 | 2026-10-31 | The image-diff temp file is removed with `cmd.exe /d /c del /q <tmp>`. The name is built by the pane (backups folder + time + the image's extension), so it's safe today, but it's a shell for a delete. | fixed 2026-10-31: Node helper `rmtemp`, limited to the pane's own name in `file-pane-cache` (the temp file moved out of the backups folder). Pane test checks the call |
| 4 | 2026-10-31 | VS Code is found through PATH (`where.exe code.cmd`), and the pane runs the two paths that `code.cmd` names. Something that can put its own `code.cmd` earlier on PATH could choose what runs, as it already could with the old `cmd /c code`. | fixed 2026-11-12: no PATH search (`where.exe` dropped); only `code.cmd` in VS Code's own install folders, the named files must exist next to it, no `..` in them. Pane test checks no `where.exe` runs |
| 7 | 2026-11-03 | `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` in `~/.claude/settings.json` makes open chats reload `~/.claude/mods/file-pane` when it changes. Anything that writes there already ran in the next chat; now it runs in the open ones at once too, with the user's rights. Only folders in `CLAUDE_CODE_PLUGIN_DIRS` are watched (just this one). | accepted (Strike's OK): write that folder only through `node deploy.mjs`, which checks first and backs up |
| 6 | 2026-11-01 | ILSpy runs from `%USERPROFILE%\.dotnet\tools`, where every .NET global tool lives: a folder any program the user runs can write to, so something could swap `ilspycmd.exe`. It runs only on the C# button, on one DLL. | accepted, low: only that one path (not PATH), on click; the DLL it reads is data to it |
| 5 | 2026-10-31 | Heimdall3D registers its .glb / .gltf thumbnail maker from `%LOCALAPPDATA%\Heimdall3D\gloss-shim\native\heim_gloss_native.dll`, a folder any program the user runs can write to. Explorer loads it for every .glb it shows, so whatever replaced that DLL would run then. Heimdall3D's problem, not the pane's. | pane: refuses that maker (cache only); since 2026-11-03 draws .glb / .gltf with `heimdall_probe` from Program Files instead. Heimdall3D: worth installing it under Program Files instead |
| 8 | 2026-11-03 | Before Claude's Edit / Write of a file (since 0.4.1 before every one, not only the first in a session) the pane copies it into `~/.claude/file-pane-backups`. Every file Claude edits now has copies there, so a `.env` or key file Claude touches is copied too, and the folder grows faster (nothing removes old backups). | accepted, low: it stays in the user's own profile, as every pane backup does; worth a "clear old backups" idea that asks first (nothing is deleted without asking) |
| 9 | 2026-11-03 | The .glb / .gltf preview runs Heimdall3D's `heimdall_probe` on any model the user opens; a hostile model is the renderer's to survive. Finding 5's DLL (under %LOCALAPPDATA%) is not involved: the probe is the Program Files copy. | accepted: on open only, one file, 60 s timeout, output to the cache; same trust as Heimdall's own viewer |
| 10 | 2026-11-03 | The repository is on GitHub (`Strikeborn/claude-file-pane`): private from 2026-11-03, public since 2026-11-12 (Strike's OK). Its docs name local folders (the vault, Program Files apps, a test folder name) but no user name, email (commits use GitHub's noreply address), keys or tokens (checked before the first push). | accepted: `scripts/prepush-check.mjs` (git's pre-push hook, `core.hooksPath .githooks`) refuses a push with this machine's user name, home folder, a personal email or a key-shaped string; a secret scan found no key or token format before it went public. Tags and releases go to the same repository; 2026-11-11: the agent working notes (CLAUDE.md, IDEAS.md, NEXT_CHAT.md, TRY.md) and SECURITY.local.md are ignored, kept on disk only, and were removed from the history (details in SECURITY.local.md) |
| 11 | 2026-11-06 | 📜 Log started a 2 s redraw timer that only another Project tab cancelled. Leaving Log for the Files view or closing the pane kept it redrawing, and each Files redraw runs `git status` (with `rev-parse`): a process every 2 s, for as long as the chat stayed open. Availability, not data. | fixed 0.4.5: the timer ends itself 10 s after the last Log draw (`$.clock.now`); pane test moves the clock and checks no more periods come. Audit 2026-11-06: no other repeating timer or loop in the pane |
| 12 | 2026-11-12 | Checks ran `cmd.exe /d /s /c "npm run <name>"` (npm on Windows is a `.cmd` shim). The name comes from a fixed list matched whole, so nothing could be slipped in, but it was the pane's last shell for a command line; the plugin directory's scan holds a plugin for it. | fixed 2026-11-12: `node -- <npm-cli.js> run <name>`, npm's own script beside the helper's Node, by argv. Pane test checks the argv and that no `cmd.exe` or `npm` runs; helper test finds the real one |
| 3 | 2026-10-31 | Checks runs `npm run <name>` in the session's folder: that project's scripts run with the user's rights. | by design, on click only; say so in the Checks tab |

## Rules for new features

- argv arrays, never a shell. When a shell can't be avoided, refuse inputs with shell characters rather than escaping.
- PowerShell: pass values as single-quoted literals (`'` doubled) or through environment variables, never spliced raw.
- Caches and temp files go in `%USERPROFILE%\.claude\` (e.g. `file-pane-cache`), never in the project or a synced
  folder; nothing is uploaded anywhere.
- The pane doesn't read other apps' data. If another app's data is ever needed, read only and from its own safe copy,
  never a live database.
- A `.blend` can carry Python: Blender only with `--factory-startup --disable-autoexec`, files opened with scripts off.
- Outside programs (Heimdall3D, 7-Zip, Blender) run only from Program Files, with a timeout, on one file at a time, and
  their output goes to the cache. A model file is untrusted input: the renderer reads it, the pane never executes it.
- No keys, tokens, emails or machine paths in anything that could be shared.
- No unlimited timers, polling loops, watchers or listeners: each has an end condition (its view gone, a max time, the
  job done), never a second copy, and the pane test checks it stops. Processes always with a timeout.
