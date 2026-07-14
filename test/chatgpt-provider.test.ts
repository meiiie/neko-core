import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveChatGptCredentials } from "../src/adapters/chatgpt-auth.ts";
import { HybridChatGptProvider } from "../src/adapters/chatgpt-app-server-provider.ts";
import { CHATGPT_CODEX_COMPAT_VERSION, ChatGptProvider, getChatGptUsage, isDirectChatGptModel, listChatGptModelCatalog, listChatGptModels, parseResponsesStream, resolveChatGptEffort, toResponsesInput, toResponsesTools } from "../src/adapters/chatgpt-provider.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { getProvider, listModelOptions, listModels } from "../src/adapters/providers.ts";

const originalFetch = globalThis.fetch;
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";

function setup(): NekoConfig {
  tempHome = mkdtempSync(join(tmpdir(), "neko-chatgpt-provider-"));
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  saveChatGptCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, accountId: "acct-1" });
  return new NekoConfig({ provider: "chatgpt", base_url: "https://malicious.invalid", model: "gpt-5.4", reasoning_effort: "high", max_retries: 0 }, "chatgpt", {}, "");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

test("Responses conversion preserves system instructions, function calls, tool output, and images", () => {
  const converted = toResponsesInput([
    { role: "system", content: "Be precise." },
    { role: "user", content: "read it" },
    { role: "assistant", content: null, provider_data: [{ type: "reasoning", id: "r-0", encrypted_content: "opaque", summary: [] }], tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: '{"path":"x"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "ok" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
  ]);
  expect(converted.instructions).toBe("Be precise.");
  expect(converted.input.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque")).toBe(true);
  expect(converted.input.some((item) => item.type === "function_call" && item.call_id === "call-1")).toBe(true);
  expect(converted.input.some((item) => item.type === "function_call_output" && item.output === "ok")).toBe(true);
  expect(converted.input.some((item) => item.content?.[0]?.type === "input_image")).toBe(true);
  expect(toResponsesTools([{ function: { name: "read_file", description: "Read", parameters: { type: "object" } } }])[0]).toEqual({
    type: "function", name: "read_file", description: "Read", parameters: { type: "object" }, strict: false,
  });
});

test("ChatGPT provider uses only the fixed Codex backend and parses streamed text, tools, and usage", async () => {
  const cfg = setup();
  let url = "", sent: any, headers = new Headers();
  const events = [
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.output_item.done", output_index: 0, item: { id: "r-1", type: "reasoning", encrypted_content: "encrypted", summary: [] } },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "read_file", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: '{"path":"README.md"}' },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' } },
    { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 7 } }, output: [] } },
  ];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input); sent = JSON.parse(String(init?.body)); headers = new Headers(init?.headers);
    const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const deltas: string[] = [], eager: string[] = [];
  const result = await getProvider(cfg).complete(
    [{ role: "system", content: "System" }, { role: "user", content: "Hi" }],
    [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    (text, kind) => { if (kind === "content") deltas.push(text); },
    undefined,
    { onToolCallReady: (call) => eager.push(call.id) },
  );
  expect(getProvider(cfg)).toBeInstanceOf(HybridChatGptProvider);
  expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(url).not.toContain("malicious.invalid");
  expect(headers.get("authorization")).toBe("Bearer access");
  expect(headers.get("chatgpt-account-id")).toBe("acct-1");
  expect(sent.store).toBe(false);
  expect(sent.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(sent.include).toEqual(["reasoning.encrypted_content"]);
  expect(result.content).toBe("Hello");
  expect(result.tool_calls).toEqual([{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }]);
  expect(result.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 5, cached_tokens: 7 });
  expect(result.continuation).toEqual([{
    type: "neko_responses_continuation",
    scope: "responses:https://chatgpt.com/backend-api/codex/responses:gpt-5.4",
    items: [{ type: "reasoning", id: "r-1", encrypted_content: "encrypted", summary: [] }],
  }]);
  expect(deltas).toEqual(["Hello"]);
  expect(eager).toEqual(["call-1"]);
});

