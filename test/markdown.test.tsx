import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { fitColumns, Markdown, truncCell } from "../src/ui/markdown.tsx";
import { TranscriptLine } from "../src/ui/transcript.tsx";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("fitColumns keeps a fitting table natural but shrinks the widest column to fit", () => {
  expect(fitColumns([5, 8, 3], 80)).toEqual([5, 8, 3]); // already fits -> unchanged
  const w = fitColumns([10, 60, 10], 40); // too wide -> shrink the widest first
  expect(w.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(40 - (3 + 1 + 3 * 2)); // within budget
  expect(w[1]).toBeLessThan(60);
  expect(w[0]).toBe(10); // narrow columns untouched
});

test("truncCell marks a cut with an ellipsis", () => {
  expect(truncCell("hello", 10)).toBe("hello");
  expect(truncCell("hello world", 5)).toBe("hell…");
});

test("markdown table draws aligned box borders and truncates an over-wide cell", () => {
  const md = [
    "| Mode | Behavior |",
    "|---|---|",
    "| default | prompt before write |",
    "| auto | approve everything automatically and never ever ask again |",
  ].join("\n");
  const out = strip(render(<Markdown text={md} width={40} />).lastFrame());
  for (const ch of ["┌", "┐", "├", "┼", "┤", "└", "┘", "│"]) expect(out).toContain(ch);
  const bordered = out.split("\n").filter((l) => /[│┌└├]/.test(l));
  const widths = new Set(bordered.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, "")].length));
  expect(widths.size).toBe(1); // every bordered line is the same width -> aligned, no wrap-shatter
  expect(out).toContain("…"); // the long cell was truncated to fit, not wrapped
});

test("markdown table renders bold cells, decodes entities and <br>", () => {
  const md = [
    "| **Shop** | **Note** |",
    "|---|---|",
    "| **A** | warranty<br>delivery |",
    "| Cửa h&#224;ng | ok |",
  ].join("\n");
  const out = strip(render(<Markdown text={md} />).lastFrame());
  expect(out).not.toContain("**"); // bold markers stripped
  expect(out).not.toContain("<br>"); // <br> decoded
  expect(out).toContain("Cửa hàng"); // &#224; -> à
});

test("tool_result with a summary collapses to one line", () => {
  const text = Array.from({ length: 45 }, (_, i) => `${i}`).join("\n");
  const out = strip(render(<TranscriptLine line={{ id: 1, kind: "tool_result", text, summary: "Read 45 lines" }} cfg={{} as any} />).lastFrame());
  expect(out).toContain("Read 45 lines");
  expect(out).toContain("ctrl+o to expand");
  expect(out).not.toContain("\n0\n"); // not showing the raw lines
});

test("tool_result collapses past 8 lines with a ctrl+o hint", () => {
  const text = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
  const out = strip(render(<TranscriptLine line={{ id: 1, kind: "tool_result", text }} cfg={{} as any} />).lastFrame());
  expect(out).toContain("ctrl+o to expand");
  expect(out).toContain("+4 lines");
  expect(out).not.toContain("line9"); // 9th+ lines hidden
});
