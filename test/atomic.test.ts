import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile, atomicWriteFileSync } from "../src/shared/atomic.ts";

test("atomicWriteFileSync writes the content and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "nk-atomic-"));
  const p = join(dir, "session.json");
  atomicWriteFileSync(p, '{"ok":true}');
  expect(readFileSync(p, "utf-8")).toBe('{"ok":true}');
  // no leftover *.tmp-* sibling
  expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("atomicWriteFileSync replaces an existing file (the all-or-nothing rename)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nk-atomic-"));
  const p = join(dir, "config.json");
  writeFileSync(p, '{"api_key":"OLD"}', "utf-8");
  atomicWriteFileSync(p, '{"api_key":"NEW","model":"m"}');
  expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ api_key: "NEW", model: "m" });
});

test("a failed write (bad target dir) does NOT corrupt the existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "nk-atomic-"));
  const p = join(dir, "keep.json");
  writeFileSync(p, "ORIGINAL", "utf-8");
  // target inside a non-existent subdir -> the temp write throws; the original must be untouched.
  expect(() => atomicWriteFileSync(join(dir, "nope", "x.json"), "X")).toThrow();
  expect(readFileSync(p, "utf-8")).toBe("ORIGINAL");
  expect(existsSync(join(dir, "nope"))).toBe(false);
});

test("async atomic publication checks ownership after staging and preserves the target on refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nk-atomic-fenced-"));
  const path = join(dir, "session.json");
  try {
    writeFileSync(path, "ORIGINAL");
    await atomicWriteFile(path, "OWNED", undefined, () => {
      expect(readFileSync(path, "utf8")).toBe("ORIGINAL");
      expect(readdirSync(dir).some((file) => file.includes(".tmp-"))).toBe(true);
    });
    await expect(atomicWriteFile(path, "STALE", undefined, () => {
      throw new Error("lost its writer lock");
    })).rejects.toThrow("lost its writer lock");
    expect(readFileSync(path, "utf8")).toBe("OWNED");
    expect(readdirSync(dir)).toEqual(["session.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
