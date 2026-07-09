/**
 * Full-pipeline fullscreen simulation: the REAL ChatApp wired exactly like production (fake TTY stdout
 * -> FrameDiffer -> BSU/ESU wrapper, raw-ish stdin), with EVERY written byte replayed into a
 * VirtualTerminal. Asserts the screen is never left blank ("black screen") across the exact flows the
 * owner hit: entering fullscreen, typing, growing the window, shrinking it. This is the deterministic
 * reproduction harness for the class of bugs that only real terminals used to reveal.
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
  writes = 0; all = "";
  write(s: string): boolean { this.writes++; this.all += String(s); this.vt.write(String(s)); return true; }
  setSize(cols: number, rows: number): void { this.columns = cols; this.rows = rows; this.vt.resize(cols, rows); this.emit("resize"); }
}
class FakeStdin extends EventEmitter {
  isTTY = true; private data: string | null = null;
  setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {}
  read(): string | null { const d = this.data; this.data = null; return d; }
  push(s: string): void { this.data = s; this.emit("readable"); this.emit("data", s); }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** render() with fullscreen ON via the EXPLICIT ChatApp prop (never NEKO_FULLSCREEN mutation - racy
 * across files under bun's CI test scheduling), and Ink forced `interactive: true`: Ink otherwise
 * consults is-in-ci and stops writing frames entirely - on GitHub runners the sims' VirtualTerminal
 * stayed BLANK and every assertion failed. */
function renderFS(node: any, options: any) {
  return render(React.cloneElement(node, { fullscreen: true }), { ...options, interactive: true });
}

test("virtual terminal consumes cursor-shape control sequences without visible residue", () => {
  const vt = new VirtualTerminal(40, 4);
  vt.write("ready\x1b[5 q"); // DECSCUSR: blinking bar cursor
  expect(vt.text()).toContain("ready");
  expect(vt.text()).not.toContain("[5 q");
});

test("virtual terminal tracks Unicode display cells, not UTF-16 code units", () => {
  const vt = new VirtualTerminal(40, 4);
  vt.write("A界B");
  expect(vt.c).toBe(4); // 1 + wide CJK cell pair + 1
  expect(vt.lines()[0]).toBe("A界B");

  const combining = new VirtualTerminal(40, 4);
  combining.write("e\u0301x");
  expect(combining.c).toBe(2); // one grapheme/cell for e + combining acute, then x
  expect(combining.lines()[0]).toBe("e\u0301x");
});

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
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false }); // runChat's pre-render alt entry
  const app = renderFS(
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

test("resize after a completed turn keeps the input row empty", async () => {
  const vt = new VirtualTerminal(110, 32);
  const out = new FakeTtyOut(110, 32, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "final answer", tool_calls: [] }) };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: true, provider, sessionId: "resize-after-turn", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(300);
  stdin.push("PROMPT-MUST-NOT-GHOST"); await tick(30); stdin.push("\r"); await tick(450);
  expect(vt.text()).toContain("final answer");

  out.setSize(80, 20);
  await tick(700);
  const promptRows = vt.lines().filter((line) => /^\s*>/.test(line));
  expect(promptRows.at(-1)?.trim()).toBe(">");
  stdin.push("\x1b[1;5A"); await tick(120); // Ctrl+Up belongs to transcript scroll, not prompt history
  expect(vt.lines().filter((line) => /^\s*>/.test(line)).at(-1)?.trim()).toBe(">");
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
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false }); // runChat's pre-render order
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "boot", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(500); // startup + warm settle - NO input at all
  expect(vt.isBlank()).toBe(false);                 // the screen is NOT black
  expect(vt.text()).toContain("boot-marker tra loi"); // the transcript is actually painted
  expect(vt.text()).toContain(">");                  // the input chrome too
  app.unmount();
  await tick(50);
}, 30000);

