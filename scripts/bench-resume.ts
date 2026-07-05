/**
 * Measure the /resume flow end-to-end with a REALISTIC bloated store: open-picker latency, per-keystroke
 * filter latency, pick-a-large-session replay wall, and post-resume input latency. Run:
 *   bun scripts/bench-resume.ts
 */
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import React from "react";

const home = join(tmpdir(), `neko-bench-resume-${process.pid}`);
mkdirSync(join(home, ".neko-core", "sessions"), { recursive: true });
process.env.USERPROFILE = home; process.env.HOME = home;

const N_SESSIONS = 1500;
for (let i = 0; i < N_SESSIONS; i++) {
  const id = `2026${String(i).padStart(4, "0")}-000000-${String(i % 1000).padStart(3, "0")}`;
  writeFileSync(join(home, ".neko-core", "sessions", `${id}.json`), JSON.stringify({
    id, createdAt: new Date(Date.now() - i * 60e3).toISOString(), updatedAt: new Date(Date.now() - i * 60e3).toISOString(),
    cwd: process.cwd(), model: "m",
    // ~40KB per file - matches the owner's REAL store (12-84KB sessions in the picker screenshot).
    messages: [{ role: "user", content: `phien thu ${i} noi ve chu de ${i % 7}` }, { role: "assistant", content: "x".repeat(40_000) }],
  }));
}
// One LARGE session to resume (400 messages with markdown).
const bigId = "20269999-999999-999";
writeFileSync(join(home, ".neko-core", "sessions", `${bigId}.json`), JSON.stringify({
  id: bigId, createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() + 60e3).toISOString(), cwd: process.cwd(), model: "m",
  messages: Array.from({ length: 400 }, (_, i) => (i % 2 === 0
    ? { role: "user", content: `cau hoi so ${i}` }
    : { role: "assistant", content: `**Tra loi ${i}** voi vai *markdown*:\n- y mot\n- y hai\n\ncode: \`x${i}\`` })),
}));

const { ChatApp } = await import("../src/ui/chat.tsx");
const { FrameDiffer } = await import("../src/ui/frame-diff.ts");
const { installAltScreenGuard } = await import("../src/ui/altscreen.ts");
const { wrapStdoutForSync } = await import("../src/ui/sync-stdout.ts");
const { VirtualTerminal } = await import("../test/vt.ts");
const { listSessionMetas } = await import("../src/adapters/session.ts");

class Out extends EventEmitter { isTTY = true; constructor(public columns: number, public rows: number, private vt: any) { super(); } write(s: string) { this.vt.write(String(s)); return true; } }
class In extends EventEmitter { isTTY = true; private data: string | null = null; setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {} read() { const d = this.data; this.data = null; return d; } push(s: string) { this.data = s; this.emit("readable"); this.emit("data", s); } }
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (t0: number) => (performance.now() - t0).toFixed(0) + "ms";

// Cold + warm index cost (the adapter-level part of "open the picker").
let t0 = performance.now();
listSessionMetas();
console.log(`listSessionMetas COLD (index build, ${N_SESSIONS + 1} x 40KB files): ${ms(t0)}`);
t0 = performance.now();
listSessionMetas();
console.log(`listSessionMetas WARM (mtime+size cache):                 ${ms(t0)}`);
// The UPGRADE path: a legacy index (entries without fsize) must MIGRATE without re-parsing.
{
  const idxPath = join(home, ".neko-core", "sessions", ".index.json");
  const { readFileSync } = await import("node:fs");
  const idx = JSON.parse(readFileSync(idxPath, "utf-8"));
  for (const k of Object.keys(idx.metas)) delete idx.metas[k].fsize; // simulate the pre-fsize index
  writeFileSync(idxPath, JSON.stringify(idx));
  t0 = performance.now();
  listSessionMetas();
  console.log(`listSessionMetas UPGRADE (legacy index, fsize migration):  ${ms(t0)}`);
}

const vt = new VirtualTerminal(110, 32);
const out = new Out(110, 32, vt);
const stdin = new In();
const differ = new FrameDiffer();
process.env.NEKO_FULLSCREEN = "1";
const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
const app = render(
  React.createElement(ChatApp as any, { yolo: true, provider: { complete: async () => ({ content: "", tool_calls: [] }) }, sessionId: "bench", frameDiffer: differ, preAltDispose }),
  { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
);
await tick(400);

// Open the picker.
t0 = performance.now();
stdin.push("/resume"); await tick(30); stdin.push("\r");
for (let i = 0; i < 200 && !vt.text().includes("Resume session"); i++) await tick(10);
console.log(`/resume -> picker visible: ${ms(t0)}`);

// Type-to-filter latency (worst case: each key refilters 1501 items).
t0 = performance.now();
for (const ch of "phien") { stdin.push(ch); await tick(5); }
for (let i = 0; i < 100 && !vt.text().includes("search: phien"); i++) await tick(10);
console.log(`5 filter keystrokes over ${N_SESSIONS + 1} items -> painted: ${ms(t0)}`);

// Clear the filter, pick the big session (newest = first) -> replay 400 messages.
for (let i = 0; i < 5; i++) { stdin.push("\x7f"); await tick(5); } // backspaces
await tick(60);
t0 = performance.now();
stdin.push("\r");
const snap = (label: string) => {
  const rows = vt.lines().filter((l: string) => l.trim());
  console.log(`--- ${label}: ${rows.length} nonblank rows; tail3: ${rows.slice(-6, -3).map((r: string) => JSON.stringify(r.slice(0, 60))).join(" | ")}`);
};
await tick(100); snap("+100ms");
await tick(400); snap("+500ms");
await tick(500); snap("+1s");
await tick(2000); snap("+3s");
for (let i = 0; i < 400 && !vt.text().includes("Tra loi 399"); i++) await tick(10);
console.log(`pick -> the TAIL of the 400-message replay visible: ${ms(t0)}`);

// Post-resume typing latency while the warmer runs.
await tick(50);
t0 = performance.now();
stdin.push("x");
for (let i = 0; i < 200 && !vt.text().includes("> x"); i++) await tick(5);
console.log(`first keystroke AFTER resume echoed: ${ms(t0)}`);
await tick(1500); // let the warmer chew
t0 = performance.now();
stdin.push("y");
for (let i = 0; i < 200 && !vt.text().includes("> xy"); i++) await tick(5);
console.log(`keystroke 1.5s after resume (warmer running) echoed: ${ms(t0)}`);

app.unmount();
await tick(50);
rmSync(home, { recursive: true, force: true });
process.exit(0);
