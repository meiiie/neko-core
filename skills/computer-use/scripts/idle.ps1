# Shared-autonomy RESUME gate: block until the user has stopped intervening, then clear the pause so Neko
# can resume. The SOTA "state-managed interruption" loop: Neko yields on a real user click (overlay sets the
# stop-file), calls THIS to wait until the user is idle for a few seconds, then RE-PERCEIVES (the user may
# have changed things) and replans toward the goal -- never blindly continues the old action sequence.
#
# Usage:  idle.ps1 [idleSeconds=3] [maxWaitSeconds=90]
#   -> prints "resume: ..." + clears the stop-file when the user has been idle >= idleSeconds  (exit 0)
#   -> prints "timeout: ..." if the user is still active after maxWaitSeconds                   (exit 1)
param([int]$idleSeconds=3, [int]$maxWaitSeconds=90)
Add-Type 'using System;using System.Runtime.InteropServices;public class II{[StructLayout(LayoutKind.Sequential)]public struct L{public uint cbSize;public uint dwTime;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref L p);[DllImport("kernel32.dll")]public static extern uint GetTickCount();public static double IdleSec(){L i=new L();i.cbSize=(uint)Marshal.SizeOf(i);GetLastInputInfo(ref i);return (GetTickCount()-i.dwTime)/1000.0;}}'
$stop="$env:TEMP\neko_overlay.stop"
$deadline=(Get-Date).AddSeconds($maxWaitSeconds)
while((Get-Date) -lt $deadline){
  $idle=[II]::IdleSec()
  if($idle -ge $idleSeconds){
    Remove-Item $stop -ErrorAction SilentlyContinue   # clear the pause so the overlay + helpers resume
    Write-Output ("resume: ban da ngung dieu khien (idle " + [Math]::Round($idle,1) + "s). Hay CHUP/DOC lai man hinh roi tiep tuc nhiem vu tu trang thai moi.")
    exit 0
  }
  Start-Sleep -Milliseconds 400
}
Write-Output "timeout: ban van dang dieu khien sau ${maxWaitSeconds}s. Goi lai idle.ps1 hoac hoi nguoi dung."
exit 1
