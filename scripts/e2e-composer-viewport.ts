/**
 * Real-PTY composer regression probe.
 *
 * Runs the compiled `neko --yolo`, types more logical rows than the composer
 * viewport can show, then verifies the box stays bounded and Up moves the
 * logical caret into older input instead of recalling prompt history.
 */
import { VirtualTerminal } from "../test/vt.ts";

const exe = process.argv[2] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko");
const cols = 90;
const rows = 24;
const vt = new VirtualTerminal(cols, rows);
let raw = "";
// SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
const term = new (Bun as any).Terminal({
  cols,
  rows,
  data(_terminal: unknown, chunk: Uint8Array) {
    const text = new TextDecoder().decode(chunk);
    raw += text;
    vt.write(text);
  },
});
const env: Record<string, string | undefined> = {
  ...process.env,
  NEKO_AUTO_UPDATE: "0",
  WT_SESSION: "composer-e2e",
};
// SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
const proc = Bun.spawn({
  cmd: [exe, "--yolo"],
  cwd: import.meta.dir + "/..",
  terminal: term,
  env,
} as any);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeoutMs: number) => {
  for (let waited = 0; waited < timeoutMs && !predicate(); waited += 50) await sleep(50);
  return predicate();
};

let ok = false;
try {
  if (!(await until(() => vt.text().includes("shift+tab to cycle"), 10_000))) {
    throw new Error(`startup timed out\n${vt.text()}`);
  }
  for (let i = 1; i <= 7; i++) {
    term.write(`composer-line-${i}`);
    if (i < 7) term.write("\x1b[13;2u"); // Shift+Enter through kitty CSI-u
    await sleep(80);
  }
  await sleep(300);

  const visible = vt.lines().filter((line) => line.includes("composer-line-")).length;
  const before = { row: vt.r, col: vt.c };
  term.write("\x1b[A");
  await sleep(120);
  term.write("-UP"); // prove the logical caret moved even if viewport-follow keeps its screen row fixed
  await sleep(300);
  const after = { row: vt.r, col: vt.c };
  const frame = vt.text();
  const visibleAfter = vt.lines().filter((line) => line.includes("composer-line-")).length;
  const bounded = visible <= 5 && visibleAfter <= 5;
  const editedPreviousLine = frame.includes("composer-line-6-UP");
  const tailScrolledOut = !frame.includes("composer-line-7");
  ok = bounded && editedPreviousLine && tailScrolledOut;
  console.log(`composer-e2e: visible-input-rows=${visible} -> ${visibleAfter} (max 5)`);
  console.log(`composer-e2e: caret ${before.row + 1}:${before.col + 1} -> ${after.row + 1}:${after.col + 1}; line-6 edited=${editedPreviousLine}; line-7 hidden=${tailScrolledOut}`);
  console.log(ok ? "composer-e2e: OK" : "composer-e2e: REPRODUCED");
} finally {
  term.write("\x03");
  await sleep(150);
  term.write("\x03");
  await Promise.race([proc.exited, sleep(2_000)]);
  try { proc.kill(); } catch {}
  term.close();
  if (!ok && process.env.NEKO_COMPOSER_RAW) await Bun.write(process.env.NEKO_COMPOSER_RAW, raw);
}

process.exit(ok ? 0 : 1);
