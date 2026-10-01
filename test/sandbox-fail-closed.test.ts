import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildSandbox } from "../src/core/sandbox.ts";

test("a configured sandbox never builds an unconfined target for primitive=none", () => {
  expect(() => buildSandbox("none", "echo unsafe", process.cwd(), false))
    .toThrow(/sandbox.*unavailable|no trusted.*primitive/i);
});

test("local Bash refuses missing confinement before approval or review", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "neko-no-primitive-"));
  try {
    const sandboxUrl = pathToFileURL(join(import.meta.dir, "..", "src", "core", "sandbox.ts")).href;
    const scopeUrl = pathToFileURL(join(import.meta.dir, "..", "src", "core", "task-scope.ts")).href;
    const registryUrl = pathToFileURL(join(import.meta.dir, "..", "src", "core", "tool-runtime.ts")).href;
    const script = `
      import { detectSandbox } from ${JSON.stringify(sandboxUrl)};
      import { ToolRegistry } from ${JSON.stringify(registryUrl)};
      import { createTaskScope } from ${JSON.stringify(scopeUrl)};
      if (detectSandbox() !== "none") throw new Error("fixture still sees a sandbox primitive");
      const root = process.cwd();
      let prompts = 0;
      const denied = new ToolRegistry(root, "default", () => { prompts++; return false; });
      denied.sandboxBash = true;
      const defaultResult = await denied.execute("bash", { command: "echo never" });
      let reviews = 0;
      const reviewed = new ToolRegistry(root, "auto", () => true);
      reviewed.sandboxBash = true;
      reviewed.checkAction = async () => { reviews++; return { ok: false, reason: "review gate" }; };
      const autoResult = await reviewed.execute("bash", { command: "echo never" });
      const scoped = new ToolRegistry(root, "auto", () => { prompts++; return true; });
      scoped.memoryHome = process.env.HOME;
      scoped.sandboxBash = true;
      scoped.explicitYolo = true;
      scoped.bindTaskScope(createTaskScope("sandbox-task", root));
      const scopedResult = await scoped.execute("bash", { command: "echo never" });
      console.log(JSON.stringify({ defaultResult, autoResult, scopedResult,
        receipt: scoped.taskExecutionReceipt(), prompts, reviews }));
    `;
    const env = {
      ...process.env,
      PATH: isolatedHome,
      BUN_INSTALL: isolatedHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      HOMEDRIVE: isolatedHome.slice(0, 2),
      HOMEPATH: isolatedHome.slice(2),
    };
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    for (const value of [result.defaultResult, result.autoResult, result.scopedResult]) {
      expect(value).toMatch(/sandbox.*unavailable|no trusted.*primitive/i);
    }
    expect(result.receipt).toMatchObject({ bashTarget: "sandbox", confinement: "required-not-attested",
      approval: { mode: "auto", yolo: true }, osAuthority: "not-attested" });
    expect(result.prompts).toBe(0);
    expect(result.reviews).toBe(0);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
