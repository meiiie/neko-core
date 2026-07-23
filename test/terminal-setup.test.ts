import { expect, test } from "bun:test";

import { patchSettings, SHIFT_ENTER_INPUT, stripJsonc } from "../src/adapters/terminal-setup.ts";

test("SHIFT_ENTER_INPUT is exactly ESC + CR (what Ink reads as return+meta)", () => {
  expect([...SHIFT_ENTER_INPUT].map((c) => c.charCodeAt(0))).toEqual([0x1b, 0x0d]);
});

test("stripJsonc removes comments and trailing commas but never touches string contents", () => {
  const src = `{
    // a line comment
    "a": 1, /* block */
    "url": "https://x.com/y", // keep the // inside the string
    "arr": [1, 2,],
  }`;
  const obj = JSON.parse(stripJsonc(src));
  expect(obj).toEqual({ a: 1, url: "https://x.com/y", arr: [1, 2] });
});

test("patchSettings adds the shift+enter action to a clean file", () => {
  const { out, note } = patchSettings('{ "actions": [] }');
  expect(note).toContain("added");
  const obj = JSON.parse(out!);
  expect(obj.actions).toHaveLength(1);
  expect(obj.actions[0].keys).toBe("shift+enter");
  expect(obj.actions[0].command.input).toBe(SHIFT_ENTER_INPUT);
});

test("patchSettings creates the actions array when absent", () => {
  const obj = JSON.parse(patchSettings('{ "theme": "dark" }').out!);
  expect(obj.actions[0].keys).toBe("shift+enter");
  expect(obj.theme).toBe("dark");
});

test("patchSettings is idempotent - never double-adds", () => {
  const first = patchSettings('{ "actions": [] }').out!;
  expect(patchSettings(first).out).toBeUndefined();
  expect(patchSettings(first).note).toContain("already exists");
});

test("patchSettings refuses an unparseable file instead of corrupting it", () => {
  const { out, note } = patchSettings('{ "actions": [ this is not json ] }');
  expect(out).toBeUndefined();
  expect(note).toContain("could not parse");
});
