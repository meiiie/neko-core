import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Box } from "ink";

import { ApprovalBox, type Approval } from "../src/ui/approval-box.tsx";

const plan = `## Plan

1. **Edit src/foo.ts** — add a helper function
2. **Edit src/bar.ts** — wire up the call site
3. Run the test suite

- bullet one
- bullet two with a fairly long line that should wrap nicely within the terminal width column`;

// SAFETY: fixture literal built by this test; the omitted members are unused by the component under test.
const makeApproval = (): Approval =>
  ({ toolName: "exit_plan_mode", args: { plan }, resolve: () => {} }) as Approval;

/** A plan box must NEVER overflow the terminal width: every rendered line <= the passed width.
 * Regression: Markdown defaulted to 80 cols, so the box was always ~84 wide and overflowed narrow
 * terminals, garbling the layout. */
test("plan box respects the passed width and never overflows", () => {
  const termW = 60;
  const c = render(
    <Box width={termW}>
      <ApprovalBox approval={makeApproval()} flash={null} width={termW} />
    </Box>,
  );
  const frame = c.lastFrame() ?? "";
  const lines = frame.split("\n");
  for (const l of lines) {
    expect(l.length).toBeLessThanOrEqual(termW);
  }
  expect(lines.length).toBeGreaterThan(3); // a real rendered box, not collapsed
  c.unmount();
});

test("plan box wraps long lines instead of letting them overflow", () => {
  const termW = 50;
  const c = render(
    <Box width={termW}>
      <ApprovalBox approval={makeApproval()} flash={null} width={termW} />
    </Box>,
  );
  const frame = c.lastFrame() ?? "";
  const lines = frame.split("\n");
  // the long bullet wrapped to 2+ visual lines (strip border/padding + trailing spaces, then join)
  const strip = (s: string) => s.replace(/^[│╭╰╮╯]\s?/, "").replace(/\s?[│╭╰╮╯]$/, "").trimEnd();
  const text = lines.map(strip).join(" ").replace(/\s+/g, " ").trim();
  expect(text).toContain("wrap nicely within the terminal width column");
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(termW);
  c.unmount();
});

test("plan box fits even very narrow terminals (<28 cols, Markdown minWidth path)", () => {
  const termW = 20;
  const c = render(
    <Box width={termW}>
      <ApprovalBox approval={makeApproval()} flash={null} width={termW} />
    </Box>,
  );
  const frame = c.lastFrame() ?? "";
  for (const l of frame.split("\n")) expect(l.length).toBeLessThanOrEqual(termW);
  c.unmount();
});

test("plan box shows header, footer and markdown content", () => {
  const c = render(
    <Box width={80}>
      <ApprovalBox approval={makeApproval()} flash={null} width={80} />
    </Box>,
  );
  const frame = c.lastFrame() ?? "";
  expect(frame).toContain("Ready to code?");
  expect(frame).toContain("[y] proceed");
  expect(frame).toContain("Edit src/foo.ts");
  expect(frame).toContain("Run the test suite");
  c.unmount();
});

test("write_file create preview omits phantom blank + from trailing newline", () => {
  const content = 'export function greet(name){ return "hi "+name; }\n';
  const approval = { toolName: "write_file", args: { path: "src/new-only-xyz.js", content }, resolve: () => {} } as Approval;
  const c = render(
    <Box width={80}>
      <ApprovalBox approval={approval} flash={null} width={80} />
    </Box>,
  );
  const frame = c.lastFrame() ?? "";
  expect(frame).toContain("write src/new-only-xyz.js (1 line");
  expect(frame).toContain("greet");
  // No second blank + line after the code line.
  const plusLines = frame.split("\n").filter((l) => /\+\s*$/.test(l.replace(/[│╭╰╮╯]/g, "").trimEnd()) || /\+ $/.test(l) || /│\s+\d+\s+\+\s*│/.test(l));
  // Stronger: frame must not contain a numbered empty addition like "2 +".
  expect(frame).not.toMatch(/\b2 \+/);
  c.unmount();
});

test("write_file overwrite preview shows red removal vs existing workspace file", () => {
  const dir = "/workspace/research/neko-ux-playground/raise-bar-6";
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const content = 'export function greet(name){ return "hello "+name; }\n';
    const approval = { toolName: "write_file", args: { path: "src/greet.js", content }, resolve: () => {} } as Approval;
    const c = render(
      <Box width={80}>
        <ApprovalBox approval={approval} flash={null} width={80} />
      </Box>,
    );
    const frame = c.lastFrame() ?? "";
    expect(frame).toContain("overwrite src/greet.js");
    expect(frame).toContain("hi"); // prior content visible as removal
    expect(frame).toContain("hello");
    expect(frame).toMatch(/-/); // red side present
    expect(frame).not.toMatch(/\b2 \+/); // no phantom trailing blank +
    c.unmount();
  } finally {
    process.chdir(prev);
  }
});

test("edit reorder preview keeps shared middle as context (not delete+re-add)", () => {
  const old_string = ["line1 anchor-AAA", "line2 middle", "line3 anchor-BBB"].join("\n");
  const new_string = ["line3 anchor-BBB", "line2 middle", "line1 anchor-AAA"].join("\n");
  const approval = {
    toolName: "edit",
    args: { path: "notes/order.txt", old_string, new_string },
    resolve: () => {},
  } as Approval;
  const c = render(
    <Box width={80}>
      <ApprovalBox approval={approval} flash={null} width={80} />
    </Box>,
  );
  const frame = c.lastFrame() ?? "";
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/[│╭╰╮╯]/g, "");
  const plain = strip(frame);
  expect(plain).toContain("Approve edit?");
  expect(plain).toContain("line2 middle");
  // Shared middle must appear as dim context (two leading spaces), not as "- line2" / "+ line2".
  const middleRows = plain.split("\n").filter((l) => l.includes("line2 middle"));
  expect(middleRows.length).toBeGreaterThan(0);
  expect(middleRows.every((l) => !/^\s*-\s*line2 middle/.test(l) && !/^\s*\+\s*line2 middle/.test(l))).toBe(true);
  expect(plain).toMatch(/-\s*line1 anchor-AAA/);
  expect(plain).toMatch(/-\s*line3 anchor-BBB/);
  expect(plain).toMatch(/\+\s*line1 anchor-AAA/);
  expect(plain).toMatch(/\+\s*line3 anchor-BBB/);
  c.unmount();
});
