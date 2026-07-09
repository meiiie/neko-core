/**
 * LATENCY map — the metric users ACTUALLY feel. Codex's key insight: bytes/writes are throughput
 * proxies, but perceived smoothness = LATENCY (time from action to first visible response).
 * Measures p50/p95 of:
 *  1. keystroke latency: key pushed -> caret/echo paints
 *  2. submit->first-token latency: Enter -> first streamed char visible
 *  3. startup->first-input latency: render() call -> prompt interactive (caret blink starts)
 *  4. scroll first-response latency: Ctrl+Up -> viewport moves
 *  5. large paste -> stable render latency
 *
 * Latency budget: <100ms = instant, 100-300ms = optimal, >400ms = sluggish (expert thresholds).
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
  writes: { t: number; bytes: number }[] = [];
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.writes.push({ t: performance.now(), bytes: str.length });
    this.vt.write(str);
    return true;
  }
  setSize(c: number, r: number) { this.columns = c; this.rows = r; this.vt.resize(c, r); this.emit("resize"); }
  /** time until the NEXT write after t0 (latency to first paint) */
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

function streamingProvider(firstTokMs = 60) {
  return {
    complete: async (_msgs: any, _tools: any, onDelta?: (t: string, k?: string) => void) => {
      await tick(firstTokMs);
      onDelta?.("x ", "content");
      await tick(2000);
      return { content: null, tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: 1 } };
    },
  };
}

async function main() {
  console.log("# NEKO LATENCY MAP (Codex insight: measure perceived latency, not bytes)\n");
  console.log("| metric | p50 (ms) | p95 (ms) | verdict (<100 instant / >400 sluggish) |");
  console.log("|---|---|---|---|");

  // 1. keystroke latency: push a key, measure ms until next paint
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider: { complete: async () => ({ content: "ok", tool_calls: [] }) }, sessionId: "k", frameDiffer: differ, preAltDispose: installAltScreenGuard(out as any, { mouse: false }), fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(900);
    const lats: number[] = [];
    for (let i = 0; i < 20; i++) {
      await tick(120); // let it settle between keys
      out.writes = [];
      const t0 = performance.now();
      stdin.push("a");
      await tick(80); // wait for paint
      const l = out.latencyToNextWrite(t0);
      if (l >= 0) lats.push(l);
    }
    app.unmount(); await tick(40);
    const p50 = pct(lats, 0.5), p95 = pct(lats, 0.95);
    console.log(`| keystroke->paint | ${Math.round(p50)} | ${Math.round(p95)} | ${p95 < 100 ? "instant" : p95 < 400 ? "ok" : "sluggish"} |`);
  }
  // 2. submit -> first token
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider: streamingProvider(60), sessionId: "s", frameDiffer: differ, preAltDispose: installAltScreenGuard(out as any, { mouse: false }), fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(900);
    out.writes = [];
    const t0 = performance.now();
    stdin.push("hi\r");
    await tick(400);
    const l = out.latencyToNextWrite(t0); // first paint after submit (the "thinking" line)
    app.unmount(); await tick(40);
    console.log(`| submit->first-paint | ${Math.round(l)} | ${Math.round(l)} | ${l < 100 ? "instant" : l < 400 ? "ok" : "sluggish"} |`);
  }
  // 3. startup -> first input interactive (time from render() to first caret blink write)
  {
    const lats: number[] = [];
    for (let run = 0; run < 3; run++) {
      const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
      const stdin = new FakeStdin(); const differ = new FrameDiffer();
      const t0 = performance.now();
      out.writes = [];
      const app = render(
        React.createElement(ChatApp as any, { yolo: true, provider: { complete: async () => ({ content: "ok", tool_calls: [] }) }, sessionId: "st", frameDiffer: differ, preAltDispose: installAltScreenGuard(out as any, { mouse: false }), fullscreen: true } as any),
        { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
      );
      await tick(900); // wait for first blink
      app.unmount(); await tick(40);
      // first write is the startup paint; measure t0->first write
      if (out.writes.length) lats.push(out.writes[0].t - t0);
    }
    const p50 = pct(lats, 0.5);
    console.log(`| startup->first-paint | ${Math.round(p50)} | ${Math.round(p50)} | ${p50 < 100 ? "instant" : p50 < 400 ? "ok" : "sluggish"} |`);
  }
  // 4. scroll first-response latency: Ctrl+Up -> viewport moves
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const session: any = {
      id: "sc", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
      messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `dong ${i} noi dung dai de wrap trong 100 cot` })),
    };
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider: { complete: async () => ({ content: "ok", tool_calls: [] }) }, resumedSession: session, sessionId: "sc", frameDiffer: differ, preAltDispose: installAltScreenGuard(out as any, { mouse: false }), fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(900);
    const lats: number[] = [];
    for (let i = 0; i < 12; i++) {
      await tick(120);
      out.writes = [];
      const t0 = performance.now();
      stdin.push("\x1b[1;5A");
      await tick(90);
      const l = out.latencyToNextWrite(t0);
      if (l >= 0) lats.push(l);
    }
    app.unmount(); await tick(40);
    const p50 = pct(lats, 0.5), p95 = pct(lats, 0.95);
    console.log(`| scroll hop->paint | ${Math.round(p50)} | ${Math.round(p95)} | ${p95 < 100 ? "instant" : p95 < 400 ? "ok" : "sluggish"} |`);
  }
  // 5. large paste -> stable render
  {
    const vt = new VirtualTerminal(100, 30); const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin(); const differ = new FrameDiffer();
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider: { complete: async () => ({ content: "ok", tool_calls: [] }) }, sessionId: "p", frameDiffer: differ, preAltDispose: installAltScreenGuard(out as any, { mouse: false }), fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(900);
    out.writes = [];
    const t0 = performance.now();
    stdin.push("y".repeat(3000));
    // poll until writes settle (gap > 80ms)
    let last = 0;
    for (let i = 0; i < 50; i++) {
      await tick(30);
      const latest = out.writes.length ? out.writes[out.writes.length - 1].t : t0;
      if (out.writes.length && performance.now() - latest > 80) { last = latest; break; }
      last = latest;
    }
    app.unmount(); await tick(40);
    const l = last - t0;
    console.log(`| paste-3k->stable | ${Math.round(l)} | ${Math.round(l)} | ${l < 100 ? "instant" : l < 400 ? "ok" : "sluggish"} |`);
  }
}
main();
