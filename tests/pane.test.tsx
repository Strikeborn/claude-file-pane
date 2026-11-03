import { expect, test } from 'claude-code/testing'
import { wordDiff } from '../hooks/project'

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
const TABS = ['next', 'items', 'ticks', 'timeline', 'features', 'blocks', 'changes', 'git', 'checks', 'search', 'backups', 'log', 'notes']

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

  // every Project tab
  await ui.press({ key: 'v-project' })
  for (const t of TABS) {
    await ui.press({ key: `tab:${t}` })
    await clean(`project tab ${t}`)
  }

  // back to Files, open the file
  await ui.press({ key: 'v-files' })
  await ui.press({ key: 'e:links.txt' })
  await clean('the open file')
  expect(await ui.find({ type: 'Button', text: /Save/ })).toBeDefined()

  // ↩ Wrap: on by default, shown in every view, flips off and back; every view still draws both ways
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
  await ui.press({ key: 'v-project' })
  for (const t of TABS) {
    await ui.press({ key: `tab:${t}` })
    await clean(`project tab ${t}, wrap off`)
  }
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: off/)
  await ui.press({ key: 'wrap' })
  await ui.press({ key: 'v-files' })
  expect((await ui.find({ key: 'wrap' }))?.text).toMatch(/Wrap: on/)

  // a Markdown file as a document: its checkboxes are buttons
  await ui.press({ key: 'back' })
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

  // the version line, and the newer deploy waiting for new chats
  expect(await shows(/Files pane v0\.2\.0 · deployed 2026-11-0[12]/)).toBeDefined()
  expect(await shows(/A newer pane was deployed 2026-11-0[34]/)).toBeDefined()

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
  await ui.press({ key: 'v-project' })
  await ui.press({ key: 'tab:ticks' })
  expect(await shows(/^Today \(/)).toBeDefined()
  expect(await shows(/☑ buy paint · Plan › Week 1 › Mon/)).toBeDefined()
  expect(await shows(/☐ unticked rest a lot · Plan › Week 2/)).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /notes\.md$/ })).toBeDefined()
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

  // Open in VS Code: Code.exe with cli.js and the path, as code.cmd would, and no cmd.exe
  await ui.press({ key: 'e:a&calc.txt' })
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
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:pic.png' })
  await ui.press({ key: 'diff' })
  await until(() => runs.some(r => r.argv[3] === 'rmtemp'), 'rmtemp')
  const rm = runs.find(r => r.argv[3] === 'rmtemp')!
  expect(rm.argv[0]).toBe('node')
  expect(rm.argv[4]).toBe('C:\\Users\\tester\\.claude\\file-pane-cache')
  expect(String(rm.argv[5])).toMatch(/^C:\\Users\\tester\\\.claude\\file-pane-cache\\last-commit-\d+\.png$/)

  // a 3D model previews through Explorer's thumbnail (Heimdall3D's here), and says what drew it
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:ship.fbx' })
  await until(() => runs.some(r => r.argv[0] === 'powershell.exe' && String(r.argv[4]).includes('FilePaneShellThumb')), 'the shell thumbnail')
  for (let i = 0; i < 20 && !(await ui.find({ text: /preview by heimdall3d_shell\.dll/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /preview by heimdall3d_shell\.dll/ })).toBeDefined()
  expect(await ui.find({ text: /couldn't draw|binary file/ })).toBeUndefined()

  // a thumbnail maker outside Program Files / Windows is refused, and the pane says so
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:car.glb' })
  for (let i = 0; i < 20 && !(await ui.find({ text: /No preview: .*Program Files/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /No preview: .*Program Files/ })).toBeDefined()
  expect(await ui.find({ text: /No preview: .*Heimdall3D couldn't render it: bad file/ })).toBeDefined()

  // a .glb: Heimdall3D's own still (the probe from Program Files, cached), drawn as a picture, and named
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:boat.glb' })
  for (let i = 0; i < 20 && !(await ui.find({ text: /preview by Heimdall3D \(heimdall_probe, GPU\)/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /preview by Heimdall3D \(heimdall_probe, GPU\)/ })).toBeDefined()
  const probe = runs.find(r => r.argv[3] === 'probe' && /boat\.glb$/.test(String(r.argv[4])))!
  expect(probe.argv.slice(5)).toEqual(['C:\\Users\\tester\\.claude\\file-pane-cache', 'C:\\Users\\tester'])
  expect(runs.some(r => r.argv[0] === 'powershell.exe' && String(r.argv[4]).includes("'C:\\Users\\tester\\.claude\\file-pane-cache\\heimdall\\abc.png'"))).toBe(true)
  // drawn once: kept on disk for other chats, and a redraw (Back and open again) runs nothing
  await until(() => runs.some(r => r.argv[3] === 'pcache' && r.argv[4] === 'put' && /boat\.glb\|/.test(String(r.argv[6]))), 'keeping the preview')
  const before = runs.length
  await ui.press({ key: 'back' })
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
  await ui.press({ key: 'back' })
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
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:mods.jar' })
  await ui.press({ key: 'bin-files' })
  expect(await shows(/^2 entries, .* unpacked/)).toBeDefined()
  // each file a button (a folder isn't): it's copied out to the cache and opened from there
  expect((await ui.find({ key: 'zf:2' }))?.text).toBe('📄 Fish.class · 297 B')
  expect(await ui.find({ key: 'zf:0' })).toBeUndefined()
  await ui.press({ key: 'zf:2' })
  expect(await shows(/Fish\.class from mods\.jar: a copy in the cache/)).toBeDefined()
  expect(runs.find(r => r.argv[3] === 'zipget')!.argv.slice(4)).toEqual([`${DIR}\\mods.jar`, 'Fish.class', 'C:\\Users\\tester\\.claude\\file-pane-cache'])
  await ui.press({ key: 'back' })
  await ui.press({ key: `rec:${DIR}\\mods.jar` })
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
  await ui.press({ key: 'back' })
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
  await ui.press({ key: 'back' })
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
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:Old.class' })
  await ui.press({ key: 'bin-diff' })
  expect(await shows(/^Debug info \(javap -l/)).toBeDefined()
  expect(await shows(/line 4: 0/)).toBeDefined()

  // a DLL: what it is (PE info), its readable text, its bytes, and C# through ILSpy (opened as a file)
  await ui.press({ key: 'back' })
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
  on('fs.exists', () => ({ value: false }))
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

  // Changes: ± Claude's change opens the file with its diff against that copy
  await ui.press({ key: 'v-project' })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'cl:changes:app.ts' })
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
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:notes.ts' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:app.ts' })
  expect((await ui.find({ key: 'base-other' }))?.text).toBe('vs notes.ts')
  await ui.press({ key: 'base-other' })
  expect(await shows(/Compared with F:\\proj\\notes\.ts \(the file opened before this one\)/)).toBeDefined()
  for (let i = 0; i < 20 && lastDiff().at(-2) !== `${DIR}\\notes.ts`; i++) await ui.drawn()
  expect(lastDiff().slice(-3)).toEqual(['--', `${DIR}\\notes.ts`, FILE])
  await ui.unmount()
})
