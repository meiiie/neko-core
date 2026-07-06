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
const term = new (Bun as any).Terminal({
  cols, rows,
  data(_t: unknown, chunk: Uint8Array) { const s = new TextDecoder().decode(chunk); raw += s; vt.write(s); },
});
const proc = Bun.spawn({ cmd: [exe, "--yolo"], cwd: import.meta.dir + "/..", terminal: term, env: { ...process.env } } as any);
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
process.exit(worst > 1 ? 1 : 0);
