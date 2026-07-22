# Persistent JSONL Windows UI Automation + input host. One process pays PowerShell/.NET/native startup once;
# the TypeScript adapter keeps the existing one-shot scripts as a transport-failure fallback.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
  Add-Type 'using System;using System.Runtime.InteropServices;public class NekoResidentDpi{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);}'
  [void][NekoResidentDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type 'using System;using System.Runtime.InteropServices;public class NekoResidentFg{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);}'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NekoResidentInputNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }

  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  const uint INPUT_MOUSE=0, INPUT_KEYBOARD=1, KEYUP=0x0002, UNICODE=0x0004, EXTENDED=0x0001;
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i=new INPUT(); i.type=INPUT_KEYBOARD; i.U.ki.wVk=vk; i.U.ki.wScan=scan; i.U.ki.dwFlags=flags; return i;
  }
  static void Send(List<INPUT> items) {
    INPUT[] input=items.ToArray();
    uint sent=SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)));
    if(sent != input.Length) throw new InvalidOperationException("SendInput failed (possibly UIPI/elevated target), error " + Marshal.GetLastWin32Error());
  }
  public static void Text(string text) {
    List<INPUT> items=new List<INPUT>(512);
    foreach(char ch in text){
      items.Add(Key(0,ch,UNICODE)); items.Add(Key(0,ch,UNICODE|KEYUP));
      if(items.Count >= 512){ Send(items); items.Clear(); }
    }
    if(items.Count > 0) Send(items);
  }
  public static void Chord(ushort[] modifiers, ushort main, bool extended) {
    List<INPUT> items=new List<INPUT>();
    foreach(ushort key in modifiers) items.Add(Key(key,0,0));
    uint flag=extended ? EXTENDED : 0;
    items.Add(Key(main,0,flag)); items.Add(Key(main,0,flag|KEYUP));
    for(int i=modifiers.Length-1;i>=0;i--) items.Add(Key(modifiers[i],0,KEYUP));
    Send(items);
  }
  public static bool FocusWindow(IntPtr hwnd) {
    IntPtr foreground=GetForegroundWindow();
    uint currentThread=GetCurrentThreadId();
    uint foregroundThread=GetWindowThreadProcessId(foreground,IntPtr.Zero);
    uint targetThread=GetWindowThreadProcessId(hwnd,IntPtr.Zero);
    bool attachedForeground=false, attachedTarget=false;
    try {
      if(foregroundThread != 0 && foregroundThread != currentThread) attachedForeground=AttachThreadInput(currentThread,foregroundThread,true);
      if(targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) attachedTarget=AttachThreadInput(currentThread,targetThread,true);
      ShowWindow(hwnd,9); BringWindowToTop(hwnd); SetForegroundWindow(hwnd); SetActiveWindow(hwnd);
    } finally {
      if(attachedTarget) AttachThreadInput(currentThread,targetThread,false);
      if(attachedForeground) AttachThreadInput(currentThread,foregroundThread,false);
    }
    return GetAncestor(GetForegroundWindow(),2) == GetAncestor(hwnd,2);
  }
  static INPUT Mouse(uint flags, int x, int y) {
    INPUT i=new INPUT(); i.type=INPUT_MOUSE; i.U.mi.dx=x; i.U.mi.dy=y; i.U.mi.dwFlags=flags; return i;
  }
  public static void MoveMouse(int x,int y) {
    int left=GetSystemMetrics(76), top=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79);
    int nx=(int)((long)(x-left)*65535/Math.Max(width-1,1));
    int ny=(int)((long)(y-top)*65535/Math.Max(height-1,1));
    Send(new List<INPUT>{Mouse(0x8001|0x4000,nx,ny)});
  }
  public static void MouseDown(){ Send(new List<INPUT>{Mouse(0x0002,0,0)}); }
  public static void MouseUp(){ Send(new List<INPUT>{Mouse(0x0004,0,0)}); }
}

public static class NekoResidentTouch {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l; public int t; public int r; public int b; }
  [StructLayout(LayoutKind.Sequential)] public struct PI {
    public uint pointerType, pointerId, frameId, pointerFlags; public IntPtr sourceDevice, hwndTarget;
    public POINT ptPixelLocation, ptHimetricLocation, ptPixelLocationRaw, ptHimetricLocationRaw;
    public uint dwTime, historyCount; public int InputData; public uint dwKeyStates; public ulong PerformanceCount; public int ButtonChangeType;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PTI {
    public PI pointerInfo; public uint touchFlags, touchMask; public RECT rcContact, rcContactRaw; public uint orientation, pressure;
  }
  [DllImport("user32.dll", SetLastError=true)] static extern bool InitializeTouchInjection(uint maxCount, uint mode);
  [DllImport("user32.dll", SetLastError=true)] static extern bool InjectTouchInput(uint count, [In] PTI[] contacts);
  const uint PT_TOUCH=0x2, F_DOWN=0x10000, F_UPDATE=0x20000, F_UP=0x40000, F_INRANGE=0x2, F_INCONTACT=0x4, MASK=0x7;
  static bool initialized=false;
  static void Ensure(){ if(initialized) return; if(!InitializeTouchInjection(10,1)) throw new InvalidOperationException("touch injection init failed, error "+Marshal.GetLastWin32Error()); initialized=true; }
  static PTI Make(int x,int y,uint flags){ PTI t=new PTI(); t.pointerInfo.pointerType=PT_TOUCH; t.pointerInfo.pointerId=0; t.pointerInfo.pointerFlags=flags; t.pointerInfo.ptPixelLocation.X=x; t.pointerInfo.ptPixelLocation.Y=y; t.touchMask=MASK; t.orientation=90; t.pressure=32000; t.rcContact.l=x-2; t.rcContact.r=x+2; t.rcContact.t=y-2; t.rcContact.b=y+2; return t; }
  static void Send(int x,int y,uint flags){ Ensure(); if(!InjectTouchInput(1,new PTI[]{Make(x,y,flags)})) throw new InvalidOperationException("touch injection failed, error "+Marshal.GetLastWin32Error()); }
  public static void Down(int x,int y){ Send(x,y,F_DOWN|F_INRANGE|F_INCONTACT); }
  public static void Move(int x,int y){ Send(x,y,F_UPDATE|F_INRANGE|F_INCONTACT); }
  public static void Up(int x,int y){ Send(x,y,F_UP); }
}
"@

