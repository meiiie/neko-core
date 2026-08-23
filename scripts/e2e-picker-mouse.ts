/**
 * Real ConPTY regression for fullscreen picker mouse input.
 *
 * Launches the compiled binary, opens the local-only /login picker, then injects the exact SGR
 * reports Windows Terminal sends for wheel and no-button motion. No provider call or credential is
 * involved. Mode-transition bytes are asserted by the fullscreen simulation because ConPTY consumes
 * recognized DECSET sequences instead of echoing them back through its output stream.
 *
 *   bun scripts/e2e-picker-mouse.ts [path-to-neko-binary]
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { VirtualTerminal } from "../test/vt.ts";

// SAFETY: Bun.Terminal is a runtime-only PTY API; the function check below guards its loose surface.
const Terminal = (Bun as any).Terminal;
if (!(Terminal instanceof Function)) throw new Error("Bun.Terminal is required for the picker mouse E2E");

const repo = resolve(import.meta.dir, "..");
const arg = process.argv[2] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko");
const exe = isAbsolute(arg) ? arg : resolve(repo, arg);
if (!existsSync(exe)) throw new Error(`compiled Neko binary not found: ${exe}`);

const home = mkdtempSync(join(tmpdir(), "neko-picker-mouse-e2e-"));
const cols = 118;
const rows = 34;
const vt = new VirtualTerminal(cols, rows);
const term = new Terminal({
  cols,
  rows,
  // SAFETY: test-built PTY callback; Bun supplies the terminal handle and a byte chunk.
  data(_terminal: any, chunk: Uint8Array) {
    vt.write(new TextDecoder().decode(chunk));
  },
});

// SAFETY: test-built fixture; every spawn field is fixed by this script or resolved inside the repo.
const proc = Bun.spawn({
  cmd: [exe, "--yolo"],
  cwd: repo,
  terminal: term,
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    WT_SESSION: "picker-mouse-e2e",
    NEKO_AUTO_UPDATE: "0",
    NEKO_VERIFY_BEFORE_EXIT: "false",
  },
} as any);

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function selectedLabel(): string | undefined {
  return vt.lines().find((line) => /^\s*>\s+\S/.test(line))?.trim();
}

try {
  await waitFor("interactive prompt", () => vt.text().includes("shift+tab to cycle"));
  term.write("/login\r");
  await waitFor("login picker", () => vt.text().includes("Sign in - choose a provider"));
  const initial = selectedLabel();

  term.write("\x1b[<65;5;5M");
  await waitFor("wheel selection", () => selectedLabel() !== initial);
  const afterWheel = selectedLabel();

  const googleRow = vt.lines().findIndex((line) => line.includes("Google")) + 1;
  if (googleRow <= 0) throw new Error("Google row was not visible in the login picker");
  term.write(`\x1b[<35;5;${googleRow}M`);
  await waitFor("hover selection", () => selectedLabel()?.includes("Google") === true);
  const afterHover = selectedLabel();

  term.write("\x1b");
  await waitFor("picker close", () => !vt.text().includes("Sign in - choose a provider"));

  console.log(JSON.stringify({ result: "PASS", binary: exe, initial, afterWheel, afterHover }));
} catch (error) {
  console.error(vt.lines().map((line, index) => `${String(index + 1).padStart(2)}|${line}`).join("\n"));
  throw error;
} finally {
  try { proc.kill(); } catch {}
  await Promise.race([proc.exited, Bun.sleep(3000)]);
  term.close();
  rmSync(home, { recursive: true, force: true });
}
