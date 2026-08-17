/** Multi-purpose capability probe: 3 real tasks (Excel create, Excel analyze, web search) against
 * the compiled binary with the user's real provider. Fixed schedule, incremental dumps. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { VirtualTerminal } from "../test/vt.ts";

const exe = isAbsolute(process.argv[2] ?? "") ? process.argv[2] : resolve("dist/neko.exe");
const COLS = 120, ROWS = 34;
const OUT = mkdtempSync(join(tmpdir(), "neko-multi-probe-"));
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
    try { vt.write(s); } catch { /* keep alive */ }
  },
});
const workDir = mkdtempSync(join(tmpdir(), "neko-multi-work-"));
// NOTE: no --yolo needed anymore: auto is the default mode as of 0.24.9 - this probe proves it.
// SAFETY: Bun.Terminal spawn options are typed loosely; this manual tool constructs them.
const proc = Bun.spawn({ cmd: [exe], cwd: workDir, terminal: term, env: process.env } as any);
mark(`spawn cwd=${workDir}`);

const snap = (label: string) => { screens.push({ t: Date.now() - t0, label, text: vt.text() }); mark(`snap:${label}`); };
const type = async (s: string, ms = 8) => { for (const ch of s) { term.write(ch); await Bun.sleep(ms); } };

const turns: Array<{ text: string; waitMs: number }> = [
  { text: "Tao file du_lich.xlsx co sheet KhoanChi voi cot STT, Hang muc, So tien (nghin dong), 8 hang muc du lich Da Nang hop ly, dong cuoi Tong cong dung CONG THUC SUM. Luu roi doc lai xac minh tong bang tool.", waitMs: 150_000 },
  { text: "Doc du_lich.xlsx: hang muc ton nhat chiem bao nhieu phan tram tong? Sap xep giam dan va cho bang so lieu.", waitMs: 90_000 },
  { text: "Dung web_search tim 'thoi tiet Da Nang hom nay' va tom tat ngan 3 dong.", waitMs: 75_000 },
];

await Bun.sleep(2500);
snap("welcome");
for (const [i, turn] of turns.entries()) {
  await type(turn.text);
  term.write("\r");
  mark(`submit turn ${i + 1}`);
  // SAFETY: fixed schedule literal - the tuple shape is exactly what this loop destructures.
  for (const [s, label] of [[8_000, "early"], [Math.floor(turn.waitMs / 2), "mid"], [turn.waitMs, "done"]] as Array<[number, string]>) {
    await Bun.sleep(i === 0 && label === "early" ? s - 2500 : s - (label === "early" ? 0 : label === "mid" ? 8_000 : Math.floor(turn.waitMs / 2)));
    snap(`t${i + 1}:${label}`);
  }
}
term.write("/exit\r");
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && proc.exitCode === null) await Bun.sleep(200);
if (proc.exitCode === null) { mark("EXIT-DID-NOT-TERMINATE"); proc.kill(); } else mark(`exited code=${proc.exitCode}`);
console.log("OUT:", OUT);
console.log("WORKDIR:", workDir);
for (const m of marks) console.log(String(m.t).padStart(7), m.label);
console.log("KB:", Math.round(raw.length / 1024));
process.exit(0);
