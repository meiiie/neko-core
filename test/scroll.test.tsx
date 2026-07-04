import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { flattenLines, ScrollRegion } from "../src/ui/scroll.tsx";
import type { Line } from "../src/ui/transcript.tsx";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

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

test("ScrollRegion renders the visible window + a scrollbar when content overflows", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ text: `row-${i}`, dim: false }));
  const f = strip(render(<ScrollRegion rows={rows} offset={10} height={5} width={20} />).lastFrame());
  expect(f).toContain("row-10");
  expect(f).toContain("row-14");
  expect(f).not.toContain("row-9");   // above the window
  expect(f).not.toContain("row-15");  // below the window
  expect(f).toMatch(/[█│]/);          // scrollbar present (content overflows)
});
