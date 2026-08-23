import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useEffect } from "react";
import { flattenLines, projectLineRows, ScrollRegion, stickyPromptAnchor, useRowScroll, useScroll, type RowScrollApi, type ScrollApi } from "../src/ui/scroll.tsx";
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

function RowProbe({ total, viewH, grab, onHop }: { total: number; viewH: number; grab?: (api: RowScrollApi) => void; onHop?: (d: number) => void }) {
  const api = useRowScroll(total, viewH, onHop);
  useEffect(() => { grab?.(api); });
  return <Text>{`dist=${api.dist};scrolled=${api.scrolled}`}</Text>;
}

test("useRowScroll glides toward the target (ease-out) instead of jumping", async () => {
  let api: RowScrollApi | null = null;
  const hops: number[] = [];
  // Read the glide from the onHop CALLBACK, not the rendered dist. dist is derived from a ref that the hop
  // timers advance; under a load spike the timers burst ahead of React's flush, so every captured render
  // reads the ref already at its final value (the old wall-clock snapshot's flake). onHop fires
  // synchronously inside each hop with that hop's exact dist - immune to render timing.
  const c = render(<RowProbe total={200} viewH={20} grab={(a) => (api = a)} onHop={(d) => hops.push(d)} />);
  await tick();
  api!.by(-40); // scroll 40 rows up in one gesture
  await tick(400);                     // let the whole animation run; each hop pushes its dist
  // Glide, not teleport: more than one hop, stepping through an INTERMEDIATE distance before landing on 40.
  expect(hops.length).toBeGreaterThan(1);
  expect(hops.some((d) => d > 0 && d < 40)).toBe(true);
  expect(hops[hops.length - 1]).toBe(40); // settled exactly on the target
  expect(strip(c.lastFrame())).toContain("dist=40;scrolled=true");
  hops.length = 0;
  api!.toBottom();
  await tick(400);
  expect(hops[hops.length - 1]).toBe(0);  // glided back to the tail
  expect(strip(c.lastFrame())).toContain("dist=0;scrolled=false");
  c.unmount();
});

test("useRowScroll exposes the live distance while direct hops bypass React", async () => {
  let api: RowScrollApi | null = null;
  const c = render(<RowProbe total={200} viewH={20} grab={(a) => (api = a)} onHop={() => {}} />);
  await tick();
  expect(api!.dist).toBe(0);
  api!.by(-40); // first direct hop runs synchronously, without a React render
  expect(api!.current()).toBeGreaterThan(0);
  c.unmount();
});

test("useRowScroll jumps an exact content row to the viewport top", async () => {
  let api: RowScrollApi | null = null;
  const c = render(<RowProbe total={100} viewH={10} grab={(a) => (api = a)} />);
  await tick();
  api!.toRow(30);
  await tick(80);
  expect(strip(c.lastFrame())).toContain("dist=60;scrolled=true"); // maxOffset 90 - row 30
  c.unmount();
});

test("sticky prompt anchor uses exact row spans, avoids duplicates, and tracks the nearest prompt", () => {
  const lines: Line[] = [
    { id: 1, kind: "user", text: "first prompt" },
    { id: 2, kind: "assistant", text: "answer one" },
    { id: 3, kind: "user", text: "second prompt\nwith detail" },
    { id: 4, kind: "assistant", text: "answer two" },
  ];
  const projection = projectLineRows(lines, (line) => {
    if (line.id === 1) return ["u1"];
    if (line.id === 2) return ["a1", "a2", "a3"];
    if (line.id === 3) return ["u2", "u2-detail"];
    return Array.from({ length: 8 }, (_, i) => `tail-${i}`);
  });
  expect(projection.rows).toHaveLength(14);
  // viewport start = 14 - 5 - 8 = 1: first prompt is fully above -> sticky first prompt
  expect(stickyPromptAnchor(projection.spans, 14, 5, 8)?.line.id).toBe(1);
  // Without the header, start=3 is one row before the second prompt. Reserving the one-row header
  // makes the real band start=4 on that prompt, so an older sticky copy must not mount above it.
  expect(stickyPromptAnchor(projection.spans, 14, 5, 6, 1)).toBeNull();
  // Effective band start = 5 lands inside the second prompt -> no duplicate sticky copy.
  expect(stickyPromptAnchor(projection.spans, 14, 5, 5, 1)).toBeNull();
  // viewport start = 6 is below the second prompt -> sticky second prompt
  expect(stickyPromptAnchor(projection.spans, 14, 5, 3)?.line.id).toBe(3);
  expect(stickyPromptAnchor(projection.spans, 14, 5, 0)).toBeNull();
});

test("flattenLines: glyphs, wrapping, entry clip", () => {
  const lines: Line[] = [
    { id: 1, kind: "user", text: "hello" },
    { id: 2, kind: "tool_call", text: "read_file(a.ts)" },
  ];
  const rows = flattenLines(lines, 40);
  expect(rows[0].text).toBe("> hello");
  expect(rows[0].background).toBe("#303030");
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
