// The PowerShell scripts the pane runs (pure strings): Windows imaging for pictures, and the shell thumbnail.
// The Node helper is a file of its own, helper.cjs.

// Windows' own imaging (System.Drawing) makes a small PNG of a picture: the desktop pane draws pictures as SVG
export const THUMB_PS = `param($p, $max)
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
  $mime = 'png'
  # a detailed picture (a model's render) is too big as PNG for the pane: JPEG, on mid grey where it was see-through
  if ($ms.Length -gt 82000) {
    $flat = New-Object System.Drawing.Bitmap $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($flat)
    $g2.Clear([System.Drawing.Color]::FromArgb(128, 128, 128))
    $g2.DrawImage($bmp, 0, 0, $w, $h)
    $jpg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 88L
    $ms = New-Object IO.MemoryStream
    $flat.Save($ms, $jpg, $ep)
    $mime = 'jpeg'
  }
  @{ w = $img.Width; h = $img.Height; tw = $w; th = $h; mime = $mime; b64 = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress
} finally { $img.Dispose() }`

// The shell thumbnail (IShellItemImageFactory, as Explorer asks for it), same JSON as THUMB_PS plus `via` (the
// provider's DLL). Only a provider under Program Files or Windows is loaded; any other gets Explorer's cached
// thumbnail at most (SIIGBF_INCACHEONLY loads no provider). The model is the provider's to read: nothing runs it here.
export const SHELL_THUMB_PS = String.raw`param($p, $max)
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
