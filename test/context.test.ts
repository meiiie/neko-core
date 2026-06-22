import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";

import { environmentBlock, loadProjectContext, rememberNote } from "../src/adapters/context.ts";

test("loads NEKO.md from the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ctx-"));
  mkdirSync(join(root, ".git")); // mark a repo root so the walk stops here
  writeFileSync(join(root, "NEKO.md"), "hello project context");
  const files = loadProjectContext(root);
  expect(files.some((f) => f.text.includes("hello project context"))).toBe(true);
});

test("expands @import references inline", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-imp-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "shared.md"), "SHARED RULES");
  writeFileSync(join(root, "NEKO.md"), "Project. See @shared.md");
  const files = loadProjectContext(root);
  expect(files.some((f) => f.text.includes("SHARED RULES"))).toBe(true);
});

test("environmentBlock reports the working directory + model", () => {
  const env = environmentBlock({ model: "m1", provider: "p1" });
  expect(env).toContain("Working directory:");
  expect(env).toContain("Model: m1 (p1)");
});

test("rememberNote appends under a Memory section (newest first)", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-mem-"));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    rememberNote("first note");
    rememberNote("second note");
    const md = readFileSync(join(root, "NEKO.md"), "utf-8");
    expect(md).toContain("## Memory");
    expect(md.indexOf("second note")).toBeLessThan(md.indexOf("first note")); // newest first
  } finally {
    process.chdir(cwd);
  }
});
