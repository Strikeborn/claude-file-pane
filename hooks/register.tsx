import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BinView, Change, CheckResult, OpenFile, Tick } from '../types'
import { NEXT_HEADING, blocksFrom, boxesIn, commitsFrom, featuresFrom, flipTask, headingPath, releasesFrom, sections, sideBySide, splitBoxes, tasks } from './project'
import type { Block, Task, TimelineEntry } from './project'
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
const wrapAtom = atom({ plugin: 'file-pane', key: 'wrap' } as const, true)
const binViewAtom = atom({ plugin: 'file-pane', key: 'binView' } as const, { path: '', mode: 'info', at: 0 } as BinView)
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
// Windows' own imaging (System.Drawing) makes a small PNG of a picture: the desktop pane draws pictures as SVG
const THUMB_PS = `param($p, $max)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($p)
try {
  $s = [Math]::Min(1.0, [double]$max / [Math]::Max($img.Width, $img.Height))
  $w = [int][Math]::Max(1, $img.Width * $s); $h = [int][Math]::Max(1, $img.Height * $s)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($img, 0, 0, $w, $h)
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  @{ w = $img.Width; h = $img.Height; tw = $w; th = $h; b64 = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress
} finally { $img.Dispose() }`
// 3D models and other files Windows can preview: what Explorer shows (Heimdall3D, Blender's BlendThumb, …)
const MODEL = /\.(fbx|obj|stl|3mf|ply|dae|glb|gltf|blend|exr|hdr|dds|tga|tiff?|psd|webp|heic)$/i
// the ones that are text, so Edit as text makes sense
const MODEL_TEXT = /\.(obj|gltf|dae|ply)$/i
// The shell thumbnail (IShellItemImageFactory, as Explorer asks for it), same JSON as THUMB_PS plus `via` (the
// provider's DLL). Only a provider under Program Files or Windows is loaded; any other gets Explorer's cached
// thumbnail at most (SIIGBF_INCACHEONLY loads no provider). The model is the provider's to read: nothing runs it here.
const SHELL_THUMB_PS = String.raw`param($p, $max)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class FilePaneShellThumb {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outp, ref int len);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  // the thumbnail provider Windows picks for this extension, as Explorer resolves it
  public static string Provider(string ext) {
    var sb = new StringBuilder(260); int n = sb.Capacity;
    return AssocQueryString(0, 16 /* ASSOCSTR_SHELLEXTENSION */, ext, "{e357fccd-a995-4576-b01f-234630154e96}", sb, ref n) == 0 ? sb.ToString() : null;
  }
  public static Bitmap Get(string path, int size, bool cacheOnly) {
    IShellItemImageFactory f;
    SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
    IntPtr hbm;
    // SIIGBF_THUMBNAILONLY (no icon instead), SIIGBF_INCACHEONLY (no provider loaded, only what Explorer cached)
    int hr = f.GetImage(new SIZE { cx = size, cy = size }, 0x8 | (cacheOnly ? 0x10 : 0), out hbm);
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    try {
      using (var b = Image.FromHbitmap(hbm)) {
        // FromHbitmap drops alpha: read the 32-bit pixels as ARGB when any are see-through
        var r = new Rectangle(0, 0, b.Width, b.Height);
        var d = b.LockBits(r, ImageLockMode.ReadOnly, b.PixelFormat);
        try {
          if (Image.GetPixelFormatSize(b.PixelFormat) == 32) {
            // row by row: the stride is negative for a bottom-up bitmap
            int row = d.Width * 4;
            var bytes = new byte[row * d.Height];
            for (int y = 0; y < d.Height; y++) Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), bytes, y * row, row);
            bool alpha = false;
            for (int i = 3; i < bytes.Length; i += 4) if (bytes[i] != 0) { alpha = true; break; }
            if (alpha) {
              var a = new Bitmap(d.Width, d.Height, PixelFormat.Format32bppArgb);
              var ad = a.LockBits(r, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
              for (int y = 0; y < d.Height; y++) Marshal.Copy(bytes, y * row, new IntPtr(ad.Scan0.ToInt64() + (long)y * ad.Stride), row);
              a.UnlockBits(ad);
              return a;
            }
          }
        } finally { b.UnlockBits(d); }
        return new Bitmap(b);
      }
    } finally { DeleteObject(hbm); }
  }
}
'@
$ext = [IO.Path]::GetExtension($p)
$clsid = [FilePaneShellThumb]::Provider($ext)
if (-not $clsid) { @{ error = "Windows has no thumbnail maker for $ext files" } | ConvertTo-Json -Compress; return }
$dll = ''
try { $dll = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\CLSID\$clsid\InprocServer32" -ErrorAction Stop).'(default)' } catch {}
$dll = [Environment]::ExpandEnvironmentVariables([string]$dll).Trim('"')
# only providers Windows or an installer put in a folder normal programs can't write to
$safe = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:SystemRoot) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') + '\' }
$full = if ($dll -and [IO.Path]::IsPathRooted($dll)) { [IO.Path]::GetFullPath($dll) } else { '' }
$trusted = [bool]($full -and ($safe | Where-Object { $full.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }))
try {
  $bmp = [FilePaneShellThumb]::Get($p, [int]$max, -not $trusted)
} catch {
  $why = if ($trusted) { "$($_.Exception.InnerException.Message)".Trim() } else { "its thumbnail maker ($([IO.Path]::GetFileName($full))) isn't under Program Files or Windows, so the pane won't load it, and Explorer has no saved thumbnail" }
  @{ error = $why; via = [IO.Path]::GetFileName($full) } | ConvertTo-Json -Compress; return
}
$ms = New-Object IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
@{ w = $bmp.Width; h = $bmp.Height; tw = $bmp.Width; th = $bmp.Height; b64 = [Convert]::ToBase64String($ms.ToArray()); via = [IO.Path]::GetFileName($full) + $(if ($trusted) { '' } else { ', saved by Explorer' }) } | ConvertTo-Json -Compress
$bmp.Dispose()`
const GIT_COLOR: Record<string, string> = { new: 'success', changed: 'warning', added: 'success', deleted: 'error', renamed: 'merged' }
// text typed into an item / section / add box, by its editing key (kept out of state: no redraw per key)
const typed = new Map<string, string>()
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
// a document drawn at most this long (the pane draws 100,000 characters in all)
const DRAW = 80_000
const SHORT_DOC = 25_000

