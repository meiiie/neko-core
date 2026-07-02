import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { NekoConfig } from "../src/adapters/config.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { linesToRows, lineToRows, ScrollView } from "../src/ui/fullscreen.tsx";
import type { Line } from "../src/ui/transcript.tsx";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 4000) => { for (let w = 0; w < ms && !pred(); w += 20) await tick(20); return pred(); };

test("/fullscreen toggles the scroll mode and PageUp shows the 'rows below' pill", async () => {
  const provider = { async complete() { return { content: "", tool_calls: [] }; } } as any;
  const resumed = { id: "s", createdAt: "", updatedAt: "", cwd: process.cwd(), model: "m",
    messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} some content` })) };
  const { stdin, lastFrame, unmount } = render(<ChatApp yolo provider={provider} resumedSession={resumed as any} sessionId="s" />);
  const seen = (s: string) => (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  await tick(60);
  stdin.write("/fullscreen"); await tick(40); stdin.write("\r");
  expect(await until(() => seen("· fullscreen"))).toBe(true); // toggled into fullscreen
  stdin.write("\x1b[5~"); // PageUp
  expect(await until(() => seen("rows below"))).toBe(true); // scrolled up -> the jump-to-bottom pill
  unmount();
}, 15000);

const CFG = new NekoConfig({ model: "m", provider: "p" }, null, {}, "");
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const rowW = (row: { text: string }[]) => row.reduce((n, s) => n + [...s.text].length, 0);

test("lineToRows produces fixed 1-row lines within width for each kind", () => {
  const lines: Line[] = [
    { id: 1, kind: "user", text: "a fairly long user prompt that should wrap across the narrow width here" },
    { id: 2, kind: "assistant", text: "## Heading\n\nA paragraph with **bold** and a list:\n- one\n- two" },
    { id: 3, kind: "tool_call", text: "Bash(echo hi)" },
    { id: 4, kind: "error", text: "boom" },
  ];
  for (const l of lines) for (const r of lineToRows(l, 24, CFG)) expect(rowW(r)).toBeLessThanOrEqual(24);
});

test("linesToRows caches committed lines (same array identity on re-flatten)", () => {
  const cache = new Map();
  const lines: Line[] = [{ id: 7, kind: "assistant", text: "hello world" }];
  const a = lineToRows(lines[0], 40, CFG);
  linesToRows(lines, 40, CFG, cache);
  expect(cache.get(7)).toBeDefined();
  const first = cache.get(7);
  linesToRows(lines, 40, CFG, cache); // second pass reuses the cached rows
  expect(cache.get(7)).toBe(first);
  expect(a.length).toBe(first!.length);
});

test("ScrollView shows exactly the window rows[top..top+height], input pinned bottom via padding", () => {
  const rows = Array.from({ length: 30 }, (_, i) => [{ text: `row-${i}` }]);
  const out = strip(render(<ScrollView rows={rows} top={20} height={6} />).lastFrame()).split("\n").filter((l) => l.length);
  expect(out.some((l) => l.includes("row-20"))).toBe(true);
  expect(out.some((l) => l.includes("row-25"))).toBe(true);
  expect(out.some((l) => l.includes("row-26"))).toBe(false); // outside the window
  expect(out.some((l) => l.includes("row-19"))).toBe(false);
});

test("ScrollView pads to full height when the transcript is shorter than the viewport", () => {
  const rows = [[{ text: "only" }], [{ text: "two" }]];
  const frame = render(<ScrollView rows={rows} top={0} height={8} />).lastFrame() ?? "";
  expect(frame.split("\n").length).toBeGreaterThanOrEqual(8); // padded to the viewport height
});