$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TrueC = [System.Windows.Automation.Condition]::TrueCondition

function PC($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Trace-Host([string]$message) {
  if ($env:NEKO_UIA_DEBUG -eq '1') {
    [Console]::Error.WriteLine($message)
    [Console]::Error.Flush()
  }
}

$cr = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @(
  $A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty,
  $A::IsInvokePatternAvailableProperty, $A::IsValuePatternAvailableProperty, $A::IsTogglePatternAvailableProperty,
  $A::IsSelectionItemPatternAvailableProperty, $A::IsExpandCollapsePatternAvailableProperty
)) { $cr.Add($p) }
foreach ($pat in @(
  [System.Windows.Automation.InvokePattern]::Pattern,
  [System.Windows.Automation.ValuePattern]::Pattern,
  [System.Windows.Automation.TogglePattern]::Pattern,
  [System.Windows.Automation.SelectionItemPattern]::Pattern
)) { $cr.Add($pat) }
$ctrlView = PC $A::IsControlElementProperty $true

function Get-TargetRoot([string]$window) {
  Trace-Host "find-window start '$window'"
  if ($window) {
    $found = $A::RootElement.FindAll($TS::Children, $TrueC) |
      Where-Object { $_.Current.Name -like "*$window*" } |
      Sort-Object { $_.Current.BoundingRectangle.Width } -Descending |
      Select-Object -First 1
    Trace-Host "find-window done found=$([bool]$found)"
    return $found
  }
  $found = $A::FromHandle([NekoResidentFg]::GetForegroundWindow())
  Trace-Host "find-foreground done found=$([bool]$found)"
  return $found
}

function Get-AllControls($root) {
  Trace-Host 'all-controls activate'
  $h = $cr.Activate()
  try {
    $found = $root.FindAll($TS::Descendants, $ctrlView)
    Trace-Host "all-controls done count=$($found.Count)"
    return $found
  } finally { $h.Dispose() }
}

