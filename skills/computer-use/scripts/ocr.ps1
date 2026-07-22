# OCR perception for apps UIA cannot see (Chromium/Electron: Zalo, Discord, Slack, VS Code...).
# Captures the target window and runs the BUILT-IN Windows OCR engine (Windows.Media.Ocr) locally -
# no vision model, no download, no network. Emits each text line with the SCREEN-PIXEL centre so a
# text-only model can then click/type by coordinate. Coordinates are physical pixels (PerMonitorV2),
# the same space inject.ps1 taps in, so an OCR read -> click lands on a scaled display.
#
#   ocr.ps1                 -> OCR the foreground window
#   NEKO_UIA_WINDOW=Zalo ... -> OCR the window whose title contains "Zalo"
#
# Output: one line per recognized text line:  'the text' @ x,y     (x,y = screen-pixel centre)
# Vietnamese note: reads Latin text with whatever recognizer is installed; accents need the Windows
# Vietnamese OCR language pack (Settings > Language). Without it, unaccented Latin still reads.
param()
$ErrorActionPreference = "Stop"

# PerMonitorV2 so capture + coordinates are true physical pixels (matches inject/screenshot).
try { Add-Type 'using System;using System.Runtime.InteropServices;public class Dpi{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);}'; [void][Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
Add-Type 'using System;using System.Runtime.InteropServices;public class WinRect{[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L;public int T;public int R;public int B;}[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}'
Add-Type -AssemblyName System.Drawing

# --- target window (Win32 only; never UIA - UIA enumeration hangs on Chromium windows) ---
$q = $env:NEKO_UIA_WINDOW
if ($q) {
  $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$q*" } | Sort-Object { $_.MainWindowTitle.Length } | Select-Object -First 1
  if (-not $p) { Write-Output "(no window titled like '$q')"; exit 1 }
  $hwnd = $p.MainWindowHandle; $title = $p.MainWindowTitle
} else {
  $hwnd = [WinRect]::GetForegroundWindow(); $title = "(foreground)"
}
$r = New-Object WinRect+RECT
if (-not [WinRect]::GetWindowRect($hwnd, [ref]$r)) { Write-Output "(could not read window bounds)"; exit 1 }
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Output "(window has no visible area - is it minimized? run activate first)"; exit 1 }

# --- capture the window region to a temp PNG (SoftwareBitmap decodes cleanly from a file) ---
$png = Join-Path $env:TEMP ("neko_ocr_{0}.png" -f ([Guid]::NewGuid().ToString("N")))
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
try { $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy) } finally { $g.Dispose() }
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# --- WinRT async bridge (PowerShell 5.1 has no await) ---
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}
# Load the WinRT projections we use.
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  # Prefer the user's profile languages (picks Vietnamese if its OCR pack is installed); fall back to
  # any available recognizer (en-US reads Latin text, accents may drop without the vi pack).
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
    if ($langs.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langs[0]) }
  }
  if (-not $engine) { Write-Output "(no Windows OCR recognizer installed; add a language OCR pack in Settings > Language)"; exit 1 }

  $result = Await ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()

  Write-Output ("OCR window='{0}'  origin={1},{2}  size={3}x{4}  engine={5}" -f $title, $r.L, $r.T, $w, $h, $engine.RecognizerLanguage.LanguageTag)
  $n = 0
  foreach ($line in $result.Lines) {
    $words = $line.Words
    if ($words.Count -eq 0) { continue }
    # Line bounding box = union of its word rects; centre = screen pixel to click.
    $minX = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
    $minY = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
    $maxX = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
    $maxY = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
    $cx = [int]($r.L + ($minX + $maxX) / 2)
    $cy = [int]($r.T + ($minY + $maxY) / 2)
    Write-Output ("  '{0}' @ {1},{2}" -f $line.Text, $cx, $cy)
    $n++
  }
  if ($n -eq 0) { Write-Output "  (no text recognized - the window may be blank, an image, or mid-render)" }
} finally {
  Remove-Item $png -Force -ErrorAction SilentlyContinue
}
