import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCoreMemory,
  coreMemoryBlock,
  importLegacyMemory,
  listMemories,
  memoryIndexBlock,
  memoryTool,
  readMemoryFile,
  setMemoryEnabled,
} from "../src/core/memory.ts";
import { createTaskScope } from "../src/core/task-scope.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-task-memory-"));
  const rootA = join(home, "a", "app");
  const rootB = join(home, "b", "app");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  return {
    home,
    rootA,
    rootB,
    a: createTaskScope("task-a", rootA),
    b: createTaskScope("task-b", rootB),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("task admission isolates same-name memories across same-basename roots and every tool path", () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "config", content: "# Use pnpm in A" }, f.home, f.a);
    memoryTool({ action: "write", name: "config", content: "# Use bun in B" }, f.home, f.b);
    expect(memoryTool({ action: "read", name: "config", taskId: "task-b" }, f.home, f.a)).toContain("pnpm in A");
    expect(memoryTool({ action: "read", name: "config" }, f.home, f.b)).toContain("bun in B");
    expect(memoryTool({ action: "search", query: "bun" }, f.home, f.a)).not.toContain("config.md");
    expect(memoryTool({ action: "search", query: "pnpm" }, f.home, f.b)).not.toContain("config.md");
    expect(memoryTool({ action: "list" }, f.home, f.a)).toContain("config.md: Use pnpm in A");
    expect(memoryIndexBlock(f.home, f.b)).toContain("config.md: Use bun in B");
    expect(listMemories(f.home, f.a)).toEqual([{ name: "config.md", summary: "Use pnpm in A" }]);
    expect(readMemoryFile("config", f.home, f.b)).toContain("bun in B");

    memoryTool({ action: "append", name: "config", content: "Only A" }, f.home, f.a);
    expect(readMemoryFile("config", f.home, f.a)).toContain("Only A");
    expect(readMemoryFile("config", f.home, f.b)).not.toContain("Only A");
    memoryTool({ action: "delete", name: "config" }, f.home, f.a);
    expect(readMemoryFile("config", f.home, f.a)).toContain("no memory");
    expect(readMemoryFile("config", f.home, f.b)).toContain("bun in B");
  } finally {
    f.cleanup();
  }
});

test("legacy memory stays excluded until trusted explicit import-copy with digest", () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "config", content: "# Legacy uses npm" }, f.home);
    expect(memoryTool({ action: "read", name: "config" }, f.home, f.a)).toContain("no memory");
    expect(memoryTool({ action: "list" }, f.home, f.a)).toBe("(no memories yet)");
    expect(memoryTool({ action: "search", query: "npm" }, f.home, f.a)).toContain("no memory matches");
    expect(memoryIndexBlock(f.home, f.a)).toBe("");
    expect(memoryTool({ action: "import", name: "config", taskId: "task-a" }, f.home, f.a)).toContain("Error");

    const imported = importLegacyMemory("config", f.home, f.a);
    expect(imported.sourceDigest).toBe(createHash("sha256").update("# Legacy uses npm").digest("hex"));
    expect(readMemoryFile("config", f.home, f.a)).toBe("# Legacy uses npm");
    expect(readMemoryFile("config", f.home, f.b)).toContain("no memory");
    expect(readMemoryFile("config", f.home)).toBe("# Legacy uses npm");
    const taskDir = join(f.home, ".neko-core", "memory", "tasks", createHash("sha256").update("task-a").digest("hex"));
    const persisted = JSON.parse(readFileSync(join(taskDir, ".imports", "config.md.json"), "utf-8"));
    expect(persisted.sourceDigest).toBe(imported.sourceDigest);
    expect(persisted.source).toBe("legacy:config.md");
    expect(() => importLegacyMemory("config", f.home, f.a)).toThrow();
  } finally {
    f.cleanup();
  }
});

test("root binding rejects task id reuse in a different root but accepts lexical alias", () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "config", content: "# A" }, f.home, f.a);
    const alias = createTaskScope("task-a", join(f.rootA, ".", "sub", ".."));
    expect(readMemoryFile("config", f.home, alias)).toBe("# A");
    const linkedRoot = join(f.home, "linked-a");
    symlinkSync(f.rootA, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    expect(readMemoryFile("config", f.home, createTaskScope("task-a", linkedRoot))).toBe("# A");
    if (process.platform === "win32") {
      expect(readMemoryFile("config", f.home, createTaskScope("task-a", f.rootA.toUpperCase()))).toBe("# A");
    }
    expect(() => memoryTool({ action: "read", name: "config" }, f.home, createTaskScope("task-a", f.rootB))).toThrow(/root/i);
  } finally {
    f.cleanup();
  }
});

