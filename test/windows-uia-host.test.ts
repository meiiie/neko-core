import { expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ResidentUiaHost } from "../src/core/windows-uia-host.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const script = join(import.meta.dir, "..", "skills", "computer-use", "scripts", "resident-uia.ps1");

test("resident UIA host reuses one PowerShell process and restarts after disposal", async () => {
  if (process.platform !== "win32") return;
  const host = new ResidentUiaHost(script);
  try {
    const first = await host.request({ action: "ping" });
    const second = await host.request({ action: "ping" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.pid).toBe(second.pid);

    host.dispose();
    const restarted = await host.request({ action: "ping" });
    expect(restarted.ok).toBe(true);
    expect(restarted.pid).not.toBe(first.pid);
  } finally {
    host.dispose();
  }
}, 15_000);

test("resident host handles waits without spawning another PowerShell process", async () => {
  if (process.platform !== "win32") return;
  const host = new ResidentUiaHost(script);
  try {
    const ready = await host.request({ action: "ping" });
    const waited = await host.request({ action: "wait", durationMs: 1 });
    expect(waited.ok).toBe(true);
    expect(waited.output).toContain("waited 1 ms");
    expect(waited.pid).toBe(ready.pid);
  } finally {
    host.dispose();
  }
});

test("resident host captures consecutive frames and keeps delta state in one process", async () => {
  if (process.platform !== "win32") return;
  const host = new ResidentUiaHost(script);
  const firstPath = join(tmpdir(), `neko_resident_capture_${process.pid}_1.gif`);
  const secondPath = join(tmpdir(), `neko_resident_capture_${process.pid}_2.gif`);
  try {
    const first = await host.request({ action: "screenshot", capturePath: firstPath, width: 320 });
    const second = await host.request({ action: "screenshot", capturePath: secondPath, width: 320 });
    expect(first.ok).toBe(true);
    expect(first.output).toContain("frame=1 delta=baseline");
    expect(second.ok).toBe(true);
    expect(second.output).toContain("frame=2 delta=");
    expect(second.pid).toBe(first.pid);
    expect(existsSync(firstPath) && statSync(firstPath).size > 0).toBe(true);
    expect(existsSync(secondPath) && statSync(secondPath).size > 0).toBe(true);
  } finally {
    host.dispose();
    rmSync(firstPath, { force: true });
    rmSync(secondPath, { force: true });
  }
});

test("an idle resident host does not pin a short-lived Neko process", async () => {
  if (process.platform !== "win32") return;
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "core", "windows-uia-host.ts")).href;
  const code = `import { ResidentUiaHost } from ${JSON.stringify(moduleUrl)}; const h = new ResidentUiaHost(${JSON.stringify(script)}); await h.request({action:'ping'});`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "pipe" });
  const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
  if (exited === null) child.kill();
  expect(exited).toBe(0);
});

test("resident UIA host reads a disposable WPF accessibility tree", async () => {
  if (process.platform !== "win32") return;
  const title = `Neko Resident UIA ${process.pid}`;
  const source = `
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$w=New-Object System.Windows.Window
$w.Title='${title}'; $w.Width=420; $w.Height=160
$p=New-Object System.Windows.Controls.StackPanel
$b=New-Object System.Windows.Controls.TextBox
[System.Windows.Automation.AutomationProperties]::SetName($b,'Resident probe input')
$c=New-Object System.Windows.Controls.CheckBox
$c.Content='Resident probe toggle'
$button=New-Object System.Windows.Controls.Button
$button.Content='Resident probe button'
$button.Add_Click({ $b.Text='Invoked' })
[void]$p.Children.Add($b); [void]$p.Children.Add($c); [void]$p.Children.Add($button)
$w.Content=$p
[void]$w.ShowDialog()
`;
  const form = Bun.spawn(["powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { stdout: "ignore", stderr: "ignore" });
  const host = new ResidentUiaHost(script);
  try {
    let output = "";
    for (let i = 0; i < 20 && !output.includes("Resident probe input"); i++) {
      const response = await host.request({ action: "list", window: title }, 5_000);
      output = response.output ?? "";
      if (!response.ok) await Bun.sleep(100);
    }
    expect(output).toContain("Resident probe input");
    expect((await host.request({ action: "setvalue", window: title, name: "Resident probe input", value: "Resident" })).output).toContain("set+VERIFIED");
    expect((await host.request({ action: "get", window: title, name: "Resident probe input" })).output).toContain("Resident");
    expect((await host.request({ action: "toggle", window: title, name: "Resident probe toggle" })).output).toContain("toggled+VERIFIED");
    expect((await host.request({ action: "invoke", window: title, name: "Resident probe button" })).output).toContain("invoked");
    expect((await host.request({ action: "get", window: title, name: "Resident probe input" })).output).toContain("Invoked");
  } finally {
    host.dispose();
    form.kill();
    await Promise.race([form.exited, Bun.sleep(1000)]);
  }
});

test("computer tool dispatches UIA reads through the resident host", async () => {
  if (process.platform !== "win32") return;
  const title = `Neko Resident Dispatch ${process.pid}`;
  const source = `
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$w=New-Object System.Windows.Window
$w.Title='${title}'; $w.Width=420; $w.Height=160
$b=New-Object System.Windows.Controls.TextBox
[System.Windows.Automation.AutomationProperties]::SetName($b,'Dispatch probe input')
$w.Content=$b
[void]$w.ShowDialog()
`;
  const form = Bun.spawn(["powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { stdout: "ignore", stderr: "ignore" });
  const tools = new ToolRegistry(join(import.meta.dir, ".."), "auto", async () => true);
  try {
    let output = "";
    for (let i = 0; i < 20 && !output.includes("Dispatch probe input"); i++) {
      output = String(await tools.execute("computer", { action: "list", window: title }));
      if (!output.includes("Dispatch probe input")) await Bun.sleep(100);
    }
    expect(output).toContain("Dispatch probe input");
  } finally {
    form.kill();
    await Promise.race([form.exited, Bun.sleep(1000)]);
  }
});
