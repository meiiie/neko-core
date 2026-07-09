# Keyboard, scroll, wait, and launch primitives for Windows computer-use.
# Unicode text uses SendInput/KEYEVENTF_UNICODE. Scroll delegates to touch injection, so the real mouse stays put.
# Usage: input.ps1 type @utf8file 1 @namefile | key @utf8file 1 @namefile | scroll down 2 | wait '' 500 | open @utf8file
param([string]$cmd="wait", [string]$arg="", [int]$amount=1, [string]$name="")

function Read-AtFile([string]$value) {
  if($value -like '@*' -and (Test-Path -LiteralPath $value.Substring(1))){
    return Get-Content -LiteralPath $value.Substring(1) -Raw -Encoding UTF8
  }
  return $value
}
$arg=Read-AtFile $arg
$name=Read-AtFile $name

# Respect the same intervention channel as pointer actions. Never keep typing after the user takes over.
if($env:NEKO_PRESENCE){
  $stop="$env:TEMP\neko_overlay.stop"; $run="$env:TEMP\neko_overlay.run"
  if((Test-Path $stop) -and ((Get-Content $stop -TotalCount 1 -ErrorAction SilentlyContinue) -match 'user')){
    Write-Output "PAUSED: the user took control. STOP acting, wait, then re-perceive before resuming."
    exit
  }
  if(-not (Test-Path $run) -or (((Get-Date)-(Get-Item $run).LastWriteTime).TotalSeconds -gt 3)){
    Remove-Item $stop -ErrorAction SilentlyContinue
    Start-Process powershell -ArgumentList '-NoProfile','-File',(Join-Path $PSScriptRoot 'overlay.ps1') -WindowStyle Hidden
  }
  if($env:NEKO_DRAW_WINDOW){ $env:NEKO_DRAW_WINDOW | Out-File "$env:TEMP\neko_active_window.txt" -Encoding utf8 }
}

function Write-Audit([string]$detail) {
  try {
    $log=if($env:NEKO_ACTION_LOG){$env:NEKO_ACTION_LOG}else{"$env:TEMP\neko_actions.log"}
    ("{0}  input {1}" -f (Get-Date -Format 'HH:mm:ss'),$detail) | Out-File $log -Append -Encoding utf8
  } catch {}
}

# These actions need neither UI Automation nor SendInput; skip C# compilation and return quickly.
if($cmd -eq "wait"){
  if($amount -lt 0 -or $amount -gt 10000){ Write-Output "Error: wait must be 0..10000 ms."; exit 1 }
  Start-Sleep -Milliseconds $amount
  Write-Output ("waited " + $amount + " ms")
  exit
}
if($cmd -eq "open"){
  Write-Audit "open target"
  Start-Process -FilePath $arg -ErrorAction Stop
  Write-Output "opened target; wait, then re-perceive to verify"
  exit
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NekoInputNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL, wParamH;
  }
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

  const uint INPUT_KEYBOARD=1, KEYUP=0x0002, UNICODE=0x0004, EXTENDED=0x0001;
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i=new INPUT(); i.type=INPUT_KEYBOARD; i.U.ki.wVk=vk; i.U.ki.wScan=scan; i.U.ki.dwFlags=flags; return i;
  }
  static void Send(List<INPUT> items) {
    INPUT[] input=items.ToArray();
    uint sent=SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)));
    if(sent != input.Length) throw new InvalidOperationException("SendInput failed (possibly blocked by an elevated target), error " + Marshal.GetLastWin32Error());
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
      if(foregroundThread != 0 && foregroundThread != currentThread)
        attachedForeground=AttachThreadInput(currentThread,foregroundThread,true);
      if(targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread)
        attachedTarget=AttachThreadInput(currentThread,targetThread,true);
      ShowWindow(hwnd,9); BringWindowToTop(hwnd); SetForegroundWindow(hwnd); SetActiveWindow(hwnd);
    } finally {
      if(attachedTarget) AttachThreadInput(currentThread,targetThread,false);
      if(attachedForeground) AttachThreadInput(currentThread,foregroundThread,false);
    }
    return GetAncestor(GetForegroundWindow(),2) == GetAncestor(hwnd,2);
  }
}
"@

function Focus-Target([string]$elementName="") {
  if($env:NEKO_DRAW_WINDOW){
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $A=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
    $matches=@($A::RootElement.FindAll($TS::Children,[System.Windows.Automation.Condition]::TrueCondition) |
      Where-Object { $_.Current.Name -like "*$($env:NEKO_DRAW_WINDOW)*" })
    if(-not $matches.Count){ Write-Output "Error: target window not found."; exit 1 }
    $exact=@($matches | Where-Object { $_.Current.Name -eq $env:NEKO_DRAW_WINDOW })
    if($exact.Count -eq 1){ $target=$exact[0] }
    elseif($matches.Count -eq 1){ $target=$matches[0] }
    else { Write-Output "Error: target title matches multiple windows; use a more specific title."; exit 1 }
    $handle=[IntPtr]$target.Current.NativeWindowHandle
    $focusElement=$null
    if($elementName){
      $condition=New-Object System.Windows.Automation.PropertyCondition($A::NameProperty,$elementName)
      $focusElement=$target.FindFirst($TS::Descendants,$condition)
      if(-not $focusElement){ Write-Output "Error: requested focus element not found."; exit 1 }
    }
    for($attempt=0;$attempt -lt 4;$attempt++){
      [void][NekoInputNative]::ShowWindow($handle,9)
      try { [void](New-Object -ComObject WScript.Shell).AppActivate($target.Current.Name) } catch {}
      [void][NekoInputNative]::FocusWindow($handle)
      Start-Sleep -Milliseconds 140
      $foreground=[NekoInputNative]::GetForegroundWindow()
      if([NekoInputNative]::GetAncestor($foreground,2) -eq [NekoInputNative]::GetAncestor($handle,2)){
        if(-not $focusElement){ return $handle }
        try { $focusElement.SetFocus() } catch {}
        Start-Sleep -Milliseconds 60
        if($focusElement.Current.HasKeyboardFocus){ return $handle }
      }
    }
    Write-Output "Error: target window could not be focused; refusing to send input to another app."
    exit 1
  }
  $foreground=[NekoInputNative]::GetForegroundWindow()
  if($foreground -eq [IntPtr]::Zero){ Write-Output "Error: no foreground window."; exit 1 }
  return $foreground
}

