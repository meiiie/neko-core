import { expect, test } from "bun:test";

import { expandTabs } from "../src/ui/format.ts";

test("expandTabs turns hard tabs into spaces at tab stops", () => {
  expect(expandTabs("\tconst")).toBe("    const");
  expect(expandTabs("x\ty", 4)).toBe("x   y"); // col 1 -> pad 3 to reach stop 4
  expect(expandTabs("abcd\ty", 4)).toBe("abcd    y");
});

test("expandTabs drops CR so CRLF source cannot rewind the cursor", () => {
  expect(expandTabs("\thello\r")).toBe("    hello");
  expect(expandTabs("a\tb\nc\td")).toBe("a   b\nc   d");
});
