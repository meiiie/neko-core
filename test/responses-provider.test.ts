import { afterEach, expect, test } from "bun:test";

import { toResponsesInput } from "../src/adapters/chatgpt-provider.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { providerScope } from "../src/adapters/provider-scope.ts";
import { ResponsesProvider } from "../src/adapters/responses-provider.ts";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

test("official Responses provider sends the xAI contract and keeps encrypted reasoning local", async () => {
  const cfg = new NekoConfig({
    provider: "responses",
    base_url: "https://api.x.ai/v1",
    model: "grok-build-0.1",
    reasoning_effort: "high",
    effort_ceiling: "high",
    max_tokens: 4096,
    max_retries: 0,
  }, "grok-build", {}, "xai-secret");
  let url = "";
  let sent: any;
  let headers = new Headers();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    sent = JSON.parse(String(init?.body));
    headers = new Headers(init?.headers);
    const events = [
      { type: "response.reasoning_summary_text.delta", delta: "checking" },
      { type: "response.output_text.delta", delta: "done" },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "reason-1", encrypted_content: "opaque", summary: [] } },
      { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 }, output: [] } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;

  const result = await new ResponsesProvider(cfg).complete(
    [{ role: "system", content: "Be precise." }, { role: "user", content: "Fix it." }],
    [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  );

  expect(url).toBe("https://api.x.ai/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer xai-secret");
  expect(sent).toMatchObject({
    model: "grok-build-0.1",
    instructions: "Be precise.",
    store: false,
    stream: true,
    max_output_tokens: 4096,
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content"],
  });
  expect(sent.temperature).toBeUndefined();
  expect(sent.prompt_cache_key).toBeString();
  expect(sent.tools[0].name).toBe("read_file");
  expect(result).toMatchObject({ content: "done", reasoning: "checking", usage: { total_tokens: 11 } });
  expect(result.continuation).toEqual([{
    type: "neko_responses_continuation",
    scope: "responses:https://api.x.ai/v1/responses:grok-build-0.1",
    items: [{ type: "reasoning", id: "reason-1", encrypted_content: "opaque", summary: [] }],
  }]);
});

test("Responses continuation replays only to the exact endpoint and model", () => {
  const scope = providerScope("responses", "https://user:pass@api.x.ai/v1/responses?key=secret#x", "grok-4.5");
  expect(scope).toBe("responses:https://api.x.ai/v1/responses:grok-4.5");
  const message = {
    role: "assistant",
    content: "answer",
    provider_data: [{
      type: "neko_responses_continuation",
      scope,
      items: [{ type: "reasoning", id: "r", encrypted_content: "opaque", summary: [] }],
    }],
  };
  const same = toResponsesInput([message], scope).input;
  const switched = toResponsesInput([message], providerScope("responses", "https://api.x.ai/v1/responses", "grok-build-0.1")).input;
  expect(same.some((item) => item.type === "reasoning")).toBe(true);
  expect(switched.some((item) => item.type === "reasoning")).toBe(false);
  expect(switched.some((item) => item.role === "assistant")).toBe(true);
});

test("Responses effort negotiates the highest advertised compatible tier before using model default", async () => {
  const cfg = new NekoConfig({
    provider: "responses", base_url: "https://api.x.ai/v1", model: "future-model",
    reasoning_effort: "max", effort_ceiling: "ultra", max_retries: 0,
  }, null, {}, "key");
  const efforts: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    efforts.push(sent.reasoning?.effort ?? "default");
    if (efforts.length === 1) {
      return new Response(JSON.stringify({ error: { message: "reasoning effort should be 'low', 'medium' or 'xhigh'" } }), { status: 400 });
    }
    const body = `data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: {} } })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  await new ResponsesProvider(cfg).complete([{ role: "user", content: "hi" }]);
  expect(efforts).toEqual(["max", "xhigh"]);
});
