import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("task-bound registry rejects direct calls to unscoped skills and procedural memory after UI re-enable", async () => {
  const base = mkdtempSync(join(tmpdir(), "neko-task-tool-gate-"));
  const root = join(base, "root");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  try {
    const registry = new ToolRegistry(root, "auto", async () => false);
    registry.memoryHome = home;
    registry.bindTaskScope(createTaskScope("task-a", root));
    for (const name of ["skill", "workflow", "playbook"]) {
      registry.disabled.delete(name); // simulated `/tools` toggle must not override admission
      expect(registry.isToolAvailable(name)).toBe(false);
      expect(String(await registry.execute(name, {}))).toContain("no task-scoped admission contract");
      expect(registry.schemas().some((schema) => schema.function.name === name)).toBe(false);
    }
    expect(registry.isToolAvailable("memory")).toBe(true);
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(base).startsWith(tempRoot) || !basename(base).startsWith("neko-task-tool-gate-")) {
      throw new Error("Refusing to remove a fixture outside the task temp directory");
    }
    rmSync(base, { recursive: true, force: true });
  }
});