test("Responses parser preserves finalized tool arguments across sparse completion events", async () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { id: "fc-computer", type: "function_call", call_id: "call-computer", name: "computer", arguments: "" } },
    { type: "response.function_call_arguments.done", item_id: "fc-computer", call_id: "call-computer", name: "computer", arguments: '{"action":"list"}' },
    { type: "response.output_item.done", output_index: 0, item: { id: "fc-computer", type: "function_call", call_id: "call-computer", name: "computer", arguments: "" } },
    { type: "response.completed", response: { output: [
      { id: "fc-computer", type: "function_call", call_id: "call-computer", name: "computer", arguments: "{}" },
    ], usage: {} } },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const eager: any[] = [];
  const result = await parseResponsesStream(new Response(body), undefined, (call) => eager.push(call));
  expect(result.tool_calls).toEqual([{ id: "call-computer", name: "computer", arguments: { action: "list" } }]);
  expect(eager).toEqual([{ id: "call-computer", name: "computer", arguments: { action: "list" } }]);
});

test("Responses parser rejects a disconnected stream instead of accepting a partial answer", async () => {
  const response = new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`);
  await expect(parseResponsesStream(response)).rejects.toThrow("before response.completed");
});

test("a backend 401 forces one token refresh and retries with the new bearer", async () => {
  const cfg = setup();
  let backendCalls = 0, refreshCalls = 0;
  const bearers: string[] = [];
  const access = `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: "acct-2" })).toString("base64url")}.sig`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      refreshCalls++;
      return Response.json({ access_token: access, refresh_token: "refresh-2", expires_in: 3600 });
    }
    backendCalls++;
    bearers.push(new Headers(init?.headers).get("authorization") ?? "");
    if (backendCalls === 1) return new Response("unauthorized", { status: 401 });
    const body = [
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(body + "data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;
  const result = await getProvider(cfg).complete([{ role: "user", content: "hi" }]);
  expect(result.content).toBe("ok");
  expect(refreshCalls).toBe(1);
  expect(bearers).toEqual(["Bearer access", `Bearer ${access}`]);
});

test("ChatGPT model picker uses the live account catalog and hides non-list models", async () => {
  setup();
  let url = "", account = "";
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    account = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
    return Response.json({ models: [
      { slug: "gpt-live-new", display_name: "GPT Live", description: "Latest", visibility: "list", default_reasoning_level: "medium", context_window: 372000,
        input_modalities: ["text", "image"], use_responses_lite: false, tool_mode: "standard", minimal_client_version: "0.144.0",
        supported_reasoning_levels: [{ effort: "low", description: "fast" }, { effort: "ultra", description: "delegate" }] },
      { slug: "gpt-hidden", visibility: "hide" },
      { slug: "gpt-live-second", visibility: "list" },
    ] });
  }) as typeof fetch;
  const catalog = await listChatGptModelCatalog(mockFetch);
  expect(catalog[0]).toEqual({
    slug: "gpt-live-new", displayName: "GPT Live", description: "Latest", defaultEffort: "medium",
    efforts: [{ effort: "low", description: "fast" }, { effort: "ultra", description: "delegate" }], contextWindow: 372000,
    inputModalities: ["text", "image"], useResponsesLite: false, toolMode: "standard", minimalClientVersion: "0.144.0",
  });
  expect(isDirectChatGptModel(catalog[0])).toBe(true);
  expect(await listChatGptModels(mockFetch)).toEqual(["gpt-live-new", "gpt-live-second"]);
  expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_CODEX_COMPAT_VERSION}`);
  expect(account).toBe("acct-1");
});

test("live model options expose GPT-5.6 for the optional App Server route", async () => {
  const cfg = setup();
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ models: [
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", use_responses_lite: true, tool_mode: "code_mode_only", input_modalities: ["text", "image"] },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", use_responses_lite: false, input_modalities: ["text", "image"] },
  ] })) as typeof fetch;
  const withSupport = await listModelOptions(cfg, { state: "ready", detail: "path 0.144.1" });
  expect(withSupport.map((model) => model.id)).toEqual(["gpt-5.6-luna", "gpt-5.5"]);
  const withoutSupport = await listModelOptions(cfg, { state: "missing", detail: "not installed" });
  expect(withoutSupport.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
    requiresCodexSupport: true,
    available: false,
  });
  expect(withoutSupport.find((model) => model.id === "gpt-5.5")?.available).toBe(true);
});