switch($cmd){
  "type" {
    [void](Focus-Target $name)
    Write-Audit ("type " + $arg.Length + " chars")
    [NekoInputNative]::Text($arg)
    Write-Output ("typed " + $arg.Length + " chars; re-perceive to verify")
  }
  "key" {
    [void](Focus-Target $name)
    $parts=@($arg.ToUpperInvariant() -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if(-not $parts.Count){ Write-Output "Error: empty key chord."; exit 1 }
    $modifierMap=@{ CTRL=0x11; CONTROL=0x11; ALT=0x12; SHIFT=0x10; WIN=0x5B; META=0x5B; CMD=0x5B }
    $keyMap=@{
      ENTER=0x0D; RETURN=0x0D; TAB=0x09; ESC=0x1B; ESCAPE=0x1B; SPACE=0x20;
      BACKSPACE=0x08; DELETE=0x2E; DEL=0x2E; INSERT=0x2D; INS=0x2D;
      HOME=0x24; END=0x23; PAGEUP=0x21; PGUP=0x21; PAGEDOWN=0x22; PGDN=0x22;
      LEFT=0x25; UP=0x26; RIGHT=0x27; DOWN=0x28;
      PLUS=0xBB; MINUS=0xBD; COMMA=0xBC; PERIOD=0xBE; SLASH=0xBF; BACKSLASH=0xDC;
      SEMICOLON=0xBA; QUOTE=0xDE; LBRACKET=0xDB; RBRACKET=0xDD; BACKTICK=0xC0
    }
    $mods=New-Object 'System.Collections.Generic.List[UInt16]'
    for($i=0;$i -lt $parts.Count-1;$i++){
      if(-not $modifierMap.ContainsKey($parts[$i])){ Write-Output ("Error: unsupported modifier '"+$parts[$i]+"'."); exit 1 }
      $vk=[UInt16]$modifierMap[$parts[$i]]; if(-not $mods.Contains($vk)){ $mods.Add($vk) }
    }
    $main=$parts[-1]; $vkMain=0
    if($keyMap.ContainsKey($main)){ $vkMain=$keyMap[$main] }
    elseif($main -match '^F([1-9]|1[0-9]|2[0-4])$'){ $vkMain=0x6F+[int]$Matches[1] }
    elseif($main -match '^[A-Z0-9]$'){ $vkMain=[int][char]$main }
    else { Write-Output ("Error: unsupported key '"+$main+"'. Use a named key or one letter/digit."); exit 1 }
    $extended=$main -in @('DELETE','DEL','INSERT','INS','HOME','END','PAGEUP','PGUP','PAGEDOWN','PGDN','LEFT','UP','RIGHT','DOWN')
    Write-Audit ("key " + ($parts -join '+'))
    [NekoInputNative]::Chord([UInt16[]]$mods.ToArray(),[UInt16]$vkMain,$extended)
    Write-Output ("sent key " + ($parts -join '+') + "; re-perceive to verify")
  }
  "scroll" {
    $handle=Focus-Target
    $rect=New-Object NekoInputNative+RECT
    if(-not [NekoInputNative]::GetWindowRect($handle,[ref]$rect)){ Write-Output "Error: could not read target window bounds."; exit 1 }
    $cx=[int](($rect.Left+$rect.Right)/2); $cy=[int](($rect.Top+$rect.Bottom)/2)
    $dx=[Math]::Max(80,[int](($rect.Right-$rect.Left)*0.28)); $dy=[Math]::Max(80,[int](($rect.Bottom-$rect.Top)*0.28))
    switch($arg){
      'down'  { $x1=$cx; $y1=$cy+$dy; $x2=$cx; $y2=$cy-$dy }
      'up'    { $x1=$cx; $y1=$cy-$dy; $x2=$cx; $y2=$cy+$dy }
      'right' { $x1=$cx+$dx; $y1=$cy; $x2=$cx-$dx; $y2=$cy }
      'left'  { $x1=$cx-$dx; $y1=$cy; $x2=$cx+$dx; $y2=$cy }
      default { Write-Output "Error: scroll direction must be up, down, left, or right."; exit 1 }
    }
    Write-Audit ("scroll " + $arg + " x" + $amount)
    for($i=0;$i -lt $amount;$i++){
      $result=& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'inject.ps1') stroke $x1 $y1 $x2 $y2 2>&1
      if($LASTEXITCODE -ne 0){ $result | Write-Output; exit $LASTEXITCODE }
      Start-Sleep -Milliseconds 80
    }
    Write-Output ("scrolled " + $arg + " x" + $amount + "; re-perceive to verify")
  }
  default { Write-Output "usage: type @file | key @file | scroll <up|down|left|right> [amount] | wait '' <ms> | open @file"; exit 1 }
}
