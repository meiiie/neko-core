import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NekoConfig } from "../src/adapters/config.ts";
import { configureToolRegistry, inheritToolRegistrySettings, restrictToolRegistryForSubagent } from "../src/adapters/tool-registry.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("shared registry composition wires native web and preserves every child safety boundary", () => {
  const cfg = new NekoConfig({
    allow_dangerous_bash: true,
    sandbox: true,
    sandbox_network: true,
    vision: true,
    computer_use_overlay: true,
    computer_use_resident: false,
    computer_use_input: "inject",
    searxng_url: "http://search.local",
    search_backend: "searxng",
    scrape_backend: "jina",
    hooks: { pre_tool_use: "pre", post_tool_use: "post" },
  }, null, { custom: { key_env: "CUSTOM_PROVIDER_KEY" } }, "");
  const parent = configureToolRegistry(new ToolRegistry(".", "auto", () => true), cfg);
  parent.disabled.add("bash");
  parent.checkAction = async () => ({ ok: true, reason: "safe" });
  parent.summarize = async () => "summary";
  parent.subagent = async () => "parent only";

  expect(parent.web).toBeDefined();
  expect(parent.vision).toBe(true);
  expect(parent.sandboxBash).toBe(true);
  expect(parent.sandboxAllowNetwork).toBe(true);
  expect(parent.childSecretEnvNames).toContain("CUSTOM_PROVIDER_KEY");

  const child = inheritToolRegistrySettings(new ToolRegistry(".", parent.mode, parent.prompt), parent);
  expect(child.mcp).toBe(parent.mcp);
  expect(child.web).toBe(parent.web);
  expect(child.checkAction).toBe(parent.checkAction);
  expect(child.summarize).toBe(parent.summarize);
  expect(child.loadSkill).toBe(parent.loadSkill);
  expect(child.disabled.has("bash")).toBe(true);
  expect(child.allowDangerousBash).toBe(true);
  expect(child.sandboxBash).toBe(true);
  expect(child.sandboxAllowNetwork).toBe(true);
  expect(child.presence).toBe(true);
  expect(child.residentUia).toBe(false);
  expect(child.inputBackend).toBe("inject");
  expect(child.childSecretEnvNames).toEqual(parent.childSecretEnvNames);
  expect(child.childSecretEnvNames).not.toBe(parent.childSecretEnvNames);
  expect(child.subagent).toBeUndefined();
});

test("native web remains a fallback alongside namespaced MCP web tools", () => {
  const mcp = {
    toolSchemas: () => [{ type: "function", function: { name: "mcp__browser__web_search", parameters: {} } }],
    has: () => false,
    call: async () => "",
  };
  const cfg = new NekoConfig({}, null, {}, "");
  const registry = configureToolRegistry(new ToolRegistry(".", "auto", () => true, mcp), cfg);
  const names = registry.schemas().map((schema: any) => schema.function.name);
  expect(names).toContain("web_search");
  expect(names).toContain("mcp__browser__web_search");
  expect(new Set(names).size).toBe(names.length);
});

test("reviewer capability boundary hides and refuses write/edit/bash while generic workers retain authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-reviewer-"));
  const parent = new ToolRegistry(root, "auto", () => true);
  const reviewer = restrictToolRegistryForSubagent(
    inheritToolRegistrySettings(new ToolRegistry(root, "auto", () => true), parent),
    "reviewer",
  );

  expect(reviewer.schemas().map((schema: any) => schema.function.name)).toEqual(["read_file", "search"]);
  expect(await reviewer.execute("write_file", { path: "blocked.txt", content: "blocked" })).toContain("not available");
  expect(await reviewer.execute("edit", { path: "blocked.txt", old_string: "x", new_string: "y" })).toContain("not available");
  expect(await reviewer.execute("bash", { command: "echo blocked" })).toContain("not available");
  expect(existsSync(join(root, "blocked.txt"))).toBe(false);

  const generic = restrictToolRegistryForSubagent(
    inheritToolRegistrySettings(new ToolRegistry(root, "auto", () => true), parent),
    undefined,
  );
  const genericNames = generic.schemas().map((schema: any) => schema.function.name);
  expect(genericNames).toContain("write_file");
  expect(genericNames).toContain("bash");
  expect(genericNames).not.toContain("task");
  expect(await generic.execute("bash", { command: "echo no", run_in_background: true }))
    .toContain("background bash is unavailable in a sub-agent");
});

test("reviewer/explorer reads drop executable hooks while generic/custom workers retain them", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-readonly-hooks-"));
  writeFileSync(join(root, "source.txt"), "safe read");
  const parent = new ToolRegistry(root, "auto", () => true);
  parent.hooks = {
    preToolUse: "echo pre>pre-hook.txt",
    postToolUse: "echo post>post-hook.txt",
  };

  for (const type of ["reviewer", "explorer"]) {
    const child = restrictToolRegistryForSubagent(
      inheritToolRegistrySettings(new ToolRegistry(root, "auto", () => true), parent),
      type,
    );
    expect(child.hooks).toBeUndefined();
    expect(await child.execute("read_file", { path: "source.txt" })).toContain("safe read");
  }
  expect(existsSync(join(root, "pre-hook.txt"))).toBe(false);
  expect(existsSync(join(root, "post-hook.txt"))).toBe(false);

  const generic = restrictToolRegistryForSubagent(
    inheritToolRegistrySettings(new ToolRegistry(root, "auto", () => true), parent),
  );
  expect(generic.hooks).toBe(parent.hooks);
  expect(await generic.execute("read_file", { path: "source.txt" })).toContain("safe read");
  expect(existsSync(join(root, "pre-hook.txt"))).toBe(true);
  expect(existsSync(join(root, "post-hook.txt"))).toBe(true);

  const custom = restrictToolRegistryForSubagent(
    inheritToolRegistrySettings(new ToolRegistry(root, "auto", () => true), parent),
    "custom-auditor",
  );
  expect(custom.hooks).toBe(parent.hooks);
  rmSync(root, { recursive: true, force: true });
});