function Get-TextId([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
    return ([BitConverter]::ToString($hash).Replace('-', '').Substring(0, 12)).ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-ReadableState($root, [int]$max = 120) {
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.Add('WINDOW: ' + $root.Current.Name)
  $signature = New-Object 'System.Collections.Generic.List[string]'
  $types = @('Text', 'Document', 'Edit', 'Hyperlink', 'ListItem', 'Button')
  $seen = @{}
  $count = 0
  $cap = [Math]::Max($max, 300)
  $scanned = 0
  foreach ($element in (Get-AllControls $root)) {
    $cached = $element.Cached
    $type = $cached.ControlType.ProgrammaticName -replace 'ControlType.', ''
    if ($types -notcontains $type) { continue }
    $label = [string]$cached.Name
    if (-not $label) { continue }
    $label = $label.Trim()
    if ($label.Length -lt 2) { continue }
    # The watch fingerprint keeps duplicates + geometry: two identical incoming messages are still two
    # events, while the human-facing read stays deduplicated and compact.
    if ($scanned -lt 1000) {
      $rect = $cached.BoundingRectangle
      $fingerprintLabel = if ($label.Length -gt 1000) { $label.Substring(0, 1000) } else { $label }
      $signature.Add("$type|$([int]$rect.X),$([int]$rect.Y),$([int]$rect.Width),$([int]$rect.Height)|$fingerprintLabel")
      $scanned++
    }
    if ($count -ge $cap -or $seen.ContainsKey($label)) { continue }
    $seen[$label] = $true
    $lines.Add($label)
    $count++
  }
  $lines.Add("($count text blocks)")
  $text = ('WINDOW|' + $root.Current.Name + "`n" + ($signature -join "`n"))
  return [PSCustomObject]@{ Lines = $lines.ToArray(); Text = $text; Id = (Get-TextId $text) }
}

function Get-ReadableSnapshot($root, [int]$max = 120) {
  return (Get-ReadableState $root $max).Lines
}

function Find-ByName($root, [string]$name) {
  $h = $cr.Activate()
  try {
    $exact = $root.FindFirst($TS::Descendants, (PC $A::NameProperty $name))
    if ($exact) { return $exact }
    foreach ($item in $root.FindAll($TS::Descendants, $ctrlView)) {
      if ($item.Cached.Name -like "*$name*") { return $item }
    }
  } finally { $h.Dispose() }
  return $null
}

function Get-Pattern($element, $pattern) {
  try { return $element.GetCurrentPattern($pattern) } catch { return $null }
}

function Get-TreeSignature($root) {
  $signature = New-Object 'System.Collections.Generic.HashSet[string]'
  $h = $cr.Activate()
  try {
    foreach ($item in $root.FindAll($TS::Descendants, $ctrlView)) {
      $cached = $item.Cached
      if ($cached.Name) {
        [void]$signature.Add((($cached.ControlType.ProgrammaticName -replace 'ControlType.', '') + ':' + $cached.Name))
      }
    }
  } finally { $h.Dispose() }
  return $signature
}

function Get-WindowSignature() {
  $signature = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($window in $A::RootElement.FindAll($TS::Children, $TrueC)) {
    if ($window.Current.Name) { [void]$signature.Add($window.Current.Name) }
  }
  return $signature
}

function Write-ActionAudit([string]$action, [string]$name, [string]$value) {
  if ($action -notin @('invoke', 'setvalue', 'toggle', 'click', 'stroke', 'type', 'key', 'scroll')) { return }
  try {
    $log = if ($env:NEKO_ACTION_LOG) { $env:NEKO_ACTION_LOG } else { "$env:TEMP\neko_actions.log" }
    $detail = if ($action -in @('setvalue', 'type')) { " ($($value.Length) chars)" } else { '' }
    ("{0}  uia {1} '{2}'{3}" -f (Get-Date -Format 'HH:mm:ss'), $action, $name, $detail) |
      Out-File $log -Append -Encoding utf8
  } catch {}
}

function Write-ObservationAudit([string]$status, [string]$window, [long]$elapsed, [long]$detected, [string]$state) {
  try {
    $log = if ($env:NEKO_OBSERVATION_LOG) { $env:NEKO_OBSERVATION_LOG } else { "$env:TEMP\neko_observations.log" }
    $windowId = Get-TextId (($window -replace '[\r\n\t]+', ' ').Trim())
    ("{0}  watch {1} elapsed_ms={2} detected_ms={3} state={4} window_id={5}" -f (Get-Date -Format 'HH:mm:ss.fff'), $status, $elapsed, $detected, $state, $windowId) |
      Out-File $log -Append -Encoding utf8
  } catch {}
}

function Get-InputTargetRoot([string]$window) {
  if (-not $window) { return $A::FromHandle([NekoResidentInputNative]::GetForegroundWindow()) }
  $matches = @($A::RootElement.FindAll($TS::Children, $TrueC) | Where-Object { $_.Current.Name -like "*$window*" })
  if (-not $matches.Count) { throw 'target window not found' }
  $exact = @($matches | Where-Object { $_.Current.Name -eq $window })
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($matches.Count -eq 1) { return $matches[0] }
  throw 'target title matches multiple windows; use a more specific title'
}

function Focus-InputTarget($root, [string]$elementName = '') {
  if (-not $root) { throw 'no foreground window' }
  $handle = [IntPtr]$root.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw 'target window has no native handle' }
  $focusElement = $null
  if ($elementName) {
    $focusElement = $root.FindFirst($TS::Descendants, (PC $A::NameProperty $elementName))
    if (-not $focusElement) { throw 'requested focus element not found' }
  }
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    [void][NekoResidentInputNative]::ShowWindow($handle, 9)
    try { [void](New-Object -ComObject WScript.Shell).AppActivate($root.Current.Name) } catch {}
    [void][NekoResidentInputNative]::FocusWindow($handle)
    Start-Sleep -Milliseconds 140
    $foreground = [NekoResidentInputNative]::GetForegroundWindow()
    if ([NekoResidentInputNative]::GetAncestor($foreground, 2) -ne [NekoResidentInputNative]::GetAncestor($handle, 2)) { continue }
    if (-not $focusElement) { return $handle }
    try { $focusElement.SetFocus() } catch {}
    Start-Sleep -Milliseconds 60
    if ($focusElement.Current.HasKeyboardFocus) { return $handle }
  }
  throw 'target window could not be focused; refusing to send input to another app'
}

function Assert-AgentPresence($request, [string]$label, [int]$x = 0, [int]$y = 0) {
  if (-not $request.presence) { return }
  $stop = "$env:TEMP\neko_overlay.stop"
  $run = "$env:TEMP\neko_overlay.run"
  if ((Test-Path $stop) -and ((Get-Content $stop -TotalCount 1 -ErrorAction SilentlyContinue) -match 'user')) {
    throw 'PAUSED: the user took control. STOP acting, wait, then re-perceive before resuming.'
  }
  if (-not (Test-Path $run) -or (((Get-Date) - (Get-Item $run).LastWriteTime).TotalSeconds -gt 3)) {
    Remove-Item $stop -ErrorAction SilentlyContinue
    Start-Process powershell -ArgumentList '-NoProfile','-File',(Join-Path $PSScriptRoot 'overlay.ps1') -WindowStyle Hidden `
      -RedirectStandardOutput "$env:TEMP\neko_overlay.stdout.log" `
      -RedirectStandardError "$env:TEMP\neko_overlay.stderr.log"
  }
  if ($label -in @('click', 'stroke')) { "$x,$y|Neko $label" | Out-File "$env:TEMP\neko_cursor.txt" -Encoding ascii }
  if ($request.window) { [string]$request.window | Out-File "$env:TEMP\neko_active_window.txt" -Encoding utf8 }
}

