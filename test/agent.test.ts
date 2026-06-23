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

test("compact keeps system + recent turns verbatim and summarizes the older ones", async () => {
  const agent = new Agent({
    provider: new ScriptedProvider([{ content: "SUMMARY HERE", tool_calls: [] }]) as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
  });
  agent.messages = [
    { role: "system", content: "base" },
    { role: "user", content: "OLD1" }, // older than the tail -> summarized
    { role: "assistant", content: "a1" },
    { role: "user", content: "OLD2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "m3" },
    { role: "assistant", content: "a3" },
    { role: "user", content: "m4" },
    { role: "assistant", content: "a4" },
    { role: "user", content: "m5" },
    { role: "assistant", content: "a5" },
    { role: "user", content: "RECENT" }, // within the kept tail (KEEP_TAIL=8)
    { role: "assistant", content: "ra" },
  ];
  await agent.compact();
  const contents = agent.messages.map((m: any) => String(m.content));
  expect(agent.messages[0].content).toBe("base"); // system kept
  expect(contents.some((c) => c.includes("SUMMARY HERE"))).toBe(true); // older turns summarized
  expect(contents).toContain("RECENT"); // recent turn kept verbatim
  expect(contents).not.toContain("OLD1"); // oldest turn folded into the summary
});

test("rewind drops the last user turn from context", () => {
  const agent = new Agent({
    provider: { complete: async () => ({ content: "x", tool_calls: [] }) } as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
  });
  agent.messages = [
    { role: "system", content: "s" },
    { role: "user", content: "first" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "second" },
    { role: "assistant", content: "a2" },
  ];
  expect(agent.rewind()).toBe(true);
  expect(agent.messages.map((m: any) => m.content)).toEqual(["s", "first", "a1"]); // last turn gone
  expect(agent.rewind()).toBe(true);
  expect(agent.messages.map((m: any) => m.role)).toEqual(["system"]); // back to just system
  expect(agent.rewind()).toBe(false); // nothing left to rewind
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

test("run attaches images as OpenAI vision content", async () => {
  let seen: any;
  const agent = new Agent({
    provider: { complete: async (msgs: any[]) => { seen = msgs[msgs.length - 1]; return { content: "ok", tool_calls: [] }; } } as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
  });
  await agent.run("what is this?", undefined, ["data:image/png;base64,AAAA"]);
  expect(Array.isArray(seen.content)).toBe(true);
  expect(seen.content[0]).toEqual({ type: "text", text: "what is this?" });
  expect(seen.content[1].type).toBe("image_url");
  expect(seen.content[1].image_url.url).toContain("base64,AAAA");
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
