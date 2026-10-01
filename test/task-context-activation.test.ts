import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { trustProject } from "../src/adapters/project-trust.ts";
import { matchedTurnContext, productionTurnContext } from "../src/adapters/turn-context.ts";
import { createTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("new active task captures a fresh environment snapshot in the same root", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-task-env-red-"));
  const root = join(base, "app");
  const home = join(base, "home");
  const hooks = join(base, "empty-hooks");
  mkdirSync(root);
  mkdirSync(home);
  mkdirSync(hooks);
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${hooks}`, "-C", root, ...args,
  ], {
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(base, "no-global-gitconfig") },
  });
  const activate = (id: string) => {
    const registry = new ToolRegistry(root, "auto", () => false);
    registry.memoryHome = home;
    registry.bindTaskScope(createTaskScope(id, root));
    return () => productionTurnContext(registry, { model: "fixture", provider: "fake", home });
  };

  try {
    git("init", "-q", "-b", "branch-a", `--template=${hooks}`);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "seed");
    const taskA = activate("task-a");
    expect(taskA()).toContain("Git: branch branch-a");

    git("checkout", "-qb", "branch-b");
    expect(taskA()).toContain("Git: branch branch-a");
    const taskB = activate("task-b");
    expect(taskB()).toContain("Git: branch branch-b");

    git("checkout", "-qb", "branch-c");
    expect(taskB()).toContain("Git: branch branch-b");
    expect(activate("task-a")()).toContain("Git: branch branch-c");
  } finally {
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(base).startsWith(tempRoot) || !basename(base).startsWith("neko-task-env-red-")) {
      throw new Error("Refusing to remove fixture outside the task temp directory");
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test("active task excludes legacy global context while retaining trusted project instructions", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-task-global-"));
  const root = join(base, "app");
  const home = join(base, "home");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(home, ".neko-core", "workflows"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "TRUSTED_PROJECT_INSTRUCTION", "utf8");
    writeFileSync(join(home, ".neko-core", "NEKO.md"), "LEGACY_GLOBAL_IDENTITY", "utf8");
    writeFileSync(join(home, ".neko-core", "workflows", "price-shop.md"),
      "getting a product price from a JS rendered shop page using browser snapshot: LEGACY_GLOBAL_WORKFLOW\nStep 1", "utf8");
    writeFileSync(join(home, ".neko-core", "playbook.md"), "- LEGACY_GLOBAL_PLAYBOOK\n", "utf8");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    trustProject(root, home);

    const legacy = new ToolRegistry(root, "auto", () => false);
    const scoped = new ToolRegistry(root, "auto", () => false);
    scoped.memoryHome = home;
    scoped.bindTaskScope(createTaskScope("task-a", root));
    const options = { model: "fixture", provider: "fake", home };
    const legacyContext = productionTurnContext(legacy, options);
    const taskContext = productionTurnContext(scoped, options);
    expect(legacyContext).toContain("LEGACY_GLOBAL_IDENTITY");
    expect(legacyContext).toContain("LEGACY_GLOBAL_WORKFLOW");
    expect(legacyContext).toContain("LEGACY_GLOBAL_PLAYBOOK");
    expect(taskContext).toContain('<context path="AGENTS.md">\nTRUSTED_PROJECT_INSTRUCTION');
    expect(taskContext).not.toContain("LEGACY_GLOBAL_IDENTITY");
    expect(taskContext).not.toContain("LEGACY_GLOBAL_WORKFLOW");
    expect(taskContext).not.toContain("LEGACY_GLOBAL_PLAYBOOK");

    const request = "get the product price from a JS rendered shop page";
    expect(matchedTurnContext(request, legacy, home).text).toContain("LEGACY_GLOBAL_WORKFLOW");
    expect(matchedTurnContext(request, scoped, home).text).not.toContain("LEGACY_GLOBAL_WORKFLOW");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    const tempRoot = resolve(tmpdir()) + sep;
    if (!resolve(base).startsWith(tempRoot) || !basename(base).startsWith("neko-task-global-")) {
      throw new Error("Refusing to remove fixture outside the task temp directory");
    }
    rmSync(base, { recursive: true, force: true });
  }
});
