import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCoreMemory,
  coreMemoryBlock,
  ensureCoreMemories,
  listMemories,
  memoryEnabled,
  memoryIndexBlock,
  memoryTool,
  setMemoryEnabled,
} from "../src/core/memory.ts";

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

test("core user/self memory scaffolds once and never overwrites edits", () => {
  const home = freshHome();
  const first = ensureCoreMemories(home);
  expect(first.created.sort()).toEqual(["self.md", "user.md"]);
  const user = join(home, ".neko-core", "memory", "user.md");
  writeFileSync(user, "# User model\n\n- custom\n", "utf-8");
  expect(ensureCoreMemories(home).created).toHaveLength(0);
  expect(readFileSync(user, "utf-8")).toContain("- custom");
});

test("core memory injects only a bounded recent set of observation bullets", () => {
  freshHome();
  for (let i = 0; i < 12; i++) appendCoreMemory("user", `preference number ${i}`);
  appendCoreMemory("self", "UIA actions need postcondition verification");
  const block = coreMemoryBlock();
  expect(block).toContain("preference number 11");
  expect(block).not.toContain("preference number 0");
  expect(block).toContain("UIA actions need postcondition verification");
  expect(block.length).toBeLessThan(5_000);
  expect(memoryIndexBlock()).toBe(""); // core profiles are not duplicated in the archival index
});

test("core memory does not duplicate the same observation across dates", () => {
  const home = freshHome();
  ensureCoreMemories(home);
  const user = join(home, ".neko-core", "memory", "user.md");
  writeFileSync(user, "# User model\n\n## Observations\n- [explicit 2025-01-01] prefers Vietnamese\n", "utf-8");
  expect(appendCoreMemory("user", "prefers Vietnamese", home)).toContain("already remembered");
  expect(readFileSync(user, "utf-8").match(/prefers Vietnamese/g)).toHaveLength(1);
});

test("memory off keeps local files but disables recall and tool access until re-enabled", () => {
  const home = freshHome();
  appendCoreMemory("user", "prefers Vietnamese");
  expect(memoryEnabled(home)).toBe(true);
  expect(setMemoryEnabled(false, home)).toContain("off");
  expect(coreMemoryBlock(home)).toBe("");
  expect(memoryTool({ action: "read", name: "user" })).toContain("Memory is off");
  expect(readFileSync(join(home, ".neko-core", "memory", "user.md"), "utf-8")).toContain("prefers Vietnamese");
  expect(setMemoryEnabled(true, home)).toContain("on");
  expect(coreMemoryBlock(home)).toContain("prefers Vietnamese");
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

test("search ranks token and accent matches instead of requiring one exact substring", () => {
  freshHome();
  memoryTool({ action: "write", name: "language", content: "# Vietnamese output\nNguoi dung thich cau tra loi ngan gon." });
  memoryTool({ action: "write", name: "runtime", content: "# Bun TypeScript runtime" });
  expect(memoryTool({ action: "search", query: "người dùng ngắn gọn" })).toContain("language.md");
  expect(memoryTool({ action: "search", query: "typescript bun" })).toContain("runtime.md");
});

test("append adds one memory bullet without replacing the file", () => {
  freshHome();
  memoryTool({ action: "write", name: "prefs", content: "# Preferences\n" });
  expect(memoryTool({ action: "append", name: "prefs", content: "Use Bun" })).toContain("Appended");
  expect(memoryTool({ action: "read", name: "prefs" })).toContain("# Preferences\n- Use Bun");
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