// what's typed in the editor (kept out of state: a redraw per key would fight the typing)
let draft: { key: string; text: string } | null = null

// the helper: page <file> <start> <max> · backup <file> <dir> · splice <file> <start> <end> (new bytes on stdin)
// · restore <backup> <file>. Prints one JSON line. Writes go to a temp file renamed over the original.
const HELPER = String.raw`
const fs = require('fs'), path = require('path');
const [cmd, ...a] = process.argv.slice(1);
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
  } else if (cmd === 'restore') {
    swap(a[1], fs.readFileSync(a[0]));
    out({ ok: true });
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
    // ilspy <dll> <cache dir>: ILSpy's C# for a .NET DLL (it reads the DLL; nothing in it runs), cached by SHA-256
    const exe = path.join(process.env.USERPROFILE || '', '.dotnet', 'tools', 'ilspycmd.exe');
    const buf = !fs.existsSync(exe) || fs.statSync(a[0]).size > 64 * 1024 * 1024 ? null : fs.readFileSync(a[0]);
    const pe = buf && describePe(buf);
    if (!fs.existsSync(exe)) out({ error: "ILSpy isn't installed (dotnet tool install -g ilspycmd)" });
    else if (!buf) out({ error: 'too big to decompile here (over 64 MB)' });
    else if (!pe || !pe.dotnet) out({ error: 'not a .NET DLL (machine code: Info shows what it exports and imports)' });
    else {
      const dir = path.join(a[1], 'ilspy');
      const cached = path.join(dir, require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 32) + '-' + path.basename(a[0]).replace(/[^\w.-]/g, '_') + '.cs');
      let error = '';
      if (!fs.existsSync(cached)) {
        const r = require('child_process').spawnSync(exe, [a[0]], { windowsHide: true, timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
        if (r.status !== 0) error = 'ILSpy failed: ' + String(r.stderr || r.error || '').split('\n')[0];
        else {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(cached + '.part', r.stdout);
          fs.renameSync(cached + '.part', cached);
        }
      }
      out(error ? { error } : { ok: true, file: cached });
    }
  } else out({ error: 'unknown command' });
} catch (e) { out({ error: String((e && e.message) || e) }); }
`

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
async function recordChange($: EngineInterface, path: unknown, tool: string, ok: boolean): Promise<void> {
  if (!ok || typeof path !== 'string' || !path) return
  await update($, changesAtom, list => {
    const old = list.find(c => c.path.toLowerCase() === path.toLowerCase())
    const rest = list.filter(c => c !== old)
    return [{ path, tool, at: Date.now(), n: (old?.n ?? 0) + 1 }, ...rest].slice(0, 300)
  })
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
    const r = await next(e)
    await recordChange($, e.file_path, 'Edit', r.deny === undefined && r.isError !== true)
    return r
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const r = await next(e)
    await recordChange($, e.file_path, 'Write', r.deny === undefined && r.isError !== true)
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
    const thumb = async (path: string, shell = false): Promise<{ w: number; h: number; tw: number; th: number; b64: string; via?: string } | string> => {
      for (const max of [420, 280, 160]) {
        try {
          const q = (s: string) => `'${s.replace(/'/g, "''")}'`
          const r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `& { ${shell ? SHELL_THUMB_PS : THUMB_PS} } ${q(path)} ${max}`], { timeoutMs: 45_000 })
          const j = JSON.parse(r.stdout.trim() || '{}') as { w: number; h: number; tw: number; th: number; b64: string; via?: string; error?: string }
          if (!j.b64) return (j.error || r.stderr || 'Windows imaging could not read it').split(/\r?\n/)[0]!
          if (j.b64.length < 120_000) return j
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      }
      return 'too detailed to preview here'
    }
    const picture = (key: string, t: { w: number; h: number; tw: number; th: number; b64: string }, alt: string) =>
      Svg ? (
        <Svg
          key={key}
          alt={alt}
          width={t.tw}
          height={t.th}
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${t.tw}" height="${t.th}" viewBox="0 0 ${t.tw} ${t.th}"><image href="data:image/png;base64,${t.b64}" width="${t.tw}" height="${t.th}"/></svg>`}
        />
      ) : (
        <Text dimColor>{alt}</Text>
      )
    const showDiff = await read($, diffOpenAtom)
    const side = await read($, sideAtom)
    // ↩ Wrap: long lines continue on more rows, or stay one row cut at the edge (every Text / Code the pane draws)
    const wrap = await read($, wrapAtom)
    const wrapMode = wrap ? ('wrap' as const) : ('truncate-end' as const)
    // a diff, one column (colored by the Code element) or two (before | after)
    const diffView = (k: string, text: string) => {
      if (!side) return Code ? <Code key={`dv:${k}`} source={text} format="diff" wrap={wrapMode} /> : <Text key={`dv:${k}`} wrap={wrapMode}>{text}</Text>
      const rows = sideBySide(text).slice(0, 1500)
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
                      {v === undefined ? ' ' : `${changed ? (which === 'left' ? '- ' : '+ ') : '  '}${v || ' '}`}
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
                {v === undefined ? ' ' : `${changed ? (which === 'left' ? '- ' : '+ ') : '  '}${v || ' '}`}
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
    const sideToggle = (
      <Button key="side" variant={side ? 'primary' : 'secondary'} onPress={() => void update($, sideAtom, v => !v)}>
        ⇆ Side by side
      </Button>
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
        const r = await $.process.run(['node', '-e', HELPER, ...args], { stdin, timeoutMs: 120_000 })
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
      lines[line] = flipTask(raw)
      const b = await backupOf(path)
      if (!b.ok) return say(`Not changed: the backup copy failed (${String(b.error ?? 'unknown')}).`)
      const r = await helper(['splice', path, '0', String(st.size)], lines.join(eol))
      if (!r.ok) return say(`Not changed: ${String(r.error ?? 'unknown')}.`)
      // logged for "what did I finish, when, where" (the pane's list, the ticks tool), and kept for Undo
      // the first box is the one flipped: it was empty, so now it's ticked
      const done = /\[( |x|X)\]/.exec(raw)?.[1] === ' '
      const tick: Tick = { path, item: raw.replace(/^\s*[-*+]\s+\[.\]\s*/, ''), headings: headingPath(lines, line), done, at: Date.now(), line, raw: lines[line]! }
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
      untracked ? await git(root, ['diff', '--no-index', '--', '/dev/null', rel]) : await git(root, ['diff', 'HEAD', '--', rel])
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
          ? (await read($, changesAtom)).map(c => ({ path: c.path, rel: rel(c.path).replace(/\\/g, '/'), note: `${c.tool}${c.n > 1 ? ` ×${c.n}` : ''} · ${new Date(c.at).toLocaleTimeString()}` }))
          : [...states.entries()].map(([r, x]) => ({ path: join(root, r), rel: r, note: label(x) }))
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
      if (isSvg) {
        const src = await $.fs.read(f.path).catch(() => '')
        now = src.length <= 131_072 && /<svg[\s>]/i.test(src) ? src : null
        if (!now) note = src ? 'This SVG is too large or not an SVG to draw here: Edit as text shows it.' : "Couldn't read it."
      } else {
        const t = await thumb(f.path, shell)
        if (typeof t === 'string') note = `No preview: ${t}`
        else now = t
      }
      if (showDiff.includes(diffKey)) {
        const tmp = join(cacheDir, `last-commit-${Date.now()}${f.path.slice(f.path.lastIndexOf('.'))}`)
        const g = await helper(['gitblob', f.path, tmp])
        if (g.ok) {
          if (isSvg) before = await $.fs.read(tmp).catch(() => null)
          else {
            const t = await thumb(tmp, shell)
            before = typeof t === 'string' ? null : t
          }
          void helper(['rmtemp', cacheDir, tmp])
        } else note = note || 'Not in git at the last commit (new, or outside a git folder).'
      }
      const draw = (k: string, v: unknown, alt: string) =>
        typeof v === 'string' ? (Svg ? <Svg key={k} alt={alt} source={v} isInteractive /> : <Text wrap={wrapMode} dimColor>{alt}</Text>) : v ? picture(k, v as never, alt) : null
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
            {fileTools(f.path)}
          </Box>
          {note ? <Text wrap={wrapMode} color="warning">{note}</Text> : null}
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
      const r = binCache.get(binKey) ?? (await helper(bv.mode === 'info' ? ['bininfo', f.path] : [bv.mode === 'text' ? 'strings' : 'hex', f.path, String(bv.at)]))
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
          : lines.join('\n') || (bv.mode === 'text' ? '(no readable text in this part)' : '')
      const decompile = async () => {
        await say('Decompiling with ILSpy (a few seconds the first time; kept after that)…')
        const d = await helper(['ilspy', f.path, cacheDir])
        if (d.error || typeof d.file !== 'string') return say(`No C#: ${String(d.error ?? 'ILSpy gave nothing')}`)
        await openPath(d.file)
        await say(`C# of ${f.path.slice(Math.max(f.path.lastIndexOf('\\'), f.path.lastIndexOf('/')) + 1)} by ILSpy (a cached copy: editing it changes nothing).`)
      }
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
            {bv.mode === 'info' && r.dotnet ? <Button key="bin-cs" label="C# (ILSpy)" onPress={() => void decompile()} /> : null}
          </Box>
          {r.error ? <Text wrap={wrapMode} color="error">{`Couldn't read it: ${String(r.error)}`}</Text> : null}
          {bv.mode !== 'info' ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="bin-prev" label="◀ Earlier" onPress={() => void setBv({ at: Math.max(0, bv.at - step) })} />
              <Button key="bin-next" label="Later ▶" onPress={() => void (end < size ? setBv({ at: end }) : say('That was the end of the file.'))} />
              <Text wrap={wrapMode} dimColor>
                {`bytes ${bv.at.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${size.toLocaleString('en-US')}${bv.mode === 'text' && lines.length >= 3000 ? ' · first 3,000 lines of this part' : ''}`}
              </Text>
            </Box>
          ) : null}
          {noteBlock(f.path)}
          {Code ? <Code key={`bin:${bv.mode}`} source={body.slice(0, DRAW)} wrap={wrapMode} /> : <Text wrap={wrapMode}>{body.slice(0, DRAW)}</Text>}
        </Box>
      )
    }

    if (open) {
      const f = open
      const key = `${f.path}|${f.start}`
      const diffKey = `filediff:${f.path}`
      const fileDiffText = showDiff.includes(diffKey)
        ? (await $.process.run(['git', '-c', 'core.quotepath=false', 'diff', 'HEAD', '--', f.path], { cwd: parent(f.path), timeoutMs: 20_000 }).catch(() => ({ stdout: '' }))).stdout
        : ''
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
          {showDiff.includes(diffKey) ? sideToggle : null}
          {showDiff.includes(diffKey) ? (
            fileDiffText.trim() ? (
              diffView('filediff', fileDiffText.slice(0, 60_000))
            ) : (
              <Text wrap={wrapMode} dimColor>No changes since the last commit (or not in git).</Text>
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
