import { expect, test } from "bun:test";
import { isMouseEnabled, parseClick, parseLastPointer, parseWheelAll } from "../src/ui/mouse.ts";

test("parseLastPointer: last event of a burst wins; kinds classified + left-button state", () => {
  expect(parseLastPointer("\x1b[<35;10;5M")).toEqual({ x: 10, y: 5, kind: "move", left: false }); // any-motion, no button
  expect(parseLastPointer("\x1b[<32;4;6M")).toEqual({ x: 4, y: 6, kind: "move", left: true });    // motion + left held (drag)
  expect(parseLastPointer("\x1b[<0;7;8M")).toEqual({ x: 7, y: 8, kind: "press", left: true });
  expect(parseLastPointer("\x1b[<0;7;8m")).toEqual({ x: 7, y: 8, kind: "release", left: true });
  expect(parseLastPointer("\x1b[<64;1;2M")).toEqual({ x: 1, y: 2, kind: "wheel", left: true });
  expect(parseLastPointer("[<35;1;1M[<35;9;9M")).toEqual({ x: 9, y: 9, kind: "move", left: false }); // burst: LAST position
  expect(parseLastPointer("hello")).toBe(null);
});

test("parseClick rejects motion reports (hover must not click)", () => {
  expect(parseClick("\x1b[<32;10;5M")).toBe(null); // motion with left held is NOT a click
  expect(parseClick("\x1b[<35;10;5M")).toBe(null); // pure motion
  expect(parseClick("\x1b[<0;10;5M")).toEqual({ x: 10, y: 5 });
});

test("parseWheelAll: SGR wheel up/down with counts, ignoring clicks and modifiers", () => {
  expect(parseWheelAll("\x1b[<64;10;5M")).toEqual({ dir: "up", count: 1 });
  expect(parseWheelAll("\x1b[<65;10;5M")).toEqual({ dir: "down", count: 1 });
  expect(parseWheelAll("\x1b[<0;10;5M")).toBe(null);   // left click, not a wheel
  expect(parseWheelAll("\x1b[<2;10;5M")).toBe(null);   // right click
  expect(parseWheelAll("\x1b[<68;10;5M")).toEqual({ dir: "up", count: 1 });   // wheel-up + shift
  expect(parseWheelAll("\x1b[<81;10;5M")).toEqual({ dir: "down", count: 1 }); // wheel-down + ctrl
  expect(parseWheelAll("hello")).toBe(null);
  expect(parseWheelAll("\x1b[A")).toBe(null);          // arrow key, not mouse
  expect(parseWheelAll("[<64;10;5M")).toEqual({ dir: "up", count: 1 }); // ESC stripped by Ink
  // A fast spin batches several reports into ONE chunk - all must count (this was the laggy-scroll bug).
  expect(parseWheelAll("\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<64;1;1M")).toEqual({ dir: "up", count: 3 });
  expect(parseWheelAll("\x1b[<64;1;1M\x1b[<65;1;1M")).toBe(null); // opposite ticks cancel to zero
});

test("parseClick: left-button press coordinates; wheel and other buttons rejected", () => {
  expect(parseClick("\x1b[<0;12;7M")).toEqual({ x: 12, y: 7 });
  expect(parseClick("[<0;3;40M")).toEqual({ x: 3, y: 40 });  // ESC stripped
  expect(parseClick("\x1b[<0;12;7m")).toBe(null);            // release, not press
  expect(parseClick("\x1b[<2;12;7M")).toBe(null);            // right button
  expect(parseClick("\x1b[<64;12;7M")).toBe(null);           // wheel
  expect(parseClick("hello")).toBe(null);
});

test("isMouseEnabled: on by default, off with NEKO_DISABLE_MOUSE", () => {
  expect(isMouseEnabled({} as any)).toBe(true);
  expect(isMouseEnabled({ NEKO_DISABLE_MOUSE: "1" } as any)).toBe(false);
  expect(isMouseEnabled({ NEKO_DISABLE_MOUSE: "true" } as any)).toBe(false);
});

