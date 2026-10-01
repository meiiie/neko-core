import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, NekoConfig } from "../src/adapters/config.ts";
import { trustProject } from "../src/adapters/project-trust.ts";
import { configureToolRegistry, inheritToolRegistrySettings } from "../src/adapters/tool-registry.ts";
import { COMPUTER_INPUT_POLICY_CAPABILITY, ComputerInputPolicyCapabilityError, computerNeedsInteraction } from "../src/core/computer-input-policy.ts";
import type { ComputerToolPort } from "../src/core/ports.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { ResidentUiaHost, residentUiaHost, type UiaRequest } from "../src/core/windows-uia-host.ts";
import { resolveWindowsSystemExecutable } from "../src/shared/windows-system.ts";

const physicalActions = ["activate", "type", "key", "click", "stroke", "scroll", "ocr", "open"];
const semanticActions = ["list", "read", "get", "watch", "invoke", "setvalue", "toggle"];
const nativeScripts = join(import.meta.dir, "..", "skills", "computer-use", "scripts");
const powershell = process.platform === "win32"
  ? resolveWindowsSystemExecutable(join("WindowsPowerShell", "v1.0", "powershell.exe"))
  : null;

test.skipIf(process.platform === "win32")("unsupported local computer reports platform limits before input policy or executable edges", async () => {
  for (const policy of ["background", "foreground"] as const) {
    const tools = new ToolRegistry(process.cwd(), "default", () => { throw new Error("unexpected approval"); });
    tools.computerInputPolicy = policy;
    tools.loadSkill = () => { throw new Error("unexpected native support load"); };
    tools.checkAction = async () => { throw new Error("unexpected action review"); };
    Object.defineProperty(tools, "hooks", { get: () => { throw new Error("unexpected hooks"); } });
    for (const action of [...physicalActions, ...semanticActions, "screenshot"]) {
      const result = String(await tools.execute("computer", { action }));
      expect(result).toContain("Windows-only");
      expect(result).not.toContain("needs_interaction");
    }
  }
});

test("only an explicit foreground config opts into physical desktop input", () => {
  expect(new NekoConfig({}, null, {}, "").computerUseInputPolicy).toBe("background");
  for (const value of [null, false, "auto", "sendinput", "inject", "invalid"]) {
    expect(() => new NekoConfig({ computer_use_input_policy: value }, null, {}, "").computerUseInputPolicy)
      .toThrow("must be background or foreground");
  }
  for (const value of ["foreground", " FOREGROUND "]) {
    expect(new NekoConfig({ computer_use_input_policy: value }, null, {}, "").computerUseInputPolicy)
      .toBe("foreground");
  }
  expect(new NekoConfig({ computer_use_input: "sendinput" }, null, {}, "").computerUseInputPolicy).toBe("background");
  for (const action of physicalActions) {
    expect(computerNeedsInteraction(action, "background")).toContain("needs_interaction:");
    expect(computerNeedsInteraction(action, "foreground")).toBeUndefined();
  }
  for (const action of [...semanticActions, "screenshot", "display", "wait"]) {
    expect(computerNeedsInteraction(action, "background")).toBeUndefined();
  }
});

