# Clicky-style agent-presence overlay, v3. Two SOTA upgrades:
#  1. FLICKER-FREE: a custom double-buffered Form (OptimizedDoubleBuffer + no OnPaintBackground, clear in
#     OnPaint) so the whole transparent layer is composited off-screen and blitted atomically -- no flicker.
#  2. INDEPENDENT agent cursor (DeepMind Magic-Pointer / Clicky pattern): the blue triangle has its OWN
#     position, driven by a TARGET FILE the agent writes. When the agent sets a target it FLIES there
#     (bezier arc), independent of the user's real cursor; when idle (no target) it follows the user's
#     cursor as a buddy beside it. A WH_MOUSE_LL hook yields on a REAL user click.
#
# Usage:  overlay.ps1 [stopFile] [maxSeconds] [targetFile]
#   Agent controls the independent cursor by writing the targetFile:  "x,y"  or  "x,y|label"  -> fly there;
#   "idle" / empty / missing -> follow the user's cursor.
param([string]$stopFile="$env:TEMP\neko_overlay.stop", [int]$maxSeconds=600, [string]$targetFile="$env:TEMP\neko_cursor.txt", [string]$shotFile="", [string]$activeWinFile="$env:TEMP\neko_active_window.txt")
Remove-Item $stopFile -ErrorAction SilentlyContinue
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @"
using System; using System.Windows.Forms; using System.Drawing; using System.Runtime.InteropServices;
public class NekoOverlay : Form {
  public NekoOverlay(){ this.SetStyle(ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint|ControlStyles.UserPaint, true); this.UpdateStyles(); }
  protected override void OnPaintBackground(PaintEventArgs e){}                       // no bg clear -> no flicker
  protected override CreateParams CreateParams { get { CreateParams cp=base.CreateParams; cp.ExStyle |= 0x20|0x80|0x08000000; return cp; } } // TRANSPARENT|TOOLWINDOW|NOACTIVATE
}
public class Hk {
  public delegate IntPtr Proc(int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, Proc cb, IntPtr mod, uint t);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string m);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);   // frame the window Neko is using
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MS { public int x; public int y; public uint data; public uint flags; public uint time; public IntPtr extra; }
  public static bool UserActed=false; static IntPtr H=IntPtr.Zero; static Proc _cb;
  static IntPtr Cb(int n, IntPtr w, IntPtr l){ if(n>=0){ MS s=(MS)Marshal.PtrToStructure(l,typeof(MS)); int m=w.ToInt32(); bool inj=(s.flags&0x01)!=0; if(!inj && (m==513||m==516)) UserActed=true; } return CallNextHookEx(H,n,w,l); }
  public static void Install(){ _cb=Cb; H=SetWindowsHookEx(14,_cb,GetModuleHandle(null),0); }
  public static void Remove(){ if(H!=IntPtr.Zero) UnhookWindowsHookEx(H); }
}
"@
$blue=[System.Drawing.Color]::FromArgb(255,51,128,255); $red=[System.Drawing.Color]::FromArgb(255,255,70,70); $key=[System.Drawing.Color]::FromArgb(255,1,2,3)
$f=New-Object NekoOverlay
$f.FormBorderStyle='None'; $f.WindowState='Maximized'; $f.TopMost=$true; $f.ShowInTaskbar=$false
$f.StartPosition='Manual'; $f.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f.BackColor=$key; $f.TransparencyKey=$key
$c=[System.Windows.Forms.Cursor]::Position; $script:mx=[double]$c.X; $script:my=[double]$c.Y
$script:flying=$false; $script:ft=0.0; $script:sx=0.0;$script:sy=0.0;$script:cxp=0.0;$script:cyp=0.0;$script:txp=0.0;$script:typ=0.0;$script:scale=1.0
$script:paused=$false; $script:pt=$null; $script:label="Neko"; $script:shot=$false; $script:lasthb=(Get-Date).AddSeconds(-10)
$script:winRect=$null; $script:winLabel=""; $script:lastwin=(Get-Date).AddSeconds(-10)   # the specific window/tab Neko is using (framed + banner)
function TriPts($ax,$ay,$sc){ $rad=[Math]::PI*-35.0/180.0; $ca=[Math]::Cos($rad); $sa=[Math]::Sin($rad); $S=22.0*$sc; $Hh=19.0*$sc; $base=@(@(0.0,0.0),@((-$S/2.0),$Hh),@(($S/2.0),$Hh)); $o=New-Object System.Collections.Generic.List[System.Drawing.PointF]; foreach($p in $base){ $rx=$p[0]*$ca-$p[1]*$sa; $ry=$p[0]*$sa+$p[1]*$ca; $o.Add((New-Object System.Drawing.PointF([single]($ax+$rx),[single]($ay+$ry)))) }; return $o.ToArray() }
$f.Add_Paint({ param($s,$e)
  $g=$e.Graphics; $g.Clear($key); $g.SmoothingMode='AntiAlias'
  $col= if($script:paused){$red}else{$blue}
  $bf=New-Object System.Drawing.Font("Segoe UI",13,[System.Drawing.FontStyle]::Bold)
  if($script:winRect){
    # Neko is using a SPECIFIC window/tab: frame that window + banner its title at its top-left.
    $r=$script:winRect; $bw=5; $g.DrawRectangle((New-Object System.Drawing.Pen $col,$bw), $r.L+2, $r.T+2, ($r.R-$r.L)-4, ($r.B-$r.T)-4)
    $txt= if($script:paused){"DA DUNG - ban dang dieu khien"}else{"NEKO dang dung tab nay:  " + $script:winLabel}
    $sz=$g.MeasureString($txt,$bf); $bx=$r.L+10; $by=$r.T+8
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240,20,22,28))),$bx,$by,$sz.Width+24,$sz.Height+12)
    $g.DrawString($txt,$bf,(New-Object System.Drawing.SolidBrush $col),$bx+12,$by+6)
  } else {
    $bw=6; $g.DrawRectangle((New-Object System.Drawing.Pen $col,$bw), [int]($bw/2),[int]($bw/2),$f.Width-$bw,$f.Height-$bw)
    $txt= if($script:paused){"DA DUNG  -  ban dang dieu khien"}else{"NEKO DANG DIEU KHIEN  -  bam chuot de dung"}
    $sz=$g.MeasureString($txt,$bf); $bx=[int](($f.Width-$sz.Width)/2)-18
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235,20,22,28))),$bx,14,$sz.Width+36,$sz.Height+14)
    $g.DrawString($txt,$bf,(New-Object System.Drawing.SolidBrush $col),$bx+18,21)
  }
  try {
    foreach($gl in @(@(2.0,55),@(1.4,110),@(1.0,255))){ $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb([int]$gl[1],$col.R,$col.G,$col.B))), (TriPts $script:mx $script:my $gl[0])) }
    $g.DrawPolygon((New-Object System.Drawing.Pen ([System.Drawing.Color]::White),1.5), (TriPts $script:mx $script:my $script:scale))
    $lbl=$script:label; $lf=New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold); $ls=$g.MeasureString($lbl,$lf); $lx=[int]$script:mx+16; $ly=[int]$script:my+14
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(225,20,22,28))),$lx,$ly,$ls.Width+14,$ls.Height+8)
    $g.DrawString($lbl,$lf,(New-Object System.Drawing.SolidBrush $col),$lx+7,$ly+4)
  } catch {}
})
$f.Add_Shown({ [Hk]::Install() })
$t0=Get-Date; $timer=New-Object System.Windows.Forms.Timer; $timer.Interval=22
$timer.Add_Tick({
 try {
  $line=$null; if(Test-Path $targetFile){ $line=(Get-Content $targetFile -TotalCount 1 -ErrorAction SilentlyContinue) }
  if($line -and ($line -match '^\s*(-?\d+)\s*,\s*(-?\d+)\s*(\|(.*))?$')){
    $tx=[double]$matches[1]; $ty=[double]$matches[2]; if($matches[4]){ $script:label=$matches[4].Trim() } else { $script:label="Neko" }
  } else { $p=[System.Windows.Forms.Cursor]::Position; $tx=[double]$p.X+22; $ty=[double]$p.Y+16; $script:label="Neko" }
  $dx=$tx-$script:mx; $dy=$ty-$script:my; $dist=[Math]::Sqrt($dx*$dx+$dy*$dy)
  if(-not $script:flying -and $dist -gt 70){ $script:flying=$true; $script:ft=0.0; $script:sx=$script:mx;$script:sy=$script:my;$script:txp=$tx;$script:typ=$ty; $arc=[Math]::Min($dist*0.2,80.0); $script:cxp=($script:sx+$tx)/2; $script:cyp=(($script:sy+$ty)/2)-$arc }
  if($script:flying){ $script:ft=[Math]::Min(1.0,$script:ft+0.05); $t=$script:ft; $om=1.0-$t; $script:mx=$om*$om*$script:sx+2*$om*$t*$script:cxp+$t*$t*$script:txp; $script:my=$om*$om*$script:sy+2*$om*$t*$script:cyp+$t*$t*$script:typ; $script:scale=1.0+0.35*[Math]::Sin($t*[Math]::PI); if($script:ft -ge 1.0){ $script:flying=$false; $script:scale=1.0 } }
  else { $script:mx+=$dx*0.25; $script:my+=$dy*0.25; $script:scale=1.0 }
  # which window/tab is Neko using? -> frame it + banner its title (throttled; Get-Process is slow)
  if(((Get-Date)-$script:lastwin).TotalMilliseconds -gt 500){ $script:lastwin=Get-Date
    $awl=$null; if(Test-Path $activeWinFile){ $awl=(Get-Content $activeWinFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) }
    if($awl){ $awl=($awl -replace '﻿','').Trim() }   # strip BOM (Out-File -utf8 prepends one) + whitespace
    if($awl){ $wp=Get-Process | Where-Object { $_.MainWindowTitle -like "*$awl*" } | Select-Object -First 1
      if($wp){ $rc=New-Object Hk+RECT; if([Hk]::GetWindowRect($wp.MainWindowHandle,[ref]$rc)){ $script:winRect=$rc; $l=$wp.MainWindowTitle; if($l.Length -gt 60){$l=$l.Substring(0,60)+"..."}; $script:winLabel=$l } else { $script:winRect=$null } }
      else { $script:winRect=$null } }
    else { $script:winRect=$null } }
  $f.Invalidate()
  if(((Get-Date)-$script:lasthb).TotalSeconds -gt 1){ $script:lasthb=Get-Date; try { "1" | Out-File "$env:TEMP\neko_overlay.run" -Encoding ascii } catch {} }  # heartbeat so the tools know it's alive
  if($shotFile -and -not $script:shot -and ((Get-Date)-$t0).TotalSeconds -gt 3.5){ $script:shot=$true; try { $sb=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bm=New-Object System.Drawing.Bitmap $sb.Width,$sb.Height; ([System.Drawing.Graphics]::FromImage($bm)).CopyFromScreen(0,0,0,0,$bm.Size); $bm.Save($shotFile); $bm.Dispose() } catch {} }
  if([Hk]::UserActed -and -not $script:paused){ $script:paused=$true; "user" | Out-File $stopFile -Encoding ascii; $script:pt=Get-Date }
  if((Test-Path $stopFile) -and -not [Hk]::UserActed){ $f.Close() }
  if($script:paused -and $script:pt -and ((Get-Date)-$script:pt).TotalSeconds -gt 1.5){ $f.Close() }
  if(((Get-Date)-$t0).TotalSeconds -gt $maxSeconds){ $f.Close() }
 } catch {}
})
$timer.Start(); [System.Windows.Forms.Application]::Run($f); [Hk]::Remove(); Remove-Item "$env:TEMP\neko_overlay.run" -ErrorAction SilentlyContinue
