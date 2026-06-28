# Windows mouse-control primitive for desktop computer-use (the "control" half of screenshot -> ground -> act).
# Uses SendInput with ABSOLUTE coordinates -- the modern, DPI-safe path that the legacy mouse_event does NOT
# provide: Windows 11 apps (the new Paint, etc.) ignore mouse_event drags but accept SendInput. `click`/`stroke`
# act on the REAL machine -- gate them behind approval. (See SKILL.md for the clicky-style overlay direction.)
#
# Usage:
#   powershell -NoProfile -File mouse.ps1 pos
#   powershell -NoProfile -File mouse.ps1 move  <x> <y>
#   powershell -NoProfile -File mouse.ps1 click <x> <y>            # left click (DESTRUCTIVE)
#   powershell -NoProfile -File mouse.ps1 dblclick <x> <y>
#   powershell -NoProfile -File mouse.ps1 stroke <x1> <y1> <x2> <y2> [x3 y3 ...]   # pen-down drag (draw)
param([string]$cmd = "pos")
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  static int W = GetSystemMetrics(0); static int H = GetSystemMetrics(1);
  static void Send(uint flags,int x,int y){ INPUT[] i=new INPUT[1]; i[0].type=0; i[0].mi.dx=x; i[0].mi.dy=y; i[0].mi.dwFlags=flags; SendInput(1,i,Marshal.SizeOf(typeof(INPUT))); }
  public static void Move(int x,int y){ Send(0x8001,(int)((long)x*65535/(W-1)),(int)((long)y*65535/(H-1))); }   // MOVE|ABSOLUTE
  public static void Down(){ Send(0x0002,0,0); } public static void Up(){ Send(0x0004,0,0); }
  public static string Pos(){ POINT p; GetCursorPos(out p); return p.X+" "+p.Y; }
}
"@
function I($n){ [int]$args[$n] }
$a = $args
switch ($cmd) {
  "pos"      { [Mouse]::Pos() }
  "move"     { [Mouse]::Move([int]$a[0],[int]$a[1]); "moved -> " + [Mouse]::Pos() }
  "click"    { [Mouse]::Move([int]$a[0],[int]$a[1]); Start-Sleep -Milliseconds 70; [Mouse]::Down(); [Mouse]::Up(); "clicked " + $a[0] + "," + $a[1] }
  "dblclick" { [Mouse]::Move([int]$a[0],[int]$a[1]); Start-Sleep -Milliseconds 70; [Mouse]::Down(); [Mouse]::Up(); Start-Sleep -Milliseconds 60; [Mouse]::Down(); [Mouse]::Up(); "double-clicked " + $a[0] + "," + $a[1] }
  "stroke"   {
    if ($a.Count -lt 4) { "usage: stroke x1 y1 x2 y2 [x3 y3 ...]"; break }
    [Mouse]::Move([int]$a[0],[int]$a[1]); Start-Sleep -Milliseconds 110; [Mouse]::Down(); Start-Sleep -Milliseconds 80
    for ($k=2; $k+1 -lt $a.Count; $k+=2) {
      $ax=[int]$a[$k-2]; $ay=[int]$a[$k-1]; $bx=[int]$a[$k]; $by=[int]$a[$k+1]
      for ($t=1; $t -le 16; $t++) { [Mouse]::Move([int]($ax+($bx-$ax)*$t/16),[int]($ay+($by-$ay)*$t/16)); Start-Sleep -Milliseconds 12 }
    }
    Start-Sleep -Milliseconds 80; [Mouse]::Up(); "stroke done"
  }
  default    { "usage: pos | move <x> <y> | click <x> <y> | dblclick <x> <y> | stroke <x1> <y1> <x2> <y2> ..." }
}
