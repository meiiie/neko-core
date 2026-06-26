import { expect, test } from "bun:test";

import { assetName, isNewer } from "../src/adapters/update.ts";

test("isNewer compares versions numerically, ignoring a leading v", () => {
  expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
  expect(isNewer("0.2.1", "0.2.0")).toBe(true);
  expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("0.2.10", "0.2.9")).toBe(true); // numeric, not lexical
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  expect(isNewer("v0.2.0", "v0.2.0")).toBe(false);
});

test("assetName picks the right release asset per platform/arch (matches release.yml)", () => {
  expect(assetName("win32", "x64")).toBe("neko-windows-x64.exe");
  expect(assetName("darwin", "arm64")).toBe("neko-macos-arm64");
  expect(assetName("darwin", "x64")).toBe("neko-macos-x64");
  expect(assetName("linux", "x64")).toBe("neko-linux-x64");
  expect(assetName("linux", "arm64")).toBe("neko-linux-arm64");
});
