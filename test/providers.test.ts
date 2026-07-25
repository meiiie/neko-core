import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { clampEffort, getProvider, listModelOptions, makeThinkSplitter, normalizeToolResultImages, OpenAICompatProvider, parseOpenAIMessage, toImgTagMessages } from "../src/adapters/providers.ts";
import { ResponsesProvider } from "../src/adapters/responses-provider.ts";
import { SESSION_CONTEXT_MARK } from "../src/core/agent-constants.ts";

function cfg(provider: string) {
  return new NekoConfig({ provider }, null, {}, "");
}

test("think splitter routes <think> to reasoning, even split across stream chunks", () => {
  let content = "", reasoning = "";
  const s = makeThinkSplitter((c) => (content += c), (r) => (reasoning += r));
  for (const ch of ["Hello <thi", "nk>secret rea", "soning</thi", "nk> the ", "answer"]) s.push(ch);
  s.flush();
  expect(reasoning).toBe("secret reasoning");
  expect(content).toBe("Hello  the answer"); // think block removed from the answer
});

test("plain content (no think tags) streams through untouched", () => {
  let content = "", reasoning = "";
  const s = makeThinkSplitter((c) => (content += c), (r) => (reasoning += r));
  for (const ch of ["just ", "a normal ", "answer"]) s.push(ch);
  s.flush();
  expect(content).toBe("just a normal answer");
  expect(reasoning).toBe("");
});

test("OpenAI-compatible wire format moves tool screenshots after the complete tool-result batch", () => {
  const messages = normalizeToolResultImages([
    { role: "assistant", content: "", tool_calls: [
      { id: "shot", function: { name: "computer", arguments: '{"action":"screenshot"}' } },
      { id: "read", function: { name: "read_file", arguments: '{"path":"x"}' } },
    ] },
    { role: "tool", tool_call_id: "shot", content: [
      { type: "text", text: "captured scale=0.4" },
      { type: "image_url", image_url: { url: "data:image/gif;base64,AAA" } },
    ] },
    { role: "tool", tool_call_id: "read", content: "file text" },
  ]);
  expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
  expect(messages[1].content).toBe("captured scale=0.4");
  expect(messages[2].content).toBe("file text");
  expect(messages[3].content.some((p: any) => p.type === "image_url")).toBe(true);
  const nvidia = toImgTagMessages(messages);
  expect(nvidia[3].content).toContain('<img src="data:image/gif;base64,AAA" />');
});

