import { expect, test } from "bun:test";
import { canFullscreen, CLEAR_HOME, emergencyRestore, ENTER_ALT, HIDE_CURSOR, installAltScreenGuard, KITTY_POP, KITTY_PUSH, LEAVE_ALT, SHOW_CURSOR, enterAltScreen, leaveAltScreen } from "../src/ui/altscreen.ts";
import { DISABLE_FOCUS_REPORTING } from "../src/ui/terminal-attention.ts";

test("canFullscreen: TTY with room only", () => {
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(canFullscreen({ isTTY: true, rows: 40, columns: 120 } as any)).toBe(true);
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(canFullscreen({ isTTY: false, rows: 40, columns: 120 } as any)).toBe(false); // piped / not a TTY
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(canFullscreen({ isTTY: true, rows: 5, columns: 120 } as any)).toBe(false);   // too short
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(canFullscreen({ isTTY: true, rows: 40, columns: 20 } as any)).toBe(false);   // too narrow
});

function fakeOut() {
  const writes: string[] = [];
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  return { out: { write: (s: any) => { writes.push(String(s)); return true; } } as any, writes };
}

test("enter/leave alt-screen write the right sequences, incl. kitty keyboard push/pop", () => {
  const a = fakeOut();
  enterAltScreen(a.out);
  expect(a.writes.join("")).toBe(ENTER_ALT + CLEAR_HOME + HIDE_CURSOR + KITTY_PUSH);
  const b = fakeOut();
  leaveAltScreen(b.out);
  expect(b.writes.join("")).toBe(KITTY_POP + SHOW_CURSOR + LEAVE_ALT);
});

test("kitty push asks for the disambiguate flag; pop restores - push before pop is balanced", () => {
  expect(KITTY_PUSH).toBe("\x1b[>1u");
  expect(KITTY_POP).toBe("\x1b[<u");
});

test("installAltScreenGuard enters and its disposer leaves exactly once (idempotent)", () => {
  const { out, writes } = fakeOut();
  const dispose = installAltScreenGuard(out);
  expect(writes.join("")).toContain(ENTER_ALT);
  writes.length = 0;
  dispose();
  expect(writes.join("")).toBe(KITTY_POP + SHOW_CURSOR + LEAVE_ALT);
  dispose(); // second call is a no-op
  expect(writes.join("")).toBe(KITTY_POP + SHOW_CURSOR + LEAVE_ALT);
});

test("emergency restore disables focus reporting so CSI focus events never leak into the shell", () => {
  const { out, writes } = fakeOut();
  out.isTTY = true;
  emergencyRestore(out);
  expect(writes.join("")).toContain(DISABLE_FOCUS_REPORTING);
});
