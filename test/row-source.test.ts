import { expect, test } from "bun:test";
import { CombinedRows, mapRows, type RowSource } from "../src/ui/row-source.ts";

test("a million-row history materializes only the requested viewport", () => {
  let reads = 0;
  const virtual: RowSource = { length: 1_000_000, at: (i) => { reads++; return `ROW_${i}`; }, slice: () => { throw new Error("No whole-source read"); } };
  const joined = new CombinedRows([["header"], virtual, ["live"]]);
  const padded = mapRows(joined, (row) => `  ${row}`);
  expect(padded.slice(500_000,500_030)).toHaveLength(30);
  expect(reads).toBe(30);
  expect(joined.at(-1)).toBe("live");
});

test("warm-cache buckets follow the actual top row at Home and block boundaries", async () => {
  const {visibleLineBucket} = await import("../src/ui/scroll.tsx");
  const spans = Array.from({length: 320}, (_, i) => ({line: {id: i, kind: "assistant" as const, text: ""}, start: i * 3, end: i * 3 + 3}));
  expect(visibleLineBucket(spans, 0)).toBe(0);
  expect(visibleLineBucket(spans, 119)).toBe(0);
  expect(visibleLineBucket(spans, 120)).toBe(1);
  expect(visibleLineBucket(spans, 959)).toBe(7);
  expect(visibleLineBucket([], 0)).toBe(0);
});
