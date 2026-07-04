/**
 * TTY-path bench: the faithful reproduction of what a REAL terminal receives. Renders ChatApp through
 * the EXACT runChat wiring (fake TTY stdout -> FrameDiffer -> BSU/ESU wrapper) so Ink takes its real
 * log-update path - the layer ink-testing (non-TTY) cannot exercise and where all the v5/v6 work lives.
 * Measures bytes + writes per keystroke and per scroll step, verifies the hardware-scroll path is
 * actually taken, and A/Bs the differ. Run:  NODE_ENV=production bun scripts/bench-tty.ts [sessionId]
 */
import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";

import { loadSession } from "../src/adapters/session.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { FrameDiffer } from "../src/ui/frame-diff.ts";
import { wrapStdoutForSync } from "../src/ui/sync-stdout.ts";

class FakeTtyOut extends EventEmitter {
  isTTY = true; columns = 120; rows = 40;
  bytes = 0; writes = 0; log: string[] = []; times: number[] = [];
  write(s: string): boolean { this.bytes += String(s).length; this.writes++; this.log.push(String(s)); this.times.push(performance.now()); return true; }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private data: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read(): string | null { const d = this.data; this.data = null; return d; }
  push(s: string): void { this.data = s; this.emit("readable"); this.emit("data", s); } // ink listens to both
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = process.argv[2] ?? "20260703-225229-822";
const s = loadSession(id);
if (!s) { console.error(`no session ${id}`); process.exit(1); }

async function quiesce(out: FakeTtyOut, maxMs = 20000): Promise<void> {
  const t0 = performance.now();
  let last = -1;
  while (performance.now() - t0 < maxMs) {
    // Min 8s: with the differ on, warm upgrades produce IDENTICAL frames -> zero writes -> a
    // writes-stable check exits while the warmer still burns CPU, polluting the keystroke timings.
    if (out.writes === last && performance.now() - t0 > 8000) return;
    last = out.writes;
    await tick(400);
  }
}

async function run(label: string, useDiffer: boolean): Promise<void> {
  const out = new FakeTtyOut();
  const stdin = new FakeStdin();
  const differ = useDiffer ? new FrameDiffer() : undefined;
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  process.env.NEKO_FULLSCREEN = "1";
  const app = render(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: s, sessionId: id, frameDiffer: differ }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await quiesce(out); // let resume replay + ANSI warm finish
  console.log(`${label} · after settle: ${out.writes} writes, ${out.bytes} bytes total`);
  if (process.env.BENCH_DEBUG) {
    app.waitUntilExit().then(() => console.log("app exited"), (e) => console.log("app ERROR:", e?.message));
    console.log("tail:", JSON.stringify(out.log.slice(-3).join("").slice(-400)));
  }

  // Keystrokes (spaced past Ink's ~30fps throttle so each lands as its own frame)
  if (process.env.BENCH_DEBUG && useDiffer) {
    const mark = out.log.length;
    stdin.push("Z");
    await tick(80);
    const w = out.log.slice(mark);
    console.log(`DEBUG keystroke writes: ${w.length}`);
    for (const [i, chunk] of w.entries()) console.log(`  [${i}] len=${chunk.length} head=${JSON.stringify(chunk.slice(0, 90))}`);
    const { parseInkPayload } = await import("../src/ui/frame-diff.ts");
    const raw = w.find((c) => c.length > 200) ?? "";
    const inner = raw.replace(/^\x1b\[\?2026h/, "").replace(/\x1b\[\?2026l$/, "");
    const parsed = parseInkPayload(inner);
    console.log(`DEBUG parse: ${parsed ? `OK erase=${parsed.eraseCount} frameLines=${parsed.frame.split("\n").length}` : "REJECTED"}`);
    if (!parsed) {
      const pm = /^((?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)/.exec(inner);
      if (!pm) console.log("DEBUG: erase-prefix regex did not match; head:", JSON.stringify(inner.slice(0, 60)));
      else {
        const frame = inner.slice(pm[1].length);
        const bad = /\x1b\[[0-9;]*[ABCDEFGHJKSTr]/.exec(frame);
        console.log("DEBUG: offending CSI in frame:", JSON.stringify(bad?.[0]), "at", bad?.index, "context:", JSON.stringify(frame.slice(Math.max(0, (bad?.index ?? 0) - 30), (bad?.index ?? 0) + 20)));
      }
    }
  }
  const kb0 = out.bytes, kw0 = out.writes;
  const t0 = performance.now();
  for (const ch of "do luong ban phim go") { stdin.push(ch); await tick(40); }
  const keyMs = (performance.now() - t0 - 20 * 40) / 20;
  const keyBytes = Math.round((out.bytes - kb0) / 20);
  console.log(`${label} · keystroke: ~${keyBytes} bytes/key, ${out.writes - kw0} writes/20 keys, +${keyMs.toFixed(1)}ms work/key`);

  // Scroll (wheel-up SGR bursts)
  const sb0 = out.bytes, si = out.log.length;
  for (let i = 0; i < 20; i++) { stdin.push("\x1b[<64;5;5M"); await tick(40); }
  await tick(100);
  const scrollBytes = Math.round((out.bytes - sb0) / 20);
  const scrolled = out.log.slice(si).join("");
  const hwScroll = /\x1b\[\d+;\d+r/.test(scrolled) && /\x1b\[\d+[ST]/.test(scrolled);
  console.log(`${label} · scroll: ~${scrollBytes} bytes/step, hardware-scroll(DECSTBM+SU/SD) used: ${hwScroll}`);

  // Glide cadence (the FPS meter): one big flick, then measure the interval between repaint writes.
  // Target: ~16ms hops (60fps) with no long gaps - long gaps are what "fps chưa ổn" feels like.
  const gi = out.times.length;
  stdin.push("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M"); // 5-notch flick
  await tick(600);
  const gaps: number[] = [];
  for (let i = gi + 1; i < out.times.length; i++) gaps.push(out.times[i] - out.times[i - 1]);
  const glide = gaps.filter((g) => g < 200); // ignore the trailing idle gap
  const avg = glide.length ? glide.reduce((a, b) => a + b, 0) / glide.length : 0;
  const max = glide.length ? Math.max(...glide) : 0;
  console.log(`${label} · glide: ${glide.length} hops, avg ${avg.toFixed(1)}ms, max ${max.toFixed(1)}ms between repaints`);
  app.unmount();
  await tick(50);
}

// One variant per process (BENCH_MODE=on|off|both): in-process A/B is order-biased - JIT warmup and
// the module-level ANSI cache/hidden-instance state bleed from run 1 into run 2.
const mode = process.env.BENCH_MODE ?? "both";
console.log(`session ${id}: ${s.messages.length} messages`);
if (mode !== "off") await run("differ ON ", true);
if (mode !== "on") await run("differ OFF", false);
process.exit(0);
