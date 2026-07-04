import { expect, test } from "bun:test";
import { isMouseEnabled, parseClick, parseLastPointer, parseWheelAll } from "../src/ui/mouse.ts";

test("parseLastPointer: last event of a burst wins; kinds classified (move/press/release/wheel)", () => {
  expect(parseLastPointer("\x1b[<35;10;5M")).toEqual({ x: 10, y: 5, kind: "move" });     // any-motion, no button
  expect(parseLastPointer("\x1b[<32;4;6M")).toEqual({ x: 4, y: 6, kind: "move" });       // motion + left held
  expect(parseLastPointer("\x1b[<0;7;8M")).toEqual({ x: 7, y: 8, kind: "press" });
  expect(parseLastPointer("\x1b[<0;7;8m")).toEqual({ x: 7, y: 8, kind: "release" });
  expect(parseLastPointer("\x1b[<64;1;2M")).toEqual({ x: 1, y: 2, kind: "wheel" });
  expect(parseLastPointer("[<35;1;1M[<35;9;9M")).toEqual({ x: 9, y: 9, kind: "move" });  // burst: LAST position
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
