import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPrefs, savePrefs } from "../src/adapters/prefs.ts";
import { fmtAge } from "../src/ui/format.ts";

// Isolate from the user's real ~/.neko-core/prefs.json (these tests WRITE it). See session.test.ts.
const TEST_HOME = mkdtempSync(join(tmpdir(), "neko-prefs-home-"));
const SAVED = { up: process.env.USERPROFILE, home: process.env.HOME };
beforeAll(() => { process.env.USERPROFILE = TEST_HOME; process.env.HOME = TEST_HOME; });
afterAll(() => {
  process.env.USERPROFILE = SAVED.up; process.env.HOME = SAVED.home;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test("prefs: missing file reads as empty defaults", () => {
  expect(loadPrefs()).toEqual({});
});

test("prefs: save / load round-trip and merge", () => {
  savePrefs({ resumeAlwaysFull: true });
  expect(loadPrefs().resumeAlwaysFull).toBe(true);
  // A patch merges, it doesn't clobber other keys.
  savePrefs({});
  expect(loadPrefs().resumeAlwaysFull).toBe(true);
});

test("fmtAge: compact d/h/m formatting", () => {
  const ago = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();
  expect(fmtAge(ago(6 * 86400 + 23 * 3600))).toContain("6d");
  expect(fmtAge(ago(3 * 3600 + 5 * 60))).toContain("3h");
  expect(fmtAge(ago(12 * 60))).toBe("12m");
  expect(fmtAge("")).toBe("");
});
