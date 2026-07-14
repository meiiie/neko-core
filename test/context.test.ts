import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_GLOBAL_NEKO_MD,
  ensureGlobalNekoMd,
  environmentBlock,
  globalNekoMdPath,
  loadProjectContext,
  rememberNote,
} from "../src/adapters/context.ts";

test("global Neko Core identity creates once, stays compact, and never overwrites user edits", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-identity-"));
  const first = ensureGlobalNekoMd(home);
  expect(first.created).toBe(true);
  expect(first.error).toBeUndefined();
  expect(first.path).toBe(globalNekoMdPath(home));
  const initial = readFileSync(first.path, "utf-8");
  expect(initial).toBe(DEFAULT_GLOBAL_NEKO_MD);
  expect(initial).toContain("# Neko Core");
  expect(initial).toContain("## Life story");
  expect(initial).toContain("not a claim of biological life or proven consciousness");
  expect(initial).not.toContain("## Memory"); // mutable observations live outside the identity
  expect(initial.length).toBeLessThan(4_000);

  writeFileSync(first.path, "# My edited Neko\n", "utf-8");
  const second = ensureGlobalNekoMd(home);
  expect(second.created).toBe(false);
  expect(readFileSync(first.path, "utf-8")).toBe("# My edited Neko\n");
});

test("cross-project memory stays separate from the global life story", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-identity-memory-"));
  const state = ensureGlobalNekoMd(home);
  expect(rememberNote("The user prefers concise Vietnamese.", "user", home)).toContain("memory/user.md");
  expect(readFileSync(state.path, "utf-8")).toBe(DEFAULT_GLOBAL_NEKO_MD);
  expect(readFileSync(join(home, ".neko-core", "memory", "user.md"), "utf-8")).toContain("The user prefers concise Vietnamese.");
});

test("loads NEKO.md from the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ctx-"));
  mkdirSync(join(root, ".git")); // mark a repo root so the walk stops here
  writeFileSync(join(root, "NEKO.md"), "hello project context");
  const files = loadProjectContext(root);
  expect(files.some((f) => f.text.includes("hello project context"))).toBe(true);
});

test("loads AGENTS.md project instructions for Codex-compatible repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-agents-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), "AGENT RULE: keep changes surgical");
  const files = loadProjectContext(root);
  expect(files.some((f) => f.path.endsWith("AGENTS.md") && f.text.includes("AGENT RULE"))).toBe(true);
});

test("context source contains no literal NUL byte (keeps text tools working)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "adapters", "context.ts"), "utf-8");
  expect(source).not.toContain("\u0000");
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
