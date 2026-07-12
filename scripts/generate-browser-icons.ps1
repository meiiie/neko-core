param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\browser-extension\icons")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

foreach ($size in @(16, 32, 48, 128)) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $s = $size / 128.0

    $body = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $body.AddArc(16 * $s, 28 * $s, 24 * $s, 24 * $s, 180, 90)
    $body.AddArc(88 * $s, 28 * $s, 24 * $s, 24 * $s, 270, 90)
    $body.AddArc(88 * $s, 88 * $s, 24 * $s, 24 * $s, 0, 90)
    $body.AddArc(16 * $s, 88 * $s, 24 * $s, 24 * $s, 90, 90)
    $body.CloseFigure()
    $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 11, 11, 11)), $body)

    $amber = [System.Drawing.Color]::FromArgb(255, 245, 158, 11)
    $earBrush = [System.Drawing.SolidBrush]::new($amber)
    $leftEar = @(
      [System.Drawing.PointF]::new(23 * $s, 34 * $s),
      [System.Drawing.PointF]::new(35 * $s, 15 * $s),
      [System.Drawing.PointF]::new(48 * $s, 34 * $s)
    )
    $rightEar = @(
      [System.Drawing.PointF]::new(80 * $s, 34 * $s),
      [System.Drawing.PointF]::new(93 * $s, 15 * $s),
      [System.Drawing.PointF]::new(105 * $s, 34 * $s)
    )
    $graphics.FillPolygon($earBrush, $leftEar)
    $graphics.FillPolygon($earBrush, $rightEar)

    $border = [System.Drawing.Pen]::new($amber, [Math]::Max(1.0, 4 * $s))
    $graphics.DrawPath($border, $body)
    $cyan = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 34, 211, 238))
    $graphics.FillEllipse($cyan, 40 * $s, 59 * $s, 9 * $s, 9 * $s)
    $graphics.FillEllipse($cyan, 79 * $s, 59 * $s, 9 * $s, 9 * $s)
    $prompt = [System.Drawing.Pen]::new($amber, [Math]::Max(1.0, 5 * $s))
    $prompt.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $prompt.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($prompt, 50 * $s, 84 * $s, 62 * $s, 92 * $s)
    $graphics.DrawLine($prompt, 62 * $s, 92 * $s, 50 * $s, 100 * $s)
    $graphics.DrawLine($prompt, 70 * $s, 100 * $s, 88 * $s, 100 * $s)

    $path = Join-Path $OutputDirectory "icon-$size.png"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

Write-Output "Generated browser extension icons in $OutputDirectory"
