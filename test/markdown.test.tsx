import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { fitColumns, Markdown, mathToUnicode, truncCell } from "../src/ui/markdown.tsx";

test("mathToUnicode converts common LaTeX to readable Unicode (incl. nested frac+sqrt)", () => {
  expect(mathToUnicode(String.raw`x^2 + y^2 = r^2`)).toBe("x² + y² = r²");
  expect(mathToUnicode(String.raw`\theta = \frac{\pi}{2}`)).toBe("θ = (π)/(2)");
  expect(mathToUnicode(String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`)).toBe("x = (-b ± √(b²-4ac))/(2a)");
  expect(mathToUnicode(String.raw`\sum_{i=1}^{n} a_i \times b_i`)).toBe("∑ᵢ₌₁ⁿ aᵢ × bᵢ");
});

test("Markdown wraps paragraphs at its OWN width, not the ambient terminal width (no mid-word split)", () => {
  // ink-testing-library's default terminal is ~100 cols; an unconstrained paragraph would wrap there.
  const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
  const lines = strip(render(<Markdown text={long} width={40} />).lastFrame()).split("\n").filter((l) => l.trim());
  expect(lines.length).toBeGreaterThan(2); // wrapped at 40, not at the ~100-col ambient width
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(40); // never overflows OUR width
});

test("display math $$...$$ renders as Unicode, inline $...$ too, but a price $5 is left alone", () => {
  const dm = strip(render(<Markdown text={"$$E = mc^2$$"} width={40} />).lastFrame());
  expect(dm).toContain("E = mc²");
  expect(dm).not.toContain("$$");
  const inl = strip(render(<Markdown text={"Công thức $x^2$ và giá $5 to $10."} width={60} />).lastFrame());
  expect(inl).toContain("x²");
  expect(inl).toContain("$5 to $10"); // no LaTeX indicator -> not treated as math
});
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

test("blank lines between paragraphs render (Ink collapses an empty <Text> otherwise)", () => {
  const out = strip(render(<Markdown text={"First paragraph.\n\nSecond paragraph."} />).lastFrame());
  const lines = out.split("\n");
  const i1 = lines.findIndex((l) => l.includes("First paragraph"));
  const i2 = lines.findIndex((l) => l.includes("Second paragraph"));
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i2).toBe(i1 + 2); // exactly one blank row between the two paragraphs
  expect(lines[i1 + 1].trim()).toBe(""); // and that row is blank
});

test("runs of blank lines collapse to one; list items stay tight", () => {
  const out = strip(render(<Markdown text={"Intro:\n- a\n- b\n\n\n\nOutro."} />).lastFrame());
  const lines = out.split("\n");
  const ia = lines.findIndex((l) => l.includes("- a"));
  const ib = lines.findIndex((l) => l.includes("- b"));
  const io = lines.findIndex((l) => l.includes("Outro"));
  expect(ib).toBe(ia + 1); // bullets adjacent -> no blank between them
  expect(io).toBe(ib + 2); // 3 source blanks collapse to a single blank row
});

test("a section label glued to its list gets a blank between them (list is its own block)", () => {
  const out = strip(render(<Markdown text={"**Rec**\n- a\n- b\nNext."} />).lastFrame());
  const lines = out.split("\n");
  const iL = lines.findIndex((l) => l.includes("Rec"));
  const iA = lines.findIndex((l) => l.includes("- a"));
  const ib = lines.findIndex((l) => l.includes("- b"));
  const iN = lines.findIndex((l) => l.includes("Next"));
  expect(iA).toBe(iL + 2); // blank between the label and its first bullet (no longer glued)
  expect(ib).toBe(iA + 1); // bullets tight
  expect(iN).toBe(ib + 2); // blank after the list before the next paragraph
});

test("compact markdown packs tighter than normal (predictable height for the stream clamp)", () => {
  const md = "## Head\nPara.\n- a\n- b\nMore.";
  const nRows = (c?: boolean) => strip(render(<Markdown text={md} compact={c} />).lastFrame()).split("\n").length;
  expect(nRows(true)).toBeLessThan(nRows(false)); // compact omits the added blank-line rhythm
});

test("a horizontal rule renders as spacing only (no cluttering full-width line)", () => {
  const out = strip(render(<Markdown text={"Above\n\n---\n\nBelow"} width={40} />).lastFrame());
  expect(out).toContain("Above");
  expect(out).toContain("Below");
  expect(out).not.toMatch(/─{10,}/); // no box-drawing rule
  expect(out).not.toMatch(/-{5,}/); // no ASCII dashes
});

test("keycap emoji (1-in-a-box) is normalized to '1.' so it doesn't render as a misaligned box", () => {
  const out = strip(render(<Markdown text={"1️⃣ first item"} width={40} />).lastFrame());
  expect(out).toContain("1. first item");
  expect(out).not.toContain("⃣"); // the keycap combiner is gone
});

test("table columns line up when a cell holds a wide char (string-width, not code-point count)", () => {
  const md = ["| Field | Note |", "|---|---|", "| A | plain |", "| B★ | wide star |"].join("\n");
  const out = strip(render(<Markdown text={md} width={40} />).lastFrame());
  const bordered = out.split("\n").filter((l) => /[│┌└├]/.test(l));
  const widths = new Set(bordered.map((l) => [...l].length));
  expect(widths.size).toBe(1); // every bordered row is the same visual width -> aligned
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

test("[text](url) renders the label AND carries the url as an OSC 8 hyperlink (the url used to be dropped)", () => {
  const frame = render(<Markdown text={"Mua tai [iPhone 15](https://cellphones.com.vn/iphone-15.html) nhe"} width={80} />).lastFrame() ?? "";
  expect(frame).toContain("\x1b]8;;https://cellphones.com.vn/iphone-15.html\x07iPhone 15\x1b]8;;\x07");
  const visible = strip(frame).replace(/\x1b\]8;;[^\x07]*\x07/g, "");
  expect(visible).toContain("iPhone 15");
  expect(visible).not.toContain("cellphones.com.vn"); // label-only on screen, target lives in the link
});

test("a bare URL in prose becomes a hyperlink whose visible text IS the url; trailing punctuation stays prose", () => {
  const frame = render(<Markdown text={"Nguon: https://tiki.vn/p/123."} width={80} />).lastFrame() ?? "";
  expect(frame).toContain("\x1b]8;;https://tiki.vn/p/123\x07https://tiki.vn/p/123\x1b]8;;\x07");
  expect(strip(frame).replace(/\x1b\]8;;[^\x07]*\x07/g, "")).toContain("https://tiki.vn/p/123."); // the dot still shows
});

test("a non-web [text](target) stays label-only (no broken hyperlink)", () => {
  const frame = render(<Markdown text={"[xem muc](#anchor)"} width={60} />).lastFrame() ?? "";
  expect(frame).not.toContain("\x1b]8;;");
  expect(strip(frame)).toContain("xem muc");
});

test("a linked table cell keeps column alignment (OSC 8 is zero display width)", () => {
  const md = "| San pham | Nguon |\n|---|---|\n| iPhone | [CPS](https://cellphones.com.vn) |";
  const frame = render(<Markdown text={md} width={60} />).lastFrame() ?? "";
  expect(frame).toContain("\x1b]8;;https://cellphones.com.vn\x07");
  const rows = strip(frame).replace(/\x1b\]8;;[^\x07]*\x07/g, "").split("\n").filter((l) => l.includes("│"));
  const edges = rows.map((r) => r.lastIndexOf("│"));
  expect(new Set(edges).size).toBe(1); // every row's right border lands on the same column
});