test("title sequences: OSC 2 set + xterm stack push/pop, control chars stripped", async () => {
  const { titleSeq, PUSH_TITLE, POP_TITLE } = await import("../src/ui/title.ts");
  expect(titleSeq("neko - fix bug")).toBe("\x1b]2;neko - fix bug\x07");
  expect(titleSeq("bad\x1b\x07title")).toBe("\x1b]2;bad  title\x07"); // control chars can't break the OSC
  expect(PUSH_TITLE).toBe("\x1b[22;0t");
  expect(POP_TITLE).toBe("\x1b[23;0t");
});

test("brandTitle: cat icon when idle; busy = blinking dot, no cat", async () => {
  const { brandTitle, TAB_ICON } = await import("../src/ui/title.ts");
  expect(TAB_ICON).toBe("\u{1F431}");                          // 🐱
  expect(brandTitle("Neko Core")).toBe("\u{1F431} Neko Core"); // idle: the cat is home
  expect(brandTitle("my session", true, true)).toBe("● my session"); // busy, blink on: dot + name, no cat
  expect(brandTitle("my session", true, false)).toBe("my session");  // busy, blink off: name alone
  expect(brandTitle("my session")).toBe("\u{1F431} my session"); // done: the cat returns
});

test("title driver: blinks the dot while busy, restores + re-asserts the cat when idle", async () => {
  const { setTabTitle, stopTitleDriver, titleSeq } = await import("../src/ui/title.ts");
  const writes: string[] = [];
  const orig = process.stdout.write, origTTY = (process.stdout as any).isTTY;
  (process.stdout as any).isTTY = true;
  (process.stdout as any).write = ((s: any) => { writes.push(String(s)); return true; }) as any;
  try {
    setTabTitle("my task", true);                            // busy
    expect(writes[0]).toBe(titleSeq("● my task"));           // dot ON immediately
    await new Promise((r) => setTimeout(r, 1150));           // one heartbeat (1s cadence)
    expect(writes).toContain(titleSeq("my task"));           // ...then the blink-off shape
    writes.length = 0;
    setTabTitle("my task", false);                           // turn done
    expect(writes[0]).toBe(titleSeq("\u{1F431} my task"));   // the cat returns at once
    if (process.platform === "win32") {
      await new Promise((r) => setTimeout(r, 1150));
      expect(writes.filter((w) => w === titleSeq("\u{1F431} my task")).length).toBeGreaterThanOrEqual(2); // keeper re-assert
    }
  } finally {
    stopTitleDriver();
    (process.stdout as any).write = orig; (process.stdout as any).isTTY = origTTY;
  }
}, 15000);

test("title stack push is SKIPPED on Windows (its restore reverts the tab mid-session)", async () => {
  const { saveTitle } = await import("../src/ui/title.ts");
  const writes: string[] = [];
  const orig = process.stdout.write, origTTY = (process.stdout as any).isTTY;
  (process.stdout as any).isTTY = true;
  (process.stdout as any).write = (s: any) => { writes.push(String(s)); return true; };
  try {
    saveTitle();
    if (process.platform === "win32") expect(writes.join("")).toBe("");           // no push -> nothing to revert to
    else expect(writes.join("")).toBe("\x1b[22;0t");                              // other terminals still get the stack
  } finally {
    (process.stdout as any).write = orig; (process.stdout as any).isTTY = origTTY;
  }
});

test("DISABLE_MOUSE resets EVERY standard mouse mode (not just the 3 we enable) - stale-mode safety", async () => {
  const { DISABLE_MOUSE, ENABLE_MOUSE } = await import("../src/ui/mouse.ts");
  for (const mode of [1000, 1002, 1003, 1005, 1006, 1015, 1016]) {
    expect(DISABLE_MOUSE).toContain(`\x1b[?${mode}l`); // every mode gets an explicit reset
  }
  // We only ENABLE the three we actually use.
  expect(ENABLE_MOUSE).toBe("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
});
