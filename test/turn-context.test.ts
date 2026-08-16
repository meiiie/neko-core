import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trustProject } from "../src/adapters/project-trust.ts";
import { productionTurnContext } from "../src/adapters/turn-context.ts";
import { EXACT_FILE_TURN_TOOLS } from "../src/adapters/turn-capabilities.ts";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("production turn context follows registry root/home and restores full catalogs after an exact lease", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "neko-turn-context-")));
  const root = join(base, "fixture-project");
  const home = join(base, "fixture-home");
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(home, ".neko-core"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "PROJECT_ROOT_CONTEXT_SENTINEL", "utf8");
    writeFileSync(join(home, ".neko-core", "NEKO.md"), "REQUESTED_HOME_CONTEXT_SENTINEL", "utf8");
    trustProject(root, home);

    const mcp = {
      toolSchemas: () => [{
        type: "function",
        function: { name: "mcp_load", description: "load", parameters: { type: "object", properties: {} } },
      }],
      has: () => false,
      call: async () => "",
      indexBlock: () => "MCP_INDEX_SENTINEL",
    };
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    const registry = new ToolRegistry(root, "auto", () => true, mcp as any);
    registry.loadSkill = () => null;
    registry.todos = [{ content: "TODO_CONTEXT_SENTINEL", status: "pending" }];
    const render = () => productionTurnContext(registry, {
      model: "fixture-model",
      provider: "fixture-provider",
      home,
      includeTodos: true,
    });

    const fullBefore = render();
    expect(fullBefore).toContain(`Working directory: ${root}`);
    expect(fullBefore).toContain("PROJECT_ROOT_CONTEXT_SENTINEL");
    expect(fullBefore).toContain("REQUESTED_HOME_CONTEXT_SENTINEL");
    expect(fullBefore).toContain("Available subagent types");
    expect(fullBefore).toContain("# NEKO SKILL CATALOG");
    expect(fullBefore).toContain("TODO_CONTEXT_SENTINEL");
    expect(fullBefore).toContain("MCP_INDEX_SENTINEL");

    const lease = registry.enterTurn({
      name: "exact-file-edit",
      allowedTools: EXACT_FILE_TURN_TOOLS,
      allowBackgroundBash: false,
    });
    expect(registry.schemas().map((schema) => schema.function.name)).toEqual(["read_file", "edit", "bash"]);
    const micro = render();
    expect(micro).toContain("PROJECT_ROOT_CONTEXT_SENTINEL");
    expect(micro).toContain("REQUESTED_HOME_CONTEXT_SENTINEL");
    expect(micro).not.toContain("Available subagent types");
    expect(micro).not.toContain("# NEKO SKILL CATALOG");
    expect(micro).not.toContain("Saved memories");
    expect(micro).not.toContain("Learned workflows");
    expect(micro).not.toContain("operating playbook index");
    expect(micro).not.toContain("TODO_CONTEXT_SENTINEL");
    expect(micro).not.toContain("MCP_INDEX_SENTINEL");
    lease.close();

    const fullAfter = render();
    expect(fullAfter).toContain("Available subagent types");
    expect(fullAfter).toContain("# NEKO SKILL CATALOG");
    expect(fullAfter).toContain("TODO_CONTEXT_SENTINEL");
    expect(fullAfter).toContain("MCP_INDEX_SENTINEL");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a preparation throw closes the turn lease and removes provider-only context", async () => {
  const registry = new ToolRegistry(".", "auto", () => true);
  const agent = new Agent({
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    provider: { complete: async () => ({ content: "unused" }) } as any,
    tools: registry,
  });
  agent.appendSystem("PERSISTENT SYSTEM CONTEXT");

  const prepare = async () => {
    const lease = registry.enterTurn({
      name: "exact-file-edit",
      allowedTools: EXACT_FILE_TURN_TOOLS,
      allowBackgroundBash: false,
    });
    agent.setTurnSystemContext("VOLATILE PREP CONTEXT");
    try {
      expect(registry.schemas().map((schema) => schema.function.name)).toEqual(["read_file", "edit", "bash"]);
      expect(JSON.stringify(agent.providerHistory())).toContain("VOLATILE PREP CONTEXT");
      throw new Error("fixture preparation failed");
    } finally {
      lease.close();
      agent.clearTurnSystemContext();
    }
  };

  await expect(prepare()).rejects.toThrow("fixture preparation failed");
  expect(registry.schemas().map((schema) => schema.function.name)).toContain("task");
  expect(JSON.stringify(agent.providerHistory())).not.toContain("VOLATILE PREP CONTEXT");
  expect(JSON.stringify(agent.messages)).toContain("PERSISTENT SYSTEM CONTEXT");
});
