/**
 * E2E ghost harness (MANUAL tool - needs a configured model/API key; not part of the CI suite).
 *
 * Runs a REAL neko binary under a REAL ConPTY (Bun.Terminal), replays everything the terminal
 * receives into the VirtualTerminal, types a message, and counts duplicated footer/prompt rows
 * across a live turn. This is the instrument that caught the WT synchronized-output corruption
 * (duplicated footer, images #77/#78): unit sims replay bytes through reference-VT semantics and
 * CANNOT see a terminal that executes correct bytes wrongly - this can. Pair with the byte tap
 * (NEKO_TRACE_FRAMES=<file>) to separate "our bytes are wrong" from "the terminal is wrong".
 *
 *   bun scripts/e2e-conpty-ghost.ts [path-to-neko-exe]     (default: dist/neko.exe)
 */
import { VirtualTerminal } from "../test/vt.ts";

const exe = process.argv[2] ?? "dist/neko.exe";
const cols = 118, rows = 30;
const vt = new VirtualTerminal(cols, rows);
let raw = "";
let answeredDecrqm = false;
const term = new (Bun as any).Terminal({
  cols, rows,
  data(_t: unknown, chunk: Uint8Array) {
    const s = new TextDecoder().decode(chunk);
    raw += s;
    vt.write(s);
    // Emulate REAL Windows Terminal: answer the DECRQM 2026 query with "supported" (Ps=2, reset).
    // WT does exactly this - a harness that stays silent lets the probe time out and tests a
    // DIFFERENT decision path than the field (that gap hid the probe re-enabling 2026 on WT).
    // Match on the ACCUMULATED stream: ConPTY chunking can split the query across data callbacks.
    if (!answeredDecrqm && raw.includes("\x1b[?2026$p")) { answeredDecrqm = true; term.write("\x1b[?2026;2$y"); }
  },
});
// WT_SESSION emulates running inside Windows Terminal - the env the sync allowlist decides on.
// NEKO_E2E_WT=0 runs the child WITHOUT it (a generic ConPTY host) for A/B triangulation.
const childEnv: Record<string, string | undefined> = { ...process.env, WT_SESSION: "e2e-harness" };
if (process.env.NEKO_E2E_WT === "0") delete childEnv.WT_SESSION;
const proc = Bun.spawn({ cmd: [exe, "--yolo"], cwd: import.meta.dir + "/..", terminal: term, env: childEnv } as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function report(label: string) {
  const text = vt.text();
  const lines = text.split("\n");
  const footers = lines.filter((l) => l.includes("shift+tab to cycle")).length;
  const prompts = lines.filter((l) => /^\s*>/.test(l)).length;
  console.log(`[${label}] footer-copies=${footers} prompt-rows=${prompts}`);
  if (footers > 1 || prompts > 2) {
    console.log("---- GHOST SCREEN ----");
    console.log(lines.filter((l) => l.trim()).join("\n"));
    console.log("----------------------");
  }
  return footers;
}

await sleep(4000);
report("startup");
term.write("xin chao");
await sleep(800);
// INPUT check - the other field class ("renders but typing does nothing"): the echo must be visible.
const typedEcho = vt.text().includes("xin chao");
console.log(`typed-echo: ${typedEcho ? "OK" : "DEAD - keys do not echo"}`);
console.log(`decrqm-query-seen: ${answeredDecrqm}`);
term.write("\r");
let worst = 0;
for (let i = 1; i <= 8; i++) {
  await sleep(2500);
  worst = Math.max(worst, report(`t+${i * 2.5}s`));
}
await sleep(4000);
worst = Math.max(worst, report("settled"));

term.write("\x03"); await sleep(300); term.write("\x03"); // double Ctrl+C exit
await Promise.race([proc.exited, sleep(3000)]);
try { proc.kill(); } catch {}
term.close();
console.log(worst > 1 ? "REPRODUCED: duplicated footer" : "no ghost seen in this run");
if (process.env.NEKO_GHOST_RAW) await Bun.write(process.env.NEKO_GHOST_RAW, raw); // ConPTY's own output stream, for forensics
process.exit(worst > 1 || !typedEcho ? 1 : 0);
