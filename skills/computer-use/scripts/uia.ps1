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
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type 'using System;using System.Runtime.InteropServices;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);}'
$A=[System.Windows.Automation.AutomationElement]
$TS=[System.Windows.Automation.TreeScope]
$TrueC=[System.Windows.Automation.Condition]::TrueCondition
function PC($prop,$val){ New-Object System.Windows.Automation.PropertyCondition($prop,$val) }

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
  "invoke" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $ip=Pat $e ([System.Windows.Automation.InvokePattern]::Pattern); if($ip){ $ip.Invoke(); Write-Output "invoked: $name"; exit }
    $sp=Pat $e ([System.Windows.Automation.SelectionItemPattern]::Pattern); if($sp){ $sp.Select(); Write-Output "selected: $name"; exit }
    $tp=Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if($tp){ $tp.Toggle(); Write-Output "toggled: $name"; exit }
    $r=$e.Current.BoundingRectangle; $cx=[int]($r.X+$r.Width/2); $cy=[int]($r.Y+$r.Height/2)
    [FG]::SetCursorPos($cx,$cy); Start-Sleep -Milliseconds 60; [FG]::mouse_event(0x0002,0,0,0,0); [FG]::mouse_event(0x0004,0,0,0,0); Write-Output "clicked: $name @ $cx,$cy"
  }
  "setvalue" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $vp=Pat $e ([System.Windows.Automation.ValuePattern]::Pattern); if($vp){ $vp.SetValue($value); Write-Output "set '$name' = '$value'"; exit }
    Write-Output "no ValuePattern on: $name"; exit 1
  }
  "toggle" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $tp=Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if($tp){ $tp.Toggle(); Write-Output "toggled: $name -> $($tp.Current.ToggleState)"; exit }
    Write-Output "no TogglePattern on: $name"; exit 1
  }
  "get" {
    $e=FindByName $name; if(-not $e){ Write-Output "not found: $name"; exit 1 }
    $vp=Pat $e ([System.Windows.Automation.ValuePattern]::Pattern); if($vp){ Write-Output "value '$name' = '$($vp.Current.Value)'"; exit }
    $tp=Pat $e ([System.Windows.Automation.TogglePattern]::Pattern); if($tp){ Write-Output "toggle '$name' = $($tp.Current.ToggleState)"; exit }
    Write-Output "name '$name' present (no value/toggle pattern)"
  }
  default { Write-Output "usage: uia.ps1 list | invoke '<name>' | setvalue '<name>' '<text>' | toggle '<name>' | get '<name>'" }
}
