import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { RichRow, toRichLines, tokenizeInline, wrapSegs } from "../src/ui/richwrap.tsx";

const rowWidth = (row: { text: string }[]) => row.reduce((n, s) => n + [...s.text].length, 0);
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("tokenizeInline splits styled spans (bold/code/italic/link/math)", () => {
  const segs = tokenizeInline("a **b** `c` $x^2$");
  expect(segs.find((s) => s.text === "b")?.bold).toBe(true);
  expect(segs.find((s) => s.text === "c")?.color).toBe("yellow");
  expect(segs.some((s) => s.text === "x²")).toBe(true); // inline math converted
});

test("wrapSegs keeps every row within width and preserves a bold span across the wrap", () => {
  const segs = [{ text: "one two three ", bold: true }, { text: "four five six seven eight" }];
  const rows = wrapSegs(segs, 12);
  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) expect(rowWidth(r)).toBeLessThanOrEqual(12); // never overflows the viewport width
  // the words from the bold segment stay bold even after wrapping
  const boldWords = rows.flat().filter((s) => s.bold).map((s) => s.text.trim()).join(" ");
  expect(boldWords).toContain("three");
});

test("an over-long token is hard-split so it can never overflow", () => {
  const rows = wrapSegs([{ text: "x".repeat(30) }], 10);
  for (const r of rows) expect(rowWidth(r)).toBeLessThanOrEqual(10);
  expect(rows.length).toBe(3); // 30 / 10
});

test("toRichLines renders a heading + bullet as styled one-row lines within width", () => {
  const rows = toRichLines("## Title\n- a bullet item here", 20);
  for (const r of rows) expect(rowWidth(r)).toBeLessThanOrEqual(20);
  const out = strip(render(<RichRow row={rows[0]} />).lastFrame());
  expect(out).toContain("Title");
});
