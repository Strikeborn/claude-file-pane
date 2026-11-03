import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BinView, Change, CheckResult, DiffBase, OpenFile, Tick } from '../types'
import { DONE_DATE, NEXT_HEADING, blocksFrom, boxesIn, commitsFrom, featuresFrom, flipTask, headingPath, markDone, releasesFrom, sections, sideBySide, splitBoxes, tasks, wordDiff } from './project'
import type { Block, Task, TimelineEntry } from './project'
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
const PAGE = 60_000
const LIST = 200

const dirAtom = atom({ plugin: 'file-pane', key: 'dir' } as const, '')
const openAtom = atom({ plugin: 'file-pane', key: 'open' } as const, null)
const msgAtom = atom({ plugin: 'file-pane', key: 'message' } as const, '')
const shownAtom = atom({ plugin: 'file-pane', key: 'shown' } as const, LIST)
const backupAtom = atom({ plugin: 'file-pane', key: 'lastBackup' } as const, '')
const viewAtom = atom({ plugin: 'file-pane', key: 'view' } as const, 'files')
const tabAtom = atom({ plugin: 'file-pane', key: 'projectTab' } as const, 'items')
const allAtom = atom({ plugin: 'file-pane', key: 'itemsAll' } as const, false)
const toggledAtom = atom({ plugin: 'file-pane', key: 'toggled' } as const, [])
const asTextAtom = atom({ plugin: 'file-pane', key: 'mdAsText' } as const, false)
const editingAtom = atom({ plugin: 'file-pane', key: 'editing' } as const, '')
const changesAtom = atom({ plugin: 'file-pane', key: 'changes' } as const, [] as Change[])
const runningAtom = atom({ plugin: 'file-pane', key: 'running' } as const, '')
const resultsAtom = atom({ plugin: 'file-pane', key: 'results' } as const, {} as Record<string, CheckResult>)
const diffOpenAtom = atom({ plugin: 'file-pane', key: 'diffOpen' } as const, [] as string[])
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
type Thumb = { w: number; h: number; tw: number; th: number; b64: string; mime?: string; via?: string }
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
    if (!(await read($, dirAtom))) await update($, dirAtom, () => '')
    void $.ui.open({ id: PANE, title: 'Files' })
    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    await update($, bandHiddenAtom, () => false)
    await $.ui.open({ id: PANE, title: 'Files' })
    return { text: 'Files pane opened.' }
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
    await recordChange($, e.file_path, 'Edit', r.deny === undefined && r.isError !== true, before)
    return r
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const before = await snapshotBefore($, e.file_path)
    const r = await next(e)
    await recordChange($, e.file_path, 'Write', r.deny === undefined && r.isError !== true, before)
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
          await update($, viewAtom, () => 'files')
          await $.ui.open({ id: PANE, title: 'Files', focus: true })
        })()} />

        {changes ? (
          <Button key="band-changes" label={`✎ ${changes} edited`} plain onPress={() => void (async () => {
            await update($, viewAtom, () => 'project')
            await update($, tabAtom, () => 'changes')
            await $.ui.open({ id: PANE, title: 'Files', focus: true })
          })()} />

        ) : null}
        {failing.length ? (
          <Button key="band-checks" label={`❌ ${failing.join(', ')}`} plain onPress={() => void (async () => {
            await update($, viewAtom, () => 'project')
            await update($, tabAtom, () => 'checks')
            await $.ui.open({ id: PANE, title: 'Files', focus: true })
          })()} />

        ) : null}
        {open ? (
          <Button key="band-items" label={`☐ ${open} open`} plain onPress={() => void (async () => {
            await update($, viewAtom, () => 'project')
            await update($, tabAtom, () => 'items')
            await $.ui.open({ id: PANE, title: 'Files', focus: true })
          })()} />

        ) : null}
        <Button key="band-hide" plain dimColor onPress={() => void update($, bandHiddenAtom, () => true)}>
          ×
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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
      for (const max of [420, 280, 160]) {
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
      const box = `${((t.tw - vw) / 2).toFixed(1)} ${((t.th - vh) / 2).toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`
      return Svg ? (
        <Svg
          key={key}
          alt={alt}
          width={t.tw}
          height={t.th}
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${t.tw}" height="${t.th}" viewBox="${box}"><image href="data:image/${t.mime === 'jpeg' ? 'jpeg' : 'png'};base64,${t.b64}" width="${t.tw}" height="${t.th}"/></svg>`}
        />
      ) : (
        <Text dimColor>{alt}</Text>
      )
    }
    const showDiff = await read($, diffOpenAtom)
    const side = await read($, sideAtom)
    // ↩ Wrap: long lines continue on more rows, or stay one row cut at the edge (every Text / Code the pane draws)
    const wrap = await read($, wrapAtom)
    const wrapMode = wrap ? ('wrap' as const) : ('truncate-end' as const)
    // a diff, one column (colored by the Code element) or two (before | after)
    const diffView = (k: string, text: string) => {
      if (!side) return Code ? <Code key={`dv:${k}`} source={text} format="diff" wrap={wrapMode} /> : <Text key={`dv:${k}`} wrap={wrapMode}>{text}</Text>
      const rows = sideBySide(text).slice(0, 1500)
      // a row's side: its sign, then the line, with the words that differ from the other side highlighted
      const cellText = (r: (typeof rows)[number], which: 'left' | 'right') => {
        const v = which === 'left' ? r.left : r.right
        if (v === undefined) return ' '
        const changed = r.kind === 'change'
        const sign = changed ? (which === 'left' ? '- ' : '+ ') : '  '
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

    const goDir = async (to: string) => {
      draft = null
      await update($, openAtom, () => null)
      await update($, shownAtom, () => LIST)
      await update($, dirAtom, () => to)
      await say('')
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

    const openPath = async (path: string) => {
      let st
      try {
        st = await $.fs.stat(path)
      } catch (err) {
        return say(`Not found: ${path}`)
      }
      if (st.kind === 'dir') return goDir(path)
      if (st.kind !== 'file') return say('That is neither a file nor a folder.')
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

    const view = await read($, viewAtom)
    const toggled = new Set(await read($, toggledAtom))
    const flip = (k: string) => update($, toggledAtom, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k].slice(-400)))

    /**
     * Lines [from, to) of a text file replaced by `next`: read again first and refused unless they're still `expected`
     * (someone else changed the file), a backup copy first, then written whole (temp file renamed over it).
     */
    const replaceLines = async (path: string, from: number, expected: string[], next: string[]): Promise<boolean> => {
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
      lines.splice(from, expected.length, ...next)
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
                          const next = (typed.get(k) ?? body.join('\n')).split(/\r?\n/)
                          if (await replaceLines(path, s.from + 1, body, next)) await say(`Saved “${s.title}”.`)
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

    const git = async (root: string, args: string[]) => {
      try {
        const r = await $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: root, timeoutMs: 20_000 })
        return r.stdout
      } catch {
        return ''
      }
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

    const changesView = async (root: string, tab: 'changes' | 'git') => {
      const rel = (p: string) => (p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length).replace(/^[\\/]/, '') : p)
      const status = await git(root, ['status', '--porcelain=v1', '-uall'])
      const states = new Map<string, string>()
      for (const l of status.split(/\r?\n/)) if (l.length > 3) states.set(l.slice(3).replace(/^"|"$/g, '').toLowerCase(), l.slice(0, 2))
      const label = (x: string) => (x === '??' ? 'new' : x.includes('M') ? 'changed' : x.includes('A') ? 'added' : x.includes('D') ? 'deleted' : x.includes('R') ? 'renamed' : x.trim())
      const rows =
        tab === 'changes'
          ? (await read($, changesAtom)).map(c => ({ path: c.path, rel: rel(c.path).replace(/\\/g, '/'), note: `${c.tool}${c.n > 1 ? ` ×${c.n}` : ''} · ${new Date(c.at).toLocaleTimeString()}`, before: c.before }))
          : [...states.entries()].map(([r, x]) => ({ path: join(root, r), rel: r, note: label(x), before: undefined as string | undefined }))
      const branch = tab === 'git' ? (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() : ''
      const out = []
      for (const row of rows) {
        const k = `${tab}:${row.rel}`
        const st = states.get(row.rel.toLowerCase())
        out.push(
          <Box key={`ch:${k}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key={`d:${k}`} label={`${diffOpen.has(k) ? '▾' : '▸'} ${kindOf(row.rel)[0]} ${row.rel}`} plain onPress={() => void flipDiff(k)} />
              <Text wrap={wrapMode} color={GIT_COLOR[tab === 'git' ? row.note : label(st ?? '')]}>● </Text>
              <Text wrap={wrapMode} dimColor>
                {row.note}
                {tab === 'changes' && st ? ` · git: ${label(st)}` : tab === 'changes' ? ' · git: committed or outside' : ''}
              </Text>
              <Button key={`o:${k}`} plain onPress={() => void (async () => {
                await update($, viewAtom, () => 'files')
                await openPath(row.path)
              })()}>
                Open
              </Button>
              {row.before ? (
                // Claude's own change: the file against the copy made before its first edit this session
                <Button key={`cl:${k}`} label="± Claude's change" plain onPress={() => void (async () => {
                  await update($, diffBaseAtom, () => ({ path: row.path, base: 'claude' }))
                  await update($, diffOpenAtom, list => [...list.filter(x => x !== `filediff:${row.path}`), `filediff:${row.path}`].slice(-50))
                  await update($, viewAtom, () => 'files')
                  await openPath(row.path)
                })()} />
              ) : null}
            </Box>
            {diffOpen.has(k) ? diffBlock(k, await fileDiff(root, row.rel, st === '??')) : null}
          </Box>,
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          {sideToggle}
          <Text wrap={wrapMode} dimColor>
            {tab === 'changes'
              ? `${rows.length} file${rows.length === 1 ? '' : 's'} Claude edited this session (newest first); ▸ shows the diff against the last commit`
              : `${branch ? `On ${branch} · ` : ''}${rows.length} changed or new file${rows.length === 1 ? '' : 's'}`}
          </Text>
          {out}
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
              await update($, viewAtom, () => 'files')
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
                  await update($, viewAtom, () => 'files')
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
                      const next = (typed.get(k) ?? body.join('\n')).split(/\r?\n/)
                      if (await replaceLines(f, s.from + 1, body, next)) await say(`Saved “${s.title}”.`)
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
      const files = [...new Set(hits.map(h => h.file))]
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
                await update($, viewAtom, () => 'files')
                await openPath(join(root, f))
              })()} />
              {hits
                .filter(h => h.file === f)
                .map(h => (
                  <Text key={`sl:${f}:${h.line}`} wrap={wrapMode}>
                    <Text wrap={wrapMode} color="subtle">{String(h.line).padStart(5)} </Text>
                    {h.text}
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
      const tab = await read($, tabAtom)
      if (tab === 'log' && !logTimer) logTimer = $.clock.every(2000, () => $.ui.invalidate('ui.render'))
      if (tab !== 'log' && logTimer) {
        logTimer.cancel()
        logTimer = null
      }
      const all = await read($, allAtom)
      const tabs: [typeof tab, string][] = [
        ['next', '🧭 Next'],
        ['items', '☑ Items'],
        ['ticks', '📅 Ticks'],
        ['timeline', '🕒 Timeline'],
        ['features', '✨ Features'],
        ['blocks', '🧱 Building blocks'],
        ['changes', '✎ Changes'],
        ['git', '🌿 Git'],
        ['checks', '▶ Checks'],
        ['search', '🔍 Search'],
        ['backups', '🗂 Backups'],
        ['log', '📜 Log'],
        ['notes', '🗒 Notes'],
      ]
      const tabBar = (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {tabs.map(([k, label]) => (
            <Button key={`tab:${k}`} variant={tab === k ? 'primary' : 'secondary'} onPress={() => void update($, tabAtom, () => k)}>
              {label}
            </Button>
          ))}
        </Box>
      )
      let body
      if (tab === 'items') {
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
                    await update($, viewAtom, () => 'files')
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
                        await update($, viewAtom, () => 'files')
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
      } else if (tab === 'changes' || tab === 'git') {
        body = await changesView(root, tab)
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
              return (
              <Box key={`tlrow:${i}`} flexDirection="row" gap={1}>
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
                        const next = (typed.get(ek) ?? b.raw.join('\n')).split(/\r?\n/)
                        if (await replaceLines(file, b.from + 1, b.raw, next)) await say(`Saved “${b.title}”.`)
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

    // which pane this chat runs: version and deploy time, and a newer deploy when there is one
    const ver = await deployInfo($, home)
    const switcher = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="v-files" variant={view === 'files' ? 'primary' : 'secondary'} onPress={() => void update($, viewAtom, () => 'files')}>
            Files
          </Button>
          <Button key="v-project" variant={view === 'project' ? 'primary' : 'secondary'} onPress={() => void update($, viewAtom, () => 'project')}>
            Project
          </Button>
          <Button key="wrap" label={wrap ? '↩ Wrap: on' : '↩ Wrap: off'} variant={wrap ? 'primary' : 'secondary'} onPress={() => void update($, wrapAtom, v => !v)} />
        </Box>
        <Text key="version" wrap={wrapMode} dimColor>
          {`Files pane ${ver.version ? `v${ver.version}` : ''}${ver.at ? ` · deployed ${whenText(ver.at)}` : ' · run from its source folder'}`}
        </Text>
        {ver.newer ? (
          <Text key="newer" wrap={wrapMode} color="warning">
            {`A newer pane was deployed ${whenText(ver.newer)}: new chats get it (this chat started without the folder watch, so it keeps the one it started with).`}
          </Text>
        ) : null}
        {undoBar}
      </Box>
    )
    if (view === 'project')
      return (
        <Box flexDirection="column" gap={1}>
          {switcher}
          {await projectView()}
        </Box>
      )

    const header = (
      <Box flexDirection="column" gap={1}>
        {switcher}
        {Input ? (
          <Input key="path" label="Path" value={open ? open.path : dir} submitLabel="go" onSubmit={(v: string) => void openPath(v.trim())} />
        ) : (
          <Text wrap={wrapMode}>{open ? open.path : dir}</Text>
        )}
        {message ? <Text wrap={wrapMode}>{message}</Text> : null}
      </Box>
    )

    const asText = await read($, asTextAtom)
    const flipDiffFile = (k: string) => update($, diffOpenAtom, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k].slice(-50)))
    const pinnedNow = await read($, pinnedAtom)
    // a file's utilities: pin, copy its path, open it in VS Code or its own app
    const fileTools = (path: string) => {
      const isPinned = pinnedNow.some(p => p.toLowerCase() === path.toLowerCase())
      return [
        <Button key="pin" onPress={() => void update($, pinnedAtom, list => (isPinned ? list.filter(p => p.toLowerCase() !== path.toLowerCase()) : [path, ...list].slice(0, 20)))}>
          {isPinned ? '★ Unpin' : '☆ Pin'}
        </Button>,
        <Button key="copy" onPress={() => void $.ui.copy({ text: path, surface: e.surface }).then(() => say('Path copied.'))}>
          📋 Copy path
        </Button>,
        <Button key="vscode" onPress={() => void (async () => {
          // absolute only, so the path can't read as one of VS Code's options
          if (!/^([A-Za-z]:[\\/]|\\\\)/.test(path)) return say('VS Code opens absolute Windows paths only.')
          const code = await findVscode($)
          if (!code) return say("Couldn't find VS Code (its `code` command on PATH, or the usual install folders).")
          const r = await $.process.run([code.exe, code.cli, path], { env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, timeoutMs: 30_000 }).catch(() => null)
          await say(r?.exitCode === 0 ? 'Opened in VS Code.' : `VS Code didn't open it${r?.stderr ? `: ${r.stderr.split(/\r?\n/)[0]}` : '.'}`)
        })()}>
          Open in VS Code
        </Button>,
        <Button key="app" onPress={() => void $.process.run(['explorer.exe', path])}>
          ↗ Its app
        </Button>,
        <Button key="note" onPress={() => void (async () => {
          typed.delete(`note:${path}`)
          await update($, noteOpenAtom, v => (v === path ? '' : path))
        })()}>
          🗒 Note
        </Button>,
      ]
    }
    if (open && /\.(md|markdown)$/i.test(open.path) && !open.binary && !asText && open.size <= 4 * 1024 * 1024) {
      const f = open
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="back" onPress={() => void goDir(parent(f.path))}>
              ← Folder
            </Button>
            {Input ? (
              <Button key="as-text" onPress={() => void (async () => {
                await update($, asTextAtom, () => true)
                await openPath(f.path)
              })()}>
                Edit as text
              </Button>
            ) : null}
            <Button key="reveal" onPress={() => void $.process.run(['explorer.exe', `/select,${f.path}`])}>
              📂 Show in Explorer
            </Button>
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
        const k = `${HEIMDALL.test(f.path) ? 'probe3' : shell ? 'shell' : 'image'}|${f.path}|${f.size}|${f.mtimeMs}`
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
      const pic = now && typeof now !== 'string' ? (now as { w: number; h: number; via?: string }) : null
      const dims = !pic ? '' : shell ? (pic.via ? ` · preview by ${pic.via}` : '') : ` · ${pic.w}×${pic.h}`
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text wrap={wrapMode} dimColor>
            {sizeText(f.size)}
            {dims}
          </Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="back" onPress={() => void goDir(parent(f.path))}>
              ← Folder
            </Button>
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
            <Button key="reveal" onPress={() => void $.process.run(['explorer.exe', `/select,${f.path}`])}>
              📂 Show in Explorer
            </Button>
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
      const setBv = (next: Partial<BinView>) => update($, binViewAtom, () => ({ ...bv, ...next }))
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
            <Button key="back" onPress={() => void goDir(parent(f.path))}>
              ← Folder
            </Button>
            <Button key="reveal" onPress={() => void $.process.run(['explorer.exe', `/select,${f.path}`])}>
              📂 Show in Explorer
            </Button>
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
      const claudeStep = ours?.edit !== undefined && ours.edit < claudeSteps.length ? ours.edit : 0
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
            <Button key="back" onPress={() => void goDir(parent(f.path))}>
              ← Folder
            </Button>
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
            <Button key="reveal" onPress={() => void $.process.run(['explorer.exe', `/select,${f.path}`])}>
              📂 Show in Explorer
            </Button>
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

    let entries: { name: string; kind: string; size: number }[] = []
    let listError = ''
    try {
      step('listing the folder')
      entries = await $.fs.list(dir)
    } catch (err) {
      listError = err instanceof Error ? err.message : String(err)
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    step('reading pinned files')
    const pinned = await read($, pinnedAtom)
    const recent = await read($, recentAtom)
    // git state of this folder's entries (a folder: changed when anything under it is); only inside a repository
    const gitHere = new Map<string, string>()
    step('checking git')
    try {
      if (!(await repoOf($, dir))) throw new Error('not in a git repository')
      const r = await $.process.run(['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall', '--', '.'], { cwd: dir, timeoutMs: 10_000 })
      const top = (await $.process.run(['git', 'rev-parse', '--show-prefix'], { cwd: dir, timeoutMs: 5_000 })).stdout.trim()
      for (const l of r.stdout.split(/\r?\n/)) {
        if (l.length < 4) continue
        const relPath = l.slice(3).replace(/^"|"$/g, '')
        const inside = top && relPath.toLowerCase().startsWith(top.toLowerCase()) ? relPath.slice(top.length) : relPath
        const first = inside.split('/')[0]!.toLowerCase()
        const x = l.slice(0, 2)
        const st = x === '??' ? 'new' : x.includes('D') ? 'deleted' : 'changed'
        if (!gitHere.has(first) || st === 'changed') gitHere.set(first, inside.includes('/') ? 'changed' : st)
      }
    } catch {
      /* not a git folder */
    }
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="row" gap={1}>
          <Button key="up" onPress={() => void goDir(parent(dir))}>
            ↑ Up
          </Button>
          <Text wrap={wrapMode} dimColor>
            {listError ? `Can't list it: ${listError}` : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
          </Text>
        </Box>
        {pinned.length || recent.length ? (
          <Box flexDirection="column">
            {pinned.length ? <Text wrap={wrapMode} dimColor>Pinned</Text> : null}
            {pinned.map(p => (
              <Box key={`pinrow:${p}`} flexDirection="row" gap={1}>
                <Button key={`pin:${p}`} label={`⭐ ${p.split(/[\\/]/).pop()}`} plain onPress={() => void openPath(p)} />
                <Text wrap={wrapMode} dimColor>{parent(p)}</Text>
              </Box>
            ))}
            {recent.some(p => !pinned.includes(p)) ? <Text wrap={wrapMode} dimColor>Recently opened</Text> : null}
            {recent
              .filter(p => !pinned.includes(p))
              .slice(0, 5)
              .map(p => (
                <Box key={`recrow:${p}`} flexDirection="row" gap={1}>
                  <Button key={`rec:${p}`} label={`${kindOf(p)[0]} ${p.split(/[\\/]/).pop()}`} plain onPress={() => void openPath(p)} />
                  <Text wrap={wrapMode} dimColor>{parent(p)}</Text>
                </Box>
              ))}
            <Text wrap={wrapMode} dimColor>
              {dir}
            </Text>
          </Box>
        ) : null}
        <Box flexDirection="column">
          {entries.slice(0, limit).map(x => {
            const [icon, color] = x.kind === 'dir' ? ['📁', 'warning'] : kindOf(x.name)
            const g = gitHere.get(x.name.toLowerCase())
            return (
              <Box key={`row:${x.name}`} flexDirection="row" gap={1}>
                <Button key={`e:${x.name}`} label={`${icon} ${x.name}`} plain onPress={() => void (x.kind === 'dir' ? goDir(join(dir, x.name)) : openPath(join(dir, x.name)))} />
                {x.kind === 'file' ? <Text wrap={wrapMode} dimColor>{sizeText(x.size)}</Text> : null}
                {g ? <Text wrap={wrapMode} color={GIT_COLOR[g]}>● {g}</Text> : color && x.kind === 'file' ? <Text wrap={wrapMode} color={color}>●</Text> : null}
              </Box>
            )
          })}
        </Box>
        {entries.length > limit ? (
          <Button key="more" label={`Show ${Math.min(LIST, entries.length - limit)} more`} onPress={() => void update($, shownAtom, n => n + LIST)} />
        ) : null}
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
            await update($, viewAtom, () => 'files')
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
