/**
 * Scroll-latency bench through a REAL ConPTY (manual tool): long transcript via /help (no model
 * call), a 15-event wheel flick, then sample the screen. Reports first-response latency, settle
 * time after the flick, and bytes moved. Compare paths:
 *   bun scripts/bench-scroll-conpty.ts label [binary]   (worktree dist/neko by default)
 *   BENCH_INCR=1 bun scripts/bench-scroll-conpty.ts on  (force the differ)
 * Baselines (2026-07-07, 118x30): differ-on 15ms/326ms; differ-off per-event renders 76ms/391ms;
 * differ-off + leading/trailing coalescing 63ms/110ms.
 */
import { VirtualTerminal } from "../test/vt.ts";

const exe = process.argv[3] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko");
const label = process.argv[2] ?? "default";
const cols = 118, rows = 30;
const vt = new VirtualTerminal(cols, rows);
let bytes = 0;
let lastChangeAt = 0;
let snapshot = "";
const term = new (Bun as any).Terminal({
  cols, rows,
  data(_t: unknown, c: Uint8Array) {
    bytes += c.length;
    vt.write(new TextDecoder().decode(c));
    const t = vt.text();
    if (t !== snapshot) { snapshot = t; lastChangeAt = performance.now(); }
  },
});
const env: Record<string, string | undefined> = { ...process.env, WT_SESSION: "bench", NEKO_AUTO_UPDATE: "0" };
if (process.env.BENCH_INCR) env.NEKO_INCR = process.env.BENCH_INCR;
const proc = Bun.spawn({ cmd: [exe, "--yolo"], cwd: import.meta.dir + "/..", terminal: term, env } as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number) => {
  for (let waited = 0; waited < ms && !pred(); waited += 50) await sleep(50);
  return pred();
};

const startupOk = await until(() => vt.text().includes("shift+tab to cycle"), 8000);
term.write("/help"); await sleep(400); term.write("\r"); await sleep(700);
term.write("/help"); await sleep(400); term.write("\r"); await sleep(700);
term.write("/help"); await sleep(400); term.write("\r"); await sleep(900);

// Baseline settled. Burst 15 wheel-ups over ~150ms (a real flick).
const preBytes = bytes;
const t0 = performance.now();
let firstChange = 0;
const before = vt.text();
const watcher = setInterval(() => {
  if (!firstChange && vt.text() !== before) firstChange = performance.now();
}, 5);
for (let i = 0; i < 15; i++) { term.write("\x1b[<64;5;5M"); await sleep(10); }
// Wait for the screen to go quiet (300ms with no change).
while (performance.now() - Math.max(lastChangeAt, t0) < 300) await sleep(20);
clearInterval(watcher);
const settle = lastChangeAt - t0;
console.log(`[${label}] first-response: ${firstChange ? (firstChange - t0).toFixed(0) : "none"}ms  settle-after-flick: ${settle.toFixed(0)}ms  bytes: ${((bytes - preBytes) / 1024).toFixed(1)}KB`);
const viewportMoved = vt.text() !== before;
console.log(`[${label}] viewport-moved: ${viewportMoved}`);

// Real ConPTY interaction smoke: resize, open the slash picker, navigate by keyboard, and complete.
vt.resize(72, 20); term.resize(72, 20);
await until(() => vt.lines().filter((line) => line.includes("shift+tab to cycle")).length === 1 && vt.lines()[19] === "", 3000);
const resized = vt.lines();
const footerCount = resized.filter((line) => line.includes("shift+tab to cycle")).length;
const resizeOk = footerCount === 1 && resized[19] === "";
if (!resizeOk) {
  console.log(`[${label}] resize diagnostics: footer-count=${footerCount} last-row=${JSON.stringify(resized[19])}`);
  console.log(resized.map((line, i) => `${String(i).padStart(2)}|${line}`).join("\n"));
}
term.write("/");
const menuOk = await until(() => vt.text().includes("/help") && vt.text().includes("up/down to select, tab to complete"), 2000);
term.write("\x1b[B"); await sleep(80); term.write("\t");
const keyboardOk = await until(() => vt.text().includes("> /cost"), 2000);
console.log(`[${label}] startup=${startupOk ? "OK" : "FAIL"} resize=${resizeOk ? "OK" : "FAIL"} slash-menu=${menuOk ? "OK" : "FAIL"} keyboard=${keyboardOk ? "OK" : "FAIL"}`);

term.write("\x03"); await sleep(200); term.write("\x03");
await Promise.race([proc.exited, sleep(2500)]);
try { proc.kill(); } catch {}
term.close();
process.exit(startupOk && resizeOk && menuOk && keyboardOk && viewportMoved ? 0 : 1);
