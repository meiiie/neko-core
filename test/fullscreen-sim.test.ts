/**
 * Full-pipeline fullscreen simulation: the REAL ChatApp wired exactly like production (fake TTY stdout
 * -> FrameDiffer -> BSU/ESU wrapper, raw-ish stdin), with EVERY written byte replayed into a
 * VirtualTerminal. Asserts the screen is never left blank ("black screen") across the exact flows the
 * owner hit: entering fullscreen, typing, growing the window, shrinking it. This is the deterministic
 * reproduction harness for the class of bugs that only real terminals used to reveal.
 */
import { EventEmitter } from "node:events";
import { afterAll, expect, test } from "bun:test";
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
  writes = 0;
  write(s: string): boolean { this.writes++; this.vt.write(String(s)); return true; }
  setSize(cols: number, rows: number): void { this.columns = cols; this.rows = rows; this.vt.resize(cols, rows); this.emit("resize"); }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private data: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read(): string | null { const d = this.data; this.data = null; return d; }
  push(s: string): void { this.data = s; this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// These tests force NEKO_FULLSCREEN=1; restore the suite baseline (setup.ts sets "0" = inline) afterward
// so the flag doesn't leak into later files whose ChatApp renders assume inline mode.
afterAll(() => { process.env.NEKO_FULLSCREEN = "0"; });

test("fullscreen sim: startup, typing, grow and shrink never leave a black screen", async () => {
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "phan hoi ok", tool_calls: [] }) };
  const session: any = {
    id: "sim", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `noi dung sim ${i}` })),
  };
  process.env.NEKO_FULLSCREEN = "1"; // fullscreen is the sole interactive mode - boot straight into it
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false }); // runChat's pre-render alt entry
  const app = render(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "sim", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(600); // alt-screen + first composed paint + warm
  expect(vt.isBlank()).toBe(false); // startup fullscreen must not be black
  expect(vt.text()).toContain("noi dung sim 7"); // the transcript tail is actually painted

  // --- typing echoes ---
  stdin.push("x"); await tick(60); stdin.push("y"); await tick(120);
  expect(vt.text()).toContain("xy");

  // --- GROW the window (maximize-like) ---
  out.setSize(120, 36);
  await tick(500); // debounce 150ms + repaint
  expect(vt.isBlank()).toBe(false); // grow must not black the screen
  expect(vt.text()).toContain("noi dung sim 7");

  // --- SHRINK the window (the stale-height overflow case) ---
  out.setSize(90, 22);
  await tick(500);
  expect(vt.isBlank()).toBe(false); // shrink must not black the screen
  expect(vt.text()).toContain("noi dung sim 7");

  // typing after all of it still lands
  stdin.push("z"); await tick(150);
  expect(vt.text()).toContain("z");
  app.unmount();
  await tick(50);
}, 30000);

test("STARTUP-fullscreen sim: alt entered BEFORE the first render - content visible with zero input", async () => {
  // The regression the toggle-path sim missed: with fullscreen as the DEFAULT, `neko --yolo` boots
  // straight into fullscreen. If the alt-screen is entered AFTER the first paint (mount effect), the
  // switch wipes the frame and Ink never repaints -> black until a keypress. This reproduces runChat's
  // exact startup order: guard installed pre-render, first Ink frame paints INTO the alt screen.
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  const session: any = {
    id: "boot", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: [{ role: "user", content: "boot-marker cau hoi" }, { role: "assistant", content: "boot-marker tra loi" }],
  };
  const prev = process.env.NEKO_FULLSCREEN;
  process.env.NEKO_FULLSCREEN = "1";
  try {
    const preAltDispose = installAltScreenGuard(out as any, { mouse: false }); // runChat's pre-render order
    const app = render(
      React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "boot", frameDiffer: differ, preAltDispose }),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
    );
    await tick(500); // startup + warm settle - NO input at all
    expect(vt.isBlank()).toBe(false);                 // the screen is NOT black
    expect(vt.text()).toContain("boot-marker tra loi"); // the transcript is actually painted
    expect(vt.text()).toContain(">");                  // the input chrome too
    app.unmount();
    await tick(50);
  } finally {
    if (prev === undefined) delete process.env.NEKO_FULLSCREEN; else process.env.NEKO_FULLSCREEN = prev;
  }
}, 30000);
