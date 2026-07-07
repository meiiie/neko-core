/**
 * Throughput under load — the OTHER half of perceived smoothness. Latency-in-isolation is instant,
 * but when a BACKGROUND task runs (MCP init, a long bash, file indexing), the event loop contends
 * with rendering. This simulates a sustained busy agent (setInterval churn simulating background
 * work) and measures whether keystroke/scroll latency degrades. Also reads the resolved FPS cap.
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
  writes: { t: number; bytes: number }[] = [];
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.writes.push({ t: performance.now(), bytes: str.length });
    this.vt.write(str);
    return true;
  }
  setSize(c: number, r: number) { this.columns = c; this.rows = r; this.vt.resize(c, r); this.emit("resize"); }
  latencyToNextWrite(t0: number): number {
    const next = this.writes.find((w) => w.t >= t0);
    return next ? next.t - t0 : -1;
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private d: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read() { const x = this.d; this.d = null; return x; }
  push(s: string) { this.d = s; this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? -1; };

async function main() {
  console.log("# THROUGHPUT UNDER LOAD (does background work degrade UI latency?)\n");

  // Read the resolved FPS cap
  const { resolveUiFps } = await import("../src/adapters/display.ts");
  let fpsCap = "?";
  try { fpsCap = String(resolveUiFps({ mode: "auto" }).fps); } catch { try { fpsCap = String(resolveUiFps().fps); } catch {} }
  console.log(`resolved UI fps cap: ${fpsCap}\n`);

  // Helper to mount a fresh app
  async function fresh(provider: any) {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider, sessionId: "l", frameDiffer: differ, preAltDispose: installAltScreenGuard(out as any, { mouse: false }), fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(900);
    return { app, out, stdin };
  }
  const nop = { complete: async () => ({ content: "ok", tool_calls: [] }) };

  console.log("| scenario | keystroke p50 | p95 | scroll p50 | p95 |");
  console.log("|---|---|---|---|---|");

  function keyLatency(out: FakeTtyOut, stdin: FakeStdin): Promise<number> {
    return new Promise(async (resolve) => {
      await tick(110);
      out.writes = [];
      const t0 = performance.now();
      stdin.push("a");
      await tick(70);
      resolve(out.latencyToNextWrite(t0));
    });
  }
  function scrollLatency(out: FakeTtyOut, stdin: FakeStdin): Promise<number> {
    return new Promise(async (resolve) => {
      await tick(110);
      out.writes = [];
      const t0 = performance.now();
      stdin.push("\x1b[1;5A");
      await tick(80);
      resolve(out.latencyToNextWrite(t0));
    });
  }

  // A. idle baseline
  {
    const { app, out, stdin } = await fresh(nop);
    const keys: number[] = [], scs: number[] = [];
    for (let i = 0; i < 12; i++) { keys.push(await keyLatency(out, stdin)); scs.push(await scrollLatency(out, stdin)); }
    app.unmount(); await tick(40);
    console.log(`| idle | ${Math.round(pct(keys, .5))} | ${Math.round(pct(keys, .95))} | ${Math.round(pct(scs, .5))} | ${Math.round(pct(scs, .95))} |`);
  }
  // B. under light background load (20ms busy every 50ms = ~40% CPU)
  {
    const { app, out, stdin } = await fresh(nop);
    const handle = setInterval(() => { const t0 = Date.now(); while (Date.now() - t0 < 20) {} }, 50);
    const keys: number[] = [], scs: number[] = [];
    for (let i = 0; i < 12; i++) { keys.push(await keyLatency(out, stdin)); scs.push(await scrollLatency(out, stdin)); }
    clearInterval(handle);
    app.unmount(); await tick(40);
    console.log(`| bg-load ~40% CPU | ${Math.round(pct(keys, .5))} | ${Math.round(pct(keys, .95))} | ${Math.round(pct(scs, .5))} | ${Math.round(pct(scs, .95))} |`);
  }
  // C. under heavy background load (40ms busy every 50ms = ~80% CPU)
  {
    const { app, out, stdin } = await fresh(nop);
    const handle = setInterval(() => { const t0 = Date.now(); while (Date.now() - t0 < 40) {} }, 50);
    const keys: number[] = [], scs: number[] = [];
    for (let i = 0; i < 12; i++) { keys.push(await keyLatency(out, stdin)); scs.push(await scrollLatency(out, stdin)); }
    clearInterval(handle);
    app.unmount(); await tick(40);
    console.log(`| bg-load ~80% CPU | ${Math.round(pct(keys, .5))} | ${Math.round(pct(keys, .95))} | ${Math.round(pct(scs, .5))} | ${Math.round(pct(scs, .95))} |`);
  }
}
main();
