# Independent-pointer desktop input via Windows TOUCH INJECTION (InitializeTouchInjection/InjectTouchInput).
# The agent acts on the VISIBLE desktop -- tap/double-tap/drag/draw on ANY touch-aware app -- WITHOUT moving
# the user's mouse cursor (a separate pointer channel). VERIFIED: drew in Paint while the real mouse stayed put.
# Pair with overlay.ps1 (the visible agent triangle) for a true independent agent cursor: overlay = where Neko
# points (you SEE it), injection = the acting "finger" (your mouse is never hijacked). No driver, no admin.
#
# Usage (same verbs as mouse.ps1, so it is a drop-in non-hijacking backend):
#   inject.ps1 tap <x> <y>                      # a click (touch down+up) -- mouse cursor NOT moved
#   inject.ps1 dbltap <x> <y>
#   inject.ps1 stroke <x1> <y1> <x2> <y2> ...   # drag / draw a continuous line
# Honest limit: the target must be VISIBLE (touch lands on the topmost window at the point) and must ACCEPT
# touch/pen (Paint, browsers, most modern apps do; a few legacy mouse-only apps ignore it -> use mouse.ps1).
# This is the visible-desktop "don't hijack my mouse" path; controlling a HIDDEN/background app needs isolation.
param([string]$cmd="tap")
$a=$args
# --- Action audit log (trace what Neko did; review the steps with: read %TEMP%\neko_actions.log) ---
if($cmd -in 'tap','dbltap','stroke'){ try { $alog= if($env:NEKO_ACTION_LOG){$env:NEKO_ACTION_LOG}else{"$env:TEMP\neko_actions.log"}; ("{0}  inject {1} {2}" -f (Get-Date -Format 'HH:mm:ss'),$cmd,($a -join ' ')) | Out-File $alog -Append -Encoding utf8 } catch {} }

