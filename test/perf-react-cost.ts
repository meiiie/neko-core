/**
 * React render-cost probe: measure how much React WORK happens per idle caret blink as the
 * transcript grows. Ink's FrameDiffer keeps stdout cheap (only the changed cell is written), BUT
 * React still re-renders the whole component tree per state change. If TranscriptLine is NOT
 * memoized, each blink re-runs O(n) component functions. This probe counts React renders.
 *
 * Method: monkey-patch React.createElement / component bodies? No — simpler: instrument by mounting
 * ChatApp with N transcript lines and measure the WALL-CLOCK cost of ONE caret-blink render via
 * performance.now() deltas around a forced setCaretOn toggle, for n=8 vs n=500 lines.
 */
import { render } from "ink";
import React from "react";
import { ChatApp } from "../src/ui/chat.tsx";
import { FrameDiffer } from "../src/ui/frame-diff.ts";
import { installAltScreenGuard } from "../src/ui/altscreen.ts";
import { wrapStdoutForSync } from "../src/ui/sync-stdout.ts";
import { VirtualTerminal } from "./vt.ts";
import { EventEmitter } from "node:events";

// A provider that instantly "completes" each turn so we can seed N lines then go idle.
class SeedProvider {
  lines: string[] = [];
  constructor(texts: string[]) { this.lines = texts; }
  async *stream() { for (const t of this.lines) yield { type: "text", text: t }; }
}

class FakeTtyOut extends EventEmitter {
  isTTY = true;
  constructor(public columns: number, public rows: number) { super(); }
  write(): boolean { return true; } // discard output; we only care about React render cost
}
class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read() { return null; }
  push(s: string) { this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(seedTexts: string[]) {
  const out = new FakeTtyOut(100, 30);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const app = render(
    React.createElement(ChatApp as any, {
      yolo: true, provider: new SeedProvider(seedTexts) as any,
      sessionId: "react-cost", frameDiffer: differ,
      preAltDispose: installAltScreenGuard(out as any, { mouse: false }),
      fullscreen: true,
    } as any),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false, interactive: true } as any,
  );
  await tick(1000); // let the seed turn flush
  return { app, stdin };
}

async function main() {
  const makeTexts = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog. ${Date.now()}`);

  console.log("# REACT RENDER COST vs TRANSCRIPT SIZE (idle caret blink)\n");
  console.log("Hypothesis: if TranscriptLine is NOT memoized, each blink re-renders O(n) React elements.\n");

  for (const n of [8, 200, 500]) {
    const { app, stdin } = await mount(makeTexts(n));
    // Measure: react's render phase isn't directly observable, so measure WALL-CLOCK of a stdin
    // keystroke (which forces exactly one re-render of the full tree) minus a no-op.
    // We use performance.now() around pushing a single char then wait for the next tick.
    const t0 = performance.now();
    stdin.push("a");
    await tick(80); // one render pass
    const dt = performance.now() - t0;
    console.log(`  n=${String(n).padStart(3)} lines  ->  keystroke render wall: ${dt.toFixed(1)} ms`);
    app.unmount();
    await tick(100);
  }
  console.log("\nIf render wall grows ~linearly with n, memoizing TranscriptLine is a real win (idle + typing).");
}
main().catch((e) => { console.error(e); process.exit(1); });
