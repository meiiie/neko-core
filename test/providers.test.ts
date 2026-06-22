import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { getProvider, OpenAICompatProvider, parseOpenAIMessage } from "../src/adapters/providers.ts";

function cfg(provider: string) {
  return new NekoConfig({ provider }, null, {}, "");
}

test("factory returns OpenAICompatProvider", () => {
  expect(getProvider(cfg("openai_compat"))).toBeInstanceOf(OpenAICompatProvider);
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
