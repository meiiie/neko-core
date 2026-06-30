# Clicky-style agent-presence overlay, v4 (atomic UX pass).
#  - FLICKER-FREE custom double-buffered Form (composited off-screen, blitted atomically).
#  - INDEPENDENT agent cursor: a blue triangle with its OWN position, driven by a TARGET FILE the agent writes;
#    it FLIES there on an EASE-IN-OUT bezier arc (independent of the user's cursor), follows the user when idle.
#  - MICRO-INTERACTIONS: a click-pulse ripple on arrival, a soft drop-shadow, rounded panels, scale-pop in flight.
#  - PRESENCE: frames + labels the exact window/tab Neko is using; a WH_MOUSE_LL hook yields on a REAL click.
#  - VIETNAMESE: UI strings load from overlay.i18n.txt (UTF-8) at runtime -- PS 5.1 parses .ps1 as cp1252, so
#    diacritics live in a data file, not in the script. GDI renders them.
#
# Usage:  overlay.ps1 [stopFile] [maxSeconds] [targetFile] [shotFile] [activeWinFile]
param([string]$stopFile="$env:TEMP\neko_overlay.stop", [int]$maxSeconds=600, [string]$targetFile="$env:TEMP\neko_cursor.txt", [string]$shotFile="", [string]$activeWinFile="$env:TEMP\neko_active_window.txt")
# DPI: PER-MONITOR-AWARE v2 BEFORE any Form is created, so the overlay's coordinate space is PHYSICAL pixels
# and the agent cursor lands where inject.ps1/mouse.ps1 act (they write physical coords). Without this the
# triangle would point at the wrong spot on a scaled display. Must match the other coordinate scripts.
try { Add-Type 'using System;using System.Runtime.InteropServices;public class Dpi{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);}'; [void][Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
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
$blue=[System.Drawing.Color]::FromArgb(255,51,128,255); $red=[System.Drawing.Color]::FromArgb(255,255,74,74); $key=[System.Drawing.Color]::FromArgb(255,1,2,3)
# --- i18n (UTF-8 data file; ASCII fallbacks if missing) ---
$script:S=@{ controlling="Neko dang dieu khien  -  bam chuot de dung"; using_tab="Neko dang dung tab nay:"; paused="Da dung  -  ban dang dieu khien"; label="Neko" }
$i18n=Join-Path $PSScriptRoot 'overlay.i18n.txt'
if(Test-Path $i18n){ try { foreach($ln in (Get-Content $i18n -Encoding UTF8)){ if($ln -notmatch '^\s*#' -and $ln -match '^\s*([a-z_]+)\s*=(.*)$'){ $script:S[$matches[1]]=($matches[2].TrimEnd("`r","`n")) } } } catch {} }
$f=New-Object NekoOverlay
$f.FormBorderStyle='None'; $f.WindowState='Maximized'; $f.TopMost=$true; $f.ShowInTaskbar=$false
$f.StartPosition='Manual'; $f.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f.BackColor=$key; $f.TransparencyKey=$key
$c=[System.Windows.Forms.Cursor]::Position; $script:mx=[double]$c.X; $script:my=[double]$c.Y
$script:flying=$false; $script:ft=0.0; $script:sx=0.0;$script:sy=0.0;$script:cxp=0.0;$script:cyp=0.0;$script:txp=0.0;$script:typ=0.0;$script:scale=1.0
$script:paused=$false; $script:pt=$null; $script:label=$script:S.label; $script:shot=$false; $script:lasthb=(Get-Date).AddSeconds(-10)
$script:winRect=$null; $script:winLabel=""; $script:lastwin=(Get-Date).AddSeconds(-10)
$script:agentTarget=$false; $script:pulseT=2.0; $script:pulseX=0.0; $script:pulseY=0.0   # click-pulse ripple state
$script:bf=New-Object System.Drawing.Font("Segoe UI",12.5,[System.Drawing.FontStyle]::Bold)
$script:lf=New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold)
# Refined cursor silhouette: a sleek notched chevron (apex = the exact target pixel; concave back for elegance),
# tilted -38 deg. Returns a GraphicsPath so it can be glow-stroked, gradient-filled, and white-bordered.
function CurPath($ax,$ay,$sc){
  $rad=[Math]::PI*-38.0/180.0; $ca=[Math]::Cos($rad); $sa=[Math]::Sin($rad)
  $base=@(@(0.0,0.0),@(-7.8,22.5),@(0.0,14.5),@(7.8,22.5))   # tip, left, notch, right (sleek, sharp apex)
  $pts=New-Object System.Collections.Generic.List[System.Drawing.PointF]
  foreach($p in $base){ $x=$p[0]*$sc; $y=$p[1]*$sc; $rx=$x*$ca-$y*$sa; $ry=$x*$sa+$y*$ca; $pts.Add((New-Object System.Drawing.PointF([single]($ax+$rx),[single]($ay+$ry)))) }
  $path=New-Object System.Drawing.Drawing2D.GraphicsPath; $path.AddPolygon($pts.ToArray()); return $path
}
function RRP($x,$y,$w,$h,$rad){ $d=$rad*2.0; $p=New-Object System.Drawing.Drawing2D.GraphicsPath; $p.AddArc($x,$y,$d,$d,180,90); $p.AddArc($x+$w-$d,$y,$d,$d,270,90); $p.AddArc($x+$w-$d,$y+$h-$d,$d,$d,0,90); $p.AddArc($x,$y+$h-$d,$d,$d,90,90); $p.CloseFigure(); return $p }
$f.Add_Paint({ param($s,$e)
  $g=$e.Graphics; $g.Clear($key); $g.SmoothingMode='AntiAlias'; $g.TextRenderingHint='ClearTypeGridFit'
  $col= if($script:paused){$red}else{$blue}
  $panel=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238,17,19,25))
  $colBr=New-Object System.Drawing.SolidBrush $col
  # ---- presence frame + banner ----
  if($script:winRect){
    $r=$script:winRect; $L=[Math]::Max(2,$r.L);$T=[Math]::Max(2,$r.T);$R=[Math]::Min($f.Width-2,$r.R);$B=[Math]::Min($f.Height-2,$r.B)
    $fp=RRP $L $T ($R-$L) ($B-$T) 14; $g.DrawPath((New-Object System.Drawing.Pen $col,4),$fp); $fp.Dispose()
    $txt= if($script:paused){$script:S.paused}else{ ($script:S.using_tab + "  " + $script:winLabel) }
    $sz=$g.MeasureString($txt,$script:bf); $bx=$L+12; $by=$T+10
    $bp=RRP $bx $by ($sz.Width+26) ($sz.Height+12) 9; $g.FillPath($panel,$bp); $bp.Dispose()
    $dot=New-Object System.Drawing.SolidBrush $col; $g.FillEllipse($dot,$bx+12,$by+($sz.Height/2)-3,7,7)
    $g.DrawString($txt,$script:bf,$colBr,$bx+26,$by+6)
  } else {
    $fp=RRP 4 4 ($f.Width-8) ($f.Height-8) 16; $g.DrawPath((New-Object System.Drawing.Pen $col,5),$fp); $fp.Dispose()
    $txt= if($script:paused){$script:S.paused}else{$script:S.controlling}
    $sz=$g.MeasureString($txt,$script:bf); $bw2=$sz.Width+44; $bx=[int](($f.Width-$bw2)/2)
    $bp=RRP $bx 14 $bw2 ($sz.Height+14) 11; $g.FillPath($panel,$bp); $bp.Dispose()
    $g.FillEllipse($colBr,$bx+16,21+($sz.Height/2)-4,8,8)
    $g.DrawString($txt,$script:bf,$colBr,$bx+30,21)
  }
  # ---- click-pulse ripple (under the cursor) ----
  if($script:pulseT -lt 1.0){
    $ease=1.0-[Math]::Pow(1.0-$script:pulseT,2); $rr=8.0+$ease*34.0; $a=[int]((1.0-$script:pulseT)*170)
    $pen=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($a,$col.R,$col.G,$col.B)),3
    $g.DrawEllipse($pen,[single]($script:pulseX-$rr),[single]($script:pulseY-$rr),[single]($rr*2),[single]($rr*2))
    $a2=[int]((1.0-$script:pulseT)*90); $pen2=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($a2,$col.R,$col.G,$col.B)),2
    $rr2=$rr*0.6; $g.DrawEllipse($pen2,[single]($script:pulseX-$rr2),[single]($script:pulseY-$rr2),[single]($rr2*2),[single]($rr2*2))
  }
  # ---- cursor: soft shadow -> glow hugging the silhouette -> gradient fill -> crisp white border ----
  try {
    $rnd=[System.Drawing.Drawing2D.LineJoin]::Round
    $sp1=CurPath ($script:mx+1.5) ($script:my+2.5) $script:scale; $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(52,0,0,0))),$sp1); $sp1.Dispose()
    $sp2=CurPath ($script:mx+3.0) ($script:my+4.5) $script:scale; $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34,0,0,0))),$sp2); $sp2.Dispose()
    $cp=CurPath $script:mx $script:my $script:scale
    $gp1=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(26,$col.R,$col.G,$col.B)),9.0; $gp1.LineJoin=$rnd; $g.DrawPath($gp1,$cp)
    $gp2=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(64,$col.R,$col.G,$col.B)),5.0; $gp2.LineJoin=$rnd; $g.DrawPath($gp2,$cp)
    $bnd=$cp.GetBounds()
    if($script:paused){ $c1=[System.Drawing.Color]::FromArgb(255,255,124,124); $c2=[System.Drawing.Color]::FromArgb(255,206,38,38) }
    else { $c1=[System.Drawing.Color]::FromArgb(255,140,190,255); $c2=[System.Drawing.Color]::FromArgb(255,28,92,210) }
    $lgb=New-Object System.Drawing.Drawing2D.LinearGradientBrush($bnd,$c1,$c2,108.0); $g.FillPath($lgb,$cp); $lgb.Dispose()
    $wp=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(240,255,255,255)),1.35; $wp.LineJoin=$rnd; $g.DrawPath($wp,$cp)
    # subtle edge specular near the tip (a premium "catch light" on the upper-left edge)
    $radS=[Math]::PI*-38.0/180.0; $lx0=(-7.8*$script:scale); $ly0=(22.5*$script:scale)
    $lbx=$script:mx+($lx0*[Math]::Cos($radS)-$ly0*[Math]::Sin($radS)); $lby=$script:my+($lx0*[Math]::Sin($radS)+$ly0*[Math]::Cos($radS))
    $hp=New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140,255,255,255)),1.3; $hp.StartCap='Round'; $hp.EndCap='Round'
    $g.DrawLine($hp,[single]($script:mx+($lbx-$script:mx)*0.12),[single]($script:my+($lby-$script:my)*0.12),[single]($script:mx+($lbx-$script:mx)*0.52),[single]($script:my+($lby-$script:my)*0.52)); $cp.Dispose()
    # ---- label bubble (rounded, edge-clamped) ----
    $lbl=$script:label; $ls=$g.MeasureString($lbl,$script:lf)
    $lx=[Math]::Min([int]$script:mx+17,$f.Width-[int]$ls.Width-26); $ly=[Math]::Min([int]$script:my+15,$f.Height-[int]$ls.Height-16)
    $lp=RRP $lx $ly ($ls.Width+18) ($ls.Height+9) 7; $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(228,17,19,25))),$lp); $lp.Dispose()
    $g.DrawString($lbl,$script:lf,$colBr,$lx+9,$ly+4)
  } catch {}
})
$f.Add_Shown({ [Hk]::Install() })
$t0=Get-Date; $timer=New-Object System.Windows.Forms.Timer; $timer.Interval=16
$timer.Add_Tick({
 try {
  $line=$null; if(Test-Path $targetFile){ $line=(Get-Content $targetFile -TotalCount 1 -ErrorAction SilentlyContinue) }
  if($line -and ($line -match '^\s*(-?\d+)\s*,\s*(-?\d+)\s*(\|(.*))?$')){
    $tx=[double]$matches[1]; $ty=[double]$matches[2]; if($matches[4]){ $script:label=$matches[4].Trim() } else { $script:label=$script:S.label }; $script:agentTarget=$true
  } else { $p=[System.Windows.Forms.Cursor]::Position; $tx=[double]$p.X+22; $ty=[double]$p.Y+16; $script:label=$script:S.label; $script:agentTarget=$false }
  $dx=$tx-$script:mx; $dy=$ty-$script:my; $dist=[Math]::Sqrt($dx*$dx+$dy*$dy)
  if(-not $script:flying -and $dist -gt 60){ $script:flying=$true; $script:ft=0.0; $script:sx=$script:mx;$script:sy=$script:my;$script:txp=$tx;$script:typ=$ty; $arc=[Math]::Min($dist*0.22,90.0); $script:cxp=($script:sx+$tx)/2; $script:cyp=(($script:sy+$ty)/2)-$arc }
  if($script:flying){
    $script:ft=[Math]::Min(1.0,$script:ft+0.055); $t=$script:ft
    $te= if($t -lt 0.5){2.0*$t*$t}else{1.0-[Math]::Pow(-2.0*$t+2.0,2)/2.0}   # ease-in-out
    $om=1.0-$te; $script:mx=$om*$om*$script:sx+2*$om*$te*$script:cxp+$te*$te*$script:txp; $script:my=$om*$om*$script:sy+2*$om*$te*$script:cyp+$te*$te*$script:typ
    $script:scale=1.0+0.30*[Math]::Sin($te*[Math]::PI)
    if($script:ft -ge 1.0){ $script:flying=$false; $script:scale=1.0; if($script:agentTarget){ $script:pulseT=0.0; $script:pulseX=$script:txp; $script:pulseY=$script:typ } }
  } else { $script:mx+=$dx*0.22; $script:my+=$dy*0.22; $script:scale=1.0 }
  if($script:pulseT -lt 1.0){ $script:pulseT+=0.045 }
  # which window/tab is Neko using? -> frame it + banner its title (throttled; Get-Process is slow)
  if(((Get-Date)-$script:lastwin).TotalMilliseconds -gt 500){ $script:lastwin=Get-Date
    $awl=$null; if(Test-Path $activeWinFile){ $awl=(Get-Content $activeWinFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) }
    if($awl){ $awl=($awl -replace '﻿','').Trim() }
    if($awl){ $wp=Get-Process | Where-Object { $_.MainWindowTitle -like "*$awl*" } | Select-Object -First 1
      if($wp){ $rc=New-Object Hk+RECT; if([Hk]::GetWindowRect($wp.MainWindowHandle,[ref]$rc)){ $script:winRect=$rc; $l=$wp.MainWindowTitle; if($l.Length -gt 64){$l=$l.Substring(0,64)+[char]0x2026}; $script:winLabel=$l } else { $script:winRect=$null } }
      else { $script:winRect=$null } }
    else { $script:winRect=$null } }
  $f.Invalidate()
  if(((Get-Date)-$script:lasthb).TotalSeconds -gt 1){ $script:lasthb=Get-Date; try { "1" | Out-File "$env:TEMP\neko_overlay.run" -Encoding ascii } catch {} }
  if($shotFile -and -not $script:shot -and ((Get-Date)-$t0).TotalSeconds -gt 3.5){ $script:shot=$true; try { $sb=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bm=New-Object System.Drawing.Bitmap $sb.Width,$sb.Height; ([System.Drawing.Graphics]::FromImage($bm)).CopyFromScreen(0,0,0,0,$bm.Size); $bm.Save($shotFile); $bm.Dispose() } catch {} }
  if([Hk]::UserActed -and -not $script:paused){ $script:paused=$true; "user" | Out-File $stopFile -Encoding ascii; $script:pt=Get-Date }
  if((Test-Path $stopFile) -and -not [Hk]::UserActed){ $f.Close() }
  if($script:paused -and $script:pt -and ((Get-Date)-$script:pt).TotalSeconds -gt 1.6){ $f.Close() }
  if(((Get-Date)-$t0).TotalSeconds -gt $maxSeconds){ $f.Close() }
 } catch {}
})
$timer.Start(); [System.Windows.Forms.Application]::Run($f); [Hk]::Remove(); Remove-Item "$env:TEMP\neko_overlay.run" -ErrorAction SilentlyContinue
