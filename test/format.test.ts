import { expect, test } from "bun:test";

import { elideCommonEnds, expandTabs } from "../src/ui/format.ts";

test("expandTabs turns hard tabs into spaces at tab stops", () => {
  expect(expandTabs("\tconst")).toBe("    const");
  expect(expandTabs("x\ty", 4)).toBe("x   y"); // col 1 -> pad 3 to reach stop 4
  expect(expandTabs("abcd\ty", 4)).toBe("abcd    y");
});

test("expandTabs drops CR so CRLF source cannot rewind the cursor", () => {
  expect(expandTabs("\thello\r")).toBe("    hello");
  expect(expandTabs("a\tb\nc\td")).toBe("a   b\nc   d");
});

test("elideCommonEnds drops identical anchors when appending after a function", () => {
  const oldText = [
    "export function clamp(n, lo, hi) {",
    "  if (n < lo) return lo;",
    "  if (n > hi) return hi;",
    "  return n;",
    "}",
  ].join("\n");
  const newText = oldText + "\n\nexport function range(xs) {\n  return [xs[0], xs[0]];\n}";
  const r = elideCommonEnds(oldText, newText, 1);
  expect(r.elidedHead).toBeGreaterThan(0);
  // Shared clamp body is elided; only 1 context line kept from the common prefix.
  expect(r.oldText).not.toContain("if (n < lo) return lo;");
  expect(r.newText).toContain("export function range");
  expect(r.newText).toContain("}"); // trailing context from the shared prefix
});

test("elideCommonEnds leaves unrelated sides alone", () => {
  const r = elideCommonEnds("alpha\nbeta", "gamma\ndelta", 1);
  expect(r.elidedHead).toBe(0);
  expect(r.elidedTail).toBe(0);
  expect(r.oldText).toBe("alpha\nbeta");
  expect(r.newText).toBe("gamma\ndelta");
});

test("elideCommonEnds leaves identical sides alone", () => {
  const same = "a\nb\nc";
  const r = elideCommonEnds(same, same, 1);
  expect(r.elidedHead).toBe(0);
  expect(r.oldText).toBe(same);
});
