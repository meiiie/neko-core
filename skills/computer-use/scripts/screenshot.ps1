# Capture the primary screen to a DOWNSCALED JPEG (stays under NVIDIA's ~180 KB inline-image cap).
# Prints the scale factor so the driver can map vision coordinates back to real screen pixels:
#   real_x = vision_x / scale ,  real_y = vision_y / scale   (then feed to mouse.ps1).
# Usage:  powershell -NoProfile -File screenshot.ps1 <out.jpg> [width]
param([string]$out = "screen.jpg", [int]$width = 1024)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$sw=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$sh=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
$full=New-Object System.Drawing.Bitmap $sw,$sh
$g=[System.Drawing.Graphics]::FromImage($full); $g.CopyFromScreen(0,0,0,0,$full.Size)
$h=[int]($sh*$width/$sw)
$small=New-Object System.Drawing.Bitmap $width,$h
$g2=[System.Drawing.Graphics]::FromImage($small); $g2.InterpolationMode='HighQualityBicubic'; $g2.DrawImage($full,0,0,$width,$h)
$jpg=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object {$_.MimeType -eq 'image/jpeg'}
$p=New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality,[long]72)
$small.Save($out,$jpg,$p)
$g.Dispose();$g2.Dispose();$full.Dispose();$small.Dispose()
$scale=[math]::Round($width/$sw,4)
Write-Output "saved $out  view=${width}x${h}  screen=${sw}x${sh}  scale=$scale  (real = vision / $scale)"
