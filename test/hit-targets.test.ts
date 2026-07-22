import { expect, test } from "bun:test";

import { hitIndexAt, setHitTargets } from "../src/ui/hit-targets.ts";

test("hitIndexAt returns the zone whose row matches and whose start col is at/left of x", () => {
  setHitTargets([
    { row: 5, col: 2 },  // zone 0: cols 2..
    { row: 5, col: 12 }, // zone 1: cols 12..
    { row: 6, col: 4 },  // zone 2: another row
  ]);
  expect(hitIndexAt(5, 5)).toBe(0);   // inside zone 0 (before zone 1 starts)
  expect(hitIndexAt(15, 5)).toBe(1);  // past zone 1's start -> zone 1
  expect(hitIndexAt(2, 5)).toBe(0);   // exactly at zone 0 start
  expect(hitIndexAt(1, 5)).toBe(-1);  // left of every zone on the row
  expect(hitIndexAt(10, 6)).toBe(2);  // different row
  expect(hitIndexAt(10, 9)).toBe(-1); // no zone on this row
});

test("setHitTargets replaces (a dismissed surface leaves nothing clickable)", () => {
  setHitTargets([{ row: 1, col: 1 }]);
  setHitTargets([]);
  expect(hitIndexAt(1, 1)).toBe(-1);
});
