import { expect, test } from "bun:test";
import { isMouseEnabled, parseWheel } from "../src/ui/mouse.ts";

test("parseWheel: SGR wheel up/down, ignoring clicks and modifiers", () => {
  expect(parseWheel("\x1b[<64;10;5M")).toBe("up");
  expect(parseWheel("\x1b[<65;10;5M")).toBe("down");
  expect(parseWheel("\x1b[<0;10;5M")).toBe(null);   // left click, not a wheel
  expect(parseWheel("\x1b[<2;10;5M")).toBe(null);   // right click
  expect(parseWheel("\x1b[<68;10;5M")).toBe("up");  // wheel-up + shift (bit 4)
  expect(parseWheel("\x1b[<81;10;5M")).toBe("down"); // wheel-down + ctrl (64+16+1)
  expect(parseWheel("hello")).toBe(null);
  expect(parseWheel("\x1b[A")).toBe(null);          // arrow key, not mouse
  expect(parseWheel("[<64;10;5M")).toBe("up");      // ESC stripped by Ink -> still parsed
  expect(parseWheel("[<65;10;5M")).toBe("down");
});

test("isMouseEnabled: on by default, off with NEKO_DISABLE_MOUSE", () => {
  expect(isMouseEnabled({} as any)).toBe(true);
  expect(isMouseEnabled({ NEKO_DISABLE_MOUSE: "1" } as any)).toBe(false);
  expect(isMouseEnabled({ NEKO_DISABLE_MOUSE: "true" } as any)).toBe(false);
});
