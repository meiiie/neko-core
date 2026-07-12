/**
 * Manual Windows desktop-input probe. It opens a disposable WPF text box, then exercises Neko's
 * first-class computer type/key/wait actions against a uniquely titled window and reads the value back
 * through UI Automation. Nothing is installed or persisted; the form is closed in finally.
 *
 * Usage: bun scripts/probe-computer-input.ts
 */
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.error("computer-input-probe: Windows only");
  process.exit(1);
}

const title = `Neko Input Probe ${process.pid}`;
const canvasPoint = join(tmpdir(), `neko_canvas_probe_${process.pid}.txt`);
const formScript = `
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$window=New-Object System.Windows.Window
$window.Title='${title}'; $window.Width=520; $window.Height=280; $window.WindowStartupLocation='CenterScreen'
$panel=New-Object System.Windows.Controls.StackPanel
$panel.Margin='20'
$label=New-Object System.Windows.Controls.TextBlock
$label.Text='Disposable computer-input probe'; $label.Margin='0,0,0,16'
$box=New-Object System.Windows.Controls.TextBox
[System.Windows.Automation.AutomationProperties]::SetName($box,'Probe input')
$canvas=New-Object System.Windows.Controls.Canvas
$canvas.Height=80; $canvas.Margin='0,16,0,0'; $canvas.Background='#202020'
$canvas.Add_TouchUp({ $box.Text='Canvas tapped'; $canvas.Background='#D04040'; $_.Handled=$true })
$panel.Children.Add($label) | Out-Null; $panel.Children.Add($box) | Out-Null; $panel.Children.Add($canvas) | Out-Null
$window.Content=$panel
$window.Add_ContentRendered({
  [void]$box.Focus()
  $point=$canvas.PointToScreen((New-Object System.Windows.Point ($canvas.ActualWidth/2),($canvas.ActualHeight/2)))
  ([string]([int]$point.X)+','+[string]([int]$point.Y)) | Set-Content -LiteralPath '${canvasPoint.replaceAll("'", "''")}' -Encoding ascii
})
[void]$window.ShowDialog()
`;
const encoded = Buffer.from(formScript, "utf16le").toString("base64");
const form = Bun.spawn(["powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
  stdout: "pipe",
  stderr: "pipe",
});
let duplicate: ReturnType<typeof Bun.spawn> | null = null;
const captures: string[] = [];
const tools = new ToolRegistry(process.cwd(), "auto", async () => true);
async function measured(label: string, action: () => Promise<string>): Promise<string> {
  const started = performance.now();
  const value = await action();
  console.log(`  ${label}: ${Math.round(performance.now() - started)} ms`);
  return value;
}
async function benchmark(label: string, action: () => Promise<string>): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < 7; i++) {
    const started = performance.now();
    await action();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  console.log(`  ${label}: p50 ${Math.round(samples[3])} ms, p95 ${Math.round(samples[6])} ms`);
}

async function eventually(action: () => Promise<string>, accept: (value: string) => boolean, ms = 10_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = String(await action());
    if (accept(last)) return last;
    await Bun.sleep(100);
  }
  throw new Error(`timed out; last result: ${last}`);
}

try {
  await measured("resident UIA ready", () => eventually(
    () => tools.execute("computer", { action: "list", window: title }).then(String),
    (value) => value.includes("Probe input"),
  ));
  await benchmark("warm list", () => tools.execute("computer", { action: "list", window: title }).then(String));

  const typed = await measured("Unicode type", () => tools.execute("computer", { action: "type", window: title, name: "Probe input", text: "Xin chào Neko" }).then(String));
  if (!typed.includes("typed 13 chars")) throw new Error(typed);
  await measured("resident get", () => eventually(
    () => tools.execute("computer", { action: "get", window: title, name: "Probe input" }).then(String),
    (value) => value.includes("Xin chào Neko"),
  ));

  const selected = await measured("select all", () => tools.execute("computer", { action: "key", window: title, name: "Probe input", keys: "CTRL+A" }).then(String));
  if (!selected.includes("sent key CTRL+A")) throw new Error(selected);
  const replaced = await measured("replacement type", () => tools.execute("computer", { action: "type", window: title, name: "Probe input", text: "Replaced7" }).then(String));
  if (!replaced.includes("typed 9 chars")) throw new Error(replaced);
  await measured("resident verify", () => eventually(
    () => tools.execute("computer", { action: "get", window: title, name: "Probe input" }).then(String),
    (value) => value.includes("Replaced7") && !value.includes("Xin chào Neko"),
  ));
  await benchmark("warm get", () => tools.execute("computer", { action: "get", window: title, name: "Probe input" }).then(String));
  await benchmark("warm setvalue", () => tools.execute("computer", { action: "setvalue", window: title, name: "Probe input", value: "Replaced7" }).then(String));

  const waited = String(await tools.execute("computer", { action: "wait", duration_ms: 1 }));
  if (!waited.includes("waited 1 ms")) throw new Error(waited);

  const point = await eventually(
    async () => { try { return await Bun.file(canvasPoint).text(); } catch { return ""; } },
    (value) => /^\d+,\d+/.test(value.trim()),
  );
  const [x, y] = point.trim().split(",").map(Number);
  const beforeCapture = await measured("resident capture baseline", () => tools.execute("computer", { action: "screenshot" }).then(String));
  const beforePath = beforeCapture.match(/^saved (.+?)\s+view=/)?.[1];
  if (beforePath) captures.push(beforePath);
  if (!beforePath || !beforeCapture.includes("frame=1 delta=baseline")) throw new Error(beforeCapture);
  const tapped = await measured("custom canvas tap", () => tools.execute("computer", { action: "click", window: title, x, y }).then(String));
  if (!tapped.includes("mouse not moved")) throw new Error(tapped);
  await measured("canvas effect verify", () => eventually(
    () => tools.execute("computer", { action: "get", window: title, name: "Probe input" }).then(String),
    (value) => value.includes("Canvas tapped"),
  ));
  const afterCapture = await measured("resident capture delta", () => tools.execute("computer", { action: "screenshot" }).then(String));
  const afterPath = afterCapture.match(/^saved (.+?)\s+view=/)?.[1];
  if (afterPath) captures.push(afterPath);
  if (!afterPath || !/frame=2 delta=(?!0\.00%)/.test(afterCapture) || !afterCapture.includes("changed=")) throw new Error(afterCapture);

  duplicate = Bun.spawn(["powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await eventually(
    () => tools.execute("computer", { action: "type", window: title, name: "Probe input", text: "must not land" }).then(String),
    (value) => value.includes("matches multiple windows"),
  );
  console.log("computer-input-probe: PASS (Unicode keys + custom-drawn canvas touch + readback; ambiguous target refused)");
} finally {
  rmSync(canvasPoint, { force: true });
  for (const capture of captures) rmSync(capture, { force: true });
  if (duplicate) {
    duplicate.kill();
    await Promise.race([duplicate.exited, Bun.sleep(1000)]);
  }
  try { await tools.execute("computer", { action: "key", window: title, keys: "ALT+F4" }); } catch {}
  const exited = await Promise.race([form.exited, Bun.sleep(2000).then(() => null)]);
  if (exited === null) form.kill();
}