test("spread or model-shaped scope cannot borrow runtime authority", () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "config", content: "# B" }, f.home, f.b);
    const forged = { ...f.a, id: f.b.id, canonicalRoot: f.b.canonicalRoot, storageKey: f.b.storageKey };
    expect(() => memoryTool({ action: "read", name: "config" }, f.home, forged)).toThrow(/runtime/);
    expect(() => memoryTool({ action: "read", name: "config" }, f.home, JSON.parse(JSON.stringify(f.b)))).toThrow(/runtime/);
    expect(readMemoryFile("config", f.home, f.a)).toContain("no memory");
  } finally {
    f.cleanup();
  }
});

test("an existing scoped directory without root binding is never adopted", () => {
  const f = fixture();
  try {
    const taskDir = join(f.home, ".neko-core", "memory", "tasks", f.a.storageKey);
    mkdirSync(taskDir, { recursive: true });
    expect(() => memoryTool({ action: "write", name: "config", content: "# A" }, f.home, f.a)).toThrow(/binding is missing/);
    expect(() => memoryTool({ action: "read", name: "config" }, f.home, f.a)).toThrow(/binding is missing/);
    expect(existsSync(join(taskDir, "config.md"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("core, index, and scoped writes respect global disabled flag", () => {
  const f = fixture();
  try {
    appendCoreMemory("user", "A uses pnpm", f.home, f.a);
    expect(coreMemoryBlock(f.home, f.a)).toContain("A uses pnpm");
    expect(coreMemoryBlock(f.home, f.b)).not.toContain("A uses pnpm");
    setMemoryEnabled(false, f.home);
    expect(coreMemoryBlock(f.home, f.a)).toBe("");
    expect(memoryIndexBlock(f.home, f.a)).toBe("");
    expect(listMemories(f.home, f.a)).toEqual([]);
    expect(memoryTool({ action: "write", name: "new", content: "x" }, f.home, f.a)).toContain("Memory is off");
    expect(memoryTool({ action: "read", name: "user" }, f.home, f.a)).toContain("Memory is off");
    expect(existsSync(join(f.home, ".neko-core", "memory", "tasks", createHash("sha256").update("task-a").digest("hex"), "new.md"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("a dangling scoped file link cannot send write or append outside its task", () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "seed", content: "# Seed" }, f.home, f.a);
    const taskDir = join(f.home, ".neko-core", "memory", "tasks", createHash("sha256").update("task-a").digest("hex"));
    const outside = join(f.home, "outside.md");
    symlinkSync(outside, join(taskDir, "config.md"), "file");
    expect(() => memoryTool({ action: "write", name: "config", content: "escaped" }, f.home, f.a)).toThrow(/regular/);
    expect(() => memoryTool({ action: "append", name: "config", content: "escaped" }, f.home, f.a)).toThrow(/regular/);
    expect(existsSync(outside)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("an intermediate scoped directory link is rejected before creating outside files", () => {
  const f = fixture();
  try {
    const memoryDir = join(f.home, ".neko-core", "memory");
    const outside = join(f.home, "outside");
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(memoryDir, "tasks"), process.platform === "win32" ? "junction" : "dir");
    expect(() => memoryTool({ action: "write", name: "config", content: "escaped" }, f.home, f.a)).toThrow(/directory/);
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("a hardlinked scoped file cannot import or mutate bytes outside its task", () => {
  const f = fixture();
  try {
    memoryTool({ action: "write", name: "seed", content: "# Seed" }, f.home, f.a);
    const taskDir = join(f.home, ".neko-core", "memory", "tasks", createHash("sha256").update("task-a").digest("hex"));
    const original = "# B only";
    memoryTool({ action: "write", name: "config", content: original }, f.home, f.b);
    const bDir = join(f.home, ".neko-core", "memory", "tasks", createHash("sha256").update("task-b").digest("hex"));
    // Same-volume temp paths make an actual multi-link inode, not a symbolic link.
    linkSync(join(bDir, "config.md"), join(taskDir, "config.md"));
    expect(() => memoryTool({ action: "read", name: "config" }, f.home, f.a)).toThrow(/single-link/);
    expect(() => memoryTool({ action: "write", name: "config", content: "escaped" }, f.home, f.a)).toThrow(/single-link/);
    expect(() => memoryTool({ action: "append", name: "config", content: "escaped" }, f.home, f.a)).toThrow(/single-link/);
    expect(memoryTool({ action: "list" }, f.home, f.a)).not.toContain("config.md");
    expect(memoryIndexBlock(f.home, f.a)).not.toContain("config.md");
    expect(memoryTool({ action: "search", query: "only" }, f.home, f.a)).not.toContain("config.md");
    expect(readFileSync(join(bDir, "config.md"), "utf-8")).toBe(original);
  } finally {
    f.cleanup();
  }
});
