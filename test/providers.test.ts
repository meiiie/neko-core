import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { getProvider, makeThinkSplitter, OpenAICompatProvider, parseOpenAIMessage } from "../src/adapters/providers.ts";

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
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.NEKO_API_KEY;
    else process.env.NEKO_API_KEY = realKey;
  }
});

test("parseOpenAIMessage extracts <think> from a non-streamed body", () => {
  const r = parseOpenAIMessage({ choices: [{ message: { content: "<think>weighing options</think>The answer is 42." } }] });
  expect(r.content).toBe("The answer is 42.");
  expect(r.reasoning).toBe("weighing options");
});

test("factory returns OpenAICompatProvider", () => {
  expect(getProvider(cfg("openai_compat"))).toBeInstanceOf(OpenAICompatProvider);
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
