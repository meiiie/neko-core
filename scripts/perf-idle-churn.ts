/**
 * Idle churn probe: does the app re-render while NOTHING is happening (no typing, no streaming)?
 * The caret is a native terminal cursor, so its blink needs ZERO app writes. Any UI-sized write is
 * wasted CPU/battery + a subtle contributor to the "feels laggy" perception.
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
  frames: { t: number; bytes: number; head: string }[] = [];
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  write(s: string): boolean {
    const str = String(s);
    this.frames.push({ t: performance.now(), bytes: str.length, head: str.slice(0, 20).replace(/\x1b/g, "E") });
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
  console.log("=== IDLE CHURN PROBE (3s, nothing happens) ===\n");
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  const session: any = {
    id: "idle", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = render(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "idle", frameDiffer: differ, preAltDispose, fullscreen: true } as any),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  await tick(1000); // settle
  out.frames = [];
  const t0 = performance.now();
  await tick(3000); // 3 seconds of pure idle
  const t1 = performance.now();
  const f = [...out.frames]; // freeze the measurement BEFORE teardown restores the terminal
  app.unmount();
  await tick(40);

  console.log(`idle window: ${Math.round(t1 - t0)}ms`);
  console.log(`writes: ${f.length}`);
  console.log(`total bytes: ${f.reduce((a, x) => a + x.bytes, 0)}`);
  console.log(`intervals between writes (ms):`);
  const intervals: number[] = [];
  for (let i = 1; i < f.length; i++) intervals.push(Math.round(f[i].t - f[i - 1].t));
  if (intervals.length) {
    console.log(`  count=${intervals.length}  median≈${intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]}ms  min=${intervals[0]}  max=${intervals[intervals.length - 1]}`);
  }
  console.log(`\nsample writes:`);
  f.slice(0, 8).forEach((x, i) => console.log(`  ${i + 1}. ${x.bytes}B  head="${x.head}"`));
  // Tiny control writes are harmless; anything UI-sized is suspicious.
  const tiny = f.filter((x) => x.bytes <= 100);
  const heavy = f.filter((x) => x.bytes > 100);
  console.log(`\ntiny control writes (<=100B):        ${tiny.length}`);
  console.log(`heavy writes (>100B, investigate):   ${heavy.length}`);
  console.log(f.length === 0 ? "=> PASS: fully idle; the terminal owns caret blinking" : "=> inspect the writes above");
}
main();
