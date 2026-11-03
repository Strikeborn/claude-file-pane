// The pane's Node helper (hooks/helper.cjs) run for real on sample files (the pane test answers every helper call itself, so this is
// where its commands meet real bytes). `node --test tests/helper.check.mjs`; deploy.mjs runs it with the checks.
// Programs that may not be installed (a JDK's javap, Heimdall3D) are tried only when they're there; ILSpy (slow) only
// with FILE_PANE_SLOW=1. Everything it writes goes to its own temp folder, removed at the end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = (...p) => path.join(root, 'samples', ...p);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-pane-check-'));
const cache = path.join(tmp, 'cache');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const helper = (args, input) => {
  // without the test runner's own variable (a child Node seeing it waits to report to a runner: ~2 s each)
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--', path.join(root, 'hooks', 'helper.cjs'), ...args], { encoding: 'utf8', input: input ?? '', timeout: 120_000, env });
  assert.equal(r.stderr, '', `helper ${args[0]} wrote to stderr`);
  return JSON.parse(r.stdout);
};
const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
const hasJavap = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft'].some(v => {
  try {
    return fs.readdirSync(path.join(pf, v)).some(d => fs.existsSync(path.join(pf, v, d, 'bin', 'javap.exe')));
  } catch {
    return false;
  }
});

// a stored (unpacked) zip with the given entries, written by hand: for names a jar tool won't make
const makeZip = (file, entries) => {
  const locals = [], central = [];
  let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text), n = Buffer.from(name), crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
};