# --- Agent presence (opt-in via NEKO_PRESENCE): point the independent overlay cursor + honour takeover. ---
if($env:NEKO_PRESENCE){
  $stop="$env:TEMP\neko_overlay.stop"; $run="$env:TEMP\neko_overlay.run"; $tgt="$env:TEMP\neko_cursor.txt"
  if((Test-Path $stop) -and ((Get-Content $stop -TotalCount 1 -ErrorAction SilentlyContinue) -match 'user')){ Write-Output "PAUSED: the user took control. STOP acting -> run idle.ps1 to wait until they're done -> then re-screenshot / uia.ps1 read and resume toward the goal."; exit }
  if(-not (Test-Path $run) -or (((Get-Date)-(Get-Item $run).LastWriteTime).TotalSeconds -gt 3)){ Remove-Item $stop -ErrorAction SilentlyContinue; Start-Process powershell -ArgumentList '-NoProfile','-File',(Join-Path $PSScriptRoot 'overlay.ps1') -WindowStyle Hidden }
  if($cmd -in 'tap','dbltap','stroke'){ "$($a[0]),$($a[1])|Neko $cmd" | Out-File $tgt -Encoding ascii }
  if($env:NEKO_DRAW_WINDOW){ $env:NEKO_DRAW_WINDOW | Out-File "$env:TEMP\neko_active_window.txt" -Encoding utf8 }  # overlay frames + labels this window/tab
}
# --- Optional: raise a target window so the touch lands on it (touch hits the topmost window at the point). ---
if($env:NEKO_DRAW_WINDOW){
  Add-Type 'using System;using System.Runtime.InteropServices;public class FgI{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}'
  $tw=Get-Process | Where-Object { $_.MainWindowTitle -like "*$($env:NEKO_DRAW_WINDOW)*" } | Select-Object -First 1
  if($tw){ [FgI]::ShowWindow($tw.MainWindowHandle,3) | Out-Null; [FgI]::SetForegroundWindow($tw.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 200 }
}

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class TI {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l; public int t; public int r; public int b; }
  [StructLayout(LayoutKind.Sequential)] public struct PI {
    public uint pointerType; public uint pointerId; public uint frameId; public uint pointerFlags;
    public IntPtr sourceDevice; public IntPtr hwndTarget; public POINT ptPixelLocation; public POINT ptHimetricLocation;
    public POINT ptPixelLocationRaw; public POINT ptHimetricLocationRaw; public uint dwTime; public uint historyCount;
    public int InputData; public uint dwKeyStates; public ulong PerformanceCount; public int ButtonChangeType; }
  [StructLayout(LayoutKind.Sequential)] public struct PTI {
    public PI pointerInfo; public uint touchFlags; public uint touchMask; public RECT rcContact;
    public RECT rcContactRaw; public uint orientation; public uint pressure; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool InitializeTouchInjection(uint maxCount, uint dwMode);
  [DllImport("user32.dll", SetLastError=true)] static extern bool InjectTouchInput(uint count, [In] PTI[] c);
  const uint PT_TOUCH=0x2, F_DOWN=0x10000, F_UPDATE=0x20000, F_UP=0x40000, F_INRANGE=0x2, F_INCONTACT=0x4, MASK=0x7;
  static PTI Mk(int x,int y,uint f){ PTI t=new PTI(); t.pointerInfo.pointerType=PT_TOUCH; t.pointerInfo.pointerId=0;
    t.pointerInfo.pointerFlags=f; t.pointerInfo.ptPixelLocation.X=x; t.pointerInfo.ptPixelLocation.Y=y;
    t.touchMask=MASK; t.orientation=90; t.pressure=32000; t.rcContact.l=x-2; t.rcContact.r=x+2; t.rcContact.t=y-2; t.rcContact.b=y+2; return t; }
  public static bool Init(){ return InitializeTouchInjection(10,1); }
  static bool Send(int x,int y,uint f){ return InjectTouchInput(1,new PTI[]{Mk(x,y,f)}); }
  public static void Down(int x,int y){ Send(x,y,F_DOWN|F_INRANGE|F_INCONTACT); }
  public static void Move(int x,int y){ Send(x,y,F_UPDATE|F_INRANGE|F_INCONTACT); }
  public static void Up(int x,int y){ Send(x,y,F_UP); }
}
"@
[TI]::Init() | Out-Null
function Tap($x,$y){ [TI]::Down($x,$y); Start-Sleep -Milliseconds 60; [TI]::Up($x,$y) }

# --- act->verify for a tap (touch has no element identity, so we read the STRUCTURE): snapshot the foreground
# window's UIA control tree before/after and report what changed. On a non-UIA target (canvas/game) the diff is
# empty -> we say so + suggest a screenshot. Loaded only for tap/dbltap so stroke/drawing stays lean. ---
$script:uiaReady=$false
function UiaSig(){
  if(-not $script:uiaReady){ try { Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; Add-Type 'using System;using System.Runtime.InteropServices;public class FGq{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}'; $script:uiaReady=$true } catch { return $null } }
  try {
    $root=[System.Windows.Automation.AutomationElement]::FromHandle([FGq]::GetForegroundWindow()); if(-not $root){ return $null }
    $sig=New-Object 'System.Collections.Generic.HashSet[string]'
    $cr=New-Object System.Windows.Automation.CacheRequest
    $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty); $cr.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $cv=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty,$true)
    $h=$cr.Activate()
    try { foreach($x in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cv)){ $n=$x.Cached.Name; if($n){ [void]$sig.Add((($x.Cached.ControlType.ProgrammaticName -replace 'ControlType.','')+":"+$n)) } } } finally { $h.Dispose() }
    return $sig
  } catch { return $null }
}
function VerifyReport($before){
  if($null -eq $before){ return }
  Start-Sleep -Milliseconds 140; $after=UiaSig; if($null -eq $after){ return }
  $added=@($after | Where-Object { -not $before.Contains($_) }); $removed=@($before | Where-Object { -not $after.Contains($_) })
  if($added.Count){ Write-Output ("  + appeared (" + $added.Count + "): " + (($added | Select-Object -First 12) -join '  |  ')) }
  if($removed.Count){ Write-Output ("  - gone (" + $removed.Count + "): " + (($removed | Select-Object -First 12) -join '  |  ')) }
  if(-not $added.Count -and -not $removed.Count){ Write-Output "  (no UIA tree change -- non-UIA target like a canvas/game, or no effect; screenshot to confirm)" }
}

switch($cmd){
  "tap"    { $b=UiaSig; Tap ([int]$a[0]) ([int]$a[1]); Write-Output ("tapped " + $a[0] + "," + $a[1]); VerifyReport $b }
  "dbltap" { $b=UiaSig; Tap ([int]$a[0]) ([int]$a[1]); Start-Sleep -Milliseconds 90; Tap ([int]$a[0]) ([int]$a[1]); Write-Output ("double-tapped " + $a[0] + "," + $a[1]); VerifyReport $b }
  "stroke" {
    if($a.Count -lt 4){ "usage: stroke x1 y1 x2 y2 [x3 y3 ...]"; break }
    [TI]::Down([int]$a[0],[int]$a[1]); Start-Sleep -Milliseconds 30
    for($k=2;$k+1 -lt $a.Count;$k+=2){ $ax=[int]$a[$k-2];$ay=[int]$a[$k-1];$bx=[int]$a[$k];$by=[int]$a[$k+1]
      for($t=1;$t -le 16;$t++){ [TI]::Move([int]($ax+($bx-$ax)*$t/16),[int]($ay+($by-$ay)*$t/16)); Start-Sleep -Milliseconds 10 } }
    Start-Sleep -Milliseconds 40; [TI]::Up([int]$a[$a.Count-2],[int]$a[$a.Count-1]); "stroke done (touch, mouse not moved)"
  }
  default  { "usage: tap <x> <y> | dbltap <x> <y> | stroke <x1> <y1> <x2> <y2> ...  (touch injection; mouse not hijacked)" }
}
