import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BinView, Change, ProjectTab, CheckResult, DiffBase, GitList, OpenFile, Tick } from '../types'
import { DONE_DATE, NEXT_HEADING, age, ageTone, blameRuns, blocksFrom, boxesIn, branchesFrom, commitsFrom, featuresFrom, flipTask, headingPath, graphRows, lastCommitByFile, logFrom, markDone, numberedDiff, releasesFrom, sections, sideBySide, splitBoxes, tasks, wordDiff } from './project'
import type { Block, GraphRow, Task, TimelineEntry } from './project'
import { SHELL_THUMB_PS, THUMB_PS } from './scripts'
import type { EngineInterface } from 'claude-code'

/**
 * Files: a pane beside the chat to browse folders and edit text files.
 * - Small files (up to PAGE bytes) open whole; bigger ones a page at a time (cut at a line end), so neither the
 *   4 MiB read limit nor the pane's drawing limit stops a big log or config.
 * - Every save copies the file to ~/.claude/file-pane-backups first, and is refused when the file changed on disk
 *   since it was opened. Revert puts the last backup back. Nothing is ever deleted. Binary files are view only.
 * - Paging, backups and saves of a page run a small Node script (no shell); Node must be on PATH to save.
 */

const PANE = 'file-pane'
// three windows, each its own pane (a tab in the dock): Files, Git, Project (Strike, 2026-11-11)
const GIT_PANE = 'file-pane-git'
const PROJECT_PANE = 'file-pane-project'
const PANE_TITLES: Record<string, string> = { [PANE]: 'Files', [GIT_PANE]: 'Git', [PROJECT_PANE]: 'Project' }
const PAGE = 60_000
// a folder draws this many rows a page (a list that grows hung the desktop pane: CLAUDE.md)
const LIST = 80

const dirAtom = atom({ plugin: 'file-pane', key: 'dir' } as const, '')
const openAtom = atom({ plugin: 'file-pane', key: 'open' } as const, null)
const msgAtom = atom({ plugin: 'file-pane', key: 'message' } as const, '')
const shownAtom = atom({ plugin: 'file-pane', key: 'shown' } as const, 0)
const backupAtom = atom({ plugin: 'file-pane', key: 'lastBackup' } as const, '')
const tabAtom = atom({ plugin: 'file-pane', key: 'projectTab' } as const, 'overview' as ProjectTab)
const allAtom = atom({ plugin: 'file-pane', key: 'itemsAll' } as const, false)
const toggledAtom = atom({ plugin: 'file-pane', key: 'toggled' } as const, [])
const asTextAtom = atom({ plugin: 'file-pane', key: 'mdAsText' } as const, false)
const editingAtom = atom({ plugin: 'file-pane', key: 'editing' } as const, '')
const changesAtom = atom({ plugin: 'file-pane', key: 'changes' } as const, [] as Change[])
const runningAtom = atom({ plugin: 'file-pane', key: 'running' } as const, '')
const resultsAtom = atom({ plugin: 'file-pane', key: 'results' } as const, {} as Record<string, CheckResult>)
const diffOpenAtom = atom({ plugin: 'file-pane', key: 'diffOpen' } as const, [] as string[])
// Changes / Git draw at most this many rows (files and folders) at once: 347 files in one repo (~720 buttons) hung
// the desktop pane, and so did 180 after ⤓ Show more; a list is paged, a folder tree stops with a note
const CHANGES_PAGE = 50
const gitListAtom = atom({ plugin: 'file-pane', key: 'gitList' } as const, { find: '', kind: 'all', sort: 'path', folders: true, open: [], page: 0 } as GitList)
// line counts of new (untracked) files, by repo: recounted when the status changes or after 15 s
const newLines = new Map<string, { key: string; at: number; counts: Record<string, number> }>()
// git's numstat (0.4 s in a big repo), by repo: kept 5 s while the status is the same, so presses stay quick
const numstats = new Map<string, { key: string; at: number; text: string }>()
// folder sizes (lower-case path → total bytes, file count, cut short), worked out in the background by the helper's
// dirsizes and kept 5 minutes; dirSizing: a count is running (one at a time)
const dirSizes = new Map<string, { bytes: number; files: number; partial: boolean; at: number }>()
let dirSizing = false
// git's answers by repo + question, newest 300 kept; gitAsking: the questions being asked again right now
const gitCache = new Map<string, { at: number; out: string }>()
const gitAsking = new Set<string>()
function keepGit(k: string, out: string): void {
  gitCache.delete(k)
  gitCache.set(k, { at: Date.now(), out })
  if (gitCache.size > 300) gitCache.delete(gitCache.keys().next().value!)
}
// Git dates by repo: each changed file's time on disk and its newest commit, kept 15 s while the status is the same
const gitDates = new Map<string, { key: string; at: number; disk: Map<string, number>; committed: Map<string, number> }>()
const bandHiddenAtom = atom({ plugin: 'file-pane', key: 'bandHidden' } as const, false)
const pinnedAtom = atom({ plugin: 'file-pane', key: 'pinned' } as const, [] as string[])
const recentAtom = atom({ plugin: 'file-pane', key: 'recent' } as const, [] as string[])
const backupLogAtom = atom({ plugin: 'file-pane', key: 'backupLog' } as const, [] as { backup: string; original: string; at: number }[])
const searchAtom = atom({ plugin: 'file-pane', key: 'search' } as const, '')
const logErrorsAtom = atom({ plugin: 'file-pane', key: 'logErrorsOnly' } as const, false)
const sideAtom = atom({ plugin: 'file-pane', key: 'sideBySide' } as const, false)
const previewZoomAtom = atom({ plugin: 'file-pane', key: 'previewZoom' } as const, 1)
const ticksAllAtom =atom({ plugin: 'file-pane', key: 'ticksAll' } as const, false)
const ignoreSpaceAtom =atom({ plugin: 'file-pane', key: 'ignoreSpace' } as const, false)
const diffBaseAtom = atom({ plugin: 'file-pane', key: 'diffBase' } as const, { path: '', base: 'commit' } as DiffBase)
const wrapAtom = atom({ plugin: 'file-pane', key: 'wrap' } as const, true)
const binViewAtom = atom({ plugin: 'file-pane', key: 'binView' } as const, { path: '', mode: 'info', at: 0 } as BinView)
// the Project tabs by name (`/files <tab>` opens one)
const PROJECT_TABS = ['next', 'items', 'ticks', 'timeline', 'features', 'blocks', 'changes', 'git', 'checks', 'search', 'backups', 'log', 'notes'] as const
const lineNosAtom = atom({ plugin: 'file-pane', key: 'diffLineNumbers' } as const, false)
const compactAtom = atom({ plugin: 'file-pane', key: 'compact' } as const, false)
const sortAtom = atom({ plugin: 'file-pane', key: 'sortBy' } as const, 'name' as 'name' | 'size' | 'date')
const folderFindAtom = atom({ plugin: 'file-pane', key: 'folderFind' } as const, '')
// which page the one pane shows: Files, Git or Project (switched in place by the bar's first row: Strike, 2026-11-11)
const viewAtom = atom({ plugin: 'file-pane', key: 'view' } as const, 'files' as 'files' | 'git' | 'project')
// the folder tree's open folders (lower-case paths), newest 1,000: ⊞ Open all adds each one, so any can fold again
const treeOpenAtom = atom({ plugin: 'file-pane', key: 'treeOpen' } as const, [] as string[])
const navAtom = atom({ plugin: 'file-pane', key: 'nav' } as const, { back: [] as string[], fwd: [] as string[] })
const menuAtom = atom({ plugin: 'file-pane', key: 'menu' } as const, false)
const fileHistAtom = atom({ plugin: 'file-pane', key: 'fileHist' } as const, null as { path: string; mode: 'log' | 'blame' } | null)
const agentReadAtom = atom({ plugin: 'file-pane', key: 'agentRead' } as const, null as { path: string; from: number; to: number; at: number } | null)
const conflictAtom = atom({ plugin: 'file-pane', key: 'conflict' } as const, null as { path: string; at: number } | null)
const zipFilterAtom = atom({ plugin: 'file-pane', key: 'zipFilter' } as const, { path: '', text: '' })
const zipEntryAtom = atom({ plugin: 'file-pane', key: 'zipEntry' } as const, { path: '', name: '' })
const lastTickAtom = atom({ plugin: 'file-pane', key: 'lastTick' } as const, null as Tick | null)
const editModeAtom = atom({ plugin: 'file-pane', key: 'editMode' } as const, [] as string[])
const openOnlyAtom = atom({ plugin: 'file-pane', key: 'openOnly' } as const, [] as string[])
// the tick log's size in the store (newest kept)
const TICKS_KEPT = 2000
const noteOpenAtom = atom({ plugin: 'file-pane', key: 'noteOpen' } as const, '')
// the live log's redraw timer while its tab shows
let logTimer: { cancel: () => void } | null = null
let logDrawnAt = 0
// %APPDATA% / %LOCALAPPDATA%, read once
let appDirs: string[] | null = null
// the deploy this chat loaded ({ version, at } from deployed.json beside the mod; null: not read yet, '' fields: a
// copy run from its source folder, never deployed). Read once per load: a reload reads it again.
let loadedStamp: { version: string; at: string } | null = null
// a binary's info / readable text / hex page, by path|modified|mode|start (the helper's answers)
const binCache = new Map<string, Record<string, unknown>>()
// a DLL's C# diff (ILSpy on both copies), by path and modified time: made on a press, drawn after
const csDiffs = new Map<string, Record<string, unknown>>()
// one file inside a zip / jar diffed against the last commit's (by zip path, modified time, name): made on a press
const entryDiffs = new Map<string, Record<string, unknown>>()
// a picture or model preview as the pane draws it (a small PNG / JPEG, base64), by kind|path|size|modified, and the
// ones being drawn now (in the background: a model's render can take seconds)
// the picture's height comes as the JSON key "h", read by its string name (the plugin directory refuses a name h)
type Thumb = { w: number; tw: number; th: number; b64: string; mime?: string; via?: string }
const previews = new Map<string, Thumb | string>()
const drawing = new Set<string>()
// VS Code's own launcher (Code.exe + its cli.js), found once
let vscode: { exe: string; cli: string } | null = null
type Note = { text: string; at: number }

// an icon and a theme color for a file, by its kind
const KINDS: [RegExp, string, string][] = [
  [/\.(md|markdown)$/i, '📝', 'suggestion'],
  [/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i, '📜', 'ide'],
  [/\.(json|ya?ml|toml|ini|xml|cfg|conf|lsx)$/i, '⚙️', 'subtle'],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|dds)$/i, '🖼️', 'merged'],
  [/\.(fbx|obj|stl|3mf|ply|dae|glb|gltf|blend)$/i, '🧊', 'merged'],
  [/\.(zip|7z|rar|tar|gz|pak|archive)$/i, '📦', 'warning'],
  [/\.(log|txt)$/i, '🧾', 'subtle'],
  [/\.(exe|dll|bat|cmd|ps1|sh|msi)$/i, '⚠️', 'error'],
  [/\.(py)$/i, '🐍', 'ide'],
  [/\.(css|scss|less)$/i, '🎨', 'planMode'],
  [/\.(html?)$/i, '🌐', 'suggestion'],
  [/\.(lua|cs|java|class|jar|rs|go|c|cpp|h)$/i, '🧩', 'ide'],
]
const kindOf = (name: string): [string, string | undefined] => {
  const k = KINDS.find(([re]) => re.test(name))
  return k ? [k[1], k[2]] : ['📄', undefined]
}
const IMAGE = /\.(png|jpe?g|gif|bmp|ico)$/i
// 3D models and other files Windows can preview: what Explorer shows (Heimdall3D, Blender's BlendThumb, …)
const MODEL = /\.(fbx|obj|stl|3mf|ply|dae|glb|gltf|blend|exr|hdr|dds|tga|tiff?|psd|webp|heic)$/i
// the ones that are text, so Edit as text makes sense
const MODEL_TEXT = /\.(obj|gltf|dae|ply)$/i
// drawn by Heimdall3D's own renderer (heimdall_probe, under Program Files): their Explorer thumbnail maker lives in
// %LOCALAPPDATA%, which the shell thumbnail refuses (SECURITY finding 5)
const HEIMDALL = /\.(glb|gltf)$/i
// binaries that are zips inside (a file list from the zip's directory), and Java classes (javap)
const ZIPPED = /\.(zip|jar|apk|aar|nupkg|whl|vsix|docx|xlsx|pptx|epub|mrpack|mcpack)$/i
const JAVA_CLASS = /\.class$/i
const GIT_COLOR: Record<string, string> = { new: 'success', changed: 'warning', added: 'success', deleted: 'error', renamed: 'merged' }
// text typed into an item / section / add box, by its editing key (kept out of state: no redraw per key)
const typed = new Map<string, string>()
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
// a document drawn at most this long (the pane draws 100,000 characters in all)
const DRAW = 80_000
const SHORT_DOC = 25_000

// what's typed in the editor (kept out of state: a redraw per key would fight the typing)
let draft: { key: string; text: string } | null = null


const sep = (p: string) => (p.includes('\\') ? '\\' : '/')
const join = (dir: string, name: string) => (dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep(dir) + name)
const parent = (p: string) => {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  if (i <= 0) return p
  // a drive root keeps its slash ("C:\")
  return /^[A-Za-z]:$/.test(s.slice(0, i)) ? s.slice(0, i + 1) : s.slice(0, i)
}
const sizeText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`
const shown = (text: string) => {
  const bom = text.charCodeAt(0) === 0xfeff
  const body = bom ? text.slice(1) : text
  const eol: '\n' | '\r\n' = body.includes('\r\n') ? '\r\n' : '\n'
  return { bom, eol, text: eol === '\r\n' ? body.replace(/\r\n/g, '\n') : body }
}

/** The Node helper, a file the mod ships (run as `node -- <it> <command> …`; see helper.cjs for why not `node -e`). */
function helperFile($: EngineInterface): string {
  return join(join($.plugin.root, 'hooks'), 'helper.cjs')
}

/**
 * VS Code without cmd.exe: `code` is a .cmd shim, and cmd would read `&`, `|`, `^`, `%` in a file name as its own
 * syntax. The shim only runs `Code.exe <cli.js> %*` with ELECTRON_RUN_AS_NODE=1, so find it (PATH via where.exe, or
 * the usual install folders), read those two paths out of it, and run them by argv.
 */
async function findVscode($: EngineInterface): Promise<{ exe: string; cli: string } | null> {
  if (vscode) return vscode
  const shims: string[] = []
  const r = await $.process.run(['where.exe', 'code.cmd'], { timeoutMs: 10_000 }).catch(() => null)
  if (r?.exitCode === 0) shims.push(...r.stdout.split(/\r?\n/).map(l => l.trim()))
  const local = await $.env.get('LOCALAPPDATA')
  const programs = await $.env.get('ProgramFiles')
  if (local) shims.push(`${local}\\Programs\\Microsoft VS Code\\bin\\code.cmd`)
  if (programs) shims.push(`${programs}\\Microsoft VS Code\\bin\\code.cmd`)
  for (const shim of shims.filter(s => /^[A-Za-z]:\\.*\\bin\\code\.cmd$/i.test(s))) {
    const text = await $.fs.read(shim).catch(() => '')
    // "%~dp0..\Code.exe" "%~dp0..\<commit>\resources\app\out\cli.js"
    const exe = /"%~dp0\.\.\\([^"%]+\.exe)"/i.exec(text)?.[1]
    const cli = /"%~dp0\.\.\\([^"%]+\\cli\.js)"/i.exec(text)?.[1]
    if (!exe || !cli || exe.includes('..') || cli.includes('..')) continue
    const top = parent(parent(shim))
    const found = { exe: join(top, exe), cli: join(top, cli) }
    if ((await $.fs.exists(found.exe)) && (await $.fs.exists(found.cli))) return (vscode = found)
  }
  return null
}

/**
 * The pane's version and deploy time as this chat loaded it, and the newest deploy (a long chat keeps the pane it
 * started with: `newer` says a later deploy is waiting for new chats). A copy run from its source folder has no stamp.
 */
async function deployInfo($: EngineInterface, home: string | undefined): Promise<{ version: string; at: string; newer: string }> {
  const stamp = async (dir: string) => {
    try {
      const j = JSON.parse(await $.fs.read(join(dir, 'deployed.json'))) as { version?: string; at?: string }
      return { version: String(j.version ?? ''), at: String(j.at ?? '') }
    } catch {
      return null
    }
  }
  if (!loadedStamp) {
    const root = $.plugin.root
    let version = ''
    try {
      version = String((JSON.parse(await $.fs.read(join(join(root, '.claude-plugin'), 'plugin.json'))) as { version?: string }).version ?? '')
    } catch {
      /* no manifest to read */
    }
    loadedStamp = (await stamp(root)) ?? { version, at: '' }
  }
  const deployed = home ? await stamp(join(join(join(home, '.claude'), 'mods'), 'file-pane')) : null
  const newer = loadedStamp.at && deployed?.at && deployed.at > loadedStamp.at ? deployed.at : ''
  return { ...loadedStamp, newer }
}
const whenText = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------- reading the project (cached by modified time); $ only goes to functions in this file ----------

const projectCache = new Map<string, { at: number; value: unknown }>()
async function cachedRead<T>($: EngineInterface, key: string, path: string, make: (text: string) => T): Promise<T> {
  const st = await $.fs.stat(path).catch(() => null)
  const at = st?.mtimeMs ?? -1
  const hit = projectCache.get(key)
  if (hit && hit.at === at) return hit.value as T
  let text = ''
  try {
    if (st) text = await $.fs.read(path)
  } catch {
    /* unreadable: empty */
  }
  const value = make(text)
  projectCache.set(key, { at, value })
  return value
}

/** Markdown files of the project: its top folder and docs/ (two levels), no dependencies or build output. */
async function markdownFiles($: EngineInterface, root: string): Promise<string[]> {
  const out: string[] = []
  const skip = /^(node_modules|\.git|dist|dist-electron|build|release|out|coverage|vendor)$/i
  const walk = async (dir: string, depth: number) => {
    let list: { name: string; kind: string }[] = []
    try {
      list = await $.fs.list(dir)
    } catch {
      return
    }
    for (const x of list) {
      if (x.kind === 'file' && /\.md$/i.test(x.name)) out.push(join(dir, x.name))
      else if (x.kind === 'dir' && depth > 0 && !skip.test(x.name) && !x.name.startsWith('.')) await walk(join(dir, x.name), depth - 1)
    }
  }
  await walk(root, 0)
  await walk(join(root, 'docs'), 2)
  return out.slice(0, 300)
}

async function projectTasks($: EngineInterface, root: string): Promise<{ path: string; tasks: Task[] }[]> {
  const out: { path: string; tasks: Task[] }[] = []
  for (const f of await markdownFiles($, root)) {
    const list = await cachedRead($, `tasks:${f}`, f, t => tasks(t.split(/\r?\n/)))
    if (list.length) out.push({ path: f, tasks: list })
  }
  return out
}

async function projectTimeline($: EngineInterface, root: string): Promise<TimelineEntry[]> {
  let commits: TimelineEntry[] = []
  try {
    const r = await $.process.run(['git', 'log', '-n', '60', '--date=format-local:%Y-%m-%d %H:%M', '--pretty=format:%ad%x09%h%x09%s'], { cwd: root, timeoutMs: 15_000 })
    commits = commitsFrom(r.stdout)
  } catch {
    /* not a git folder */
  }
  const releases = await cachedRead($, `releases:${root}`, join(root, 'CHANGELOG.md'), releasesFrom)
  return [...commits, ...releases].sort((a, b) => (b.date || '0').localeCompare(a.date || '0'))
}

async function projectFeatures($: EngineInterface, root: string): Promise<{ version: string; blocks: Block[] }> {
  return cachedRead($, `features:${root}`, join(root, 'CHANGELOG.md'), featuresFrom)
}

async function projectBlocks($: EngineInterface, root: string): Promise<{ from: string; blocks: Block[] }> {
  const docs = (await markdownFiles($, root)).sort((a, b) => Number(/DEVELOPING/i.test(b)) - Number(/DEVELOPING/i.test(a)))
  for (const f of docs) {
    const found = await cachedRead($, `blocks:${f}`, f, t => blocksFrom(t, false))
    if (found.length) return { from: f, blocks: found }
  }
  const dev = docs.find(f => /DEVELOPING\.md$/i.test(f))
  return dev ? { from: dev, blocks: await cachedRead($, `blocks-top:${dev}`, dev, t => blocksFrom(t, true)) } : { from: '', blocks: [] }
}

/** The git repository a folder is in (a `.git` above it), found by looking, without running git; '' when none. */
async function repoOf($: EngineInterface, dir: string): Promise<string> {
  let d = dir
  for (let i = 0; i < 30 && d; i++) {
    if (await $.fs.exists(join(d, '.git')).catch(() => false)) return d
    const up = parent(d)
    if (up === d) break
    d = up
  }
  return ''
}

/** `p`, or `fallback` after `ms` (a call that never answers must not keep the pane from drawing). */
async function within<T>($: EngineInterface, p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), $.clock.sleep(ms).then(() => fallback)])
}

// Changes: every file Claude edits this session, newest first (the call's own path; only when it went through)
async function recordChange($: EngineInterface, path: unknown, tool: string, ok: boolean, before?: string): Promise<void> {
  if (!ok || typeof path !== 'string' || !path) return
  await update($, changesAtom, list => {
    const old = list.find(c => c.path.toLowerCase() === path.toLowerCase())
    const rest = list.filter(c => c !== old)
    const kept = old?.before ?? before
    // each edit's own copy too (a new file's first edit has none)
    const edits = [...(old?.edits ?? []), ...(before ? [{ at: Date.now(), before }] : [])].slice(-20)
    return [{ path, tool, at: Date.now(), n: (old?.n ?? 0) + 1, ...(kept !== undefined ? { before: kept } : {}), ...(edits.length ? { edits } : {}) }, ...rest].slice(0, 300)
  })
}

/**
 * Before each of Claude's Edit / Write calls on a file: a backup copy of it (the pane's backups folder, listed in
 * Backups), so ± Diff can show Claude's change (all of this session's, or from one edit on) and Put back can undo it.
 * '' for a file that doesn't exist yet; undefined when no copy was made (a folder, over 32 MB, no Node). Never stops
 * the edit.
 */
async function snapshotBefore($: EngineInterface, path: unknown): Promise<string | undefined> {
  if (typeof path !== 'string' || !path) return undefined
  const st = await $.fs.stat(path).catch(() => null)
  if (!st) return ''
  if (st.kind !== 'file' || st.size > 32 * 1024 * 1024) return undefined
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return undefined
  try {
    const r = await $.process.run(['node', '--', helperFile($), 'backup', path, join(join(home, '.claude'), 'file-pane-backups')], { timeoutMs: 15_000 })
    const j = JSON.parse(r.stdout || '{}') as { backup?: unknown }
    if (typeof j.backup !== 'string') return undefined
    const backup = j.backup
    await update($, backupLogAtom, list => [{ backup, original: path, at: Date.now() }, ...list].slice(0, 500))
    return backup
  } catch {
    return undefined
  }
}

/**
 * Opens a file in the pane from a hook or a tool (not a press): a text file up to PAGE bytes whole, anything else by
 * its folder (a press opens it, with paging). Says what it did. Unsaved typing for another file is dropped, as a
 * click on another file drops it.
 */
async function openForAgent($: EngineInterface, path: string): Promise<string> {
  const st = await $.fs.stat(path).catch(() => null)
  if (!st) return `Not found: ${path}`
  await rememberPlace($, path)
  if (st.kind === 'dir') {
    await update($, openAtom, () => null)
    await update($, dirAtom, () => path)
    return `Showing the folder ${path}.`
  }
  await update($, dirAtom, () => parent(path))
  await update($, recentAtom, list => [path, ...list.filter(p => p.toLowerCase() !== path.toLowerCase())].slice(0, 15))
  const text = st.kind === 'file' && st.size <= PAGE ? await $.fs.read(path).catch(() => null) : null
  if (text === null || text.slice(0, 8000).includes('\u0000')) {
    await update($, openAtom, () => null)
    await update($, msgAtom, () => `${path} is in this folder: click it to open it (big or binary files open on a click).`)
    return `Showing the folder of ${path} (it's big or binary: a click opens it).`
  }
  const s = shown(text)
  draft = null
  await update($, openAtom, () => ({ path, size: st.size, mtimeMs: st.mtimeMs, mode: 'whole' as const, start: 0, end: st.size, text: s.text, eol: s.eol, bom: s.bom, binary: false }))
  return `Opened ${path}.`
}

/**
 * After Claude's Edit / Write of a file went through: the pane open on it reloads (it showed the old text); with
 * unsaved typing for it, a conflict warning instead (the typing stays; Save refuses, the file changed); with
 * 👁 Follow Claude on, the file opens with that edit's diff.
 */
async function afterClaudeEdit($: EngineInterface, path: unknown): Promise<void> {
  if (typeof path !== 'string' || !path) return
  const open = await read($, openAtom)
  const same = open !== null && open.path.toLowerCase() === path.toLowerCase()
  if (same && draft && draft.key.startsWith(`${open.path}|`) && draft.text !== open.text) {
    await update($, conflictAtom, () => ({ path, at: Date.now() }))
    return
  }
  // Claude's own working and temp files (scratch scripts, memory, transcripts) aren't followed, as for reads
  if (!same && NOT_FOLLOWED.test(path)) return
  // never takes the pane from unsaved typing in another file: a note instead
  if (!same && (await typingElsewhere($))) {
    if (await followOn($)) await update($, msgAtom, () => `👁 Claude edited ${path.split(/[\\/]/).pop()} (not opened: you have unsaved typing here).`)
    return
  }
  if (await followOn($)) {
    await update($, agentReadAtom, () => null)
    await showPane($, PANE, false)
    await openForAgent($, path)
    await update($, diffOpenAtom, list => (list.includes(`filediff:${path}`) ? list : [...list, `filediff:${path}`].slice(-50)))
    // the newest edit (the render takes the last step there is)
    await update($, diffBaseAtom, () => ({ path, base: 'claude' as const, edit: Number.MAX_SAFE_INTEGER }))
  } else if (same && open.mode === 'whole') await openForAgent($, path)
}