test("the direct adapter still self-heals an accidental 5.6 request instead of spoofing Codex", async () => {
  const cfg = setup();
  cfg.data.model = "gpt-5.6-luna";
  let sent: any;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/models")) return Response.json({ models: [
      { slug: "gpt-5.6-luna", visibility: "list", use_responses_lite: true, tool_mode: "code_mode_only", input_modalities: ["text", "image"] },
      { slug: "gpt-5.5", visibility: "list", use_responses_lite: false, input_modalities: ["text", "image"], default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })) },
    ] });
    sent = JSON.parse(String(init?.body));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: {} } })}\n\ndata: [DONE]\n\n`, { status: 200 });
  }) as typeof fetch;
  const notices: string[] = [];
  await new ChatGptProvider(cfg).complete([{ role: "user", content: "hi" }], undefined, (text, kind) => { if (kind === "reasoning") notices.push(text); });
  expect(sent.model).toBe("gpt-5.5");
  expect(cfg.model).toBe("gpt-5.5");
  expect(cfg.vision).toBe(true);
  expect(JSON.parse(readFileSync(join(tempHome, ".neko-core", "config.json"), "utf8")).profiles.chatgpt.model).toBe("gpt-5.5");
  expect(notices.join(" ")).toContain("official Codex Responses-Lite/code-mode transport");
});

test("a retryable SSE failure before output retries once without duplicating visible activity", async () => {
  const cfg = setup();
  cfg.data.max_retries = 1;
  cfg.data.retry_base_delay_seconds = 0;
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
    calls++;
    if (calls === 1) return new Response(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "An error occurred while processing your request." } } })}\n\n`, { status: 200 });
    return new Response([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { output: [], usage: {} } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
  }) as typeof fetch;
  expect((await getProvider(cfg).complete([{ role: "user", content: "hi" }])).content).toBe("ok");
  expect(calls).toBe(2);
});

test("model-aware effort keeps supported tiers and clamps only to the nearest declared tier", () => {
  const sol = { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort, description: "" })) };
  const luna = { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort, description: "" })) };
  const old = { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort, description: "" })) };
  expect(resolveChatGptEffort("ultra", sol)).toBe("ultra");
  expect(resolveChatGptEffort("ultra", luna)).toBe("max");
  expect(resolveChatGptEffort("max", old)).toBe("xhigh");
  expect(resolveChatGptEffort("off", sol)).toBe("off");
});

test("saved max effort on GPT-5.4 is resolved from the catalog before the Responses request", async () => {
  const cfg = setup();
  cfg.data.reasoning_effort = "max";
  let sent: any;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/models")) return Response.json({ models: [{
      slug: "gpt-5.4", visibility: "list", default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })),
    }] });
    sent = JSON.parse(String(init?.body));
    const body = `data: ${JSON.stringify({ type: "response.completed", response: { output: [], usage: {} } })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const notices: string[] = [];
  await getProvider(cfg).complete([{ role: "user", content: "hi" }], undefined, (text, kind) => { if (kind === "reasoning") notices.push(text); });
  expect(sent.reasoning.effort).toBe("xhigh");
  expect(notices.join(" ")).toContain("max -> xhigh");
});

test("ChatGPT usage parses plan, primary/weekly windows, extra model limits, and credits", async () => {
  setup();
  let url = "", account = "";
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input); account = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
    return Response.json({
      plan_type: "pro",
      rate_limit: { allowed: false, limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 2000 },
        secondary_window: { used_percent: 29, limit_window_seconds: 604800, reset_at: 9000 } },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      additional_rate_limits: [{ limit_name: "Spark", metered_feature: "spark", rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 3000 } } }],
    });
  }) as typeof fetch;
  const usage = await getChatGptUsage(mockFetch);
  expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
  expect(account).toBe("acct-1");
  expect(usage.planType).toBe("pro");
  expect(usage.limits[0]).toMatchObject({ id: "codex", limitReached: true, primary: { usedPercent: 100 }, secondary: { usedPercent: 29 } });
  expect(usage.limits[1]).toMatchObject({ id: "spark", name: "Spark", primary: { usedPercent: 4 } });
  expect(usage.credits).toEqual({ hasCredits: false, unlimited: false, balance: "0" });
});

test("ChatGPT model picker falls back to the configured catalog when the live endpoint fails", async () => {
  setup();
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ detail: "temporary failure" }), { status: 503 })) as typeof fetch;
  const cfg = new NekoConfig(
    { provider: "chatgpt", model: "gpt-5.4" },
    "chatgpt",
    { chatgpt: { models: ["gpt-5.4-mini", "gpt-5.5"] } },
    "",
  );
  expect(await listModels(cfg)).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
});
