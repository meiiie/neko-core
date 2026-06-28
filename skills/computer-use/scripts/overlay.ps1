# Clicky-style "agent is controlling" overlay (pixel-faithful to Clicky's OverlayWindow.swift):
#  - a blue (#3380FF) GLOWING triangle cursor, tilted -35 deg (cursor-like), apex pointing at the action;
#  - it FLIES to a new target along a quadratic bezier ARC (control point = midpoint lifted by
#    min(dist*0.2, 80)), with a scale bump at mid-flight -- not a jump (Clicky's signature gesture);
#  - a small label bubble beside it ("Neko", or the first line of a status file);
#  - a coloured screen border + a top banner;
#  - a low-level mouse hook flips to PAUSED on a REAL (non-injected) user click and writes the stop-file.
# The OS has ONE physical cursor, so this is a VISUAL agent-cursor over the shared one (same as Clicky);
# true input separation needs an isolated session/VM (see SKILL.md section B / isolated/).
#
# Usage:  powershell -NoProfile -File overlay.ps1 [stopFile] [maxSeconds] [statusFile]
param([string]$stopFile = "$env:TEMP\neko_overlay.stop", [int]$maxSeconds = 600, [string]$statusFile = "", [string]$shotFile = "")
Remove-Item $stopFile -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Ov {
  public delegate IntPtr Proc(int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, Proc cb, IntPtr mod, uint t);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string m);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [StructLayout(LayoutKind.Sequential)] public struct MS { public int x; public int y; public uint data; public uint flags; public uint time; public IntPtr extra; }
  public static bool UserActed = false;
  static IntPtr H = IntPtr.Zero; static Proc _cb;
  static IntPtr Cb(int n, IntPtr w, IntPtr l){
    if(n >= 0){ MS s=(MS)Marshal.PtrToStructure(l,typeof(MS)); int msg=w.ToInt32(); bool injected=(s.flags & 0x01)!=0;
      if(!injected && (msg==513 || msg==516)) UserActed = true; }
    return CallNextHookEx(H, n, w, l);
  }
  public static void Install(){ _cb=Cb; H=SetWindowsHookEx(14,_cb,GetModuleHandle(null),0); }
  public static void Remove(){ if(H!=IntPtr.Zero) UnhookWindowsHookEx(H); }
  public static void ClickThrough(IntPtr h){ int ex=GetWindowLong(h,-20); SetWindowLong(h,-20, ex | 0x80000 | 0x20 | 0x80); }
}
"@
$blue=[System.Drawing.Color]::FromArgb(255,51,128,255)   # #3380FF
$red=[System.Drawing.Color]::FromArgb(255,255,70,70)
$key=[System.Drawing.Color]::FromArgb(255,1,2,3)
$f=New-Object System.Windows.Forms.Form
$f.FormBorderStyle='None'; $f.WindowState='Maximized'; $f.TopMost=$true; $f.ShowInTaskbar=$false
$f.StartPosition='Manual'; $f.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f.BackColor=$key; $f.TransparencyKey=$key
# buddy state
$c=[System.Windows.Forms.Cursor]::Position
$script:mx=[double]$c.X; $script:my=[double]$c.Y
$script:flying=$false; $script:ft=0.0; $script:sx=0.0; $script:sy=0.0; $script:cx=0.0; $script:cy=0.0; $script:tx=0.0; $script:ty=0.0; $script:scale=1.0
$script:paused=$false; $script:opacity=1.0; $script:pt=$null; $script:first=$true; $script:shot=$false
function TriPts($ax,$ay,$sc){
  $rad=[Math]::PI*-35.0/180.0; $ca=[Math]::Cos($rad); $sa=[Math]::Sin($rad)
  $S=22.0*$sc; $Hh=19.0*$sc
  $base=@(@(0.0,0.0),@((-$S/2.0),$Hh),@(($S/2.0),$Hh))   # apex at origin, base below
  $out=New-Object System.Collections.Generic.List[System.Drawing.PointF]
  foreach($p in $base){ $rx=$p[0]*$ca-$p[1]*$sa; $ry=$p[0]*$sa+$p[1]*$ca; $out.Add((New-Object System.Drawing.PointF([single]($ax+$rx),[single]($ay+$ry)))) }
  return ,$out.ToArray()
}
$f.Add_Paint({ param($s,$e)
  $g=$e.Graphics; $g.SmoothingMode='AntiAlias'
  $col = if($script:paused){$red}else{$blue}
  $bw=6; $g.DrawRectangle((New-Object System.Drawing.Pen $col,$bw), [int]($bw/2),[int]($bw/2),$f.Width-$bw,$f.Height-$bw)
  $txt = if($script:paused){"DA DUNG  -  ban dang dieu khien"}else{"NEKO DANG DIEU KHIEN  -  bam chuot de dung"}
  $bf=New-Object System.Drawing.Font("Segoe UI",13,[System.Drawing.FontStyle]::Bold)
  $sz=$g.MeasureString($txt,$bf); $bx=[int](($f.Width-$sz.Width)/2)-18
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235,20,22,28))), $bx,14,$sz.Width+36,$sz.Height+14)
  $g.DrawString($txt,$bf,(New-Object System.Drawing.SolidBrush $col), $bx+18,21)
  try {
    # glowing triangle cursor at (mx,my)
    $a=[int](255*$script:opacity)
    foreach($gl in @(@(2.2,40),@(1.6,90),@(1.0,255))){
      $al=[int]($gl[1]*$script:opacity)
      $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($al,$col.R,$col.G,$col.B))), (TriPts $script:mx $script:my $gl[0]))
    }
    $g.DrawPolygon((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($a,255,255,255)),1.5), (TriPts $script:mx $script:my $script:scale))
    # label bubble beside the cursor
    $lbl="Neko"; if($statusFile -and (Test-Path $statusFile)){ $first=(Get-Content $statusFile -TotalCount 1 -ErrorAction SilentlyContinue); if($first){ $lbl=$first } }
    $lf=New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold)
    $ls=$g.MeasureString($lbl,$lf); $lx=[int]($script:mx)+16; $ly=[int]($script:my)+14
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int](225*$script:opacity),20,22,28))), $lx,$ly,$ls.Width+14,$ls.Height+8)
    $g.DrawString($lbl,$lf,(New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($a,$col.R,$col.G,$col.B))), $lx+7,$ly+4)
  } catch { $_ | Out-File "$env:TEMP\neko_ov_err.txt" }
})
$f.Add_Shown({ [Ov]::ClickThrough($f.Handle); [Ov]::Install() })
$t0=Get-Date
$timer=New-Object System.Windows.Forms.Timer; $timer.Interval=16
$timer.Add_Tick({
 try {
  if($script:opacity -lt 1.0){ $script:opacity=[Math]::Min(1.0,$script:opacity+0.08) }
  $p=$f.PointToClient([System.Windows.Forms.Cursor]::Position); $gx=[double]$p.X; $gy=[double]$p.Y   # screen -> client (DPI-correct)
  if($script:first){ $script:mx=$gx; $script:my=$gy; $script:first=$false }
  $dx=$gx-$script:mx; $dy=$gy-$script:my; $dist=[Math]::Sqrt($dx*$dx+$dy*$dy)
  if(-not $script:flying -and $dist -gt 60){
    $script:flying=$true; $script:ft=0.0; $script:sx=$script:mx; $script:sy=$script:my; $script:tx=$gx; $script:ty=$gy
    $arc=[Math]::Min($dist*0.2,80.0); $script:cx=($script:sx+$gx)/2; $script:cy=(($script:sy+$gy)/2)-$arc
  }
  if($script:flying){
    $script:ft=[Math]::Min(1.0,$script:ft+0.05)   # ~0.32s flight
    $t=$script:ft; $om=1.0-$t
    $script:mx=$om*$om*$script:sx + 2*$om*$t*$script:cx + $t*$t*$script:tx
    $script:my=$om*$om*$script:sy + 2*$om*$t*$script:cy + $t*$t*$script:ty
    $script:scale=1.0 + 0.35*[Math]::Sin($t*[Math]::PI)
    if($script:ft -ge 1.0){ $script:flying=$false; $script:scale=1.0 }
  } else {
    $script:mx += $dx*0.25; $script:my += $dy*0.25; $script:scale=1.0   # spring follow (Clicky response 0.2)
  }
  $f.Invalidate()
  # Self-capture from INSIDE the overlay process (same DPI context as the form) so the marker's true
  # alignment to the cursor can be verified without a cross-process capture artifact.
  if($shotFile -and -not $script:shot -and ((Get-Date)-$t0).TotalSeconds -gt 2.5){
    $script:shot=$true
    try { $sb=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bm=New-Object System.Drawing.Bitmap $sb.Width,$sb.Height; ([System.Drawing.Graphics]::FromImage($bm)).CopyFromScreen(0,0,0,0,$bm.Size); $bm.Save($shotFile); $bm.Dispose() } catch {}
  }
  if([Ov]::UserActed -and -not $script:paused){ $script:paused=$true; "user" | Out-File $stopFile -Encoding ascii; $script:pt=Get-Date }
  if((Test-Path $stopFile) -and -not [Ov]::UserActed){ $f.Close() }
  if($script:paused -and $script:pt -and ((Get-Date)-$script:pt).TotalSeconds -gt 1.5){ $f.Close() }
  if(((Get-Date)-$t0).TotalSeconds -gt $maxSeconds){ $f.Close() }
 } catch { $_ | Out-File "$env:TEMP\neko_ov_tick.txt" }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($f)
[Ov]::Remove()
