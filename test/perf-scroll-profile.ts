/**
 * Scroll profile: tách bạch 2 nguồn cost trong scroll burst để biết CƠ HỘI cải thiện:
 *  (A) React re-render ở gesture edges (pill mount/unmount, newSince counter)
 *  (B) plain line-diff full-frame repaint (Windows path, hwscroll off)
 * Cách đo: bật NEKO_TRACE_FRAMES để bắt mọi byte, đếm xem burst 15 scroll sinh bao nhiêu
 * full-frame vs band-only, và thời gian giữa writes (gap = event-loop stall).
 */
import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";
import { ChatApp } from "../src/ui/chat.tsx";
import { FrameDiffer } from "../src/ui/frame-diff.ts";
import { installAltScreenGuard } from "../src/ui/altscreen.ts";
import { wrapStdoutForSync } from "../src/ui/sync-stdout.ts";
import { VirtualTerminal } from "./vt.ts";

class FakeTtyOut extends EventEmitter {
  isTTY = true;
  writes: { t: number; bytes: number; head: string }[] = [];
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.writes.push({ t: performance.now(), bytes: str.length, head: str.slice(0, 12).replace(/\x1b/g, "E") });
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
  console.log("=== SCROLL PROFILE (Windows path: hwscroll off) ===\n");
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  const session: any = {
    id: "p", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `dong ${i} noi dung dai mot chut de co nhieu row khi wrap trong viewport 100 cot` })),
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = render(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "p", frameDiffer: differ, preAltDispose, fullscreen: true } as any),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  await tick(900);
  out.writes = [];
  const t0 = performance.now();
  for (let i = 0; i < 15; i++) { stdin.push("\x1b[1;5A"); await tick(12); }
  await tick(500);
  const t1 = performance.now();
  app.unmount();
  await tick(50);

  const w = out.writes;
  const big = w.filter((x) => x.bytes > 200);   // full-frame-ish
  const small = w.filter((x) => x.bytes <= 200); // band/control
  console.log(`total writes: ${w.length}  (window ${Math.round(t1 - t0)}ms)`);
  console.log(`  big (>200B, likely full-frame repaint): ${big.length}  bytes=${big.reduce((a,b)=>a+b.bytes,0)}`);
  console.log(`  small (<=200B, band/control):           ${small.length}  bytes=${small.reduce((a,b)=>a+b.bytes,0)}`);
  // gap analysis: longest stall between consecutive writes = event-loop block
  let maxGap = 0;
  for (let i = 1; i < w.length; i++) { const g = w[i].t - w[i-1].t; if (g > maxGap) maxGap = g; }
  console.log(`  max gap between writes: ${Math.round(maxGap)}ms (event-loop stall indicator)`);
  console.log(`  fps (writes/sec over window): ${Math.round(w.length / ((t1-t0)/1000))}`);
  console.log("\nsample of big writes (heads):");
  big.slice(0, 6).forEach((x) => console.log(`   ${x.bytes}B  head="${x.head}"`));
}
main();
