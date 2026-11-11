import { expect, test } from 'claude-code/testing'
import { age, ageTone, blameRuns, branchesFrom, graphRows, lastCommitByFile, logFrom, releasesFrom, wordDiff } from '../hooks/project'

// The Files pane drawn as the desktop app draws it, in a folder like the one where it stayed blank
// (F:\GT racing IPAD: not a git repository, one links.txt). The engine's answers are this test's hooks.
const PANE = {
  plugin: 'file-pane',
  component: 'Pane',
  requestId: 'file-pane',
  props: {
    title: 'Files',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const CWD = 'F:\\GT racing IPAD'
const TABS = ['next', 'items', 'ticks', 'timeline', 'checks', 'log', 'search', 'backups', 'notes', 'features', 'blocks']
// three windows since 2026-11-11: Files (PANE), Git, Project
const GIT = { ...PANE, requestId: 'file-pane-git', props: { ...PANE.props, title: 'Git' } } as const
const PROJECT = { ...PANE, requestId: 'file-pane-project', props: { ...PANE.props, title: 'Project' } } as const
type Ui = { press: (q: { key: string }) => Promise<unknown>; find: (q: { key: string }) => Promise<unknown>; drawn: () => Promise<unknown> }
/** A Project tab: in the row, or after More; false when it hides here (Checks without a package.json). */
async function openTab(ui: Ui, t: string): Promise<boolean> {
  // on the dashboard (no tab row): its Items card's title opens a full page, which has the row
  if (!(await ui.find({ key: `tab:${t}` })) && (await ui.find({ key: 'card-go:items' }))) {
    await ui.press({ key: 'card-go:items' })
    for (let i = 0; i < 20 && !(await ui.find({ key: 'tab:overview' })); i++) await ui.drawn()
  }
  if (!(await ui.find({ key: `tab:${t}` })) && (await ui.find({ key: 'tab-more' }))) {
    await ui.press({ key: 'tab-more' })
    for (let i = 0; i < 20 && !(await ui.find({ key: `tab:${t}` })); i++) await ui.drawn()
  }
  if (!(await ui.find({ key: `tab:${t}` }))) return false
  await ui.press({ key: `tab:${t}` })
  for (let i = 0; i < 5; i++) await ui.drawn()
  return true
}
/** A folded section of the Git window opened (uncommitted, claude, branches). */
async function openSection(ui: Ui, key: string): Promise<void> {
  await ui.press({ key: `sec-btn:${key}` })
  for (let i = 0; i < 10; i++) await ui.drawn()
}

test('every view of the Files pane draws in a non-git folder with one file', async ($, on) => {
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({
    value: String(e.path ?? '').endsWith('IPAD') ? [
            { name: 'links.txt', kind: 'file', size: 805, mtimeMs: 1, isLink: false },
            { name: 'notes.md', kind: 'file', size: 60, mtimeMs: 1, isLink: false },
          ] : [],
  }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_, e) => ({
    value: /\.(txt|md)$/i.test(String(e.path)) ? { kind: 'file', size: 805, mtimeMs: 1, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_, e) => {
    if (/links\.txt$/i.test(String(e.path))) return { value: 'https://archive.org/details/gt-racing\n' }
    if (/notes\.md$/i.test(String(e.path))) return { value: '# Notes\n\n## To do\n\n- [ ] find the iPad build\n- [x] links saved\n' }
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const clean = async (where: string) => {
    const bad = await ui.find({ text: /couldn't draw/ })
    if (bad) throw new Error(`${where}: ${(await ui.findAll({ text: /./ })).map(x => x.text).join(' | ').slice(0, 600)}`)
  }

  // Files: the folder with its file
  await clean('files')
  expect(await ui.find({ type: 'Button', text: /links\.txt/ })).toBeDefined()

  // every Project tab, in the Project window (Checks hides: no package.json); the Git window says there's no repo
  const proj = await $.ui.mount({ ...PROJECT, surface: 'desktop' })
  const cleanIn = async (w: typeof proj, where: string) => {
    const bad = await w.find({ text: /couldn't draw/ })
    if (bad) throw new Error(`${where}: ${(await w.findAll({ text: /./ })).map(x => x.text).join(' | ').slice(0, 600)}`)
  }
  for (const t of TABS) {
    expect(await openTab(proj, t)).toBe(t !== 'checks')
    await cleanIn(proj, `project tab ${t}`)
  }
  const gitWin = await $.ui.mount({ ...GIT, surface: 'desktop' })
  await cleanIn(gitWin, 'git window')
  expect(await gitWin.find({ text: /isn't in a git repository/ })).toBeDefined()

  // open the file
  await ui.press({ key: 'e:links.txt' })
  await clean('the open file')
  expect(await ui.find({ type: 'Button', text: /Save/ })).toBeDefined()

  // ↩ Wrap: on by default, in the ⋯ menu (it stays open), flips off and back; every view still draws both ways
  await ui.press({ key: 'menu' })
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: on/)
  await ui.press({ key: 'wrap' })
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: off/)
  await clean('the open file, wrap off')
  // Wrap off: the file reads as numbered code, one row a line; ✎ Edit brings the (always wrapping) editor back
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ key: 'edit-wrapped' })).toBeDefined()
  await ui.press({ key: 'edit-wrapped' })
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: on/)
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'wrap' })
  for (const t of TABS) {
    await openTab(proj, t)
    await cleanIn(proj, `project tab ${t}, wrap off`)
  }
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: off/)
  await ui.press({ key: 'wrap' })
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: on/)

  // a Markdown file as a document: its checkboxes are buttons
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:notes.md' })
  await clean('the Markdown document')
  expect(await ui.find({ type: 'Button', text: /☐ find the iPad build/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /☑ links saved/ })).toBeDefined()
  await ui.unmount()
})

// Checklists: x of y per heading, a tick logged (heading path, time) with Undo, the ticks tool, Only open per
// section, ✎ Edit mode, a line of several boxes split; and the version / deploy line with a newer deploy waiting.
test('checklists: tick log, undo, counts, only open, edit mode, split; version line', async ($, on) => {
  const DIR = 'F:\\plans'
  const FILE = `${DIR}\\notes.md`
  let file = [
    '# Plan',
    '',
    '## Week 1',
    '',
    '### Mon',
    '- [ ] buy paint',
    '- [x] sand wall',
    '',
    '### Tue',
    '- [ ] a - [ ] b - [x] c',
    '',
    '## Week 2',
    '- [ ] rest',
    '',
  ].join('\n')
  const store = new Map<string, unknown>()
  const writes: string[] = []
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: DIR }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({ value: String(e.path ?? '') === DIR ? [{ name: 'notes.md', kind: 'file', size: 200, mtimeMs: 1, isLink: false }] : [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_, e) => ({ value: /\.md$/i.test(String(e.path)) ? { kind: 'file', size: file.length, mtimeMs: 1, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    const p = String(e.path)
    if (p === FILE) return { value: file }
    // the deploy this chat loaded (beside the mod) is older than the one now in ~/.claude/mods
    if (/deployed\.json$/i.test(p)) return { value: JSON.stringify({ version: '0.2.0', at: /[\\/]mods[\\/]file-pane[\\/]/i.test(p) ? '2026-11-03T12:00:00.000Z' : '2026-11-01T12:00:00.000Z' }) }
    throw new Error('ENOENT')
  })
  on('store.get', (_, e) => ({ value: store.get(String(e.key)) }))
  on('store.set', (_, e) => {
    store.set(String(e.key), e.value)
    return { value: undefined }
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [exe, , , cmd] = e.argv
    if (exe === 'node' && cmd === 'backup') return out('{"ok":true,"backup":"C:\\\\Users\\\\tester\\\\.claude\\\\file-pane-backups\\\\b"}')
    if (exe === 'node' && cmd === 'splice') {
      // the pane writes the whole file (start 0, end = size): take the new text as the file
      file = String(e.init?.stdin ?? '')
      writes.push(file)
      return out(`{"ok":true,"end":${file.length}}`)
    }
    return out('', 128)
  })
  const shows = async (re: RegExp) => {
    for (let i = 0; i < 20 && !(await ui.find({ text: re })); i++) await ui.drawn()
    return ui.find({ text: re })
  }
  const lineOf = (text: string) => file.split('\n').findIndex(l => l.includes(text))

  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'menu' }) // Wrap, Follow, Compact, version and Tools live in the ⋯ menu

  // the version line, and the newer deploy waiting for new chats
  expect(await shows(/Files pane v0\.2\.0 · deployed 2026-11-0[12]/)).toBeDefined()
  expect(await shows(/⬆ A newer pane was deployed 2026-11-0[34] .*: open a new chat/)).toBeDefined()

  await ui.press({ key: 'e:notes.md' })
  // x of y: the section, and each heading under it
  expect(await shows(/^1 of 3 done$/)).toBeDefined()
  expect(await shows(/^1 of 2 done$/)).toBeDefined()

  // tick: written (backup first), logged with where and when, Undo offered
  await ui.press({ key: `t:${FILE}#${lineOf('buy paint')}` })
  expect(await shows(/☑ Ticked just now: buy paint/)).toBeDefined()
  expect(file).toContain('- [x] buy paint')
  const log = store.get('ticks') as { item: string; headings: string[]; done: boolean }[]
  expect(log[0]).toMatchObject({ item: 'buy paint', headings: ['Plan', 'Week 1', 'Mon'], done: true })
  expect(await shows(/Ticked recently/)).toBeDefined()

  // an untick says so, and Undo puts the tick back
  await ui.press({ key: `t:${FILE}#${lineOf('sand wall')}` })
  expect(await shows(/☐ Unticked just now: sand wall/)).toBeDefined()
  expect(file).toContain('- [ ] sand wall')
  await ui.press({ key: 'tick-undo' })
  for (let i = 0; i < 20 && !file.includes('- [x] sand wall'); i++) await ui.drawn()
  expect(file).toContain('- [x] sand wall')

  // the ticks tool: newest first, filtered to the file
  const answer = await $.tool.call({ tool: 'mcp__file-pane__ticks', path: FILE })
  expect(String(answer.text)).toMatch(/ticked "sand wall" in .*notes\.md › Plan › Week 1 › Mon/)

  // Only open (per section): the done items of Week 1 hide
  const week1 = `${lineOf('## Week 1')}:Week 1`
  await ui.press({ key: `oo:${week1}` })
  for (let i = 0; i < 20 && (await ui.find({ type: 'Button', text: /^☑ sand wall$/ })); i++) await ui.drawn()
  expect(await ui.find({ type: 'Button', text: /^☑ sand wall$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^☐ rest$/ })).toBeDefined()
  await ui.press({ key: `oo:${week1}` })

  // several boxes on one line: warned, and split into one item each (their ticks kept)
  expect(await shows(/⚠ 3 boxes on one line/)).toBeDefined()
  await ui.press({ key: `split:${FILE}#${lineOf('a - [ ] b')}` })
  for (let i = 0; i < 20 && !file.includes('- [ ] b\n'); i++) await ui.drawn()
  expect(file).toContain('- [ ] a\n- [ ] b\n- [x] c\n')

  // ✎ Edit mode: no ✎ on every row until it's on; then a click edits the item instead of ticking it
  expect(await ui.find({ type: 'Button', text: /^✎ ☐ rest/ })).toBeUndefined()
  await ui.press({ key: 'edit-mode' })
  expect(await shows(/^✎ ☐ rest/)).toBeDefined()
  const before = writes.length
  await ui.press({ key: `t:${FILE}#${lineOf('rest')}` })
  expect(await ui.find({ key: `in:${FILE}#${lineOf('rest')}` })).toBeDefined()
  expect(writes.length).toBe(before)
  await ui.input({ key: `in:${FILE}#${lineOf('rest')}`, text: 'rest a lot' })
  for (let i = 0; i < 20 && !file.includes('rest a lot'); i++) await ui.drawn()
  expect(file).toContain('- [ ] rest a lot')

  // 📅 Done dates: a tick writes "(done <date time>)" after the item; the untick takes it off; the log keeps the bare item
  await ui.press({ key: 'edit-mode' })
  await ui.press({ key: 'tick-dates' })
  for (let i = 0; i < 20 && store.get('tickDates') !== true; i++) await ui.drawn()
  expect(store.get('tickDates')).toBe(true)
  await ui.press({ key: `t:${FILE}#${lineOf('rest a lot')}` })
  for (let i = 0; i < 20 && !/\(done \d{4}/.test(file); i++) await ui.drawn()
  expect(file).toMatch(/- \[x\] rest a lot \(done \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\n/)
  expect((store.get('ticks') as { item: string }[])[0]!.item).toBe('rest a lot')
  await ui.press({ key: `t:${FILE}#${lineOf('rest a lot')}` })
  for (let i = 0; i < 20 && file.includes('(done'); i++) await ui.drawn()
  expect(file).toContain('- [ ] rest a lot\n')

  // the Ticks tab: the log across files, by day, with the headings and the file
  const proj = await $.ui.mount({ ...PROJECT, surface: 'desktop' })
  await openTab(proj, 'ticks')
  expect(await proj.find({ text: /^Today \(/ })).toBeDefined()
  expect(await proj.find({ text: /☑ buy paint · Plan › Week 1 › Mon/ })).toBeDefined()
  expect(await proj.find({ text: /☐ unticked rest a lot · Plan › Week 2/ })).toBeDefined()
  expect(await proj.find({ type: 'Button', text: /notes\.md$/ })).toBeDefined()
  await ui.unmount()
})

// SECURITY.md findings 1 and 2: no cmd.exe for Open in VS Code or for removing the picture diff's temp file.
// A file name with cmd's own characters goes to VS Code's Code.exe + cli.js as one argv entry.
test('VS Code and the temp file go without cmd.exe; 3D models preview', async ($, on) => {
  const DIR = 'F:\\pics'
  const VS = 'C:\\Users\\tester\\AppData\\Local\\Programs\\Microsoft VS Code'
  const runs: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: DIR }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({
    value: String(e.path ?? '') === DIR ? [
            { name: 'a&calc.txt', kind: 'file', size: 4, mtimeMs: 1, isLink: false },
            { name: 'pic.png', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'ship.fbx', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'car.glb', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'boat.glb', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'ship.obj', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'Fish.dll', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'Fish.class', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'Old.class', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'mods.jar', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'big.zip', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
          ] : [],
  }))
  on('fs.exists', (_, e) => ({ value: String(e.path).startsWith(VS) }))
  on('fs.stat', (_, e) => ({
    value: /\.(txt|png|fbx|glb|obj|dll|cs|class|jar|zip)$/i.test(String(e.path)) ? { kind: 'file', size: 4, mtimeMs: 1, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_, e) => {
    if (/code\.cmd$/i.test(String(e.path))) return { value: '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\abc123\\resources\\app\\out\\cli.js" %*\r\n' }
    if (/\.txt$/i.test(String(e.path))) return { value: 'hi\n' }
    if (/\.obj$/i.test(String(e.path))) return { value: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' }
    if (/\.(png|fbx|glb)$/i.test(String(e.path))) return { value: '\u0089PNG\r\n\u001a\n\u0000\u0000' }
    if (/\.dll$/i.test(String(e.path))) return { value: 'MZ\u0090\u0000\u0003\u0000' }
    if (/\.class$/i.test(String(e.path))) return { value: 'Êþº¾\u0000\u0000' }
    if (/\.(jar|zip)$/i.test(String(e.path))) return { value: 'PK\u0003\u0004\u0000\u0000' }
    if (/\.cs$/i.test(String(e.path))) return { value: 'namespace Fish\n{\n  public class Fishy { }\n}\n' }
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, env: e.init?.env })
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // node -e <helper> <command> …
    const [exe, , , cmd] = e.argv
    if (exe === 'where.exe') return out(`${VS}\\bin\\code.cmd\r\n`)
    if (exe === 'git' && e.argv.includes('diff')) return out('diff --git a/a&calc.txt b/a&calc.txt\n--- a/a&calc.txt\n+++ b/a&calc.txt\n@@ -1 +1 @@\n-hello there\n+hi\n')
    if (exe === 'node') {
      // the helper's binary commands, answered as it answers them
      if (cmd === 'bininfo') return out(JSON.stringify({ size: 100, kind: 'Windows program or DLL (PE)', dotnet: true, pe: ['Kind: DLL, x64, .NET', 'Version info: FileVersion = 1.2.3.4'] }))
      if (cmd === 'strings') return out(JSON.stringify({ start: 0, end: 100, size: 100, lines: ['00000040  Fish.Patches.HaulFix'] }))
      if (cmd === 'hex') return out(JSON.stringify({ start: 0, end: 100, size: 100, lines: ['00000000  4d 5a 90 00  MZ..'] }))
      if (cmd === 'ilspy') return out(JSON.stringify({ ok: true, file: 'C:\\Users\\tester\\.claude\\file-pane-cache\\ilspy\\abc-Fish.dll.cs' }))
      // big.zip: over 300 files (a find box instead of buttons), one of them deep/wanted.cfg
      if (cmd === 'ziplist' && /big\.zip$/.test(String(e.argv[4]))) {
        const files = [...Array.from({ length: 320 }, (_, i) => ({ name: `data/f${i}.bin`, size: 10 })), { name: 'deep/wanted.cfg', size: 5 }]
        return out(JSON.stringify({ count: files.length, bytes: 3205, lines: files.map(z => `${z.size}  2026-11-03 14:47  ${z.name}`), files }))
      }
      // one changed file inside the jar, diffed against the last commit's
      if (cmd === 'zipentry') return out(JSON.stringify({ kind: 'javap', diff: '@@ -9 +9 @@ int haul();\n-       0: iconst_1\n+       0: iconst_7\n' }))
      if (cmd === 'ziplist') return out(JSON.stringify({ count: 2, bytes: 361, lines: ['         64  2026-11-03 14:47  META-INF/MANIFEST.MF', '        297  2026-11-03 14:47  Fish.class'], files: [{ name: 'META-INF/', size: 0 }, { name: 'META-INF/MANIFEST.MF', size: 64 }, { name: 'Fish.class', size: 297 }] }))
      // a file out of the jar (copied to the cache), and a DLL's C# diff (ILSpy on both copies)
      if (cmd === 'zipget') return out(JSON.stringify({ ok: true, file: 'C:\\Users\\tester\\.claude\\file-pane-cache\\zip\\ab12\\Fish.class' }))
      if (cmd === 'csdiff') return out(JSON.stringify({ diff: '@@ -1 +1 @@\n-  public int Haul() => 1;\n+  public int Haul() => 2;\n' }))
      // javap: the bytecode, or (with an older copy) its diff; Old.class only moved lines (debug info)
      if (cmd === 'javap' && e.argv.length > 6 && /Old\.class$/.test(String(e.argv[4]))) return out(JSON.stringify({ diff: '', debugDiff: '@@ -5 +5 @@ int haul();\n-      line 1: 0\n+      line 4: 0\n' }))
      if (cmd === 'javap') return out(JSON.stringify(e.argv.length > 6 ?{ diff: '@@ -9 +9 @@ int haul();\n-       0: iconst_1\n+       0: iconst_2\n' } : { text: 'public class Fish {\n  int haul();\n}\n', javap: 'C:\\Program Files\\Java\\jdk-21\\bin\\javap.exe' }))
      if (cmd === 'bindiff') return out(JSON.stringify({ same: false, oldSize: 235, newSize: 297, files: /\.jar$/.test(String(e.argv[5])) ? ['~ Fish.class  (235 → 297 bytes)', '+ notes.txt  (6 bytes)'] : null, text:'@@ -1 +1 @@\n-HaulOld\n+HaulNew\n', hex: ['@@ 62 bytes added at 0x9; everything after is the same, just moved @@', '+00000009  12 0a  ..'] }))
      // Heimdall3D's probe: renders boat.glb into the cache; car.glb fails (so Explorer's thumbnail is asked)
      if (cmd === 'probe') return out(JSON.stringify(/car\.glb$/.test(String(e.argv[4])) ? { error: "Heimdall3D couldn't render it: bad file" } : { ok: true, gpu: true, file: 'C:\\Users\\tester\\.claude\\file-pane-cache\\heimdall\\abc.png' }))
      // the preview cache: ship.obj's preview was drawn in an earlier chat; the rest are drawn now and kept
      if (cmd === 'pcache') return out(e.argv[4] === 'get' && /ship\.obj\|/.test(String(e.argv[6])) ? JSON.stringify({ value: { w: 2, h: 2, tw: 2, th: 2, b64: 'iVBORw0KGgo=', mime: 'jpeg', via: 'an earlier chat' } }) : '{}')
      return out(cmd === 'gitblob' || cmd === 'rmtemp' ? '{"ok":true}' : '{}')
    }
    if (exe === 'powershell.exe') {
      // the shell thumbnail: Heimdall's maker for .fbx; .glb's maker is refused (outside Program Files), nothing cached
      const script = String(e.argv[4] ?? '')
      if (script.includes('FilePaneShellThumb') && /car\.glb'/.test(script)) return out('{"error":"its thumbnail maker (gloss.dll) isn\'t under Program Files or Windows"}')
      if (script.includes('FilePaneShellThumb')) return out('{"w":1,"h":1,"tw":1,"th":1,"b64":"iVBORw0KGgo=","via":"heimdall3d_shell.dll"}')
      return out('{"w":1,"h":1,"tw":1,"th":1,"b64":"iVBORw0KGgo="}')
    }
    if (exe?.endsWith('Code.exe')) return out('')
    return out('', 128)
  })
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !ok(); i++) await ui.drawn()
    if (!ok()) throw new Error(`${what} never ran: ${runs.map(r => r.argv.filter((_, i) => i !== 2).slice(0, 4).join(' ')).join(' | ')}`)
  }

  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'menu' }) // Wrap, Follow, Compact, version and Tools live in the ⋯ menu

  // Open in VS Code: Code.exe with cli.js and the path, as code.cmd would, and no cmd.exe
  await ui.press({ key: 'e:a&calc.txt' })
  await ui.press({ key: 'file-more' }) // the file's rarer actions are under its ⋯
  await ui.press({ key: 'vscode' })
  await until(() => runs.some(r => r.argv[0]?.endsWith('Code.exe')), 'Code.exe')
  const code = runs.find(r => r.argv[0]?.endsWith('Code.exe'))!
  expect(code.argv).toEqual([`${VS}\\Code.exe`, `${VS}\\abc123\\resources\\app\\out\\cli.js`, `${DIR}\\a&calc.txt`])
  expect(code.env?.ELECTRON_RUN_AS_NODE).toBe('1')

  // a side-by-side diff draws wrapped (row by row, each before beside its after) and cut (two columns)
  await ui.press({ key: 'diff' })
  await ui.press({ key: 'side' })
  for (let i = 0; i < 20 && !(await ui.find({ text: /^- hello there$/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /^- hello there$/ })).toBeDefined()
  expect(await ui.find({ text: /^\+ hi$/ })).toBeDefined()
  await ui.press({ key: 'wrap' })
  expect(await ui.find({ text: /^- hello there$/ })).toBeDefined()
  expect(await ui.find({ text: /^\+ hi$/ })).toBeDefined()
  await ui.press({ key: 'wrap' })
  await ui.press({ key: 'side' })
  await ui.press({ key: 'diff' })

  // the picture at the last commit: its temp file is removed by the helper, only inside the cache folder
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:pic.png' })
  await ui.press({ key: 'diff' })
  await until(() => runs.some(r => r.argv[3] === 'rmtemp'), 'rmtemp')
  const rm = runs.find(r => r.argv[3] === 'rmtemp')!
  expect(rm.argv[0]).toBe('node')
  expect(rm.argv[4]).toBe('C:\\Users\\tester\\.claude\\file-pane-cache')
  expect(String(rm.argv[5])).toMatch(/^C:\\Users\\tester\\\.claude\\file-pane-cache\\last-commit-\d+\.png$/)

  // a 3D model previews through Explorer's thumbnail (Heimdall3D's here), and says what drew it
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:ship.fbx' })
  await until(() => runs.some(r => r.argv[0] === 'powershell.exe' && String(r.argv[4]).includes('FilePaneShellThumb')), 'the shell thumbnail')
  for (let i = 0; i < 20 && !(await ui.find({ text: /preview by heimdall3d_shell\.dll/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /preview by heimdall3d_shell\.dll/ })).toBeDefined()
  expect(await ui.find({ text: /couldn't draw|binary file/ })).toBeUndefined()

  // a thumbnail maker outside Program Files / Windows is refused, and the pane says so
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:car.glb' })
  for (let i = 0; i < 20 && !(await ui.find({ text: /No preview: .*Program Files/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /No preview: .*Program Files/ })).toBeDefined()
  expect(await ui.find({ text: /No preview: .*Heimdall3D couldn't render it: bad file/ })).toBeDefined()

  // a .glb: Heimdall3D's own still (the probe from Program Files, cached), drawn as a picture, and named
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:boat.glb' })
  for (let i = 0; i < 20 && !(await ui.find({ text: /preview by Heimdall3D \(heimdall_probe, GPU\)/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /preview by Heimdall3D \(heimdall_probe, GPU\)/ })).toBeDefined()
  const probe = runs.find(r => r.argv[3] === 'probe' && /boat\.glb$/.test(String(r.argv[4])))!
  expect(probe.argv.slice(5)).toEqual(['C:\\Users\\tester\\.claude\\file-pane-cache', 'C:\\Users\\tester'])
  expect(runs.some(r => r.argv[0] === 'powershell.exe' && String(r.argv[4]).includes("'C:\\Users\\tester\\.claude\\file-pane-cache\\heimdall\\abc.png'"))).toBe(true)
  // drawn once: kept on disk for other chats, and a redraw (Back and open again) runs nothing
  await until(() => runs.some(r => r.argv[3] === 'pcache' && r.argv[4] === 'put' && /boat\.glb\|/.test(String(r.argv[6]))), 'keeping the preview')
  const before = runs.length
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:boat.glb' })
  expect(await ui.find({ text: /preview by Heimdall3D/ })).toBeDefined()
  expect(runs.slice(before).filter(r => r.argv[0] === 'powershell.exe' || r.argv[3] === 'probe' || r.argv[3] === 'pcache')).toEqual([])
  // 🔍 Closer: the middle of the picture (the SVG's viewBox), 1.5× then 2× then back
  await ui.press({ key: 'zoom' })
  expect((await ui.find({ key: 'zoom' }))?.text).toMatch(/Closer \(1\.5×\)/)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toMatch(/viewBox="0\.2 0\.2 0\.7 0\.7"/)
  await ui.press({ key: 'zoom' })
  await ui.press({ key: 'zoom' })
  expect((await ui.find({ key: 'zoom' }))?.text).toMatch(/^🔍 Closer$/)

  // a preview drawn in an earlier chat comes from the disk cache: no PowerShell, a JPEG
  const beforeObj = runs.length
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:ship.obj' })
  for (let i = 0; i < 20 && !(await ui.find({ text: /preview by an earlier chat/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /preview by an earlier chat/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('data:image/jpeg;base64,')
  expect(runs.slice(beforeObj).filter(r => r.argv[0] === 'powershell.exe')).toEqual([])

  const shows = async (re: RegExp) => {
    for (let i = 0; i < 20 && !(await ui.find({ text: re })); i++) await ui.drawn()
    const found = await ui.find({ text: re })
    if (!found) throw new Error(`nothing shows ${re}`)
    return found
  }

  // a jar: the files inside (from its directory), and ± Diff against the last commit (readable text and hex)
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:mods.jar' })
  await ui.press({ key: 'bin-files' })
  expect(await shows(/^2 entries, .* unpacked/)).toBeDefined()
  // each file a button (a folder isn't): it's copied out to the cache and opened from there
  expect((await ui.find({ key: 'zf:2' }))?.text).toBe('📄 Fish.class · 297 B')
  expect(await ui.find({ key: 'zf:0' })).toBeUndefined()
  await ui.press({ key: 'zf:2' })
  expect(await shows(/Fish\.class from mods\.jar: a copy in the cache/)).toBeDefined()
  expect(runs.find(r => r.argv[3] === 'zipget')!.argv.slice(4)).toEqual([`${DIR}\\mods.jar`, 'Fish.class', 'C:\\Users\\tester\\.claude\\file-pane-cache'])
  await ui.press({ key: 'up' })
  // back to it through 🕘 Recent ▾ (the folder view lists no recent files since 0.4.8)
  await ui.press({ key: 'recent' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Button', text: /mods\.jar$/ })); i++) await ui.drawn()
  const jarRow = await ui.find({ type: 'Button', text: /mods\.jar$/ })
  await ui.press({ key: String(jarRow?.key) })
  await ui.press({ key: 'bin-diff' })
  expect(await shows(/Last commit 235 B → now 297 B/)).toBeDefined()
  // which files inside changed
  expect(await shows(/^~Fish\.class {2}\(235 → 297 bytes\)$/)).toBeDefined()
  expect((await ui.find({ key: 'zc:1' }))?.text).toBe('notes.txt  (6 bytes)')
  // a changed file's own diff: Fish.class inside the jar, by javap on both copies
  expect((await ui.find({ key: 'zc:0' }))?.text).toBe('Fish.class  (235 → 297 bytes)')
  await ui.press({ key: 'zc:0' })
  await until(() => runs.some(r => r.argv[3] === 'zipentry'), 'the diff of a file inside the jar')
  expect(await shows(/^Fish\.class: bytecode \(javap -c -p\)$/)).toBeDefined()
  expect(await shows(/iconst_7/)).toBeDefined()
  const ze = runs.find(r => r.argv[3] === 'zipentry')!
  expect(String(ze.argv[4])).toMatch(/file-pane-cache\\last-commit-\d+\.jar$/)
  expect(ze.argv.slice(5)).toEqual([`${DIR}\\mods.jar`, 'Fish.class', 'C:\\Users\\tester\\.claude\\file-pane-cache', 'C:\\Users\\tester'])
  expect(await shows(/HaulNew/)).toBeDefined()
  expect(await shows(/62 bytes added at 0x9/)).toBeDefined()
  await ui.press({ key: 'side' })
  expect(await shows(/^\+ HaulNew$/)).toBeDefined()
  await ui.press({ key: 'side' })
  const bindiff = runs.find(r => r.argv[3] === 'bindiff')!
  expect(String(bindiff.argv[4])).toMatch(/file-pane-cache\\last-commit-\d+\.jar$/)
  expect(bindiff.argv[5]).toBe(`${DIR}\\mods.jar`)
  await until(() => runs.some(r => r.argv[3] === 'rmtemp' && /\.jar$/.test(String(r.argv[5]))), 'removing the jar temp copy')

  // a zip of over 300 files: no buttons until a find narrows it, then each match is one
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:big.zip' })
  await ui.press({ key: 'bin-files' })
  expect(await shows(/^321 entries/)).toBeDefined()
  expect(await ui.find({ key: 'zf:0' })).toBeUndefined()
  await ui.input({ key: 'zip-find', text: 'wanted' })
  for (let i = 0; i < 20 && !(await ui.find({ key: 'zf:0' })); i++) await ui.drawn()
  expect((await ui.find({ key: 'zf:0' }))?.text).toBe('📄 deep/wanted.cfg · 5 B')
  expect(await ui.find({ key: 'zf:1' })).toBeUndefined()
  expect(await shows(/^1 match "wanted"$/)).toBeDefined()

  // a class: its bytecode through javap, and the bytecode diff (javap on both copies)
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:Fish.class' })
  await ui.press({ key: 'bin-java' })
  expect(await shows(/public class Fish/)).toBeDefined()
  expect(await shows(/by C:\\Program Files\\Java\\jdk-21\\bin\\javap\.exe/)).toBeDefined()
  await ui.press({ key: 'bin-diff' })
  expect(await shows(/iconst_2/)).toBeDefined()
  const javapDiff = runs.find(r => r.argv[3] === 'javap' && r.argv.length > 6)!
  expect(javapDiff.argv[4]).toBe(`${DIR}\\Fish.class`)
  expect(String(javapDiff.argv[6])).toMatch(/last-commit-\d+\.class$/)

  // a class whose bytecode is the same: what moved in its debug info (javap -l)
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:Old.class' })
  await ui.press({ key: 'bin-diff' })
  expect(await shows(/^Debug info \(javap -l/)).toBeDefined()
  expect(await shows(/line 4: 0/)).toBeDefined()

  // a DLL: what it is (PE info), its readable text, its bytes, and C# through ILSpy (opened as a file)
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:Fish.dll' })
  expect(await shows(/FileVersion = 1\.2\.3\.4/)).toBeDefined()
  expect(await ui.find({ text: /binary file/ })).toBeUndefined()
  await ui.press({ key: 'bin-text' })
  expect(await shows(/Fish\.Patches\.HaulFix/)).toBeDefined()
  await ui.press({ key: 'bin-hex' })
  expect(await shows(/4d 5a 90 00/)).toBeDefined()
  await ui.press({ key: 'wrap' })
  expect(await shows(/4d 5a 90 00/)).toBeDefined()
  await ui.press({ key: 'wrap' })
  // its C# against the last commit's: ILSpy on both copies, on a press
  await ui.press({ key: 'bin-diff' })
  await ui.press({ key: 'bin-csdiff' })
  await until(() => runs.some(r => r.argv[3] === 'csdiff'), 'the C# diff')
  expect(await shows(/Haul\(\) => 2/)).toBeDefined()
  const csd = runs.find(r => r.argv[3] === 'csdiff')!
  expect(String(csd.argv[4])).toMatch(/file-pane-cache\\last-commit-\d+\.dll$/)
  expect(csd.argv.slice(5)).toEqual([`${DIR}\\Fish.dll`, 'C:\\Users\\tester\\.claude\\file-pane-cache'])
  await ui.press({ key: 'bin-info' })
  await ui.press({ key: 'bin-cs' })
  expect(await shows(/C# of Fish\.dll by ILSpy/)).toBeDefined()
  expect(runs.some(r => r.argv[3] === 'ilspy' && String(r.argv[5]).endsWith('file-pane-cache'))).toBe(true)

  expect(runs.filter(r => /cmd(\.exe)?$/i.test(r.argv[0] ?? '')).map(r => r.argv.join(' '))).toEqual([])
  await ui.unmount()
})

// Better diffs: Claude's own change (a copy made before its first Edit), against the newest backup or the last commit,
// ␣ Ignore spaces, the words that changed, and Put back for Claude's edits (current version backed up first).
test('diffs: Claude\'s change, vs backup / commit, ignore spaces, word highlights, put back', async ($, on) => {
  const DIR = 'F:\\proj'
  const FILE = `${DIR}\\app.ts`
  const BEFORE = 'C:\\Users\\tester\\.claude\\file-pane-backups\\2026-11-03T20-00-00-000Z-app.ts'
  const runs: (readonly string[])[] = []
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('tool.call', () => ({ result: 'edited', text: 'edited' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: DIR }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({
    value: String(e.path ?? '') === DIR ? [{ name: 'app.ts', kind: 'file', size: 20, mtimeMs: 1, isLink: false }, { name: 'notes.ts', kind: 'file', size: 20, mtimeMs: 1, isLink: false }] : [],
  }))
  on('fs.exists', (_, e) => ({ value: /[\\/]\.git$/.test(String(e.path)) })) // a repository, so the Git window draws
  on('fs.stat', (_, e) => ({ value: /\.ts$/i.test(String(e.path)) ? { kind: 'file', size: 20, mtimeMs: 1, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    if (String(e.path) === FILE) return { value: 'const speed = 2\n' }
    if (String(e.path) === `${DIR}\\notes.ts`) return { value: 'const speed = 3\n' }
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [exe, , , cmd] = e.argv
    const n = runs.filter(r => r[3] === 'backup').length
    if (exe === 'node' && cmd === 'backup') return out(JSON.stringify({ ok: true, backup: n === 1 ? BEFORE : `C:\\Users\\tester\\.claude\\file-pane-backups\\now${n}-app.ts` }))
    if (exe === 'node' && cmd === 'restore') return out('{"ok":true}')
    if (exe === 'git' && e.argv.includes('diff')) return out('@@ -1 +1 @@\n-const speed = 1\n+const speed = 2\n', e.argv.includes('--no-index') ? 1 : 0)
    return out('', 128)
  })
  const shows = async (re: RegExp) => {
    for (let i = 0; i < 20 && !(await ui.find({ text: re })); i++) await ui.drawn()
    return ui.find({ text: re })
  }
  const lastDiff = () => [...runs].reverse().find(r => r[0] === 'git' && r.includes('diff')) ?? []

  // the words that changed, as the side-by-side view highlights them
  expect(wordDiff('const speed = 1', 'const speed = 2')).toEqual({
    left: [{ text: 'const speed = ', changed: false }, { text: '1', changed: true }],
    right: [{ text: 'const speed = ', changed: false }, { text: '2', changed: true }],
  })

  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true })
  // Claude edits the file: a copy is made before each edit (the first one is "before Claude's edits")
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: '1', new_string: '2' })
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'x', new_string: 'y' })
  expect(runs.filter(r => r[3] === 'backup').map(r => r[4])).toEqual([FILE, FILE])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // the Git window → Claude's edits: ± Claude's change opens the file (in the Files window) with its diff against that copy
  await ui.press({ key: 'menu' }) // the diff options (side by side, ignore spaces) are in ⋯
  const gitWin = await $.ui.mount({ ...GIT, surface: 'desktop' })
  await openSection(gitWin, 'claude')
  await gitWin.press({ key: 'cl:changes:app.ts' })
  expect(await shows(/Compared with the file before Claude's first edit/)).toBeDefined()
  for (let i = 0; i < 20 && !lastDiff().includes('--no-index'); i++) await ui.drawn()
  expect(lastDiff().slice(-3)).toEqual(['--', BEFORE, FILE])

  // side by side: each line beside its pair
  await ui.press({ key: 'side' })
  expect(await shows(/^- const speed = 1$/)).toBeDefined()
  expect(await shows(/^\+ const speed = 2$/)).toBeDefined()

  // ␣ Ignore spaces: git leaves out space-only changes
  await ui.press({ key: 'ws' })
  for (let i = 0; i < 20 && !lastDiff().includes('--ignore-all-space'); i++) await ui.drawn()
  expect(lastDiff()).toContain('--ignore-blank-lines')

  // vs last commit, and back to Claude's change
  await ui.press({ key: 'base-commit' })
  expect(await shows(/Compared with the last commit/)).toBeDefined()
  for (let i = 0; i < 20 && !lastDiff().includes('HEAD'); i++) await ui.drawn()
  expect(lastDiff()).toContain('HEAD')
  await ui.press({ key: 'base-claude' })

  // Put back: the current version is backed up, then the copy from before Claude's edits is restored
  await ui.press({ key: 'claude-putback' })
  for (let i = 0; i < 20 && !runs.some(r => r[3] === 'restore'); i++) await ui.drawn()
  expect(runs.find(r => r[3] === 'restore')!.slice(4)).toEqual([BEFORE, FILE])
  expect(runs.filter(r => r[3] === 'backup').length).toBe(3)
  // the current version's copy is now the newest backup (the copies before Claude's edits aren't listed there)
  await ui.press({ key: 'base-backup' })
  expect(await shows(/Compared with the backup from/)).toBeDefined()
  expect(await ui.find({ key: 'bk:0' })).toBeUndefined()

  // with two backups, any of them: the older one picked compares with it
  const BK = (n: number) => `C:\\Users\\tester\\.claude\\file-pane-backups\\now${n}-app.ts`
  await ui.press({ key: 'base-claude' })
  await ui.press({ key: 'claude-putback' })
  for (let i = 0; i < 20 && runs.filter(r => r[3] === 'backup').length < 4; i++) await ui.drawn()
  await ui.press({ key: 'base-backup' })
  for (let i = 0; i < 20 && !(await ui.find({ key: 'bk:1' })); i++) await ui.drawn()
  await ui.press({ key: 'bk:1' })
  for (let i = 0; i < 20 && !lastDiff().some(a => /now3-app\.ts$/.test(a)); i++) await ui.drawn()
  expect(lastDiff().slice(-3)).toEqual(['--', BK(3), FILE])
  // two backups against each other: the picked one against the newer, not the file now
  await ui.press({ key: 'vs:0' })
  expect(await shows(/against the backup from .* instead of the file now/)).toBeDefined()
  for (let i = 0; i < 20 && lastDiff().at(-1) !== BK(4); i++) await ui.drawn()
  expect(lastDiff().slice(-3)).toEqual(['--', BK(3), BK(4)])
  await ui.press({ key: 'vs:now' })

  // Claude's change from its second edit on (the copy made before that edit), and Put back for just that part
  await ui.press({ key: 'base-claude' })
  expect((await ui.find({ key: 'ce:0' }))?.text).toBe('all 2 edits')
  expect((await ui.find({ key: 'ce:1' }))?.text).toMatch(/^from edit 2 · /)
  await ui.press({ key: 'ce:1' })
  expect(await shows(/Compared with the file before Claude's edit 2 of 2/)).toBeDefined()
  for (let i = 0; i < 20 && lastDiff().at(-2) !== BK(2); i++) await ui.drawn()
  expect(lastDiff().slice(-3)).toEqual(['--', BK(2), FILE])
  expect((await ui.find({ key: 'claude-putback' }))?.text).toBe('↩ Put back (undo edit 2 and later)')

  // vs another file: the one opened before this one
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:notes.ts' })
  await ui.press({ key: 'up' })
  await ui.press({ key: 'e:app.ts' })
  expect((await ui.find({ key: 'base-other' }))?.text).toBe('vs notes.ts')
  await ui.press({ key: 'base-other' })
  expect(await shows(/Compared with F:\\proj\\notes\.ts \(the file opened before this one\)/)).toBeDefined()
  for (let i = 0; i < 20 && lastDiff().at(-2) !== `${DIR}\\notes.ts`; i++) await ui.drawn()
  expect(lastDiff().slice(-3)).toEqual(['--', `${DIR}\\notes.ts`, FILE])
  await ui.unmount()
})

// 👁 Follow Claude, the conflict warning, Claude's show / backups / notes tools, /files <tab | path>, the tools line,
// breadcrumbs, folder sort and find, file tabs, # Line numbers and ▤ Compact.
test('follow Claude, conflicts, agent tools, /files, tools line, folder and diff UI', async ($, on) => {
  const DIR = 'F:\\work'
  const A = `${DIR}\\a.ts`
  const B = `${DIR}\\b.ts`
  const files = new Map<string, string>([
    [A, 'one\n'],
    [B, 'x\n'],
  ])
  const runs: (readonly string[])[] = []
  const store = new Map<string, unknown>([['notes', { [A]: { text: 'careful: generated', at: 5 } }]])
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  // Claude's Edit: the file changes on disk (the pane's Edit hook sits above this)
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit' && e.file_path === A) files.set(A, `${files.get(A)}edited\n`)
    return { result: 'edited', text: 'edited' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: DIR }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({
    value:
      String(e.path ?? '') === DIR
        ? [
            { name: 'a.ts', kind: 'file', size: 4, mtimeMs: 100, isLink: false },
            { name: 'big.log', kind: 'file', size: 900, mtimeMs: 50, isLink: false },
            { name: 'b.ts', kind: 'file', size: 2, mtimeMs: 300, isLink: false },
            { name: 'src', kind: 'dir', size: 0, mtimeMs: 10, isLink: false },
          ]
        : [],
  }))
  on('fs.exists', (_, e) => ({ value: /heimdall_probe\.exe$/i.test(String(e.path)) }))
  on('fs.stat', (_, e) => {
    const t = files.get(String(e.path))
    return { value: t !== undefined ? { kind: 'file', size: t.length, mtimeMs: t.length, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const t = files.get(String(e.path))
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('store.get', (_, e) => ({ value: store.get(String(e.key)) }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [exe, , , cmd] = e.argv
    if (exe === 'node' && e.argv[1] === '--version') return out('v24.0.0\n')
    if (exe === 'node' && cmd === 'backup') return out(JSON.stringify({ ok: true, backup: `C:\\Users\\tester\\.claude\\file-pane-backups\\b${runs.length}-a.ts` }))
    if (exe === 'git' && e.argv.includes('diff')) return out('@@ -3,2 +3,2 @@\n ctx\n-old\n+new\n', e.argv.includes('--no-index') ? 1 : 0)
    return out('', 128)
  })
  const shows = async (re: RegExp) => {
    for (let i = 0; i < 20 && !(await ui.find({ text: re })); i++) await ui.drawn()
    const found = await ui.find({ text: re })
    if (!found) throw new Error(`nothing shows ${re}`)
    return found
  }

  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'menu' }) // Wrap, Follow, Compact, version and Tools live in the ⋯ menu

  // the tools line: found ones ticked, a missing one says what it's for
  expect(await shows(/^Tools: ✓ Node · ✗ git · ✗ javap · ✗ ILSpy · ✓ Heimdall3D · ✗ Everything \(missing: git for diffs/)).toBeDefined()

  // breadcrumbs, sort, find in the folder
  expect((await ui.find({ key: 'bc:0' }))?.text).toBe('F:')
  expect((await ui.find({ key: 'bc:1' }))?.text).toBe('work')
  // the table's header sorts: Modified, newest first
  await ui.press({ key: 'sort:date' })
  expect((await ui.find({ key: 'sort:date' }))?.text).toBe('Modified ▾')
  // 🔎 in the bar opens the find box (a small folder doesn't show it by itself)
  await ui.press({ key: 'find-toggle' })
  await ui.input({ key: 'folder-find', text: 'b.' })
  expect(await shows(/^1 of 4 match "b\."$/)).toBeDefined()
  expect(await ui.find({ key: 'e:a.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'e:b.ts' })).toBeDefined()
  await ui.press({ key: 'find-clear' })
  expect(await ui.find({ key: 'e:a.ts' })).toBeDefined()

  // 👁 Follow Claude (on by default): an edit opens the file with that edit's diff
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'one', new_string: 'one' })
  expect(await shows(/Compared with the file before Claude's first edit/)).toBeDefined()
  expect(runs.some(r => r[0] === 'git' && r.includes('--no-index') && r.at(-1) === A)).toBe(true)
  // # Line numbers: each diff line with its old and new line number
  await ui.press({ key: 'linenos' })
  expect(await shows(/^ {4}3 {5}3 {2}ctx$/)).toBeDefined()
  expect(await shows(/^ {4}4 {7}-old$/)).toBeDefined()
  await ui.press({ key: 'linenos' })

  // a conflict: typing kept in the editor, then Claude edits the same file: a warning, and the typing stays
  await ui.input({ key: `edit:${A}|0`, text: 'mine\n' })
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'edited', new_string: 'edited' })
  expect(await shows(/^⚠ Claude edited a\.ts at .* while you had unsaved typing for it here/)).toBeDefined()
  await ui.press({ key: 'conflict-ok' })
  for (let i = 0; i < 20 && (await ui.find({ key: 'conflict-ok' })); i++) await ui.drawn()
  expect(await ui.find({ key: 'conflict-ok' })).toBeUndefined()

  // Claude's tools: show a file with its diff and one line; its backups; the person's notes
  const shown = await $.tool.call({ tool: 'mcp__file-pane__show', path: B, diff: 'commit', line: 1 })
  expect(JSON.stringify(shown)).toContain('Pointed at line 1')
  expect(await shows(/^Claude points at line 1: x$/)).toBeDefined()
  expect(await shows(/Compared with the last commit/)).toBeDefined()
  const backups = await $.tool.call({ tool: 'mcp__file-pane__backups', path: DIR })
  expect(JSON.stringify(backups)).toContain("before one of Claude's edits")
  const notes = await $.tool.call({ tool: 'mcp__file-pane__notes', path: DIR })
  expect(JSON.stringify(notes)).toContain('careful: generated')

  // the files opened lately: no row of tabs (0.4.9), they're in 🕘 Recent ▾, newest first
  expect(await ui.find({ key: 'ft:0' })).toBeUndefined()
  await ui.press({ key: 'recent' })
  for (let i = 0; i < 20 && !(await ui.find({ key: 'recent:0' })); i++) await ui.drawn()
  expect((await ui.find({ key: 'recent:0' }))?.text).toMatch(/b\.ts$/)
  expect((await ui.find({ key: 'recent:1' }))?.text).toMatch(/a\.ts$/)
  await ui.press({ key: 'recent' })

  // ▤ Compact: shorter labels
  await ui.press({ key: 'file-more' })
  await ui.press({ key: 'compact' })
  expect((await ui.find({ key: 'copy' }))?.text).toBe('📋')
  await ui.press({ key: 'compact' })

  // /files ticks opens that Project tab; /files <path> opens a file (typed at the prompt)
  const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
  expect(JSON.stringify(await $.command.run({ command: 'files', args: 'ticks', ...RUN }))).toContain('Project window opened at ticks')
  expect(JSON.stringify(await $.command.run({ command: 'files', args: 'a.ts', ...RUN }))).toContain(`Opened ${A.replace(/\\/g, '\\\\')}`)
  await ui.unmount()
})

test('timeline: each version says what it changed', async () => {
  const v = releasesFrom(
    [
      '# Changelog',
      '## v0.2.5 (2026-11-03)',
      '- **What’s new:** click the version for every version,',
      '  newest first.',
      '  - a sub-point left out',
      '- **Sidebar:** the `version` shows.',
      '## v0.2.0 (2026-11-01, release candidate)',
      '### Replaced mods and collections',
      '- **Problems → Replaced**: outdated mods.',
      '### Minecraft packs',
      '## v0.1.0 — first release (2026-10-13)',
      '- First',
      '- Second point with no bold lead. More words.',
      '- Third', '- Fourth', '- Fifth',
    ].join('\r\n'),
  )
  expect(v.map(x => [x.text, x.date])).toEqual([['v0.2.5', '2026-11-03'], ['v0.2.0', '2026-11-01'], ['v0.1.0 — first release', '2026-10-13']])
  expect(v[0]!.summary).toBe('What’s new; Sidebar')
  expect(v[0]!.points).toEqual(['What’s new: click the version for every version, newest first.', 'Sidebar: the version shows.'])
  // sections name a big version
  expect(v[1]!.summary).toBe('Replaced mods and collections; Minecraft packs')
  expect(v[2]!.summary).toBe('First; Second point with no bold lead; Third; Fourth; +1 more')
})

// A repo with 347 changed files (ModKeeper's) hung the desktop pane on Git, and 180 still did: at most 50 rows are
// drawn, as a folder tree (folded) or a list in pages, with kinds, sorting, 🔎 find and + / − lines
test('git: a long list of changed files: folders, pages, kinds, sort, find, line counts', async ($, on) => {
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'F:\\big-repo' }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: /[\\/]\.git$/.test(String(e.path)) }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  // 150 files in three folders: even ones new, odd ones changed (i lines added, 1 removed), every 25th deleted
  const DIRS = ['src/ui', 'src/utils', 'docs']
  const file = (i: number) => `${DIRS[i % 3]}/File${i}.tsx`
  const code = (i: number) => (i % 25 === 0 ? ' D' : i % 2 ? ' M' : '??')
  const status = Array.from({ length: 150 }, (_, i) => `${code(i)} ${file(i)}`).join('\n')
  const numstat = Array.from({ length: 150 }, (_, i) => i)
    .filter(i => code(i) !== '??')
    .map(i => `${code(i) === ' D' ? 0 : i}\t${code(i) === ' D' ? 7 : 1}\t${file(i)}`)
    .join('\n')
  let counted: string[] = []
  on('process.run', (_, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git' && e.argv.includes('status')) return out(status)
    if (e.argv[0] === 'git' && e.argv.includes('--numstat')) return out(numstat)
    if (e.argv[0] === 'git' && e.argv.includes('rev-parse')) return out('main\n')
    if (e.argv[0] === 'node' && e.argv[3] === 'lines') {
      counted = JSON.parse(String(e.init?.stdin ?? '[]')) as string[]
      return out(JSON.stringify({ ok: true, counts: Object.fromEntries(counted.map(p => [p, 10])) }))
    }
    return out('')
  })
  await $.session.start({ cwd: 'F:\\big-repo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...GIT, surface: 'desktop' })
  // the buttons' handlers are async (not awaited by ui.press): wait for the redraw
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await ok()); i++) await ui.drawn()
  }
  const button = async (re: RegExp) => !!(await ui.find({ type: 'Button', text: re }))
  const fileButtons = async () => (await ui.findAll({ type: 'Button', text: /File\d+\.tsx$/ })).length
  await openSection(ui, 'uncommitted')
  await until(() => button(/📁 docs\/$/))

  // the summary, the new files counted by the helper, folders folded, src/ui and src/utils under src
  expect(await ui.find({ text: /^On main · 150 files: 72 changed, 72 new, 6 deleted · \+\d[\d,]* −\d+ lines$/ })).toBeDefined()
  expect(counted.length).toBe(72)
  expect(await button(/^▸ 📁 docs\/$/)).toBe(true)
  expect(await button(/^▸ 📁 src\/$/)).toBe(true)
  expect(await fileButtons()).toBe(0)
  expect(await ui.find({ text: /^50 files · \+\d[\d,]* −\d+$/ })).toBeDefined()
  // unfold docs: its 50 files, then the row limit's note
  await ui.press({ key: 'dir:docs/' })
  await until(async () => (await fileButtons()) > 0)
  expect(await button(/^▾ 📁 docs\/$/)).toBe(true)
  expect(await fileButtons()).toBeLessThanOrEqual(50)
  expect(await ui.find({ text: /^Showing the first 50 rows/ })).toBeDefined()
  // columns: Kind, Lines
  expect(await ui.find({ text: /^● new$/ })).toBeDefined()
  expect(await ui.find({ text: /^\+10 −0$/ })).toBeDefined()
  expect(await ui.find({ text: /^● deleted$/ })).toBeDefined()
  expect(await ui.find({ text: /^\+0 −7$/ })).toBeDefined()

  // ☰ List: pages of 50
  await ui.press({ key: 'ch-folders' })
  await until(() => button(/^☰ List$/))
  expect(await fileButtons()).toBe(50)
  expect(await ui.find({ text: /^Page 1 of 3 · 1-50 of 150$/ })).toBeDefined()
  await ui.press({ key: 'ch-next' })
  await until(async () => !!(await ui.find({ text: /^Page 2 of 3/ })))
  expect(await ui.find({ text: /^Page 2 of 3 · 51-100 of 150$/ })).toBeDefined()

  // New only, then 🔎 find within them, then most lines first among the changed
  await ui.press({ key: 'ch-kind:new' })
  await until(async () => !!(await ui.find({ text: /^72 of 150 match · new only$/ })))
  expect(await ui.find({ text: /^Page 1 of 2/ })).toBeDefined()
  await ui.input({ key: 'ch-find', text: 'utils/File1' })
  await until(async () => !!(await ui.find({ text: /match "utils\/file1"/ })))
  expect(await button(/^▸ 📜 src\/utils\/File10\.tsx$/) || (await fileButtons()) > 0).toBe(true)
  expect(await ui.find({ text: /^Page/ })).toBeUndefined()
  await ui.press({ key: 'ch-find-clear' })
  await ui.press({ key: 'ch-kind:changed' })
  // ↕ one sort button: Path → Recently edited → Most lines
  await ui.press({ key: 'ch-sort' })
  await until(async () => (await ui.find({ key: 'ch-sort' }))?.text === '↕ Recently edited')
  await ui.press({ key: 'ch-sort' })
  await until(async () => (await ui.findAll({ type: 'Button', text: /File\d+\.tsx$/ }))[0]?.text?.endsWith('File149.tsx') ?? false)
  expect((await ui.findAll({ type: 'Button', text: /File\d+\.tsx$/ }))[0]?.text).toMatch(/File149\.tsx$/)

  // folded and open again: the section keeps working
  await openSection(ui, 'uncommitted')
  await until(async () => (await fileButtons()) === 0)
  expect(await fileButtons()).toBe(0)
  await openSection(ui, 'uncommitted')
  await until(async () => (await fileButtons()) > 0)
  expect(await fileButtons()).toBeGreaterThan(0)
})

// 📜 Log's 2 s redraw timer ends itself once the Log tab isn't drawn (Files view, pane closed): no timer left running
test('log: the follow timer stops once the Log tab is left', async ($, on) => {
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  let periods = 0
  on('clock.every', () => {
    periods++
    return { value: undefined }
  })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const proj = await $.ui.mount({ ...PROJECT, surface: 'desktop' })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await ui.drawn()
  }
  await openTab(proj, 'log')
  for (let i = 0; i < 20; i++) await proj.drawn()
  expect(periods).toBeGreaterThan(0)
  // still following while the Log tab is drawn
  const before = periods
  for (let i = 0; i < 20; i++) await proj.drawn()
  expect(periods).toBeGreaterThan(before)
  // the Project window closed, and 20 s later: the next period ends the timer, and no more come
  await proj.unmount()
  now += 20_000
  await settle()
  const stopped = periods
  await settle()
  expect(periods).toBe(stopped)
})

// Round 1 of the 2026-11-11 UI pass: the top bar (← → ↑, the path as buttons, ⋯), 👁 Follow Claude on by default for
// reads too (with the lines read shown), never over unsaved typing, off from ⋯ for every chat; pictures ◀ ▶
test('top bar: back / forward, follow Claude reads, picture steps', async ($, on) => {
  const DIR = 'F:\\pics'
  const TXT = 'F:\\pics\\notes.txt'
  const files = new Map<string, string>([[TXT, 'one\ntwo\nthree\nfour\nfive\n']])
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('tool.call', () => ({ result: 'read', text: 'read' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: DIR }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({
    value: String(e.path) === DIR
      ? [
          { name: 'a.png', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
          { name: 'b.png', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
          { name: 'notes.txt', kind: 'file', size: 24, mtimeMs: 1, isLink: false },
          { name: 'sub', kind: 'dir', size: 0, mtimeMs: 1, isLink: false },
        ]
      : String(e.path).endsWith('sub')
        ? [{ name: 'inner.txt', kind: 'file', size: 7, mtimeMs: 1, isLink: false }]
        : [],
  }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', (_, e) => ({ value: /\.(txt|png)$/i.test(String(e.path)) ? { kind: 'file', size: /\.txt$/i.test(String(e.path)) ? 24 : 100, mtimeMs: 1, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    if (/\.png$/i.test(String(e.path))) return { value: 'PNG\u0000' } // a picture is binary
    const v = files.get(String(e.path))
    if (v === undefined) throw new Error('ENOENT')
    return { value: v }
  })
  on('store.get', (_, e) => ({ value: store.get(String(e.key)) }))
  on('store.set', (_, e) => {
    store.set(String(e.key), e.value)
    return { value: undefined }
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    // the helper's folder sizes: each folder holds 2 KB
    if (e.argv[3] === 'dirsizes')
      return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, sizes: Object.fromEntries(e.argv.slice(4).map(d => [d, { bytes: 2048, files: 1, partial: false }])) }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '{"error":"no pictures in a test"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 30 && !(await ok()); i++) await ui.drawn()
  }
  const has = async (key: string) => !!(await ui.find({ key }))
  const sizes = () => runs.filter(r => r[3] === 'dirsizes').length

  // the folder as a tree: sub's size is counted once (kept), its ▸ opens it in place with its file under it
  await until(async () => !!(await ui.find({ text: /^2(\.0)? KB$/ })))
  expect(await ui.find({ text: /^2(\.0)? KB$/ })).toBeDefined()
  expect(sizes()).toBe(1)
  await ui.press({ key: 'tg:sub' })
  await until(() => has('e:sub/inner.txt'))
  expect(await has('e:sub/inner.txt')).toBe(true)
  await ui.press({ key: 'tg:sub' })
  await until(async () => !(await has('e:sub/inner.txt')))
  expect(await has('e:sub/inner.txt')).toBe(false)
  expect(sizes()).toBe(1)
  // ⊞ Open all opens every folder (sub's file shows); one folder still folds on its own and stays folded
  expect(await has('tree-fold-all')).toBe(false)
  await ui.press({ key: 'tree-open-all' })
  await until(() => has('e:sub/inner.txt'))
  expect(await has('e:sub/inner.txt')).toBe(true)
  await ui.press({ key: 'tg:sub' })
  await until(async () => !(await has('e:sub/inner.txt')))
  for (let i = 0; i < 5; i++) await ui.drawn()
  expect(await has('e:sub/inner.txt')).toBe(false)
  // ⊟ Fold all closes the rest
  await ui.press({ key: 'tg:sub' })
  await until(() => has('e:sub/inner.txt'))
  await ui.press({ key: 'tree-fold-all' })
  await until(async () => !(await has('e:sub/inner.txt')))
  expect(await has('e:sub/inner.txt')).toBe(false)
  expect(await has('tree-open-all')).toBe(true)

  // the bar: the path as buttons, the Git and Project windows a press away, ⋯; no ← → yet; Wrap only in ⋯
  expect(await has('v-git')).toBe(true)
  expect(await has('v-project')).toBe(true)
  // Files · Git · Project switch in place in the one pane (no extra dock tabs since 0.4.8)
  // Project opens on its dashboard: cards, each title opening its page (Items → its page, ← Overview back)
  await ui.press({ key: 'v-project' })
  await until(() => has('card-go:next'))
  expect(await has('card-go:next')).toBe(true)
  expect(await has('card-go:items')).toBe(true)
  expect(await has('ov:search')).toBe(true)
  await ui.press({ key: 'card-go:items' })
  await until(() => has('tab:overview'))
  expect(await has('tab:overview')).toBe(true)
  await ui.press({ key: 'tab:overview' })
  await until(() => has('card-go:next'))
  await ui.press({ key: 'v-git' })
  await until(async () => !!(await ui.find({ text: /isn't in a git repository/ })))
  expect(await ui.find({ text: /isn't in a git repository/ })).toBeDefined()
  await ui.press({ key: 'v-files' })
  await until(() => has('e:notes.txt'))
  expect(await has('menu')).toBe(true)
  expect(await has('nav-back')).toBe(false)
  expect(await has('wrap')).toBe(false)
  expect((await ui.find({ type: 'Button', key: 'bc:1' }))?.text).toBe('pics')

  // into a folder and to a file: ← goes back, → forward again
  await ui.press({ key: 'e:sub' })
  await until(() => has('nav-back'))
  await ui.press({ key: 'nav-back' })
  await until(() => has('nav-fwd'))
  expect(await has('e:notes.txt')).toBe(true)
  await ui.press({ key: 'nav-fwd' })
  await until(async () => !(await has('e:notes.txt')))
  expect((await ui.find({ type: 'Button', key: 'bc:2' }))?.text).toBe('sub')
  await ui.press({ key: 'up' })
  await until(() => has('e:notes.txt'))

  // 👁 a Read by Claude: the file opens, with the lines read shown above it
  await $.tool.call({ tool: 'Read', file_path: TXT, offset: 2, limit: 2 })
  await until(async () => !!(await ui.find({ text: /^👁 Claude read lines 2–3/ })))
  expect(await ui.find({ text: /^👁 Claude read lines 2–3/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Save/ })).toBeDefined()
  // Claude's own working files aren't followed
  await $.tool.call({ tool: 'Read', file_path: 'C:\\Users\\tester\\.claude\\projects\\x\\memory\\MEMORY.md' })
  expect(await ui.find({ text: /^👁 Claude read lines 2–3/ })).toBeDefined()
  // the ✕ closes the band; ← goes back to the folder
  await ui.press({ key: 'read-done' })
  await until(async () => !(await ui.find({ text: /^👁 Claude read/ })))
  expect(await ui.find({ text: /^👁 Claude read/ })).toBeUndefined()

  // a picture: ◀ ▶ through the folder's pictures, and its own app
  await ui.press({ key: 'up' })
  await until(() => has('e:a.png'))
  await ui.press({ key: 'e:a.png' })
  await until(() => has('pic-next'))
  expect(await ui.find({ text: /^1 of 2 in this folder$/ })).toBeDefined()
  await ui.press({ key: 'pic-next' })
  await until(async () => !!(await ui.find({ text: /^2 of 2 in this folder$/ })))
  expect(await ui.find({ text: /^2 of 2 in this folder$/ })).toBeDefined()
  await ui.press({ key: 'open-app' })
  await until(async () => runs.some(r => r[0] === 'explorer.exe' && r[1] === 'F:\\pics\\b.png'))
  expect(runs.some(r => r[0] === 'explorer.exe' && r[1] === 'F:\\pics\\b.png')).toBe(true)

  // ⋯ → Follow off (kept for every chat): a Read no longer opens anything
  await ui.press({ key: 'menu' })
  await until(() => has('follow'))
  expect((await ui.find({ key: 'follow' }))?.text).toBe('👁 Follow Claude: on')
  await ui.press({ key: 'follow' })
  await until(async () => store.get('followClaude') === false)
  expect(store.get('followClaude')).toBe(false)
  await $.tool.call({ tool: 'Read', file_path: TXT })
  for (let i = 0; i < 5; i++) await ui.drawn()
  expect(await has('pic-next')).toBe(true)
})

// Round 2 of the 2026-11-11 UI pass: git's own words, read by the parsers
test('git parsers: ages, log, newest commit per file, branches, blame', async () => {
  const now = Date.UTC(2026, 10, 11, 12)
  expect(age(now - 30_000, now)).toBe('just now')
  expect(age(now - 5 * 60_000, now)).toBe('5 min')
  expect(age(now - 3 * 3_600_000, now)).toBe('3 h')
  expect(age(now - 2 * 86_400_000, now)).toBe('2 days')
  expect(age(now - 21 * 86_400_000, now)).toBe('3 weeks')
  expect(age(now - 400 * 86_400_000, now)).toBe('1 year')
  expect(ageTone(now - 3_600_000, now)).toBe('new')
  expect(ageTone(now - 3 * 86_400_000, now)).toBe('recent')
  expect(ageTone(now - 30 * 86_400_000, now)).toBe('old')
  const SHA = 'a'.repeat(40)
  expect(logFrom(`${SHA}\t1762862400\tStrike\tFix: tabs\twith a tab`)).toEqual([{ sha: SHA, at: 1762862400000, author: 'Strike', subject: 'Fix: tabs\twith a tab' }])
  const last = lastCommitByFile('\u00012000\nsrc/A.ts\nREADME.md\n\n\u00011000\nsrc/a.ts\nold.txt\n')
  expect(last.get('src/a.ts')).toBe(2_000_000)
  expect(last.get('old.txt')).toBe(1_000_000)
  expect(branchesFrom('*\tmain\t1762862400\torigin/main\t[ahead 2, behind 1]\n \tidea\t1762000000\t\t')).toEqual([
    { name: 'main', at: 1762862400000, upstream: 'origin/main', ahead: 2, behind: 1, current: true },
    { name: 'idea', at: 1762000000000, upstream: '', ahead: 0, behind: 0, current: false },
  ])
  const B = 'b'.repeat(40)
  const porcelain = [
    `${SHA} 1 1 2`, 'author Strike', 'author-time 1762862400', 'summary First', 'filename x.ts', '\tone',
    `${SHA} 2 2`, 'filename x.ts', '\ttwo',
    `${B} 3 3 1`, 'author Claude', 'author-time 1762000000', 'summary Second', 'filename x.ts', '\tthree',
  ].join('\n')
  // the graph's lanes: main straight down, a branch beside it that merges back
  const M = 'c'.repeat(40)
  const F = 'f'.repeat(40)
  const graph = graphRows([
    `${M}\t${SHA} ${F}\t3\tStrike\tHEAD -> main\tMerge idea`,
    `${F}\t${SHA}\t2\tStrike\tidea\tTry an idea`,
    `${SHA}\t\t1\tStrike\ttag: v1\tFirst`,
  ].join('\n'))
  expect(graph.map(r => [r.col, r.refs])).toEqual([[0, ['main']], [1, ['idea']], [0, ['🏷 v1']]])
  expect(graph[0]!.lanes).toEqual([SHA, F])
  expect(graph[2]!.lanes).toEqual([])
  expect(blameRuns(porcelain)).toEqual([
    { from: 1, to: 2, sha: SHA, author: 'Strike', at: 1762862400000, subject: 'First' },
    { from: 3, to: 3, sha: B, author: 'Claude', at: 1762000000000, subject: 'Second' },
  ])
})

// Round 2 in the pane: Git → Changed files with dates, History (a commit's files and diff), Branches (ahead /
// behind, Compare), and an open file's 🕘 History (commits, who changed each line)
test('git: dates, history, branches and compare, a file\'s history and blame', async ($, on) => {
  const ROOT = 'F:\\repo'
  const FILE = 'F:\\repo\\src\\a.ts'
  const NOW = Date.now()
  const s = (ms: number) => String(Math.floor(ms / 1000))
  const C1 = '1'.repeat(40)
  const C2 = '2'.repeat(40)
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({ value: String(e.path) === 'F:\\repo\\src' ? [{ name: 'a.ts', kind: 'file', size: 12, mtimeMs: NOW - 3_600_000, isLink: false }] : [] }))
  on('fs.exists', (_, e) => ({ value: /[\\/]\.git$/.test(String(e.path)) }))
  on('fs.stat', (_, e) => ({ value: /\.ts$/i.test(String(e.path)) ? { kind: 'file', size: 12, mtimeMs: NOW - 3_600_000, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    if (String(e.path) === FILE) return { value: 'one\ntwo\nthree\n' }
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('process.run', (_, e) => {
    const a = e.argv
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] !== 'git') return out('')
    if (a.includes('status')) return out(' M src/a.ts')
    if (a.includes('--numstat') && a.includes('HEAD') && a.includes('diff')) return out('2\t1\tsrc/a.ts')
    if (a.includes('--name-only')) return out(`\u0001${s(NOW - 5 * 86_400_000)}\nsrc/a.ts\n`)
    if (a.includes('--abbrev-ref')) return out('main\n')
    if (a.includes('rev-list')) return out('2\n')
    if (a.includes('blame')) return out([`${C2} 1 1 2`, 'author Strike', `author-time ${s(NOW - 2 * 86_400_000)}`, 'summary Second', '\tone', `${C2} 2 2`, '\ttwo', `${'0'.repeat(40)} 3 3 1`, 'author Not Committed Yet', `author-time ${s(NOW)}`, 'summary Version of a.ts from a.ts', '\tthree'].join('\n'))
    if (a.includes('branch') && a.includes('-r')) return out('origin/main\norigin/HEAD\n')
    if (a.includes('branch')) return out(`*\tmain\t${s(NOW - 86_400_000)}\torigin/main\t[ahead 2]\n \tidea\t${s(NOW - 9 * 86_400_000)}\t\t\n`)
    if (a.includes('main..idea')) return out(`${C1}\t${s(NOW - 9 * 86_400_000)}\tStrike\tTry an idea\n`)
    if (a.includes('idea..main')) return out('')
    if (a.includes('main...idea') && a.includes('--numstat')) return out('5\t0\tsrc/idea.ts\n')
    if (a.includes('show') && a.includes('--numstat')) return out('2\t1\tsrc/a.ts\n')
    if (a.includes('show')) return out('@@ -1 +1 @@\n-old\n+new\n')
    // the graph: every branch, with parents and names
    if (a.includes('--all')) return out(`${C2}\t${C1}\t${s(NOW - 2 * 86_400_000)}\tStrike\tHEAD -> main, origin/main\tSecond\n${C1}\t\t${s(NOW - 9 * 86_400_000)}\tStrike\t\tFirst\n`)
    if (a.includes('log')) return out(`${C2}\t${s(NOW - 2 * 86_400_000)}\tStrike\tSecond\n${C1}\t${s(NOW - 9 * 86_400_000)}\tStrike\tFirst\n`)
    return out('')
  })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 30 && !(await ok()); i++) await ui.drawn()
  }
  const text = (re: RegExp) => ui.find({ text: re })
  const gitWin = await $.ui.mount({ ...GIT, surface: 'desktop' })
  const gUntil = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 30 && !(await ok()); i++) await gitWin.drawn()
  }
  const gText = (re: RegExp) => gitWin.find({ text: re })

  // the Git window: where main stands, the graph (a picture), the commits as rows; ▸ a commit, ▸ a file's diff
  await gUntil(async () => !!(await gitWin.find({ type: 'Svg' })))
  expect(await gText(/^On main · ↑2 vs origin\/main · 2 branches · 1 uncommitted$/)).toBeDefined()
  expect(await gitWin.find({ type: 'Svg' })).toBeDefined()
  expect(await gitWin.find({ type: 'Button', text: /^▸ 2222222 Second$/ })).toBeDefined()
  // columns: Author, When
  expect(await gText(/^Strike$/)).toBeDefined()
  expect(await gText(/^2 days ago$/)).toBeDefined()
  await gitWin.press({ key: `cmb:commit:graph:${C2}` })
  await gUntil(async () => !!(await gitWin.find({ type: 'Button', text: /src\/a\.ts$/ })))
  await gitWin.press({ key: `cfd:commit:graph:${C2}:src/a.ts` })
  await gUntil(async () => !!(await gitWin.find({ type: 'Code' })))
  expect(await gitWin.find({ type: 'Code' })).toBeDefined()

  // Uncommitted changes (folded until pressed): when each file was edited and last committed
  await openSection(gitWin, 'uncommitted')
  // columns: Edited, Committed (under a header)
  await gUntil(async () => !!(await gText(/^1 h ago$/)))
  expect(await gText(/^1 h ago$/)).toBeDefined()
  expect(await gText(/^5 days ago$/)).toBeDefined()
  expect(await gText(/^Committed$/)).toBeDefined()
  expect((await gitWin.find({ key: 'ch-sort' }))?.text).toBe('↕ Path')

  // Branches: main ahead of its remote; Compare with idea: its commit and the file that differs
  await openSection(gitWin, 'branches')
  await gUntil(async () => !!(await gText(/^● main$/)))
  expect(await gText(/^↑2 vs origin\/main$/)).toBeDefined()
  expect(await gText(/^2 local branches, 1 on remotes/)).toBeDefined()
  await gitWin.press({ key: 'br-cmp:idea' })
  await gUntil(async () => !!(await gText(/^main ↔ idea$/)))
  expect(await gText(/^Only on idea: 1 commit$/)).toBeDefined()
  expect(await gitWin.find({ type: 'Button', text: /Try an idea$/ })).toBeDefined()
  expect(await gitWin.find({ type: 'Button', text: /src\/idea\.ts$/ })).toBeDefined()

  // an open file's 🕘 History (Files window): its commits, then who changed each line
  await ui.press({ key: 'e:a.ts' }).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__file-pane__show', path: FILE })
  await until(async () => !!(await ui.find({ key: 'fhist' })))
  await ui.press({ key: 'fhist' })
  await until(async () => !!(await ui.find({ key: 'fh-blame' })))
  expect(await ui.find({ type: 'Button', text: /^▸ 2222222 Second$/ })).toBeDefined()
  await ui.press({ key: 'fh-blame' })
  await until(async () => !!(await text(/^lines 1–2 · 2222222 · Strike · 2 days ago · Second$/)))
  expect(await text(/^lines 1–2 · 2222222 · Strike · 2 days ago · Second$/)).toBeDefined()
  expect(await text(/^line 3 · not committed yet$/)).toBeDefined()
})

// Folder sizes from Everything's index when voidtools' es.exe is in Program Files\Everything (0.4.10): one es.exe
// query per folder, by argv, and no helper count for what it answered
test('folder sizes: es.exe in Program Files answers, the helper counts the rest', async ($, on) => {
  const DIR = 'F:\\work'
  const ES = 'C:\\Program Files\\Everything\\es.exe'
  on('command.register', () => ({ value: { command: 'files' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__file-pane__open' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: DIR }))
  on('env.get', (_, e) => ({ value: e.name === 'ProgramFiles' ? 'C:\\Program Files' : 'C:\\Users\\tester' }))
  on('fs.list', (_, e) => ({
    value: String(e.path) === DIR
      ? [
          { name: 'big', kind: 'dir', size: 0, mtimeMs: 1, isLink: false },
          { name: 'skipped', kind: 'dir', size: 0, mtimeMs: 1, isLink: false },
        ]
      : [],
  }))
  on('fs.exists', (_, e) => ({ value: String(e.path) === ES }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // Everything knows big (5 MB) but not skipped (left out of its index); the helper counts skipped (1 KB)
    if (e.argv[0] === ES) return out('Filename,Size\r\n"F:\\work\\big\\",5242880\r\n')
    if (e.argv[3] === 'dirsizes') return out(JSON.stringify({ ok: true, sizes: Object.fromEntries(e.argv.slice(4).map(d => [d, { bytes: 1024, files: 1, partial: false }])) }))
    return out('')
  })
  await $.session.start({ cwd: DIR, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (let i = 0; i < 40 && !(await ui.find({ text: /^1\.0 KB$/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /^5\.0 MB$/ })).toBeDefined()
  expect(await ui.find({ text: /^1\.0 KB$/ })).toBeDefined()
  const es = runs.filter(r => r[0] === ES)
  expect(es.length).toBe(1)
  expect(es[0]).toEqual([ES, '-timeout', '3000', '-parent', DIR, '/ad', '-size', '-csv', '-size-format', '1'])
  // the helper was asked only for the folder Everything didn't answer
  expect(runs.filter(r => r[3] === 'dirsizes').map(r => r.slice(4))).toEqual([['F:\\work\\skipped']])
})
