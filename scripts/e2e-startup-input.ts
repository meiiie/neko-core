/** Real PTY startup acceptance: retain type-ahead and echo input at the first composer frame.
 * Run with --source, or --exe <compiled binary>. No model request or real credentials are used.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VirtualTerminal } from "../test/vt.ts";

const source = process.argv.includes("--source");
const exeIndex = process.argv.indexOf("--exe");
const exe = exeIndex >= 0 ? process.argv[exeIndex + 1] : join("dist", process.platform === "win32" ? "neko.exe" : "neko");
if (!exe || (source && exeIndex >= 0)) throw new Error("choose --source or --exe <binary>");
const command = source ? [process.execPath, resolve("bin/neko.ts")] : [resolve(exe)];
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

for (const early of [true, false]) for (const yolo of [false, true]) {
  const home = mkdtempSync(join(tmpdir(), "neko-input-startup-"));
  mkdirSync(join(home, ".neko-core"));
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({
    auto_update: false, auto_update_check: false, completion_sound: false, mcp_servers: {},
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TERM: "xterm-256color", NEKO_MOUSE: "0" };
  // Exercise the unknown-terminal path on POSIX, not a capability inferred from the test runner.
  for (const name of ["NEKO_SYNC", "TERM_PROGRAM", "VTE_VERSION", "WT_SESSION", "TMUX", "KITTY_WINDOW_ID", "ZED_TERM"]) delete env[name];
  const vt = new VirtualTerminal(118, 30);
  const marker = "startup_input_kept";
  const started = performance.now();
  let startupBytes = "";
  let sent: number | null = null, composer: number | null = null, echoed: number | null = null;
  const term = new Bun.Terminal({ cols: 118, rows: 30, data(terminal, bytes) {
    const text = new TextDecoder().decode(bytes);
    if (sent === null) startupBytes = (startupBytes + text).slice(-16_384);
    vt.write(text);
    const screen = vt.text();
    if (composer === null && screen.includes('Try: "explain src/agent.ts"')) composer = performance.now() - started;
    // ConPTY may normalize OSC 2 (window title) to OSC 0 (icon + window title).
    // Accumulate fragments: a transport chunk is not an escape-sequence boundary.
    if (sent === null && (early ? /\x1b\](?:0|2);/.test(startupBytes) : composer !== null)) {
      sent = performance.now() - started;
      terminal.write(marker);
    }
    if (composer !== null && screen.includes("> " + marker) && echoed === null) echoed = performance.now() - started;
  } });
  const proc = Bun.spawn({ cmd: [...command, ...(yolo ? ["--yolo"] : [])], cwd: home, terminal: term, env });
  try {
    while (echoed === null && performance.now() - started < 8_000) await sleep(10);
    if (echoed === null) throw new Error(`startup input lost or stalled: early=${early}, yolo=${yolo}, sentMs=${sent}, composerMs=${composer}, startup=${JSON.stringify(startupBytes.slice(0, 300))}, screen=${vt.text()}`);
    console.log(JSON.stringify({ early, yolo, composerMs: composer, sentMs: sent, echoMs: echoed }));
    // Verify the draft survives a later input/render, rather than mistaking the PTY's pre-raw
    // local echo for text owned by the composer. The first input above has no readiness delay.
    await sleep(200);
    term.write("x");
    const editDeadline = performance.now() + 2_000;
    while (!vt.text().includes("> " + marker + "x") && performance.now() < editDeadline) await sleep(10);
    if (!vt.text().includes("> " + marker + "x")) throw new Error("type-ahead did not survive a subsequent edit");
    term.write("\x15"); await sleep(100);
    term.write("/exit"); await sleep(50); term.write("\r");
    const exit = await Promise.race([proc.exited, sleep(5_000).then(() => null)]);
    if (exit !== 0) throw new Error(`startup input exit failed: ${exit}`);
  } finally {
    if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    term.close();
    rmSync(home, { recursive: true, force: true });
  }
}
