import { expect, test } from "bun:test";

import { composeMcpTools } from "../src/adapters/mcp-compose.ts";
import type { McpTools } from "../src/core/ports.ts";

function source(server: string): McpTools {
  return {
    toolSchemas: () => [],
    has: () => false,
    call: async () => "",
    promptList: () => [{ server, name: "review" }],
    getPrompt: async (_server, _name, args) => `${server}:${String(args.topic)}`,
  };
}

test("MCP composition preserves prompt discovery and dispatch", async () => {
  const composed = composeMcpTools(source("alpha"), source("beta"))!;
  expect(composed.promptList?.()).toEqual([
    { server: "alpha", name: "review" },
    { server: "beta", name: "review" },
  ]);
  expect(await composed.getPrompt?.("beta", "review", { topic: "changes" })).toBe("beta:changes");
  expect(await composed.getPrompt?.("missing", "review", {})).toContain("unknown MCP prompt");
});

test("MCP composition fails closed on duplicate external tool names", async () => {
  const duplicate = (): McpTools => ({
    toolSchemas: () => [{ type: "function", function: { name: "mcp__shared__echo", parameters: {} } }],
    has: (name) => name === "mcp__shared__echo",
    call: async () => "should not run",
  });
  const left = duplicate();
  const right = duplicate();
  const composed = composeMcpTools(left, right)!;

  expect(() => composed.toolSchemas()).toThrow("duplicate external tool schema");
  expect(composed.permission?.("mcp__shared__echo")).toBe("gated");
  expect(await composed.call("mcp__shared__echo", {})).toContain("ambiguous external tool name");
});

test("MCP composition rejects duplicate prompt identities", async () => {
  const composed = composeMcpTools(source("shared"), source("shared"))!;
  expect(() => composed.promptList?.()).toThrow("duplicate MCP prompt: shared:review");
  expect(await composed.getPrompt?.("shared", "review", {})).toContain("ambiguous MCP prompt");
});

test("lazy MCP loading routes each name only to its owning source", () => {
  const calls: string[][][] = [[], []];
  const lazy = (owned: string, index: number): McpTools => ({
    toolSchemas: () => [],
    has: (name) => name === owned,
    call: async () => "",
    loadTools: (names) => { calls[index].push(names); return `loaded ${names.join(",")}`; },
  });
  const composed = composeMcpTools(lazy("mcp__a__one", 0), lazy("mcp__b__two", 1))!;
  const result = composed.loadTools?.(["mcp__a__one", "mcp__b__two", "mcp__missing__x"]);
  expect(calls).toEqual([[ ["mcp__a__one"] ], [ ["mcp__b__two"] ]]);
  expect(result).toContain("loaded mcp__a__one");
  expect(result).toContain("loaded mcp__b__two");
  expect(result).toContain("unknown external tool mcp__missing__x");
});
