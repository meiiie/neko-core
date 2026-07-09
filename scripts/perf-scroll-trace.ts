/**
 * Scroll TRACE: capture FrameDiffer events to see EXACTLY which differ path each scroll hop takes
 * (hw-scroll / repaintBand / diff / resync / passthru). This tells us whether the 17 big writes are
 * imperative band repaints (cheap, just wide) or React-driven full-frame diffs (the expensive churn).
 */
import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";
import { ChatApp } from "../src/ui/chat.tsx";
import { FrameDiffer } from "../src/ui/frame-diff.ts";
import { installAltScreenGuard } from "../src/ui/altscreen.ts";
import { wrapStdoutForSync } from "../src/ui/sync-stdout.ts";
import { VirtualTerminal } from "../test/vt.ts";

class FakeTtyOut extends EventEmitter {
  isTTY = true;
  frames: { t: number; bytes: number; head: string } = [];
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.frames.push({ t: performance.now(), bytes: str.length, head: str.slice(0, 16).replace(/\x1b/g, "E").replace(/\r/g, "") });
    this.vt.write(str);
    return true;
  }
  setSize(c: number, r: number) { this.columns = c; this.rows = r; this.vt.resize(c, r); this.emit("resize"); }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private d: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read() { const x = this.d; this.d = null; return x; }
  push(s: string) { this.d = s; this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const TRACE = "trace-scroll.ndjson";
  // clear trace
  const { writeFileSync } = await import("node:fs");
  writeFileSync(TRACE, "");

  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  const session: any = {
    id: "t", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `dong ${i} noi dung dai de wrap trong 100 cot terminal` })),
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = render(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "t", frameDiffer: differ, preAltDispose, fullscreen: true } as any),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  await tick(900);
  out.frames = [];
  for (let i = 0; i < 15; i++) { stdin.push("\x1b[1;5A"); await tick(15); }
  await tick(400);
  app.unmount();
  await tick(40);

  // Analyze the differ trace
  const trace = (await import("node:fs")).readFileSync(TRACE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const evs: Record<string, number> = {};
  for (const e of trace) evs[e.ev] = (evs[e.ev] ?? 0) + 1;
  console.log("=== DIFFER EVENTS during 15-hop scroll ===");
  for (const [k, v] of Object.entries(evs).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log("\n=== STDOUT WRITES during scroll (sorted by bytes desc) ===");
  const sorted = [...out.frames].sort((a, b) => b.bytes - a.bytes);
  console.log(`total writes: ${out.frames.length}, total bytes: ${out.frames.reduce((a, f) => a + f.bytes, 0)}`);
  console.log("top 6 writes:");
  sorted.slice(0, 6).forEach((f, i) => console.log(`  ${i + 1}. ${f.bytes}B  head="${f.head}"`));
  // correlate: how many writes are big (>500B) vs small
  const big = out.frames.filter((f) => f.bytes > 500);
  const small = out.frames.filter((f) => f.bytes <= 500);
  console.log(`\nbig writes (>500B): ${big.length}  total ${big.reduce((a, f) => a + f.bytes, 0)}B`);
  console.log(`small writes (<=500B): ${small.length}  total ${small.reduce((a, f) => a + f.bytes, 0)}B`);
}
main();