test("config composition and child inheritance preserve input policy independently of yolo", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-input-policy-compose-"));
  try {
    for (const policy of ["background", "foreground"] as const) {
      const config = new NekoConfig({ computer_use_input_policy: policy }, null, {}, "", null, [],
        { state: "none", files: [] }, join(root, policy));
      const parent = configureToolRegistry(new ToolRegistry(root, "auto", () => false), config);
      parent.explicitYolo = true;
      const child = inheritToolRegistrySettings(new ToolRegistry(root, "auto", () => false), parent);
      expect(parent.computerInputPolicy).toBe(policy);
      expect(child.computerInputPolicy).toBe(policy);
      expect(child.isExplicitYolo()).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted project config and its selected profile cannot opt into foreground input", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-input-policy-trust-"));
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(join(home, ".neko-core"), { recursive: true });
  const previousPolicy = process.env.NEKO_COMPUTER_USE_INPUT_POLICY;
  delete process.env.NEKO_COMPUTER_USE_INPUT_POLICY;
  try {
    writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({
      profiles: { "input-test": { model: "unused" } },
    }), "utf8");
    writeFileSync(join(root, "neko.json"), JSON.stringify({ model: "declarative-only" }), "utf8");
    expect(trustProject(root, home).state).toBe("trusted");
    for (const project of [
      { computer_use_input_policy: "foreground" },
      { profiles: { "input-test": { computer_use_input_policy: "foreground" } } },
    ]) {
      writeFileSync(join(root, "neko.json"), JSON.stringify(project), "utf8");
      expect(() => trustProject(root, home)).toThrow("configure them globally");
      const config = loadConfig({ cwd: root, home, profile: "input-test" });
      expect(config.projectTrust.state).toBe("error");
      expect(config.computerUseInputPolicy).toBe("background");
    }
    writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({
      computer_use_input_policy: "foreground", profiles: { "input-test": { model: "unused" } },
    }), "utf8");
    expect(loadConfig({ cwd: root, home, profile: "input-test" }).computerUseInputPolicy).toBe("foreground");
    process.env.NEKO_COMPUTER_USE_INPUT_POLICY = "background";
    expect(loadConfig({ cwd: root, home, profile: "input-test" }).computerUseInputPolicy).toBe("background");
  } finally {
    if (previousPolicy === undefined) delete process.env.NEKO_COMPUTER_USE_INPUT_POLICY;
    else process.env.NEKO_COMPUTER_USE_INPUT_POLICY = previousPolicy;
    rmSync(base, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("background prompt, auto and yolo refuse physical actions before any executable edge", async () => {
  for (const mode of ["default", "auto"] as const) {
    const tools = new ToolRegistry(process.cwd(), mode, () => { throw new Error("unexpected approval"); });
    tools.loadSkill = () => { throw new Error("native support loaded before input refusal"); };
    tools.checkAction = async () => { throw new Error("adversarial checker ran before input refusal"); };
    Object.defineProperty(tools, "hooks", { get: () => { throw new Error("hooks read before input refusal"); } });
    expect(tools.computerInputPolicy).toBe("background");
    for (const yolo of [false, true]) {
      tools.explicitYolo = yolo;
      for (const action of physicalActions) {
        const result = await tools.execute("computer", {
          action, name: "field", text: "text", keys: "ENTER", x: 10, y: 10,
          points: [1, 1, 2, 2], direction: "down", target: "never-open",
          inputPolicy: "foreground", computer_use_input_policy: "foreground",
        });
        expect(String(result)).toContain("needs_interaction:");
      }
    }
  }
});

test("background policy preserves injected host contracts without invoking local desktop support", async () => {
  const tools = new ToolRegistry(process.cwd(), "auto", () => false);
  tools.loadSkill = () => { throw new Error("local support must not replace a host backend"); };
  let handlerCalls = 0;
  tools.computerHandler = () => { handlerCalls++; return "injected action"; };
  expect(await tools.execute("computer", { action: "click", x: 1, y: 2 })).toBe("injected action");
  expect(handlerCalls).toBe(1);
  let hostCalls = 0;
  const port: ComputerToolPort = {
    schema: () => ({ type: "function", function: { name: "computer", description: "fake host",
      parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } } }),
    permission: () => "gated",
    call: async () => { hostCalls++; return "host semantic action"; },
  };
  tools.computerPort = port;
  expect(await tools.execute("computer", { action: "click", x: 1, y: 2 })).toBe("host semantic action");
  expect(hostCalls).toBe(1);
  expect(handlerCalls).toBe(1);
});

test.skipIf(process.platform !== "win32")("semantic resident requests carry policy without starting a native process", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-input-policy-resident-"));
  const host = residentUiaHost(join(root, "scripts", "resident-uia.ps1"));
  const originalRequest = host.request;
  const seen: UiaRequest[] = [];
  host.request = async (request) => { seen.push(request); return { id: seen.length, ok: true, output: "fake semantic result" }; };
  try {
    const tools = new ToolRegistry(root, "auto", () => false);
    tools.loadSkill = () => ({ body: "", dir: root });
    for (const policy of ["background", "foreground"] as const) {
      tools.computerInputPolicy = policy;
      for (const action of semanticActions) {
        expect(await tools.execute("computer", { action, name: "field", value: "value" })).toBe("fake semantic result");
        expect(seen.at(-1)?.inputPolicy).toBe(policy);
        expect(seen.at(-1)?.action).toBe(action);
      }
    }
  } finally {
    host.request = originalRequest;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("one-shot and resident-error fallback transfer policy to a harmless script fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-input-policy-oneshot-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "uia.ps1"), [
    "# neko-computer-input-policy-v1",
    "param([string]$action, [string]$name)",
    'Write-Output ("fixture policy=" + $env:NEKO_COMPUTER_INPUT_POLICY + " action=" + $action)',
  ].join("\n"), "utf8");
  const host = residentUiaHost(join(scripts, "resident-uia.ps1"));
  const originalRequest = host.request;
  host.request = async () => { throw new Error("test-only resident unavailable"); };
  const previousInternalPolicy = process.env.NEKO_COMPUTER_INPUT_POLICY;
  process.env.NEKO_COMPUTER_INPUT_POLICY = "foreground";
  try {
    const tools = new ToolRegistry(root, "auto", () => false);
    tools.loadSkill = () => ({ body: "", dir: root });
    for (const resident of [false, true]) {
      tools.residentUia = resident;
      for (const policy of ["background", "foreground"] as const) {
        tools.computerInputPolicy = policy;
        expect(await tools.execute("computer", { action: "invoke", name: "fake control" }))
          .toBe(`fixture policy=${policy} action=invoke`);
      }
    }
  } finally {
    if (previousInternalPolicy === undefined) delete process.env.NEKO_COMPUTER_INPUT_POLICY;
    else process.env.NEKO_COMPUTER_INPUT_POLICY = previousInternalPolicy;
    host.request = originalRequest;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform !== "win32")("background refuses a one-shot helper without the policy contract before executing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-input-policy-legacy-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "uia.ps1"), [
    "param([string]$action, [string]$name)",
    '[IO.File]::WriteAllText((Join-Path $PSScriptRoot "executed.txt"),"legacy helper ran")',
    'Write-Output "legacy helper executed"',
  ].join("\n"), "utf8");
  try {
    const tools = new ToolRegistry(root, "auto", () => false);
    tools.loadSkill = () => ({ body: "", dir: root });
    tools.residentUia = false;
    expect(String(await tools.execute("computer", { action: "invoke", name: "control" })))
      .toContain("unsupported_helper:");
    expect(existsSync(join(scripts, "executed.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("resident policy-contract rejection never falls back to another native helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-input-policy-capability-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "uia.ps1"), [
    "# neko-computer-input-policy-v1",
    "param([string]$action, [string]$name)",
    '[IO.File]::WriteAllText((Join-Path $PSScriptRoot "executed.txt"),"one-shot fallback ran")',
    'Write-Output "fallback helper executed"',
  ].join("\n"), "utf8");
  const host = residentUiaHost(join(scripts, "resident-uia.ps1"));
  const originalRequest = host.request;
  host.request = async () => { throw new ComputerInputPolicyCapabilityError("test-only policy contract absent"); };
  try {
    const tools = new ToolRegistry(root, "auto", () => false);
    tools.loadSkill = () => ({ body: "", dir: root });
    expect(String(await tools.execute("computer", { action: "invoke", name: "control" })))
      .toContain("unsupported_helper:");
    expect(existsSync(join(scripts, "executed.txt"))).toBe(false);
  } finally {
    host.request = originalRequest;
    rmSync(root, { recursive: true, force: true });
  }
});

type FakeResidentChild = { killed: boolean; exitCode: null; identity: number };

test("resident background handshake runs before action, caches one child and reprobes its replacement", async () => {
  const host = new ResidentUiaHost("never-executed-by-fake");
  let child = { killed: false, exitCode: null, identity: 1 };
  const requests: { action: string; policy: string | undefined; identity: number }[] = [];
  // Test-owned objects replace both process/I/O edges. No actual child or stdin is created.
  Object.defineProperty(host, "child", { get: () => child });
  Object.defineProperty(host, "ensureChild", { value: () => child });
  Object.defineProperty(host, "requestNow", {
    value: async (request: UiaRequest, _timeout: number, _signal?: AbortSignal, pinnedChild?: FakeResidentChild) => {
      expect(pinnedChild).toBe(child);
      requests.push({ action: request.action, policy: request.inputPolicy, identity: child.identity });
      return { id: requests.length, ok: true, output: request.action === "ping" ? COMPUTER_INPUT_POLICY_CAPABILITY : "fake action" };
    },
  });
  expect((await host.request({ action: "invoke", name: "control" })).output).toBe("fake action");
  expect(requests.map((request) => request.action)).toEqual(["ping", "invoke"]);
  expect(requests.every((request) => request.policy === "background")).toBe(true);
  await host.request({ action: "read", inputPolicy: "background" });
  expect(requests.map((request) => request.action)).toEqual(["ping", "invoke", "read"]);
  child = { killed: false, exitCode: null, identity: 2 };
  await host.request({ action: "get", name: "control", inputPolicy: "background" });
  expect(requests.map((request) => request.action)).toEqual(["ping", "invoke", "read", "ping", "get"]);
  expect(requests.slice(-2).map((request) => request.identity)).toEqual([2, 2]);
});

test("resident rejects unsupported or replaced background helper before semantic dispatch", async () => {
  for (const failure of ["unsupported", "replacement"] as const) {
    const host = new ResidentUiaHost("never-executed-by-fake");
    let child = { killed: false, exitCode: null };
    const requests: string[] = [];
    Object.defineProperty(host, "child", { get: () => child });
    Object.defineProperty(host, "ensureChild", { value: () => child });
    Object.defineProperty(host, "requestNow", {
      value: async (request: UiaRequest) => {
        requests.push(request.action);
        if (failure === "replacement") child = { killed: false, exitCode: null };
        return { id: requests.length, ok: true,
          output: failure === "unsupported" ? "legacy resident ready" : COMPUTER_INPUT_POLICY_CAPABILITY };
      },
    });
    await expect(host.request({ action: "invoke", name: "control", inputPolicy: "background" }))
      .rejects.toBeInstanceOf(ComputerInputPolicyCapabilityError);
    expect(requests).toEqual(["ping"]);
  }
});

test("resident physical background refusal precedes process startup while foreground remains explicit", async () => {
  const host = new ResidentUiaHost("never-executed-by-fake");
  let starts = 0;
  const requests: string[] = [];
  Object.defineProperty(host, "ensureChild", { value: () => { starts++; throw new Error("unexpected process startup"); } });
  Object.defineProperty(host, "requestNow", {
    value: async (request: UiaRequest) => { requests.push(request.action); return { id: 1, ok: true }; },
  });
  for (const action of physicalActions) {
    await expect(host.request({ action, inputPolicy: "background" })).rejects.toThrow("needs_interaction:");
  }
  expect(starts).toBe(0);
  expect(requests).toEqual([]);
  expect((await host.request({ action: "type", inputPolicy: "foreground" })).ok).toBe(true);
  expect(requests).toEqual(["type"]);
});

// Parse the product scripts without executing their initialization. The extracted functions/clauses
// run against test-only types: no UIA assembly, user32 import, capture, input, or real app exists here.
const nativeFakeScope = String.raw`
$ErrorActionPreference = 'Stop'
function Assert-Test($condition, [string]$message) { if(-not $condition){ throw $message } }
Add-Type @'
using System;
namespace System.Windows.Automation {
  public class InvokePattern { public static string Pattern = "invoke"; }
  public class SelectionItemPattern { public static string Pattern = "selection"; }
  public class TogglePattern { public static string Pattern = "toggle"; }
  public class ExpandCollapsePattern { public static string Pattern = "expand"; }
  public enum ExpandCollapseState { Collapsed, Expanded, PartiallyExpanded, LeafNode }
}
public class FakePatternState {
  public System.Windows.Automation.ExpandCollapseState ExpandCollapseState = System.Windows.Automation.ExpandCollapseState.Collapsed;
}
public class FakePattern {
  public static int Calls;
  public FakePatternState Current = new FakePatternState();
  public void Invoke(){ Calls++; } public void Select(){ Calls++; } public void Toggle(){ Calls++; }
  public void Expand(){ Calls++; } public void Collapse(){ Calls++; }
}
public class FG {
  public static int Calls;
  public static bool SetCursorPos(int x,int y){ Calls++; Console.WriteLine("FAKE_MOUSE_CALLED"); return true; }
  public static void mouse_event(uint flags,uint x,uint y,uint data,int extra){ Calls++; Console.WriteLine("FAKE_MOUSE_CALLED"); }
}
public class NekoResidentFg : FG {}
'@
$script:patternName = ''
$script:discoveries = 0
$script:fakeRoot = [pscustomobject]@{ Current = [pscustomobject]@{ Name = 'fake window' } }
$script:fakeElement = [pscustomobject]@{ Current = [pscustomobject]@{
  BoundingRectangle = [pscustomobject]@{ X = 10; Y = 20; Width = 30; Height = 40 }
} }
function Trace-Host { }
function Write-ActionAudit { }
function Get-TargetRoot { $script:discoveries++; return $script:fakeRoot }
function Get-InputTargetRoot { throw 'physical target discovery reached' }
function Find-ByName { return $script:fakeElement }
function FindByName { return $script:fakeElement }
function Get-Pattern($unused, $pattern) { if($pattern -eq $script:patternName){ return New-Object FakePattern } }
function Pat($unused, $pattern) { return Get-Pattern $unused $pattern }
function Get-TreeSignature { return 'unchanged-tree' }
function Get-WindowSignature { return 'unchanged-window' }
function TreeSig { return Get-TreeSignature }
function WindowSig { return Get-WindowSignature }
function Start-Sleep { }
function Read-ProductAst([string]$path) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
  Assert-Test ($errors.Count -eq 0) 'product PowerShell did not parse'
  return $ast
}
`;

function runNativeFake(source: string, scriptPath: string): ReturnType<typeof spawnSync> {
  if (!powershell) throw new Error("trusted Windows PowerShell is unavailable");
  const root = mkdtempSync(join(tmpdir(), "neko-input-policy-native-fake-"));
  const fixture = join(root, "fake.ps1");
  try {
    writeFileSync(fixture, `param([string]$productPath)\n${nativeFakeScope}\n${source}`, "utf8");
    return spawnSync(powershell, ["-NoProfile", "-File", fixture, scriptPath], {
      cwd: root, windowsHide: true, encoding: "utf8", timeout: 15_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "win32")("resident background guards and UIA fallback execute only fake APIs", () => {
  const result = runNativeFake(String.raw`
$ast=Read-ProductAst $productPath
$functions=$ast.FindAll({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Get-InputPolicy','Invoke-UiaRequest')
},$true)
Assert-Test ($functions.Count -eq 2) 'resident policy functions missing'
foreach($function in $functions){ . ([scriptblock]::Create($function.Extent.Text)) }
$env:NEKO_COMPUTER_INPUT_POLICY=''
foreach($policy in @('', 'background')){
  foreach($action in @('activate','type','key','click','stroke','scroll','ocr','open')){
    $request=[pscustomobject]@{ action=$action; inputPolicy=$policy }
    $caught=$false
    try { [void](Invoke-UiaRequest $request) } catch {
      $caught=$_.Exception.Message -like '*needs_interaction:*'
    }
    Assert-Test $caught "physical action did not refuse: $action"
  }
}
Assert-Test ($script:discoveries -eq 0) 'background refusal discovered a target'
Assert-Test ([FG]::Calls -eq 0) 'background refusal touched mouse'
foreach($pattern in @('invoke','selection','toggle','expand')){
  $script:patternName=$pattern
  [FakePattern]::Calls=0
  $output=@(Invoke-UiaRequest ([pscustomobject]@{ action='invoke'; name='control'; inputPolicy='background' }))
  Assert-Test ([FakePattern]::Calls -eq 1) "semantic pattern did not act: $pattern"
  Assert-Test ([FG]::Calls -eq 0) "semantic pattern touched mouse: $pattern"
}
$script:patternName=''
$caught=$false
try { [void](Invoke-UiaRequest ([pscustomobject]@{ action='invoke'; name='control'; inputPolicy='background' })) } catch {
  $caught=$_.Exception.Message -like '*needs_interaction:*'
}
Assert-Test $caught 'unsupported background invoke did not refuse'
Assert-Test ([FG]::Calls -eq 0) 'unsupported background invoke clicked'
$env:NEKO_COMPUTER_INPUT_POLICY='foreground'
$caught=$false
try { [void](Invoke-UiaRequest ([pscustomobject]@{ action='invoke'; name='control'; inputPolicy='background' })) } catch {
  $caught=$_.Exception.Message -like '*needs_interaction:*'
}
Assert-Test $caught 'foreground environment widened an explicit background request'
Assert-Test ([FG]::Calls -eq 0) 'foreground environment caused mouse fallback'
[void](Invoke-UiaRequest ([pscustomobject]@{ action='invoke'; name='control'; inputPolicy='foreground' }))
Assert-Test ([FG]::Calls -eq 3) 'explicit foreground fallback no longer available'
Write-Output 'resident fake policy verified'
`, join(nativeScripts, "resident-uia.ps1"));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(String(result.stderr)).toBe("");
  expect(String(result.stdout)).toContain("resident fake policy verified");
});

const oneShotInvokeClause = String.raw`
$ast=Read-ProductAst $productPath
$switch=$ast.Find({ param($node)
  $node -is [Management.Automation.Language.SwitchStatementAst] -and $node.Condition.Extent.Text -eq '$cmd'
},$true)
Assert-Test ($null -ne $switch) 'one-shot dispatch missing'
$invoke=$switch.Clauses | Where-Object { $_.Item1.Value -eq 'invoke' } | Select-Object -First 1
Assert-Test ($null -ne $invoke) 'one-shot invoke clause missing'
$body=$invoke.Item2.Extent.Text
$invokeBlock=[scriptblock]::Create($body.Substring(1,$body.Length-2))
$name='control'
$root=$script:fakeRoot
`;

test.skipIf(process.platform !== "win32")("one-shot unsupported invoke refuses before fake cursor fallback", () => {
  const result = runNativeFake(`${oneShotInvokeClause}\n$inputPolicy='background'\n& $invokeBlock`, join(nativeScripts, "uia.ps1"));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(String(result.stdout)).toContain("needs_interaction:");
  expect(String(result.stdout)).not.toContain("FAKE_MOUSE_CALLED");
  expect(String(result.stderr)).toBe("");
});

test.skipIf(process.platform !== "win32")("one-shot semantic patterns remain background-capable and foreground fallback stays explicit", () => {
  const result = runNativeFake(`${oneShotInvokeClause}\n${String.raw`
$inputPolicy='background'
foreach($pattern in @('invoke','selection','toggle','expand')){
  $script:patternName=$pattern
  [FakePattern]::Calls=0
  & $invokeBlock
  Assert-Test ([FakePattern]::Calls -eq 1) "semantic pattern did not act: $pattern"
  Assert-Test ([FG]::Calls -eq 0) "semantic pattern touched mouse: $pattern"
}
$script:patternName=''
$inputPolicy='foreground'
& $invokeBlock
Assert-Test ([FG]::Calls -eq 3) 'explicit foreground fallback no longer available'
Write-Output 'one-shot fake policy verified'
`}`, join(nativeScripts, "uia.ps1"));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(String(result.stderr)).toBe("");
  expect(String(result.stdout)).toContain("one-shot fake policy verified");
});

test("one-shot input guard precedes native initialization", () => {
  for (const script of ["uia.ps1", "input.ps1", "inject.ps1", "mouse.ps1", "ocr.ps1"]) {
    const source = readFileSync(join(nativeScripts, script), "utf8");
    const guard = source.indexOf("needs_interaction:");
    const initialization = source.indexOf("Add-Type");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(initialization);
    if (script === "input.ps1") {
      expect(source.indexOf('if($cmd -eq "wait")')).toBeLessThan(initialization);
      expect(source.indexOf('if($cmd -eq "wait")')).toBeLessThan(source.indexOf("$arg=Read-AtFile"));
      expect(source.indexOf('if($cmd -eq "wait")')).toBeLessThan(source.indexOf("if($env:NEKO_PRESENCE)"));
    }
  }
});

test.skipIf(process.platform !== "win32")("raw helper guard prefixes fail closed without executing native initialization", () => {
  for (const script of ["uia.ps1", "input.ps1", "inject.ps1", "mouse.ps1", "ocr.ps1"]) {
    const result = runNativeFake(String.raw`
$ast=Read-ProductAst $productPath
$prefix=New-Object 'System.Collections.Generic.List[string]'
foreach($statement in $ast.EndBlock.Statements){
  $native=$statement.Find({ param($node)
    $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type'
  },$true)
  if($null -ne $native){ break }
  $prefix.Add($statement.Extent.Text)
}
$cmd='activate'; $arg='@never-read'; $amount=0; $name=''
$env:NEKO_COMPUTER_INPUT_POLICY=''
& ([scriptblock]::Create(($prefix -join [Environment]::NewLine)))
Write-Output 'raw guard failed to refuse'
`, join(nativeScripts, script));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(String(result.stdout)).toContain("needs_interaction:");
    expect(String(result.stdout)).not.toContain("raw guard failed to refuse");
    expect(String(result.stderr)).toBe("");
  }
}, 30_000);
