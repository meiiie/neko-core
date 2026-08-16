/**
 * Reading while Neko works: with the transcript scrolled away, the streaming tail is BELOW the
 * viewport, so per-delta UI syncs are invisible work - and at 25fps they saturated the event loop
 * and wheel input queued behind them ("scrolling lags while Neko is working", field report
 * 2026-07-28). The pump drops to ~3fps while scrolled and snaps current on re-pin.
 *
 * This sim verifies the INTEGRATION end-to-end: scrolling up during a live stream engages reading
 * mode ("Jump to bottom") and the pump is throttled (scrolledPumps stays bounded by the ~300ms cap).
 * The 40ms/300ms CADENCE CONTRACT itself is NOT asserted here - under CPU load the observed pinned
 * cadence varies 3-6x (40-433ms) and even pinnedPumps>scrolledPumps inverts when the event loop
 * starves, so any wall-clock comparison flakes. The contract lives in the deterministic
 * stream-pump-cadence.test.ts (shouldStreamPump). This test only proves the throttle is wired to the
 * scroll state in the real component.
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

test("streaming while SCROLLED AWAY throttles the pump and engages reading mode", async () => {
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new PumpCountingDiffer();
  // Keep the stream alive across the sample even on a loaded runner; finally cancels it deterministically.
  let cancelled = false;
  const provider: any = {
    complete: async (_m: any[], _t: any[], onDelta?: (t: string, k?: string) => void) => {
      for (let i = 0; i < 800 && !cancelled; i++) { onDelta?.(`chunk ${i} `, "content"); await tick(10); }
      return { content: "", tool_calls: [] };
    },
  };
  const session: any = {
    id: "lag", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `lich su ${i}` })),
  };
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = render(
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    React.createElement(ChatApp as any, { fullscreen: true, yolo: true, provider, resumedSession: session, sessionId: "lag", frameDiffer: differ, preAltDispose }),
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true },
  );
  try {
    await tick(500); // settle startup
    stdin.push("stream nhieu vao"); // type the prompt...
    await tick(80);
    stdin.push("\r"); // ...and start the streaming turn
    await tick(300); // the stream is flowing, pinned at the bottom
    // Scroll up into history (wheel), then let the glide fully settle into reading mode.
    stdin.push("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M");
    await tick(300);
    // Sample the scrolled-away window: the throttle must keep the pump bounded (~300ms floor; ~4 unloaded).
    // No pinned comparison - pinned cadence is unobservable under CPU load (see header); the contract is
    // verified deterministically in stream-pump-cadence.test.ts (shouldStreamPump).
    const SAMPLE_MS = 1_200;
    differ.resetPumps();
    await tick(SAMPLE_MS);
    const scrolledPumps = differ.streamPumps;
    expect(vt.text()).toContain("Jump to bottom"); // reading-mode UI engaged (the scroll really took)
    expect(scrolledPumps).toBeGreaterThanOrEqual(1); // we actually sampled the live stream
    expect(scrolledPumps).toBeLessThanOrEqual(8); // scrolled throttle active (300ms floor; ~4 unloaded, 8 = load headroom)
  } finally {
    cancelled = true;
    app.unmount();
    await tick(80);
  }
}, 30000);
