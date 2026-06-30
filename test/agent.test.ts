import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, clampObservation, estimateTokens, MAX_OBS_CHARS } from "../src/core/agent.ts";
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

test("a throwing tool call (model glitch) is fed back as an error, not crashed", async () => {
  // web_fetch with no `url` makes requireArg throw -- before safeExecute this rejected the whole turn.
  const script = [
    { content: null, tool_calls: [{ id: "c1", name: "web_fetch", arguments: {} }] }, // no url -> throws
    { content: "recovered", tool_calls: [] },
  ];
  const agent = new Agent({
    provider: new ScriptedProvider(script) as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
    maxSteps: 5,
  });
  expect(await agent.run("go")).toBe("recovered"); // run did NOT crash
  const toolMsg = agent.messages.find((m: any) => m.role === "tool");
  expect(String(toolMsg.content)).toMatch(/error/i); // the throw became a recoverable observation
});

test("dynamicContext is merged into the ONE system message and refreshed each turn (no staleness, one system msg)", async () => {
  let model = "m1";
  const agent = new Agent({
    provider: new ScriptedProvider([{ content: "ok", tool_calls: [] }, { content: "ok2", tool_calls: [] }]) as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
    dynamicContext: () => `<env>model: ${model}</env>`,
  });
  const sys = () => agent.messages.find((m: any) => m.role === "system");
  await agent.run("hi");
  expect(sys().content).toContain("model: m1");
  // Exactly ONE system message: a second system message breaks tool-calling on Llama/Mistral templates.
  expect(agent.messages.filter((m: any) => m.role === "system").length).toBe(1);
  model = "m2"; // user switches model mid-session
  await agent.run("again");
  expect(sys().content).toContain("model: m2"); // refreshed, not stale
  expect(sys().content).not.toContain("model: m1"); // old context stripped, not accumulated
  expect(agent.messages.filter((m: any) => m.role === "system").length).toBe(1); // still one
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

  test("compact clips a dense few-line tool result by char count (line guard alone misses it)", async () => {
    // A minified/base64-style blob: long in chars, short in lines -> the line-count guard (>40 lines)
    // would leave it fully intact, so compaction freed nothing. The char guard must clip it.
    const dense = "x".repeat(50000);
    const agent = new Agent({
      provider: new ScriptedProvider([{ content: "SUM", tool_calls: [] }]) as any,
      tools: new ToolRegistry(process.cwd(), "auto", () => true),
    });
    // Need convo.length > KEEP_TAIL(8) so head is non-empty and compact() actually runs; the dense
    // tool result sits in the kept tail where the lean-clip applies.
    agent.messages = [
      { role: "system", content: "base" },
      { role: "user", content: "o1" }, { role: "assistant", content: "a1" }, // old head -> summarized
      { role: "user", content: "o2" }, { role: "assistant", content: "a2" },
      { role: "user", content: "r1" }, { role: "assistant", content: "a3" }, // recent tail (kept)
      { role: "user", content: "r2" }, { role: "assistant", content: "a4" },
      { role: "user", content: "r3" }, { role: "assistant", content: "a5" },
      { role: "tool", content: dense }, // dense few-line result in the tail -> char-clipped
      { role: "assistant", content: "a6" },
    ];
    await agent.compact();
    const toolMsgs = agent.messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect((toolMsgs[0].content as string).length).toBeLessThan(dense.length); // clipped, not intact
    expect(toolMsgs[0].content).toMatch(/chars clipped on compaction/); // char-guard marker present
    expect(toolMsgs[0].content.startsWith("x")).toBe(true); // head preserved
  });

test("refreshSystemPrompt updates a resumed session's base system message", () => {
  const agent = new Agent({
    provider: { complete: async () => ({ content: "x", tool_calls: [] }) } as any,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
    systemPrompt: "NEW PROMPT",
  });
  agent.messages = [
    { role: "system", content: "OLD SAVED PROMPT" }, // as if loaded from a session
    { role: "user", content: "hi" },
  ];
  agent.refreshSystemPrompt();
  expect(agent.messages[0].content).toBe("NEW PROMPT"); // base system swapped to the current prompt
  expect(agent.messages[1].content).toBe("hi"); // conversation untouched
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

  test("loop guard stops re-running an identical tool call", async () => {
    let execs = 0;
    const tools = { schemas: () => [], execute: async () => { execs++; return "err"; } };
    const provider = { complete: async () => ({ content: null, tool_calls: [{ id: "x", name: "read_file", arguments: { path: "p" } }] }) };
    const agent = new Agent({ provider: provider as any, tools: tools as any, maxSteps: 6 });
    await agent.run("go");
    expect(execs).toBeLessThan(6); // guarded after the 3rd identical call, not executed every step
    expect(agent.messages.some((m: any) => String(m.content).includes("loop guard"))).toBe(true);
  });

test("BROAD loop guard trips on N DISTINCT edits to ONE path (the exact-repeat guard misses this)", async () => {
  // The classic doom-loop: edit the SAME file with DIFFERENT args chasing a build error. Every
  // call signature differs, so the exact-repeat guard (lastSig/repeats) NEVER trips. The broad
  // guard counts edits-per-path and nudges once the cap (3) is hit.
  const edited: string[] = [];
  const tools = {
    schemas: () => [],
    execute: async (_n: string, args: any) => { edited.push(args.path); return "ok"; },
  };
  // 5 distinct edit calls to the same path, then a final tool-less answer.
  const script = [
    { content: null, tool_calls: [{ id: "c1", name: "edit", arguments: { path: "src/x.ts", old_string: "a", new_string: "b" } }] },
    { content: null, tool_calls: [{ id: "c2", name: "edit", arguments: { path: "src/x.ts", old_string: "c", new_string: "d" } }] },
    { content: null, tool_calls: [{ id: "c3", name: "edit", arguments: { path: "src/x.ts", old_string: "e", new_string: "f" } }] },
    { content: null, tool_calls: [{ id: "c4", name: "edit", arguments: { path: "src/x.ts", old_string: "g", new_string: "h" } }] },
    { content: null, tool_calls: [{ id: "c5", name: "edit", arguments: { path: "src/x.ts", old_string: "i", new_string: "j" } }] },
    { content: "done", tool_calls: [] },
  ];
  const agent = new Agent({ provider: new ScriptedProvider(script) as any, tools: tools as any, maxSteps: 10 });
  await agent.run("go");
  // Only the first 2 edits actually execute; from the 3rd on the broad guard nudges instead of running.
  expect(edited.length).toBeLessThanOrEqual(2);
  expect(edited.every((p) => p === "src/x.ts")).toBe(true);
  const broadNudges = agent.messages.filter((m: any) =>
    String(m.content).includes("[loop guard]") && String(m.content).includes("src/x.ts"));
  expect(broadNudges.length).toBeGreaterThan(0); // broad guard fired (exact guard would NOT have)
});

test("BROAD loop guard does NOT trip on edits to DIFFERENT paths (no false positive)", async () => {
  const edited: string[] = [];
  const tools = {
    schemas: () => [],
    execute: async (_n: string, args: any) => { edited.push(args.path); return "ok"; },
  };
  const script = [
    { content: null, tool_calls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "a", new_string: "b" } }] },
    { content: null, tool_calls: [{ id: "c2", name: "edit", arguments: { path: "b.ts", old_string: "c", new_string: "d" } }] },
    { content: null, tool_calls: [{ id: "c3", name: "edit", arguments: { path: "c.ts", old_string: "e", new_string: "f" } }] },
    { content: "done", tool_calls: [] },
  ];
  const agent = new Agent({ provider: new ScriptedProvider(script) as any, tools: tools as any, maxSteps: 10 });
  await agent.run("go");
  expect(edited).toEqual(["a.ts", "b.ts", "c.ts"]); // all 3 ran — no false nudge on distinct paths
  expect(agent.messages.some((m: any) => String(m.content).includes("[loop guard]"))).toBe(false);
});

test("BROAD loop guard trips on N CONSECUTIVE FAILING bash runs", async () => {
  // The agent re-runs a failing command 3x with tiny tweaks; the exact-repeat guard won't trip
  // (commands differ) but the failing-streak guard must nudge it to change approach.
  const script = [
    { content: null, tool_calls: [{ id: "b1", name: "bash", arguments: { command: "make test1" } }] },
    { content: null, tool_calls: [{ id: "b2", name: "bash", arguments: { command: "make test2" } }] },
    { content: null, tool_calls: [{ id: "b3", name: "bash", arguments: { command: "make test3" } }] },
    { content: "done", tool_calls: [] },
  ];
  // tool-runtime tags failures as "(exit N -- command FAILED)" — every bash here fails.
  const tools = { schemas: () => [], execute: async () => "(exit 1 -- command FAILED)\nsome error" };
  const agent = new Agent({ provider: new ScriptedProvider(script) as any, tools: tools as any, maxSteps: 8 });
  await agent.run("go");
  const nudge = agent.messages.find((m: any) =>
    String(m.content).includes("[loop guard]") && String(m.content).includes("failed") && String(m.content).includes("times in a row"));
  expect(nudge).toBeTruthy(); // the failing-streak nudge fired
});

test("BROAD loop guard resets the failing streak on a successful bash (no false positive)", async () => {
  // fail, fail, SUCCESS (resets), then fail again -> streak is only 1, no nudge should fire.
  const script = [
    { content: null, tool_calls: [{ id: "b1", name: "bash", arguments: { command: "f1" } }] },
    { content: null, tool_calls: [{ id: "b2", name: "bash", arguments: { command: "f2" } }] },
    { content: null, tool_calls: [{ id: "b3", name: "bash", arguments: { command: "ok" } }] },
    { content: null, tool_calls: [{ id: "b4", name: "bash", arguments: { command: "f3" } }] },
    { content: "done", tool_calls: [] },
  ];
  let n = 0;
  const tools = {
    schemas: () => [],
    execute: async () => { n++; return n === 3 ? "(exit 0)\nok" : "(exit 1 -- command FAILED)\nerr"; },
  };
  const agent = new Agent({ provider: new ScriptedProvider(script) as any, tools: tools as any, maxSteps: 8 });
  await agent.run("go");
  expect(agent.messages.some((m: any) => String(m.content).includes("[loop guard]"))).toBe(false);
});

test("max_steps cap fires", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-ag-"));
  const loop = { content: null, tool_calls: [{ id: "x", name: "read_file", arguments: { path: "missing" } }] };
  const provider = { complete: async () => loop };
  const agent = new Agent({ provider: provider as any, tools: new ToolRegistry(root, "auto", () => true), maxSteps: 3 });
  expect(await agent.run("go")).toContain("max_steps=3");
});