function Send-TouchTap([int]$x, [int]$y) {
  [NekoResidentTouch]::Down($x, $y)
  Start-Sleep -Milliseconds 60
  [NekoResidentTouch]::Up($x, $y)
}

function Send-Points($points, [string]$backend = 'inject') {
  if ($points.Count -lt 4 -or $points.Count % 2 -ne 0) { throw 'stroke needs at least two x,y points' }
  if ($backend -eq 'sendinput') {
    [NekoResidentInputNative]::MoveMouse([int]$points[0], [int]$points[1])
    Start-Sleep -Milliseconds 80
    [NekoResidentInputNative]::MouseDown()
  } else {
    [NekoResidentTouch]::Down([int]$points[0], [int]$points[1])
    Start-Sleep -Milliseconds 30
  }
  for ($k = 2; $k + 1 -lt $points.Count; $k += 2) {
    $ax = [int]$points[$k - 2]; $ay = [int]$points[$k - 1]
    $bx = [int]$points[$k]; $by = [int]$points[$k + 1]
    for ($t = 1; $t -le 16; $t++) {
      $x = [int]($ax + ($bx - $ax) * $t / 16); $y = [int]($ay + ($by - $ay) * $t / 16)
      if ($backend -eq 'sendinput') { [NekoResidentInputNative]::MoveMouse($x, $y) }
      else { [NekoResidentTouch]::Move($x, $y) }
      Start-Sleep -Milliseconds 10
    }
  }
  Start-Sleep -Milliseconds 40
  if ($backend -eq 'sendinput') { [NekoResidentInputNative]::MouseUp() }
  else { [NekoResidentTouch]::Up([int]$points[-2], [int]$points[-1]) }
}

function Send-KeyChord([string]$keys) {
  $parts = @($keys.ToUpperInvariant() -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if (-not $parts.Count) { throw 'empty key chord' }
  $modifierMap = @{ CTRL=0x11; CONTROL=0x11; ALT=0x12; SHIFT=0x10; WIN=0x5B; META=0x5B; CMD=0x5B }
  $keyMap = @{
    ENTER=0x0D; RETURN=0x0D; TAB=0x09; ESC=0x1B; ESCAPE=0x1B; SPACE=0x20;
    BACKSPACE=0x08; DELETE=0x2E; DEL=0x2E; INSERT=0x2D; INS=0x2D;
    HOME=0x24; END=0x23; PAGEUP=0x21; PGUP=0x21; PAGEDOWN=0x22; PGDN=0x22;
    LEFT=0x25; UP=0x26; RIGHT=0x27; DOWN=0x28;
    PLUS=0xBB; MINUS=0xBD; COMMA=0xBC; PERIOD=0xBE; SLASH=0xBF; BACKSLASH=0xDC;
    SEMICOLON=0xBA; QUOTE=0xDE; LBRACKET=0xDB; RBRACKET=0xDD; BACKTICK=0xC0
  }
  $modifiers = New-Object 'System.Collections.Generic.List[UInt16]'
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    if (-not $modifierMap.ContainsKey($parts[$i])) { throw "unsupported modifier '$($parts[$i])'" }
    $vk = [UInt16]$modifierMap[$parts[$i]]
    if (-not $modifiers.Contains($vk)) { $modifiers.Add($vk) }
  }
  $main = $parts[-1]
  if ($keyMap.ContainsKey($main)) { $vkMain = $keyMap[$main] }
  elseif ($main -match '^F([1-9]|1[0-9]|2[0-4])$') { $vkMain = 0x6F + [int]$Matches[1] }
  elseif ($main -match '^[A-Z0-9]$') { $vkMain = [int][char]$main }
  else { throw "unsupported key '$main'; use a named key or one letter/digit" }
  $extended = $main -in @('DELETE','DEL','INSERT','INS','HOME','END','PAGEUP','PGUP','PAGEDOWN','PGDN','LEFT','UP','RIGHT','DOWN')
  [NekoResidentInputNative]::Chord([UInt16[]]$modifiers.ToArray(), [UInt16]$vkMain, $extended)
  return $parts -join '+'
}

function Get-TreeChangeReport($root, $before) {
  Start-Sleep -Milliseconds 140
  $after = Get-TreeSignature $root
  $added = @($after | Where-Object { -not $before.Contains($_) })
  $removed = @($before | Where-Object { -not $after.Contains($_) })
  $lines = New-Object 'System.Collections.Generic.List[string]'
  if ($added.Count) { $lines.Add("  + appeared ($($added.Count)): " + (($added | Select-Object -First 12) -join '  |  ')) }
  if ($removed.Count) { $lines.Add("  - gone ($($removed.Count)): " + (($removed | Select-Object -First 12) -join '  |  ')) }
  if (-not $added.Count -and -not $removed.Count) {
    $lines.Add('  (no UIA tree change -- custom-drawn target or no effect; screenshot and verify the target state)')
  }
  return $lines.ToArray()
}

