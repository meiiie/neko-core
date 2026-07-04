/**
 * UI perf bench on a REAL session: loads a saved transcript and measures the exact per-frame costs the
 * REPL pays - initial fullscreen render, per-keystroke re-render, scroll flush - plus the micro-pieces
 * (estimateTokens, replay build, flatten). Run:  bun scripts/bench-ui.ts [sessionId]
 * This is how "it lags" gets turned into numbers before any fix is attempted.
 */
import { render } from "ink-testing-library";
import React from "react";

import { loadSession } from "../src/adapters/session.ts";
import { estimateTokens } from "../src/core/agent.ts";
import { ChatApp, buildReplayLines } from "../src/ui/chat.tsx";
import { flattenLines } from "../src/ui/scroll.tsx";
import { RichView } from "../src/ui/rich-transcript.tsx";
import { NekoConfig } from "../src/adapters/config.ts";

const id = process.argv[2] ?? "20260703-225229-822";
const s = loadSession(id);
if (!s) { console.error(`no session ${id}`); process.exit(1); }
console.log(`session ${id}: ${s.messages.length} messages, ${JSON.stringify(s.messages).length} chars`);

const ms = (t0: number) => (performance.now() - t0).toFixed(1) + "ms";
const tick = (n = 40) => new Promise((r) => setTimeout(r, n));

// --- micro pieces ---
let t0 = performance.now();
const tok = estimateTokens(s.messages);
console.log(`estimateTokens: ${ms(t0)} (=${tok} tok)  <- runs EVERY render until the first API call`);

let nextId = 0;
t0 = performance.now();
const lines = buildReplayLines(s.messages, () => nextId++);
console.log(`buildReplayLines: ${ms(t0)} (${lines.length} lines)`);

t0 = performance.now();
const flat = flattenLines(lines, 100);
console.log(`flattenLines: ${ms(t0)} (${flat.length} rows)`);

// --- ANSI cache: warm cost (once) + RichView paste cost (per frame) ---
const CFG = new NekoConfig({}, null, {}, "");
const { renderLineRows } = await import("../src/ui/ansi-cache.ts");
t0 = performance.now();
const allRows: string[] = [];
for (const l of lines) allRows.push(...renderLineRows(l, 100, CFG));
console.log(`warm ALL ${lines.length} lines to ANSI rows: ${ms(t0)} (${allRows.length} rows) <- paid ONCE, in background chunks`);
t0 = performance.now();
const rv = render(React.createElement(RichView, { rows: allRows, dist: 0, viewH: 30, width: 100 }) as any);
console.log(`RichView mount (viewH=30, cached rows): ${ms(t0)}`);
t0 = performance.now();
for (let i = 1; i <= 10; i++) rv.rerender(React.createElement(RichView, { rows: allRows, dist: i * 3, viewH: 30, width: 100 }) as any);
console.log(`RichView 10 scroll re-renders: ${ms(t0)} (avg ${((performance.now() - t0) / 10).toFixed(1)}ms/frame)`);
rv.unmount();

// --- full ChatApp in fullscreen with the real session ---
process.env.NEKO_FULLSCREEN = "1";
const provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) };
t0 = performance.now();
const app = render(React.createElement(ChatApp as any, { yolo: true, provider, resumedSession: s, sessionId: id }) as any);
await tick(80);
console.log(`ChatApp fullscreen mount+settle: ${ms(t0)} (${app.stdout.frames.length} frames)`);

// Let the background warmer finish (chunks of 3 on 0ms timers) before measuring steady-state typing.
t0 = performance.now();
let lastFrames = -1;
while (app.stdout.frames.length !== lastFrames) { lastFrames = app.stdout.frames.length; await tick(120); }
console.log(`background warm quiesced in ${ms(t0)}`);

// per-keystroke: type, measure wall time at steady state
const before = app.stdout.frames.length;
t0 = performance.now();
for (const ch of "danh gia do tre go phim") { app.stdin.write(ch); await tick(1); }
await tick(60);
const typed = performance.now() - t0 - 23 * 1 - 60;
console.log(`23 keystrokes (steady state): ${typed.toFixed(0)}ms (~${(typed / 23).toFixed(1)}ms/key), frames +${app.stdout.frames.length - before}`);

// scroll: 10 coalesced wheel bursts
t0 = performance.now();
for (let i = 0; i < 10; i++) { app.stdin.write("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M"); await tick(40); }
console.log(`10 wheel bursts (3 notches each, 40ms apart): ${ms(t0)}`);

app.unmount();
process.exit(0);
