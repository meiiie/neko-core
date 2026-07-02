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

// The env block sits at the HEAD of the system prompt: any per-turn variation (a dirty-file count
// that flips on every edit) invalidates the provider's prompt-prefix cache for the whole
// conversation, every turn. So it is a session-start SNAPSHOT: byte-identical across calls, no
// live git churn, and labeled so the model knows to run `git status` itself for fresh state.
test("environmentBlock is a byte-stable session snapshot (no per-turn volatile fields)", () => {
  const a = environmentBlock({ model: "m1", provider: "p1" });
  const b = environmentBlock({ model: "m1", provider: "p1" });
  expect(b).toBe(a); // byte-identical across turns -> the prompt prefix stays cacheable
  expect(a).not.toContain("uncommitted"); // the old dirty-count churned on every edit
  expect(a).toContain("snapshot"); // labeled, so the model fetches live state via tools
  expect(environmentBlock({ model: "m2", provider: "p1" })).toContain("Model: m2"); // a model switch DOES refresh it
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
