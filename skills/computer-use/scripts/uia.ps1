# Dump the foreground window's interactive elements via Windows UI Automation (UIA) -- the desktop
# accessibility tree, the OS-native analogue of the web DOM. A PLAIN TEXT model (gpt-oss) grounds via this:
# it gets each element's name + role + EXACT bounding rectangle FROM THE OS (not an estimate), picks the
# element by name, and clicks its center. No vision, no GUI-trained model, pixel-perfect, <100ms, private
# (no screenshot leaves the machine). This is how Windows-Use / DirectShell / UFO2 control desktop apps.
# Usage:  powershell -NoProfile -File uia.ps1 [maxElements]
param([int]$max=80)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type 'using System;using System.Runtime.InteropServices;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}'
$A=[System.Windows.Automation.AutomationElement]
$root=$A::FromHandle([FG]::GetForegroundWindow())
if(-not $root){ Write-Output "(no foreground UIA element)"; exit }
Write-Output ("WINDOW: " + $root.Current.Name + "  [" + ($root.Current.ControlType.ProgrammaticName -replace 'ControlType.','') + "]")
$interactive='Button','Edit','Document','MenuItem','CheckBox','RadioButton','ComboBox','Hyperlink','TabItem','ListItem','Slider','SplitButton','Menu','Text','Image','Custom'
$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$n=0
foreach($e in $all){
  if($n -ge $max){ break }
  $c=$e.Current
  $ct=$c.ControlType.ProgrammaticName -replace 'ControlType.',''
  if($interactive -notcontains $ct){ continue }
  $nm=$c.Name; if(-not $nm -or $nm.Length -gt 60){ continue }
  $r=$c.BoundingRectangle; if($r.Width -le 0 -or $r.Height -le 0 -or [double]::IsInfinity($r.X)){ continue }
  $cx=[int]($r.X+$r.Width/2); $cy=[int]($r.Y+$r.Height/2)
  Write-Output ("[$ct] '$nm' -> click $cx,$cy")
  $n++
}
Write-Output ("($n interactive elements; click any via: mouse.ps1 click <x> <y>)")
