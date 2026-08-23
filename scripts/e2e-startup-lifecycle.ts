/**
 * Real ConPTY regression for the two edges users see most clearly:
 *   1. the welcome header is present when the composer first appears;
 *   2. terminal restore finishes before the resume handoff is printed.
 *
 * Run after `bun run build`: `bun scripts/e2e-startup-lifecycle.ts`.
 * Release artifact: `bun scripts/e2e-startup-lifecycle.ts --exe ./neko-windows-x64.exe`.
 * Source fallback: `bun scripts/e2e-startup-lifecycle.ts --source`.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LEAVE_ALT } from "../src/ui/altscreen.ts";
import { VirtualTerminal } from "../test/vt.ts";

const repo = resolve(import.meta.dir, "..");
const sourceMode = process.argv.includes("--source");
const exeArgAt = process.argv.indexOf("--exe");
const exeArg = exeArgAt >= 0 ? process.argv[exeArgAt + 1] : undefined;
if (sourceMode && exeArg) throw new Error("choose either --source or --exe, not both");
if (exeArgAt >= 0 && !exeArg) throw new Error("--exe requires a path");
const exe = exeArg
  ? resolve(repo, exeArg)
  : resolve(repo, "dist", process.platform === "win32" ? "neko.exe" : "neko");
if (!sourceMode && !existsSync(exe)) throw new Error(`missing ${exe}; run bun run build first`);
const command = sourceMode
  ? [process.execPath, resolve(repo, "bin", "neko.ts"), "--yolo"]
  : [exe, "--yolo"];

const home = mkdtempSync(join(tmpdir(), "neko-startup-lifecycle-"));
const vt = new VirtualTerminal(118, 30);
let raw = "";
let composerSeen = false;
let headerPresentAtComposer = false;

// SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
const term = new (Bun as any).Terminal({
  cols: 118,
  rows: 30,
  data(_terminal: any, chunk: Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    raw += text;
    vt.write(text);
    if (!composerSeen && vt.text().includes('Try: "explain src/agent.ts"')) {
      composerSeen = true;
      headerPresentAtComposer = vt.text().includes("Neko Core v");
    }
  },
});

// SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
const proc = Bun.spawn({
  cmd: command,
  cwd: repo,
  terminal: term,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WT_SESSION: "startup-lifecycle-e2e",
    NEKO_AUTO_UPDATE: "0",
    NEKO_COMPLETION_SOUND: "0",
    NEKO_MOUSE: "0",
  },
} as any);

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  for (let elapsed = 0; elapsed < timeoutMs && !predicate(); elapsed += 25) await sleep(25);
  return predicate();
};

let ok = false;
try {
  if (!(await waitFor(() => composerSeen, 15_000))) throw new Error("composer did not appear");
  if (!headerPresentAtComposer) throw new Error("composer appeared before the welcome header");

  await sleep(500); // allow Ink's input effect to attach; this test targets paint/teardown, not key-race timing
  for (const key of "/exit") { term.write(key); await sleep(15); }
  term.write("\r");
  const exitCode = await Promise.race([proc.exited, sleep(5_000).then(() => null)]);
  if (exitCode === null) throw new Error("neko did not exit after /exit");

  const resumeAt = raw.lastIndexOf("Resume this session with:");
  const leaveAt = raw.lastIndexOf(LEAVE_ALT);
  if (resumeAt < 0) {
    throw new Error(`resume handoff was not printed; terminal tail=${JSON.stringify(raw.slice(-2_000))}`);
  }
  if (leaveAt < 0 || leaveAt > resumeAt) throw new Error("terminal restore did not finish before the resume handoff");
  const afterRestore = raw.slice(leaveAt + LEAVE_ALT.length, resumeAt);
  const visiblePrefix = afterRestore.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // POSIX PTYs may apply ONLCR to an already CRLF-anchored write, producing CR-CR-LF. It is still the
  // same clean-line boundary on screen; require two line feeds while accepting one or more carriage
  // returns before each. Windows ConPTY emits the ordinary CR-LF form.
  if (!/(?:\r*\n){2}$/.test(visiblePrefix)) {
    throw new Error(`resume handoff was not anchored on a clean line: ${JSON.stringify(afterRestore)}`);
  }
  if (raw.slice(resumeAt).includes(LEAVE_ALT)) throw new Error("a late terminal restore ran after the resume handoff");

  ok = true;
  console.log("startup-lifecycle-e2e: first frame complete; exit handoff ordered; OK");
} finally {
  try { proc.kill(); } catch { /* already exited */ }
  term.close();
  rmSync(home, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
