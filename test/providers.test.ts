import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { getProvider, OpenAICompatProvider, parseOpenAIMessage } from "../src/adapters/providers.ts";

function cfg(provider: string) {
  return new NekoConfig({ provider }, null, {}, "");
}

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
