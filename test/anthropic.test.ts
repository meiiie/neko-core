import { expect, test } from "bun:test";

import { addCacheBreakpoints, AnthropicProvider, extractJsonLoose, parseMessage, stripCacheBreakpoints, thinkingBudget, toAnthropicMessages, toAnthropicTools } from "../src/adapters/anthropic.ts";
import { NekoConfig } from "../src/adapters/config.ts";

test("thinkingBudget maps the effort ladder; off/unset => 0 (no extended thinking)", () => {
  expect(thinkingBudget("off")).toBe(0);
  expect(thinkingBudget("")).toBe(0);
  expect(thinkingBudget("nonsense")).toBe(0);
  expect(thinkingBudget("low")).toBeGreaterThan(0);
  expect(thinkingBudget("medium")).toBeGreaterThan(thinkingBudget("low"));
  expect(thinkingBudget("high")).toBeGreaterThan(thinkingBudget("medium"));
  expect(thinkingBudget("xhigh")).toBeGreaterThan(thinkingBudget("high"));
  expect(thinkingBudget("max")).toBeGreaterThan(thinkingBudget("xhigh"));
});

test("toAnthropicMessages: system folds to top-level, tool_calls -> tool_use, tool result -> user block", () => {
  const { system, msgs } = toAnthropicMessages([
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
    { role: "tool", tool_call_id: "t1", content: "RESULT" },
  ]);
  expect(system).toBe("SYS");
  expect(msgs[0]).toEqual({ role: "user", content: "hi" });
  expect(msgs[1].role).toBe("assistant");
  expect(msgs[1].content).toContainEqual({ type: "tool_use", id: "t1", name: "f", input: { x: 1 } });
  expect(msgs[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "RESULT" }] });
});

test("toAnthropicMessages: consecutive tool results merge into ONE user message", () => {
  const { msgs } = toAnthropicMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "x", arguments: "{}" } }, { id: "b", function: { name: "y", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "RA" },
    { role: "tool", tool_call_id: "b", content: "RB" },
  ]);
  const userMsg = msgs[msgs.length - 1];
  expect(userMsg.role).toBe("user");
  expect(userMsg.content.map((b: any) => b.tool_use_id)).toEqual(["a", "b"]);
});

test("toAnthropicMessages: image_url -> Anthropic image block", () => {
  const { msgs } = toAnthropicMessages([{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,ABC" } }] }]);
  expect(msgs[0].content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "ABC" } });
});

test("toAnthropicMessages: multimodal tool result keeps its screenshot", () => {
  const { msgs } = toAnthropicMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "shot", function: { name: "computer", arguments: '{"action":"screenshot"}' } }] },
    { role: "tool", tool_call_id: "shot", content: [
      { type: "text", text: "captured view=768x432 scale=0.4" },
      { type: "image_url", image_url: { url: "data:image/gif;base64,R0lGODlh" } },
    ] },
  ]);
  const result = msgs[1].content[0];
  expect(result.type).toBe("tool_result");
  expect(result.content).toContainEqual({ type: "text", text: "captured view=768x432 scale=0.4" });
  expect(result.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lGODlh" } });
});

test("toAnthropicTools: OpenAI function shape -> Anthropic input_schema", () => {
  expect(toAnthropicTools([{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }]))
    .toEqual([{ name: "f", description: "d", input_schema: { type: "object", properties: {} } }]);
});

test("parseMessage: text + tool_use + thinking + usage mapping", () => {
  const r = parseMessage({
    content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "hello" }, { type: "tool_use", id: "u1", name: "g", input: { a: 2 } }],
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  expect(r.content).toBe("hello");
  expect(r.reasoning).toBe("hmm");
  expect(r.tool_calls).toEqual([{ id: "u1", name: "g", arguments: { a: 2 } }]);
  expect(r.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
});

test("usage mapping: cache reads/writes fold back into prompt_tokens (Anthropic excludes them from input_tokens)", () => {
  const r = parseMessage({
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  });
  expect(r.usage).toEqual({ prompt_tokens: 125, completion_tokens: 7, total_tokens: 132, cached_tokens: 100, cache_write_tokens: 20 });
});

test("addCacheBreakpoints: system + last message get cache_control; strip restores the payload", () => {
  const payload: Record<string, any> = {
    system: "SYS",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "R1" }, { type: "tool_result", tool_use_id: "u", content: "R2" }] },
    ],
  };
  addCacheBreakpoints(payload);
  // System lifted to block form with the breakpoint at the end of the (stable) prefix.
  expect(payload.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  // Rolling breakpoint: ONLY the last block of the LAST message is marked.
  const blocks = payload.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
  expect(blocks.filter((b: any) => b.cache_control).length).toBe(1);
  expect(payload.messages[2].content[1].cache_control).toEqual({ type: "ephemeral" });
  // Untouched: a non-last message keeps its plain-string content.
  expect(payload.messages[0].content).toBe("hi");

  stripCacheBreakpoints(payload);
  expect(payload.system).toBe("SYS");
  expect(JSON.stringify(payload)).not.toContain("cache_control");
});

