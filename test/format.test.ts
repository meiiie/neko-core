import { expect, test } from "bun:test";

import { elideCommonEnds, expandTabs, isTrivialContextLine } from "../src/ui/format.ts";

test("isTrivialContextLine marks braces and blanks only", () => {
  expect(isTrivialContextLine("}")).toBe(true);
  expect(isTrivialContextLine("  ")).toBe(true);
  expect(isTrivialContextLine("  return n;")).toBe(false);
  expect(isTrivialContextLine("export function clamp(n, lo, hi) {")).toBe(false);
});


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
  // Shared clamp body is fully dropped beyond dim context; mid is additions only.
  expect(r.oldText).toBe("");
  // Lone `}` is weak — widen so the user sees which function they are appending after.
  expect(r.headContext).toContain("return n;");
  expect(r.headContext).toContain("}");
  expect(r.newText).toContain("export function range");
  expect(r.newText).not.toMatch(/^-/); // mid must not restate the context brace as a -/+ side
  expect(r.newText.startsWith("\n") || r.newText.startsWith("export")).toBe(true);
});

test("elideCommonEnds widens trivial head context past a closing brace", () => {
  const oldText = [
    "export function truncate(s, max) {",
    "  return t.slice(0, max - 3) + \"...\";",
    "}",
  ].join("\n");
  const newText = oldText + "\n\nexport function startsWith(s, prefix) {\n  return true;\n}\n";
  const r = elideCommonEnds(oldText, newText, 1);
  expect(r.oldText).toBe("");
  expect(r.headContext).toContain("return t.slice");
  expect(r.headContext.split("\n").at(-1)).toBe("}");
  expect(r.newText).toContain("export function startsWith");
});

test("elideCommonEnds mid-only append after a single shared line (multi_edit-style)", () => {
  const oldText = 'assert(JSON.stringify(chunk([1, 2], 2)) === "[[1,2]]", "chunk");';
  const newText = oldText + '\nassert(JSON.stringify(groupBy([], x => x)) === "{}", "groupBy empty");';
  const r = elideCommonEnds(oldText, newText, 1);
  expect(r.elidedHead).toBe(0);
  expect(r.headContext).toBe(oldText);
  expect(r.oldText).toBe("");
  expect(r.newText).toContain("groupBy empty");
  expect(r.newText).not.toContain("chunk");
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