$script:captureReady = $false
function Initialize-Capture {
  if ($script:captureReady) { return }
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Globalization;

public static class NekoFrameDelta {
  static int[] previous;
  static int previousWidth, previousHeight, previousOriginX, previousOriginY;
  static int frame;

  public static string Analyze(Bitmap image, double scale, int originX, int originY) {
    frame++;
    int step=Math.Max(1,image.Width/96);
    int columns=(image.Width+step-1)/step, rows=(image.Height+step-1)/step;
    int[] current=new int[columns*rows];
    int index=0;
    for(int row=0;row<rows;row++) {
      int y=Math.Min(row*step,image.Height-1);
      for(int column=0;column<columns;column++) {
        int x=Math.Min(column*step,image.Width-1);
        current[index++]=image.GetPixel(x,y).ToArgb();
      }
    }
    string sample=columns+"x"+rows;
    bool baseline=previous==null || previous.Length!=current.Length || previousWidth!=image.Width ||
      previousHeight!=image.Height || previousOriginX!=originX || previousOriginY!=originY;
    if(baseline) {
      previous=current; previousWidth=image.Width; previousHeight=image.Height;
      previousOriginX=originX; previousOriginY=originY;
      return "frame="+frame+" delta=baseline sample="+sample;
    }
    int changed=0,minX=image.Width,minY=image.Height,maxX=-1,maxY=-1;
    index=0;
    for(int row=0;row<rows;row++) {
      int y=Math.Min(row*step,image.Height-1);
      for(int column=0;column<columns;column++) {
        int x=Math.Min(column*step,image.Width-1);
        Color before=Color.FromArgb(previous[index]);
        Color after=Color.FromArgb(current[index]);
        int distance=Math.Abs(before.R-after.R)+Math.Abs(before.G-after.G)+Math.Abs(before.B-after.B);
        if(distance>=48) { changed++; minX=Math.Min(minX,x); minY=Math.Min(minY,y); maxX=Math.Max(maxX,x); maxY=Math.Max(maxY,y); }
        index++;
      }
    }
    previous=current;
    double percent=100.0*changed/current.Length;
    string result="frame="+frame+" delta="+percent.ToString("0.00",CultureInfo.InvariantCulture)+"% sample="+sample;
    if(changed==0) return result;
    int left=originX+(int)Math.Floor(minX/scale), top=originY+(int)Math.Floor(minY/scale);
    int right=originX+(int)Math.Ceiling(Math.Min(image.Width,maxX+step)/scale);
    int bottom=originY+(int)Math.Ceiling(Math.Min(image.Height,maxY+step)/scale);
    return result+" changed="+left+","+top+","+(right-left)+","+(bottom-top);
  }
}
"@
  $script:captureReady = $true
}

function Invoke-Capture([string]$path, [int]$width = 768) {
  if (-not $path -or $path.Length -gt 4096) { throw 'invalid capture path' }
  if ($width -lt 160 -or $width -gt 2048) { throw 'capture width must be 160..2048' }
  Initialize-Capture
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'virtual desktop has invalid bounds' }
  $height = [Math]::Max(1, [int][Math]::Round($bounds.Height * $width / $bounds.Width))
  $scale = [double]$width / $bounds.Width
  $full = New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
  $small = New-Object System.Drawing.Bitmap $width,$height
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($full)
    try { $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$full.Size,[System.Drawing.CopyPixelOperation]::SourceCopy) }
    finally { $graphics.Dispose() }
    $graphics = [System.Drawing.Graphics]::FromImage($small)
    try { $graphics.DrawImage($full,0,0,$width,$height) }
    finally { $graphics.Dispose() }
    $delta = [NekoFrameDelta]::Analyze($small,$scale,$bounds.Left,$bounds.Top)
    $small.Save($path,[System.Drawing.Imaging.ImageFormat]::Gif)
    $roundedScale = [Math]::Round($scale,4).ToString([Globalization.CultureInfo]::InvariantCulture)
    return "saved $path  view=${width}x${height}  screen=$($bounds.Width)x$($bounds.Height)  origin=$($bounds.Left),$($bounds.Top)  scale=$roundedScale  capture=gdi  $delta"
  } finally {
    $full.Dispose(); $small.Dispose()
  }
}

