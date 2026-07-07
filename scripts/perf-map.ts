/**
 * COMPREHENSIVE perf map — measures EVERY hot path in neko's UI, not just the two reported
 * symptoms. Produces a table of {scenario: bytes, writes, ms, fps} so we can RANK bottleneck
 * severity and pick the top 3 to fix. Reuses the fullscreen-sim harness (real ChatApp+Differ+sync).
 *
 * Scenarios:
 *  1. idle baseline        (nothing happening — noise floor)
 *  2. single keystroke     (caret blink / input echo — responsiveness)
 *  3. scroll burst 15      (the reported lag)
 *  4. stream tokens x40    (LLM reply streaming — the other core interaction)
 *  5. big transcript 500   (does render scale with history?)
 *  6. paste large input    (multibyte paste echo)
 *  7. rapid commands       (slash menu open/close churn)
 * Run: bun scripts/perf-map.ts   (prints a markdown-ish table)
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
  frames: { t: number; bytes: number }[] = [];
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.frames.push({ t: performance.now(), bytes: str.length });
    this.vt.write(str);
    return true;
  }
  reset() { this.frames = []; }
  setSize(c: number, r: number) { this.columns = c; this.rows = r; this.vt.resize(c, r); this.emit("resize"); }
  // count writes/bytes within the last window
  window(): { writes: number; bytes: number } {
    return { writes: this.frames.length, bytes: this.frames.reduce((a, f) => a + f.bytes, 0) };
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private d: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read() { const x = this.d; this.d = null; return x; }
  push(s: string) { this.d = s; this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSession(n: number, long = false) {
  return {
    id: "m", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: n }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: long ? `dong tin nhan thu ${i} noi dung dai de tao nhieu row khi wrap trong ${100} cot terminal day` : `msg ${i}`,
    })),
  };
}

// A provider that STREAMS tokens via onDelta so we can measure the streaming path.
function streamingProvider(ntok: number) {
  return {
    complete: async (_msgs: any, _tools: any, onDelta?: (t: string, k?: string) => void) => {
      const words = "mot hai ba bon nam sau bay tam chin muoi mot cai token streaming xuat hien tung mot ".split(" ");
      for (let i = 0; i < ntok; i++) {
        onDelta?.(words[i % words.length] + " ", "content");
        await tick(12); // ~ realistic token cadence
      }
      return { content: null, tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: ntok } };
    },
  };
}

async function mount(out: FakeTtyOut, stdin: FakeStdin, differ: FrameDiffer, session: any, provider: any) {
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = render(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "m", frameDiffer: differ, preAltDispose, fullscreen: true } as any),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  await tick(900);
  return app;
}

function row(label: string, w: { writes: number; bytes: number }, ms: number): string {
  const fps = ms > 0 ? Math.round(w.writes / (ms / 1000)) : 0;
  return `| ${label.padEnd(26)} | ${String(w.writes).padStart(6)} | ${String(w.bytes).padStart(8)} | ${String(Math.round(ms)).padStart(5)} | ${String(fps).padStart(4)} |`;
}

async function main() {
  console.log("# NEKO PERF MAP (Windows path: hwscroll off, sync on)\n");
  console.log("| scenario                  | writes |    bytes |    ms |  fps |");
  console.log("|---------------------------|--------|----------|-------|------|");

  // 1. idle
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(8), { complete: async () => ({ content: "ok", tool_calls: [] }) });
    out.reset(); const t0 = performance.now(); await tick(600); const t1 = performance.now();
    console.log(row("1 idle (8 msg)", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  // 2. single keystroke echo (repeated)
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(8), { complete: async () => ({ content: "ok", tool_calls: [] }) });
    out.reset(); const t0 = performance.now();
    for (let i = 0; i < 15; i++) { stdin.push("a"); await tick(60); }
    const t1 = performance.now();
    console.log(row("2 keystroke x15 (short input)", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  // 3. scroll burst (reported)
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(200, true), { complete: async () => ({ content: "ok", tool_calls: [] }) });
    out.reset(); const t0 = performance.now();
    for (let i = 0; i < 15; i++) { stdin.push("\x1b[1;5A"); await tick(12); }
    await tick(400); const t1 = performance.now();
    console.log(row("3 scroll burst x15 (200 msg)", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  // 4. streaming tokens
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(4), streamingProvider(40));
    out.reset(); const t0 = performance.now();
    stdin.push("hi\r");
    await tick(900); // ~40 tokens at ~12ms each
    const t1 = performance.now();
    console.log(row("4 stream 40 tokens", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  // 5. big transcript render (history scaling)
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(500, true), { complete: async () => ({ content: "ok", tool_calls: [] }) });
    out.reset(); const t0 = performance.now(); await tick(700); const t1 = performance.now();
    console.log(row("5 startup render (500 msg)", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  // 6. paste large input then type
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(4), { complete: async () => ({ content: "ok", tool_calls: [] }) });
    stdin.push("x".repeat(2000)); await tick(300); out.reset();
    const t0 = performance.now();
    for (let i = 0; i < 15; i++) { stdin.push("a"); await tick(50); }
    const t1 = performance.now();
    console.log(row("6 type x15 (2k-char input)", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  // 7. slash menu churn
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = await mount(out, stdin, differ, makeSession(4), { complete: async () => ({ content: "ok", tool_calls: [] }) });
    out.reset(); const t0 = performance.now();
    for (let i = 0; i < 8; i++) { stdin.push("/"); await tick(90); stdin.push("\x1b"); await tick(90); }
    const t1 = performance.now();
    console.log(row("7 slash menu open/close x8", out.window(), t1 - t0));
    app.unmount(); await tick(40);
  }
  console.log("\n# ranking by bytes (higher = more render cost):");
}
main();