test("addCacheBreakpoints: a plain-string last message is lifted to block form; empty content is left alone", () => {
  const p1: Record<string, any> = { system: "S", messages: [{ role: "user", content: "hello" }] };
  addCacheBreakpoints(p1);
  expect(p1.messages[0].content).toEqual([{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
  const p2: Record<string, any> = { system: "", messages: [] };
  addCacheBreakpoints(p2); // no system text, no messages -> no crash, nothing marked
  expect(p2.system).toBe("");
});

test("HTTP 529 (Anthropic overloaded_error) is retried, not fatal - found live on Z.ai", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const cfg = new NekoConfig({ provider: "anthropic", base_url: "http://x", model: "m", reasoning_effort: "off", retry_base_delay_seconds: 0.01 }, null, {}, "k");
    const provider = new AnthropicProvider(cfg);
    const res = await provider.complete([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("ok");
    expect(calls).toBe(2); // 529 -> one backoff retry -> success (used to throw immediately)
  } finally {
    globalThis.fetch = orig;
  }
});

test("self-heals when an endpoint rejects cache_control: strips the breakpoints, retries once", async () => {
  const orig = globalThis.fetch;
  const sawCache: boolean[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const sent = JSON.parse(init.body);
    sawCache.push(JSON.stringify(sent).includes("cache_control"));
    if (JSON.stringify(sent).includes("cache_control")) {
      return new Response(JSON.stringify({ error: { message: "Unknown field: cache_control" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const cfg = new NekoConfig({ provider: "anthropic", base_url: "http://x", model: "m", reasoning_effort: "off" }, null, {}, "k");
    const provider = new AnthropicProvider(cfg);
    const res = await provider.complete([{ role: "system", content: "S" }, { role: "user", content: "hi" }]);
    expect(res.content).toBe("ok");
    expect(sawCache).toEqual([true, false]); // first try with breakpoints, healed retry without
  } finally {
    globalThis.fetch = orig;
  }
});

test("extractJsonLoose: fences, padding, and no-braces pass-through", () => {
  expect(extractJsonLoose('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(extractJsonLoose('Here you go:\n{"a": {"b": 2}}\nHope that helps!')).toBe('{"a": {"b": 2}}');
  expect(extractJsonLoose("no json here")).toBe("no json here"); // caller's JSON.parse fails loudly
});

test("responseSchema on the anthropic provider = forced tool call, no thinking; input comes back as JSON", async () => {
  const orig = globalThis.fetch;
  let sent: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "t", name: "emit_extraction", input: { lowest_price_vnd: 18990000, matches_query: true } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const cfg = new NekoConfig({ provider: "anthropic", base_url: "http://x", model: "m", reasoning_effort: "high" }, null, {}, "k");
    const res = await new AnthropicProvider(cfg).complete(
      [{ role: "user", content: "extract" }], undefined, undefined, undefined,
      { responseSchema: { type: "object", properties: { lowest_price_vnd: { type: "integer" } } } },
    );
    expect(sent.tool_choice).toEqual({ type: "tool", name: "emit_extraction" }); // FORCED
    expect(sent.tools[0].input_schema.properties.lowest_price_vnd.type).toBe("integer"); // schema IS the tool input
    expect(sent.thinking).toBeUndefined(); // forced tool_choice is incompatible with extended thinking
    expect(JSON.parse(res.content!)).toEqual({ lowest_price_vnd: 18990000, matches_query: true });
    expect(res.tool_calls).toEqual([]); // consumed as the structured result, not surfaced as a tool call
  } finally {
    globalThis.fetch = orig;
  }
});

test("responseSchema self-heals when tool_choice is rejected: prompt-JSON fallback + loose extraction", async () => {
  const orig = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const sent = JSON.parse(init.body);
    bodies.push(sent);
    if (sent.tool_choice) {
      return new Response(JSON.stringify({ error: { message: "tool_choice is not supported" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      content: [{ type: "text", text: 'Sure!\n```json\n{"price_found": false}\n```' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const cfg = new NekoConfig({ provider: "anthropic", base_url: "http://x", model: "m", reasoning_effort: "off" }, null, {}, "k");
    const res = await new AnthropicProvider(cfg).complete(
      [{ role: "system", content: "S" }, { role: "user", content: "extract" }], undefined, undefined, undefined,
      { responseSchema: { type: "object" } },
    );
    expect(bodies[1].tool_choice).toBeUndefined(); // healed retry dropped the force
    expect(JSON.stringify(bodies[1].system)).toContain("ONLY a single JSON object"); // fallback instruction appended
    expect(res.content).toBe('{"price_found": false}'); // fenced reply loose-extracted to clean JSON
  } finally {
    globalThis.fetch = orig;
  }
});

test("anthropic stream fires onToolCallReady at content_block_stop, BEFORE the stream ends", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read_file" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "tail-after-tool" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ];
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as any;
  const order: string[] = [];
  try {
    const cfg = new NekoConfig({ provider: "anthropic", base_url: "http://x", model: "m", reasoning_effort: "off" }, null, {}, "k");
    const res = await new AnthropicProvider(cfg).complete(
      [{ role: "user", content: "hi" }], undefined,
      (t, k) => { if (!k) order.push(`delta:${t}`); }, undefined,
      { onToolCallReady: (c) => order.push(`ready:${c.name}:${JSON.stringify(c.arguments)}`) },
    );
    expect(order[0]).toBe('ready:read_file:{"path":"a"}'); // fired at block stop, before the text tail streamed
    expect(order).toContain("delta:tail-after-tool");
    expect(res.tool_calls).toEqual([{ id: "t1", name: "read_file", arguments: { path: "a" } }]);
  } finally {
    globalThis.fetch = orig;
  }
});
