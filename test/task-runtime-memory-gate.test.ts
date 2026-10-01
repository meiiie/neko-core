import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { productionTurnContext } from "../src/adapters/turn-context.ts";
import { memoryTool } from "../src/core/memory.ts";
import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("runtime task scope gates context and memory tool for same-basename roots", async () => {
  const base = mkdtempSync(join(tmpdir(), "neko-task-runtime-memory-"));
  const home = join(base, "home");
  const otherHome = join(base, "other-home");
  const rootA = join(base, "repo-a", "app");
  const rootB = join(base, "repo-b", "app");
  mkdirSync(home, { recursive: true });
  mkdirSync(otherHome, { recursive: true });
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  try {
    memoryTool({ action: "write", name: "stack", content: "# Legacy uses npm" }, home);
    memoryTool({ action: "append", name: "user", content: "Legacy preference" }, home);
    memoryTool({ action: "write", name: "stack", content: "# Wrong home fact" }, otherHome);
    writeFileSync(join(home, ".neko-core", "NEKO.md"), "RIGHT_HOME_POLICY", "utf8");
    writeFileSync(join(otherHome, ".neko-core", "NEKO.md"), "WRONG_HOME_POLICY", "utf8");
    memoryTool({ action: "write", name: "stack", content: "# Wrong home scoped trap" }, otherHome, createTaskScope("task-a", rootA));

    const a = new ToolRegistry(rootA, "auto", () => true);
    const b = new ToolRegistry(rootB, "auto", () => true);
    a.memoryHome = home;
    b.memoryHome = home;
    a.bindTaskScope(createTaskScope("task-a", rootA));
    b.bindTaskScope(createTaskScope("task-b", rootB));

    expect(await a.execute("memory", { action: "write", name: "stack", content: "# A uses pnpm", taskId: "task-b" })).toContain("Saved");
    expect(await b.execute("memory", { action: "write", name: "stack", content: "# B uses bun", taskId: "task-a" })).toContain("Saved");
    await a.execute("memory", { action: "append", name: "user", content: "A prefers pnpm" });
    await b.execute("memory", { action: "append", name: "user", content: "B prefers bun" });

    const context = (registry: ToolRegistry) => productionTurnContext(registry, {
      model: "fixture-model", provider: "fixture-provider", home,
    });
    const contextA = context(a);
    const contextB = context(b);
    expect(contextA).toContain("stack.md: A uses pnpm");
    expect(contextA).toContain("A prefers pnpm");
    expect(contextA).not.toContain("B uses bun");
    expect(contextA).not.toContain("B prefers bun");
    expect(contextA).not.toContain("Legacy uses npm");
    expect(contextA).not.toContain("Legacy preference");
    // Unscoped home instructions stay quarantined from an explicitly scoped task.
    expect(contextA).not.toContain("RIGHT_HOME_POLICY");
    expect(contextA).not.toContain("WRONG_HOME_POLICY");
    expect(contextA).not.toContain("Available subagent types");
    expect(a.schemas().map((schema) => schema.function.name)).not.toContain("task");
    expect(a.isToolAvailable("task")).toBe(false);
    const mismatchedHomeContext = productionTurnContext(a, {
      model: "fixture-model", provider: "fixture-provider", home: otherHome,
    });
    expect(mismatchedHomeContext).toContain("stack.md: A uses pnpm");
    expect(mismatchedHomeContext).not.toContain("Wrong home fact");
    expect(mismatchedHomeContext).not.toContain("Wrong home scoped trap");
    expect(mismatchedHomeContext).not.toContain("RIGHT_HOME_POLICY");
    expect(mismatchedHomeContext).not.toContain("WRONG_HOME_POLICY");
    expect(() => { a.memoryHome = otherHome; }).toThrow(/already bound/);
    expect(await a.execute("memory", { action: "read", name: "stack" })).toContain("A uses pnpm");
    expect(contextB).toContain("stack.md: B uses bun");
    expect(contextB).toContain("B prefers bun");
    expect(contextB).not.toContain("A uses pnpm");
    expect(contextB).not.toContain("A prefers pnpm");
    expect(contextB).not.toContain("Legacy uses npm");

    expect(await a.execute("memory", { action: "read", name: "stack", taskId: "task-b" })).toContain("A uses pnpm");
    expect(await b.execute("memory", { action: "read", name: "stack", taskId: "task-a" })).toContain("B uses bun");
    expect(await a.execute("memory", { action: "search", query: "bun", taskId: "task-b" })).toContain("no memory matches");
    expect(await b.execute("memory", { action: "search", query: "pnpm", taskId: "task-a" })).toContain("no memory matches");
    expect(await a.execute("memory", { action: "list", taskId: "task-b" })).toContain("stack.md: A uses pnpm");

    let childCalled = false;
    let approvalCalls = 0;
    let checkCalls = 0;
    a.prompt = () => { approvalCalls++; return true; };
    a.checkAction = async () => { checkCalls++; return { ok: true, reason: "" }; };
    a.hooks = { preToolUse: "exit 99" };
    a.subagent = async () => { childCalled = true; return "child started"; };
    expect(await a.execute("task", { prompt: "Read another task memory" })).toContain("scoped task");
    expect(childCalled).toBe(false);
    expect(approvalCalls).toBe(0);
    expect(checkCalls).toBe(0);

    const legacy = new ToolRegistry(rootA, "auto", () => true);
    legacy.memoryHome = home;
    expect(context(legacy)).toContain("stack.md: Legacy uses npm");
    expect(context(legacy)).toContain("RIGHT_HOME_POLICY");
    expect(await legacy.execute("memory", { action: "read", name: "stack" })).toContain("Legacy uses npm");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("runtime refuses a task scope bound to another root or forged by model data", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-task-runtime-binding-"));
  const rootA = join(base, "one", "app");
  const rootB = join(base, "two", "app");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  try {
    const a = new ToolRegistry(rootA, "auto", () => true);
    const scopeA = createTaskScope("task-a", rootA);
    const scopeB = createTaskScope("task-b", rootB);
    expect(() => a.bindTaskScope(scopeB)).toThrow(/root/i);
    expect(() => a.bindTaskScope({ ...scopeA })).toThrow(/runtime/i);
    a.bindTaskScope(scopeA);
    expect(() => a.bindTaskScope(createTaskScope("other-task", rootA))).toThrow(/already/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
