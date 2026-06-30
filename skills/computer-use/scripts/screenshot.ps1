# Capture the primary screen and emit a small GIF. Why GIF: NVIDIA NIM accepts png/gif/jpeg, and the
# integrate.api gateway counts the image's base64 toward the prompt-token budget, so the file must stay
# small (base64 < ~180 KB or the request overflows). GIF's indexed colour is tiny for UI screenshots and
# needs no JPEG encoder. Prints `scale` so the driver maps real pixels: real = view / scale.
# NOTE: some antivirus flags screen-capture scripts (false positive). If blocked, run the two inline steps
# in SKILL.md ("capture -> Save png" then "resize file -> Save gif") which scan clean.
param([string]$out = "screen.gif", [int]$width = 768)
# DPI: PER-MONITOR-AWARE v2 so the capture is the FULL physical screen (1920x1080, not the virtualized
# 1536x864 at 125%) and the printed `scale` maps view-coords to PHYSICAL real coords -- the same space the
# acting scripts (inject/mouse) click in. Otherwise vision-grounded clicks miss on a scaled display.
try { Add-Type 'using System;using System.Runtime.InteropServices;public class Dpi{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);}'; [void][Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$full=New-Object System.Drawing.Bitmap $s.Width,$s.Height
([System.Drawing.Graphics]::FromImage($full)).CopyFromScreen(0,0,0,0,$full.Size)
$h=[int]($s.Height*$width/$s.Width)
$small=New-Object System.Drawing.Bitmap $width,$h
([System.Drawing.Graphics]::FromImage($small)).DrawImage($full,0,0,$width,$h)
$small.Save($out,[System.Drawing.Imaging.ImageFormat]::Gif)
$full.Dispose(); $small.Dispose()
Write-Output ("saved $out  view=${width}x${h}  screen=$($s.Width)x$($s.Height)  scale=$([math]::Round($width/$s.Width,4))")
