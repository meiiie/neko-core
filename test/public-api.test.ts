import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Agent, ToolRegistry, denyAll, type Provider } from "neko-core";

const root = resolve(import.meta.dir, "..");

test("public core types compose into an embeddable agent", () => {
  const provider: Provider = {
    async complete() {
      return { content: "ok", tool_calls: [] };
    },
  };
  const tools = new ToolRegistry(root, "plan", denyAll);
  const agent = new Agent({ provider, tools, maxSteps: 1 });

  expect(agent.currentProvider()).toBe(provider);
  expect(agent.externalToolSchemas().length).toBeGreaterThan(0);
});

test("bare package import exposes only the public core library and has no CLI output", () => {
  const script = `
    const api = await import("neko-core");
    const expected = ${JSON.stringify([
      "Agent",
      "CostTracker",
      "GATED",
      "SAFE",
      "TOOL_SPECS",
      "ToolRegistry",
      "autoApprove",
      "denyAll",
      "describeToolCall",
      "listTools",
      "toolSchemas",
    ])};
    const actual = Object.keys(api).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) {
      throw new Error("unexpected public exports: " + actual.join(","));
    }
    if (typeof api.Agent !== "function" || typeof api.ToolRegistry !== "function") {
      throw new Error("public constructors are unavailable");
    }
  `;
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(root, "bunfig.neko.toml")}`,
      "--eval",
      script,
    ],
    cwd: root,
    env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
});
