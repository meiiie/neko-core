import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useEffect } from "react";
import { flattenLines, ScrollRegion, useScroll, type ScrollApi } from "../src/ui/scroll.tsx";
import type { Line } from "../src/ui/transcript.tsx";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Probe harness: renders the hook's state and hands the api out so tests can drive it. */
function Probe({ total, viewH, grab }: { total: number; viewH: number; grab?: (api: ScrollApi) => void }) {
  const api = useScroll(total, viewH);
  useEffect(() => { grab?.(api); }); // every render, so the grabbed api is never stale
  return <Text>{`off=${api.offset};bottom=${api.atBottom}`}</Text>;
}

test("useScroll: sticky pins to the bottom and follows growth (derived, no effect chase)", () => {
  const c = render(<Probe total={50} viewH={10} />);
  expect(strip(c.lastFrame())).toContain("off=40;bottom=true");
  c.rerender(<Probe total={60} viewH={10} />); // content grew while sticky -> derived offset follows at once
  expect(strip(c.lastFrame())).toContain("off=50;bottom=true");
  c.unmount();
});

test("useScroll: scrolling up breaks sticky FROM the current bottom and holds place as content grows", async () => {
  let api: ScrollApi | null = null;
  const c = render(<Probe total={50} viewH={10} grab={(a) => (api = a)} />);
  await tick();
  api!.up(3); // from the derived bottom (40) -> 37, sticky broken
  await tick();
  expect(strip(c.lastFrame())).toContain("off=37;bottom=false");
  c.rerender(<Probe total={60} viewH={10} grab={(a) => (api = a)} />); // grows below; reading position holds
  expect(strip(c.lastFrame())).toContain("off=37;bottom=false");
  api!.down(50); // overshoot to the bottom -> clamps + re-arms sticky
  await tick();
  expect(strip(c.lastFrame())).toContain("bottom=true");
  c.unmount();
});

test("flattenLines: glyphs, wrapping, entry clip", () => {
  const lines: Line[] = [
    { id: 1, kind: "user", text: "hello" },
    { id: 2, kind: "tool_call", text: "read_file(a.ts)" },
  ];
  const rows = flattenLines(lines, 40);
  expect(rows[0].text).toBe("> hello");
  expect(rows.some((r) => r.text.startsWith("● "))).toBe(true);

  // A long line wraps into multiple rows at the given width.
  const wrapped = flattenLines([{ id: 3, kind: "assistant", text: "x".repeat(100) }], 20);
  expect(wrapped.filter((r) => r.text.includes("x")).length).toBeGreaterThan(3);

  // A noisy tool_result clips to a few rows + a "+N more" marker.
  const noisy = flattenLines([{ id: 4, kind: "tool_result", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") }], 40);
  expect(noisy.some((r) => /\+\d+ more lines/.test(r.text))).toBe(true);
});

test("ScrollRegion renders exactly the visible window (single column, no scrollbar)", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ text: `row-${i}`, dim: false }));
  const f = strip(render(<ScrollRegion rows={rows} offset={10} height={5} width={20} />).lastFrame());
  expect(f).toContain("row-10");
  expect(f).toContain("row-14");
  expect(f).not.toContain("row-9");   // above the window
  expect(f).not.toContain("row-15");  // below the window
  expect(f).not.toMatch(/[█│]/);      // no scrollbar column (the jump pill is the affordance)
});