# --- OCR (warm): read on-screen TEXT of Chromium/Electron windows UIA can't see. Loading the WinRT
# projections + the recognizer costs ~1s ONCE; every subsequent ocr is ~400ms (capture + recognize),
# matching/beating GPU screen-parsers - here CPU-only, no model, no download. ---
$script:ocrReady = $false
$script:ocrEngine = $null
$script:ocrAsTask = $null
# Set-of-Marks: the LAST ocr's numbered marks -> screen coords. `click {mark:N}` looks up N here, so
# a text-only model picks a NUMBER (the SOTA OmniParser affordance) instead of reproducing pixels -
# removing the coordinate-grounding step where weak models fail. Persisted in this warm host.
$script:ocrMarks = @{}
function Initialize-Ocr {
  if ($script:ocrReady) { return }
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:ocrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $script:ocrEngine) {
    $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
    if ($langs.Count -gt 0) { $script:ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langs[0]) }
  }
  $script:ocrReady = $true
}
function Await-Winrt($op, $type) {
  $m = $script:ocrAsTask.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result
}
function Invoke-Ocr($root) {
  Initialize-Ocr
  if (-not $script:ocrEngine) { throw 'no Windows OCR recognizer installed; add a language OCR pack in Settings > Language' }
  $hwnd = [IntPtr]$root.Current.NativeWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { throw 'target window has no native handle' }
  $rect = New-Object NekoResidentInputNative+RECT
  if (-not [NekoResidentInputNative]::GetWindowRect($hwnd, [ref]$rect)) { throw 'could not read window bounds' }
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { throw 'window has no visible area - run activate first' }
  $ms = New-Object System.IO.MemoryStream
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy) } finally { $g.Dispose() }
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose(); $ms.Position = 0
  try {
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $dec = Await-Winrt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await-Winrt ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await-Winrt ($script:ocrEngine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  } finally { $ms.Dispose() }
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.Add("OCR window='$($root.Current.Name)' origin=$($rect.Left),$($rect.Top) size=${w}x${h} engine=$($script:ocrEngine.RecognizerLanguage.LanguageTag)")
  $lines.Add("(each line has a mark [N]; act with: computer click mark=N - no coordinates needed)")
  $script:ocrMarks = @{}
  $n = 0
  foreach ($line in $res.Lines) {
    $words = $line.Words
    if ($words.Count -eq 0) { continue }
    $minX = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
    $minY = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
    $maxX = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
    $maxY = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
    $cx = [int]($rect.Left + ($minX + $maxX) / 2)
    $cy = [int]($rect.Top + ($minY + $maxY) / 2)
    $n++
    $script:ocrMarks[[string]$n] = @($cx, $cy)
    $lines.Add("  [$n] '$($line.Text)' @ $cx,$cy")
  }
  if ($n -eq 0) { $lines.Add('  (no text recognized - the window may be blank, an image, or mid-render)') }
  return $lines.ToArray()
}

