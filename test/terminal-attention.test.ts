import { expect, test } from "bun:test";

import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  setApprovalCursorHidden,
  setFocusReporting,
  terminalFocusFromInput,
} from "../src/ui/terminal-attention.ts";

function fakeOut(isTTY = true) {
  const writes: string[] = [];
  // SAFETY: test-built stream surface; the helper only reads isTTY and calls write.
  const out = { isTTY, write: (value: string) => { writes.push(value); return true; } } as any;
  return { out, writes };
}

test("terminal focus reports accept raw and Ink-stripped CSI, with the last report winning", () => {
  expect(terminalFocusFromInput("\x1b[O")).toBe(false);
  expect(terminalFocusFromInput("[I")).toBe(true);
  expect(terminalFocusFromInput("\x1b[O\x1b[I")).toBe(true);
  expect(terminalFocusFromInput("ordinary input")).toBeNull();
});

test("focus reporting and approval cursor visibility are TTY-only and symmetric", () => {
  const tty = fakeOut();
  setFocusReporting(tty.out, true);
  setApprovalCursorHidden(tty.out, true);
  setApprovalCursorHidden(tty.out, false);
  setFocusReporting(tty.out, false);
  expect(tty.writes).toEqual([
    ENABLE_FOCUS_REPORTING,
    "\x1b[?25l",
    "\x1b[?25h",
    DISABLE_FOCUS_REPORTING,
  ]);

  const pipe = fakeOut(false);
  setFocusReporting(pipe.out, true);
  setApprovalCursorHidden(pipe.out, true);
  expect(pipe.writes).toEqual([]);
});
