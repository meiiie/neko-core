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

const makeApproval = (): Approval =>
  ({ toolName: "exit_plan_mode", args: { plan }, resolve: () => {} }) as unknown as Approval;

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
