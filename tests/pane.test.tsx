import { expect, test } from 'claude-code/testing'

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
const TABS = ['next', 'items', 'timeline', 'features', 'blocks', 'changes', 'git', 'checks', 'search', 'backups', 'log', 'notes']

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
            { name: 'Fish.dll', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'Fish.class', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
            { name: 'mods.jar', kind: 'file', size: 100, mtimeMs: 1, isLink: false },
          ] : [],
  }))
  on('fs.exists', (_, e) => ({ value: String(e.path).startsWith(VS) }))
  on('fs.stat', (_, e) => ({
    value: /\.(txt|png|fbx|glb|dll|cs|class|jar)$/i.test(String(e.path)) ? { kind: 'file', size: 4, mtimeMs: 1, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 1, isLink: false },
  }))
  on('fs.read', (_, e) => {
    if (/code\.cmd$/i.test(String(e.path))) return { value: '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\abc123\\resources\\app\\out\\cli.js" %*\r\n' }
    if (/\.txt$/i.test(String(e.path))) return { value: 'hi\n' }
    if (/\.(png|fbx|glb)$/i.test(String(e.path))) return { value: '\u0089PNG\r\n\u001a\n\u0000\u0000' }
    if (/\.dll$/i.test(String(e.path))) return { value: 'MZ\u0090\u0000\u0003\u0000' }
    if (/\.class$/i.test(String(e.path))) return { value: 'Êþº¾\u0000\u0000' }
    if (/\.jar$/i.test(String(e.path))) return { value: 'PK\u0003\u0004\u0000\u0000' }
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
      if (cmd === 'ziplist') return out(JSON.stringify({ count: 2, bytes: 361, lines: ['         64  2026-11-03 14:47  META-INF/MANIFEST.MF', '        297  2026-11-03 14:47  Fish.class'] }))
      // javap: the bytecode, or (with an older copy) its diff
      if (cmd === 'javap') return out(JSON.stringify(e.argv.length > 6 ? { diff: '@@ -9 +9 @@ int haul();\n-       0: iconst_1\n+       0: iconst_2\n' } : { text: 'public class Fish {\n  int haul();\n}\n', javap: 'C:\\Program Files\\Java\\jdk-21\\bin\\javap.exe' }))
      if (cmd === 'bindiff') return out(JSON.stringify({ same: false, oldSize: 235, newSize: 297, text: '@@ -1 +1 @@\n-HaulOld\n+HaulNew\n', hex: ['@@ 62 bytes added at 0x9; everything after is the same, just moved @@', '+00000009  12 0a  ..'] }))
      // Heimdall3D's probe: renders boat.glb into the cache; car.glb fails (so Explorer's thumbnail is asked)
      if (cmd === 'probe') return out(JSON.stringify(/car\.glb$/.test(String(e.argv[4])) ? { error: "Heimdall3D couldn't render it: bad file" } : { ok: true, file: 'C:\\Users\\tester\\.claude\\file-pane-cache\\heimdall\\abc.png' }))
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
  for (let i = 0; i < 20 && !(await ui.find({ text: /preview by Heimdall3D \(heimdall_probe\)/ })); i++) await ui.drawn()
  expect(await ui.find({ text: /preview by Heimdall3D \(heimdall_probe\)/ })).toBeDefined()
  const probe = runs.find(r => r.argv[3] === 'probe' && /boat\.glb$/.test(String(r.argv[4])))!
  expect(probe.argv.slice(5)).toEqual(['C:\\Users\\tester\\.claude\\file-pane-cache', 'C:\\Users\\tester'])
  expect(runs.some(r => r.argv[0] === 'powershell.exe' && String(r.argv[4]).includes("'C:\\Users\\tester\\.claude\\file-pane-cache\\heimdall\\abc.png'"))).toBe(true)

  const shows = async (re: RegExp) => {
    for (let i = 0; i < 20 && !(await ui.find({ text: re })); i++) await ui.drawn()
    return ui.find({ text: re })
  }

  // a jar: the files inside (from its directory), and ± Diff against the last commit (readable text and hex)
  await ui.press({ key: 'back' })
  await ui.press({ key: 'e:mods.jar' })
  await ui.press({ key: 'bin-files' })
  expect(await shows(/^2 entries, .* unpacked/)).toBeDefined()
  expect(await shows(/297 {2}2026-11-03 14:47 {2}Fish\.class/)).toBeDefined()
  await ui.press({ key: 'bin-diff' })
  expect(await shows(/Last commit 235 B → now 297 B/)).toBeDefined()
  expect(await shows(/HaulNew/)).toBeDefined()
  expect(await shows(/62 bytes added at 0x9/)).toBeDefined()
  await ui.press({ key: 'side' })
  expect(await shows(/^\+ HaulNew$/)).toBeDefined()
  await ui.press({ key: 'side' })
  const bindiff = runs.find(r => r.argv[3] === 'bindiff')!
  expect(String(bindiff.argv[4])).toMatch(/file-pane-cache\\last-commit-\d+\.jar$/)
  expect(bindiff.argv[5]).toBe(`${DIR}\\mods.jar`)
  await until(() => runs.some(r => r.argv[3] === 'rmtemp' && /\.jar$/.test(String(r.argv[5]))), 'removing the jar temp copy')

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
  await ui.press({ key: 'bin-info' })
  await ui.press({ key: 'bin-cs' })
  expect(await shows(/C# of Fish\.dll by ILSpy/)).toBeDefined()
  expect(runs.some(r => r.argv[3] === 'ilspy' && String(r.argv[5]).endsWith('file-pane-cache'))).toBe(true)

  expect(runs.filter(r => /cmd(\.exe)?$/i.test(r.argv[0] ?? '')).map(r => r.argv.join(' '))).toEqual([])
  await ui.unmount()
})
