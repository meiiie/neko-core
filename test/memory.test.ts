import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listMemories, memoryIndexBlock, memoryTool } from "../src/core/memory.ts";

// memory.ts resolves ~/.neko-core/memory via homedir(); point HOME at a temp dir per test.
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});
function freshHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nk-mem-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  return tmp;
}

test("memory write -> read round-trip", () => {
  freshHome();
  expect(memoryTool({ action: "write", name: "prefs", content: "# User prefers Bun + TypeScript\nNo semicolons." }))
    .toContain("Saved memory 'prefs.md'");
  expect(memoryTool({ action: "read", name: "prefs" })).toContain("prefers Bun");
});

test("list + index block surface saved memories with a summary", () => {
  freshHome();
  memoryTool({ action: "write", name: "prefs", content: "# User prefers Bun" });
  memoryTool({ action: "write", name: "stack", content: "# Project uses Ink + React 19" });
  expect(listMemories().map((m) => m.name).sort()).toEqual(["prefs.md", "stack.md"]);
  const block = memoryIndexBlock();
  expect(block).toContain("Saved memories");
  expect(block).toContain("prefs.md: User prefers Bun");
  expect(block).toContain("stack.md: Project uses Ink + React 19");
});

test("search finds a memory by content", () => {
  freshHome();
  memoryTool({ action: "write", name: "deploy", content: "# Deploy via bun build --compile" });
  expect(memoryTool({ action: "search", query: "compile" })).toContain("deploy.md");
  expect(memoryTool({ action: "search", query: "kubernetes" })).toContain("no memory matches");
});

test("delete removes a memory", () => {
  freshHome();
  memoryTool({ action: "write", name: "tmp", content: "x" });
  expect(memoryTool({ action: "delete", name: "tmp" })).toContain("Deleted");
  expect(listMemories()).toHaveLength(0);
});

test("names are confined to the memory dir (no path escape)", () => {
  const home = freshHome();
  memoryTool({ action: "write", name: "../../escape", content: "nope" });
  // nothing written outside the memory dir
  expect(existsSync(join(home, "escape"))).toBe(false);
  expect(existsSync(join(home, "escape.md"))).toBe(false);
  // the file landed inside the memory dir under a sanitized name
  const files = readdirSync(join(home, ".neko-core", "memory"));
  expect(files.every((f) => f.endsWith(".md"))).toBe(true);
  expect(files.some((f) => f.includes("/") || f.includes("\\"))).toBe(false);
});

test("empty index block when there are no memories", () => {
  freshHome();
  expect(memoryIndexBlock()).toBe("");
  expect(memoryTool({ action: "list" })).toBe("(no memories yet)");
});