test('page, backup, splice, restore: a text file read, backed up, changed and put back', () => {
  const f = path.join(tmp, 'notes.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  assert.deepEqual(helper(['page', f, '0', '8']), { start: 0, end: 8, size: 14, binary: false, text: 'one\ntwo\n' });
  const b = helper(['backup', f, path.join(tmp, 'backups')]);
  assert.equal(b.ok, true);
  assert.equal(fs.readFileSync(b.backup, 'utf8'), 'one\ntwo\nthree\n');
  assert.deepEqual(helper(['splice', f, '4', '7'], 'TWO'), { ok: true, end: 7 });
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\nTWO\nthree\n');
  assert.deepEqual(helper(['restore', b.backup, f]), { ok: true });
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\ntwo\nthree\n');
});

test('rmtemp removes only the pane\'s own last-commit file in the cache folder', () => {
  fs.mkdirSync(cache, { recursive: true });
  const own = path.join(cache, 'last-commit-123.png'), other = path.join(cache, 'keep.png');
  fs.writeFileSync(own, 'x');
  fs.writeFileSync(other, 'x');
  assert.deepEqual(helper(['rmtemp', cache, own]), { ok: true });
  assert.equal(fs.existsSync(own), false);
  assert.deepEqual(helper(['rmtemp', cache, other]), { error: 'not a pane temp file' });
  assert.deepEqual(helper(['rmtemp', cache, path.join(cache, '..', 'last-commit-1.png')]), { error: 'not a pane temp file' });
  assert.equal(fs.existsSync(other), true);
});

test('bininfo, strings, hex: what a file is, its text and its bytes', () => {
  assert.match(helper(['bininfo', sample('java', 'fish-1.jar')]).kind, /^zip archive/);
  assert.equal(helper(['bininfo', sample('java', 'Fish-1.class')]).kind, 'Java class file');
  assert.equal(helper(['bininfo', sample('star-test.glb')]).kind, 'glTF binary model (.glb)');
  const pe = helper(['bininfo', process.execPath]);
  assert.match(pe.kind, /PE/);
  assert.ok(pe.pe.some(l => /^Kind: program, x64/.test(l)));
  assert.ok(helper(['strings', sample('java', 'fish-2.jar'), '0']).lines.some(l => /notes\.txt/.test(l)));
  assert.match(helper(['hex', sample('java', 'fish-1.jar'), '0']).lines[0], /^00000000 {2}50 4b 03 04/);
});

test('ziplist, zipget: the files in a jar, one copied out (CRC checked), names kept inside the cache', () => {
  const list = helper(['ziplist', sample('java', 'fish-2.jar')]);
  assert.equal(list.count, 4);
  assert.deepEqual(list.files.map(f => f.name), ['META-INF/', 'META-INF/MANIFEST.MF', 'Fish.class', 'notes.txt']);
  const got = helper(['zipget', sample('java', 'fish-2.jar'), 'notes.txt', cache]);
  assert.equal(fs.readFileSync(got.file, 'utf8').trim(), 'hello');
  assert.ok(got.file.startsWith(path.join(cache, 'zip') + path.sep));
  assert.deepEqual(helper(['zipget', sample('java', 'fish-2.jar'), 'META-INF/', cache]), { error: 'no such file in it' });
  // a name climbing out of the folder lands in the cache as its last part only
  const evil = path.join(tmp, 'evil.zip');
  makeZip(evil, [['../../outside.txt', 'nope'], ['dir\\..\\..\\win.txt', 'nope']]);
  for (const name of ['../../outside.txt', 'dir\\..\\..\\win.txt']) {
    const r = helper(['zipget', evil, name, cache]);
    assert.ok(r.file.startsWith(path.join(cache, 'zip') + path.sep), r.file);
    assert.match(path.basename(r.file), /^(outside|win)\.txt$/);
  }
  assert.equal(fs.existsSync(path.join(tmp, 'outside.txt')), false);
  // damaged data is refused
  const bad = path.join(tmp, 'bad.zip');
  makeZip(bad, [['a.txt', 'hello']]);
  const bytes = fs.readFileSync(bad);
  bytes[30 + 5] ^= 1;
  fs.writeFileSync(bad, bytes);
  assert.deepEqual(helper(['zipget', bad, 'a.txt', cache]), { error: 'its data is damaged (CRC differs)' });
});

test('bindiff, zipentry: two jars compared, file by file and one file inside', () => {
  const d = helper(['bindiff', sample('java', 'fish-1.jar'), sample('java', 'fish-2.jar'), cache]);
  assert.equal(d.same, false);
  assert.deepEqual(d.files, ['~ Fish.class  (235 → 297 bytes)', '+ notes.txt  (6 bytes)']);
  assert.match(d.hex[0], /^@@ /);
  assert.deepEqual(helper(['zipentry', sample('java', 'fish-1.jar'), sample('java', 'fish-2.jar'), 'META-INF/MANIFEST.MF', cache, pf]), { same: true });
  assert.match(helper(['zipentry', sample('java', 'fish-1.jar'), sample('java', 'fish-2.jar'), 'notes.txt', cache, pf]).diff, /^\+hello$/m);
  const cls = helper(['zipentry', sample('java', 'fish-1.jar'), sample('java', 'fish-2.jar'), 'Fish.class', cache, pf]);
  if (hasJavap) {
    assert.equal(cls.kind, 'javap');
    assert.match(cls.diff, /^\+ +0: iconst_2$/m);
  } else assert.equal(cls.kind, 'binary');
  // javap's and the diff's own temp files are gone
  assert.deepEqual(fs.existsSync(path.join(cache, 'diff')) ? fs.readdirSync(path.join(cache, 'diff')) : [], []);
});

test('javap: a class\'s bytecode, and its debug info when only lines moved', { skip: !hasJavap && 'no JDK under Program Files' }, () => {
  assert.match(helper(['javap', sample('java', 'Fish-1.class'), pf]).text, /int haul\(\);/);
  const d = helper(['javap', sample('java', 'Fish-lines.class'), pf, sample('java', 'Fish-1.class'), cache]);
  assert.equal(d.diff, '');
  assert.match(d.debugDiff, /^\+ +line 4: 0$/m);
});

test('pcache: a drawn preview kept and found again', () => {
  assert.deepEqual(helper(['pcache', 'get', cache, 'image|x|1|2']), {});
  assert.deepEqual(helper(['pcache', 'put', cache, 'image|x|1|2'], '{"w":1}'), { ok: true });
  assert.deepEqual(helper(['pcache', 'get', cache, 'image|x|1|2']), { value: { w: 1 } });
});

test('probe: Heimdall3D draws the sample star', { skip: !fs.existsSync(path.join(pf, 'Heimdall3D', 'heimdall_probe.exe')) && 'Heimdall3D not installed' }, () => {
  const r = helper(['probe', sample('star-test.glb'), cache, pf]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.statSync(r.file).size > 1000);
  assert.equal(helper(['probe', sample('star-test.glb'), cache, pf]).cached, true);
});

test('ilspy, csdiff: a .NET DLL to C#, and two copies compared', { skip: process.env.FILE_PANE_SLOW !== '1' && 'slow (set FILE_PANE_SLOW=1)' }, () => {
  const dll = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'System.Runtime.Remoting.dll');
  const r = helper(['ilspy', dll, cache]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(helper(['csdiff', dll, dll, cache]), { diff: '' });
});
