import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSkill } from "../src/adapters/skills.ts";

const SCRIPT = join(import.meta.dir, "..", "skills", "browser-visual-qa", "scripts", "extract-frames.ts");
const run = (args: string[], cwd: string) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf-8" });

test("browser-visual-qa skill is discoverable with its workflow body", () => {
  const s = loadSkill("browser-visual-qa");
  expect(s).not.toBeNull();
  expect(s!.body).toContain("Browser visual QA");
  expect(s!.body).toContain("read_file"); // the analyze-with-vision step
});

test("extract-frames: usage error with no video", () => {
  const r = run([], tmpdir());
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("usage");
});

test("extract-frames: clear error on a missing video", () => {
  const r = run(["nope.mp4"], tmpdir());
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("no such video");
});

test("extract-frames: splits a real video into PNG frames (ffmpeg)", () => {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) return; // where ffmpeg is absent the script exits 3 with a clear message instead
  const dir = mkdtempSync(join(tmpdir(), "bvqa-"));
  const gen = spawnSync(ffmpeg, ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=4", "-y", join(dir, "v.mp4")], { encoding: "utf-8" });
  expect(gen.status).toBe(0);
  const r = run([join(dir, "v.mp4"), join(dir, "frames"), "2"], dir);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Extracted");
  expect(readdirSync(join(dir, "frames")).filter((f) => f.endsWith(".png")).length).toBeGreaterThan(0);
});
