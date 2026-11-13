// The pane's Node helper: `node -- helper.cjs <command> …` from register.tsx (argv, no shell), one JSON line out.
// Run as a file, not `node -e`: Windows took ~2.7 s to start a 30 KB command line, a file starts in ~0.1 s.
// Tested for real on sample files by tests/helper.check.mjs.
'use strict';
const fs = require('fs'), path = require('path');
const [cmd, ...a] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o));
const swap = (file, bytes) => { const tmp = file + '.file-pane-tmp'; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); };
const readPart = (file, start, len) => {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return buf;
};
// what a binary is, by its first bytes
const magic = (b) => {
  const s = b.toString('latin1', 0, 16), h = b.toString('hex', 0, 8);
  if (s.startsWith('MZ')) return 'Windows program or DLL (PE)';
  if (s.startsWith('PK\x03\x04') || s.startsWith('PK\x05\x06')) return 'zip archive (also .jar, .docx, .xlsx, many mod packs)';
  if (h.startsWith('cafebabe')) return 'Java class file';
  if (s.startsWith('\x7fELF')) return 'Linux program or library (ELF)';
  if (h.startsWith('cffaedfe') || h.startsWith('cefaedfe')) return 'Mac program or library (Mach-O)';
  if (s.startsWith('UnityFS')) return 'Unity asset bundle';
  if (s.startsWith('7z\xbc\xaf')) return '7-Zip archive';
  if (s.startsWith('Rar!')) return 'RAR archive';
  if (h.startsWith('1f8b')) return 'gzip archive';
  if (s.startsWith('SQLite format 3')) return 'SQLite database';
  if (s.startsWith('%PDF')) return 'PDF document';
  if (s.startsWith('\x89PNG')) return 'PNG picture';
  if (s.startsWith('DDS ')) return 'DDS texture';
  if (s.startsWith('OggS')) return 'Ogg audio';
  if (s.startsWith('RIFF')) return 'RIFF file (WAV audio, AVI, WebP)';
  if (s.startsWith('ID3') || h.startsWith('fffb')) return 'MP3 audio';
  if (s.startsWith('glTF')) return 'glTF binary model (.glb)';
  if (s.startsWith('BLENDER')) return 'Blender file';
  if (s.startsWith('Kaydara FBX Binary')) return 'FBX model';
  return 'unknown binary';
};
// what a DLL / EXE says about itself (from ModKeeper's peInfo.ts): version info, build time, machine, sections,
// exports, imports; dotnet when it carries .NET code (ILSpy can turn that back into C#). Read only, nothing runs.
const describePe = (b) => {
  if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = b.readUInt32LE(0x3c);
  if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x4550) return null;
  const machine = b.readUInt16LE(pe + 4), nSections = b.readUInt16LE(pe + 6), stamp = b.readUInt32LE(pe + 8);
  const optSize = b.readUInt16LE(pe + 20), characteristics = b.readUInt16LE(pe + 22), opt = pe + 24;
  if (opt + optSize > b.length) return null;
  const pe32plus = b.readUInt16LE(opt) === 0x20b;
  const dirs = opt + (pe32plus ? 112 : 96), nDirs = b.readUInt32LE(opt + (pe32plus ? 108 : 92));
  const dir = (i) => (i < nDirs && dirs + i * 8 + 8 <= b.length ? { rva: b.readUInt32LE(dirs + i * 8), size: b.readUInt32LE(dirs + i * 8 + 4) } : { rva: 0, size: 0 });
  const sections = [];
  for (let i = 0, st = opt + optSize; i < nSections && st + i * 40 + 40 <= b.length; i++) {
    const o = st + i * 40;
    sections.push({ name: b.toString('latin1', o, o + 8).replace(/\0+$/, ''), vsize: b.readUInt32LE(o + 8), va: b.readUInt32LE(o + 12), rawSize: b.readUInt32LE(o + 16), raw: b.readUInt32LE(o + 20) });
  }
  const off = (rva) => {
    const s = sections.find(x => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
    const o = s ? rva - s.va + s.raw : -1;
    return o >= 0 && o < b.length ? o : -1;
  };
  const cstr = (o) => { if (o < 0) return ''; const e = b.indexOf(0, o); return b.toString('latin1', o, e < 0 ? Math.min(b.length, o + 512) : Math.min(e, o + 512)); };
  const MACHINE = { 0x14c: 'x86 (32-bit)', 0x8664: 'x64', 0xaa64: 'ARM64' };
  const dotnet = dir(14).rva !== 0;
  const lines = [];
  lines.push('Kind: ' + (characteristics & 0x2000 ? 'DLL' : 'program') + ', ' + (MACHINE[machine] || 'machine 0x' + machine.toString(16)) + (dotnet ? ', .NET (C# can be read back: C# (ILSpy))' : ', machine code'));
  // reproducible builds (most .NET ones) put a hash here, not a time: only a date up to next year reads as one
  const built = new Date(stamp * 1000);
  lines.push(built.getUTCFullYear() >= 2000 && built.getUTCFullYear() <= new Date().getUTCFullYear() + 1 ? 'Built: ' + built.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Build stamp: 0x' + stamp.toString(16));
  const at = b.indexOf(Buffer.from('VS_VERSION_INFO', 'utf16le'));
  if (at >= 0) {
    const seg = b.subarray(at, Math.min(b.length, at + 8192));
    for (const key of ['CompanyName', 'FileDescription', 'FileVersion', 'ProductName', 'ProductVersion', 'OriginalFilename', 'InternalName', 'LegalCopyright']) {
      const k = seg.indexOf(Buffer.from(key + '\0', 'utf16le'));
      if (k < 0) continue;
      let v = k + (key.length + 1) * 2;
      while ((at + v) % 4) v++;
      let e = v;
      while (e + 1 < seg.length && (seg[e] || seg[e + 1])) e += 2;
      const value = seg.toString('utf16le', v, e).trim();
      if (value) lines.push('Version info: ' + key + ' = ' + value);
    }
  }
  lines.push('Sections: ' + sections.map(s => s.name + ' ' + s.vsize.toLocaleString('en-US') + ' B').join(', '));
  const ex = dir(0);
  if (ex.rva && off(ex.rva) >= 0) {
    const e = off(ex.rva), n = b.readUInt32LE(e + 24), names = off(b.readUInt32LE(e + 32)), list = [];
    for (let i = 0; i < Math.min(n, 5000) && names >= 0 && names + i * 4 + 4 <= b.length; i++) list.push(cstr(off(b.readUInt32LE(names + i * 4))));
    lines.push('Exports (functions other code calls in it): ' + n);
    for (const f of list.sort()) lines.push('  ' + f);
  }
  const im = dir(1);
  if (im.rva && off(im.rva) >= 0) {
    const byDll = new Map();
    for (let d = off(im.rva); d >= 0 && d + 20 <= b.length; d += 20) {
      const thunks = b.readUInt32LE(d) || b.readUInt32LE(d + 16), nameRva = b.readUInt32LE(d + 12);
      if (!thunks && !nameRva) break;
      const dll = cstr(off(nameRva)).toLowerCase(), fns = [], w = pe32plus ? 8 : 4;
      for (let t = off(thunks), k = 0; t >= 0 && t + w <= b.length && k < 4000; t += w, k++) {
        const v = pe32plus ? Number(b.readBigUInt64LE(t) & 0x7fffffffffffffffn) : b.readUInt32LE(t) & 0x7fffffff;
        const byOrdinal = pe32plus ? b.readBigUInt64LE(t) >> 63n === 1n : b.readUInt32LE(t) >>> 31 === 1;
        if (!v && !byOrdinal) break;
        fns.push(byOrdinal ? '#' + (v & 0xffff) : cstr(off(v) + 2));
      }
      byDll.set(dll, fns.sort());
      if (byDll.size > 500) break;
    }
    lines.push('Imports (the DLLs and functions it uses): ' + byDll.size + ' DLLs');
    for (const [dll, fns] of [...byDll].sort()) lines.push('  ' + dll + ': ' + fns.slice(0, 400).join(', ') + (fns.length > 400 ? ' …' : ''));
  }
  return { lines, dotnet };
};
// the readable text in a buffer (as the strings command finds it), without offsets: they move when anything is added
const stringsOf = (b) => {
  const s = b.toString('latin1'), found = [], wordy = (t) => /[A-Za-z]{4}/.test(t) && (t.match(/[A-Za-z]/g) || []).length >= t.length / 2;
  for (const m of s.matchAll(/[\x20-\x7e]{5,}/g)) if (wordy(m[0])) found.push([m.index, m[0].slice(0, 400)]);
  for (const m of s.matchAll(/(?:[\x20-\x7e]\x00){5,}/g)) { const t = m[0].replace(/\x00/g, ''); if (wordy(t)) found.push([m.index, t.slice(0, 400) + '  (UTF-16)']); }
  return found.sort((x, y) => x[0] - y[0]).slice(0, 20000).map(x => x[1]);
};
// two texts as a unified diff (git diff --no-index on two files of the pane's own in <cache>\diff, removed after)
const textDiff = (cache, oldText, newText) => {
  const dir = path.join(cache, 'diff');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, process.pid + '-' + Date.now()), fa = base + '-before.txt', fb = base + '-after.txt';
  fs.writeFileSync(fa, oldText); fs.writeFileSync(fb, newText);
  try {
    const r = require('child_process').spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', '--', fa, fb], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    return (r.stdout || '').split(/\r?\n/).filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).slice(0, 6000).join('\n');
  } finally { fs.rmSync(fa, { force: true }); fs.rmSync(fb, { force: true }); }
};
// hex around where two binaries differ (ModKeeper's hexDiff): one inserted / removed / replaced block shown as such
// (hexInsertion: the rest only moved), else up to 6 regions of changed 16-byte lines, old then new
const hexLine = (buf, off, end) => {
  const bytes = [...buf.subarray(off, Math.min(end === undefined ? off + 16 : end, off + 16))];
  return off.toString(16).padStart(8, '0') + '  ' + bytes.map(x => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ') + '  ' + bytes.map(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
};
const hexDiff = (a, b) => {
  let p = 0;
  const min = Math.min(a.length, b.length);
  while (p < min && a[p] === b[p]) p++;
  if (p === a.length && p === b.length) return [];
  let s = 0;
  while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldEnd = a.length - s, newEnd = b.length - s, out = [];
  if (oldEnd - p <= 4096 && newEnd - p <= 4096 && a.length !== b.length) {
    const what = oldEnd === p ? (newEnd - p) + ' bytes added at 0x' + p.toString(16) : newEnd === p ? (oldEnd - p) + ' bytes removed at 0x' + p.toString(16) : (oldEnd - p) + ' bytes replaced by ' + (newEnd - p) + ' at 0x' + p.toString(16);
    out.push('@@ ' + what + '; everything after is the same, just moved @@');
    if (p > 0) out.push(' ' + hexLine(a, Math.max(0, p - 16), p));
    for (let o = p; o < oldEnd; o += 16) out.push('-' + hexLine(a, o, oldEnd));
    for (let o = p; o < newEnd; o += 16) out.push('+' + hexLine(b, o, newEnd));
    if (oldEnd < a.length) out.push(' ' + hexLine(a, oldEnd, a.length));
    out.push('@@ size ' + a.length + ' → ' + b.length + ' bytes @@');
    return out;
  }
  const max = Math.max(a.length, b.length);
  let regions = 0;
  for (let off = 0; off < max && regions < 6; off += 16) {
    if (a.subarray(off, off + 16).equals(b.subarray(off, off + 16))) continue;
    regions++;
    const start = Math.max(0, off - 16), run = [];
    out.push('@@ bytes 0x' + start.toString(16) + ' @@');
    if (start < off) out.push(' ' + hexLine(a, start));
    let o = off;
    while (o < max && !a.subarray(o, o + 16).equals(b.subarray(o, o + 16)) && run.length < 8) { run.push(o); o += 16; }
    for (const r of run) if (r < a.length) out.push('-' + hexLine(a, r));
    for (const r of run) if (r < b.length) out.push('+' + hexLine(b, r));
    if (o < Math.min(a.length, b.length)) out.push(' ' + hexLine(a, o));
    off = o;
  }
  if (a.length !== b.length) out.push('@@ size ' + a.length + ' → ' + b.length + ' bytes @@');
  return out;
};
// the JDK's class disassembler, only from Program Files (the usual JDK folders, newest name first)
const findJavap = (pf) => {
  if (!/^[A-Za-z]:\\/.test(pf || '')) return null;
  for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft']) {
    let list = [];
    try { list = fs.readdirSync(path.join(pf, vendor)).sort().reverse(); } catch (e) { list = []; }
    for (const d of list) { const exe = path.join(pf, vendor, d, 'bin', 'javap.exe'); if (fs.existsSync(exe)) return exe; }
  }
  return null;
};
const javapOf = (exe, file, flags) => {
  const r = require('child_process').spawnSync(exe, [...(flags || ['-c', '-p']), file], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('javap failed: ' + String(r.stderr || r.error || '').trim().split(/\r?\n/)[0]);
  // its file path, size and checksum lines differ between two copies of the same class: left out
  return r.stdout.split(/\r?\n/).filter(l => !/^\s*(Compiled from|Classfile |Last modified|SHA-256 checksum|MD5 checksum)/.test(l)).join('\n');
};
// a zip / jar's entries from its central directory (read only, nothing unpacked): name, sizes, CRC, method, where
// its data starts
const zipEntries = (file) => {
  const size = fs.statSync(file).size, tail = readPart(file, Math.max(0, size - 65557), Math.min(size, 65557));
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return { error: 'no zip directory at its end (damaged, or not a zip)' };
  const total = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || cdSize === 0xffffffff) return { error: 'a zip64 archive (over 4 GB or 65,535 files): its list isn’t read here' };
  const cd = readPart(file, cdOff, Math.min(cdSize, size - cdOff)), entries = [];
  let bytes = 0;
  for (let o = 0; o + 46 <= cd.length && cd.readUInt32LE(o) === 0x02014b50 && entries.length < 20000; ) {
    const flags = cd.readUInt16LE(o + 8), method = cd.readUInt16LE(o + 10), time = cd.readUInt16LE(o + 12), date = cd.readUInt16LE(o + 14);
    const crc = cd.readUInt32LE(o + 16), csize = cd.readUInt32LE(o + 20), usize = cd.readUInt32LE(o + 24);
    const nlen = cd.readUInt16LE(o + 28), xlen = cd.readUInt16LE(o + 30), clen = cd.readUInt16LE(o + 32), local = cd.readUInt32LE(o + 42);
    const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', o + 46, o + 46 + nlen);
    const two = (n) => String(n).padStart(2, '0');
    const when = ((date >> 9) + 1980) + '-' + two((date >> 5) & 15) + '-' + two(date & 31) + ' ' + two(time >> 11) + ':' + two((time >> 5) & 63);
    bytes += usize;
    entries.push({ name, flags, method, crc, csize, usize, local, when });
    o += 46 + nlen + xlen + clen;
  }
  return { count: total, bytes, entries };
};
const zipList = (file) => {
  const z = zipEntries(file);
  return z.error ? z : { count: z.count, bytes: z.bytes, lines: z.entries.map(e => String(e.usize).padStart(11, ' ') + '  ' + e.when + '  ' + e.name), files: z.entries.map(e => ({ name: e.name, size: e.usize })) };
};
// two zips / jars file by file (by name, CRC and size): added +, removed -, changed ~
const zipCompare = (fa, fb) => {
  const x = zipEntries(fa), y = zipEntries(fb);
  if (x.error || y.error) return null;
  const old = new Map(x.entries.map(e => [e.name, e])), out = [];
  for (const e of y.entries) {
    const o = old.get(e.name);
    if (!o) out.push('+ ' + e.name + '  (' + e.usize + ' bytes)');
    else if (o.crc !== e.crc || o.usize !== e.usize) out.push('~ ' + e.name + '  (' + o.usize + ' → ' + e.usize + ' bytes)');
    old.delete(e.name);
  }
  for (const o of old.values()) out.push('- ' + o.name + '  (' + o.usize + ' bytes)');
  return out.sort((p, q) => p.slice(2).localeCompare(q.slice(2))).slice(0, 2000);
};
// one file's bytes out of a zip / jar, in memory: { data } or { error } ({ missing } when it isn't in it)
const zipRead = (file, name) => {
  const z = zipEntries(file);
  if (z.error) return z;
  const e = z.entries.find(x => x.name === name);
  if (!e || name.endsWith('/')) return { error: 'no such file in it', missing: true };
  if (e.flags & 1) return { error: 'it is encrypted' };
  if (e.method !== 0 && e.method !== 8) return { error: 'packed in a way not read here (method ' + e.method + ')' };
  if (e.usize > 64 * 1024 * 1024) return { error: 'too big to copy out here (over 64 MB)' };
  const zlib = require('zlib'), lh = readPart(file, e.local, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) return { error: 'its entry is damaged' };
  const raw = readPart(file, e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), e.csize);
  const data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
  if (typeof zlib.crc32 === 'function' && zlib.crc32(data) >>> 0 !== e.crc) return { error: 'its data is damaged (CRC differs)' };
  return { data };
};
// one file inside two copies of a zip / jar, compared: a class by javap (both written to <cache>\diff and removed
// after), text as text, anything else as its readable text and hex. An added / removed file compares with nothing.
const zipEntryDiff = (oldZip, newZip, name, cache, pf) => {
  const x = zipRead(oldZip, name), y = zipRead(newZip, name);
  if ((x.error && !x.missing) || (y.error && !y.missing)) return { error: x.error || y.error };
  const a = x.data || Buffer.alloc(0), b = y.data || Buffer.alloc(0);
  if (a.equals(b)) return { same: true };
  if (/\.class$/i.test(name) && a.length && b.length) {
    const exe = findJavap(pf);
    if (exe) {
      const dir = path.join(cache, 'diff'), base = path.join(dir, process.pid + '-' + Date.now()), fa = base + '-old.class', fb = base + '-new.class';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fa, a); fs.writeFileSync(fb, b);
      try {
        const diff = textDiff(cache, javapOf(exe, fa) + '\n', javapOf(exe, fb) + '\n');
        return { kind: 'javap', diff: diff.trim() ? diff : textDiff(cache, javapOf(exe, fa, ['-l', '-p']) + '\n', javapOf(exe, fb, ['-l', '-p']) + '\n'), debug: !diff.trim() };
      } finally { fs.rmSync(fa, { force: true }); fs.rmSync(fb, { force: true }); }
    }
  }
  if (!a.subarray(0, 8000).includes(0) && !b.subarray(0, 8000).includes(0)) return { kind: 'text', diff: textDiff(cache, a.toString('utf8'), b.toString('utf8')) };
  return { kind: 'binary', diff: textDiff(cache, stringsOf(a).join('\n') + '\n', stringsOf(b).join('\n') + '\n'), hex: hexDiff(a, b) };
};
// one file out of a zip / jar, into <cache>\zip\<hash of the zip's version and the name>\<its name> (stored or
// deflated only, 64 MB at most, its CRC checked); of the entry's name only its last part is used, cleaned
const zipGet = (file, name, cache) => {
  const got = zipRead(file, name);
  if (got.error) return { error: got.error };
  const data = got.data, st = fs.statSync(file);
  const dir = path.join(cache, 'zip', require('crypto').createHash('sha1').update(path.resolve(file).toLowerCase() + '|' + st.size + '|' + st.mtimeMs + '|' + name).digest('hex').slice(0, 16));
  const dest = path.join(dir, (name.split(/[\\/]/).pop() || 'file').replace(/[^\w.-]/g, '_').replace(/^\.+/, '_'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest + '.part', data);
  fs.renameSync(dest + '.part', dest);
  return { ok: true, file: dest };
};
// ILSpy's C# for a .NET DLL (it reads the DLL; nothing in it runs), cached in <cache>\ilspy by SHA-256
const ilspyOf = (file, cache) => {
  const exe = path.join(process.env.USERPROFILE || '', '.dotnet', 'tools', 'ilspycmd.exe');
  const buf = !fs.existsSync(exe) || fs.statSync(file).size > 64 * 1024 * 1024 ? null : fs.readFileSync(file);
  const pe = buf && describePe(buf);
  if (!fs.existsSync(exe)) return { error: "ILSpy isn't installed (dotnet tool install -g ilspycmd)" };
  if (!buf) return { error: 'too big to decompile here (over 64 MB)' };
  if (!pe || !pe.dotnet) return { error: 'not a .NET DLL (machine code: Info shows what it exports and imports)' };
  const dir = path.join(cache, 'ilspy');
  const cached = path.join(dir, require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 32) + '-' + path.basename(file).replace(/[^\w.-]/g, '_') + '.cs');
  if (!fs.existsSync(cached)) {
    const r = require('child_process').spawnSync(exe, [file], { windowsHide: true, timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return { error: 'ILSpy failed: ' + String(r.stderr || r.error || '').split('\n')[0] };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cached + '.part', r.stdout);
    fs.renameSync(cached + '.part', cached);
  }
  return { ok: true, file: cached };
};
try {
  if (cmd === 'page') {
    const f = a[0], start = Number(a[1]), max = Number(a[2]);
    const size = fs.statSync(f).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(max, size - start)));
    const fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    let used = buf, end = start + buf.length;
    if (end < size) { const nl = buf.lastIndexOf(10); if (nl >= 0) { used = buf.subarray(0, nl + 1); end = start + nl + 1; } }
    out({ start, end, size, binary: used.subarray(0, 8000).includes(0), text: used.toString('utf8') });
  } else if (cmd === 'npmcli') {
    // npm's own script beside this Node (Project → Checks runs it with node: no cmd.exe for the npm.cmd shim)
    const file = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    out(fs.existsSync(file) ? { file } : { error: 'npm not found beside Node (' + path.dirname(process.execPath) + ')' });
  } else if (cmd === 'backup') {
    fs.mkdirSync(a[1], { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let dest = path.join(a[1], stamp + '-' + path.basename(a[0]));
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(a[1], stamp + '-' + i + '-' + path.basename(a[0]));
    fs.copyFileSync(a[0], dest, fs.constants.COPYFILE_EXCL);
    out({ ok: true, backup: dest });
  } else if (cmd === 'splice') {
    const f = a[0], start = Number(a[1]), end = Number(a[2]);
    const input = fs.readFileSync(0);
    const old = fs.readFileSync(f);
    swap(f, Buffer.concat([old.subarray(0, start), input, old.subarray(end)]));
    out({ ok: true, end: start + input.length });
  } else if (cmd === 'gitblob') {
    // gitblob <file> <out>: the file as it was at the last commit (binary safe), or {missing}
    const { spawnSync } = require('child_process');
    const dir = path.dirname(a[0]);
    const top = (spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).stdout || '').trim();
    const rel = top ? path.relative(top, a[0]).split(path.sep).join('/') : '';
    const r = top ? spawnSync('git', ['show', 'HEAD:' + rel], { cwd: top, maxBuffer: 256 * 1024 * 1024 }) : null;
    if (!r || r.status !== 0) out({ missing: true });
    else { fs.mkdirSync(path.dirname(a[1]), { recursive: true }); fs.writeFileSync(a[1], r.stdout); out({ ok: true, rel }); }
  } else if (cmd === 'rmtemp') {
    // rmtemp <cache dir> <file>: removes the pane's own last-commit-<time>.<ext> there, and nothing else
    const dir = path.resolve(a[0]), f = path.resolve(a[1]);
    if (path.dirname(f).toLowerCase() !== dir.toLowerCase() || !/^last-commit-\d+\.[A-Za-z0-9]{1,8}$/.test(path.basename(f))) out({ error: 'not a pane temp file' });
    else { fs.rmSync(f, { force: true }); out({ ok: true }); }
  } else if (cmd === 'dirsizes') {
    // dirsizes <folder>…: each folder's total size and file count, walked without following links or junctions
    // (no loops), all of them within 15 s and 400,000 entries; a folder cut short says partial
    const deadline = Date.now() + 15000;
    let budget = 400000;
    const sizes = {};
    for (const top of a.slice(0, 200)) {
      let bytes = 0, files = 0, partial = false;
      const stack = [top];
      while (stack.length) {
        if (Date.now() > deadline || budget <= 0) { partial = true; break; }
        const d = stack.pop();
        let list = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const x of list) {
          budget--;
          const f = path.join(d, x.name);
          if (x.isSymbolicLink()) continue;
          if (x.isDirectory()) stack.push(f);
          else if (x.isFile()) { try { bytes += fs.lstatSync(f).size; files++; } catch { /* gone */ } }
        }
      }
      sizes[top] = { bytes, files, partial };
    }
    out({ ok: true, sizes });
  } else if (cmd === 'lines') {
    // lines <root>, stdin a JSON list of paths under it: each file's line count (-1: binary, over 16 MB, outside, gone)
    const root = path.resolve(a[0]), counts = {};
    for (const rel of JSON.parse(fs.readFileSync(0, 'utf8') || '[]').slice(0, 5000)) {
      const f = path.resolve(root, String(rel));
      let n = -1;
      try {
        if (f.toLowerCase().startsWith(root.toLowerCase() + path.sep) && fs.statSync(f).size <= 16 * 1024 * 1024) {
          const b = fs.readFileSync(f);
          if (!b.subarray(0, 8000).includes(0)) {
            n = 0;
            for (let i = 0; i < b.length; i++) if (b[i] === 10) n++;
            if (b.length && b[b.length - 1] !== 10) n++;
          }
        }
      } catch { /* gone or unreadable: -1 */ }
      counts[rel] = n;
    }
    out({ ok: true, counts });
  } else if (cmd === 'restore') {
    swap(a[1], fs.readFileSync(a[0]));
    out({ ok: true });
  } else if (cmd === 'probe') {
    // probe <model> <cache dir> <Program Files> [bycontent]: Heimdall3D's still of a .glb / .gltf (400 px), cached in
    // <cache>\heimdall by path, size and modified time (bycontent: by its bytes, for a git temp copy). Its GPU mode
    // draws materials and textures (2-4 s); the plain mode (a grey clay render) only when that fails. Only the probe
    // under Program Files runs, on this one file, with a timeout; the model is its input, nothing in it runs here.
    const exe = path.join(a[2] || '', 'Heimdall3D', 'heimdall_probe.exe');
    const st = fs.statSync(a[0]);
    if (!/^[A-Za-z]:\\/.test(exe) || !fs.existsSync(exe)) out({ error: "Heimdall3D isn't installed (no heimdall_probe.exe under Program Files)" });
    else {
      const crypto = require('crypto');
      const key = (a[3] === 'bycontent' ? crypto.createHash('sha1').update('gpu|').update(fs.readFileSync(a[0])) : crypto.createHash('sha1').update('gpu|' + path.resolve(a[0]).toLowerCase() + '|' + st.size + '|' + st.mtimeMs)).digest('hex').slice(0, 32);
      // the GPU render is <key>.png, the plain one <key>-plain.png (so a cached one still says which it is)
      const dir = path.join(a[1], 'heimdall'), file = path.join(dir, key + '.png'), plainFile = path.join(dir, key + '-plain.png');
      if (fs.existsSync(file)) out({ ok: true, file, gpu: true, cached: true });
      else if (fs.existsSync(plainFile)) out({ ok: true, file: plainFile, gpu: false, cached: true });
      else {
        fs.mkdirSync(dir, { recursive: true });
        const part = path.join(dir, key + '.part.png');
        const run = (args) => { fs.rmSync(part, { force: true }); return require('child_process').spawnSync(exe, args, { windowsHide: true, timeout: 60000, encoding: 'utf8' }); };
        let r = run(['--gpu', a[0], part, '--size', '400', '--samples', '16']), gpu = r.status === 0 && fs.existsSync(part);
        if (!gpu) r = run([a[0], part, '--size', '400', '--budget', 'thumbnail']);
        if (r.status !== 0 || !fs.existsSync(part)) out({ error: "Heimdall3D couldn't render it: " + (String(r.stderr || r.stdout || r.error || 'no picture').trim().split(/\r?\n/)[0] || 'no picture') });
        else { fs.renameSync(part, gpu ? file : plainFile); out({ ok: true, file: gpu ? file : plainFile, gpu }); }
      }
    }
  } else if (cmd === 'bininfo') {
    // bininfo <file>: what a binary is (by its first bytes) and, for a DLL / EXE, what its PE headers say (read only)
    const size = fs.statSync(a[0]).size;
    const b = readPart(a[0], 0, Math.min(size, 64 * 1024 * 1024));
    const pe = describePe(b);
    out({ size, kind: magic(b), pe: pe ? pe.lines : null, dotnet: Boolean(pe && pe.dotnet) });
  } else if (cmd === 'strings') {
    // strings <file> <start>: the readable text in 1 MiB from <start> (ASCII and UTF-16 runs of 5+ with a word in
    // them: names, messages, paths), with offsets
    const start = Number(a[1]), size = fs.statSync(a[0]).size, len = Math.min(1024 * 1024, Math.max(0, size - start));
    const s = readPart(a[0], start, len).toString('latin1');
    // a word of 4+ letters and mostly letters: drops the chance runs in compiled code (K1KGK\K~K)
    const found = [], wordy = (t) => /[A-Za-z]{4}/.test(t) && (t.match(/[A-Za-z]/g) || []).length >= t.length / 2;
    for (const m of s.matchAll(/[\x20-\x7e]{5,}/g)) if (wordy(m[0])) found.push([m.index, m[0]]);
    for (const m of s.matchAll(/(?:[\x20-\x7e]\x00){5,}/g)) { const t = m[0].replace(/\x00/g, ''); if (wordy(t)) found.push([m.index, t + '  (UTF-16)']); }
    found.sort((x, y) => x[0] - y[0]);
    out({ start, end: start + len, size, lines: found.slice(0, 3000).map(([o, t]) => (start + o).toString(16).padStart(8, '0') + '  ' + t.slice(0, 400)) });
  } else if (cmd === 'hex') {
    // hex <file> <start>: 4 KiB as lines of 16 bytes: offset, bytes, the printable ones
    const start = Number(a[1]), size = fs.statSync(a[0]).size;
    const b = readPart(a[0], start, Math.min(4096, Math.max(0, size - start)));
    const lines = [];
    for (let o = 0; o < b.length; o += 16) {
      const row = [...b.subarray(o, o + 16)];
      lines.push((start + o).toString(16).padStart(8, '0') + '  ' + row.map(x => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ') + '  ' + row.map(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join(''));
    }
    out({ start, end: start + b.length, size, lines });
  } else if (cmd === 'ilspy') {
    out(ilspyOf(a[0], a[1]));
  } else if (cmd === 'csdiff') {
    // csdiff <old dll> <new dll> <cache dir>: ILSpy's C# of both copies (each cached by its SHA-256) as a unified diff
    const x = ilspyOf(a[0], a[2]), y = x.error ? x : ilspyOf(a[1], a[2]);
    if (x.error || y.error) out({ error: x.error || y.error });
    else out({ diff: textDiff(a[2], fs.readFileSync(x.file, 'utf8'), fs.readFileSync(y.file, 'utf8')) });
  } else if (cmd === 'zipget') {
    // zipget <zip> <name> <cache dir>: one file out of a zip / jar into the cache, to open read only
    out(zipGet(a[0], a[1], a[2]));
  } else if (cmd === 'zipentry') {
    // zipentry <old zip> <new zip> <name> <cache dir> <Program Files>: that one file in both copies, compared
    out(zipEntryDiff(a[0], a[1], a[2], a[3], a[4]));
  } else if (cmd === 'bindiff') {
    // bindiff <old> <new> <cache dir>: two versions of a binary, as their readable text (a unified diff) and the hex
    // around where the bytes differ. 64 MiB each at most; read only.
    const sa = fs.statSync(a[0]).size, sb = fs.statSync(a[1]).size;
    if (sa > 64 * 1024 * 1024 || sb > 64 * 1024 * 1024) out({ error: 'too big to compare here (over 64 MB)' });
    else {
      const x = fs.readFileSync(a[0]), y = fs.readFileSync(a[1]);
      const same = x.equals(y);
      // two zips / jars: also which files inside changed
      const zips = !same && magic(x).startsWith('zip') && magic(y).startsWith('zip') ? zipCompare(a[0], a[1]) : null;
      out({ same, oldSize: sa, newSize: sb, files: zips, text: same ? '' : textDiff(a[2], stringsOf(x).join('\n') + '\n', stringsOf(y).join('\n') + '\n'), hex: same ? [] : hexDiff(x, y) });
    }
  } else if (cmd === 'javap') {
    // javap <class> <Program Files> [<old class> <cache dir>]: a Java class's bytecode (javap -c -p), or the diff of
    // an older copy's against it. The JDK's javap reads the class; nothing in it runs.
    const exe = findJavap(a[1]);
    if (!exe) out({ error: "no JDK's javap found under Program Files (Eclipse Adoptium, Java, Microsoft, Zulu, BellSoft)" });
    else if (fs.statSync(a[0]).size > 16 * 1024 * 1024) out({ error: 'too big for javap here (over 16 MB)' });
    else if (a[2]) {
      // the same bytecode: what changed may be only debug info (line numbers, local names after a recompile): javap -l
      const diff = textDiff(a[3], javapOf(exe, a[2]) + '\n', javapOf(exe, a[0]) + '\n');
      out({ diff, debugDiff: diff.trim() ? '' : textDiff(a[3], javapOf(exe, a[2], ['-l', '-p']) + '\n', javapOf(exe, a[0], ['-l', '-p']) + '\n'), javap: exe });
    }
    else out({ text: javapOf(exe, a[0]), javap: exe });
  } else if (cmd === 'pcache') {
    // pcache get|put <cache dir> <key>: a drawn preview (the pane's JSON, on stdin for put) kept in <cache>\previews,
    // named by the key's hash (the key holds the file's path, size and modified time, so a changed file misses)
    const dir = path.join(a[1], 'previews'), f = path.join(dir, require('crypto').createHash('sha1').update(a[2]).digest('hex').slice(0, 32) + '.json');
    if (a[0] === 'get') out(fs.existsSync(f) ? { value: JSON.parse(fs.readFileSync(f, 'utf8')) } : {});
    else { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f + '.part', fs.readFileSync(0)); fs.renameSync(f + '.part', f); out({ ok: true }); }
  } else if (cmd === 'ziplist') {
    // ziplist <file>: the files in a zip / jar (size, date, name), from its central directory
    out(zipList(a[0]));
  } else out({ error: 'unknown command' });
} catch (e) { out({ error: String((e && e.message) || e) }); }
