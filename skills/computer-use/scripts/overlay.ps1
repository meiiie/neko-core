# Clicky-style "agent is controlling" overlay for Windows. A transparent, click-through, always-on-top
# window that shows: a coloured screen border + a top banner ("NEKO is controlling") + a ring marking the
# agent's cursor. A low-level mouse hook watches for a REAL (non-injected) user click and flips to PAUSED,
# writing the stop-file so the agent's loop knows to yield. The OS has only one physical cursor, so the ring
# is a VISUAL agent-cursor over the shared one (same approach as Clicky's overlay); true input separation
# needs an isolated session/VM (see SKILL.md, section B).
#
# Usage:  powershell -NoProfile -File overlay.ps1 [stopFile] [maxSeconds]
#   Run in the background while the agent acts. Stops when: the stopFile exists, a real user click happens,
#   or maxSeconds elapses. On a user click it writes "user" into stopFile (takeover signal).
param([string]$stopFile = "$env:TEMP\neko_overlay.stop", [int]$maxSeconds = 600)
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
      if(!injected && (msg==513 || msg==516)) UserActed = true; } // real WM_LBUTTONDOWN / WM_RBUTTONDOWN
    return CallNextHookEx(H, n, w, l);
  }
  public static void Install(){ _cb=Cb; H=SetWindowsHookEx(14,_cb,GetModuleHandle(null),0); }
  public static void Remove(){ if(H!=IntPtr.Zero) UnhookWindowsHookEx(H); }
  public static void ClickThrough(IntPtr hwnd){ int ex=GetWindowLong(hwnd,-20); SetWindowLong(hwnd,-20, ex | 0x80000 | 0x20 | 0x80); } // WS_EX_LAYERED|TRANSPARENT|TOOLWINDOW
}
"@
$key = [System.Drawing.Color]::FromArgb(255,1,2,3)
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle='None'; $f.WindowState='Maximized'; $f.TopMost=$true; $f.ShowInTaskbar=$false
$f.StartPosition='Manual'; $f.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f.BackColor=$key; $f.TransparencyKey=$key
$accent=[System.Drawing.Color]::FromArgb(255,90,170,255); $red=[System.Drawing.Color]::FromArgb(255,255,70,70)
$paused=$false
$f.Add_Paint({ param($s,$e)
  $g=$e.Graphics; $g.SmoothingMode='AntiAlias'
  $col = if($paused){$red}else{$accent}
  $bw=6; $g.DrawRectangle((New-Object System.Drawing.Pen $col,$bw), [int]($bw/2),[int]($bw/2),$f.Width-$bw,$f.Height-$bw)
  $txt = if($paused){"DA DUNG  -  ban dang dieu khien"}else{"NEKO DANG DIEU KHIEN  -  bam chuot de dung"}
  $font=New-Object System.Drawing.Font("Segoe UI",13,[System.Drawing.FontStyle]::Bold)
  $sz=$g.MeasureString($txt,$font); $bx=[int](($f.Width-$sz.Width)/2)-18
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235,20,22,28))), $bx,14,$sz.Width+36,$sz.Height+14)
  $g.DrawString($txt,$font,(New-Object System.Drawing.SolidBrush $col), $bx+18,21)
  $p=[System.Windows.Forms.Cursor]::Position
  $g.DrawEllipse((New-Object System.Drawing.Pen $col,3), $p.X-17,$p.Y-17,34,34)
  $g.DrawLine((New-Object System.Drawing.Pen $col,2), $p.X-26,$p.Y,$p.X-20,$p.Y); $g.DrawLine((New-Object System.Drawing.Pen $col,2), $p.X+20,$p.Y,$p.X+26,$p.Y)
  $g.DrawLine((New-Object System.Drawing.Pen $col,2), $p.X,$p.Y-26,$p.X,$p.Y-20); $g.DrawLine((New-Object System.Drawing.Pen $col,2), $p.X,$p.Y+20,$p.X,$p.Y+26)
})
$f.Add_Shown({ [Ov]::ClickThrough($f.Handle); [Ov]::Install() })
$t0=Get-Date
$timer=New-Object System.Windows.Forms.Timer; $timer.Interval=33
$timer.Add_Tick({
  $f.Invalidate()
  if([Ov]::UserActed -and -not $script:paused){ $script:paused=$true; "user" | Out-File $stopFile -Encoding ascii; $timer.Interval=1200 }
  if((Test-Path $stopFile) -and -not [Ov]::UserActed){ $f.Close() }
  if($script:paused -and ((Get-Date)-$t0).TotalSeconds -gt 2){ $f.Close() }   # show PAUSED briefly then exit
  if(((Get-Date)-$t0).TotalSeconds -gt $maxSeconds){ $f.Close() }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($f)
[Ov]::Remove()