test("fullscreen drag-select: uniform highlight, copies on release, PERSISTS for Ctrl+C", async () => {
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  const session: any = {
    id: "sel", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: [{ role: "user", content: "SELECTME a unique line" }, { role: "assistant", content: "a reply here" }],
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "sel", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(500);
  const ls = vt.lines();
  const y = ls.findIndex((l) => l.includes("SELECTME")) + 1; // 1-based screen row of the line
  expect(y).toBeGreaterThan(0);
  const x0 = ls[y - 1].indexOf("SELECTME") + 1, x1 = x0 + "SELECTME".length;
  out.all = "";
  stdin.push(`\x1b[<0;${x0};${y}M`); await tick(30);   // press left
  stdin.push(`\x1b[<32;${x1};${y}M`); await tick(30);  // drag right
  stdin.push(`\x1b[<0;${x1};${y}m`); await tick(90);   // release
  expect(out.all).toContain("\x1b[48;5;25m"); // UNIFORM solid-blue highlight (not per-char inverse)
  expect(out.all).toContain("\x1b]52;");       // copied on release via OSC 52
  expect(vt.text()).toContain("copied");        // "copied N chars to clipboard" confirmation
  out.all = "";
  stdin.push("\x03"); await tick(80);           // the habit: the selection persists, Ctrl+C copies it
  expect(out.all).toContain("\x1b]52;");        // Ctrl+C copied the still-active selection
  app.unmount();
  await tick(50);
}, 30000);

test("todo flow shows the current plan once while the next step is running", async () => {
  const vt = new VirtualTerminal(96, 28);
  const out = new FakeTtyOut(96, 28, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  let call = 0;
  let finish = () => {};
  const provider: any = {
    complete: async () => {
      call++;
      if (call === 1) {
        return {
          content: null,
          tool_calls: [{
            id: "todo-flow",
            name: "todo_write",
            arguments: { todos: [
              { content: "active task", status: "in_progress" },
              { content: "UNIQUE PENDING TODO", status: "pending" },
            ] },
          }],
        };
      }
      await new Promise<void>((resolve) => { finish = resolve; });
      return { content: "done", tool_calls: [] };
    },
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: true, provider, sessionId: "todo-flow", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(300);
  stdin.push("make a plan"); await tick(30); stdin.push("\r"); await tick(450);
  const occurrences = vt.text().split("UNIQUE PENDING TODO").length - 1;
  expect(occurrences).toBe(1); // one plan, not a committed result plus a duplicate live copy
  finish();
  await tick(150);
  app.unmount();
  await tick(50);
}, 30000);

test("approval decision keys never leak into the prompt", async () => {
  const vt = new VirtualTerminal(80, 24);
  const out = new FakeTtyOut(80, 24, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  let call = 0;
  const provider: any = {
    complete: async () => ++call === 1
      ? { content: null, tool_calls: [{ id: "deny", name: "bash", arguments: { command: "echo should-not-run" } }] }
      : { content: "denied safely", tool_calls: [] },
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: false, provider, sessionId: "approval-key", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(300);
  stdin.push("request approval"); await tick(30); stdin.push("\r");
  for (let waited = 0; waited < 2000 && !vt.text().includes("Approve bash?"); waited += 25) await tick(25);
  expect(vt.text()).toContain("Approve bash?");
  stdin.push("n");
  await tick(500);
  expect(vt.text()).toContain("denied safely");
  expect(vt.lines().some((line) => /^\s*>\s*n\s*$/.test(line))).toBe(false);
  app.unmount();
  await tick(50);
}, 30000);

test("slash menu on a SHORT window keeps the input row + first items (chrome never flex-squashed)", async () => {
  // Image #61: typing "/" on a short window opened the slash menu, and Yoga squashed the input chrome -
  // the "> /" input row vanished and the first menu entries (incl. the selected /help) were cut. The
  // chrome is flexShrink=0 now; the transcript band shrinks instead.
  const vt = new VirtualTerminal(100, 18); // SHORT window - the menu + chrome dominate it
  const out = new FakeTtyOut(100, 18, vt);
  const stdin = new FakeStdin();
  const differ = new FrameDiffer();
  const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
  const msgs: any[] = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
  const session: any = { id: "slash", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "slash", frameDiffer: differ, preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(400);
  stdin.push("/"); await tick(300);
  const t = vt.text();
  expect(t).toMatch(/> \S?\//);            // the input row with the typed "/" is ON SCREEN (was squashed away)
  expect(t).toContain("/help");             // the FIRST (selected) menu entry survived too
  app.unmount();
  await tick(50);
}, 30000);

test("/resume picker while SCROLLED UP renders names intact (no flex-squash, no stale band rows)", async () => {
  // Image #60: with the pill visible the picker lost its header + session names - Yoga flex-SQUASHED the
  // list (label+detail overlapped on one row), and the band's stale geometry froze old transcript rows
  // over it (Ink skips identical frames, so nothing repainted). Locks the flexShrink=0 + setBand-geometry
  // refresh fixes end-to-end on the real composed screen.
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = join(tmpdir(), `neko-sim-resume-${process.pid}`);
  mkdirSync(join(home, ".neko-core", "sessions"), { recursive: true });
  const savedEnv = { up: process.env.USERPROFILE, home: process.env.HOME };
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    for (let i = 0; i < 5; i++) {
      const id = `2026070${i}-00000${i}-00${i}`;
      writeFileSync(join(home, ".neko-core", "sessions", `${id}.json`), JSON.stringify({
        id, createdAt: new Date(Date.now() - i * 3600e3).toISOString(), updatedAt: new Date(Date.now() - i * 3600e3).toISOString(),
        cwd: process.cwd(), model: "m",
        messages: [{ role: "user", content: `ten phien so ${i} rat de nhan` }, { role: "assistant", content: `tra loi ${i}` }],
      }));
    }
    const vt = new VirtualTerminal(110, 32);
    const out = new FakeTtyOut(110, 32, vt);
    const stdin = new FakeStdin();
    const differ = new FrameDiffer();
    const msgs: any[] = [];
    for (let i = 0; i < 30; i++) msgs.push({ role: "user", content: `cau hoi ${i}` }, { role: "assistant", content: `tra loi dai dong so ${i}` });
    const session: any = { id: "cur", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
    const app = renderFS(
      React.createElement(ChatApp as any, { yolo: true, provider: { complete: async () => ({ content: "", tool_calls: [] }) }, resumedSession: session, sessionId: "cur", frameDiffer: differ, preAltDispose }),
      { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
    );
    await tick(500);
    stdin.push("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M"); await tick(250); // scroll up -> pill (the #60 state)
    stdin.push("/resume"); await tick(80); stdin.push("\r"); await tick(500);
    const t = vt.text();
    expect(t).toContain("Resume session");                 // the header survived (was flex-squashed to 0)
    for (let i = 0; i < 5; i++) expect(t).toContain(`ten phien so ${i} rat de nhan`); // every NAME intact
    expect(t).not.toMatch(/msgs\S/);                       // no label residue fused right after a detail ("msgsde nhan")
    app.unmount();
    await tick(50);
  } finally {
    process.env.USERPROFILE = savedEnv.up; process.env.HOME = savedEnv.home;
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

test("DIFFER-LESS fullscreen (the Windows default): renders, types, and scrolls INSTANTLY", async () => {
  // ConPTY displaces the differ's output at live cadence (the duplicated-chrome ghost), so on Windows
  // the differ is OFF and fullscreen runs on plain Ink frames with INSTANT scrolling (no glide - a
  // glide through React renders a full frame per hop and stutters). This sim locks that whole path:
  // no band composition, no imperative writes, wheel gestures jump straight to the target.
  const vt = new VirtualTerminal(100, 30);
  const out = new FakeTtyOut(100, 30, vt);
  const stdin = new FakeStdin();
  const provider: any = { complete: async () => ({ content: "phan hoi", tool_calls: [] }) };
  const session: any = {
    id: "nodiff", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `noi dung dong ${i}` })),
  };
  const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
  const app = renderFS(
    React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: session, sessionId: "nodiff", preAltDispose }),
    { stdout: wrapStdoutForSync(out as any, { supported: true }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
  );
  await tick(600);
  expect(vt.isBlank()).toBe(false);
  expect(vt.text()).toContain("noi dung dong 39"); // tail visible without any differ

  // Typing echoes through the plain Ink path.
  stdin.push("a"); await tick(60); stdin.push("b"); await tick(150);
  expect(vt.text()).toContain("ab");

  // Wheel up = INSTANT jump into history (no glide timers to wait out).
  for (let i = 0; i < 12; i++) { stdin.push("\x1b[<64;5;5M"); await tick(20); }
  await tick(200);
  const scrolled = vt.text();
  expect(scrolled).not.toContain("noi dung dong 39"); // tail left the viewport
  expect(scrolled).toContain("noi dung dong");        // older transcript rows are on screen

  // Wheel down returns to the live tail.
  for (let i = 0; i < 20; i++) { stdin.push("\x1b[<65;5;5M"); await tick(20); }
  await tick(200);
  expect(vt.text()).toContain("noi dung dong 39");
  app.unmount();
  await tick(50);
}, 30000);
