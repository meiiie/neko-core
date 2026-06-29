import { expect, test } from "bun:test";

import { parseVnd } from "../skills/procurement/scripts/price-table.ts";

// The whole point of moving number-handling out of the LLM: it's now DETERMINISTIC, so it's unit-testable.
// These are the exact shapes that made gpt-oss misparse during dogfooding.
test("parseVnd reads Vietnamese prices deterministically (no LLM misparse)", () => {
  expect(parseVnd("31.990.000đ")).toBe(31990000);            // the famous misparse -> NOT 31
  expect(parseVnd("24.990.000 ₫")).toBe(24990000);
  expect(parseVnd("1.250.000 VND")).toBe(1250000);
  expect(parseVnd("12,5 triệu")).toBe(12500000);             // unit multiplier (comma decimal)
  expect(parseVnd("12tr")).toBe(12000000);
  expect(parseVnd("990k")).toBe(990000);
  expect(parseVnd("9.450.000 - 12.100.000")).toBe(9450000);  // range -> LOW end
  expect(parseVnd(24990000)).toBe(24990000);                 // already a number
});

test("parseVnd returns null for no-price text (so the agent sees a flagged gap, not a fake 0)", () => {
  for (const v of ["Liên hệ", "đang cập nhật", "", "  ", null, undefined]) expect(parseVnd(v)).toBeNull();
});
