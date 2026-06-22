import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

class ScriptedProvider {
  index = 0;
  constructor(private script: any[]) {}
  async complete() {
    return this.script[this.index++];
  }
}

test("loop runs tools then finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ag-"));
  writeFileSync(join(root, "a.txt"), "orig");
  const script = [
    { content: null, tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
    { content: null, tool_calls: [{ id: "c2", name: "write_file", arguments: { path: "b.txt", content: "done" } }] },
    { content: "finished", tool_calls: [] },
  ];
  const agent = new Agent({
    provider: new ScriptedProvider(script) as any,
    tools: new ToolRegistry(root, "auto", () => true),
    maxSteps: 10,
  });
  expect(await agent.run("go")).toBe("finished");
  expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("done");
  expect(agent.messages.map((m: any) => m.role)).toEqual([
    "system", "user", "assistant", "tool", "assistant", "tool", "assistant",
  ]);
});

test("max_steps cap fires", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ag-"));
  const loop = { content: null, tool_calls: [{ id: "x", name: "read_file", arguments: { path: "missing" } }] };
  const provider = { complete: async () => loop };
  const agent = new Agent({ provider: provider as any, tools: new ToolRegistry(root, "auto", () => true), maxSteps: 3 });
  expect(await agent.run("go")).toContain("max_steps=3");
});