test("NVIDIA img-tag wire format preserves interleaved text/image order", () => {
  const [message] = toImgTagMessages([{ role: "user", content: [
    { type: "text", text: "first [Image #1]" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,ONE" } },
    { type: "text", text: " then [Image #2]" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,TWO" } },
    { type: "text", text: " done" },
  ] }]);
  expect(message.content).toBe('first [Image #1]<img src="data:image/jpeg;base64,ONE" /> then [Image #2]<img src="data:image/jpeg;base64,TWO" /> done');
});

test("complete sends response_format json_schema only when a responseSchema is given (structured output)", async () => {
  const config = new NekoConfig({ provider: "openai_compat", base_url: "https://example/v1", model: "m" }, null, {}, "");
  const provider = getProvider(config);
  let sent: any = null;
  const realFetch = globalThis.fetch;
  const realKey = process.env.NEKO_API_KEY;
  process.env.NEKO_API_KEY = "k"; // key is read on-demand from env
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    await provider.complete([{ role: "user", content: "hi" }], undefined, undefined, undefined, { responseSchema: schema });
    expect(sent.response_format?.type).toBe("json_schema");
    expect(sent.response_format?.json_schema?.schema).toEqual(schema);
    await provider.complete([{ role: "user", content: "hi" }]); // no schema -> no response_format
    expect(sent.response_format).toBeUndefined();
    expect(sent.prompt_cache_key).toBeUndefined(); // do not leak OpenAI-only fields to compatible vendors
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.NEKO_API_KEY;
    else process.env.NEKO_API_KEY = realKey;
  }
});

test("official OpenAI chat completions use a stable key, stable-prefix breakpoint, and per-call effort", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  }) as typeof fetch;
  try {
    const config = new NekoConfig({
      provider: "openai_compat",
      base_url: "https://api.openai.com/v1",
      model: "gpt-5.6",
      reasoning_effort: "high",
      effort_ceiling: "high",
    }, null, {}, "test-key");
    const provider = new OpenAICompatProvider(config);
    await provider.complete([
      { role: "system", content: `stable rules${SESSION_CONTEXT_MARK}volatile cwd` },
      { role: "user", content: "one" },
    ], undefined, undefined, undefined, { reasoningEffort: "low" });
    await provider.complete([{ role: "user", content: "two" }]);
    expect(bodies[0].prompt_cache_key).toBeString();
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[1].reasoning_effort).toBe("high");
    expect(bodies[0].messages[0].content).toEqual([
      { type: "text", text: "stable rules", prompt_cache_breakpoint: { mode: "explicit" } },
      { type: "text", text: `${SESSION_CONTEXT_MARK}volatile cwd` },
    ]);
    expect(typeof bodies[1].messages[0].content).toBe("string"); // no seam -> ordinary message shape
    const older = new OpenAICompatProvider(new NekoConfig({
      provider: "openai_compat", base_url: "https://api.openai.com/v1", model: "gpt-5.5",
    }, null, {}, "test-key"));
    await older.complete([{ role: "system", content: `stable${SESSION_CONTEXT_MARK}volatile` }]);
    expect(typeof bodies[2].messages[0].content).toBe("string"); // explicit breakpoints start at GPT-5.6
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("idle timeout resets per chunk: a slow-but-active stream is NOT aborted (long generation)", async () => {
  // timeout_seconds is an IDLE budget, reset on every streamed chunk — not a total request cap. Chunks
  // arrive 120ms apart (< the 400ms idle) but total ~600ms (> 400ms). A total timeout would abort at
  // 400ms mid-stream ("operation timed out"); the idle reset must let it finish.
  const config = new NekoConfig({ provider: "openai_compat", base_url: "https://example/v1", model: "m", timeout_seconds: 0.4 }, null, {}, "");
  const provider = getProvider(config);
  const realFetch = globalThis.fetch;
  const realKey = process.env.NEKO_API_KEY;
  process.env.NEKO_API_KEY = "k";
  const sse = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
  globalThis.fetch = (async () => {
    const enc = new TextEncoder();
    const parts = ["Hel", "lo ", "lan", "ding", " page"]; // 5 chunks * 120ms = 600ms > 400ms idle budget
    const stream = new ReadableStream({
      async start(controller) {
        for (const p of parts) {
          await new Promise((r) => setTimeout(r, 120));
          controller.enqueue(enc.encode(sse(p)));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;
  try {
    const res = await provider.complete([{ role: "user", content: "hi" }], undefined, () => {});
    expect(res.content).toBe("Hello landing page"); // finished despite total time > timeout_seconds
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.NEKO_API_KEY; else process.env.NEKO_API_KEY = realKey;
  }
}, 5000);

test("parseOpenAIMessage extracts <think> from a non-streamed body", () => {
  const r = parseOpenAIMessage({ choices: [{ message: { content: "<think>weighing options</think>The answer is 42." } }] });
  expect(r.content).toBe("The answer is 42.");
  expect(r.reasoning).toBe("weighing options");
});

test("factory returns OpenAICompatProvider", () => {
  expect(getProvider(cfg("openai_compat"))).toBeInstanceOf(OpenAICompatProvider);
});

test("factory returns the standard Responses provider", () => {
  expect(getProvider(cfg("responses"))).toBeInstanceOf(ResponsesProvider);
});

test("official Anthropic model discovery never sends the API key as a Bearer token", async () => {
  const originalFetch = globalThis.fetch;
  let sentHeaders: Headers | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sentHeaders = new Headers(init?.headers);
    return Response.json({ data: [{ id: "claude-sonnet-5" }] });
  }) as any;
  try {
    const config = new NekoConfig(
      { provider: "anthropic", base_url: "https://api.anthropic.com", model: "claude-sonnet-5" },
      "claude",
      { claude: { provider: "anthropic", key_env: "ANTHROPIC_API_KEY" } },
      "anthropic-key",
    );
    expect((await listModelOptions(config)).map((model) => model.id)).toEqual(["claude-sonnet-5"]);
    expect(sentHeaders?.get("x-api-key")).toBe("anthropic-key");
    expect(sentHeaders?.has("authorization")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function netCfg(offlineSeconds: number) {
  // localhost -> no api key required; tiny delays so the test is fast.
  return new NekoConfig(
    { provider: "openai_compat", base_url: "http://localhost:9/v1", model: "m", retry_base_delay_seconds: 0.01, retry_max_delay_seconds: 0.01, offline_retry_seconds: offlineSeconds },
    null, {}, "",
  );
}

test("network-resilient: keeps retrying a dropped connection, then resumes", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) throw new TypeError("fetch failed"); // offline twice (laptop asleep)
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const res = await new OpenAICompatProvider(netCfg(5)).complete([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("ok");
    expect(calls).toBe(3); // failed twice while offline, succeeded on reconnect
  } finally {
    globalThis.fetch = orig;
  }
});

test("network-resilient: gives up once the offline budget is exhausted", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as any; // never comes back
  try {
    await new OpenAICompatProvider(netCfg(0)).complete([{ role: "user", content: "hi" }]);
    throw new Error("should have thrown");
  } catch (e) {
    expect(String((e as Error).message)).toContain("completion failed");
  } finally {
    globalThis.fetch = orig;
  }
});

test("self-heals when an endpoint rejects reasoning_effort: drops the field, retries, remembers", async () => {
  const orig = globalThis.fetch;
  const sentEffort: (string | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const sent = JSON.parse(init.body);
    sentEffort.push(sent.reasoning_effort);
    if (sent.reasoning_effort !== undefined) {
      // vLLM-style validation error naming the offending field
      return new Response(JSON.stringify({ error: { message: "validation: 'reasoning_effort' Input should be 'low','medium' or 'high'" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const c = new NekoConfig({ provider: "openai_compat", base_url: "http://x/v1", model: "m", reasoning_effort: "max" }, null, {}, "k");
    const provider = new OpenAICompatProvider(c);
    const res = await provider.complete([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("ok");
    expect(sentEffort[0]).toBe("max");     // first try sends the configured value (pass-through)
    expect(sentEffort[1]).toBe("high");    // clamp to the highest accepted tier first
    expect(sentEffort[2]).toBeUndefined(); // then drop when 'high' also fails (field truly unsupported)
    // remembered for the model: a second call omits the field up front (no wasted 400)
    sentEffort.length = 0;
    await provider.complete([{ role: "user", content: "again" }]);
    expect(sentEffort[0]).toBeUndefined();
  } finally {
    globalThis.fetch = orig;
  }
});

test("clampEffort maps a configured effort down to the endpoint ceiling (extensible per profile)", () => {
  expect(clampEffort("max", "high")).toBe("high"); // gpt-oss reality: high IS the model's ceiling
  expect(clampEffort("xhigh", "high")).toBe("high");
  expect(clampEffort("high", "high")).toBe("high");
  expect(clampEffort("medium", "high")).toBe("medium"); // below ceiling -> untouched
  expect(clampEffort("max", "max")).toBe("max"); // endpoint that supports max -> passes through
  expect(clampEffort("max", "")).toBe("max"); // no ceiling declared -> pass through
  expect(clampEffort("weird", "high")).toBe("weird"); // unknown vocab -> pass through, let self-heal handle
});

test("MoA: references analyze WITHOUT tools, aggregator acts WITH tools + their advice, cost summed", async () => {
  const orig = globalThis.fetch;
  const calls: { model: string; hasTools: boolean; sys: string }[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const sys = body.messages.find((m: any) => m.role === "system")?.content ?? "";
    calls.push({ model: body.model, hasTools, sys });
    const ok = (content: string, usage: any) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, headers: { "content-type": "application/json" } });
    return body.model === "agg"
      ? ok("FINAL", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
      : ok(`analysis-${body.model}`, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }) as any;
  try {
    const cfg = new NekoConfig({ provider: "moa", base_url: "http://x/v1", moa: { references: ["ref-a", "ref-b"], aggregator: "agg" } }, null, {}, "k");
    const res = await getProvider(cfg).complete(
      [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
      [{ type: "function", function: { name: "t", parameters: {} } }],
    );
    const refCalls = calls.filter((c) => c.model !== "agg");
    const aggCalls = calls.filter((c) => c.model === "agg");
    expect(refCalls.length).toBe(2);
    expect(refCalls.every((c) => !c.hasTools)).toBe(true); // advisors never get tools
    expect(refCalls.every((c) => c.sys === "")).toBe(true); // advisory-safe view: no system prompt re-billed
    expect(aggCalls.length).toBe(1);
    expect(aggCalls[0].hasTools).toBe(true); // only the aggregator acts
    expect(aggCalls[0].sys).toContain("MIXTURE-OF-AGENTS");
    expect(aggCalls[0].sys).toContain("analysis-ref-a");
    expect(aggCalls[0].sys).toContain("analysis-ref-b");
    expect(aggCalls[0].sys).toContain("SYS"); // base system preserved
    expect(res.content).toBe("FINAL");
    expect(res.usage?.total_tokens).toBe(15 + 15 + 150); // whole mixture billed
    expect(res.usage?.prompt_tokens).toBe(100); // aggregator's only (context-window math not inflated)
  } finally {
    globalThis.fetch = orig;
  }
});

test("MoA: a failing reference degrades to a noted gap; the turn still completes", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.model === "bad") return new Response("boom", { status: 500 });
    const content = body.model === "agg" ? "DONE" : "ok";
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const cfg = new NekoConfig({ provider: "moa", base_url: "http://x/v1", max_retries: 0, moa: { references: ["good", "bad"], aggregator: "agg" } }, null, {}, "k");
    const res = await getProvider(cfg).complete([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("DONE"); // the bad advisor didn't sink the turn
  } finally {
    globalThis.fetch = orig;
  }
});

test("effort_ceiling clamps 'max' to 'high' UP FRONT (single request, no 400 round-trip)", async () => {
  const orig = globalThis.fetch;
  const sentEffort: (string | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    sentEffort.push(JSON.parse(init.body).reasoning_effort);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const c = new NekoConfig({ provider: "openai_compat", base_url: "http://x/v1", model: "m", reasoning_effort: "max", effort_ceiling: "high" }, null, {}, "k");
    await new OpenAICompatProvider(c).complete([{ role: "user", content: "hi" }]);
    expect(sentEffort).toEqual(["high"]); // clamped proactively -> one request, no wasted 400
  } finally {
    globalThis.fetch = orig;
  }
});

test("clamps reasoning_effort 'max' to 'high' on an endpoint that caps at high (intent preserved, not dropped)", async () => {
  const orig = globalThis.fetch;
  const sentEffort: (string | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const sent = JSON.parse(init.body);
    sentEffort.push(sent.reasoning_effort);
    if (sent.reasoning_effort === "max") {
      return new Response(JSON.stringify({ error: { message: "validation: 'reasoning_effort' Input should be 'low', 'medium' or 'high'" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const c = new NekoConfig({ provider: "openai_compat", base_url: "http://x/v1", model: "m", reasoning_effort: "max" }, null, {}, "k");
    const provider = new OpenAICompatProvider(c);
    const res = await provider.complete([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("ok");
    expect(sentEffort).toEqual(["max", "high"]); // clamped to 'high', NOT dropped
    // remembered: a second call sends 'high' up front (keeps high-effort, no wasted 400)
    sentEffort.length = 0;
    await provider.complete([{ role: "user", content: "again" }]);
    expect(sentEffort[0]).toBe("high");
  } finally {
    globalThis.fetch = orig;
  }
});

test("factory unknown provider throws", () => {
  expect(() => getProvider(cfg("nope"))).toThrow();
});

test("parse content only", () => {
  const out = parseOpenAIMessage({ choices: [{ message: { content: "hi" } }] });
  expect(out.content).toBe("hi");
  expect(out.tool_calls).toEqual([]);
});

test("parse tool calls", () => {
  const out = parseOpenAIMessage({
    choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } }] } }],
  });
  expect(out.tool_calls[0]).toEqual({ id: "c1", name: "read_file", arguments: { path: "a" } });
});

test("parse bad arguments kept raw", () => {
  const out = parseOpenAIMessage({
    choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "x", arguments: "{bad" } }] } }],
  });
  expect(out.tool_calls[0].arguments._raw).toBe("{bad");
});

test("parse error object throws with message", () => {
  expect(() => parseOpenAIMessage({ error: { message: "boom" } })).toThrow(/boom/);
});

test("parse captures usage", () => {
  const out = parseOpenAIMessage({ choices: [{ message: { content: "x" } }], usage: { total_tokens: 5 } });
  expect(out.usage?.total_tokens).toBe(5);
});

test("openai stream finalizes tool call i when the index advances (onToolCallReady mid-stream)", async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"x"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "search", arguments: '{"pattern":"y"}' } }] } }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as any;
  const ready: string[] = [];
  try {
    const c = new NekoConfig({ provider: "openai_compat", base_url: "http://x/v1", model: "m", reasoning_effort: "off" }, null, {}, "k");
    const res = await new OpenAICompatProvider(c).complete(
      [{ role: "user", content: "hi" }], undefined, () => {}, undefined,
      { onToolCallReady: (call) => ready.push(call.name) },
    );
    expect(ready).toEqual(["read_file", "search"]); // call 0 finalized when index 1 appeared; last at stream end
    expect(res.tool_calls).toEqual([
      { id: "a", name: "read_file", arguments: { path: "x" } },
      { id: "b", name: "search", arguments: { pattern: "y" } },
    ]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("openai stream accumulates interleaved parallel tool-call deltas by index", async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"' } },
      { index: 1, id: "b", function: { name: "search", arguments: '{"pattern":"' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: 'x"}' } },
      { index: 1, function: { arguments: 'y"}' } },
    ] } }] },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as any;
  const ready: any[] = [];
  try {
    const c = new NekoConfig({ provider: "openai_compat", base_url: "http://x/v1", model: "m", reasoning_effort: "off" }, null, {}, "k");
    const res = await new OpenAICompatProvider(c).complete(
      [{ role: "user", content: "hi" }], undefined, () => {}, undefined,
      { onToolCallReady: (call) => ready.push(call) },
    );
    expect(ready.map((x) => x.arguments)).toEqual([{ path: "x" }, { pattern: "y" }]);
    expect(res.tool_calls.map((x) => x.arguments)).toEqual([{ path: "x" }, { pattern: "y" }]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("OpenAI-compatible tool metadata replays only to the endpoint and model that produced it", async () => {
  const origin = "https://generativelanguage.googleapis.com/v1beta/openai";
  const firstChunk = {
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"package.json"}' },
      extra_content: { google: { thought_signature: "encrypted-signature" } },
    }] } }],
  };
  const stream = `data: ${JSON.stringify(firstChunk)}\n\ndata: [DONE]\n\n`;
  const sent: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    if (sent.length === 1) return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const provider = new OpenAICompatProvider(new NekoConfig(
      { provider: "openai_compat", base_url: origin, model: "gemini-3.5-flash", reasoning_effort: "off" },
      "gemini-api",
      {},
      "key",
    ));
    const first = await provider.complete([{ role: "user", content: "read package.json" }], undefined, () => {});
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: first.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
      provider_data: first.continuation,
    };
    const history = [
      { role: "user", content: "read package.json" },
      assistant,
      { role: "tool", tool_call_id: "call_1", content: "{}" },
    ];
    await provider.complete(history);
    expect(sent[1].body.messages[1].extra_content).toBeUndefined();
    expect(sent[1].body.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe("encrypted-signature");
    expect(sent[1].body.messages[1].provider_data).toBeUndefined();

    const switchedModel = new OpenAICompatProvider(new NekoConfig(
      { provider: "openai_compat", base_url: origin, model: "gemini-other" },
      null,
      {},
      "key",
    ));
    await switchedModel.complete(history);
    expect(sent[2].body.messages[1].tool_calls[0].extra_content).toBeUndefined();

    const other = new OpenAICompatProvider(new NekoConfig(
      { provider: "openai_compat", base_url: "https://api.example/v1", model: "other" },
      null,
      {},
      "key",
    ));
    await other.complete(history);
    expect(sent[3].body.messages[1].tool_calls[0].extra_content).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("DeepSeek V4 sends current thinking controls and replays tool-turn reasoning_content", async () => {
  const orig = globalThis.fetch;
  const sent: any[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    calls++;
    if (calls === 1) return Response.json({ choices: [{ message: {
      role: "assistant",
      content: null,
      reasoning_content: "opaque tool reasoning",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
    } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] });
  }) as typeof fetch;
  try {
    const config = new NekoConfig({
      provider: "openai_compat",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      reasoning_effort: "max",
      effort_ceiling: "max",
      thinking_wire: "toggle",
      max_tokens: 65_536,
    }, "deepseek", { deepseek: { key_env: "DEEPSEEK_API_KEY" } }, "secret");
    const provider = new OpenAICompatProvider(config);
    const first = await provider.complete([{ role: "user", content: "inspect" }]);
    await provider.complete([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        tool_calls: first.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
        provider_data: first.continuation,
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
    expect(sent[0].thinking).toEqual({ type: "enabled" });
    expect(sent[0].reasoning_effort).toBe("max");
    expect(sent[0].max_tokens).toBe(65_536);
    expect(sent[1].messages[1].reasoning_content).toBe("opaque tool reasoning");
    expect(sent[1].messages[1].provider_data).toBeUndefined();
  } finally {
    globalThis.fetch = orig;
  }
});

test("OpenAI-compat omits the token cap when max_tokens is unset (0 = auto -> the model's full output budget)", async () => {
  const orig = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as typeof fetch;
  try {
    const config = new NekoConfig(
      { provider: "openai_compat", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
      "groq", { groq: { key_env: "GROQ_API_KEY" } }, "secret",
    );
    expect(config.maxTokens).toBe(0);
    await new OpenAICompatProvider(config).complete([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  } finally {
    globalThis.fetch = orig;
  }
});

test("Kimi API route uses the official completion budget and thinking wire without a proxy", async () => {
  const orig = globalThis.fetch;
  let body: any;
  let authorization = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  }) as typeof fetch;
  try {
    const config = new NekoConfig({
      provider: "kimi",
      base_url: "https://api.moonshot.ai/v1",
      model: "kimi-k2.5",
      reasoning_effort: "max",
      effort_ceiling: "high",
      thinking_wire: "toggle",
      max_tokens: 32_000,
    }, "moonshot", { moonshot: { auth: "api_key", key_env: "KIMI_API_KEY" } }, "kimi-secret");
    await getProvider(config).complete([{ role: "user", content: "hello" }]);
    expect(authorization).toBe("Bearer kimi-secret");
    expect(body.max_tokens).toBe(32_000);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: "enabled" });
  } finally {
    globalThis.fetch = orig;
  }
});
