import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { environmentBlock, loadProjectContext } from "../src/adapters/context.ts";
import { createTaskScope } from "../src/core/task-scope.ts";

test("branded scope from one root cannot admit same-named other root context", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-task-context-root-"));
  const rootA = join(base, "a", "app");
  const rootB = join(base, "b", "app");
  const home = join(base, "home");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  mkdirSync(home);
  try {
    const scopeA = createTaskScope("task-a", rootA);
    expect(loadProjectContext(rootA, home, scopeA)).toEqual([]);
    expect(environmentBlock({ model: "fixture" }, rootA, scopeA)).toContain("Working directory:");
    expect(() => loadProjectContext(rootB, home, scopeA)).toThrow(/Task context root/);
    expect(() => environmentBlock({ model: "fixture" }, rootB, scopeA)).toThrow(/Task context root/);
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(base).startsWith(tempRoot) || !basename(base).startsWith("neko-task-context-root-")) {
      throw new Error("Refusing to remove a fixture outside the task temp directory");
    }
    rmSync(base, { recursive: true, force: true });
  }
});