test("clampObservation caps a huge tool result so one result can't overflow the window", () => {
  const huge = "y".repeat(MAX_OBS_CHARS * 3);
  const out = clampObservation(huge) as string;
  expect(out.length).toBeLessThan(huge.length);
  expect(out.length).toBeLessThanOrEqual(MAX_OBS_CHARS + 200); // head + tail + marker, bounded
  expect(out).toContain("truncated to fit the context window");
  expect(out.startsWith("y")).toBe(true); // head preserved
  expect(out.endsWith("y")).toBe(true);   // tail preserved
  // Small strings and multimodal arrays pass through untouched.
  expect(clampObservation("short")).toBe("short");
  const parts = [{ type: "text", text: "hi" }];
  expect(clampObservation(parts as any)).toBe(parts as any);
});

test("estimateTokens approximates ~4 chars/token over the conversation", () => {
  const msgs = [{ role: "user", content: "a".repeat(400) }, { role: "assistant", content: "b".repeat(400) }];
  expect(estimateTokens(msgs)).toBe(200); // 800 chars / 4
});

test("estimateTokens counts assistant tool_calls (e.g. write_file args) so the overflow guard isn't undercounted", () => {
  const big = "x".repeat(400);
  const without = [{ role: "assistant", content: "" }];
  const withCalls = [{ role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "p", content: big }) } }] }];
  // The tool_call's serialized JSON adds length; the estimate must reflect it, not just content.
  expect(estimateTokens(withCalls)).toBeGreaterThan(estimateTokens(without));
  expect(estimateTokens(withCalls)).toBeGreaterThanOrEqual(Math.ceil(big.length / 4));
});