function Invoke-UiaRequest($request) {
  $action = [string]$request.action
  Trace-Host "request action=$action"
  if ($action -eq 'ping') { return "resident-ui-ready pid=$PID apartment=$([Threading.Thread]::CurrentThread.ApartmentState)" }
  if ($action -eq 'wait') {
    $duration = if ($null -ne $request.durationMs) { [int]$request.durationMs } else { 500 }
    if ($duration -lt 0 -or $duration -gt 10000) { throw 'wait must be 0..10000 ms' }
    Start-Sleep -Milliseconds $duration
    return "waited $duration ms"
  }
  if ($action -eq 'screenshot') {
    $width = if ($request.width) { [int]$request.width } else { 768 }
    return Invoke-Capture ([string]$request.capturePath) $width
  }
  $inputActions = @('click', 'stroke', 'type', 'key', 'scroll')
  $root = if ($action -in $inputActions) { Get-InputTargetRoot ([string]$request.window) } else { Get-TargetRoot ([string]$request.window) }
  if (-not $root) { throw '(no target window)' }
  $name = [string]$request.name
  $value = [string]$request.value
  $text = [string]$request.text
  $backend = if ([string]$request.inputBackend -eq 'sendinput') { 'sendinput' } else { 'inject' }
  $max = if ($request.max) { [Math]::Min([Math]::Max([int]$request.max, 1), 500) } else { 120 }
  $auditName = switch ($action) {
    'click' { "$($request.x),$($request.y)" }
    'stroke' { "$(@($request.points).Count / 2) points" }
    'key' { [string]$request.keys }
    'scroll' { "$($request.direction) x$($request.amount)" }
    default { $name }
  }
  Write-ActionAudit $action $auditName $(if ($action -eq 'type') { $text } else { $value })

  switch ($action) {
    'list' {
      $lines = New-Object 'System.Collections.Generic.List[string]'
      $lines.Add('WINDOW: ' + $root.Current.Name)
      $keep = @('Button', 'Edit', 'Document', 'MenuItem', 'CheckBox', 'RadioButton', 'ComboBox', 'Hyperlink', 'TabItem', 'ListItem', 'Slider', 'SplitButton', 'Menu', 'Custom')
      $count = 0
      foreach ($element in (Get-AllControls $root)) {
        if ($count -ge $max) { break }
        $cached = $element.Cached
        $type = $cached.ControlType.ProgrammaticName -replace 'ControlType.', ''
        $label = $cached.Name
        if (-not $label -or $label.Length -gt 60) { continue }
        $rect = $cached.BoundingRectangle
        if ($rect.Width -le 0 -or [double]::IsInfinity($rect.X)) { continue }
        $verb = $null
        if ($element.GetCachedPropertyValue($A::IsValuePatternAvailableProperty)) { $verb = 'setvalue' }
        elseif ($element.GetCachedPropertyValue($A::IsTogglePatternAvailableProperty)) { $verb = 'toggle' }
        elseif ($element.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty) -or
                $element.GetCachedPropertyValue($A::IsSelectionItemPatternAvailableProperty) -or
                $element.GetCachedPropertyValue($A::IsExpandCollapsePatternAvailableProperty)) { $verb = 'invoke' }
        if (-not $verb -and $keep -notcontains $type) { continue }
        if (-not $verb) { $verb = 'invoke' }
        $x = [int]($rect.X + $rect.Width / 2)
        $y = [int]($rect.Y + $rect.Height / 2)
        $lines.Add("[$type] '$label' ($verb) -> $x,$y")
        $count++
      }
      $lines.Add("($count elements; act by name)")
      return $lines.ToArray()
    }
    'read' {
      return @(Get-ReadableSnapshot $root $max)
    }
    'ocr' {
      return Invoke-Ocr $root
    }
    'watch' {
      $duration = if ($null -ne $request.durationMs) { [int]$request.durationMs } else { 10000 }
      $settle = if ($null -ne $request.settleMs) { [int]$request.settleMs } else { 500 }
      if ($duration -lt 250 -or $duration -gt 30000) { throw 'watch duration must be 250..30000 ms' }
      if ($settle -lt 100 -or $settle -gt 2000 -or $settle -ge $duration) { throw 'watch settle must be 100..2000 ms and less than duration' }
      $clock = [Diagnostics.Stopwatch]::StartNew()
      $baseline = Get-ReadableState $root $max
      $last = $baseline
      [long]$changedAt = -1
      while ($clock.ElapsedMilliseconds -lt $duration) {
        $remaining = $duration - $clock.ElapsedMilliseconds
        Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min(150, $remaining)))
        $current = Get-ReadableState $root $max
        if ($current.Text -cne $last.Text) {
          $last = $current
          $changedAt = if ($current.Text -cne $baseline.Text) { $clock.ElapsedMilliseconds } else { -1 }
          continue
        }
        if ($changedAt -ge 0 -and ($clock.ElapsedMilliseconds - $changedAt) -ge $settle) {
          $elapsed = $clock.ElapsedMilliseconds
          Write-ObservationAudit 'changed' $root.Current.Name $elapsed $changedAt $last.Id
          $lines = New-Object 'System.Collections.Generic.List[string]'
          $lines.Add("WATCH changed elapsed_ms=$elapsed detected_ms=$changedAt state=$($last.Id)")
          foreach ($line in $last.Lines) { $lines.Add([string]$line) }
          return $lines.ToArray()
        }
      }
      $status = if ($last.Text -cne $baseline.Text) { 'changed_unsettled' } else { 'timeout' }
      $elapsed = $clock.ElapsedMilliseconds
      Write-ObservationAudit $status $root.Current.Name $elapsed $changedAt $last.Id
      $lines = New-Object 'System.Collections.Generic.List[string]'
      $lines.Add("WATCH $status elapsed_ms=$elapsed detected_ms=$changedAt state=$($last.Id)")
      foreach ($line in $last.Lines) { $lines.Add([string]$line) }
      return $lines.ToArray()
    }
    'get' {
      if (-not $name) { throw "computer get needs 'name'" }
      $element = Find-ByName $root $name
      if (-not $element) { throw "not found: $name" }
      $vp = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { return "value '$name' = '$($vp.Current.Value)'" }
      $tp = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($tp) { return "toggle '$name' = $($tp.Current.ToggleState)" }
      return "name '$name' present (no value/toggle pattern)"
    }
    'setvalue' {
      if (-not $name) { throw "computer setvalue needs 'name'" }
      $element = Find-ByName $root $name
      if (-not $element) { throw "not found: $name" }
      $vp = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $vp) { throw "no ValuePattern on: $name; this may be contenteditable - use computer type with the freshly observed element name" }
      if ($vp.Current.IsReadOnly) { throw "setvalue: '$name' is READ-ONLY" }
      $vp.SetValue($value)
      Start-Sleep -Milliseconds 40
      $actual = $vp.Current.Value
      if ($actual -cne $value) { throw "setvalue MISMATCH on '$name': requested '$value' but field now reads '$actual'" }
      return "set+VERIFIED '$name' = '$value'"
    }
    'toggle' {
      if (-not $name) { throw "computer toggle needs 'name'" }
      $element = Find-ByName $root $name
      if (-not $element) { throw "not found: $name" }
      $tp = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
      if (-not $tp) { throw "no TogglePattern on: $name" }
      $before = $tp.Current.ToggleState
      $tp.Toggle()
      Start-Sleep -Milliseconds 40
      $after = $tp.Current.ToggleState
      if ($after -eq $before) { throw "toggle: '$name' state did NOT change (still $after)" }
      return "toggled+VERIFIED '$name': $before -> $after"
    }
    'invoke' {
      if (-not $name) { throw "computer invoke needs 'name'" }
      $element = Find-ByName $root $name
      if (-not $element) { throw "not found: $name" }
      $beforeTree = Get-TreeSignature $root
      $beforeWindows = Get-WindowSignature
      $did = $null
      $ip = Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
      if ($ip) { $ip.Invoke(); $did = 'invoked' }
      if (-not $did) {
        $sp = Get-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($sp) { $sp.Select(); $did = 'selected' }
      }
      if (-not $did) {
        $tp = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($tp) { $tp.Toggle(); $did = 'toggled' }
      }
      if (-not $did) {
        $rect = $element.Current.BoundingRectangle
        $x = [int]($rect.X + $rect.Width / 2)
        $y = [int]($rect.Y + $rect.Height / 2)
        [void][NekoResidentFg]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 60
        [NekoResidentFg]::mouse_event(0x0002, 0, 0, 0, 0)
        [NekoResidentFg]::mouse_event(0x0004, 0, 0, 0, 0)
        $did = "clicked @ $x,$y"
      }
      Start-Sleep -Milliseconds 140
      $afterTree = Get-TreeSignature $root
      $afterWindows = Get-WindowSignature
      $added = @($afterTree | Where-Object { -not $beforeTree.Contains($_) })
      $removed = @($beforeTree | Where-Object { -not $afterTree.Contains($_) })
      $newWindows = @($afterWindows | Where-Object { -not $beforeWindows.Contains($_) })
      $lines = New-Object 'System.Collections.Generic.List[string]'
      $lines.Add("${did}: $name")
      if ($newWindows.Count) { $lines.Add('  + NEW WINDOW: ' + ($newWindows -join '; ')) }
      if ($added.Count) { $lines.Add("  + appeared ($($added.Count)): " + (($added | Select-Object -First 14) -join '  |  ')) }
      if ($removed.Count) { $lines.Add("  - gone ($($removed.Count)): " + (($removed | Select-Object -First 14) -join '  |  ')) }
      if (-not $newWindows.Count -and -not $added.Count -and -not $removed.Count) {
        $lines.Add('  (no tree change detected -- action may have had NO effect; re-read the foreground)')
      }
      return $lines.ToArray()
    }
    'type' {
      Assert-AgentPresence $request 'type'
      [void](Focus-InputTarget $root $name)
      [NekoResidentInputNative]::Text($text)
      return "typed $($text.Length) chars; re-perceive to verify"
    }
    'key' {
      Assert-AgentPresence $request 'key'
      [void](Focus-InputTarget $root $name)
      $sent = Send-KeyChord ([string]$request.keys)
      return "sent key $sent; re-perceive to verify"
    }
    'click' {
      # Set-of-Marks: `mark` (an [N] from the last ocr) resolves to that element's coords - the model
      # never emits pixels. Falls back to explicit x,y when no mark is given.
      if ($null -ne $request.mark) {
        $key = [string][int]$request.mark
        if (-not $script:ocrMarks.ContainsKey($key)) { throw "no OCR mark [$key]; run computer ocr first, then click the mark you see" }
        $coord = $script:ocrMarks[$key]; $x = [int]$coord[0]; $y = [int]$coord[1]
      } else {
        $x = [int]$request.x; $y = [int]$request.y
      }
      Assert-AgentPresence $request 'click' $x $y
      if ($request.window) { [void](Focus-InputTarget $root) }
      $before = Get-TreeSignature $root
      if ($backend -eq 'sendinput') {
        [NekoResidentInputNative]::MoveMouse($x, $y)
        Start-Sleep -Milliseconds 70
        [NekoResidentInputNative]::MouseDown(); [NekoResidentInputNative]::MouseUp()
        $lines = New-Object 'System.Collections.Generic.List[string]'
        $lines.Add("clicked $x,$y (SendInput; system cursor moved)")
      } else {
        Send-TouchTap $x $y
        $lines = New-Object 'System.Collections.Generic.List[string]'
        $lines.Add("tapped $x,$y (touch; mouse not moved)")
      }
      foreach ($line in (Get-TreeChangeReport $root $before)) { $lines.Add($line) }
      return $lines.ToArray()
    }
    'stroke' {
      $points = @($request.points | ForEach-Object { [int]$_ })
      Assert-AgentPresence $request 'stroke' $points[0] $points[1]
      if ($request.window) { [void](Focus-InputTarget $root) }
      Send-Points $points $backend
      if ($backend -eq 'sendinput') { return 'stroke done (SendInput; system cursor moved); re-perceive to verify' }
      return 'stroke done (touch; mouse not moved); re-perceive to verify'
    }
    'scroll' {
      $direction = [string]$request.direction
      $amount = if ($request.amount) { [int]$request.amount } else { 1 }
      Assert-AgentPresence $request 'scroll'
      $handle = Focus-InputTarget $root
      $rect = New-Object NekoResidentInputNative+RECT
      if (-not [NekoResidentInputNative]::GetWindowRect($handle, [ref]$rect)) { throw 'could not read target window bounds' }
      $cx = [int](($rect.Left + $rect.Right) / 2); $cy = [int](($rect.Top + $rect.Bottom) / 2)
      $dx = [Math]::Max(80, [int](($rect.Right - $rect.Left) * 0.28)); $dy = [Math]::Max(80, [int](($rect.Bottom - $rect.Top) * 0.28))
      switch ($direction) {
        'down'  { $points = @($cx, $cy + $dy, $cx, $cy - $dy) }
        'up'    { $points = @($cx, $cy - $dy, $cx, $cy + $dy) }
        'right' { $points = @($cx + $dx, $cy, $cx - $dx, $cy) }
        'left'  { $points = @($cx - $dx, $cy, $cx + $dx, $cy) }
        default { throw 'scroll direction must be up, down, left, or right' }
      }
      for ($i = 0; $i -lt $amount; $i++) { Send-Points $points 'inject'; Start-Sleep -Milliseconds 80 }
      return "scrolled $direction x$amount (touch; mouse not moved); re-perceive to verify"
    }
    default { throw "unsupported resident UIA action: $action" }
  }
}

function Send-Response($response) {
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $id = 0
  try {
    if ($line.Length -gt 100000) { throw 'request too large' }
    $request = $line | ConvertFrom-Json
    $id = [int]$request.id
    $output = @(Invoke-UiaRequest $request) -join "`n"
    Send-Response @{ id = $id; ok = $true; output = $output; pid = $PID }
  } catch {
    Send-Response @{ id = $id; ok = $false; error = $_.Exception.Message; pid = $PID }
  }
}
