import { expect, test } from "bun:test";

import { parseMessage, toAnthropicMessages, toAnthropicTools } from "../src/adapters/anthropic.ts";

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
