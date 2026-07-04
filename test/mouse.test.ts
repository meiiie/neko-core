import { expect, test } from "bun:test";
import { isMouseEnabled, parseClick, parseWheelAll } from "../src/ui/mouse.ts";

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
