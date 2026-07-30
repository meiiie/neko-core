/**
 * Reading while Neko works: with the transcript scrolled away, the streaming tail is BELOW the
 * viewport, so per-delta UI syncs are invisible work - and at 25fps they saturated the event loop
 * and wheel input queued behind them ("scrolling lags while Neko is working", field report
 * 2026-07-28). The pump now drops to ~3fps while scrolled and snaps current on re-pin. This sim
 * locks the mechanism by measuring terminal WRITES during identical streaming windows.
 */
import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { render } from "ink";
import React from "react";

import { ChatApp } from "../src/ui/chat.tsx";
import { FrameDiffer } from "../src/ui/frame-diff.ts";
import { installAltScreenGuard } from "../src/ui/altscreen.ts";
import { wrapStdoutForSync } from "../src/ui/sync-stdout.ts";
import { VirtualTerminal } from "./vt.ts";

class FakeTtyOut extends EventEmitter {
  isTTY = true;
  constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); }
  writes = 0; bytes = 0;
  write(s: string): boolean { this.writes++; this.bytes += String(s).length; this.vt.write(String(s)); return true; }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private data: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read(): string | null { const d = this.data; this.data = null; return d; }
  push(s: string): void { this.data = s; this.emit("readable"); this.emit("data", s); }
}
class PumpCountingDiffer extends FrameDiffer {
  streamPumps = 0;
  private lastTail = "";

  override setBandContent(rows: string[] | null, dist: number, tail: string[] = []): void {
    const nextTail = tail.join("\n");
    if (nextTail && nextTail !== this.lastTail) this.streamPumps++;
    this.lastTail = nextTail;
    super.setBandContent(rows, dist, tail);
  }

  resetPumps(): void { this.streamPumps = 0; }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("streaming while SCROLLED AWAY pumps far less than streaming at the bottom", async () => {
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new PumpCountingDiffer();
  // A provider that streams a delta every 10ms for ~2.4s - long enough to sample both phases.
  const provider: any = {
    complete: async (_m: any[], _t: any[], onDelta?: (t: string, k?: string) => void) => {
      for (let i = 0; i < 240; i++) { onDelta?.(`chunk ${i} `, "content"); await tick(10); }
      return { content: "", tool_calls: [] };
    },
  };
  const session: any = {
    id: "lag", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `lich su ${i}` })),
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = render(
    React.createElement(ChatApp as any, { fullscreen: true, yolo: true, provider, resumedSession: session, sessionId: "lag", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  try {
    await tick(500); // settle startup
    stdin.push("stream nhieu vao"); // type the prompt...
    await tick(80);
    stdin.push("\r"); // ...and start the streaming turn
    await tick(300); // the stream is flowing, pinned at the bottom
    differ.resetPumps();
    await tick(600); // SAMPLE A: pinned - every pump updates the moving tail
    const pinnedPumps = differ.streamPumps;
    // Scroll up into history (wheel), then let the glide fully settle.
    stdin.push("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M");
    await tick(300);
    differ.resetPumps();
    await tick(600); // SAMPLE B: scrolled away - the tail is off-screen, pumps are slowed
    const scrolledPumps = differ.streamPumps;
    // Count stream-tail updates at the compositor boundary, not all terminal writes. Spinner/cursor writes
    // share neither cadence nor scheduler priority across OSes and made the old wall-clock delta flaky.
    // The product contract is 40ms pinned versus 300ms while reading: in this window pinned must produce
    // several frames, while the scrolled path remains bounded to a handful even on a slow runner.
    expect(vt.text()).toContain("Jump to bottom"); // the scroll really engaged (reading mode)
    expect(pinnedPumps).toBeGreaterThanOrEqual(5);
    expect(scrolledPumps).toBeLessThanOrEqual(4);
    expect(pinnedPumps).toBeGreaterThan(scrolledPumps);
  } finally {
    app.unmount();
    await tick(80);
  }
}, 30000);
