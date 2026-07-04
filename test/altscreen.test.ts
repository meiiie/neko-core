import { expect, test } from "bun:test";
import { canFullscreen, CLEAR_HOME, ENTER_ALT, HIDE_CURSOR, installAltScreenGuard, LEAVE_ALT, SHOW_CURSOR, enterAltScreen, leaveAltScreen } from "../src/ui/altscreen.ts";

test("canFullscreen: TTY with room only", () => {
  expect(canFullscreen({ isTTY: true, rows: 40, columns: 120 } as any)).toBe(true);
  expect(canFullscreen({ isTTY: false, rows: 40, columns: 120 } as any)).toBe(false); // piped / not a TTY
  expect(canFullscreen({ isTTY: true, rows: 5, columns: 120 } as any)).toBe(false);   // too short
  expect(canFullscreen({ isTTY: true, rows: 40, columns: 20 } as any)).toBe(false);   // too narrow
});

function fakeOut() {
  const writes: string[] = [];
  return { out: { write: (s: any) => { writes.push(String(s)); return true; } } as any, writes };
}

test("enter/leave alt-screen write the right sequences", () => {
  const a = fakeOut();
  enterAltScreen(a.out);
  expect(a.writes.join("")).toBe(ENTER_ALT + CLEAR_HOME + HIDE_CURSOR);
  const b = fakeOut();
  leaveAltScreen(b.out);
  expect(b.writes.join("")).toBe(SHOW_CURSOR + LEAVE_ALT);
});

test("installAltScreenGuard enters and its disposer leaves exactly once (idempotent)", () => {
  const { out, writes } = fakeOut();
  const dispose = installAltScreenGuard(out);
  expect(writes.join("")).toContain(ENTER_ALT);
  writes.length = 0;
  dispose();
  expect(writes.join("")).toBe(SHOW_CURSOR + LEAVE_ALT);
  dispose(); // second call is a no-op
  expect(writes.join("")).toBe(SHOW_CURSOR + LEAVE_ALT);
});
