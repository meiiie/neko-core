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

test("dynamicContext is injected and refreshed each turn (no staleness on model switch)", async () => {
  let model = "m1";
  const agent = new Agent({
    provider: new ScriptedProvider([{ content: "ok", tool_calls: [] }, { content: "ok2", tool_calls: [] }]) as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
    dynamicContext: () => `<env>model: ${model}</env>`,
  });
  const dyn = () => agent.messages.find((m: any) => m.role === "system" && m.dynamic);
  await agent.run("hi");
  expect(dyn().content).toContain("model: m1");
  model = "m2"; // user switches model mid-session
  await agent.run("again");
  expect(dyn().content).toContain("model: m2"); // refreshed, not stale
  expect(agent.messages.filter((m: any) => m.role === "system" && m.dynamic).length).toBe(1);
});

test("compact replaces the conversation with [system, summary]", async () => {
  const agent = new Agent({
    provider: new ScriptedProvider([{ content: "SUMMARY HERE", tool_calls: [] }]) as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
  });
  agent.messages = [
    { role: "system", content: "base" },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  await agent.compact();
  expect(agent.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
  expect(agent.messages[0].content).toBe("base"); // base system kept
  expect(agent.messages[1].content).toContain("SUMMARY HERE");
});

test("runUntilDone iterates until the model replies DONE, and caps", async () => {
  const done = new Agent({
    provider: new ScriptedProvider([
      { content: "did work", tool_calls: [] }, // goal
      { content: "fixed more", tool_calls: [] }, // review 1
      { content: "DONE", tool_calls: [] }, // review 2 -> stop
    ]) as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
  });
  expect(await done.runUntilDone("do X", { maxIters: 6 })).toBe("DONE");

  const capped = new Agent({
    provider: { complete: async () => ({ content: "still working", tool_calls: [] }) } as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
  });
  expect(await capped.runUntilDone("do X", { maxIters: 3 })).toBe("still working"); // never DONE -> cap
});

test("concurrency-safe tool calls in one turn run in parallel", async () => {
  class SlowTools {
    active = 0;
    maxActive = 0;
    schemas() { return []; }
    async execute(name: string) {
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise((r) => setTimeout(r, 25));
      this.active--;
      return `ran ${name}`;
    }
  }
  const tools = new SlowTools();
  const agent = new Agent({
    provider: new ScriptedProvider([
      { content: null, tool_calls: [
        { id: "1", name: "read_file", arguments: {} },
        { id: "2", name: "search", arguments: {} },
        { id: "3", name: "glob", arguments: {} },
      ] },
      { content: "done", tool_calls: [] },
    ]) as any,
    tools: tools as any,
  });
  await agent.run("go");
  expect(tools.maxActive).toBeGreaterThan(1); // overlapped => ran in parallel
});

test("max_steps cap fires", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ag-"));
  const loop = { content: null, tool_calls: [{ id: "x", name: "read_file", arguments: { path: "missing" } }] };
  const provider = { complete: async () => loop };
  const agent = new Agent({ provider: provider as any, tools: new ToolRegistry(root, "auto", () => true), maxSteps: 3 });
  expect(await agent.run("go")).toContain("max_steps=3");
});