/**
 * Shows Files, Git or Project in the one pane (0.4.8: they were their own dock tabs in 0.4.7, extra tabs to close,
 * which Strike didn't want), and opens the pane; focus: the keyboard goes there too.
 */
async function showPane($: EngineInterface, id: string, focus = true): Promise<void> {
  await update($, viewAtom, () => (id === GIT_PANE ? 'git' : id === PROJECT_PANE ? 'project' : 'files'))
  await $.ui.open(focus ? { id: PANE, title: 'Files', focus: true } : { id: PANE, title: 'Files' })
}

/** ← history: the place shown now goes on the back list before the pane moves to `to` (forward is cleared). */
async function rememberPlace($: EngineInterface, to: string): Promise<void> {
  const open = await read($, openAtom)
  const here = open ? open.path : (await read($, dirAtom)) || (await $.session.cwd())
  if (!here || here.toLowerCase() === to.toLowerCase()) return
  await update($, navAtom, n => ({ back: [...n.back.filter(p => p.toLowerCase() !== here.toLowerCase()), here].slice(-50), fwd: [] }))
}

/**
 * Folder sizes from Everything's index (voidtools' es.exe, only the copy in Program Files\Everything, by argv, read
 * only): each folder's direct subfolders with their sizes, a few hundred ms instead of walking them. Folders it doesn't
 * answer for (excluded from its index, Everything not running) are left out; the helper counts those.
 */
async function everythingSizes($: EngineInterface, parents: string[]): Promise<Map<string, number>> {
  const got = new Map<string, number>()
  const pf = (await $.env.get('ProgramFiles')) ?? ''
  const es = pf ? join(join(pf, 'Everything'), 'es.exe') : ''
  if (!es || !(await $.fs.exists(es).catch(() => false))) return got
  for (const dir of parents.slice(0, 10)) {
    const r = await $.process.run([es, '-timeout', '3000', '-parent', dir, '/ad', '-size', '-csv', '-size-format', '1'], { timeoutMs: 8_000 }).catch(() => null)
    if (!r || r.exitCode !== 0) continue
    for (const l of r.stdout.split(/\r?\n/)) {
      const m = /^"(.*?)\\?",(\d+)$/.exec(l.trim())
      if (m) got.set(m[1]!.toLowerCase(), Number(m[2]))
    }
  }
  return got
}

/** 👁 Follow Claude, a setting for every chat ($.store): on unless switched off. */
async function followOn($: EngineInterface): Promise<boolean> {
  return (await within($, $.store.get('followClaude'), 2000, undefined)) !== false
}

/** The open file has typing that isn't saved: following Claude to another file would drop it. */
async function typingElsewhere($: EngineInterface): Promise<boolean> {
  const open = await read($, openAtom)
  return open !== null && draft !== null && draft.key.startsWith(`${open.path}|`) && draft.text !== open.text
}

// Claude's own working files: followed reads skip them (memory, transcripts, tool results, temp files, the plugin's types)
const NOT_FOLLOWED = /[\\/]\.claude[\\/](projects|plugins|shell-snapshots|mods|todos)[\\/]|[\\/]AppData[\\/]Local[\\/]Temp[\\/]|[\\/]\.claude-plugin[\\/]types[\\/]/i

/**
 * 👁 Follow Claude after a Read: the file opens in the pane with the lines read marked above it (a band with those
 * lines). Skips Claude's own working files, and never takes the pane from unsaved typing.
 */
async function afterClaudeRead($: EngineInterface, path: unknown, offset: unknown, limit: unknown): Promise<void> {
  if (typeof path !== 'string' || !path || NOT_FOLLOWED.test(path) || !(await followOn($))) return
  const open = await read($, openAtom)
  const same = open !== null && open.path.toLowerCase() === path.toLowerCase()
  if (!same && (await typingElsewhere($))) return
  if (!same) {
    const st = await $.fs.stat(path).catch(() => null)
    if (!st || st.kind !== 'file') return
    await showPane($, PANE, false)
    await openForAgent($, path)
  }
  const from = typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 1
  const to = typeof limit === 'number' && limit > 0 ? from + Math.floor(limit) - 1 : from + 1999
  await update($, agentReadAtom, () => ({ path, from, to, at: Date.now() }))
}

// the programs the pane leans on, found or not (checked once per chat, in the background)
type Health = { name: string; ok: boolean; for: string }[]
let health: Health | null = null
let healthStarted = false

/** Which of the pane's outside programs are there (Node, git, a JDK's javap, ILSpy, Heimdall3D), and what each is for. */
async function checkHealth($: EngineInterface): Promise<Health> {
  const runs = async (argv: string[]) => (await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null))?.exitCode === 0
  const pf = (await $.env.get('ProgramFiles')) ?? ''
  const home = (await $.env.get('USERPROFILE')) ?? ''
  const exists = (p: string) => $.fs.exists(p).catch(() => false)
  let javap = false
  for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft']) {
    const dirs = pf ? await $.fs.list(join(pf, vendor)).catch(() => []) : []
    for (const d of dirs) if (!javap && d.kind === 'dir') javap = await exists(join(join(join(join(pf, vendor), d.name), 'bin'), 'javap.exe'))
  }
  return [
    { name: 'Node', ok: await runs(['node', '--version']), for: 'saving, backups, paging, binaries' },
    { name: 'git', ok: await runs(['git', '--version']), for: 'diffs, Git, Timeline' },
    { name: 'javap', ok: javap, for: '☕ Bytecode and class diffs (a JDK under Program Files)' },
    { name: 'ILSpy', ok: home ? await exists(join(join(join(home, '.dotnet'), 'tools'), 'ilspycmd.exe')) : false, for: 'C# of .NET DLLs (dotnet tool install -g ilspycmd)' },
    { name: 'Heimdall3D', ok: pf ? await exists(join(join(pf, 'Heimdall3D'), 'heimdall_probe.exe')) : false, for: '.glb / .gltf previews' },
    { name: 'Everything', ok: pf ? await exists(join(join(pf, 'Everything'), 'es.exe')) : false, for: 'instant folder sizes (es.exe from voidtools.com in Program Files\\Everything; without it the pane counts them itself)' },
  ]
}

