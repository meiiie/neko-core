/**
 * Scroll-latency bench through a REAL ConPTY (manual tool): long transcript via /help (no model
 * call), a 15-event wheel flick, then sample the screen. Reports first-response latency, settle
 * time after the flick, and bytes moved. Compare paths:
 *   bun scripts/bench-scroll-conpty.ts label            (installed binary, default config)
 *   BENCH_INCR=1 bun scripts/bench-scroll-conpty.ts on  (force the differ)
 * Baselines (2026-07-07, 118x30): differ-on 15ms/326ms; differ-off per-event renders 76ms/391ms;
 * differ-off + leading/trailing coalescing 63ms/110ms.
 */
import { VirtualTerminal } from "../test/vt.ts";

const exe = "C:/Users/Admin/AppData/Local/Programs/neko/neko.exe";
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
const env: Record<string, string | undefined> = { ...process.env, WT_SESSION: "bench" };
if (process.env.BENCH_INCR) env.NEKO_INCR = process.env.BENCH_INCR;
const proc = Bun.spawn({ cmd: [exe, "--yolo"], cwd: import.meta.dir + "/..", terminal: term, env } as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await sleep(4000);
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
const scrolled = vt.text().includes("Try:") === false; // heuristic: viewport left the tail
console.log(`[${label}] viewport-moved: ${vt.text() !== before}`);

term.write("\x03"); await sleep(200); term.write("\x03");
await Promise.race([proc.exited, sleep(2500)]);
try { proc.kill(); } catch {}
term.close();
process.exit(0);
