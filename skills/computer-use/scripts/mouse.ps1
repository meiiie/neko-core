# Minimal Windows mouse-control primitive for desktop computer-use (the "control" half of the
# screenshot -> vision-ground -> act loop). Pairs with a screenshot + a vision model that outputs
# coordinates (clicky's [POINT:x,y] idea). Move is harmless; CLICK acts on the real machine -- gate it.
#
# Usage:
#   powershell -NoProfile -File mouse.ps1 pos                 -> prints current "X Y"
#   powershell -NoProfile -File mouse.ps1 move  <x> <y>       -> moves the pointer (no click)
#   powershell -NoProfile -File mouse.ps1 click <x> <y>       -> moves then left-clicks  (DESTRUCTIVE)
#   powershell -NoProfile -File mouse.ps1 dblclick <x> <y>    -> double left-click
param([string]$cmd = "pos", [int]$x = -1, [int]$y = -1)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
  public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static void Click() { mouse_event(LEFTDOWN,0,0,0,0); mouse_event(LEFTUP,0,0,0,0); }
}
"@
function Pos { $p = New-Object Mouse+POINT; [Mouse]::GetCursorPos([ref]$p) | Out-Null; "$($p.X) $($p.Y)" }
switch ($cmd) {
  "pos"      { Pos }
  "move"     { [Mouse]::SetCursorPos($x,$y) | Out-Null; "moved -> " + (Pos) }
  "click"    { [Mouse]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 90; [Mouse]::Click(); "clicked $x $y" }
  "dblclick" { [Mouse]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 90; [Mouse]::Click(); Start-Sleep -Milliseconds 60; [Mouse]::Click(); "double-clicked $x $y" }
  default    { "usage: pos | move <x> <y> | click <x> <y> | dblclick <x> <y>" }
}
