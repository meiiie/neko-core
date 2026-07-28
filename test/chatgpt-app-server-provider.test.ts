import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChatGptAppServerProvider,
  type CodexClientFactory,
} from "../src/adapters/chatgpt-app-server-provider.ts";
import { saveChatGptCredentials } from "../src/adapters/chatgpt-auth.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import type { CodexAppServerHandlers } from "../src/adapters/codex-app-server.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";

function setup(): NekoConfig {
  tempHome = mkdtempSync(join(tmpdir(), "neko-app-server-provider-"));
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  saveChatGptCredentials({
    accessToken: "header.payload.signature",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "acct-1",
  });
  return new NekoConfig({ provider: "chatgpt", model: "gpt-5.6-luna", reasoning_effort: "low" }, "chatgpt", {}, "");
}

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

test("GPT-5.6 provider authenticates externally, bridges one tool call, streams, and reports usage", async () => {
  const cfg = setup();
  const requests: Array<{ method: string; params: any }> = [];
  let handlers!: CodexAppServerHandlers;
  let toolResult: any;
  const factory: CodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}),
      close: () => {},
      request: async (method, params: any) => {
        requests.push({ method, params });
        if (method === "account/login/start") return { type: "chatgptAuthTokens" };
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") {
          setTimeout(async () => {
            toolResult = await handlers.onRequest?.("item/tool/call", {
              threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "read_file", arguments: { path: "README.md" },
            });
            handlers.onNotification?.("thread/tokenUsage/updated", {
              threadId: "thread-1",
              tokenUsage: { last: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cachedInputTokens: 4 } },
            });
            handlers.onNotification?.("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "BRIDGE_" });
            handlers.onNotification?.("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "OK" });
            handlers.onNotification?.("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
          }, 0);
          return { turn: { id: "turn-1" } };
        }
        return {};
      },
    };
  };
  const provider = new ChatGptAppServerProvider(cfg, factory);
  const deltas: string[] = [];
  let executions = 0;
  const response = await provider.complete(
    [
      { role: "system", content: "Be precise." },
      { role: "user", content: [
        { type: "text", text: "Read the screenshot." },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ] },
    ],
    [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    (delta, kind) => { if (kind === "content") deltas.push(delta); },
    undefined,
    { executeTool: async () => { executions++; return "file contents"; } },
  );

  expect(requests.find((request) => request.method === "account/login/start")?.params.type).toBe("chatgptAuthTokens");
  expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
    model: "gpt-5.6-luna", sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
  });
  expect(requests.find((request) => request.method === "thread/start")?.params.dynamicTools[0]).toMatchObject({
    type: "function", name: "read_file",
  });
  expect(requests.find((request) => request.method === "turn/start")?.params.input).toEqual([
    { type: "text", text: "Read the screenshot.", text_elements: [] },
    { type: "image", url: "data:image/png;base64,AAA" },
  ]);
  expect(toolResult).toEqual({ contentItems: [{ type: "inputText", text: "file contents" }], success: true });
  expect(executions).toBe(1);
  expect(deltas).toEqual(["BRIDGE_", "OK"]);
  expect(response).toMatchObject({
    content: "BRIDGE_OK",
    tool_calls: [],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cached_tokens: 4 },
  });
  provider.dispose();
});

test("prior conversation is injected as Codex-valid response items with an explicit type", async () => {
  const cfg = setup();
  const requests: Array<{ method: string; params: any }> = [];
  let handlers!: CodexAppServerHandlers;
  const factory: CodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => {},
      request: async (method, params: any) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") {
          setTimeout(() => {
            handlers.onNotification?.("item/agentMessage/delta", { threadId: "thread-1", delta: "ok" });
            handlers.onNotification?.("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
          }, 0);
          return { turn: { id: "turn-1" } };
        }
        return {};
      },
    };
  };
  const provider = new ChatGptAppServerProvider(cfg, factory);
  // A conversation carried over from GPT-5.5: user, assistant (with a tool call), tool result, then
  // the live user turn. Everything before the last message is injected into the fresh thread.
  await provider.complete(
    [
      { role: "system", content: "Be precise." },
      { role: "user", content: "Improve the DB plan." },
      { role: "assistant", content: "On it.", tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "plan.md contents" },
      { role: "user", content: "Continue on 5.6." },
    ],
    [],
    undefined,
    undefined,
    {},
  );

  const inject = requests.find((request) => request.method === "thread/inject_items");
  expect(inject).toBeDefined();
  const items = inject!.params.items as any[];
  // The exact failure the user hit: items[0] reached Codex with no `type`.
  expect(items.every((item) => typeof item.type === "string" && item.type.length > 0)).toBe(true);
  expect(items[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Improve the DB plan." }] });
  expect(items).toContainEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] });
  expect(items).toContainEqual({ type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}" });
  expect(items).toContainEqual({ type: "function_call_output", call_id: "call-1", output: "plan.md contents" });
  // The live turn is the last message and is sent via turn/start, not injected.
  expect(requests.find((request) => request.method === "turn/start")?.params.input).toEqual([
    { type: "text", text: "Continue on 5.6.", text_elements: [] },
  ]);
  provider.dispose();
});

test("dynamic tool call ids are idempotent inside one App Server turn", async () => {
  const cfg = setup();
  let handlers!: CodexAppServerHandlers;
  let executions = 0;
  const factory: CodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") {
          setTimeout(async () => {
            const call = { threadId: "thread-1", turnId: "turn-1", callId: "same", tool: "ls", arguments: {} };
            await Promise.all([handlers.onRequest?.("item/tool/call", call), handlers.onRequest?.("item/tool/call", call)]);
            handlers.onNotification?.("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
          }, 0);
          return { turn: { id: "turn-1" } };
        }
        return {};
      },
    };
  };
  const provider = new ChatGptAppServerProvider(cfg, factory);
  await provider.complete(
    [{ role: "user", content: "list" }],
    [{ function: { name: "ls", parameters: { type: "object" } } }],
    undefined,
    undefined,
    { executeTool: async () => { executions++; return "ok"; } },
  );
  expect(executions).toBe(1);
  provider.dispose();
});

