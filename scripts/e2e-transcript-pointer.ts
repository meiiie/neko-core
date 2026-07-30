/**
 * Real ConPTY E2E for `/transcript` pointer isolation and latency.
 *
 * Creates an isolated saved session, opens it with the compiled Neko binary, enters `/transcript`,
 * injects the exact XTerm SGR reports seen in the field, and proves they scroll/are consumed rather
 * than becoming search text. It then performs an ordinary text search to verify input still works.
 *
 *   rtk bun scripts/e2e-transcript-pointer.ts [path-to-neko-binary]
 *   NEKO_TRANSCRIPT_E2E_ENTRIES=5000 rtk bun scripts/e2e-transcript-pointer.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { VirtualTerminal } from "../test/vt.ts";

const Terminal = (Bun as any).Terminal;
if (typeof Terminal !== "function") throw new Error("Bun.Terminal is required for the transcript pointer E2E");

const repo = resolve(import.meta.dir, "..");
const arg = process.argv[2] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko");
const exe = isAbsolute(arg) ? arg : resolve(repo, arg);
if (!existsSync(exe)) throw new Error(`compiled Neko binary not found: ${exe}`);

const entryCount = Number.parseInt(process.env.NEKO_TRANSCRIPT_E2E_ENTRIES ?? "561", 10);
if (!Number.isSafeInteger(entryCount) || entryCount < 80 || entryCount > 10_000) {
  throw new Error("NEKO_TRANSCRIPT_E2E_ENTRIES must be an integer from 80 to 10000");
}

const home = mkdtempSync(join(tmpdir(), "neko-transcript-pointer-e2e-"));
const sessions = join(home, ".neko-core", "sessions");
mkdirSync(sessions, { recursive: true });
const id = "20260730-205000-001";
const now = new Date().toISOString();
writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
  id,
  createdAt: now,
  updatedAt: now,
  cwd: repo,
  model: "transcript-e2e",
  messages: Array.from({ length: entryCount }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: i === 0 ? "NEEDLE unique marker" : `message number ${i}`,
  })),
}));

const cols = 118, rows = 30;
const vt = new VirtualTerminal(cols, rows);
let raw = "";
const term = new Terminal({
  cols,
  rows,
  data(_terminal: unknown, chunk: Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    raw += text;
    vt.write(text);
  },
});
const proc = Bun.spawn({
  cmd: [exe, "--yolo", "--resume", id],
  cwd: repo,
  terminal: term,
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    WT_SESSION: "transcript-pointer-e2e",
    NEKO_AUTO_UPDATE: "0",
    NEKO_VERIFY_BEFORE_EXIT: "false",
  },
} as any);

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 12_000): Promise<number> {
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return performance.now() - start;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function transcriptPosition(): string | null {
  const header = vt.text().split("\n").find((line) => line.includes(`Conversation  ${entryCount} entries`));
  return header?.match(/ · (all|end|top|\d+%)/)?.[1] ?? null;
}

async function stableTranscriptPosition(stableMs = 150, timeoutMs = 3000): Promise<string | null> {
  const deadline = performance.now() + timeoutMs;
  let last = transcriptPosition();
  let unchangedSince = performance.now();
  while (performance.now() < deadline) {
    await Bun.sleep(10);
    const current = transcriptPosition();
    if (current !== last) { last = current; unchangedSince = performance.now(); }
    if (current && performance.now() - unchangedSince >= stableMs) return current;
  }
  return null;
}

let openMs = 0, wheelMs = 0, searchMs = 0;
try {
  await waitFor("interactive prompt", () => vt.text().includes("shift+tab to cycle"));

  const openStart = performance.now();
  term.write("/transcript");
  await waitFor("transcript command echo", () => vt.text().includes("> /transcript"), 3_000);
  await Bun.sleep(120);
  term.write("\r");
  // A slow ANSI/menu frame can consume the first Enter as autocomplete. Retry once only when the viewer
  // has not opened; this keeps the probe deterministic without hiding a real viewer-start failure.
  await Bun.sleep(800);
  if (!vt.text().includes(`Conversation  ${entryCount} entries`)) term.write("\r");
  await waitFor("transcript viewer", () => vt.text().includes(`Conversation  ${entryCount} entries`) && vt.text().includes(" · end"));
  openMs = performance.now() - openStart;

  const wheelStart = performance.now();
  for (let i = 0; i < 8; i++) term.write("\x1b[<64;86;26M"); // wheel up
  term.write("\x1b[<65;86;26M");                            // exact field report: wheel down
  term.write("\x1b[<35;80;20M");                            // no-button motion
  term.write("\x1b[<0;80;20M\x1b[<0;80;20m");             // press + release
  await waitFor("pointer scroll", () => vt.text().includes(`Conversation  ${entryCount} entries`) && !vt.text().includes(" · end"));
  wheelMs = performance.now() - wheelStart;

  const verticalPosition = await stableTranscriptPosition();
  if (!verticalPosition) throw new Error("transcript header position did not settle after vertical scroll");
  term.write("\x1b[<66;80;20M");                            // horizontal left
  await Bun.sleep(100);
  if (transcriptPosition() !== verticalPosition) throw new Error("horizontal-left wheel changed vertical offset");
  term.write("\x1b[<67;80;20M");                            // horizontal right
  await Bun.sleep(100);
  if (transcriptPosition() !== verticalPosition) throw new Error("horizontal-right wheel changed vertical offset");

  const pointerScreen = vt.text();
  if (pointerScreen.includes("[<") || pointerScreen.includes("found 0") || pointerScreen.includes("search: [<")) {
    throw new Error("SGR pointer report polluted transcript search");
  }

  const searchStart = performance.now();
  term.write("NEEDLE");
  await waitFor("ordinary transcript search", () => vt.text().includes("found 1") && vt.text().includes("NEEDLE unique marker"));
  searchMs = performance.now() - searchStart;

  console.log(JSON.stringify({
    result: "PASS",
    binary: exe,
    entries: entryCount,
    openMs: Math.round(openMs),
    wheelFirstResponseMs: Math.round(wheelMs),
    searchMs: Math.round(searchMs),
    rawBytes: new TextEncoder().encode(raw).length,
  }));
} catch (error) {
  console.error(vt.text());
  throw error;
} finally {
  try { proc.kill(); } catch {}
  await Promise.race([proc.exited, Bun.sleep(3000)]);
  term.close();
  rmSync(home, { recursive: true, force: true });
}
