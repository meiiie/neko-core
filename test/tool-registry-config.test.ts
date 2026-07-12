import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { configureToolRegistry, inheritToolRegistrySettings } from "../src/adapters/tool-registry.ts";
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
  }, null, {}, "");
  const parent = configureToolRegistry(new ToolRegistry(".", "auto", () => true), cfg);
  parent.disabled.add("bash");
  parent.checkAction = async () => ({ ok: true, reason: "safe" });
  parent.summarize = async () => "summary";
  parent.subagent = async () => "parent only";

  expect(parent.web).toBeDefined();
  expect(parent.vision).toBe(true);
  expect(parent.sandboxBash).toBe(true);
  expect(parent.sandboxAllowNetwork).toBe(true);

  const child = inheritToolRegistrySettings(new ToolRegistry(".", parent.mode, parent.prompt), parent);
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
