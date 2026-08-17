/**
 * UX probe (fixed-schedule edition): drive the REAL compiled neko binary in --yolo through a real
 * ConPTY with the user's real provider, snapshot the VT grid on a fixed timeline, and dump
 * everything incrementally so a kill never loses data.
 *
 *   bun scripts/__ux-probe.ts A|B [path-to-neko-binary]
 * Manual tool; delete at the owner's call.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { VirtualTerminal } from "../test/vt.ts";

const mode = (process.argv[2] ?? "A").toUpperCase();
const exe = isAbsolute(process.argv[3] ?? "") ? process.argv[3] : resolve("dist/neko.exe");
const COLS = 120, ROWS = 34;
const OUT = mkdtempSync(join(tmpdir(), `neko-ux-${mode}-`));
const decoder = new TextDecoder();
const t0 = Date.now();
const marks: { t: number; label: string }[] = [];
const timeline: { t: number; bytes: number }[] = [];
const screens: { t: number; label: string; text: string }[] = [];
let raw = "";
const dump = () => {
  writeFileSync(join(OUT, "probe.json"), JSON.stringify({ marks, timeline, screens }, null, 1));
  writeFileSync(join(OUT, "probe.raw"), raw);
};
const mark = (label: string) => { marks.push({ t: Date.now() - t0, label }); dump(); };

const vt = new VirtualTerminal(COLS, ROWS);
// SAFETY: test-built PTY bridge; only this probe constructs it.
const term = new (Bun as any).Terminal({
  cols: COLS, rows: ROWS,
  data(_t: any, chunk: Uint8Array) {
    const s = decoder.decode(chunk);
    raw += s;
    timeline.push({ t: Date.now() - t0, bytes: chunk.byteLength });
    try { vt.write(s); } catch { /* keep the probe alive */ }
  },
});
const workDir = mode === "A"
  ? resolve(".")
  : mkdtempSync(join(tmpdir(), "neko-ux-work-"));
// SAFETY: Bun.Terminal spawn options are typed loosely; this manual tool constructs them.
const proc = Bun.spawn({ cmd: [exe, "--yolo"], cwd: workDir, terminal: term, env: process.env } as any);
mark(`spawn cwd=${workDir}`);

const snap = (label: string) => { screens.push({ t: Date.now() - t0, label, text: vt.text() }); mark(`snap:${label}`); };
const type = async (s: string, ms = 8) => { for (const ch of s) { term.write(ch); await Bun.sleep(ms); } };
const wait = async (ms: number, label: string) => { await Bun.sleep(ms); mark(label); };

const turns = mode === "A"
  ? ["Đọc file README.md rồi tóm tắt repo này bằng 3 gạch đầu dòng ngắn.",
     "Dùng search tìm 'COMPACT_AT' trong src và cho tôi biết giá trị và file nào định nghĩa nó."]
  : ["Tạo file hello.py định nghĩa hàm main in ra dòng 'xin chao neko', chạy nó bằng python rồi cho tôi biết output."];

await wait(2500, "boot");
snap("welcome");
await type(turns[0]);
term.write("\r");
mark("submit turn 1");
for (const [s, label] of [[3_000, "t1+3s"], [6_000, "t1+6s"], [12_000, "t1+12s"], [20_000, "t1+20s"], [30_000, "t1+30s"], [45_000, "t1+45s"]]) {
  await wait(label.endsWith("3s") ? s : s - 2000, label);
  snap(label);
}
if (turns[1]) {
  await type(turns[1]);
  term.write("\r");
  mark("submit turn 2");
  for (const [s, label] of [[3_000, "t2+3s"], [8_000, "t2+8s"], [16_000, "t2+16s"], [28_000, "t2+28s"], [45_000, "t2+45s"]]) {
    await wait(label.endsWith("3s") ? s : s - 2000, label);
    snap(label);
  }
}
await wait(1_000, "cooldown");
snap("pre-exit");
term.write("/exit\r");
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && proc.exitCode === null) await Bun.sleep(200);
if (proc.exitCode === null) { mark("EXIT-DID-NOT-TERMINATE"); proc.kill(); } else mark(`exited code=${proc.exitCode}`);
await Bun.sleep(800);
snap("post-exit");
console.log("OUT:", OUT);
for (const m of marks) console.log(String(m.t).padStart(7), m.label);
console.log("chunks:", timeline.length, "KB:", Math.round(raw.length / 1024));
process.exit(0);
