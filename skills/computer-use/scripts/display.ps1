# Report the coordinate contract used by every Neko desktop action. Values are physical pixels in the
# Windows virtual desktop, including negative origins on monitors placed left/above the primary display.
try {
  Add-Type 'using System;using System.Runtime.InteropServices;public class NekoDisplayDpi{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);}'
  [void][NekoDisplayDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NekoDisplayNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
  public static uint DpiAt(int x, int y) {
    try {
      uint dx, dy;
      var monitor = MonitorFromPoint(new POINT { X = x, Y = y }, 2);
      return monitor != IntPtr.Zero && GetDpiForMonitor(monitor, 0, out dx, out dy) == 0 ? dx : 96;
    } catch { return 96; }
  }
}
"@

$virtual=[System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ("coordinate_space=physical_px awareness=per-monitor-v2 virtual={0},{1} {2}x{3}" -f $virtual.X,$virtual.Y,$virtual.Width,$virtual.Height)
$index=0
foreach($screen in [System.Windows.Forms.Screen]::AllScreens){
  $index++
  $b=$screen.Bounds; $w=$screen.WorkingArea
  $dpi=[NekoDisplayNative]::DpiAt([int]($b.X+$b.Width/2),[int]($b.Y+$b.Height/2))
  $scale=[math]::Round($dpi*100/96)
  Write-Output ("monitor={0} primary={1} bounds={2},{3} {4}x{5} work={6},{7} {8}x{9} dpi={10} scale={11}%" -f $index,$screen.Primary.ToString().ToLowerInvariant(),$b.X,$b.Y,$b.Width,$b.Height,$w.X,$w.Y,$w.Width,$w.Height,$dpi,$scale)
}
