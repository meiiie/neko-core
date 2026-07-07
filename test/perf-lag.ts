/**
 * Perf harness — measures the TWO reported lag symptoms under the real ChatApp, NOT a guess:
 *   1) SCROLL lag: a burst of wheel events on a long transcript -> measure renders/bytes/wall time
 *   2) LONG-INPUT lag: typing while the input buffer is huge -> measure renders/bytes/wall time
 *
 * This reuses the exact fullscreen-sim harness (real ChatApp + FrameDiffer + sync-stdout + VirtualTerminal)
 * so the bytes path is identical to production. It INSTRUMENTS FakeTtyOut to count writes + bytes + the
 * time between them, and taps ChatApp's render via Ink's onRender, so we get objective before/after numbers
 * for any future fix. Run: bun test/perf-lag.ts
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
  writes = 0; bytes = 0;
  frames: { t: number; bytes: number }[] = []; // timestamp + size of every write
  all = "";
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.writes++;
    this.bytes += str.length;
    this.frames.push({ t: performance.now(), bytes: str.length });
    this.all += str;
    this.vt.write(str);
    return true;
  }
  setSize(cols: number, rows: number): void { this.columns = cols; this.rows = rows; this.vt.resize(cols, rows); this.emit("resize"); }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private data: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read(): string | null { const d = this.data; this.data = null; return d; }
  push(s: string): void { this.data = s; this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSession(nMsg: number) {
  return {
    id: "perf", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: nMsg }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `dong tin nhan thu ${i} cua mot transcript rat dai de do cuon lag` })),
  };
}

interface Probe { label: string; writes: number; bytes: number; ms: number; fps: number }
async function probe(label: string, out: FakeTtyOut, t0: number, t1: number): Promise<Probe> {
  const writes = out.writes;
  // count writes inside [t0,t1]
  const inWin = out.frames.filter((f) => f.t >= t0 && f.t <= t1);
  const bytes = inWin.reduce((a, f) => a + f.bytes, 0);
  const ms = t1 - t0;
  return { label, writes: inWin.length, bytes, ms: Math.round(ms), fps: inWin.length > 0 ? Math.round(inWin.length / (ms / 1000)) : 0 };
}

async function main() {
  console.log("=== NEKO PERF HARNESS: scroll + long-input lag ===\n");

  // ---- SCROLL lag: long transcript, burst of wheel-up then wheel-down ----
  {
    const vt = new VirtualTerminal(100, 30);
    const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin();
    const differ = new FrameDiffer();
    const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
    const session = makeSession(200); // long transcript
    const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "perf", frameDiffer: differ, preAltDispose, fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(800); // startup paint
    out.writes = 0; out.frames = []; out.bytes = 0;
    const t0 = performance.now();
    // burst of Ctrl+Up (line-scroll) — \x1b[1;5A is the raw-mode encoding of Ctrl+UpArrow
    for (let i = 0; i < 15; i++) { stdin.push("\x1b[1;5A"); await tick(10); }
    await tick(400); // settle
    const t1 = performance.now();
    const up = await probe("ctrl-up burst (15 ev)", out, t0, t1);
    out.writes = 0; out.frames = [];
    const t2 = performance.now();
    for (let i = 0; i < 15; i++) { stdin.push("\x1b[1;5B"); await tick(10); }
    await tick(400);
    const t3 = performance.now();
    const down = await probe("ctrl-down burst (15 ev)", out, t2, t3);
    app.unmount();
    await tick(50);
    console.log("--- SCROLL lag (200-line transcript) ---");
    console.log(up);
    console.log(down);
    console.log("baseline: differ on = each hop should be sub-ms band repaint, NOT full frame\n");
  }

  // ---- LONG-INPUT lag: type into a huge input buffer ----
  {
    const vt = new VirtualTerminal(100, 30);
    const out = new FakeTtyOut(100, 30, vt);
    const stdin = new FakeStdin();
    const differ = new FrameDiffer();
    const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
    const session: any = { id: "in", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [] };
    const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "in", frameDiffer: differ, preAltDispose, fullscreen: true } as any),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
    );
    await tick(800);
    // First fill the input with a LOT of text (paste a long string char by char would be slow; push a blob)
    const longText = "x".repeat(50);
    stdin.push(longText); // paste
    await tick(300);
    out.writes = 0; out.frames = [];
    const t0 = performance.now();
    // now type 20 more chars one at a time — each triggers a re-render
    for (let i = 0; i < 20; i++) { stdin.push("a"); await tick(8); }
    await tick(300);
    const t1 = performance.now();
    const shortInput = await probe("type 20 chars @ 50-char input", out, t0, t1);

    // grow to a VERY long input (multiline pasted)
    stdin.push("y".repeat(2000));
    await tick(300);
    out.writes = 0; out.frames = [];
    const t2 = performance.now();
    for (let i = 0; i < 20; i++) { stdin.push("a"); await tick(8); }
    await tick(300);
    const t3 = performance.now();
    const longInput = await probe("type 20 chars @ 2050-char input", out, t2, t3);
    app.unmount();
    await tick(50);
    console.log("--- LONG-INPUT lag ---");
    console.log(shortInput);
    console.log(longInput);
    console.log("signal: if longInput bytes/writes >> shortInput, input render is O(n) in buffer size\n");
  }
  console.log("=== DONE ===");
}
main();