test("in-loop guard clips OLD observations within one turn before context overflows", async () => {
  const big = "x".repeat(5000); // under MAX_OBS_CHARS, so it accumulates rather than being clamped per-result
  const tools = { schemas: () => [], execute: async () => big };
  const script: any[] = [];
  // 9 tool turns (unique args so the loop guard doesn't trip), then a final answer.
  for (let i = 0; i < 9; i++) script.push({ content: null, tool_calls: [{ id: `c${i}`, name: "read_file", arguments: { path: `p${i}` } }] });
  script.push({ content: "done", tool_calls: [] });
  const provider = {
    complete: async (msgs: any[]) => {
      // A summarizing compaction call (multi-turn fallback) -> return a stub summary, never a script item.
      if (msgs.length === 2 && String(msgs[0]?.content ?? "").startsWith("Summarize")) return { content: "SUMMARY", usage: {} };
      return script.shift();
    },
  };
  const agent = new Agent({ provider: provider as any, tools: tools as any, maxSteps: 20, maxContextTokens: 4000 });
  expect(await agent.run("go")).toBe("done");
  // Older tool observations were compressed IN PLACE (so the single long turn stayed under the window),
  // while the most recent ones were kept full.
  const clipped = agent.messages.filter((m: any) => typeof m.content === "string" && m.content.includes("chars elided to fit context"));
  expect(clipped.length).toBeGreaterThan(0);
  const fullRecent = agent.messages.filter((m: any) => m.role === "tool" && m.content === big);
  expect(fullRecent.length).toBeGreaterThan(0); // recent observations untouched
});
