/**
 * Manual Windows desktop-input probe. It opens a disposable WPF text box, then exercises Neko's
 * first-class computer type/key/wait actions against a uniquely titled window and reads the value back
 * through UI Automation. Nothing is installed or persisted; the form is closed in finally.
 *
 * Usage: bun scripts/probe-computer-input.ts
 */
import { ToolRegistry } from "../src/core/tool-runtime.ts";

if (process.platform !== "win32") {
  console.error("computer-input-probe: Windows only");
  process.exit(1);
}

const title = `Neko Input Probe ${process.pid}`;
const formScript = `
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$window=New-Object System.Windows.Window
$window.Title='${title}'; $window.Width=520; $window.Height=180; $window.WindowStartupLocation='CenterScreen'
$panel=New-Object System.Windows.Controls.StackPanel
$panel.Margin='20'
$label=New-Object System.Windows.Controls.TextBlock
$label.Text='Disposable computer-input probe'; $label.Margin='0,0,0,16'
$box=New-Object System.Windows.Controls.TextBox
[System.Windows.Automation.AutomationProperties]::SetName($box,'Probe input')
$panel.Children.Add($label) | Out-Null; $panel.Children.Add($box) | Out-Null
$window.Content=$panel
$window.Add_ContentRendered({ [void]$box.Focus() })
[void]$window.ShowDialog()
`;
const encoded = Buffer.from(formScript, "utf16le").toString("base64");
const form = Bun.spawn(["powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
  stdout: "pipe",
  stderr: "pipe",
});
let duplicate: ReturnType<typeof Bun.spawn> | null = null;
const tools = new ToolRegistry(process.cwd(), "auto", async () => true);

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
  await eventually(
    () => tools.execute("computer", { action: "list", window: title }).then(String),
    (value) => value.includes("Probe input"),
  );

  const typed = String(await tools.execute("computer", { action: "type", window: title, name: "Probe input", text: "Xin chào Neko" }));
  if (!typed.includes("typed 13 chars")) throw new Error(typed);
  await eventually(
    () => tools.execute("computer", { action: "get", window: title, name: "Probe input" }).then(String),
    (value) => value.includes("Xin chào Neko"),
  );

  const selected = String(await tools.execute("computer", { action: "key", window: title, name: "Probe input", keys: "CTRL+A" }));
  if (!selected.includes("sent key CTRL+A")) throw new Error(selected);
  const replaced = String(await tools.execute("computer", { action: "type", window: title, name: "Probe input", text: "Replaced7" }));
  if (!replaced.includes("typed 9 chars")) throw new Error(replaced);
  await eventually(
    () => tools.execute("computer", { action: "get", window: title, name: "Probe input" }).then(String),
    (value) => value.includes("Replaced7") && !value.includes("Xin chào Neko"),
  );

  const waited = String(await tools.execute("computer", { action: "wait", duration_ms: 1 }));
  if (!waited.includes("waited 1 ms")) throw new Error(waited);

  duplicate = Bun.spawn(["powershell", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(600);
  const ambiguous = String(await tools.execute("computer", { action: "type", window: title, name: "Probe input", text: "must not land" }));
  if (!ambiguous.includes("matches multiple windows")) throw new Error(`ambiguous target did not fail closed: ${ambiguous}`);
  console.log("computer-input-probe: PASS (Unicode type -> Ctrl+A -> replacement -> UIA readback; ambiguous target refused)");
} finally {
  if (duplicate) {
    duplicate.kill();
    await Promise.race([duplicate.exited, Bun.sleep(1000)]);
  }
  try { await tools.execute("computer", { action: "key", window: title, keys: "ALT+F4" }); } catch {}
  const exited = await Promise.race([form.exited, Bun.sleep(2000).then(() => null)]);
  if (exited === null) form.kill();
}