test("a multi-call codex turn reports the SUM of its internal model calls, not just the last one", async () => {
  const cfg = setup();
  let handlers!: CodexAppServerHandlers;
  let turns = 0;
  const factory: CodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "t1" } };
        if (method === "turn/start") {
          turns++;
          // Thread-cumulative totals carry across turns: turn 2's counters start where turn 1 ended.
          const b = turns === 1 ? { p: 0, o: 0, t: 0, c: 0 } : { p: 360, o: 45, t: 405, c: 200 };
          setTimeout(() => {
            // Three internal model calls in ONE turn (the app-server runs its own tool loop).
            handlers.onNotification?.("thread/tokenUsage/updated", { threadId: "t1", tokenUsage: {
              last: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 0 },
              total: { inputTokens: b.p + 100, outputTokens: b.o + 10, totalTokens: b.t + 110, cachedInputTokens: b.c + 0 },
            } });
            handlers.onNotification?.("thread/tokenUsage/updated", { threadId: "t1", tokenUsage: {
              last: { inputTokens: 120, outputTokens: 20, totalTokens: 140, cachedInputTokens: 90 },
              total: { inputTokens: b.p + 220, outputTokens: b.o + 30, totalTokens: b.t + 250, cachedInputTokens: b.c + 90 },
            } });
            handlers.onNotification?.("thread/tokenUsage/updated", { threadId: "t1", tokenUsage: {
              last: { inputTokens: 140, outputTokens: 15, totalTokens: 155, cachedInputTokens: 110 },
              total: { inputTokens: b.p + 360, outputTokens: b.o + 45, totalTokens: b.t + 405, cachedInputTokens: b.c + 200 },
            } });
            handlers.onNotification?.("item/agentMessage/delta", { threadId: "t1", delta: "done" });
            handlers.onNotification?.("turn/completed", { threadId: "t1", turn: { id: `turn-${turns}`, status: "completed" } });
          }, 0);
          return { turn: { id: `turn-${turns}` } };
        }
        return {};
      },
    };
  };
  const provider = new ChatGptAppServerProvider(cfg, factory);
  const first = await provider.complete([{ role: "user", content: "go" }]);
  // The old behavior kept only the LAST call (140/15) - every multi-call turn undercounted.
  expect(first.usage).toMatchObject({
    prompt_tokens: 360, completion_tokens: 45, total_tokens: 405, cached_tokens: 200,
    context_tokens: 140, // the LIVE context is the last call's prompt, not the turn sum
    model_calls: 3,
  });
  // Turn 2 on the same thread: only ITS delta is reported, not the thread-cumulative again.
  const second = await provider.complete([{ role: "user", content: "more" }]);
  expect(second.usage).toMatchObject({ prompt_tokens: 360, completion_tokens: 45, total_tokens: 405, cached_tokens: 200, model_calls: 3 });
  provider.dispose();
});

test("a turn RUNNING LONGER than codex_keepalive is not killed mid-flight by the idle timer", async () => {
  const cfg = setup();
  cfg.data.codex_keepalive = 0.0002; // 12ms - far shorter than the second turn below
  let handlers!: CodexAppServerHandlers;
  let turns = 0;
  const factory: CodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "t1" } };
        if (method === "turn/start") {
          turns++;
          const wait = turns === 1 ? 0 : 60; // the second turn streams well past the keepalive window
          setTimeout(() => {
            handlers.onNotification?.("item/agentMessage/delta", { threadId: "t1", delta: `t${turns}` });
            handlers.onNotification?.("turn/completed", { threadId: "t1", turn: { id: `turn-${turns}`, status: "completed" } });
          }, wait);
          return { turn: { id: `turn-${turns}` } };
        }
        return {};
      },
    };
  };
  const provider = new ChatGptAppServerProvider(cfg, factory);
  await provider.complete([{ role: "user", content: "quick" }]); // arms the 12ms idle timer on settle
  // Start the long turn immediately; the armed timer used to fire MID-TURN and reject it with
  // "Codex App Server stopped" (the field failure on long research turns).
  const long = await provider.complete([{ role: "user", content: "deep research" }]);
  expect(long.content).toBe("t2");
  provider.dispose();
});

test("a missing bridge can be installed and retried without restarting Neko", async () => {
  const cfg = setup();
  cfg.data.codex_keepalive = 0.0002;
  let attempts = 0;
  let closes = 0;
  let handlers!: CodexAppServerHandlers;
  const factory: CodexClientFactory = (nextHandlers) => {
    attempts++;
    if (attempts === 1) throw new Error("support pack missing");
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => { closes++; },
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "thread-retry" } };
        if (method === "turn/start") {
          setTimeout(() => {
            handlers.onNotification?.("item/agentMessage/delta", { threadId: "thread-retry", delta: "ready" });
            handlers.onNotification?.("turn/completed", { threadId: "thread-retry", turn: { id: "turn-retry", status: "completed" } });
          }, 0);
          return { turn: { id: "turn-retry" } };
        }
        return {};
      },
    };
  };
  const provider = new ChatGptAppServerProvider(cfg, factory);
  await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow("support pack missing");
  expect((await provider.complete([{ role: "user", content: "hi again" }])).content).toBe("ready");
  expect(attempts).toBe(2);
  await Bun.sleep(40);
  expect(closes).toBe(1); // idle expiry releases the optional process
  provider.dispose();
});