/** The tick log ($.store `ticks`, newest first, shared by every chat), or [] when unreadable. */
async function readTicks($: EngineInterface): Promise<Tick[]> {
  const v = await within($, $.store.get('ticks'), 2000, undefined)
  return Array.isArray(v) ? (v as Tick[]) : []
}
async function logTick($: EngineInterface, t: Tick): Promise<void> {
  try {
    await $.store.set('ticks', [t, ...(await readTicks($))].slice(0, TICKS_KEPT))
  } catch {
    /* the log is a convenience: a full or broken store never stops a tick */
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'files', description: 'Open the Files pane: browse folders and edit text files' })
    await $.tool.register({
      name: 'open',
      description: "Opens the person's Files pane beside the chat, optionally at a folder or a file (absolute path).",
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A folder to list or a file to open' } } },
    })
    await $.tool.register({
      name: 'ticks',
      description:
        "The checkboxes the person ticked or unticked in Markdown files through the Files pane, newest first: file, item, the headings above it, ticked or unticked, and when. Use it to answer what they finished, when and where.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Only this file, or files under this folder (absolute)' },
          since: { type: 'string', description: 'Only ticks at or after this time (ISO date or date-time)' },
          limit: { type: 'number', description: 'At most this many (default 50, at most 500)' },
        },
      },
    })
    await $.tool.register({
      name: 'show',
      description:
        "Shows the person a file in the Files pane beside the chat (absolute path), optionally with its diff (against the last commit, the file before Claude's edits this session, or its newest backup) or pointing at one line. Use it to show them where something is or what changed.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file to show (absolute)' },
          diff: { type: 'string', enum: ['commit', 'claude', 'backup'], description: 'Show its diff against this' },
          line: { type: 'number', description: 'Point at this line (1-based): the pane says what it reads' },
        },
        required: ['path'],
      },
    })
    await $.tool.register({
      name: 'backups',
      description:
        "The backup copies the Files pane made of a file (before each save, and before each of Claude's edits), newest first: the copy's path and when. Read a copy to see or compare an older version.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Only copies of this file, or of files under this folder (absolute)' },
          limit: { type: 'number', description: 'At most this many (default 20, at most 200)' },
        },
      },
    })
    await $.tool.register({
      name: 'notes',
      description: 'The notes the person wrote about files in the Files pane (per file), newest first. Read them before changing a file they noted.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Only this file, or files under this folder (absolute)' } },
      },
    })
    if (!(await read($, dirAtom))) await update($, dirAtom, () => '')
    void $.ui.open({ id: PANE, title: 'Files' })
    return next(e)
  })

  // /files, /files <project tab> (ticks, changes, items, git…), /files <path>
  on('command.run', { command: 'files' }, async ($, e) => {
    await update($, bandHiddenAtom, () => false)
    const arg = String(e.args ?? '').trim().replace(/^"(.*)"$/, '$1')
    const tab = PROJECT_TABS.find(t => t === arg.toLowerCase())
    let text = 'Files pane opened.'
    if (tab === 'git' || tab === 'changes') {
      await showPane($, GIT_PANE)
      return { text: 'Git window opened.' }
    }
    if (tab) {
      await update($, tabAtom, () => tab)
      await showPane($, PROJECT_PANE)
      return { text: `Project window opened at ${tab}.` }
    }
    if (arg) text = await openForAgent($, /^[A-Za-z]:[\\/]|^[\\/]/.test(arg) ? arg : join(await $.session.cwd(), arg))
    await showPane($, PANE)
    return { text }
  })

  // show a file (with its diff, or one line) to the person
  on('tool.call', { tool: 'mcp__file-pane__show' }, async ($, e) => {
    const answer = (text: string) => ({ result: text, text })
    const path = typeof e.path === 'string' ? e.path.trim() : ''
    if (!path) return answer('Give the file to show (an absolute path).')
    await showPane($, PANE)
    let said = await openForAgent($, path)
    const diff = e.diff === 'commit' || e.diff === 'claude' || e.diff === 'backup' ? e.diff : undefined
    if (diff) {
      await update($, diffOpenAtom, list => (list.includes(`filediff:${path}`) ? list : [...list, `filediff:${path}`].slice(-50)))
      await update($, diffBaseAtom, () => ({ path, base: diff }))
      said += ` With its diff against ${diff === 'commit' ? 'the last commit' : diff === 'claude' ? "the file before Claude's edits" : 'its newest backup'}.`
    }
    const open = await read($, openAtom)
    if (typeof e.line === 'number' && open?.path === path) {
      const n = Math.max(1, Math.floor(e.line))
      const at = open.text.split('\n')[n - 1]
      await update($, msgAtom, () => (at === undefined ? `Claude pointed at line ${n} (the file has fewer lines).` : `Claude points at line ${n}: ${at.trim().slice(0, 300)}`))
      said += ` Pointed at line ${n}.`
    }
    const r = await $.ui.open({ id: PANE, title: 'Files', focus: true })
    return answer(r.isPlaced ? said : `${said} (The pane isn't drawn: ${r.reason}.)`)
  })

  // the backup copies of a file, for an agent comparing or restoring an older version
  on('tool.call', { tool: 'mcp__file-pane__backups' }, async ($, e) => {
    const where = typeof e.path === 'string' ? e.path.trim().toLowerCase().replace(/[\\/]+$/, '') : ''
    const limit = Math.min(200, Math.max(1, typeof e.limit === 'number' ? Math.floor(e.limit) : 20))
    const under = (p: string) => !where || p.toLowerCase() === where || p.toLowerCase().startsWith(`${where}\\`) || p.toLowerCase().startsWith(`${where}/`)
    const changes = await read($, changesAtom)
    const claudeCopies = new Set(changes.flatMap(c => [c.before ?? '', ...(c.edits ?? []).map(x => x.before)]).filter(Boolean))
    const list = (await read($, backupLogAtom))
      .filter(b => under(b.original))
      .slice(0, limit)
      .map(b => ({ file: b.original, copy: b.backup, at: new Date(b.at).toISOString(), made: claudeCopies.has(b.backup) ? "before one of Claude's edits" : 'before a save in the pane' }))
    const text = list.length
      ? list.map(b => `${b.at} ${b.file} → ${b.copy} (${b.made})`).join('\n')
      : 'No backups listed for that in this chat (the copies are in ~/.claude/file-pane-backups, named <time>-<file name>).'
    return { result: list, text }
  })

  // the person's per-file notes
  on('tool.call', { tool: 'mcp__file-pane__notes' }, async ($, e) => {
    const where = typeof e.path === 'string' ? e.path.trim().toLowerCase().replace(/[\\/]+$/, '') : ''
    const all = ((await within($, $.store.get('notes'), 2000, undefined)) ?? {}) as Record<string, Note>
    const list = Object.entries(all)
      .filter(([p, n]) => n.text.trim() && (!where || p.toLowerCase() === where || p.toLowerCase().startsWith(`${where}\\`) || p.toLowerCase().startsWith(`${where}/`)))
      .sort(([, a], [, b]) => b.at - a.at)
      .map(([p, n]) => ({ path: p, note: n.text, at: new Date(n.at).toISOString() }))
    const text = list.length ? list.map(n => `${n.path} (${n.at}):\n${n.note}`).join('\n\n') : 'No notes for that.'
    return { result: list, text }
  })

  // the model's way to open it: at a folder (listed) or a file (its folder listed; open it from there)
  on('tool.call', { tool: 'mcp__file-pane__open' }, async ($, e) => {
    const want = typeof e.path === 'string' ? e.path.trim() : ''
    const answer = (text: string) => ({ result: text, text })
    if (want) {
      const st = await $.fs.stat(want).catch(() => null)
      if (!st) return answer(`Not found: ${want}`)
      const isDir = st.kind === 'dir'
      await update($, openAtom, () => null)
      await update($, dirAtom, () => (isDir ? want : parent(want)))
      await update($, msgAtom, () => (isDir ? '' : `Opened at ${want}: click it in the list to edit.`))
    }
    const r = await $.ui.open({ id: PANE, title: 'Files', focus: true })
    return answer(r.isPlaced ? 'The Files pane is open.' : `The Files pane is open but not drawn: ${r.reason}. Typing /files opens it at any width.`)
  })

  // the tick log, for an agent asking what was finished, when and where
  on('tool.call', { tool: 'mcp__file-pane__ticks' }, async ($, e) => {
    const where = typeof e.path === 'string' ? e.path.trim().toLowerCase().replace(/[\\/]+$/, '') : ''
    const since = typeof e.since === 'string' && e.since.trim() ? Date.parse(e.since) : NaN
    const limit = Math.min(500, Math.max(1, typeof e.limit === 'number' ? Math.floor(e.limit) : 50))
    const list = (await readTicks($))
      .filter(t => !where || t.path.toLowerCase() === where || t.path.toLowerCase().startsWith(`${where}\\`) || t.path.toLowerCase().startsWith(`${where}/`))
      .filter(t => Number.isNaN(since) || t.at >= since)
      .slice(0, limit)
      .map(t => ({ path: t.path, item: t.item, headings: t.headings, ticked: t.done, at: new Date(t.at).toISOString() }))
    const text = list.length
      ? list.map(t => `${t.at} ${t.ticked ? 'ticked' : 'unticked'} "${t.item}" in ${t.path}${t.headings.length ? ` › ${t.headings.join(' › ')}` : ''}`).join('\n')
      : 'No ticks logged for that (the log starts with Files pane 0.2.0; ticks made in other editors are not seen).'
    return { result: list, text }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const before = await snapshotBefore($, e.file_path)
    const r = await next(e)
    const ok = r.deny === undefined && r.isError !== true
    await recordChange($, e.file_path, 'Edit', ok, before)
    if (ok) await afterClaudeEdit($, e.file_path)
    return r
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const before = await snapshotBefore($, e.file_path)
    const r = await next(e)
    const ok = r.deny === undefined && r.isError !== true
    await recordChange($, e.file_path, 'Write', ok, before)
    if (ok) await afterClaudeEdit($, e.file_path)
    return r
  })
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.isError !== true) await afterClaudeRead($, e.file_path, e.offset, e.limit)
    return r
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const r = await next(e)
    await recordChange($, e.notebook_path, 'NotebookEdit', r.deny === undefined && r.isError !== true)
    return r
  })

  // a slim band above the prompt: open the pane in one click, and what needs a look
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, bandHiddenAtom))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const changes = (await read($, changesAtom)).length
    const conflict = await read($, conflictAtom)
    const failing = Object.entries(await read($, resultsAtom)).filter(([, r]) => !r.ok).map(([k]) => k)
    let open = 0
    try {
      for (const f of await projectTasks($, await $.session.cwd())) open += f.tasks.filter(t => !t.done).length
    } catch {
      /* no project docs */
    }
    return (
      <Box flexDirection="row" gap={1}>
        <Button key="band-open" label="📁 Files" plain onPress={() => void (async () => {
          await showPane($, PANE)
        })()} />
        {conflict ? (
          <Button key="band-conflict" label={`⚠ ${conflict.path.split(/[\\/]/).pop()}: Claude edited it over your unsaved typing`} plain onPress={() => void (async () => {
            await showPane($, PANE)
          })()} />
        ) : null}
        {changes ? (
          <Button key="band-changes" label={`✎ ${changes} edited`} plain onPress={() => void (async () => {
            await showPane($, GIT_PANE)
          })()} />

        ) : null}
        {failing.length ? (
          <Button key="band-checks" label={`❌ ${failing.join(', ')}`} plain onPress={() => void (async () => {
            await update($, tabAtom, () => 'checks')
            await showPane($, PROJECT_PANE)
          })()} />

        ) : null}
        {open ? (
          <Button key="band-items" label={`☐ ${open} open`} plain onPress={() => void (async () => {
            await update($, tabAtom, () => 'items')
            await showPane($, PROJECT_PANE)
          })()} />

        ) : null}
        <Button key="band-hide" plain dimColor onPress={() => void update($, bandHiddenAtom, () => true)}>
          ×
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE && e.requestId !== GIT_PANE && e.requestId !== PROJECT_PANE) return next(e)
    // anything that goes wrong while drawing shows here, instead of an empty pane; the step it's on shows on the
    // status line under the prompt while it draws (so a step that never finishes says which it is)
    const step = (s: string) => $.ui.status(`Files pane: ${s}…`)
    step('starting')
    try {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // the phone app draws no text field: there the pane browses and shows files, read only
    const Input = 'Input' in els ? els.Input : null
    const Md = 'Markdown' in els ? els.Markdown : null
    const Code = 'Code' in els ? els.Code : null
    const Svg = 'Svg' in els ? els.Svg : null
    // a picture as a small PNG (Windows imaging), sized under the SVG element's 131,072 characters
    // shell: Explorer's thumbnail (3D models and the like) instead of decoding the picture
    const thumb = async (path: string, shell = false): Promise<Thumb | string> => {
      // as big as fits the SVG element (pictures read small at 420 px: Strike, 2026-11-11)
      for (const max of [800, 560, 420, 280, 160]) {
        try {
          const q = (s: string) => `'${s.replace(/'/g, "''")}'`
          const r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `& { ${shell ? SHELL_THUMB_PS : THUMB_PS} } ${q(path)} ${max}`], { timeoutMs: 45_000 })
          const j = JSON.parse(r.stdout.trim() || '{}') as Thumb & { error?: string }
          if (!j.b64) return (j.error || r.stderr || 'Windows imaging could not read it').split(/\r?\n/)[0]!
          if (j.b64.length < 120_000) return j
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      }
      return 'too detailed to preview here'
    }
    // zoom > 1: the middle of the picture, drawn at the same size (the SVG's viewBox crops it)
    const picture = (key: string, t: Thumb, alt: string, zoom = 1) => {
      const vw = t.tw / zoom
      const vh = t.th / zoom
      // drawn up to twice its size (1200 px at most), and never wider than the pane: the element fits its slot
      const shownW = Math.min(1200, t.tw * 2)
      const box = `${((t.tw - vw) / 2).toFixed(1)} ${((t.th - vh) / 2).toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`
      return Svg ? (
        <Svg
          key={key}
          alt={alt}
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${shownW}" height="${Math.round((shownW * t.th) / t.tw)}" viewBox="${box}"><image href="data:image/${t.mime === 'jpeg' ? 'jpeg' : 'png'};base64,${t.b64}" width="${t.tw}" height="${t.th}"/></svg>`}
        />
      ) : (
        <Text dimColor>{alt}</Text>
      )
    }
    const showDiff = await read($, diffOpenAtom)
    const side = await read($, sideAtom)
    const lineNos = await read($, lineNosAtom)
    // ↩ Wrap: long lines continue on more rows, or stay one row cut at the edge (every Text / Code the pane draws)
    const wrap = await read($, wrapAtom)
    const follow = await followOn($)
    // the tools check runs once per chat, in the background (a module variable, not state: drawing can't write state)
    if (!healthStarted) {
      healthStarted = true
      void checkHealth($).then(found => {
        health = found
        $.ui.invalidate('ui.render')
      })
    }
    const compact = await read($, compactAtom)
    const conflict = await read($, conflictAtom)
    const wrapMode = wrap ? ('wrap' as const) : ('truncate-end' as const)
    // ▭ a card (Strike, 2026-11-11: "sectioning"): a rounded box with a bold title and its count or state on the
    // right. With `fold`, the title is a button and a folded card is just its title row.
    const card = (key: string, title: string, note: string, body: unknown, fold?: { open: boolean; toggle: () => void; button?: string }, go?: () => void) => (
      <Box key={`card:${key}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {fold ? <Button key={fold.button ?? `card-btn:${key}`} label={`${fold.open ? '▾' : '▸'} ${title}`} plain onPress={fold.toggle} /> : go ? <Button key={`card-go:${key}`} label={`${title} ›`} plain onPress={go} /> : <Text bold>{title}</Text>}
          <Box flexGrow={1} />
          {note ? <Text dimColor wrap="truncate-end">{note}</Text> : null}
        </Box>
        {!fold || fold.open ? (body as never) : null}
      </Box>
    )
    // ▦ a table row (Strike, 2026-11-11: "columns"): the first cell takes the room left, the others fixed widths (in
    // cells), each cut at its edge, so every row lines up under the header
    const tableRow = (key: string, first: unknown, rest: [unknown, number][], indent = 0) => (
      <Box key={key} flexDirection="row" gap={1} marginLeft={indent}>
        <Box flexGrow={1} flexShrink={1} minWidth={10}>
          {first as never}
        </Box>
        {rest.map(([c, w], i) => (
          <Box key={`${key}:c${i}`} width={w} flexShrink={0}>
            {typeof c === 'string' ? <Text dimColor wrap="truncate-end">{c}</Text> : (c as never)}
          </Box>
        ))}
      </Box>
    )
    // a table's header: dim bold labels (a label can be a button, e.g. to sort by that column)
    const headCell = (label: string) => <Text bold dimColor wrap="truncate-end">{label}</Text>
    // a diff, one column (colored by the Code element) or two (before | after)
    const diffView = (k: string, text: string) => {
      // # Line numbers in one column: the lines drawn one by one (the engine's diff view numbers nothing)
      if (!side && lineNos)
        return (
          <Box key={`dv:${k}`} flexDirection="column">
            {numberedDiff(text)
              .slice(0, 3000)
              .map((l, i) => (
                <Text key={`n${i}`} wrap={wrapMode} dimColor={l.kind === 'hunk' || l.kind === 'meta'} color={l.kind === 'del' ? 'diffRemoved' : l.kind === 'add' ? 'diffAdded' : undefined}>
                  {l.kind === 'hunk' || l.kind === 'meta' ? l.text : `${String(l.oldNo ?? '').padStart(5, ' ')} ${String(l.newNo ?? '').padStart(5, ' ')} ${l.text}`}
                </Text>
              ))}
          </Box>
        )
      if (!side) return Code ? <Code key={`dv:${k}`} source={text} format="diff" wrap={wrapMode} /> : <Text key={`dv:${k}`} wrap={wrapMode}>{text}</Text>
      const rows = sideBySide(text).slice(0, 1500)
      // a row's side: its line number (with # Line numbers), its sign, then the line, with the words that differ from
      // the other side highlighted
      const cellText = (r: (typeof rows)[number], which: 'left' | 'right') => {
        const v = which === 'left' ? r.left : r.right
        if (v === undefined) return ' '
        const no = lineNos ? `${String((which === 'left' ? r.leftNo : r.rightNo) ?? '').padStart(5, ' ')} ` : ''
        const changed = r.kind === 'change'
        const sign = no + (changed ? (which === 'left' ? '- ' : '+ ') : '  ')
        if (!changed || r.left === undefined || r.right === undefined || !v) return `${sign}${v || ' '}`
        const parts = wordDiff(r.left, r.right)[which]
        return [
          sign,
          ...parts.map((p, i) =>
            p.changed ? (
              <Text key={`w${i}`} backgroundColor={which === 'left' ? 'diffRemovedWord' : 'diffAddedWord'}>
                {p.text}
              </Text>
            ) : (
              p.text
            ),
          ),
        ]
      }
      // wrapped, the two sides wrap to different heights: draw row by row so each before stays beside its after
      if (wrap)
        return (
          <Box key={`dv:${k}`} flexDirection="column">
            {rows.map((r, i) => {
              if (r.kind === 'hunk' || r.kind === 'meta')
                return (
                  <Text wrap={wrapMode} key={`r${i}`} dimColor>
                    {r.left ?? ' '}
                  </Text>
                )
              const cell = (which: 'left' | 'right') => {
                const v = which === 'left' ? r.left : r.right
                const changed = r.kind === 'change' && v !== undefined
                return (
                  <Box key={which} flexGrow={1} flexShrink={1} width="50%">
                    <Text wrap={wrapMode} color={changed ? (which === 'left' ? 'diffRemoved' : 'diffAdded') : undefined}>
                      {cellText(r, which)}
                    </Text>
                  </Box>
                )
              }
              return (
                <Box key={`r${i}`} flexDirection="row" gap={1}>
                  {cell('left')}
                  {cell('right')}
                </Box>
              )
            })}
          </Box>
        )
      const col = (which: 'left' | 'right') => (
        <Box flexDirection="column" flexGrow={1} flexShrink={1} width="50%">
          {rows.map((r, i) => {
            const v = which === 'left' ? r.left : r.right
            if (r.kind === 'hunk' || r.kind === 'meta')
              return (
                <Text key={`${which}${i}`} dimColor wrap="truncate-end">
                  {which === 'left' ? v : ' '}
                </Text>
              )
            const changed = r.kind === 'change' && v !== undefined
            return (
              <Text key={`${which}${i}`} wrap="truncate-end" color={changed ? (which === 'left' ? 'diffRemoved' : 'diffAdded') : undefined}>
                {cellText(r, which)}
              </Text>
            )
          })}
        </Box>
      )
      return (
        <Box key={`dv:${k}`} flexDirection="row" gap={1}>
          {col('left')}
          {col('right')}
        </Box>
      )
    }
    // ⇆ Side by side (with the words that changed highlighted) and ␣ Ignore spaces, beside every diff
    const ignoreSpace = await read($, ignoreSpaceAtom)
    const wsArgs = ignoreSpace ? ['--ignore-all-space', '--ignore-blank-lines'] : []
    const sideToggle = (
      <Box key="diff-toggles" flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="side" variant={side ? 'primary' : 'secondary'} onPress={() => void update($, sideAtom, v => !v)}>
          ⇆ Side by side
        </Button>
        <Button key="ws" label="␣ Ignore spaces" variant={ignoreSpace ? 'primary' : 'secondary'} onPress={() => void update($, ignoreSpaceAtom, v => !v)} />
        <Button key="linenos" label="# Line numbers" variant={lineNos ? 'primary' : 'secondary'} onPress={() => void update($, lineNosAtom, v => !v)} />
      </Box>
    )
    // notes are a convenience: a store that can't be read leaves them out, never the pane
    step('reading notes')
    const notes = ((await within($, $.store.get('notes'), 2000, undefined)) ?? {}) as Record<string, Note>
    const noteOpen = await read($, noteOpenAtom)
    const saveNote = async (path: string, text: string) => {
      const all = ((await $.store.get('notes')) ?? {}) as Record<string, Note>
      const k = path.toLowerCase()
      if (text.trim()) all[k] = { text: text.trim(), at: Date.now() }
      else delete all[k]
      await $.store.set('notes', all)
      await update($, noteOpenAtom, () => '')
      await say(text.trim() ? 'Note saved.' : 'Note removed.')
    }
    // a file's note: shown above it; 🗒 opens a box to write it (kept across chats)
    const noteBlock = (path: string) => {
      const n = notes[path.toLowerCase()]
      const k = `note:${path}`
      if (noteOpen === path && Input)
        return (
          <Box key={`nb:${path}`} flexDirection="column" gap={1}>
            <Input
              key={`in:${k}`}
              label="🗒"
              rows={4}
              placeholder="A note about this file (only you see it)"
              value={typed.get(k) ?? n?.text ?? ''}
              submitLabel="keep"
              autoFocus
              onInput={(v: string) => void typed.set(k, v)}
              onSubmit={(v: string) => void typed.set(k, v)}
            />
            <Box flexDirection="row" gap={1}>
              <Button key={`ns:${path}`} variant="primary" onPress={() => void saveNote(path, typed.get(k) ?? n?.text ?? '')}>
                Save note
              </Button>
              <Button key={`nc:${path}`} onPress={() => void update($, noteOpenAtom, () => '')}>
                Cancel
              </Button>
            </Box>
          </Box>
        )
      return n ? (
        <Text wrap={wrapMode} key={`nt:${path}`} color="warning">
          🗒 {n.text}
        </Text>
      ) : null
    }
    const editing = await read($, editingAtom)
    const startEdit = (k: string, text: string) => {
      typed.set(k, text)
      return update($, editingAtom, () => k)
    }
    const stopEdit = () => update($, editingAtom, () => '')
    // backups stay in ~/.claude/file-pane-backups wherever the mod is loaded from (its own folder or ~/.claude/mods)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const backupDir = home
      ? join(join(home, '.claude'), 'file-pane-backups')
      : (() => {
          const root = $.plugin.root
          const i = root.toLowerCase().lastIndexOf('.claude')
          return join(i >= 0 ? root.slice(0, i + '.claude'.length) : root, 'file-pane-backups')
        })()
    const backups = () => backupDir
    // temp files (the picture at the last commit): beside the backups, never in a project
    const cacheDir = join(parent(backupDir), 'file-pane-cache')
    const say = (text: string) => update($, msgAtom, () => text)
    // a backup copy of `path` before a change, kept in the Backups list (with the file it's of)
    const backupOf = async (path: string): Promise<Record<string, unknown>> => {
      const b = await helper(['backup', path, backups()])
      if (b.ok && typeof b.backup === 'string') await update($, backupLogAtom, list => [{ backup: String(b.backup), original: path, at: Date.now() }, ...list].slice(0, 500))
      return b
    }
    const helper = async (args: string[], stdin?: string): Promise<Record<string, unknown>> => {
      try {
        const r = await $.process.run(['node', '--', helperFile($), ...args], { stdin, timeoutMs: 120_000 })
        return JSON.parse(r.stdout || '{}') as Record<string, unknown>
      } catch (err) {
        return { error: `Node couldn't run (${err instanceof Error ? err.message : String(err)}). Saving and big files need Node on PATH.` }
      }
    }

    // drawing only reads (the engine refuses a state write while drawing): no folder chosen yet is the session's own
    const dir = (await read($, dirAtom)) || (await $.session.cwd())
    const open = await read($, openAtom)
    const message = await read($, msgAtom)
    const limit = await read($, shownAtom)
    const lastBackup = await read($, backupAtom)
    const rows = Math.max(8, (e.viewport?.rows ?? 30) - 12)

    // ← → : every move to another folder or file is remembered (rec false: a move made by ← or → itself)
    const here = open ? open.path : dir
    const goDir = async (to: string, rec = true) => {
      if (rec) await rememberPlace($, to)
      draft = null
      await update($, openAtom, () => null)
      await update($, shownAtom, () => 0)
      await update($, dirAtom, () => to)
      await say('')
    }

    // ← back / → forward: the place shown now moves to the other list
    const goNav = async (dirn: 'back' | 'fwd') => {
      const n = await read($, navAtom)
      const to = dirn === 'back' ? n.back.at(-1) : n.fwd[0]
      if (!to) return
      await update($, navAtom, x =>
        dirn === 'back' ? { back: x.back.slice(0, -1), fwd: [here, ...x.fwd].slice(0, 50) } : { back: [...x.back, here].slice(-50), fwd: x.fwd.slice(1) },
      )
      await showPane($, PANE)
      await openPath(to, false)
    }

    const loadPage = async (path: string, start: number, size: number, mtimeMs: number) => {
      const r = await helper(['page', path, String(start), String(PAGE)])
      if (r.error) return say(`Couldn't read it: ${String(r.error)}`)
      const s = shown(String(r.text ?? ''))
      draft = null
      const file: OpenFile = { path, size, mtimeMs, mode: 'page', start, end: Number(r.end), text: s.text, eol: s.eol, bom: start === 0 && s.bom, binary: Boolean(r.binary) }
      await update($, openAtom, () => file)
      await say('')
    }

    const openPath = async (path: string, rec = true) => {
      let st
      try {
        st = await $.fs.stat(path)
      } catch (err) {
        return say(`Not found: ${path}`)
      }
      if (st.kind === 'dir') return goDir(path, rec)
      if (st.kind !== 'file') return say('That is neither a file nor a folder.')
      if (rec) await rememberPlace($, path)
      await update($, agentReadAtom, r => (r && r.path.toLowerCase() === path.toLowerCase() ? r : null))
      await update($, recentAtom, list => [path, ...list.filter(p => p.toLowerCase() !== path.toLowerCase())].slice(0, 15))
      await update($, dirAtom, () => parent(path))
      if (st.size > PAGE) return loadPage(path, 0, st.size, st.mtimeMs)
      let text = ''
      try {
        text = await $.fs.read(path)
      } catch (err) {
        return say(`Couldn't read it: ${err instanceof Error ? err.message : String(err)}`)
      }
      const s = shown(text)
      draft = null
      // reopened: a conflict warning about it is done with
      await update($, conflictAtom, c => (c && c.path.toLowerCase() === path.toLowerCase() ? null : c))
      const file: OpenFile = { path, size: st.size, mtimeMs: st.mtimeMs, mode: 'whole', start: 0, end: st.size, text: s.text, eol: s.eol, bom: s.bom, binary: text.slice(0, 8000).includes('\u0000') }
      await update($, openAtom, () => file)
      await say('')
    }

    const save = async (f: OpenFile) => {
      if (f.binary) return say('Binary files are view only.')
      const edited = draft && draft.key === `${f.path}|${f.start}` ? draft.text : null
      if (edited === null || edited === f.text) return say('Nothing changed to save.')
      // refused when someone else changed the file since it was opened
      const now = await $.fs.stat(f.path).catch(() => null)
      if (!now || now.size !== f.size || now.mtimeMs !== f.mtimeMs)
        return say('The file changed on disk since it was opened. Nothing was saved: reopen it to see the new version.')
      const b = await backupOf(f.path)
      if (!b.ok) return say(`Nothing was saved: the backup copy failed (${String(b.error ?? 'unknown')}).`)
      const text = (f.bom ? '\ufeff' : '') + (f.eol === '\r\n' ? edited.replace(/\r?\n/g, '\r\n') : edited)
      const r = await helper(['splice', f.path, String(f.start), String(f.end)], text)
      if (!r.ok) return say(`Not saved: ${String(r.error ?? 'unknown')}. The original is untouched; its copy is ${String(b.backup)}.`)
      await update($, backupAtom, () => String(b.backup))
      const st = await $.fs.stat(f.path)
      if (f.mode === 'page') await loadPage(f.path, f.start, st.size, st.mtimeMs)
      else await openPath(f.path)
      await say(`Saved. A copy from before is in ${String(b.backup)} (Revert puts it back).`)
    }

    const revert = async (f: OpenFile) => {
      if (!lastBackup) return say('No save to revert in this session.')
      const now = await $.fs.stat(f.path).catch(() => null)
      if (!now) return say('The file is gone; nothing was changed.')
      // the current version is kept too, so a revert can be undone the same way
      const b = await backupOf(f.path)
      if (!b.ok) return say(`Not reverted: couldn't copy the current version first (${String(b.error ?? 'unknown')}).`)
      const r = await helper(['restore', lastBackup, f.path])
      if (!r.ok) return say(`Not reverted: ${String(r.error ?? 'unknown')}.`)
      await update($, backupAtom, () => String(b.backup))
      await openPath(f.path)
      await say(`Put back the version from before the last save. The one it replaced is in ${String(b.backup)}.`)
    }

    // (a Git or Project tab left open from 0.4.7 still draws its page)
    const view: 'files' | 'git' | 'project' = e.requestId === GIT_PANE ? 'git' : e.requestId === PROJECT_PANE ? 'project' : await read($, viewAtom)
    const toggled = new Set(await read($, toggledAtom))
    const flip = (k: string) => update($, toggledAtom, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k].slice(-400)))

    /**
     * Lines [from, to) of a text file replaced by `next`: read again first and refused unless they're still `expected`
     * (someone else changed the file), a backup copy first, then written whole (temp file renamed over it).
     */
    const replaceLines = async (path: string, from: number, expected: string[], replacement: string[]): Promise<boolean> => {
      const st = await $.fs.stat(path).catch(() => null)
      if (!st) {
        await say('That file is gone.')
        return false
      }
      let text = ''
      try {
        text = await $.fs.read(path)
      } catch (err) {
        await say(`Couldn't read it: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const lines = text.split(/\r?\n/)
      if (lines.slice(from, from + expected.length).join('\n') !== expected.join('\n')) {
        await say('Those lines changed in the file since they were shown: nothing was changed (shown again now).')
        return false
      }
      lines.splice(from, expected.length, ...replacement)
      const b = await backupOf(path)
      if (!b.ok) {
        await say(`Not changed: the backup copy failed (${String(b.error ?? 'unknown')}).`)
        return false
      }
      const r = await helper(['splice', path, '0', String(st.size)], lines.join(eol))
      if (!r.ok) {
        await say(`Not changed: ${String(r.error ?? 'unknown')}.`)
        return false
      }
      return true
    }

    // an item's text typed in place (its box and indent kept); an empty text changes nothing
    const saveItem = async (path: string, line: number, raw: string, text: string) => {
      const m = /^(\s*[-*+]\s+\[.\]\s*)/.exec(raw)
      if (!m || !text.trim()) return stopEdit()
      if (await replaceLines(path, line, [raw], [m[1]! + text.trim()])) await say('Item saved.')
      await stopEdit()
    }
    // a new item after the last one under a heading (or after the heading itself)
    const addItem = async (path: string, afterLine: number, afterRaw: string, indent: string, text: string) => {
      if (!text.trim()) return stopEdit()
      if (await replaceLines(path, afterLine, [afterRaw], [afterRaw, `${indent}- [ ] ${text.trim()}`])) await say('Item added.')
      await stopEdit()
    }

    // a checkbox in a Markdown file: the line is read again and must still be the one shown; backup first
    const toggleTask = async (path: string, line: number, raw: string) => {
      const st = await $.fs.stat(path).catch(() => null)
      if (!st) return say('That file is gone.')
      let text = ''
      try {
        text = await $.fs.read(path)
      } catch (err) {
        return say(`Couldn't read it: ${err instanceof Error ? err.message : String(err)}`)
      }
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const lines = text.split(/\r?\n/)
      if (lines[line] !== raw) return say('That line changed in the file since it was shown: nothing was changed (shown again now).')
      // the first box is the one flipped: it was empty, so now it's ticked. With 📅 Done dates on, a tick writes
      // "(done <date time>)" after the item; an untick takes a date like that off either way
      const done = /\[( |x|X)\]/.exec(raw)?.[1] === ' '
      const dated = done && (await within($, $.store.get('tickDates'), 2000, undefined)) === true
      lines[line] = markDone(flipTask(raw), done, dated ? whenText(new Date().toISOString()) : undefined)
      const b = await backupOf(path)
      if (!b.ok) return say(`Not changed: the backup copy failed (${String(b.error ?? 'unknown')}).`)
      const r = await helper(['splice', path, '0', String(st.size)], lines.join(eol))
      if (!r.ok) return say(`Not changed: ${String(r.error ?? 'unknown')}.`)
      // logged for "what did I finish, when, where" (the pane's list, the ticks tool), and kept for Undo
      const tick: Tick = { path, item: raw.replace(/^\s*[-*+]\s+\[.\]\s*/, '').replace(DONE_DATE, ''), headings: headingPath(lines, line), done, at: Date.now(), line, raw: lines[line]! }
      await logTick($, tick)
      await update($, lastTickAtom, () => tick)
      await say(`${done ? 'Ticked' : 'Unticked'}: ${(tick.item || 'item').slice(0, 80)}`)
    }

    // ✎ Edit mode (per file): a click on an item or heading edits it in place instead of ticking. The engine's Button
    // only reports a press (no double-click, Esc or hover-to-show), so the mode is the switch, not a ✎ on every row.
    const editModes = await read($, editModeAtom)
    const inEditMode = (path: string) => editModes.some(p => p.toLowerCase() === path.toLowerCase())
    // a line holding several boxes: only the first is a checkbox, the rest are text; split it into one item each
    const splitRow = async (path: string, t: Task) => {
      if (await replaceLines(path, t.line, [t.raw], splitBoxes(t.raw))) await say(`Split into ${boxesIn(t.raw)} items.`)
    }
    // a checkbox row: tick it, or (in Edit mode) type its text (Enter saves; Cancel, as the engine has no Esc)
    const taskRow = (path: string, t: Task) => {
      const k = `${path}#${t.line}`
      const several = boxesIn(t.raw) > 1
      if (editing === k && Input)
        return (
          <Box key={`edit:${k}`} flexDirection="column">
            <Input
              key={`in:${k}`}
              value={typed.get(k) ?? t.text}
              submitLabel="save"
              autoFocus
              onInput={(v: string) => void typed.set(k, v)}
              onSubmit={(v: string) => void saveItem(path, t.line, t.raw, v)}
            />
            <Button key={`cancel:${k}`} plain onPress={() => void stopEdit()}>
              Cancel
            </Button>
          </Box>
        )
      const editHere = Boolean(Input) && inEditMode(path)
      return (
        <Box key={`row:${k}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button
              key={`t:${k}`}
              label={`${editHere ? '✎ ' : ''}${t.done ? '☑' : '☐'} ${t.text || '(empty item)'}`}
              plain
              dimColor={t.done}
              onPress={() => void (editHere ? startEdit(k, t.text) : toggleTask(path, t.line, t.raw))}
            />
          </Box>
          {several ? (
            <Box flexDirection="row" gap={1}>
              <Text wrap={wrapMode} color="warning">
                {`⚠ ${boxesIn(t.raw)} boxes on one line: only the first is a real checkbox`}
              </Text>
              {Input ? <Button key={`split:${k}`} label="Split into items" onPress={() => void splitRow(path, t)} /> : null}
            </Box>
          ) : null}
        </Box>
      )
    }
    // a box to add an item after `after` (the last item under a heading)
    const addRow = (path: string, after: Task, label: string) => {
      const k = `${path}#add:${after.line}`
      const indent = /^(\s*)/.exec(after.raw)?.[1] ?? ''
      if (!Input) return null
      if (editing === k)
        return (
          <Box key={`add:${k}`} flexDirection="column">
            <Input
              key={`in:${k}`}
              placeholder="New item"
              value={typed.get(k) ?? ''}
              submitLabel="add"
              autoFocus
              onInput={(v: string) => void typed.set(k, v)}
              onSubmit={(v: string) => void addItem(path, after.line, after.raw, indent, v)}
            />
            <Button key={`cancel:${k}`} plain onPress={() => void stopEdit()}>
              Cancel
            </Button>
          </Box>
        )
      return (
        <Button key={`addb:${k}`} label={`+ ${label}`} plain dimColor onPress={() => void startEdit(k, '')} />
      )
    }

    // lines drawn as Markdown, each checkbox a button (`budget` keeps the drawing under the pane's limit)
    let budget = DRAW
    // a heading inside a section: its own "x/y" when items sit under it; in Edit mode a click edits its text
    const headingRow = (path: string, lines: string[], i: number, list: Task[], keyBase: string) => {
      const raw = lines[i] ?? ''
      const m = /^(#{1,6})\s+(.*)$/.exec(raw)!
      const level = m[1]!.length
      let end = lines.length
      for (let j = i + 1; j < lines.length; j++) if ((/^(#{1,6})\s/.exec(lines[j] ?? '')?.[1]?.length ?? 9) <= level) {
        end = j
        break
      }
      const under = list.filter(t => t.line > i && t.line < end)
      const k = `${path}#head:${i}`
      if (editing === k && Input)
        return (
          <Box key={`hedit:${k}`} flexDirection="column">
            <Input
              key={`in:${k}`}
              label={m[1]}
              value={typed.get(k) ?? m[2]!}
              submitLabel="save"
              autoFocus
              onInput={(v: string) => void typed.set(k, v)}
              onSubmit={(v: string) => void (async () => {
                if (v.trim() && (await replaceLines(path, i, [raw], [`${m[1]} ${v.trim()}`]))) await say('Heading saved.')
                await stopEdit()
              })()}
            />
            <Button key={`cancel:${k}`} label="Cancel" plain onPress={() => void stopEdit()} />
          </Box>
        )
      const count = under.length ? (
        <Text wrap={wrapMode} color={under.every(x => x.done) ? 'success' : 'warning'}>
          {`${under.filter(x => x.done).length} of ${under.length} done`}
        </Text>
      ) : null
      return (
        <Box key={`${keyBase}:h:${i}`} flexDirection="row" gap={1}>
          {Input && inEditMode(path) ? (
            <Button key={`he:${k}`} label={`✎ ${m[2]}`} plain onPress={() => void startEdit(k, m[2]!)} />
          ) : Md ? (
            <Md key={`${keyBase}:hm:${i}`} text={raw} />
          ) : (
            <Text wrap={wrapMode} bold>
              {m[2]}
            </Text>
          )}
          {count}
        </Box>
      )
    }
    const drawLines = (path: string, lines: string[], from: number, to: number, keyBase: string, hideDone = false) => {
      const out = []
      let chunk: string[] = []
      const flush = (n: number) => {
        if (!chunk.length) return
        const t = chunk.join('\n')
        chunk = []
        if (!t.trim()) return
        const shown = t.slice(0, Math.max(0, budget))
        budget -= shown.length
        if (shown) out.push(Md ? <Md key={`${keyBase}:md:${n}`} text={shown} /> : <Text wrap={wrapMode} key={`${keyBase}:t:${n}`}>{shown}</Text>)
      }
      const list = tasks(lines.slice(0, to)).filter(x => x.line >= from)
      const at = new Map(list.map(x => [x.line, x]))
      let fence = false
      for (let i = from; i < to && budget > 0; i++) {
        const l = lines[i] ?? ''
        if (/^\s*```/.test(l)) fence = !fence
        if (!fence && /^#{1,6}\s+\S/.test(l)) {
          flush(i)
          budget -= l.length + 20
          out.push(headingRow(path, lines, i, list, keyBase))
          continue
        }
        const t = at.get(i)
        if (!t) {
          chunk.push(l)
          continue
        }
        flush(i)
        if (hideDone && t.done) continue
        budget -= t.text.length + 4
        out.push(taskRow(path, t))
      }
      flush(to)
      return out
    }

    const ago = (ms: number) => {
      const s = Math.round((Date.now() - ms) / 1000)
      return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : whenText(new Date(ms).toISOString())
    }
    // the last tick (a document or Items), with Undo for ten minutes; an untick says so in the warning color, as a
    // misclick there un-checks finished work
    const last = await read($, lastTickAtom)
    const undo = last && Date.now() - last.at < 10 * 60_000 ? last : null
    const undoBar = undo ? (
      <Box key="undo-bar" flexDirection="row" gap={1} flexWrap="wrap">
        <Text wrap={wrapMode} color={undo.done ? 'success' : 'warning'}>
          {`${undo.done ? '☑ Ticked' : '☐ Unticked'} ${ago(undo.at)}: ${undo.item.slice(0, 80) || 'item'}`}
        </Text>
        <Button key="tick-undo" label="↶ Undo" onPress={() => void (async () => {
          await toggleTask(undo.path, undo.line, undo.raw)
          await update($, lastTickAtom, () => null)
        })()} />
      </Box>
    ) : null
    // 📅 Done dates (every chat: kept in the store): a tick also writes "(done <date time>)" after the item, so the date
    // travels with the file (the tick log only sees the pane's own ticks)
    const tickDates = (await within($, $.store.get('tickDates'), 2000, undefined)) === true
    const tickDatesButton = (
      <Button key="tick-dates" label={tickDates ? '📅 Done dates: on' : '📅 Done dates'} variant={tickDates ? 'primary' : 'secondary'} onPress={() => void (async () => {
        await $.store.set('tickDates', !tickDates)
        await say(tickDates ? 'Ticks no longer write a date into the file.' : 'Ticks now write "(done <date time>)" after the item; unticking takes it off.')
      })()} />
    )

    const docView = async (path: string) => {
      let text = ''
      try {
        text = await $.fs.read(path)
      } catch (err) {
        return <Text wrap={wrapMode}>Couldn't read it as a document: {err instanceof Error ? err.message : String(err)}</Text>
      }
      const lines = text.replace(/^\ufeff/, '').split(/\r?\n/)
      const secs = sections(lines)
      const top = secs.filter(s => s.level === 1).length === 1 ? 2 : Math.min(...secs.map(s => s.level), 9)
      const parts = secs.filter(s => s.level === top)
      const short = text.length <= SHORT_DOC
      const isOpen = (k: string) => (toggled.has(`${path}#${k}`) ? !short : short)
      const open = parts.filter(s => isOpen(s.key)).length
      const counts = tasks(lines)
      const done = counts.filter(t => t.done).length
      const openOnly = await read($, openOnlyAtom)
      const onlyOpen = (k: string) => openOnly.includes(`${path}#${k}`)
      const flipOnlyOpen = (k: string) => update($, openOnlyAtom, list => (list.includes(`${path}#${k}`) ? list.filter(x => x !== `${path}#${k}`) : [...list, `${path}#${k}`].slice(-200)))
      const editMode = inEditMode(path)
      const recent = (await readTicks($)).filter(t => t.path.toLowerCase() === path.toLowerCase()).slice(0, 6)
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {counts.length ? (
              <Text wrap={wrapMode} dimColor>
                {done} of {counts.length} ticked
              </Text>
            ) : null}
            {Input ? (
              <Button
                key="edit-mode"
                label={editMode ? '✎ Edit mode: on (click to edit)' : '✎ Edit mode'}
                variant={editMode ? 'primary' : 'secondary'}
                onPress={() => void update($, editModeAtom, list => (editMode ? list.filter(p => p.toLowerCase() !== path.toLowerCase()) : [...list, path].slice(-50)))}
              />
            ) : null}
            {counts.length ? tickDatesButton : null}
            {parts.length > 1 ? (
              <Button key="doc-all" onPress={() => void update($, toggledAtom, list => {
                const keys = parts.map(s => `${path}#${s.key}`)
                const rest = list.filter(k => !keys.includes(k))
                // a short document is open unless flipped, a long one folded unless flipped
                const openAll = open < parts.length
                return openAll === short ? rest : [...rest, ...keys]
              })}>
                {open < parts.length ? 'Open all' : 'Fold all'}
              </Button>
            ) : null}
          </Box>
          {recent.length ? (
            <Box key="recent-ticks" flexDirection="column">
              <Text wrap={wrapMode} dimColor>
                Ticked recently (all chats; an agent asks with the ticks tool):
              </Text>
              {recent.map((t, i) => (
                <Text key={`rt:${i}`} wrap={wrapMode} dimColor={t.done} color={t.done ? undefined : 'warning'}>
                  {`  ${t.done ? '☑' : '☐ unticked'} ${t.item.slice(0, 70) || 'item'}${t.headings.length ? ` · ${t.headings[t.headings.length - 1]}` : ''} · ${ago(t.at)}`}
                </Text>
              ))}
            </Box>
          ) : null}
          {drawLines(path, lines, 0, parts[0]?.from ?? lines.length, 'pre')}
          {parts.map(s => (
            <Box key={`sec:${s.key}`} flexDirection="column">
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {editMode && Input && editing !== `${path}#head:${s.from}` ? (
                  <>
                    <Button key={`h:${s.key}`} label={isOpen(s.key) ? '▾' : '▸'} plain onPress={() => void flip(`${path}#${s.key}`)} />
                    <Button key={`he:${path}#head:${s.from}`} label={`✎ ${s.title}`} plain onPress={() => void startEdit(`${path}#head:${s.from}`, s.title)} />
                  </>
                ) : editMode && Input ? (
                  headingRow(path, lines, s.from, counts, `top:${s.key}`)
                ) : (
                  <Button key={`h:${s.key}`} label={`${isOpen(s.key) ? '▾' : '▸'} ${s.title}`} plain onPress={() => void flip(`${path}#${s.key}`)} />
                )}
                {(() => {
                  const t = counts.filter(x => x.line > s.from && x.line < s.to)
                  if (!t.length) return null
                  return [
                    <Text key={`cnt:${s.key}`} wrap={wrapMode} color={t.every(x => x.done) ? 'success' : 'warning'}>
                      {`${t.filter(x => x.done).length} of ${t.length} done`}
                    </Text>,
                    ...(t.some(x => x.done)
                      ? [<Button key={`oo:${s.key}`} label={onlyOpen(s.key) ? 'Show done too' : 'Only open'} plain dimColor onPress={() => void flipOnlyOpen(s.key)} />]
                      : []),
                  ]
                })()}
              </Box>
              {(() => {
                const k = `${path}#sec:${s.key}`
                const body = lines.slice(s.from + 1, s.to)
                if (editing === k && Input)
                  return (
                    <Box key={`secedit:${k}`} flexDirection="column" gap={1}>
                      <Input
                        key={`in:${k}`}
                        rows={Math.min(30, Math.max(6, body.length + 2))}
                        value={typed.get(k) ?? body.join('\n')}
                        submitLabel="keep"
                        autoFocus
                        onInput={(v: string) => void typed.set(k, v)}
                        onSubmit={(v: string) => void typed.set(k, v)}
                      />
                      <Box flexDirection="row" gap={1}>
                        <Button key={`save:${k}`} variant="primary" onPress={() => void (async () => {
                          const newText = (typed.get(k) ?? body.join('\n')).split(/\r?\n/)
                          if (await replaceLines(path, s.from + 1, body, newText)) await say(`Saved “${s.title}”.`)
                          await stopEdit()
                        })()}>
                          Save section
                        </Button>
                        <Button key={`cancel:${k}`} onPress={() => void stopEdit()}>
                          Cancel
                        </Button>
                      </Box>
                    </Box>
                  )
                return isOpen(s.key) ? (
                  <Box key={`secbody:${k}`} flexDirection="column">
                    {drawLines(path, lines, s.from + 1, s.to, `s:${s.key}`, onlyOpen(s.key))}
                    {Input ? (
                      <Button key={`secedit-b:${k}`} plain dimColor onPress={() => void startEdit(k, body.join('\n'))}>
                        ✎ Edit section
                      </Button>
                    ) : null}
                  </Box>
                ) : null
              })()}
            </Box>
          ))}
          {budget <= 0 ? <Text wrap={wrapMode} dimColor>(More below: fold some sections to see the rest.)</Text> : null}
        </Box>
      )
    }

    // git's answers are kept (gitCache): a tab draws at once from the last answer, and one older than 4 s is asked
    // again in the background (one run per question at a time, 20 s timeout), redrawing only when it changed
    const git = async (root: string, args: string[]) => {
      const k = `${root}\u0000${args.join('\u0000')}`
      const ask = async () => {
        try {
          return (await $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: root, timeoutMs: 20_000 })).stdout
        } catch {
          return ''
        }
      }
      const hit = gitCache.get(k)
      if (!hit) {
        const out = await ask()
        keepGit(k, out)
        return out
      }
      if (Date.now() - hit.at > 4_000 && !gitAsking.has(k)) {
        gitAsking.add(k)
        void ask().then(out => {
          gitAsking.delete(k)
          keepGit(k, out)
          if (out !== hit.out) $.ui.invalidate('ui.render')
        })
      }
      return hit.out
    }
    const diffOpen = new Set(await read($, diffOpenAtom))
    const flipDiff = (k: string) => update($, diffOpenAtom, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k].slice(-50)))
    // a file's changes against the last commit (an untracked file: all of it as added)
    const fileDiff = async (root: string, rel: string, untracked: boolean) =>
      untracked ? await git(root, ['diff', '--no-index', ...wsArgs, '--', '/dev/null', rel]) : await git(root, ['diff', ...wsArgs, 'HEAD', '--', rel])
    const diffBlock = (k: string, text: string) => {
      const shown = text.slice(0, Math.max(0, budget))
      budget -= shown.length
      if (!shown.trim()) return <Text wrap={wrapMode} key={`nd:${k}`} dimColor>No differences from the last commit.</Text>
      return diffView(`diff:${k}`, shown)
    }

    const LOG_FORMAT = '--format=%H%x09%ct%x09%an%x09%s'
    // one commit: its line (sha, subject, who, when); ▸ opens its files, each with its own diff
    const commitRow = async (root: string, c: { sha: string; at: number; author: string; subject: string }, scope: string, only?: string) => {
      const k = `commit:${scope}:${c.sha}`
      const now = Date.now()
      const tone = ageTone(c.at, now)
      let files: { path: string; add: number; del: number }[] = []
      if (diffOpen.has(k))
        files = (await git(root, ['show', '--numstat', '--format=', c.sha, ...(only ? ['--', only] : [])]))
          .split(/\r?\n/)
          .map(l => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l))
          .filter((m): m is RegExpExecArray => !!m)
          .map(m => ({ path: m[3]!, add: m[1] === '-' ? -1 : Number(m[1]), del: m[2] === '-' ? -1 : Number(m[2]) }))
          .slice(0, CHANGES_PAGE)
      const out = []
      for (const f of files) {
        const fk = `${k}:${f.path}`
        out.push(
          <Box key={`cf:${fk}`} flexDirection="column" marginLeft={2}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key={`cfd:${fk}`} label={`${diffOpen.has(fk) ? '▾' : '▸'} ${kindOf(f.path)[0]} ${f.path}`} plain onPress={() => void flipDiff(fk)} />
              <Text wrap={wrapMode} dimColor>{f.add < 0 ? 'binary' : `+${f.add} −${f.del}`}</Text>
            </Box>
            {diffOpen.has(fk) ? diffBlock(fk, await git(root, ['show', ...wsArgs, '--format=', c.sha, '--', f.path])) : null}
          </Box>,
        )
      }
      return (
        <Box key={`cm:${k}`} flexDirection="column">
          {tableRow(
            `cmr:${k}`,
            <Button key={`cmb:${k}`} label={`${diffOpen.has(k) ? '▾' : '▸'} ${c.sha.slice(0, 7)} ${c.subject}`} plain onPress={() => void flipDiff(k)} />,
            [
              [c.author, 14],
              [<Text wrap="truncate-end" color={tone === 'new' ? 'success' : undefined} dimColor={tone !== 'new'}>{`${age(c.at, now)} ago`}</Text>, 11],
            ],
          )}
          {out}
        </Box>
      )
    }

    // Branches: each local branch with its last commit and how far it is from its remote; Compare with this branch
    const gitBranchesView = async (root: string) => {
      const g = await read($, gitListAtom)
      const now = Date.now()
      const branches = branchesFrom(await git(root, ['branch', '--format=%(HEAD)%09%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)'])).sort(
        (a, b) => Number(b.current) - Number(a.current) || b.at - a.at,
      )
      const current = branches.find(b => b.current)?.name ?? (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      const remotes = (await git(root, ['branch', '-r', '--format=%(refname:short)'])).split(/\r?\n/).filter(l => l.trim() && !/\/HEAD$/.test(l))
      const other = g.compare && branches.some(b => b.name === g.compare) ? g.compare : ''
      let compare = null
      if (other) {
        // what each side has that the other hasn't, and the files that differ since they split
        const theirs = logFrom(await git(root, ['log', '-n', '20', LOG_FORMAT, `${current}..${other}`]))
        const mine = logFrom(await git(root, ['log', '-n', '20', LOG_FORMAT, `${other}..${current}`]))
        const files = (await git(root, ['diff', '--numstat', `${current}...${other}`]))
          .split(/\r?\n/)
          .map(l => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l))
          .filter((m): m is RegExpExecArray => !!m)
        const fileRows = []
        for (const m of files.slice(0, CHANGES_PAGE)) {
          const fk = `cmp:${other}:${m[3]}`
          fileRows.push(
            <Box key={`cmpf:${fk}`} flexDirection="column">
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Button key={`cmpd:${fk}`} label={`${diffOpen.has(fk) ? '▾' : '▸'} ${kindOf(m[3]!)[0]} ${m[3]}`} plain onPress={() => void flipDiff(fk)} />
                <Text wrap={wrapMode} dimColor>{m[1] === '-' ? 'binary' : `+${m[1]} −${m[2]}`}</Text>
              </Box>
              {diffOpen.has(fk) ? diffBlock(fk, await git(root, ['diff', ...wsArgs, `${current}...${other}`, '--', m[3]!])) : null}
            </Box>,
          )
        }
        const theirRows = []
        for (const c of theirs) theirRows.push(await commitRow(root, c, `theirs:${other}`))
        const mineRows = []
        for (const c of mine) mineRows.push(await commitRow(root, c, `mine:${other}`))
        compare = (
          <Box key="compare" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text wrap={wrapMode} bold>{`${current} ↔ ${other}`}</Text>
              <Button key="cmp-close" label="✕" plain onPress={() => void update($, gitListAtom, x => ({ ...x, compare: '' }))} />
            </Box>
            <Text wrap={wrapMode} dimColor>{`Only on ${other}: ${theirs.length}${theirs.length === 20 ? '+' : ''} commit${theirs.length === 1 ? '' : 's'}`}</Text>
            {theirRows}
            <Text wrap={wrapMode} dimColor>{`Only on ${current}: ${mine.length}${mine.length === 20 ? '+' : ''} commit${mine.length === 1 ? '' : 's'}`}</Text>
            {mineRows}
            <Text wrap={wrapMode} dimColor>{`${files.length} file${files.length === 1 ? '' : 's'} differ on ${other} since the two split${files.length > CHANGES_PAGE ? ` (the first ${CHANGES_PAGE})` : ''}`}</Text>
            {fileRows}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap={wrapMode} dimColor>{`${branches.length} local branch${branches.length === 1 ? '' : 'es'}${remotes.length ? `, ${remotes.length} on remotes` : ''}; newest first. Read only: switching branches is git's (or VS Code's) job.`}</Text>
          {branches.slice(0, CHANGES_PAGE).map(b => {
            const tone = ageTone(b.at, now)
            return (
              <Box key={`br:${b.name}`} flexDirection="row" gap={1} flexWrap="wrap">
                <Text wrap={wrapMode} bold={b.current} color={b.current ? 'success' : undefined}>{`${b.current ? '●' : '○'} ${b.name}`}</Text>
                <Text wrap={wrapMode} color={tone === 'new' ? 'success' : undefined} dimColor={tone === 'old'}>{`last commit ${age(b.at, now)} ago`}</Text>
                {b.upstream ? <Text wrap={wrapMode} color={b.ahead || b.behind ? 'warning' : undefined} dimColor={!b.ahead && !b.behind}>{`${b.ahead ? `↑${b.ahead} ` : ''}${b.behind ? `↓${b.behind} ` : ''}${b.ahead || b.behind ? `vs ${b.upstream}` : `= ${b.upstream}`}`}</Text> : <Text wrap={wrapMode} dimColor>no remote</Text>}
                {b.current ? null : <Button key={`br-cmp:${b.name}`} label={other === b.name ? 'Comparing' : 'Compare'} variant={other === b.name ? 'primary' : 'secondary'} onPress={() => void update($, gitListAtom, x => ({ ...x, compare: x.compare === b.name ? '' : b.name }))} />}
              </Box>
            )
          })}
          {compare}
        </Box>
      )
    }

    // 🌿 the Git window, one page (Strike, 2026-11-11): where the branch stands, the graph of every branch's recent
    // commits (a picture), those commits as rows (▸ files, ▸ a file's diff), then the uncommitted changes, Claude's
    // edits and the branches (with Compare), folded. Read only: nothing commits, switches or pushes.
    const GRAPH_ROWS = 30
    const LANE_COLORS = ['#4f9dff', '#3fb950', '#d29922', '#db61a2', '#a371f7', '#39c5cf', '#f85149', '#8b949e']
    const graphSvg = (rows: GraphRow[]) => {
      const rowH = 22
      const laneW = 14
      const lanesN = Math.max(1, ...rows.map(r => Math.max(r.col + 1, r.lanes.length)))
      const gx = (c: number) => 12 + c * laneW
      const gy = (i: number) => 14 + i * rowH
      const textX = gx(lanesN) + 6
      const W = 640
      const H = gy(rows.length - 1) + 14
      const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const parts: string[] = []
      rows.forEach((r, i) => {
        const below = rows[i + 1]
        r.lanes.forEach((p, L) => {
          if (!p) return
          const x1 = r.parents.includes(p) ? gx(r.col) : gx(L)
          const y1 = gy(i)
          const x2 = below && below.sha === p ? gx(below.col) : gx(L)
          const y2 = below ? gy(i + 1) : y1 + rowH / 2
          const color = LANE_COLORS[L % LANE_COLORS.length]
          parts.push(x1 === x2 ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2"/>` : `<path d="M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/>`)
        })
      })
      const now = Date.now()
      rows.forEach((r, i) => {
        const color = LANE_COLORS[r.col % LANE_COLORS.length]
        parts.push(`<circle cx="${gx(r.col)}" cy="${gy(i)}" r="${r.parents.length > 1 ? 3.5 : 4.5}" fill="${r.parents.length > 1 ? '#202124' : color}" stroke="${color}" stroke-width="2"/>`)
        let x = textX
        for (const ref of r.refs.slice(0, 3)) {
          const w = ref.length * 6.6 + 10
          parts.push(`<rect x="${x}" y="${gy(i) - 8}" width="${w}" height="16" rx="8" fill="${color}" fill-opacity="0.22" stroke="${color}"/><text x="${x + 5}" y="${gy(i) + 4}" font-size="11" fill="#e8eaed" font-family="Segoe UI, sans-serif">${esc(ref)}</text>`)
          x += w + 4
        }
        const room = Math.max(8, Math.floor((W - 70 - x) / 6.4))
        parts.push(`<text x="${x}" y="${gy(i) + 4}" font-size="12" fill="#e8eaed" font-family="Segoe UI, sans-serif">${esc(r.subject.length > room ? `${r.subject.slice(0, room - 1)}…` : r.subject)}</text>`)
        parts.push(`<text x="${W - 8}" y="${gy(i) + 4}" font-size="11" fill="#9aa0a6" text-anchor="end" font-family="Segoe UI, sans-serif">${esc(age(r.at, now))}</text>`)
      })
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="8" fill="#202124"/>${parts.join('')}</svg>`
    }
    const gitPage = async (root: string) => {
      if (!root || !(await repoOf($, root))) return <Text wrap={wrapMode} dimColor>This folder isn't in a git repository.</Text>
      const g = await read($, gitListAtom)
      // where this branch stands
      const branches = branchesFrom(await git(root, ['branch', '--format=%(HEAD)%09%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)']))
      const cur = branches.find(b => b.current)
      const status = (await git(root, ['status', '--porcelain=v1', '-uall'])).split(/\r?\n/).filter(l => l.length > 3)
      let add = 0
      let del = 0
      for (const l of (await git(root, ['diff', '--numstat', 'HEAD'])).split(/\r?\n/)) {
        const m = /^(\d+)\t(\d+)\t/.exec(l)
        if (m) {
          add += Number(m[1])
          del += Number(m[2])
        }
      }
      const claudeEdits = (await read($, changesAtom)).length
      // the graph: every branch's newest commits, a page of 30
      const page = g.page
      const rows = graphRows(await git(root, ['log', '--all', '--date-order', `--skip=${page * GRAPH_ROWS}`, '-n', String(GRAPH_ROWS + 1), '--format=%H%x09%P%x09%ct%x09%an%x09%D%x09%s']))
      const more = rows.length > GRAPH_ROWS
      const shownRows = rows.slice(0, GRAPH_ROWS)
      const list = []
      for (const r of shownRows) list.push(await commitRow(root, r, 'graph'))
      // a folded section: its header a plain row, open when pressed (kept per chat)
      const section = async (key: string, title: string, note: string, draw: () => Promise<unknown>) => {
        const isOpen = toggled.has(`git:${key}`)
        return card(key, title, note, isOpen ? await draw() : null, { open: isOpen, toggle: () => void flip(`git:${key}`), button: `sec-btn:${key}` })
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap={wrapMode}>
            {`On ${cur?.name ?? '(no branch)'}`}
            {cur?.upstream ? <Text color={cur.ahead || cur.behind ? 'warning' : undefined} dimColor={!cur.ahead && !cur.behind}>{` · ${cur.ahead ? `↑${cur.ahead} ` : ''}${cur.behind ? `↓${cur.behind} ` : ''}${cur.ahead || cur.behind ? `vs ${cur.upstream}` : `up to date with ${cur.upstream}`}`}</Text> : <Text dimColor> · no remote</Text>}
            <Text dimColor>{` · ${branches.length} branch${branches.length === 1 ? '' : 'es'}`}</Text>
            {status.length ? <Text color="warning">{` · ${status.length} uncommitted`}</Text> : <Text dimColor> · nothing uncommitted</Text>}
          </Text>
          {shownRows.length && Svg ? card('graph', 'Graph', `every branch · ${page ? `commits ${page * GRAPH_ROWS + 1}-${page * GRAPH_ROWS + shownRows.length}` : `newest ${shownRows.length}`}`, <Svg key="git-graph" alt={`The newest ${shownRows.length} commits of every branch, as a graph`} source={graphSvg(shownRows)} />) : null}
          {shownRows.length ? card('commits', 'Commits', `${shownRows.length}${more ? '+' : ''}`, [tableRow('cm-head', headCell('Commit'), [[headCell('Author'), 14], [headCell('When'), 11]]), ...list]) : null}
          {page > 0 || more ? (
            <Box key="graph-pages" flexDirection="row" gap={1} flexWrap="wrap">
              {page > 0 ? <Button key="graph-newer" label="◀ Newer" plain onPress={() => void update($, gitListAtom, x => ({ ...x, page: Math.max(0, page - 1) }))} /> : null}
              {more ? <Button key="graph-older" label="Older ▶" plain onPress={() => void update($, gitListAtom, x => ({ ...x, page: page + 1 }))} /> : null}
            </Box>
          ) : null}
          {!shownRows.length ? <Text wrap={wrapMode} dimColor>No commits yet.</Text> : null}
          {await section('uncommitted', 'Uncommitted changes', status.length ? `${status.length} file${status.length === 1 ? '' : 's'} · +${add.toLocaleString('en-US')} −${del.toLocaleString('en-US')}` : 'none', () => changesView(root, 'git'))}
          {await section('claude', "Claude's edits this chat", claudeEdits ? `${claudeEdits} file${claudeEdits === 1 ? '' : 's'}` : 'none yet', () => changesView(root, 'changes'))}
          {await section('branches', 'Branches', `${branches.length} · ${branches.filter(b => b.ahead || b.behind).length} out of step with their remote · Compare`, () => gitBranchesView(root))}
          <Text wrap={wrapMode} dimColor>Read only: commit, switch and push in git or VS Code.</Text>
        </Box>
      )
    }

    const changesView = async (root: string, tab: 'changes' | 'git') => {
      const g0 = await read($, gitListAtom)
      const rel = (p: string) => (p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length).replace(/^[\\/]/, '') : p)
      const status = await git(root, ['status', '--porcelain=v1', '-uall'])
      const states = new Map<string, string>()
      const names = new Map<string, string>() // the same keys, the path as git wrote it (keys are lower case)
      for (const l of status.split(/\r?\n/))
        if (l.length > 3) {
          const name = l.slice(3).replace(/^"|"$/g, '')
          states.set(name.toLowerCase(), l.slice(0, 2))
          names.set(name.toLowerCase(), name)
        }
      const label = (x: string) => (x === '??' ? 'new' : x.includes('M') ? 'changed' : x.includes('A') ? 'added' : x.includes('D') ? 'deleted' : x.includes('R') ? 'renamed' : x.trim())
      // lines added / removed against the last commit: git's numstat for tracked files, a line count for new ones
      const plus = new Map<string, [number, number]>()
      let ns = numstats.get(root)
      if (!ns || ns.key !== status || Date.now() - ns.at > 5_000) {
        ns = { key: status, at: Date.now(), text: await git(root, ['diff', '--numstat', 'HEAD']) }
        numstats.set(root, ns)
      }
      for (const l of ns.text.split(/\r?\n/)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l)
        if (m) plus.set(m[3]!.replace(/^"|"$/g, '').toLowerCase(), [m[1] === '-' ? -1 : Number(m[1]), m[2] === '-' ? -1 : Number(m[2])])
      }
      const untracked = [...states.entries()].filter(([, x]) => x === '??').map(([r]) => names.get(r) ?? r)
      if (untracked.length) {
        const key = untracked.join('\n')
        let c = newLines.get(root)
        if (!c || c.key !== key || Date.now() - c.at > 15_000) {
          const r = await helper(['lines', root], JSON.stringify(untracked))
          c = { key, at: Date.now(), counts: (r.counts ?? {}) as Record<string, number> }
          newLines.set(root, c)
        }
        for (const [n, v] of Object.entries(c.counts)) plus.set(n.toLowerCase(), [v, v < 0 ? -1 : 0])
      }
      const all =
        tab === 'changes'
          ? (await read($, changesAtom)).map(c => ({ path: c.path, rel: rel(c.path).replace(/\\/g, '/'), note: `${c.tool}${c.n > 1 ? ` ×${c.n}` : ''} · ${new Date(c.at).toLocaleTimeString()}`, before: c.before }))
          : [...states.entries()].map(([r, x]) => ({ path: join(root, names.get(r) ?? r), rel: names.get(r) ?? r, note: label(x), before: undefined as string | undefined }))
      const branch = tab === 'git' ? (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() : ''
      // each file's kind (for the filter and its colour) and its + / − lines
      const rows = all.map((row, i) => {
        const st = states.get(row.rel.toLowerCase())
        const lb = st ? label(st) : ''
        const kind = !st ? 'committed' : lb === 'new' || lb === 'added' ? 'new' : lb === 'deleted' ? 'deleted' : 'changed'
        const [add, del] = plus.get(row.rel.toLowerCase()) ?? [0, 0]
        return { ...row, i, st, lb, kind, add, del }
      })
      type Row = (typeof rows)[number]
      const g = g0
      // when each file was last changed on disk, and its newest commit (one git log for all), kept 15 s
      // (worked out in the background, a few hundred file dates in a big repo: the list draws at once, the dates
      // fill in when ready)
      const old = gitDates.get(root)
      if ((!old || old.key !== status + rows.length || Date.now() - old.at > 15_000) && !gitAsking.has(`dates:${root}`)) {
        gitAsking.add(`dates:${root}`)
        void (async () => {
          const disk = new Map<string, number>()
          for (const r of rows.slice(0, 2000)) {
            const st = await $.fs.stat(r.path).catch(() => null)
            if (st) disk.set(r.rel.toLowerCase(), st.mtimeMs)
          }
          const committed = lastCommitByFile(await git(root, ['log', '-n', '400', '--format=%x01%ct', '--name-only']))
          gitDates.set(root, { key: status + rows.length, at: Date.now(), disk, committed })
          gitAsking.delete(`dates:${root}`)
          $.ui.invalidate('ui.render')
        })()
      }
      const dates = old ?? { key: '', at: 0, disk: new Map<string, number>(), committed: new Map<string, number>() }
      const nowMs = Date.now()
      const find = g.find.trim().toLowerCase()
      const counts = { all: rows.length, changed: 0, new: 0, deleted: 0 }
      let addAll = 0
      let delAll = 0
      for (const r of rows) {
        if (r.kind !== 'committed') counts[r.kind as 'changed' | 'new' | 'deleted']++
        addAll += Math.max(0, r.add)
        delAll += Math.max(0, r.del)
      }
      const weight = (r: { add: number; del: number }) => Math.max(0, r.add) + Math.max(0, r.del)
      const KIND_ORDER: Record<string, number> = { changed: 0, new: 1, deleted: 2, committed: 3 }
      const editedAt = (r: Row) => dates!.disk.get(r.rel.toLowerCase()) ?? 0
      const order = (a: Row, b: Row) =>
        g.sort === 'newest' ? editedAt(b) - editedAt(a) || a.rel.localeCompare(b.rel)
        : g.sort === 'lines' ? weight(b) - weight(a) || a.rel.localeCompare(b.rel)
        : g.sort === 'kind' ? KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]! || a.rel.localeCompare(b.rel)
        : tab === 'changes' ? a.i - b.i // Changes: newest first, as it was
        : a.rel.localeCompare(b.rel)
      const shown = rows.filter(r => (g.kind === 'all' || r.kind === g.kind) && (!find || r.rel.toLowerCase().includes(find))).sort(order)
      const set = (f: (x: GitList) => GitList) => void update($, gitListAtom, f)
      const n = (x: number) => x.toLocaleString('en-US')
      const lines = (r: { add: number; del: number }) => (r.add < 0 ? 'binary' : `+${n(r.add)} −${n(r.del)}`)

      const fileRow = async (row: Row, depth: number, name: string) => {
        const k = `${tab}:${row.rel}`
        // when: edited on disk (green within a day, dim after a week), and its newest commit
        const ed = row.kind === 'deleted' ? undefined : dates!.disk.get(row.rel.toLowerCase())
        const cm = dates!.committed.get(row.rel.toLowerCase())
        const tone = ed ? ageTone(ed, nowMs) : 'old'
        const ago = (ms: number) => (age(ms, nowMs) === 'just now' ? 'just now' : `${age(ms, nowMs)} ago`)
        return (
          <Box key={`ch:${k}`} flexDirection="column">
            {tableRow(
              `chr:${k}`,
              <Box flexDirection="row" gap={1} marginLeft={depth * 2}>
                <Button key={`d:${k}`} label={`${diffOpen.has(k) ? '▾' : '▸'} ${kindOf(row.rel)[0]} ${name}`} plain onPress={() => void flipDiff(k)} />
                {row.kind === 'deleted' ? null : (
                  <Button key={`o:${k}`} label="Open" plain dimColor onPress={() => void (async () => {
                    await showPane($, PANE)
                    await openPath(row.path)
                  })()} />
                )}
                {row.before ? (
                  // Claude's own change: the file against the copy made before its first edit this session
                  <Button key={`cl:${k}`} label="± Claude's" plain onPress={() => void (async () => {
                    await update($, diffBaseAtom, () => ({ path: row.path, base: 'claude' }))
                    await update($, diffOpenAtom, list => [...list.filter(x => x !== `filediff:${row.path}`), `filediff:${row.path}`].slice(-50))
                    await showPane($, PANE)
                    await openPath(row.path)
                  })()} />
                ) : null}
              </Box>,
              [
                [<Text wrap="truncate-end" color={GIT_COLOR[tab === 'git' ? row.note : row.lb]}>{`● ${tab === 'git' ? row.note : row.st ? row.lb : 'committed'}`}</Text>, 10],
                [lines(row), 12],
                [ed ? <Text wrap="truncate-end" color={tone === 'new' ? 'success' : undefined} dimColor={tone !== 'new'}>{ago(ed)}</Text> : '', 11],
                [cm ? ago(cm) : 'never', 11],
              ],
            )}
            {tab === 'changes' ? <Text key={`tool:${k}`} wrap={wrapMode} dimColor>{`   ${row.note}`}</Text> : null}
            {diffOpen.has(k) ? diffBlock(k, await fileDiff(root, row.rel, row.st === '??')) : null}
          </Box>
        )
      }

      const out = []
      let more = ''
      if (g.folders && !find) {
        // 📁 a folder tree: each folder with its files' count and lines, folded until pressed; a folder holding
        // just one folder shows as one (src/components). At most CHANGES_PAGE rows, then a note.
        let left = CHANGES_PAGE
        const openSet = new Set(g.open)
        const small = shown.length <= CHANGES_PAGE // few files: everything unfolded
        const walk = async (prefix: string, list: Row[], depth: number) => {
          const dirs = new Map<string, Row[]>()
          const here: Row[] = []
          for (const r of list) {
            const rest = r.rel.slice(prefix.length)
            const cut = rest.indexOf('/')
            if (cut < 0) here.push(r)
            else dirs.set(rest.slice(0, cut), [...(dirs.get(rest.slice(0, cut)) ?? []), r])
          }
          const folders = [...dirs.entries()].map(([d, rs]) => {
            // join single-folder chains: a/b/c with nothing else in a or a/b
            let name = d
            for (;;) {
              const p = `${prefix}${name}/`
              const subs = new Set(rs.map(r => r.rel.slice(p.length).split('/')[0]))
              if (subs.size !== 1 || rs.some(r => !r.rel.slice(p.length).includes('/'))) break
              name = `${name}/${[...subs][0]}`
            }
            return { name, rows: rs, add: rs.reduce((s, r) => s + Math.max(0, r.add), 0), del: rs.reduce((s, r) => s + Math.max(0, r.del), 0) }
          })
          folders.sort((a, b) => (g.sort === 'lines' ? weight(b) - weight(a) : 0) || a.name.localeCompare(b.name))
          for (const f of folders) {
            if (left <= 0) return
            left--
            const p = `${prefix}${f.name}/`
            const isOpen = small || openSet.has(p)
            out.push(
              <Box key={`dir:${tab}:${p}`} flexDirection="row" gap={1} flexWrap="wrap" marginLeft={depth * 2}>
                <Button key={`dir:${p}`} label={`${isOpen ? '▾' : '▸'} 📁 ${f.name}/`} plain onPress={() => set(x => ({ ...x, open: x.open.includes(p) ? x.open.filter(o => o !== p) : [...x.open, p].slice(-200) }))} />
                <Text wrap={wrapMode} dimColor>{`${f.rows.length} file${f.rows.length === 1 ? '' : 's'} · +${n(f.add)} −${n(f.del)}`}</Text>
              </Box>,
            )
            if (isOpen) await walk(p, f.rows, depth + 1)
          }
          for (const r of here) {
            if (left <= 0) return
            left--
            out.push(await fileRow(r, depth, r.rel.slice(prefix.length)))
          }
        }
        await walk('', shown, 0)
        if (left <= 0) more = `Showing the first ${CHANGES_PAGE} rows: fold some folders, pick a kind, or 🔎 find, to see the rest.`
      } else {
        // ☰ a list (or 🔎 matches), a page at a time
        const pages = Math.max(1, Math.ceil(shown.length / CHANGES_PAGE))
        const page = Math.min(g.page, pages - 1)
        for (const r of shown.slice(page * CHANGES_PAGE, (page + 1) * CHANGES_PAGE)) out.push(await fileRow(r, 0, r.rel))
        if (pages > 1)
          out.push(
            <Box key="ch-pages" flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="ch-prev" label="◀ Previous" variant="secondary" onPress={() => set(x => ({ ...x, page: Math.max(0, page - 1) }))} />
              <Text wrap={wrapMode} dimColor>{`Page ${page + 1} of ${pages} · ${page * CHANGES_PAGE + 1}-${Math.min(shown.length, (page + 1) * CHANGES_PAGE)} of ${shown.length}`}</Text>
              <Button key="ch-next" label="Next ▶" variant="secondary" onPress={() => set(x => ({ ...x, page: Math.min(pages - 1, page + 1) }))} />
            </Box>,
          )
      }

      const kindName = { all: 'All', changed: 'Changed', new: 'New', deleted: 'Deleted' } as const
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap={wrapMode} dimColor>
            {tab === 'changes'
              ? `${rows.length} file${rows.length === 1 ? '' : 's'} Claude edited this session (newest first) · +${n(addAll)} −${n(delAll)} against the last commit; ▸ shows the diff`
              : `${branch ? `On ${branch} · ` : ''}${rows.length} file${rows.length === 1 ? '' : 's'}: ${counts.changed} changed, ${counts.new} new, ${counts.deleted} deleted · +${n(addAll)} −${n(delAll)} lines`}
          </Text>
          {rows.length ? (
            <Box key="ch-tools" flexDirection="row" gap={1} flexWrap="wrap">
              {/* the kinds there are (none when there's only one kind), one sort button that cycles, folders or a list */}
              {(['all', 'changed', 'new', 'deleted'] as const).filter(kd => (kd === 'all' || counts[kd] > 0) && [counts.changed, counts.new, counts.deleted].filter(Boolean).length > 1).map(kd => (
                <Button key={`ch-kind:${kd}`} label={`${kindName[kd]} ${counts[kd]}`} plain variant={g.kind === kd ? 'primary' : 'secondary'} onPress={() => set(x => ({ ...x, kind: kd, page: 0 }))} />
              ))}
              {(() => {
                const order = tab === 'git' ? (['path', 'newest', 'lines', 'kind'] as const) : (['path', 'lines', 'kind'] as const)
                const name = (o: string) => (o === 'path' ? (tab === 'changes' ? 'Newest' : 'Path') : o === 'newest' ? 'Recently edited' : o === 'lines' ? 'Most lines' : 'Kind')
                const at = Math.max(0, (order as readonly string[]).indexOf(g.sort))
                return <Button key="ch-sort" label={`↕ ${name(order[at]!)}`} plain onPress={() => set(x => ({ ...x, sort: order[(at + 1) % order.length]!, page: 0 }))} />
              })()}
              <Button key="ch-folders" label={g.folders ? '📁 Folders' : '☰ List'} plain onPress={() => set(x => ({ ...x, folders: !x.folders, page: 0 }))} />
              {g.folders && g.open.length ? <Button key="ch-fold" label="Fold all" plain onPress={() => set(x => ({ ...x, open: [] }))} /> : null}
              {find ? <Button key="ch-find-clear" label="✕ All" onPress={() => set(x => ({ ...x, find: '', page: 0 }))} /> : null}
            </Box>
          ) : null}
          {(rows.length > 20 || find) && Input ? (
            <Input key="ch-find" label="🔎" placeholder="Find by part of a path (Enter)" value={g.find} submitLabel="find" onSubmit={(v: string) => set(x => ({ ...x, find: v, page: 0 }))} />
          ) : null}
          {rows.length ? tableRow('ch-head', headCell('File'), [[headCell(tab === 'git' ? 'Kind' : 'In git'), 10], [headCell('Lines'), 12], [headCell('Edited'), 11], [headCell('Committed'), 11]]) : null}
          {find || g.kind !== 'all' ? <Text wrap={wrapMode} dimColor>{`${shown.length} of ${rows.length} match${find ? ` "${find}"` : ''}${g.kind !== 'all' ? ` · ${kindName[g.kind].toLowerCase()} only` : ''}`}</Text> : null}
          {out}
          {more ? <Text wrap={wrapMode} dimColor>{more}</Text> : null}
          {!rows.length ? <Text wrap={wrapMode} dimColor>{tab === 'changes' ? 'No edits yet this session.' : status ? 'Nothing changed since the last commit.' : 'Not a git folder.'}</Text> : null}
        </Box>
      )
    }

    // Checks: the project's own scripts (package.json), one at a time, results kept for the session
    const checksView = async (root: string) => {
      let scripts: string[] = []
      try {
        scripts = Object.keys((JSON.parse(await $.fs.read(join(root, 'package.json'))) as { scripts?: Record<string, string> }).scripts ?? {})
      } catch {
        /* no package.json */
      }
      const wanted = scripts.filter(s => /^(test|build|lint|typecheck|check|tsc)$/i.test(s))
      const running = await read($, runningAtom)
      const results = await read($, resultsAtom)
      const win = /^[A-Za-z]:/.test(root)
      const run = async (name: string) => {
        if (await read($, runningAtom)) return
        await update($, runningAtom, () => name)
        const t0 = Date.now()
        try {
          const argv = win ? ['cmd.exe', '/d', '/s', '/c', `npm run ${name}`] : ['npm', 'run', name]
          const r = await $.process.run(argv, { cwd: root, timeoutMs: 600_000 })
          const all = `${r.stdout}\n${r.stderr}`.replace(ANSI, '')
          const lines = all.split(/\r?\n/).filter(l => l.trim())
          const summary = lines.filter(l => /^\s*(Tests|Test Files)\s|✓ built|Found \d+ (error|warning)|error TS|\d+ (passed|failed)/.test(l)).slice(-3).join(' · ')
          const failures = lines.filter(l => /(^|\s)(FAIL|×|✘)\s|error TS\d+|^\s*Error:|AssertionError/.test(l)).slice(0, 20)
          const result: CheckResult = { ok: r.exitCode === 0, at: Date.now(), secs: Math.round((Date.now() - t0) / 1000), summary, failures, tail: lines.slice(-25).join('\n') }
          await update($, resultsAtom, m => ({ ...m, [name]: result }))
        } catch (err) {
          await update($, resultsAtom, m => ({ ...m, [name]: { ok: false, at: Date.now(), secs: Math.round((Date.now() - t0) / 1000), summary: err instanceof Error ? err.message : String(err), failures: [], tail: '' } }))
        } finally {
          await update($, runningAtom, () => '')
        }
      }
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {wanted.map(s => (
              <Button key={`run:${s}`} label={running === s ? `Running ${s}…` : `▶ ${s}`} variant={running === s ? 'primary' : 'secondary'} onPress={() => void run(s)} />
            ))}
          </Box>
          {!wanted.length ? <Text wrap={wrapMode} dimColor>No test / build / lint scripts in package.json here.</Text> : null}
          {running ? <Text wrap={wrapMode} dimColor>One at a time: {running} is running.</Text> : null}
          {wanted
            .filter(s => results[s])
            .map(s => {
              const r = results[s]!
              const k = `check:${s}`
              return (
                <Box key={k} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={`h:${k}`} label={`${r.ok ? '✅' : '❌'} ${s}`} plain onPress={() => void flipDiff(k)} />
                    <Text wrap={wrapMode} color={r.ok ? 'success' : 'error'}>{r.ok ? 'passed' : 'failed'}</Text>
                    <Text wrap={wrapMode} dimColor>
                      {r.secs}s · {new Date(r.at).toLocaleTimeString()}
                      {r.summary ? ` · ${r.summary}` : ''}
                    </Text>
                  </Box>
                  {r.failures.length ? (
                    <Text color="error" wrap={wrapMode}>
                      {r.failures.join('\n')}
                    </Text>
                  ) : null}
                  {diffOpen.has(k) && r.tail ? (Code ? <Code key={`tail:${k}`} source={r.tail} wrap={wrapMode} /> : <Text wrap={wrapMode}>{r.tail}</Text>) : null}
                </Box>
              )
            })}
        </Box>
      )
    }

    // Log: the newest .log of the app this project builds (its data folder's logs, or the project's own), followed live
    const logView = async (root: string) => {
      if (!appDirs) {
        appDirs = [await $.env.get('APPDATA'), await $.env.get('LOCALAPPDATA')].filter((x): x is string => Boolean(x))
      }
      let pkgName = ''
      try {
        pkgName = String((JSON.parse(await $.fs.read(join(root, 'package.json'))) as { name?: string }).name ?? '')
      } catch {
        /* no package.json */
      }
      const base = root.split(/[\\/]/).filter(Boolean).pop() ?? ''
      const candidates = [join(root, 'logs'), ...appDirs.flatMap(d => [base, pkgName].filter(Boolean).map(n => join(join(d, n), 'logs')))]
      let newest: { path: string; at: number; size: number } | null = null
      for (const dir of candidates) {
        const list = await $.fs.list(dir).catch(() => [])
        for (const x of list) if (x.kind === 'file' && /\.log$/i.test(x.name) && (!newest || x.mtimeMs > newest.at)) newest = { path: join(dir, x.name), at: x.mtimeMs, size: x.size }
      }
      const errorsOnly = await read($, logErrorsAtom)
      if (!newest) return <Text wrap={wrapMode} dimColor>No .log file in {candidates.join(', ')}.</Text>
      const start = Math.max(0, newest.size - 48_000)
      const r = await helper(['page', newest.path, String(start), '48000'])
      let lines = String(r.text ?? '').split(/\r?\n/)
      if (start > 0) lines = lines.slice(1)
      const bad = /\b(error|errors|failed|exception|fatal|threw|refused)\b/i
      const warn = /\bwarn(ing)?\b/i
      if (errorsOnly) lines = lines.filter(l => bad.test(l) || warn.test(l))
      const shown = lines.filter(l => l.trim()).slice(-200)
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text wrap={wrapMode} dimColor>
              {newest.path} · {sizeText(newest.size)} · following (every 2 s)
            </Text>
            <Button key="log-err" variant={errorsOnly ? 'primary' : 'secondary'} onPress={() => void update($, logErrorsAtom, v => !v)}>
              ⚠ Errors and warnings only
            </Button>
            <Button key="log-open" onPress={() => void (async () => {
              await showPane($, PANE)
              await openPath(newest!.path)
            })()}>
              Open whole log
            </Button>
          </Box>
          {shown.map((l, i) => {
            const m = /^(\d{2}:\d{2}:\d{2}\S*)\s+(.*)$/.exec(l)
            const color = bad.test(l) ? 'error' : warn.test(l) ? 'warning' : undefined
            return (
              <Text key={`log:${i}`} wrap={wrapMode} color={color}>
                {m ? <Text wrap={wrapMode} color="subtle">{m[1]} </Text> : null}
                {m ? m[2] : l}
              </Text>
            )
          })}
          {!shown.length ? <Text wrap={wrapMode} dimColor>{errorsOnly ? 'No errors or warnings in the last part of the log.' : 'The log is empty.'}</Text> : null}
        </Box>
      )
    }

    // Notes: every file note (kept across chats), newest first
    const notesView = () => {
      const list = Object.entries(notes).sort((a, b) => b[1].at - a[1].at)
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap={wrapMode} dimColor>
            {list.length} note{list.length === 1 ? '' : 's'} (🗒 Note on any open file writes one)
          </Text>
          {list.map(([p, n]) => (
            <Box key={`note:${p}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button key={`no:${p}`} label={`${kindOf(p)[0]} ${p.split(/[\\/]/).pop()}`} plain onPress={() => void (async () => {
                  await showPane($, PANE)
                  await openPath(p)
                })()} />
                <Text wrap={wrapMode} dimColor>{new Date(n.at).toLocaleString()}</Text>
              </Box>
              <Text wrap={wrapMode} color="warning">🗒 {n.text}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    // Next: the sections of the project's notes that say what's next (open issues, to-dos, plans), editable
    // ☑ Project's dashboard (Strike, 2026-11-11): one page of cards, each title opening its full page in place.
    // Next (the project's next-steps section), Items (a bar per file), Checks (last results), Commits, Ticks today,
    // and More (the rarer pages)
    const overview = async (root: string, hasScripts: boolean) => {
      const go = (k: ProjectTab) => () => void update($, tabAtom, () => k)
      const bar = (done: number, total: number) => {
        const n = total ? Math.round((done / total) * 10) : 0
        return `${'█'.repeat(n)}${'░'.repeat(10 - n)}`
      }
      // Next: the first next-steps section of the handoff / next / todo docs, its first lines
      let nextTitle = ''
      let nextLines: string[] = []
      for (const f of (await markdownFiles($, root)).filter(x => /(HANDOFF|NEXT|TODO|ROADMAP|README|PLAN)[^\\/]*\.md$/i.test(x))) {
        const lines = (await $.fs.read(f).catch(() => '')).replace(/^\ufeff/, '').split(/\r?\n/)
        const sec = sections(lines).find(x => x.level <= 3 && NEXT_HEADING.test(x.title))
        if (sec) {
          nextTitle = `${sec.title} · ${f.slice(root.length).replace(/^[\\/]/, '')}`
          nextLines = lines.slice(sec.from + 1, sec.to).map(l => l.trim()).filter(l => l && !l.startsWith('#')).slice(0, 4)
          break
        }
      }
      // Items: open of total per file, the files with most open first
      const files = await projectTasks($, root)
      const openAll = files.reduce((n, f) => n + f.tasks.filter(t => !t.done).length, 0)
      const byOpen = files
        .map(f => ({ f, open: f.tasks.filter(t => !t.done).length, done: f.tasks.filter(t => t.done).length }))
        .filter(x => x.open)
        .sort((a, b) => b.open - a.open)
        .slice(0, 6)
      // Checks: the last result of each
      const results = await read($, resultsAtom)
      const checks = Object.entries(results)
      // Commits: the newest five
      const commits = (await repoOf($, root)) ? logFrom(await git(root, ['log', '-n', '5', LOG_FORMAT])) : []
      // Ticks today
      const today = new Date().toDateString()
      const ticks = (await readTicks($)).filter(t => new Date(t.at).toDateString() === today && t.path.toLowerCase().startsWith(root.toLowerCase()))
      const now = Date.now()
      return (
        <Box flexDirection="column" gap={1}>
          {card('next', '🧭 Next', nextTitle || 'no next-steps section found', nextLines.length ? nextLines.map((l, i) => <Text key={`nx:${i}`} wrap={wrapMode}>{l}</Text>) : null, undefined, go('next'))}
          {card(
            'items',
            '☑ Items',
            `${openAll} open`,
            byOpen.length
              ? byOpen.map(x =>
                  tableRow(
                    `it:${x.f.path}`,
                    <Text wrap="truncate-end">{x.f.path.slice(root.length).replace(/^[\\/]/, '')}</Text>,
                    [
                      [<Text color="success" wrap="truncate-end">{bar(x.done, x.done + x.open)}</Text>, 11],
                      [`${x.done}/${x.done + x.open} done`, 13],
                    ],
                  ),
                )
              : <Text dimColor>Nothing open.</Text>,
            undefined,
            go('items'),
          )}
          {hasScripts
            ? card(
                'checks',
                '▶ Checks',
                checks.length ? `✓ ${checks.filter(([, r]) => r.ok).length}  ❌ ${checks.filter(([, r]) => !r.ok).length}` : 'not run yet',
                checks.length ? (
                  <Text wrap={wrapMode}>
                    {checks.map(([k, r], i) => (
                      <Text key={`ck:${k}`} color={r.ok ? 'success' : 'error'}>{`${i ? '   ' : ''}${r.ok ? '✓' : '❌'} ${k}`}</Text>
                    ))}
                  </Text>
                ) : null,
                undefined,
                go('checks'),
              )
            : null}
          {commits.length
            ? card(
                'commits',
                '🕒 Commits',
                `newest ${commits.length}`,
                commits.map(c => tableRow(`oc:${c.sha}`, <Text wrap="truncate-end">{`${c.sha.slice(0, 7)} ${c.subject}`}</Text>, [[`${age(c.at, now)} ago`, 11]])),
                undefined,
                go('timeline'),
              )
            : null}
          {card(
            'ticks',
            '📅 Ticks today',
            `${ticks.length}`,
            ticks.length ? ticks.slice(0, 3).map((t, i) => <Text key={`tk:${i}`} wrap="truncate-end" dimColor={t.done}>{`${t.done ? '☑' : '☐'} ${t.item.slice(0, 80)}`}</Text>) : null,
            undefined,
            go('ticks'),
          )}
          {card(
            'more',
            'More',
            '',
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {(
                [
                  ['log', '📜 Log'],
                  ['search', '🔍 Search'],
                  ['backups', '🗂 Backups'],
                  ['notes', '🗒 Notes'],
                  ['features', '✨ Features'],
                  ['blocks', '🧱 Building blocks'],
                ] as [ProjectTab, string][]
              ).map(([k, label]) => (
                <Button key={`ov:${k}`} label={label} plain onPress={go(k)} />
              ))}
            </Box>,
          )}
        </Box>
      )
    }

    const nextView = async (root: string) => {
      const files = (await markdownFiles($, root)).filter(f => /(HANDOFF|NEXT|TODO|ROADMAP|README|PLAN)[^\\/]*\.md$/i.test(f))
      const cards = []
      for (const f of files) {
        const text = await $.fs.read(f).catch(() => '')
        const lines = text.replace(/^\ufeff/, '').split(/\r?\n/)
        for (const s of sections(lines).filter(x => x.level <= 3 && NEXT_HEADING.test(x.title))) {
          const k = `${f}#sec:${s.key}`
          const body = lines.slice(s.from + 1, s.to)
          const name = f.slice(root.length).replace(/^[\\/]/, '')
          cards.push(
            <Box key={`next:${k}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text wrap={wrapMode} bold color="claude">
                  🧭 {s.title}
                </Text>
                <Text wrap={wrapMode} dimColor>{name}</Text>
                {Input && editing !== k ? (
                  <Button key={`ne:${k}`} plain dimColor onPress={() => void startEdit(k, body.join('\n'))}>
                    ✎
                  </Button>
                ) : null}
              </Box>
              {editing === k && Input ? (
                <Box flexDirection="column" gap={1}>
                  <Input
                    key={`in:${k}`}
                    rows={Math.min(30, Math.max(6, body.length + 2))}
                    value={typed.get(k) ?? body.join('\n')}
                    submitLabel="keep"
                    autoFocus
                    onInput={(v: string) => void typed.set(k, v)}
                    onSubmit={(v: string) => void typed.set(k, v)}
                  />
                  <Box flexDirection="row" gap={1}>
                    <Button key={`nsave:${k}`} variant="primary" onPress={() => void (async () => {
                      const newText = (typed.get(k) ?? body.join('\n')).split(/\r?\n/)
                      if (await replaceLines(f, s.from + 1, body, newText)) await say(`Saved “${s.title}”.`)
                      await stopEdit()
                    })()}>
                      Save
                    </Button>
                    <Button key={`ncancel:${k}`} onPress={() => void stopEdit()}>
                      Cancel
                    </Button>
                  </Box>
                </Box>
              ) : (
                drawLines(f, lines, s.from + 1, s.to, `next:${k}`)
              )}
            </Box>,
          )
        }
      }
      return (
        <Box flexDirection="column" gap={1}>
          {cards.length ? cards : <Text wrap={wrapMode} dimColor>No “Next”, “Open issues”, “To do” or “Plans” section in HANDOFF / NEXT / TODO / README files here.</Text>}
        </Box>
      )
    }

    // Search: the project's text files (git grep: tracked and new files, not ignored ones), five hits a file
    const searchView = async (root: string) => {
      const q = await read($, searchAtom)
      let hits: { file: string; line: number; text: string }[] = []
      if (q.trim()) {
        const out = await git(root, ['grep', '-n', '-I', '-i', '-F', '--untracked', '--max-count=5', '-e', q.trim()])
        hits = out
          .split(/\r?\n/)
          .map(l => /^(.*?):(\d+):(.*)$/.exec(l))
          .filter((m): m is RegExpExecArray => Boolean(m))
          .slice(0, 300)
          .map(m => ({ file: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) }))
      }
      const files = [...new Set(hits.map(hit => hit.file))]
      return (
        <Box flexDirection="column" gap={1}>
          {Input ? (
            <Input key="search" label="🔍" placeholder="Text to find in the project" value={q} submitLabel="find" autoFocus onSubmit={(v: string) => void update($, searchAtom, () => v)} />
          ) : null}
          {q.trim() ? (
            <Text wrap={wrapMode} dimColor>
              {hits.length} line{hits.length === 1 ? '' : 's'} in {files.length} file{files.length === 1 ? '' : 's'}
              {hits.length >= 300 ? ' (first 300)' : ''}
            </Text>
          ) : null}
          {files.map(f => (
            <Box key={`sf:${f}`} flexDirection="column">
              <Button key={`so:${f}`} label={`${kindOf(f)[0]} ${f}`} plain onPress={() => void (async () => {
                await showPane($, PANE)
                await openPath(join(root, f))
              })()} />
              {hits
                .filter(hit => hit.file === f)
                .map(hit => (
                  <Text key={`sl:${f}:${hit.line}`} wrap={wrapMode}>
                    <Text wrap={wrapMode} color="subtle">{String(hit.line).padStart(5)} </Text>
                    {hit.text}
                  </Text>
                ))}
            </Box>
          ))}
        </Box>
      )
    }

    // Backups: every copy the pane made before a change; Put back saves the current version first (so it's undoable)
    const backupsView = async () => {
      const list = await read($, backupLogAtom)
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap={wrapMode} dimColor>
            {list.length} backup cop{list.length === 1 ? 'y' : 'ies'} this session (in {backups()}), newest first
          </Text>
          {list.slice(0, 100).map((b, i) => (
            <Box key={`bk:${i}:${b.backup}`} flexDirection="row" gap={1}>
              <Text wrap={wrapMode}>
                <Text wrap={wrapMode} color="subtle">{new Date(b.at).toLocaleTimeString()} </Text>
                {kindOf(b.original)[0]} {b.original}
              </Text>
              <Button key={`bkput:${b.backup}`} plain onPress={() => void (async () => {
                const now = await backupOf(b.original)
                if (!now.ok) return say(`Not put back: couldn't copy the current version first (${String(now.error ?? 'unknown')}).`)
                const r = await helper(['restore', b.backup, b.original])
                await say(r.ok ? `Put back the copy from ${new Date(b.at).toLocaleTimeString()}; the version it replaced is the newest backup.` : `Not put back: ${String(r.error ?? 'unknown')}.`)
              })()}>
                ↩ Put back
              </Button>
              <Button key={`bkshow:${b.backup}`} plain onPress={() => void $.process.run(['explorer.exe', `/select,${b.backup}`])}>
                📂
              </Button>
            </Box>
          ))}
        </Box>
      )
    }

    const projectView = async () => {
      const root = await $.session.cwd()
      const saved = await read($, tabAtom)
      const tab = saved === 'git' || saved === 'changes' ? 'next' : saved
      // 📜 Log follows the file by a redraw every 2 s. The timer ends itself once the Log tab hasn't been drawn for 10 s
      // (Files view, pane closed): it never outlives the tab
      if (tab === 'log') logDrawnAt = await $.clock.now()
      if (tab === 'log' && !logTimer)
        logTimer = $.clock.every(2000, () => void (async () => {
          if ((await $.clock.now()) - logDrawnAt > 10_000) {
            logTimer?.cancel()
            logTimer = null
          } else $.ui.invalidate('ui.render')
        })())
      if (tab !== 'log' && logTimer) {
        logTimer.cancel()
        logTimer = null
      }
      const all = await read($, allAtom)
      // one row of tabs (Strike, 2026-11-11: no tabs in tabs); the rarer ones under More. Git and Claude's edits are
      // the Git window's. Checks hides without a package.json (the /files command can still name it)
      const hasScripts = await $.fs.exists(join(root, 'package.json')).catch(() => false)
      const MAIN: [typeof tab, string][] = [['next', '🧭 Next'], ['items', '☑ Items'], ['ticks', '📅 Ticks'], ['timeline', '🕒 Timeline'], ['checks', '▶ Checks'], ['log', '📜 Log']]
      const MORE: [typeof tab, string][] = [['search', '🔍 Search'], ['backups', '🗂 Backups'], ['notes', '🗒 Notes'], ['features', '✨ Features'], ['blocks', '🧱 Building blocks']]
      const mainTabs = MAIN.filter(([k]) => k !== 'checks' || hasScripts || tab === 'checks')
      const inMore = MORE.some(([k]) => k === tab)
      const moreOpen = toggled.has('proj-more') || inMore
      // one state change a press (each change is a whole redraw)
      const pick = (k: typeof tab) => void update($, tabAtom, () => k)
      const tabBar = tab === 'overview' ? null : (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="tab:overview" label="← Overview" plain onPress={() => pick('overview')} />
          {[...mainTabs, ...(moreOpen ? MORE : [])].map(([k, label]) => (
            <Button key={`tab:${k}`} label={compact ? label.split(' ')[0]! : label} plain variant={tab === k ? 'primary' : 'secondary'} onPress={() => pick(k)} />
          ))}
          {inMore ? null : <Button key="tab-more" label={moreOpen ? '‹ Less' : 'More ›'} plain onPress={() => void flip('proj-more')} />}
        </Box>
      )
      let body
      if (tab === 'overview') body = await overview(root, hasScripts)
      else if (tab === 'items') {
        const files = await projectTasks($, root)
        const total = files.reduce((n, f) => n + f.tasks.length, 0)
        const openCount = files.reduce((n, f) => n + f.tasks.filter(t => !t.done).length, 0)
        body = (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1}>
              <Text wrap={wrapMode} dimColor>
                {openCount} open of {total}, in {files.length} file{files.length === 1 ? '' : 's'}
              </Text>
              <Button key="items-all" onPress={() => void update($, allAtom, v => !v)}>
                {all ? 'Only open' : 'Show done too'}
              </Button>
            </Box>
            {files.map(f => {
              const list = f.tasks.filter(t => all || !t.done)
              if (!list.length) return null
              const name = f.path.slice(root.length).replace(/^[\\/]/, '') || f.path
              const heads = [...new Set(list.map(t => t.heading))]
              return (
                <Box key={`f:${f.path}`} flexDirection="column">
                  <Button key={`open:${f.path}`} label={`${kindOf(name)[0]} ${name}`} plain onPress={() => void (async () => {
                    await showPane($, PANE)
                    await update($, asTextAtom, () => false)
                    await openPath(f.path)
                  })()} />
                  {heads.map(hd => (
                    <Box key={`hd:${f.path}:${hd}`} flexDirection="column" marginLeft={2}>
                      {hd ? <Text wrap={wrapMode} dimColor>{hd}</Text> : null}
                      {list.filter(t => t.heading === hd).map(t => taskRow(f.path, t))}
                      {(() => {
                        const under = f.tasks.filter(t => t.heading === hd)
                        const last = under[under.length - 1]
                        return last ? addRow(f.path, last, 'Add item') : null
                      })()}
                    </Box>
                  ))}
                </Box>
              )
            })}
            {!total ? <Text wrap={wrapMode} dimColor>No checkboxes (- [ ]) in this project's Markdown files.</Text> : null}
          </Box>
        )
      } else if (tab === 'ticks') {
        // the tick log (every chat's, newest first) by day: this project's files, or every folder
        const everywhere = await read($, ticksAllAtom)
        const under = root.toLowerCase().replace(/[\\/]+$/, '')
        const log = (await readTicks($)).filter(t => everywhere || t.path.toLowerCase().startsWith(`${under}\\`) || t.path.toLowerCase().startsWith(`${under}/`))
        const shown = log.slice(0, 300)
        const day = (ms: number) => whenText(new Date(ms).toISOString()).slice(0, 10)
        const today = day(Date.now())
        const yesterday = day(Date.now() - 86_400_000)
        const days = [...new Set(shown.map(t => day(t.at)))]
        const nameOf = (p: string) => (everywhere || !p.toLowerCase().startsWith(under) ? p : p.slice(root.length).replace(/^[\\/]/, ''))
        body = (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="ticks-all" label={everywhere ? 'Every folder' : 'This project'} onPress={() => void update($, ticksAllAtom, v => !v)} />
              {tickDatesButton}
            </Box>
            <Text wrap={wrapMode} dimColor>
              {`${log.length} tick${log.length === 1 ? '' : 's'} ${everywhere ? 'in every folder' : 'in this project'}, newest first${log.length > shown.length ? ` (the newest ${shown.length})` : ''}. The pane's own ticks, from every chat; ticks made in another editor aren't seen.`}
            </Text>
            {days.map(d => (
              <Box key={`day:${d}`} flexDirection="column">
                <Text wrap={wrapMode} bold>
                  {d === today ? `Today (${d})` : d === yesterday ? `Yesterday (${d})` : d}
                </Text>
                {shown
                  .map((t, i) => ({ t, i }))
                  .filter(({ t }) => day(t.at) === d)
                  .map(({ t, i }) => (
                    <Box key={`tk:${i}`} flexDirection="row" gap={1} flexWrap="wrap" marginLeft={2}>
                      <Text wrap={wrapMode} dimColor={t.done} color={t.done ? undefined : 'warning'}>
                        {`${whenText(new Date(t.at).toISOString()).slice(11)} ${t.done ? '☑' : '☐ unticked'} ${t.item.slice(0, 90) || 'item'}${t.headings.length ? ` · ${t.headings.join(' › ')}` : ''}`}
                      </Text>
                      <Button key={`tko:${i}`} label={`${kindOf(t.path)[0]} ${nameOf(t.path)}`} plain onPress={() => void (async () => {
                        await showPane($, PANE)
                        await update($, asTextAtom, () => false)
                        await openPath(t.path)
                      })()} />
                    </Box>
                  ))}
              </Box>
            ))}
            {!log.length ? <Text wrap={wrapMode} dimColor>No ticks logged yet{everywhere ? '' : ' in this project'} (the log starts with Files pane 0.2.0).</Text> : null}
          </Box>
        )
      } else if (tab === 'checks') {
        body = await checksView(root)
      } else if (tab === 'search') {
        body = await searchView(root)
      } else if (tab === 'backups') {
        body = await backupsView()
      } else if (tab === 'log') {
        body = await logView(root)
      } else if (tab === 'notes') {
        body = notesView()
      } else if (tab === 'next') {
        body = await nextView(root)
      } else if (tab === 'timeline') {
        const list = await projectTimeline($, root)
        body = (
          <Box flexDirection="column">
            {list.slice(0, 120).map((x, i) => {
              const ek = `${join(root, 'CHANGELOG.md')}#rel:${x.line}`
              if (x.kind === 'release' && editing === ek && Input && x.raw)
                return (
                  <Input
                    key={`in:${ek}`}
                    value={typed.get(ek) ?? x.raw.replace(/^##\s+/, '')}
                    submitLabel="save"
                    autoFocus
                    onInput={(v: string) => void typed.set(ek, v)}
                    onSubmit={(v: string) => void (async () => {
                      if (v.trim() && (await replaceLines(join(root, 'CHANGELOG.md'), x.line!, [x.raw!], [`## ${v.trim()}`]))) await say('Version heading saved.')
                      await stopEdit()
                    })()}
                  />
                )
              const relKey = `tl:rel:${root}#${x.line}`
              const relOpen = x.kind === 'release' && toggled.has(relKey)
              const row = (
              <Box key={`tlrow:${i}`} flexDirection="row" gap={1}>
              {x.kind === 'release' && x.points?.length ? (
                <Button key={`rel-fold:${i}`} label={relOpen ? '▾' : '▸'} plain onPress={() => void flip(relKey)} />
              ) : null}
              <Text wrap={wrapMode} key={`tl:${i}`}>
                <Text wrap={wrapMode} dimColor>{x.date || '—'} </Text>
                {x.kind === 'release' ? (
                  <Text wrap={wrapMode} bold color="claude">
                    🏷 {x.text}
                  </Text>
                ) : (
                  <Text wrap={wrapMode}>
                    <Text wrap={wrapMode} color="subtle">● </Text>
                    {x.text}
                  </Text>
                )}
                {x.kind === 'commit' && x.detail ? <Text wrap={wrapMode} dimColor> {x.detail}</Text> : null}
              </Text>
              {x.kind === 'release' && Input ? (
                <Button key={`rel-edit:${i}`} plain dimColor onPress={() => void startEdit(ek, (x.raw ?? '').replace(/^##\s+/, ''))}>
                  ✎
                </Button>
              ) : null}
              </Box>
              )
              if (x.kind !== 'release' || !x.summary) return row
              // what the version changed: a summary line, every point when unfolded
              return (
                <Box key={`tlrel:${i}`} flexDirection="column">
                  {row}
                  {relOpen ? (
                    (x.points ?? []).slice(0, 60).map((p, j) => (
                      <Text key={`tlp:${i}:${j}`} wrap={wrapMode} dimColor>
                        {'   • '}
                        {p}
                      </Text>
                    ))
                  ) : (
                    <Text key={`tls:${i}`} wrap={wrapMode} dimColor>
                      {'   '}
                      {x.summary}
                    </Text>
                  )}
                  {relOpen && (x.points?.length ?? 0) > 60 ? (
                    <Text key={`tlm:${i}`} wrap={wrapMode} dimColor>{`   …and ${x.points!.length - 60} more in CHANGELOG.md`}</Text>
                  ) : null}
                </Box>
              )
            })}
            {!list.length ? <Text wrap={wrapMode} dimColor>No git history or CHANGELOG.md versions here.</Text> : null}
          </Box>
        )
      } else {
        const data = tab === 'features' ? await projectFeatures($, root) : await projectBlocks($, root)
        const title = tab === 'features' ? (data as { version: string }).version : (data as { from: string }).from.slice(root.length).replace(/^[\\/]/, '')
        body = (
          <Box flexDirection="column" gap={1}>
            {title ? <Text wrap={wrapMode} dimColor>{tab === 'features' ? `CHANGELOG.md · ${title}` : title}</Text> : null}
            {data.blocks.map(b => {
              const k = `${tab}:${b.title}`
              const unfolded = toggled.has(k)
              const shown = unfolded ? b.body.slice(0, Math.max(0, budget)) : ''
              budget -= shown.length
              const file = tab === 'features' ? join(root, 'CHANGELOG.md') : (data as { from: string }).from
              const ek = `${file}#block:${b.from}`
              if (editing === ek && Input)
                return (
                  <Box key={`be:${k}`} flexDirection="column" gap={1}>
                    <Text wrap={wrapMode} bold>{b.title}</Text>
                    <Input
                      key={`in:${ek}`}
                      rows={Math.min(30, Math.max(6, b.raw.length + 2))}
                      value={typed.get(ek) ?? b.raw.join('\n')}
                      submitLabel="keep"
                      autoFocus
                      onInput={(v: string) => void typed.set(ek, v)}
                      onSubmit={(v: string) => void typed.set(ek, v)}
                    />
                    <Box flexDirection="row" gap={1}>
                      <Button key={`bsave:${ek}`} variant="primary" onPress={() => void (async () => {
                        const newText = (typed.get(ek) ?? b.raw.join('\n')).split(/\r?\n/)
                        if (await replaceLines(file, b.from + 1, b.raw, newText)) await say(`Saved “${b.title}”.`)
                        await stopEdit()
                      })()}>
                        Save
                      </Button>
                      <Button key={`bcancel:${ek}`} onPress={() => void stopEdit()}>
                        Cancel
                      </Button>
                    </Box>
                  </Box>
                )
              return (
                <Box key={`b:${k}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={`bh:${k}`} label={`${unfolded ? '▾' : '▸'} ${tab === 'features' ? '✨' : '🧱'} ${b.title}`} plain onPress={() => void flip(k)} />
                    {Input ? (
                      <Button key={`bedit:${k}`} plain dimColor onPress={() => void startEdit(ek, b.raw.join('\n'))}>
                        ✎
                      </Button>
                    ) : null}
                  </Box>
                  {unfolded && shown ? (Md ? <Md key={`bm:${k}`} text={shown} /> : <Text wrap={wrapMode}>{shown}</Text>) : null}
                </Box>
              )
            })}
            {!data.blocks.length ? (
              <Text wrap={wrapMode} dimColor>{tab === 'features' ? 'No CHANGELOG.md with ### sections here.' : 'No "Building blocks" section or DEVELOPING.md here.'}</Text>
            ) : null}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          {tabBar}
          {message ? <Text wrap={wrapMode}>{message}</Text> : null}
          {body}
        </Box>
      )
    }

    // the top bar: Files | Project, ← → ↑ and the path as buttons, ⋯ for the rest (Wrap, Follow, Compact, Go to,
    // version, Tools). Warnings that need a look (a newer pane, a conflict, Undo) show under it.
    const ver = await deployInfo($, home)
    const menuOpen = await read($, menuAtom)
    const nav = await read($, navAtom)
    const missing = health ? health.filter(tool => !tool.ok) : []
    const projectRoot = view !== 'files' ? await $.session.cwd() : ''
    const crumbsOf = (p: string) => {
      const out: { label: string; path: string }[] = []
      for (let q = p, i = 0; q && i < 40; i++) {
        const up = parent(q)
        out.unshift({ label: up === q ? q.replace(/[\\/]+$/, '') : q.slice(Math.max(q.lastIndexOf('\\'), q.lastIndexOf('/')) + 1), path: q })
        if (up === q) break
        q = up
      }
      return out
    }
    const trail = crumbsOf(view === 'project' ? projectRoot : here)
    // a long path: the drive, …, and the last three parts
    const shownTrail = trail.length > 5 ? [trail[0]!, { label: '…', path: trail[trail.length - 4]!.path }, ...trail.slice(-3)] : trail
    // 🕘 Recent ▾: pinned files, then the 8 opened last, in a short list under the bar while it's open
    const pinnedAll = await read($, pinnedAtom)
    const recentAll = (await read($, recentAtom)).filter(p => !NOT_FOLLOWED.test(p) && !pinnedAll.some(q => q.toLowerCase() === p.toLowerCase())).slice(0, 8)
    const recentOpen = toggled.has('recent-open')
    const recentList = recentOpen ? (
      <Box key="recent-list" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {[...pinnedAll.map(p => ({ p, star: true })), ...recentAll.map(p => ({ p, star: false }))].map(({ p, star }, i) => (
          <Box key={`rl:${i}`} flexDirection="row" gap={1}>
            <Button key={`recent:${i}`} label={`${star ? '⭐' : kindOf(p)[0]} ${p.split(/[\\/]/).pop()}`} plain onPress={() => void (async () => {
              await flip('recent-open')
              await openPath(p)
            })()} />
            <Text wrap="truncate-end" dimColor>{parent(p)}</Text>
          </Box>
        ))}
      </Box>
    ) : null
    const switcher = (
      <Box flexDirection="column" gap={1}>
        <Box key="bar" flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {/* Files · Git · Project: one row, switched in place */}
          {(['files', 'git', 'project'] as const).map(v => (
            <Button key={`v-${v}`} label={v === 'files' ? '📁 Files' : v === 'git' ? '🌿 Git' : '☑ Project'} variant={view === v ? 'primary' : 'secondary'} onPress={() => void update($, viewAtom, () => v)} />
          ))}
          {view === 'files' && nav.back.length ? <Button key="nav-back" label="←" plain onPress={() => void goNav('back')} /> : null}
          {view === 'files' && nav.fwd.length ? <Button key="nav-fwd" label="→" plain onPress={() => void goNav('fwd')} /> : null}
          {view === 'files' && parent(here) !== here ? <Button key="up" label={open ? '↑ Folder' : '↑'} plain onPress={() => void goDir(parent(here))} /> : null}
          <Box key="trail" flexDirection="row" gap={0} flexWrap="wrap" flexGrow={1}>
            {(view === 'files' ? shownTrail : []).flatMap((c, i) => [
              ...(i > 0 ? [<Text key={`ts${i}`} dimColor>{' › '}</Text>] : []),
              <Button
                key={`bc:${i}`}
                label={c.label}
                plain
                variant={i === shownTrail.length - 1 ? 'primary' : 'secondary'}
                onPress={() => void (async () => {
                  await showPane($, PANE)
                  await openPath(c.path)
                })()}
              />,
            ])}
          </Box>
          {/* the other windows, a press away (each is its own tab in the dock once open) */}
          {view === 'files' && !open ? <Button key="find-toggle" label="🔎" plain onPress={() => void flip('folder-find')} /> : null}
          {view === 'files' && (pinnedAll.length || recentAll.length) ? <Button key="recent" label={recentOpen ? '🕘 Recent ▴' : '🕘 Recent ▾'} plain onPress={() => void flip('recent-open')} /> : null}
          <Button key="menu" label={menuOpen ? '✕' : missing.length || ver.newer ? '⋯ ⚠' : '⋯'} plain onPress={() => void update($, menuAtom, v => !v)} />
        </Box>
        {view === 'files' ? recentList : null}
        {menuOpen ? (
          <Box key="menu-body" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="wrap" label={wrap ? '↩ Wrap: on' : '↩ Wrap: off'} variant={wrap ? 'primary' : 'secondary'} onPress={() => void update($, wrapAtom, v => !v)} />
              <Button key="follow" label={follow ? '👁 Follow Claude: on' : '👁 Follow Claude: off'} variant={follow ? 'primary' : 'secondary'} onPress={() => void (async () => {
                await $.store.set('followClaude', !follow)
                await say(follow ? 'Follow Claude is off (in every chat).' : "Follow Claude is on (in every chat): files Claude edits or reads open here.")
              })()} />
              <Button key="compact" label={compact ? '▤ Full labels' : '▤ Compact'} variant={compact ? 'primary' : 'secondary'} onPress={() => void update($, compactAtom, v => !v)} />
            </Box>
            {/* how diffs are drawn, everywhere */}
              {Input ? (
              <Input key="path" label="Go to" placeholder="a folder or file path (Enter)" value={here} submitLabel="go" onSubmit={(v: string) => void (async () => {
                await showPane($, PANE)
                await openPath(v.trim())
              })()} />
            ) : null}
            <Text key="version" wrap={wrapMode} dimColor>
              {`Files pane ${ver.version ? `v${ver.version}` : ''}${ver.at ? ` · deployed ${whenText(ver.at)}` : ' · run from its source folder'}`}
            </Text>
            {health ? (
              // which outside programs are there: a missing one says what it's needed for
              <Text key="health" wrap={wrapMode} dimColor={!missing.length} color={missing.length ? 'warning' : undefined}>
                {`Tools: ${health.map(tool => `${tool.ok ? '✓' : '✗'} ${tool.name}`).join(' · ')}${missing.length ? ` (missing: ${missing.map(tool => `${tool.name} for ${tool.for}`).join('; ')})` : ''}`}
              </Text>
            ) : null}
          </Box>
        ) : null}
        {ver.newer ? (
          <Text key="newer" wrap={wrapMode} color="warning">
            {`⬆ A newer pane was deployed ${whenText(ver.newer)}: open a new chat to get it.`}
          </Text>
        ) : null}
        {conflict ? (
          // Claude edited a file while the pane held unsaved typing for it
          <Box key="conflict" flexDirection="column">
            <Text wrap={wrapMode} color="warning">
              {`⚠ Claude edited ${conflict.path.split(/[\\/]/).pop()} at ${new Date(conflict.at).toLocaleTimeString()} while you had unsaved typing for it here. Your typing is still in the editor, but Save is refused (the file changed): copy what you need, then reopen the file and put it back in.`}
            </Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="conflict-diff" label="± See Claude's change" onPress={() => void (async () => {
                await update($, diffOpenAtom, list => (list.includes(`filediff:${conflict.path}`) ? list : [...list, `filediff:${conflict.path}`].slice(-50)))
                await update($, diffBaseAtom, () => ({ path: conflict.path, base: 'claude' as const, edit: Number.MAX_SAFE_INTEGER }))
              })()} />
              <Button key="conflict-ok" label="Got it" onPress={() => void update($, conflictAtom, () => null)} />
            </Box>
          </Box>
        ) : null}
        {undoBar}
      </Box>
    )
    if (view === 'git')
      return (
        <Box flexDirection="column" gap={1}>
          {switcher}
          {message ? <Text wrap={wrapMode}>{message}</Text> : null}
          {await gitPage(projectRoot)}
        </Box>
      )
    if (view === 'project')
      return (
        <Box flexDirection="column" gap={1}>
          {switcher}
          {await projectView()}
        </Box>
      )

    // 👁 the lines of this file Claude read last: named, with those lines (up to 60) as numbered code
    const agentRead = await read($, agentReadAtom)
    const readBand = (() => {
      if (!open || !agentRead || agentRead.path.toLowerCase() !== open.path.toLowerCase() || open.mode !== 'whole') return null
      const all = open.text.split('\n')
      const to = Math.min(agentRead.to, all.length)
      const whole = agentRead.from <= 1 && to >= all.length
      const lines = all.slice(agentRead.from - 1, Math.min(to, agentRead.from + 59))
      return (
        <Box key="read-band" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text wrap={wrapMode} color="claude">
              {`👁 Claude read ${whole ? 'all of it' : `lines ${agentRead.from}–${to}`} · ${new Date(agentRead.at).toLocaleTimeString()}`}
            </Text>
            <Button key="read-done" label="✕" plain onPress={() => void update($, agentReadAtom, () => null)} />
          </Box>
          {!whole && lines.length ? (
            Code ? (
              <Code key="read-lines" source={lines.join('\n')} startLine={agentRead.from} path={open.path} wrap={wrapMode} />
            ) : (
              <Text wrap={wrapMode}>{lines.join('\n')}</Text>
            )
          ) : null}
          {!whole && to - agentRead.from + 1 > lines.length ? <Text wrap={wrapMode} dimColor>{`(the first ${lines.length} lines shown)`}</Text> : null}
        </Box>
      )
    })()
    // 🕘 History of the open file: its commits (each with its diff of this file), or blame (who changed which lines
    // when, as runs of lines from one commit; 50 runs at most)
    const fileHist = await read($, fileHistAtom)
    const histPanel = await (async () => {
      if (!open || !fileHist || fileHist.path.toLowerCase() !== open.path.toLowerCase()) return null
      const top = await repoOf($, parent(open.path))
      const relPath = top ? open.path.slice(top.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : ''
      const modes = (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text wrap={wrapMode} bold>🕘 History</Text>
          <Button key="fh-log" label="Commits" variant={fileHist.mode === 'log' ? 'primary' : 'secondary'} onPress={() => void update($, fileHistAtom, hist => (hist ? { ...hist, mode: 'log' as const } : hist))} />
          <Button key="fh-blame" label="Who changed each line" variant={fileHist.mode === 'blame' ? 'primary' : 'secondary'} onPress={() => void update($, fileHistAtom, hist => (hist ? { ...hist, mode: 'blame' as const } : hist))} />
          <Button key="fh-close" label="✕" plain onPress={() => void update($, fileHistAtom, () => null)} />
        </Box>
      )
      let body
      if (!top) body = <Text wrap={wrapMode} dimColor>Not in a git repository.</Text>
      else if (fileHist.mode === 'log') {
        const commits = logFrom(await git(top, ['log', '--follow', '-n', '30', LOG_FORMAT, '--', relPath]))
        const rows = []
        for (const c of commits) rows.push(await commitRow(top, c, `file:${relPath}`, relPath))
        body = commits.length ? rows : <Text wrap={wrapMode} dimColor>Never committed.</Text>
      } else {
        const runs = blameRuns(await git(top, ['blame', '--porcelain', '--', relPath]))
        const now = Date.now()
        body = runs.length ? (
          [
            ...runs.slice(0, CHANGES_PAGE).map((r, i) => {
              const fresh = /^0+$/.test(r.sha)
              const tone = fresh ? 'new' : ageTone(r.at, now)
              return (
                <Text key={`bl:${i}`} wrap={wrapMode} color={tone === 'new' ? 'success' : undefined} dimColor={tone === 'old'}>
                  {`${r.from === r.to ? `line ${r.from}` : `lines ${r.from}–${r.to}`} · ${fresh ? 'not committed yet' : `${r.sha.slice(0, 7)} · ${r.author} · ${age(r.at, now)} ago · ${r.subject}`}`}
                </Text>
              )
            }),
            ...(runs.length > CHANGES_PAGE ? [<Text key="bl-more" wrap={wrapMode} dimColor>{`(the first ${CHANGES_PAGE} of ${runs.length} runs)`}</Text>] : []),
          ]
        ) : (
          <Text wrap={wrapMode} dimColor>Never committed.</Text>
        )
      }
      return (
        <Box key="file-hist" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          {modes}
          {body}
        </Box>
      )
    })()
    const header = (
      <Box flexDirection="column" gap={1}>
        {switcher}
        {message ? <Text wrap={wrapMode}>{message}</Text> : null}
        {readBand}
        {histPanel}
        {/* (the files opened lately were tabs here until 0.4.9: 🕘 Recent ▾ in the bar has them) */}
      </Box>
    )

    const asText = await read($, asTextAtom)
    const flipDiffFile = (k: string) => update($, diffOpenAtom, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k].slice(-50)))
    const pinnedNow = await read($, pinnedAtom)
    // a file's utilities: pin, copy its path, open it in VS Code or its own app
    const fileTools = (path: string) => {
      const isPinned = pinnedNow.some(p => p.toLowerCase() === path.toLowerCase())
      // the file's main action here; the rest under its own ⋯ (one toolbar row a view: Strike, 2026-11-11)
      const more = toggled.has('file-more')
      const histOn = fileHist?.path.toLowerCase() === path.toLowerCase()
      return [
        <Button key="fhist" label={compact ? '🕘' : '🕘 History'} variant={histOn ? 'primary' : 'secondary'} onPress={() => void update($, fileHistAtom, hist => (hist && hist.path.toLowerCase() === path.toLowerCase() ? null : { path, mode: 'log' as const }))} />,
        <Button key="file-more" label={more ? '✕' : '⋯'} plain onPress={() => void flip('file-more')} />,
        ...(more ? fileMenu(path, isPinned) : []),
      ]
    }
    const fileMenu = (path: string, isPinned: boolean) => {
      return [
        <Button key="reveal" label={compact ? '📂' : '📂 Explorer'} onPress={() => void $.process.run(['explorer.exe', `/select,${path}`])} />,
        <Button key="pin" onPress={() => void update($, pinnedAtom, list => (isPinned ? list.filter(p => p.toLowerCase() !== path.toLowerCase()) : [path, ...list].slice(0, 20)))}>
          {isPinned ? (compact ? '★' : '★ Unpin') : compact ? '☆' : '☆ Pin'}
        </Button>,
        <Button key="copy" onPress={() => void $.ui.copy({ text: path, surface: e.surface }).then(() => say('Path copied.'))}>
          {compact ? '📋' : '📋 Copy path'}
        </Button>,
        <Button key="vscode" onPress={() => void (async () => {
          // absolute only, so the path can't read as one of VS Code's options
          if (!/^([A-Za-z]:[\\/]|\\\\)/.test(path)) return say('VS Code opens absolute Windows paths only.')
          const code = await findVscode($)
          if (!code) return say("Couldn't find VS Code (its `code` command on PATH, or the usual install folders).")
          const r = await $.process.run([code.exe, code.cli, path], { env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, timeoutMs: 30_000 }).catch(() => null)
          await say(r?.exitCode === 0 ? 'Opened in VS Code.' : `VS Code didn't open it${r?.stderr ? `: ${r.stderr.split(/\r?\n/)[0]}` : '.'}`)
        })()}>
          {compact ? 'VS Code' : 'Open in VS Code'}
        </Button>,
        <Button key="app" onPress={() => void $.process.run(['explorer.exe', path])}>
          {compact ? '↗' : '↗ Its app'}
        </Button>,
        <Button key="note" onPress={() => void (async () => {
          typed.delete(`note:${path}`)
          await update($, noteOpenAtom, v => (v === path ? '' : path))
        })()}>
          {compact ? '🗒' : '🗒 Note'}
        </Button>,
      ]
    }
    if (open && /\.(md|markdown)$/i.test(open.path) && !open.binary && !asText && open.size <= 4 * 1024 * 1024) {
      const f = open
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {Input ? (
              <Button key="as-text" onPress={() => void (async () => {
                await update($, asTextAtom, () => true)
                await openPath(f.path)
              })()}>
                Edit as text
              </Button>
            ) : null}
            {fileTools(f.path)}
          </Box>
          {noteBlock(f.path)}
          {await docView(f.path)}
        </Box>
      )
    }

    // pictures and 3D models: a preview (and, with ± Diff, the one at the last commit beside it)
    // (binary models always preview: "as text" only means something for the text ones)
    if (open && (IMAGE.test(open.path) || ((/\.svg$/i.test(open.path) || MODEL_TEXT.test(open.path)) && !asText) || (MODEL.test(open.path) && !MODEL_TEXT.test(open.path)))) {
      const f = open
      const diffKey = `filediff:${f.path}`
      const isSvg = /\.svg$/i.test(f.path)
      const shell = MODEL.test(f.path)
      // ◀ ▶ through the pictures and models in the same folder, by name
      const isPic = (n: string) => IMAGE.test(n) || /\.svg$/i.test(n) || MODEL.test(n)
      const sibs = ((await $.fs.list(parent(f.path)).catch(() => [])) as { name: string; kind: string }[])
        .filter(x => x.kind === 'file' && isPic(x.name))
        .map(x => join(parent(f.path), x.name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      const at = sibs.findIndex(p => p.toLowerCase() === f.path.toLowerCase())
      let now: unknown = null
      let before: unknown = null
      let note = ''
      let pending = false
      // .glb / .gltf: Heimdall3D's own render first (its PNG cached), Explorer's thumbnail when it can't; a string
      // says why there's no picture
      const preview = async (p: string, byContent: boolean) => {
        let probeErr = ''
        if (HEIMDALL.test(f.path)) {
          const r = await helper(['probe', p, cacheDir, (await $.env.get('ProgramFiles')) ?? '', ...(byContent ? ['bycontent'] : [])])
          if (typeof r.file === 'string') {
            const t = await thumb(r.file)
            if (typeof t !== 'string') return { ...t, via: `Heimdall3D (heimdall_probe${r.gpu ? ', GPU' : ''})` }
            probeErr = t
          } else if (r.error) probeErr = String(r.error)
        }
        const t = await thumb(p, shell)
        return typeof t === 'string' && probeErr ? `${t} · ${probeErr}` : t
      }
      if (isSvg) {
        const src = await $.fs.read(f.path).catch(() => '')
        now = src.length <= 131_072 && /<svg[\s>]/i.test(src) ? src : null
        if (!now) note = src ? 'This SVG is too large or not an SVG to draw here: Edit as text shows it.' : "Couldn't read it."
      } else {
        // drawn once per file version (a model's render or Explorer's thumbnail can take seconds): kept in memory for
        // redraws and on disk (file-pane-cache\previews) for other chats; the first time it draws in the background
        // while the rest of the pane shows
        const k = `${HEIMDALL.test(f.path) ? 'probe3' : shell ? 'shell2' : 'image2'}|${f.path}|${f.size}|${f.mtimeMs}`
        const got = previews.get(k)
        if (got === undefined && !drawing.has(k)) {
          drawing.add(k)
          void (async () => {
            let r: Thumb | string
            try {
              const kept = await helper(['pcache', 'get', cacheDir, k])
              if (kept.value && typeof kept.value === 'object') r = kept.value as Thumb
              else {
                r = await preview(f.path, false)
                if (typeof r !== 'string') await helper(['pcache', 'put', cacheDir, k], JSON.stringify(r))
              }
            } catch (err) {
              r = err instanceof Error ? err.message : String(err)
            }
            previews.set(k, r)
            if (previews.size > 40) previews.delete(previews.keys().next().value!)
            drawing.delete(k)
            $.ui.invalidate('ui.render')
          })()
        }
        if (got === undefined) {
          note = 'Drawing the preview… (the first time can take a few seconds; kept after that)'
          pending = true
        }
        else if (typeof got === 'string') note = `No preview: ${got}`
        else now = got
      }
      if (showDiff.includes(diffKey)) {
        const tmp = join(cacheDir, `last-commit-${Date.now()}${f.path.slice(f.path.lastIndexOf('.'))}`)
        const g = await helper(['gitblob', f.path, tmp])
        if (g.ok) {
          if (isSvg) before = await $.fs.read(tmp).catch(() => null)
          else {
            const t = await preview(tmp, true)
            before = typeof t === 'string' ? null : t
          }
          void helper(['rmtemp', cacheDir, tmp])
        } else note = note || 'Not in git at the last commit (new, or outside a git folder).'
      }
      // 🔍 Closer: a model's render is mostly floor around it, so it can be drawn zoomed in on its middle
      const zoom = shell ? await read($, previewZoomAtom) : 1
      const draw = (k: string, v: unknown, alt: string) =>
        typeof v === 'string' ? (Svg ? <Svg key={k} alt={alt} source={v} isInteractive /> : <Text wrap={wrapMode} dimColor>{alt}</Text>) : v ? picture(k, v as Thumb, alt, zoom) : null
      // a model's thumbnail size says nothing about it: name what drew it instead
      const pic = now && typeof now !== 'string' ? (now as { w: number; via?: string } & Record<string, unknown>) : null
      const dims = !pic ? '' : shell ? (pic.via ? ` · preview by ${pic.via}` : '') : ` · ${pic.w}×${String(pic['h'])}`
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text wrap={wrapMode} dimColor>
            {sizeText(f.size)}
            {dims}
          </Text>
          {sibs.length > 1 && at >= 0 ? (
            <Box key="pic-nav" flexDirection="row" gap={1} alignItems="center">
              <Button key="pic-prev" label="◀" onPress={() => void openPath(sibs[(at - 1 + sibs.length) % sibs.length]!)} />
              <Text dimColor>{`${at + 1} of ${sibs.length} in this folder`}</Text>
              <Button key="pic-next" label="▶" onPress={() => void openPath(sibs[(at + 1) % sibs.length]!)} />
            </Box>
          ) : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {/^[A-Za-z]:[\\/]/.test(f.path) ? (
              // its own app (Photos, Heimdall3D's viewer…), as a double click in Explorer would; absolute paths only
              <Button key="open-app" label={compact ? '⤢' : '⤢ Open in its app'} onPress={() => void $.process.run(['explorer.exe', f.path], { timeoutMs: 15_000 }).then(() => say('Opened in its own app.'))} />
            ) : null}
            <Button key="diff" variant={showDiff.includes(diffKey) ? 'primary' : 'secondary'} onPress={() => void flipDiffFile(diffKey)}>
              ± Diff
            </Button>
            {(isSvg || MODEL_TEXT.test(f.path)) && Input ? (
              <Button key="as-text" onPress={() => void (async () => {
                await update($, asTextAtom, () => true)
                await openPath(f.path)
              })()}>
                Edit as text
              </Button>
            ) : null}
            {shell ? <Button key="zoom" label={`🔍 Closer${zoom > 1 ? ` (${zoom}×)` : ''}`} variant={zoom > 1 ? 'primary' : 'secondary'} onPress={() => void update($, previewZoomAtom, z => (z >= 2 ? 1 : z === 1 ? 1.5 : 2))} /> : null}
            {fileTools(f.path)}
          </Box>
          {note ? <Text wrap={wrapMode} color={pending ? undefined : 'warning'} dimColor={pending}>{note}</Text> : null}
          {showDiff.includes(diffKey) && before ? (
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              <Box flexDirection="column">
                <Text wrap={wrapMode} color="diffRemoved">Last commit</Text>
                {draw('before', before, 'the picture at the last commit')}
              </Box>
              <Box flexDirection="column">
                <Text wrap={wrapMode} color="diffAdded">Now</Text>
                {draw('now', now, 'the picture now')}
              </Box>
            </Box>
          ) : (
            draw('now', now, f.path)
          )}
        </Box>
      )
    }

    // binaries (DLLs, programs, archives, data): what it is, its readable text, or its bytes; .NET DLLs as C# through
    // ILSpy. Read only, by the helper; nothing in the file runs.
    if (open && open.binary) {
      const f = open
      const saved = await read($, binViewAtom)
      const bv: BinView = saved.path === f.path ? saved : { path: f.path, mode: 'info', at: 0 }
      const setBv = (change: Partial<BinView>) => update($, binViewAtom, () => ({ ...bv, ...change }))
      // kept per file version and page: a redraw (any click) doesn't read the file again
      const binKey = `${f.path}|${f.mtimeMs}|${bv.mode}|${bv.at}`
      const programs = (await $.env.get('ProgramFiles')) ?? ''
      // ± Diff: the copy at the last commit (a temp file in the cache, removed after) against the file now: readable
      // text and hex, and a class's bytecode through javap
      const binDiff = async (): Promise<Record<string, unknown>> => {
        const tmp = join(cacheDir, `last-commit-${Date.now()}${f.path.slice(f.path.lastIndexOf('.'))}`)
        const g = await helper(['gitblob', f.path, tmp])
        if (!g.ok) return { error: 'not in git at the last commit (new, or outside a git folder)' }
        try {
          const d = await helper(['bindiff', tmp, f.path, cacheDir])
          if (JAVA_CLASS.test(f.path) && !d.error && !d.same) {
            const j = await helper(['javap', f.path, programs, tmp, cacheDir])
            return { ...d, javapDiff: j.diff, javapDebugDiff: j.debugDiff, javapError: j.error }
          }
          return d
        } finally {
          void helper(['rmtemp', cacheDir, tmp])
        }
      }
      const binRead = (): Promise<Record<string, unknown>> => {
        switch (bv.mode) {
          case 'info':
            return helper(['bininfo', f.path])
          case 'files':
            return helper(['ziplist', f.path])
          case 'java':
            return helper(['javap', f.path, programs])
          case 'diff':
            return binDiff()
          default:
            return helper([bv.mode === 'text' ? 'strings' : 'hex', f.path, String(bv.at)])
        }
      }
      const r = binCache.get(binKey) ?? (await binRead())
      if (!r.error) binCache.set(binKey, r)
      if (binCache.size > 40) binCache.delete(binCache.keys().next().value!)
      const lines = Array.isArray(r.lines) ? (r.lines as string[]) : []
      const pe = Array.isArray(r.pe) ? (r.pe as string[]) : null
      const end = Number(r.end ?? 0)
      const size = Number(r.size ?? f.size)
      const step = bv.mode === 'hex' ? 4096 : 1024 * 1024
      const body =
        bv.mode === 'info'
          ? [`What it is: ${String(r.kind ?? 'unknown')}`, `Size: ${sizeText(size)}`, ...(pe ?? [])].join('\n')
          : bv.mode === 'java'
            ? String(r.text ?? '')
            : lines.join('\n') || (bv.mode === 'text' ? '(no readable text in this part)' : bv.mode === 'files' && !r.error ? '(no files in it)' : '')
      // ± Diff's parts: a heading, then its diff (or a line saying it's the same)
      const diffPart = (k: string, title: string, text: unknown, same: string) => [
        <Text key={`h:${k}`} bold>
          {title}
        </Text>,
        typeof text === 'string' && text.trim() ? diffView(k, text.slice(0, DRAW / 2)) : <Text key={`s:${k}`} dimColor wrap={wrapMode}>{same}</Text>,
      ]
      const decompile = async () => {
        await say('Decompiling with ILSpy (a few seconds the first time; kept after that)…')
        const d = await helper(['ilspy', f.path, cacheDir])
        if (d.error || typeof d.file !== 'string') return say(`No C#: ${String(d.error ?? 'ILSpy gave nothing')}`)
        await openPath(d.file)
        await say(`C# of ${f.path.slice(Math.max(f.path.lastIndexOf('\\'), f.path.lastIndexOf('/')) + 1)} by ILSpy (a cached copy: editing it changes nothing).`)
      }
      // a file inside a zip / jar: copied out to the cache (read only there) and opened like any file
      const openInZip = async (name: string) => {
        const d = await helper(['zipget', f.path, name, cacheDir])
        if (d.error || typeof d.file !== 'string') return say(`Couldn't open ${name}: ${String(d.error ?? 'nothing came out')}`)
        await openPath(d.file)
        await say(`${name} from ${f.path.slice(Math.max(f.path.lastIndexOf('\\'), f.path.lastIndexOf('/')) + 1)}: a copy in the cache (editing it changes nothing in the archive).`)
      }
      // a .NET DLL's C# against the last commit's: ILSpy on both copies (seconds to minutes, so only on a press)
      const csKey = `${f.path}|${f.mtimeMs}`
      const csDiff = csDiffs.get(csKey)
      const diffCs = async () => {
        await say('Decompiling both copies with ILSpy (kept after that)…')
        const tmp = join(cacheDir, `last-commit-${Date.now()}${f.path.slice(f.path.lastIndexOf('.'))}`)
        const g = await helper(['gitblob', f.path, tmp])
        const d = g.ok ? await helper(['csdiff', tmp, f.path, cacheDir]) : { error: 'not in git at the last commit' }
        if (g.ok) void helper(['rmtemp', cacheDir, tmp])
        csDiffs.set(csKey, d)
        if (csDiffs.size > 10) csDiffs.delete(csDiffs.keys().next().value!)
        await say(d.error ? `No C# diff: ${String(d.error)}` : 'C# diff ready (below the bytecode parts).')
      }
      const zipFiles = bv.mode === 'files' && Array.isArray(r.files) ? (r.files as { name: string; size: number }[]) : []
      // up to 300 files: each a button; more: the list as text, and a box to find files by part of their name
      const zf = await read($, zipFilterAtom)
      const zipFind = zf.path === f.path ? zf.text.trim().toLowerCase() : ''
      const bigZip = zipFiles.length > 300
      const zipShown = zipFind ? zipFiles.filter(z => z.name.toLowerCase().includes(zipFind)) : bigZip ? [] : zipFiles
      // a zip / jar's ± Diff: one changed file inside it, diffed on a press (the last commit's copy as a temp file)
      const ze = await read($, zipEntryAtom)
      const entryName = ze.path === f.path ? ze.name : ''
      const entryKey = (name: string) => `${f.path}|${f.mtimeMs}|${name}`
      const entryDiff = entryName ? entryDiffs.get(entryKey(entryName)) : undefined
      const diffEntry = async (name: string) => {
        await update($, zipEntryAtom, () => ({ path: f.path, name }))
        if (entryDiffs.has(entryKey(name))) return
        await say(`Comparing ${name} with the last commit's…`)
        const tmp = join(cacheDir, `last-commit-${Date.now()}${f.path.slice(f.path.lastIndexOf('.'))}`)
        const g = await helper(['gitblob', f.path, tmp])
        const d = g.ok ? await helper(['zipentry', tmp, f.path, name, cacheDir, programs]) : { error: 'not in git at the last commit' }
        if (g.ok) void helper(['rmtemp', cacheDir, tmp])
        entryDiffs.set(entryKey(name), d)
        if (entryDiffs.size > 30) entryDiffs.delete(entryDiffs.keys().next().value!)
        await say(d.error ? `No diff of ${name}: ${String(d.error)}` : d.same ? `${name} is the same as at the last commit.` : `${name}: its diff is under the list of files.`)
      }
      const entryTitle = !entryDiff
        ? ''
        : entryDiff.kind === 'javap'
          ? `${entryName}: ${entryDiff.debug ? 'debug info (javap -l; the bytecode is the same)' : 'bytecode (javap -c -p)'}`
          : entryDiff.kind === 'binary'
            ? `${entryName}: readable text`
            : entryName
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {fileTools(f.path)}
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="bin-info" label="ℹ Info" variant={bv.mode === 'info' ? 'primary' : 'secondary'} onPress={() => void setBv({ mode: 'info', at: 0 })} />
            <Button key="bin-text" label="🔤 Readable text" variant={bv.mode === 'text' ? 'primary' : 'secondary'} onPress={() => void setBv({ mode: 'text', at: 0 })} />
            <Button key="bin-hex" label="🔢 Hex" variant={bv.mode === 'hex' ? 'primary' : 'secondary'} onPress={() => void setBv({ mode: 'hex', at: 0 })} />
            {ZIPPED.test(f.path) ? <Button key="bin-files" label="🗂 Files inside" variant={bv.mode === 'files' ? 'primary' : 'secondary'} onPress={() => void setBv({ mode: 'files', at: 0 })} /> : null}
            {JAVA_CLASS.test(f.path) ? <Button key="bin-java" label="☕ Bytecode (javap)" variant={bv.mode === 'java' ? 'primary' : 'secondary'} onPress={() => void setBv({ mode: 'java', at: 0 })} /> : null}
            <Button key="bin-diff" label="± Diff" variant={bv.mode === 'diff' ? 'primary' : 'secondary'} onPress={() => void setBv({ mode: 'diff', at: 0 })} />
            {bv.mode === 'diff' ? sideToggle : null}
            {bv.mode === 'diff' && /\.(dll|exe)$/i.test(f.path) && !r.error && !r.same ? <Button key="bin-csdiff" label="C# diff (ILSpy)" variant={csDiff ? 'primary' : 'secondary'} onPress={() => void diffCs()} /> : null}
            {bv.mode === 'info' && r.dotnet ? <Button key="bin-cs" label="C# (ILSpy)" onPress={() => void decompile()} /> : null}
          </Box>
          {r.error ? <Text wrap={wrapMode} color="error">{bv.mode === 'diff' ? `No diff: ${String(r.error)}` : `Couldn't read it: ${String(r.error)}`}</Text> : null}
          {bv.mode === 'files' && !r.error ? (
            <Text wrap={wrapMode} dimColor>
              {`${Number(r.count ?? lines.length).toLocaleString('en-US')} entries, ${sizeText(Number(r.bytes ?? 0))} unpacked${lines.length >= 20000 ? ' · first 20,000 shown' : ''} · read from its directory, nothing unpacked${zipShown.length > 0 ? ' · press one to open a copy of it' : ''}`}
            </Text>
          ) : null}
          {bv.mode === 'files' && !r.error && bigZip && Input ? (
            <Box key="zip-find-row" flexDirection="column">
              <Input
                key="zip-find"
                label="🔎"
                placeholder="Find files in it by part of their name (Enter)"
                value={zf.path === f.path ? zf.text : ''}
                submitLabel="find"
                onSubmit={(v: string) => void update($, zipFilterAtom, () => ({ path: f.path, text: v }))}
              />
              {zipFind ? (
                <Text dimColor wrap={wrapMode}>{`${zipShown.length.toLocaleString('en-US')} match "${zipFind}"${zipShown.length > 300 ? ' · first 300 shown' : ''}`}</Text>
              ) : null}
            </Box>
          ) : null}
          {bv.mode === 'files' && !r.error && zipShown.length > 0 ? (
            // each file a button that opens a copy of it
            <Box key="zip-files" flexDirection="column">
              {zipShown.slice(0, 300).map((z, i) =>
                z.name.endsWith('/') ? (
                  <Text key={`zd${i}`} dimColor wrap={wrapMode}>{`📁 ${z.name}`}</Text>
                ) : (
                  <Button key={`zf:${i}`} label={`📄 ${z.name} · ${sizeText(z.size)}`} plain onPress={() => void openInZip(z.name)} />
                ),
              )}
            </Box>
          ) : null}
          {bv.mode === 'java' && typeof r.javap === 'string' ? <Text wrap={wrapMode} dimColor>{`by ${r.javap} (javap -c -p)`}</Text> : null}
          {bv.mode === 'diff' && !r.error ? (
            <Box key="bin-diff-body" flexDirection="column" gap={1}>
              <Text wrap={wrapMode} dimColor>
                {r.same ? 'The same bytes as at the last commit.' : `Last commit ${sizeText(Number(r.oldSize ?? 0))} → now ${sizeText(Number(r.newSize ?? 0))}`}
              </Text>
              {r.same
                ? null
                : [
                    ...(JAVA_CLASS.test(f.path) ? diffPart('bin-javap', 'Bytecode (javap -c -p)', r.javapDiff, r.javapError ? `No bytecode diff: ${String(r.javapError)}` : 'The bytecode is the same (only debug info or the constant pool changed).') : []),
                    // the same bytecode: the line numbers and local names (a recompile moves them)
                    ...(JAVA_CLASS.test(f.path) && typeof r.javapDebugDiff === 'string' && r.javapDebugDiff.trim() ? diffPart('bin-javap-l', 'Debug info (javap -l: line numbers, local variable names)', r.javapDebugDiff, '') : []),
                    ...(csDiff ? diffPart('bin-csd', 'C# (ILSpy on both copies)', csDiff.diff, csDiff.error ? `No C# diff: ${String(csDiff.error)}` : 'The C# is the same.') : []),
                    // a zip / jar: which files inside were added, removed or changed
                    ...(Array.isArray(r.files)
                      ? [
                          <Text key="h:bin-zipfiles" bold>
                            Files inside
                          </Text>,
                          <Box key="bin-zipfiles" flexDirection="column">
                            {(r.files as string[]).length === 0 ? (
                              <Text key="z-same" dimColor wrap={wrapMode}>The same files (only how they're packed changed).</Text>
                            ) : (
                              // each a button: that file's own diff (a class by javap) under the list
                              (r.files as string[]).slice(0, 400).map((l, i) => {
                                const name = l.slice(2).replace(/ {2}\([^)]*\)$/, '')
                                return (
                                  <Box key={`zcrow${i}`} flexDirection="row" gap={1}>
                                    <Text color={l.startsWith('-') ? 'diffRemoved' : l.startsWith('+') ? 'diffAdded' : 'warning'}>{l[0]}</Text>
                                    <Button key={`zc:${i}`} label={l.slice(2)} plain variant={name === entryName ? 'primary' : 'secondary'} onPress={() => void diffEntry(name)} />
                                  </Box>
                                )
                              })
                            )}
                          </Box>,
                          ...(entryDiff
                            ? [
                                ...diffPart('bin-entry', entryTitle, entryDiff.diff, entryDiff.error ? `No diff of ${entryName}: ${String(entryDiff.error)}` : `${entryName} is the same as at the last commit.`),
                                ...(Array.isArray(entryDiff.hex) && entryDiff.hex.length
                                  ? [
                                      <Box key="bin-entry-hex" flexDirection="column">
                                        {(entryDiff.hex as string[]).slice(0, 200).map((l, i) => (
                                          <Text key={`ex${i}`} wrap={wrapMode} dimColor={l.startsWith('@@')} color={l.startsWith('-') ? 'diffRemoved' : l.startsWith('+') ? 'diffAdded' : undefined}>
                                            {l}
                                          </Text>
                                        ))}
                                      </Box>,
                                    ]
                                  : []),
                              ]
                            : []),
                        ]
                      : []),
                    ...diffPart('bin-strings', 'Readable text', r.text, 'The readable text is the same.'),
                    <Text key="h:bin-hexdiff" bold>
                      Bytes (hex)
                    </Text>,
                    // not a unified diff (its @@ lines say what moved), so drawn row by row, colored by its sign
                    <Box key="bin-hexdiff" flexDirection="column">
                      {(Array.isArray(r.hex) ? (r.hex as string[]) : []).slice(0, 400).map((l, i) => (
                        <Text key={`x${i}`} wrap={wrapMode} dimColor={l.startsWith('@@')} color={l.startsWith('-') ? 'diffRemoved' : l.startsWith('+') ? 'diffAdded' : undefined}>
                          {l}
                        </Text>
                      ))}
                    </Box>,
                  ]}
            </Box>
          ) : null}
          {bv.mode === 'text' || bv.mode === 'hex' ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="bin-prev" label="◀ Earlier" onPress={() => void setBv({ at: Math.max(0, bv.at - step) })} />
              <Button key="bin-next" label="Later ▶" onPress={() => void (end < size ? setBv({ at: end }) : say('That was the end of the file.'))} />
              <Text wrap={wrapMode} dimColor>
                {`bytes ${bv.at.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${size.toLocaleString('en-US')}${bv.mode === 'text' && lines.length >= 3000 ? ' · first 3,000 lines of this part' : ''}`}
              </Text>
            </Box>
          ) : null}
          {noteBlock(f.path)}
          {bv.mode === 'diff' || (bv.mode === 'files' && (zipShown.length > 0 || zipFind !== '')) ? null : Code ? <Code key={`bin:${bv.mode}`} source={body.slice(0, DRAW)} wrap={wrapMode} /> : <Text wrap={wrapMode}>{body.slice(0, DRAW)}</Text>}
        </Box>
      )
    }

    if (open) {
      const f = open
      const key = `${f.path}|${f.start}`
      const diffKey = `filediff:${f.path}`
      // ± Diff against: the last commit, the newest backup of this file, or the copy from before Claude's first edit
      const savedBase = await read($, diffBaseAtom)
      const change = (await read($, changesAtom)).find(c => c.path.toLowerCase() === f.path.toLowerCase())
      const claudeBefore = change?.before
      // Claude's change from one edit on: the copy before the first edit (all of them), then the one before each later
      // edit (step i: from edit i + 1 on)
      const claudeSteps = [
        ...(claudeBefore !== undefined ? [{ at: 0, before: claudeBefore }] : []),
        ...(change?.edits ?? []).filter(e => e.before !== claudeBefore),
      ]
      const claudeCopies = new Set(claudeSteps.map(s => s.before))
      // this file's backups, newest first (any of them can be the base; the newest unless one was picked), without the
      // copies made before Claude's edits (those are under "vs before Claude's edits")
      const fileBackups = (await read($, backupLogAtom)).filter(b => b.original.toLowerCase() === f.path.toLowerCase() && !claudeCopies.has(b.backup))
      const ours = savedBase.path === f.path ? savedBase : undefined
      const pickedBackup = fileBackups.find(b => b.backup === ours?.backup) ?? fileBackups[0]
      // two backups against each other: `versus` instead of the file now
      const versusBackup = ours?.versus ? fileBackups.find(b => b.backup === ours.versus && b.backup !== pickedBackup?.backup) : undefined
      const claudeStep = ours?.edit !== undefined && claudeSteps.length ? Math.min(ours.edit, claudeSteps.length - 1) : 0
      // another file: the one opened before this (open it, then this one, to compare the two)
      const otherFile = ours?.other ?? (await read($, recentAtom)).find(p => p.toLowerCase() !== f.path.toLowerCase())
      const base = ours && (ours.base !== 'backup' || pickedBackup) && (ours.base !== 'claude' || claudeBefore !== undefined) && (ours.base !== 'other' || otherFile) ? ours.base : 'commit'
      const against = base === 'claude' ? claudeSteps[claudeStep]?.before : base === 'backup' ? pickedBackup?.backup : base === 'other' ? otherFile : undefined
      const newer = base === 'backup' && versusBackup ? versusBackup.backup : f.path
      const setBase = (b: DiffBase['base'], more: Partial<DiffBase> = {}) =>
        update($, diffBaseAtom, () => ({ path: f.path, base: b, ...(b === 'other' ? { other: otherFile } : {}), ...more }))
      const runDiff = (args: string[]) =>
        $.process
          .run(['git', '-c', 'core.quotepath=false', 'diff', ...args], { cwd: parent(f.path), timeoutMs: 20_000 })
          .then(r => r.stdout)
          .catch(() => '')
      const fileDiffText = !showDiff.includes(diffKey)
        ? ''
        : base === 'commit'
          ? await runDiff([...wsArgs, 'HEAD', '--', f.path])
          : against
            ? await runDiff(['--no-index', '--no-color', ...wsArgs, '--', against, newer])
            : ''
      const comparedWith =
        base === 'commit'
          ? 'the last commit'
          : base === 'backup'
            ? `the backup from ${new Date(pickedBackup?.at ?? 0).toLocaleString()} (${String(against)})${versusBackup ? `, against the backup from ${new Date(versusBackup.at).toLocaleString()} (${versusBackup.backup}) instead of the file now` : ''}`
            : base === 'other'
              ? `${String(against)} (the file opened before this one)`
              : against
                ? claudeStep > 0
                  ? `the file before Claude's edit ${claudeStep + 1} of ${claudeSteps.length} this session (${against}): that edit and later ones`
                  : `the file before Claude's first edit this session (${against})`
                : "nothing: Claude made this file this session, so all of it is Claude's"
      // Put back what Claude changed (from the picked edit on): the current version backed up first, then that copy
      const putBackClaude = async () => {
        if (base !== 'claude' || !against) return
        const now = await backupOf(f.path)
        if (!now.ok) return say(`Not put back: couldn't copy the current version first (${String(now.error ?? 'unknown')}).`)
        const r = await helper(['restore', against, f.path])
        if (!r.ok) return say(`Not put back: ${String(r.error ?? 'unknown')}.`)
        await openPath(f.path)
        await say(`Put back the file from before Claude's ${claudeStep > 0 ? `edit ${claudeStep + 1}` : 'edits'}; the version it replaced is in ${String(now.backup)}.`)
      }
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text wrap={wrapMode} dimColor>
            {sizeText(f.size)}
            {f.mode === 'page' ? ` · page: bytes ${f.start.toLocaleString()}–${f.end.toLocaleString()}` : ''}
            {f.eol === '\r\n' ? ' · CRLF' : ''}
            {f.binary ? ' · binary: view only' : ' · Shift+Enter for a new line'}
          </Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {!f.binary && Input && (
              <Button key="save" variant="primary" onPress={() => void save(f)}>
                Save
              </Button>
            )}
            {lastBackup ? (
              <Button key="revert" onPress={() => void revert(f)}>
                Revert last save
              </Button>
            ) : null}
            {f.mode === 'page' && f.start > 0 ? (
              <Button key="prev" onPress={() => void loadPage(f.path, Math.max(0, f.start - PAGE), f.size, f.mtimeMs)}>
                ‹ Page
              </Button>
            ) : null}
            {f.mode === 'page' && f.end < f.size ? (
              <Button key="next" onPress={() => void loadPage(f.path, f.end, f.size, f.mtimeMs)}>
                Page ›
              </Button>
            ) : null}
            {fileTools(f.path)}
            <Button key="diff" variant={showDiff.includes(diffKey) ? 'primary' : 'secondary'} onPress={() => void flipDiffFile(diffKey)}>
              ± Diff
            </Button>
            {/\.(md|markdown)$/i.test(f.path) ? (
              <Button key="as-doc" onPress={() => void update($, asTextAtom, () => false)}>
                Show as document
              </Button>
            ) : /\.svg$/i.test(f.path) || MODEL_TEXT.test(f.path) ? (
              <Button key="as-doc" onPress={() => void update($, asTextAtom, () => false)}>
                Show preview
              </Button>
            ) : null}
          </Box>
          {noteBlock(f.path)}
          {showDiff.includes(diffKey) ? (
            <Box key="diff-against" flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="base-commit" label="vs last commit" variant={base === 'commit' ? 'primary' : 'secondary'} onPress={() => void setBase('commit')} />
              {pickedBackup ? <Button key="base-backup" label={fileBackups.length > 1 ? 'vs a backup' : 'vs its backup'} variant={base === 'backup' ? 'primary' : 'secondary'} onPress={() => void setBase('backup')} /> : null}
              {claudeBefore !== undefined ? <Button key="base-claude" label="vs before Claude's edits" variant={base === 'claude' ? 'primary' : 'secondary'} onPress={() => void setBase('claude')} /> : null}
              {otherFile ? <Button key="base-other" label={`vs ${otherFile.split(/[\\/]/).pop()}`} variant={base === 'other' ? 'primary' : 'secondary'} onPress={() => void setBase('other')} /> : null}
              {base === 'claude' && against ? <Button key="claude-putback" label={claudeStep > 0 ? `↩ Put back (undo edit ${claudeStep + 1} and later)` : "↩ Put back (undo Claude's edits)"} onPress={() => void putBackClaude()} /> : null}
            </Box>
          ) : null}
          {showDiff.includes(diffKey) && base === 'claude' && claudeSteps.length > 1 ? (
            // Claude's change from one edit on (the newest 8 edits, and all of them)
            <Box key="diff-edits" flexDirection="row" gap={1} flexWrap="wrap">
              <Text dimColor>Claude's change:</Text>
              {claudeSteps.map((s, i) =>
                i === 0 || i >= claudeSteps.length - 8 ? (
                  <Button key={`ce:${i}`} label={i === 0 ? `all ${claudeSteps.length} edits` : `from edit ${i + 1} · ${new Date(s.at).toLocaleTimeString()}`} variant={i === claudeStep ? 'primary' : 'secondary'} onPress={() => void setBase('claude', { edit: i })} />
                ) : null,
              )}
            </Box>
          ) : null}
          {showDiff.includes(diffKey) && base === 'backup' && fileBackups.length > 1 ? (
            // which backup: the newest 8, by when they were made; and against the file now or another backup
            <Box key="diff-backups" flexDirection="column">
              <Box key="diff-backup-pick" flexDirection="row" gap={1} flexWrap="wrap">
                <Text dimColor>Backup from:</Text>
                {fileBackups.slice(0, 8).map((b, i) => (
                  <Button key={`bk:${i}`} label={new Date(b.at).toLocaleString()} variant={b.backup === pickedBackup?.backup ? 'primary' : 'secondary'} onPress={() => void setBase('backup', { backup: b.backup, ...(ours?.versus && ours.versus !== b.backup ? { versus: ours.versus } : {}) })} />
                ))}
              </Box>
              <Box key="diff-backup-versus" flexDirection="row" gap={1} flexWrap="wrap">
                <Text dimColor>Against:</Text>
                <Button key="vs:now" label="the file now" variant={versusBackup ? 'secondary' : 'primary'} onPress={() => void setBase('backup', { backup: pickedBackup?.backup })} />
                {fileBackups.slice(0, 8).map((b, i) =>
                  b.backup === pickedBackup?.backup ? null : (
                    <Button key={`vs:${i}`} label={new Date(b.at).toLocaleString()} variant={b.backup === versusBackup?.backup ? 'primary' : 'secondary'} onPress={() => void setBase('backup', { backup: pickedBackup?.backup, versus: b.backup })} />
                  ),
                )}
              </Box>
            </Box>
          ) : null}
          {showDiff.includes(diffKey) ? sideToggle : null}
          {showDiff.includes(diffKey) ? <Text wrap={wrapMode} dimColor>{`Compared with ${comparedWith}`}</Text> : null}
          {showDiff.includes(diffKey) && (base === 'commit' || against) ? (
            fileDiffText.trim() ? (
              diffView('filediff', fileDiffText.slice(0, 60_000))
            ) : (
              <Text wrap={wrapMode} dimColor>{base === 'commit' ? 'No changes since the last commit (or not in git).' : 'No differences.'}</Text>
            )
          ) : null}
          {!wrap && Code && !f.binary ? (
            // the editor box always wraps (the engine's field has no setting): with Wrap off, read the file one row
            // per line, numbered; ✎ Edit turns Wrap back on for the editor
            <Box flexDirection="column">
              {Input ? <Button key="edit-wrapped" label="✎ Edit (turns Wrap on)" onPress={() => void update($, wrapAtom, () => true)} /> : null}
              <Code key={`read:${key}`} source={f.text.slice(0, DRAW)} path={f.path} startLine={f.start === 0 ? 1 : undefined} wrap="truncate-end" />
            </Box>
          ) : Input ? (
            <Input
              key={`edit:${key}`}
              rows={rows}
              value={f.binary ? '(binary file)' : f.text}
              submitLabel="keep"
              onInput={(v: string) => {
                draft = { key, text: v }
              }}
              onSubmit={(v: string) => {
                draft = { key, text: v }
                void say('Kept in the editor. Press Save to write it.')
              }}
            />
          ) : (
            <Text wrap={wrapMode}>{f.binary ? '(binary file)' : f.text.slice(0, 20_000)}</Text>
          )}
        </Box>
      )
    }

    let entries: { name: string; kind: string; size: number; mtimeMs?: number }[] = []
    let listError = ''
    try {
      step('listing the folder')
      entries = await $.fs.list(dir)
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err)
    }
    // sorted by name (folders first), size or modified time (biggest / newest first); narrowed by 🔎
    const sortBy = await read($, sortAtom)
    const folderFind = (await read($, folderFindAtom)).trim().toLowerCase()
    const total = entries.length
    if (folderFind) entries = entries.filter(x => x.name.toLowerCase().includes(folderFind))
    entries.sort((a, b) =>
      sortBy === 'size' ? b.size - a.size || a.name.localeCompare(b.name) : sortBy === 'date' ? (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) : a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
    )
    step('reading pinned files')
    const pinned = await read($, pinnedAtom)
    const recent = await read($, recentAtom)
    // git state of this folder's entries (a folder: changed when anything under it is); only inside a repository
    const gitHere = new Map<string, string>()
    step('checking git')
    try {
      if (!(await repoOf($, dir))) throw new Error('not in a git repository')
      // (through the kept git answers, like the Git page: no git run on every redraw)
      const status = await git(dir, ['status', '--porcelain=v1', '-uall', '--', '.'])
      const top = (await git(dir, ['rev-parse', '--show-prefix'])).trim()
      // every path under this folder, and each folder on the way to it (changed when anything under it is), so the
      // tree's deeper rows have their state too; keys are paths relative to this folder, lower case, with /
      for (const l of status.split(/\r?\n/)) {
        if (l.length < 4) continue
        const relPath = l.slice(3).replace(/^"|"$/g, '')
        const inside = top && relPath.toLowerCase().startsWith(top.toLowerCase()) ? relPath.slice(top.length) : relPath
        const x = l.slice(0, 2)
        const st = x === '??' ? 'new' : x.includes('D') ? 'deleted' : 'changed'
        const parts = inside.toLowerCase().split('/')
        for (let i = 1; i < parts.length; i++) gitHere.set(parts.slice(0, i).join('/'), 'changed')
        gitHere.set(parts.join('/'), st)
      }
    } catch {
      /* not a git folder */
    }
    // 🌳 the folder as a tree: a folder's ▸ opens it in place (its rows under it, indented), at most `limit` rows in
    // all; folders show their total size (counted in the background, kept 5 minutes)
    const sizeOf = (base: string, x: { name: string; kind: string; size: number }) => (x.kind === 'dir' ? (dirSizes.get(join(base, x.name).toLowerCase())?.bytes ?? -1) : x.size)
    const order = (base: string) => (a: { name: string; kind: string; size: number; mtimeMs?: number }, b: { name: string; kind: string; size: number; mtimeMs?: number }) =>
      sortBy === 'size' ? sizeOf(base, b) - sizeOf(base, a) || a.name.localeCompare(b.name) : sortBy === 'date' ? (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) : a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1
    type TreeRow = { name: string; path: string; rel: string; kind: string; size: number; mtimeMs?: number; depth: number }
    const treeOpen = new Set(await read($, treeOpenAtom))
    const anyOpen = treeOpen.size > 0
    const flipTree = (path: string) => update($, treeOpenAtom, list => (list.includes(path.toLowerCase()) ? list.filter(x => x !== path.toLowerCase()) : [...list, path.toLowerCase()].slice(-1000)))
    // ⊞ Open all: every folder under this one, level by level, each marked open on its own (so ▾ folds any of them),
    // until 400 rows or 300 folders (the rows come a page at a time); links and junctions aren't followed
    const openAll = async () => {
      const found: string[] = []
      let rowsSeen = 0
      let level = [dir]
      while (level.length && rowsSeen < 400 && found.length < 300) {
        const deeper: string[] = []
        for (const d of level) {
          const kids = await $.fs.list(d).catch(() => [] as { name: string; kind: string; isLink?: boolean }[])
          rowsSeen += kids.length
          for (const k of kids) if (k.kind === 'dir' && !k.isLink) deeper.push(join(d, k.name))
          if (rowsSeen >= 400) break
        }
        for (const d of deeper.slice(0, 300 - found.length)) found.push(d.toLowerCase())
        level = deeper
      }
      await update($, treeOpenAtom, list => [...new Set([...list, ...found])].slice(-1000))
    }
    const treeRows: TreeRow[] = []
    const addRows = async (list: { name: string; kind: string; size: number; mtimeMs?: number }[], base: string, relBase: string, depth: number) => {
      for (const x of [...list].sort(order(base))) {
        if (treeRows.length > limit + LIST) return
        const path = join(base, x.name)
        const rel = relBase ? `${relBase}/${x.name}` : x.name
        treeRows.push({ name: x.name, path, rel, kind: x.kind, size: x.size, mtimeMs: x.mtimeMs, depth })
        // open: pressed open, or ⊞ Open all for this folder (three levels deep; the rows come a page at a time)
        if (x.kind === 'dir' && treeOpen.has(path.toLowerCase()) && depth < 40) await addRows(await $.fs.list(path).catch(() => []), path, rel, depth + 1)
      }
    }
    await addRows(entries, dir, '', 0)
    const stale = treeRows.filter(r => r.kind === 'dir').map(r => r.path).filter(d => {
      const c = dirSizes.get(d.toLowerCase())
      return !c || Date.now() - c.at > 300_000
    })
    if (stale.length && !dirSizing) {
      dirSizing = true
      const want = stale.slice(0, 60)
      void (async () => {
        // Everything's index first (instant, when es.exe is in Program Files\Everything), the helper's count for the rest
        const fromIndex = await everythingSizes($, [...new Set(want.map(d => parent(d)))])
        const rest = want.filter(d => !fromIndex.has(d.toLowerCase()))
        const r = rest.length ? await helper(['dirsizes', ...rest]) : {}
        dirSizing = false
        const got = (r.sizes ?? {}) as Record<string, { bytes: number; files: number; partial: boolean }>
        // a folder neither answered (Node missing, an error) is kept as unknown (−1) for its 5 minutes too, so a
        // failing count isn't asked again on every redraw
        for (const d of want) {
          const indexed = fromIndex.get(d.toLowerCase())
          dirSizes.set(d.toLowerCase(), { ...(indexed !== undefined ? { bytes: indexed, files: 0, partial: false } : (got[d] ?? { bytes: -1, files: 0, partial: false })), at: Date.now() })
        }
        if (dirSizes.size > 2000) dirSizes.delete(dirSizes.keys().next().value!)
        $.ui.invalidate('ui.render')
      })()
    }
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {card(
          'folder',
          `📁 ${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}`,
          listError ? '' : folderFind ? `${entries.length} of ${total} match "${folderFind}"` : `${total} item${total === 1 ? '' : 's'}`,
          [
            listError ? <Text key="list-error" wrap={wrapMode} color="error">{`Can't list it: ${listError}`}</Text> : null,
            // 🔎 only where there's something to find in (more than 20 entries), or while a search is on
            Input && (total > 20 || folderFind || toggled.has('folder-find')) ? (
              <Box key="find-row" flexDirection="row" gap={1}>
                <Box flexGrow={1}>
                  <Input key="folder-find" label="🔎" placeholder="Find by part of a name (Enter)" value={folderFind} submitLabel="find" onSubmit={(v: string) => void update($, folderFindAtom, () => v)} />
                </Box>
                {folderFind ? <Button key="find-clear" label="✕ All" plain onPress={() => void update($, folderFindAtom, () => '')} /> : null}
              </Box>
            ) : null,
            // ⊞ Open all (three levels) / ⊟ Fold all, where there are folders to open
            entries.some(x => x.kind === 'dir') ? (
              <Box key="tree-tools" flexDirection="row" gap={1}>
                <Button key="tree-open-all" label="⊞ Open all" plain onPress={() => void openAll()} />
                {anyOpen ? <Button key="tree-fold-all" label="⊟ Fold all" plain onPress={() => void update($, treeOpenAtom, () => [])} /> : null}
              </Box>
            ) : null,
            // the header: each column's label sorts by it
            tableRow(
              'folder-head',
              <Button key="sort:name" label={sortBy === 'name' ? 'Name ▾' : 'Name'} plain variant={sortBy === 'name' ? 'primary' : 'secondary'} onPress={() => void update($, sortAtom, () => 'name')} />,
              [
                [<Button key="sort:size" label={sortBy === 'size' ? 'Size ▾' : 'Size'} plain variant={sortBy === 'size' ? 'primary' : 'secondary'} onPress={() => void update($, sortAtom, () => 'size')} />, 9],
                [<Button key="sort:date" label={sortBy === 'date' ? 'Modified ▾' : 'Modified'} plain variant={sortBy === 'date' ? 'primary' : 'secondary'} onPress={() => void update($, sortAtom, () => 'date')} />, 12],
                [headCell('Git'), 10],
              ],
            ),
            ...treeRows.slice(limit, limit + LIST).map(x => {
              const [icon, color] = x.kind === 'dir' ? ['📁', 'warning'] : kindOf(x.name)
              const g = gitHere.get(x.rel.toLowerCase())
              const now = Date.now()
              const tone = x.mtimeMs ? ageTone(x.mtimeMs, now) : 'old'
              const isOpen = treeOpen.has(x.path.toLowerCase())
              const ds = x.kind === 'dir' ? dirSizes.get(x.path.toLowerCase()) : undefined
              return tableRow(
                `row:${x.rel}`,
                <Box flexDirection="row" gap={0} marginLeft={x.depth * 2}>
                  {x.kind === 'dir' ? <Button key={`tg:${x.rel}`} label={isOpen ? '▾' : '▸'} plain dimColor onPress={() => void flipTree(x.path)} /> : <Text>{'  '}</Text>}
                  <Button key={`e:${x.rel}`} label={`${icon} ${x.name}`} plain onPress={() => void (x.kind === 'dir' ? goDir(x.path) : openPath(x.path))} />
                </Box>,
                [
                  [x.kind === 'file' ? sizeText(x.size) : !ds ? '…' : ds.bytes < 0 ? '—' : `${ds.partial ? '≥ ' : ''}${sizeText(ds.bytes)}`, 9],
                  [x.mtimeMs ? <Text wrap="truncate-end" color={tone === 'new' ? 'success' : undefined} dimColor={tone !== 'new'}>{`${age(x.mtimeMs, now)}${age(x.mtimeMs, now) === 'just now' ? '' : ' ago'}`}</Text> : '', 12],
                  [g ? <Text wrap="truncate-end" color={GIT_COLOR[g]}>{`● ${g}`}</Text> : color && x.kind === 'file' ? <Text color={color}>●</Text> : '', 10],
                ],
              )
            }),
            limit > 0 || treeRows.length > limit + LIST ? (
              <Box key="folder-pages" flexDirection="row" gap={1}>
                {limit > 0 ? <Button key="rows-prev" label="◀ Previous" plain onPress={() => void update($, shownAtom, n => Math.max(0, n - LIST))} /> : null}
                <Text dimColor>{`rows ${limit + 1}-${Math.min(treeRows.length, limit + LIST)}`}</Text>
                {treeRows.length > limit + LIST ? <Button key="rows-next" label="Next ▶" plain onPress={() => void update($, shownAtom, n => n + LIST)} /> : null}
              </Box>
            ) : null,
          ],
        )}
      </Box>
    )
    } catch (err) {
      $.ui.status(undefined)
      const { Box, Text, Button } = $.ui.resolve(e)
      const why = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1, 4).join('\n')}` : ''}` : String(err)
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error">The Files pane couldn't draw this view:</Text>
          <Text>{why}</Text>
          <Button key="reset" onPress={() => void (async () => {
            await showPane($, PANE)
            await update($, openAtom, () => null)
            await update($, dirAtom, () => '')
          })()}>
            Back to the folder list
          </Button>
        </Box>
      )
    } finally {
      // drawn (or its error shown): the step line goes
      $.ui.status(undefined)
    }
  })
}
