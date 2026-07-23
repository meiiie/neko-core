# Desktop control via Windows UI Automation (UIA) -- the OS accessibility tree, the desktop analogue of the
# web DOM. A PLAIN TEXT model (gpt-oss) grounds + acts via STRUCTURE, not pixels: NO vision, NO GUI-trained
# model, pixel/element-perfect, fast, private. Beyond a coordinate click, UIA INVOKES controls
# programmatically (InvokePattern/ValuePattern/Toggle/Select) -- the path assistive tech uses: no cursor
# movement, no focus stealing, works even when the window is occluded. This is how Windows-Use / UFO2 work.
#
# PERFORMANCE (the SOTA bit): modern apps (WinUI/WPF) have huge UIA trees; a naive
# FindAll(Descendants,TrueCondition) makes one cross-process COM round-trip PER node and TIMES OUT. We use a
# CacheRequest (bulk-fetch every property+pattern server-side in ONE call) + scope to the Control view +
# server-side FindFirst(NameProperty=...) for actions. Fast and reliable on rich apps.
#
# Usage:
#   uia.ps1 list                         -> interactive elements: [role] 'name' -> click x,y
#   uia.ps1 invoke   "<name>"            -> activate a button/link/menuitem (Invoke|Select|Toggle, else click)
#   uia.ps1 setvalue "<name>" "<text>"   -> set a text field's value (ValuePattern)
#   uia.ps1 toggle   "<name>"            -> toggle a checkbox/switch
#   uia.ps1 get      "<name>"            -> read an element's current value/toggle state (verify an action)
# Target window: $env:NEKO_UIA_WINDOW (title substring) else the foreground window. (UIA acts without focus.)
# NOTE: UWP apps (Calculator) suspend their UIA tree when fully hidden -- keep them visible. Classic Win32
#       and WPF/WinForms apps keep their tree alive when backgrounded (best for automation).
param([string]$cmd="list", [string]$name="", [string]$value="", [int]$max=120)
# DPI: PER-MONITOR-AWARE v2 so coordinates are TRUE physical pixels. CONFIRMED necessary: on a 125%-scaled
# display, a DPI-UNAWARE acting process taps/clicks at virtualized coords (Windows scales them up ~1.25x) and
# MISSES the target, while a DPI-aware read+click lands (verified: checkbox toggled). All five coordinate
# scripts (uia/inject/mouse/overlay/screenshot) MUST set this identically so reads and actions share one space.
try { Add-Type 'using System;using System.Runtime.InteropServices;public class Dpi{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);}'; [void][Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type 'using System;using System.Runtime.InteropServices;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);}'
$A=[System.Windows.Automation.AutomationElement]
$TS=[System.Windows.Automation.TreeScope]
$TrueC=[System.Windows.Automation.Condition]::TrueCondition
function PC($prop,$val){ New-Object System.Windows.Automation.PropertyCondition($prop,$val) }

# activate: Win32-ONLY fast path, BEFORE any UIA. The UIA window enumeration below reads a property
# off every top-level window, which BLOCKS on Chromium/Electron windows (Zalo, Discord, VS Code)
# where forced renderer accessibility makes each cross-process read hang - that is why `activate`
# timed out at 90s. Get-Process gives the main window handle with no UIA round-trip; restore +
# foreground it. Requires a target title (activating "the foreground" would be a no-op).
if($cmd -eq 'activate'){
  $q=$env:NEKO_UIA_WINDOW
  if(-not $q){ Write-Output "(activate needs a target window title)"; exit 1 }
  $p=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$q*" } | Sort-Object { $_.MainWindowTitle.Length } | Select-Object -First 1
  if(-not $p){ Write-Output "(no window titled like '$q')"; exit 1 }
  $h=$p.MainWindowHandle
  if([FG]::IsIconic($h)){ [void][FG]::ShowWindow($h,9) }
  [void][FG]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 200
  Write-Output ("ACTIVATED: " + $p.MainWindowTitle)
  exit 0
}

# --- target window: env title-substring (largest match) else foreground ---
if($env:NEKO_UIA_WINDOW){
  $root=$A::RootElement.FindAll($TS::Children,$TrueC) | Where-Object { $_.Current.Name -like "*$($env:NEKO_UIA_WINDOW)*" } | Sort-Object { $_.Current.BoundingRectangle.Width } -Descending | Select-Object -First 1
} else { $root=$A::FromHandle([FG]::GetForegroundWindow()) }
if(-not $root){ Write-Output "(no target window)"; exit 1 }

# --- CacheRequest: bulk-fetch properties + patterns in ONE server-side call (the anti-timeout trick) ---
$cr=New-Object System.Windows.Automation.CacheRequest
foreach($p in @($A::NameProperty,$A::ControlTypeProperty,$A::BoundingRectangleProperty,$A::IsEnabledProperty,
  $A::IsInvokePatternAvailableProperty,$A::IsValuePatternAvailableProperty,$A::IsTogglePatternAvailableProperty,
  $A::IsSelectionItemPatternAvailableProperty,$A::IsExpandCollapsePatternAvailableProperty)){ $cr.Add($p) }
foreach($pat in @([System.Windows.Automation.InvokePattern]::Pattern,[System.Windows.Automation.ValuePattern]::Pattern,[System.Windows.Automation.TogglePattern]::Pattern,[System.Windows.Automation.SelectionItemPattern]::Pattern)){ $cr.Add($pat) }
$ctrlView=PC $A::IsControlElementProperty $true   # Control view prunes raw-tree noise

function AllControls(){ $h=$cr.Activate(); try { return $root.FindAll($TS::Descendants,$ctrlView) } finally { $h.Dispose() } }
# server-side exact match first (fast, no per-node round-trip); cached substring scan only as fallback
function FindByName($nm){
  $h=$cr.Activate()
  try {
    $e=$root.FindFirst($TS::Descendants,(PC $A::NameProperty $nm)); if($e){ return $e }
    foreach($x in $root.FindAll($TS::Descendants,$ctrlView)){ if($x.Cached.Name -like "*$nm*"){ return $x } }
  } finally { $h.Dispose() }
  return $null
}
function Pat($e,$p){ try { return $e.GetCurrentPattern($p) } catch { return $null } }
# act->verify for invoke: a fingerprint of the window's control tree ("type:name" set) + the set of top-level
# window titles. Diffing before/after an invoke shows DETERMINISTICALLY what the action changed (menu opened,
# fields appeared, a dialog popped) -- invoke has no single property to read back, so we read the STRUCTURE.
function TreeSig($r){
  $sig=New-Object 'System.Collections.Generic.HashSet[string]'
  $h=$cr.Activate()
  try { foreach($x in $r.FindAll($TS::Descendants,$ctrlView)){ $c=$x.Cached; $nm=$c.Name; if($nm){ [void]$sig.Add((($c.ControlType.ProgrammaticName -replace 'ControlType.','')+":"+$nm)) } } } finally { $h.Dispose() }
  return $sig
}
function WindowSig(){
  $s=New-Object 'System.Collections.Generic.HashSet[string]'
  foreach($w in $A::RootElement.FindAll($TS::Children,$TrueC)){ $n=$w.Current.Name; if($n){ [void]$s.Add($n) } }
  return $s
}
# Unicode-safe targets: pass `@<path>` to read the name/value from a UTF-8 file (the Windows console is
# cp1252, so non-ASCII args -- Vietnamese, CJK, emoji -- mangle on the command line; a file round-trips clean).
if($name -like '@*' -and (Test-Path $name.Substring(1))){ $name=(Get-Content $name.Substring(1) -Raw -Encoding UTF8).TrimEnd("`r","`n") }
if($value -like '@*' -and (Test-Path $value.Substring(1))){ $value=(Get-Content $value.Substring(1) -Raw -Encoding UTF8).TrimEnd("`r","`n") }
# --- Action audit log (trace; review the steps with: read %TEMP%\neko_actions.log) ---
if($cmd -in 'invoke','setvalue','toggle'){ try { $alog= if($env:NEKO_ACTION_LOG){$env:NEKO_ACTION_LOG}else{"$env:TEMP\neko_actions.log"}; $detail=if($cmd -eq 'setvalue'){" ($($value.Length) chars)"}else{""}; ("{0}  uia {1} '{2}'{3}" -f (Get-Date -Format 'HH:mm:ss'),$cmd,$name,$detail) | Out-File $alog -Append -Encoding utf8 } catch {} }

switch($cmd){
  "list" {
    Write-Output ("WINDOW: " + $root.Current.Name)
    # Capability-first: keep anything ACTIONABLE (supports a pattern) OR a known interactive control type --
    # so this works on native-UIA apps AND MSAA-bridged ones (where everything degrades to [Pane]).
    $keep='Button','Edit','Document','MenuItem','CheckBox','RadioButton','ComboBox','Hyperlink','TabItem','ListItem','Slider','SplitButton','Menu','Custom'
    $n=0
    foreach($e in (AllControls)){
      if($n -ge $max){ break }
      $c=$e.Cached; $ct=$c.ControlType.ProgrammaticName -replace 'ControlType.',''
      $nm=$c.Name; if(-not $nm -or $nm.Length -gt 60){ continue }
      $r=$c.BoundingRectangle; if($r.Width -le 0 -or [double]::IsInfinity($r.X)){ continue }
      # action verb from the supported pattern (tells gpt-oss invoke vs setvalue vs toggle)
      $act=$null
      if($e.GetCachedPropertyValue($A::IsValuePatternAvailableProperty)){ $act='setvalue' }
      elseif($e.GetCachedPropertyValue($A::IsTogglePatternAvailableProperty)){ $act='toggle' }
      elseif($e.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty) -or $e.GetCachedPropertyValue($A::IsSelectionItemPatternAvailableProperty) -or $e.GetCachedPropertyValue($A::IsExpandCollapsePatternAvailableProperty)){ $act='invoke' }
      if(-not $act -and ($keep -notcontains $ct)){ continue }   # no pattern + not an interactive type -> skip
      if(-not $act){ $act='invoke' }
      Write-Output ("[$ct] '$nm' ($act) -> " + [int]($r.X+$r.Width/2) + "," + [int]($r.Y+$r.Height/2)); $n++
    }
    Write-Output "($n elements; act by name e.g. uia.ps1 invoke '<name>')"
  }
  "read" {
    # Dump the page's READABLE text (Text/Document/Hyperlink/Edit/ListItem names), deduped, in tree order --
    # for reading/summarizing a web page or doc as TEXT, no vision. (list = actionable; read = content.)
    Write-Output ("WINDOW: " + $root.Current.Name)
    $textTypes='Text','Document','Edit','Hyperlink','ListItem','Button'
    $seen=@{}; $n=0; $cap=[Math]::Max($max,300)
    foreach($e in (AllControls)){
      if($n -ge $cap){ break }
      $c=$e.Cached; $ct=$c.ControlType.ProgrammaticName -replace 'ControlType.',''
      if($textTypes -notcontains $ct){ continue }
      $nm=$c.Name; if(-not $nm){ continue }; $nm=$nm.Trim(); if($nm.Length -lt 2){ continue }
      if($seen.ContainsKey($nm)){ continue }; $seen[$nm]=$true
      Write-Output $nm; $n++
    }
    Write-Output "($n text blocks)"
  }
  "invoke" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    # snapshot the structure BEFORE acting (so we can prove what changed)
    $beforeT=TreeSig $root; $beforeW=WindowSig
    $did=$null
    $ip=Pat $e ([System.Windows.Automation.InvokePattern]::Pattern); if($ip){ $ip.Invoke(); $did='invoked' }
    if(-not $did){ $sp=Pat $e ([System.Windows.Automation.SelectionItemPattern]::Pattern); if($sp){ $sp.Select(); $did='selected' } }
    if(-not $did){ $tp=Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if($tp){ $tp.Toggle(); $did='toggled' } }
    if(-not $did){
      $r=$e.Current.BoundingRectangle; $cx=[int]($r.X+$r.Width/2); $cy=[int]($r.Y+$r.Height/2)
      [FG]::SetCursorPos($cx,$cy); Start-Sleep -Milliseconds 60; [FG]::mouse_event(0x0002,0,0,0,0); [FG]::mouse_event(0x0004,0,0,0,0); $did="clicked @ $cx,$cy"
    }
    # act->VERIFY: diff the tree + windows AFTER, so the model SEES the effect (no vision, deterministic).
    Start-Sleep -Milliseconds 140
    $afterT=TreeSig $root; $afterW=WindowSig
    $added=@($afterT | Where-Object { -not $beforeT.Contains($_) })
    $removed=@($beforeT | Where-Object { -not $afterT.Contains($_) })
    $newWin=@($afterW | Where-Object { -not $beforeW.Contains($_) })
    Write-Output "${did}: $name"
    if($newWin.Count){ Write-Output ("  + NEW WINDOW: " + ($newWin -join '; ')) }
    if($added.Count){ Write-Output ("  + appeared ($($added.Count)): " + (($added | Select-Object -First 14) -join '  |  ')) }
    if($removed.Count){ Write-Output ("  - gone ($($removed.Count)): " + (($removed | Select-Object -First 14) -join '  |  ')) }
    if(-not $newWin.Count -and -not $added.Count -and -not $removed.Count){ Write-Output "  (no tree change detected -- action may have had NO effect, or its effect is outside this window; try `list` on the foreground)" }
  }
  "setvalue" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $vp=Pat $e ([System.Windows.Automation.ValuePattern]::Pattern); if(-not $vp){ Write-Output "no ValuePattern on: $name; this may be contenteditable - use computer type with the freshly observed element name"; exit 1 }
    if($vp.Current.IsReadOnly){ Write-Output "FAIL setvalue: '$name' is READ-ONLY (cannot set)"; exit 1 }
    $vp.SetValue($value)
    # act -> VERIFY (deterministic): read the value back and confirm it landed. Catches input the field
    # rejected / reformatted / masked / truncated -- so the model never assumes a silent setvalue worked.
    Start-Sleep -Milliseconds 40
    $actual=$vp.Current.Value
    if($actual -ceq $value){ Write-Output "set+VERIFIED '$name' = '$value'" }
    else { Write-Output "WARN setvalue MISMATCH on '$name': requested '$value' but field now reads '$actual' (rejected/reformatted/masked?)"; exit 1 }
    exit
  }
  "toggle" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $tp=Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if(-not $tp){ Write-Output "no TogglePattern on: $name"; exit 1 }
    $before=$tp.Current.ToggleState; $tp.Toggle(); Start-Sleep -Milliseconds 40; $after=$tp.Current.ToggleState
    # act -> VERIFY: the state must actually have changed.
    if($after -ne $before){ Write-Output "toggled+VERIFIED '$name': $before -> $after" }
    else { Write-Output "WARN toggle: '$name' state did NOT change (still $after)"; exit 1 }
    exit
  }
  "get" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $vp=Pat $e ([System.Windows.Automation.ValuePattern]::Pattern); if($vp){ Write-Output "value '$name' = '$($vp.Current.Value)'"; exit }
    $tp=Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if($tp){ Write-Output "toggle '$name' = $($tp.Current.ToggleState)"; exit }
    Write-Output "name '$name' present (no value/toggle pattern)"
  }
  default { Write-Output "usage: uia.ps1 list | invoke '<name>' | setvalue '<name>' '<text>' | toggle '<name>' | get '<name>'" }
}
