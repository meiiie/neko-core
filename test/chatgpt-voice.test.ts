import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChatGptVoiceSession,
  friendlyVoiceError,
  realtimeInitialItems,
  type VoiceCodexClientFactory,
  type VoiceEvent,
} from "../src/adapters/chatgpt-voice.ts";
import { saveChatGptCredentials } from "../src/adapters/chatgpt-auth.ts";
import type { CodexAppServerHandlers } from "../src/adapters/codex-app-server.ts";
import { estimateTokens } from "../src/core/agent-constants.ts";
import type { NativeVoiceAudioOptions, RealtimePcmChunk } from "../src/adapters/native-voice-audio.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
let tempHome = "";
let active: ChatGptVoiceSession | null = null;

function setupAuth(): void {
  tempHome = mkdtempSync(join(tmpdir(), "neko-voice-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  saveChatGptCredentials({
    accessToken: "header.payload.signature",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "acct-voice",
  });
}

afterEach(async () => {
  await active?.stop("test cleanup");
  active = null;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
});

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }));
}

test("realtime history stays inside the token budget for dense non-ASCII text", () => {
  const cjk = "\u754c".repeat(4_000);
  const items = realtimeInitialItems([
    { role: "system", content: cjk },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: cjk,
    })),
    { role: "tool", content: cjk },
  ]);
  const estimated = estimateTokens(items.map((item) => ({ role: item.role, content: item.text })));
  expect(estimated).toBeLessThanOrEqual(8_192);
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThanOrEqual(64);
  expect(items.every((item) => item.role === "user" || item.role === "assistant")).toBe(true);
});

test("subscription voice keeps consent in the browser and negotiates WebRTC through App Server", async () => {
  setupAuth();
  const requests: Array<{ method: string; params: any }> = [];
  const events: VoiceEvent[] = [];
  let handlers!: CodexAppServerHandlers;
  let closed = 0;
  let readToolCalls = 0;
  let routedTool = "";
  const factory: VoiceCodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}),
      close: () => { closed++; },
      request: async (method, params: any) => {
        requests.push({ method, params });
        if (method === "account/login/start") return {};
        if (method === "thread/start") return { thread: { id: "voice-thread" } };
        if (method === "thread/realtime/listVoices") return { voices: { v1: ["cove"] } };
        if (method === "thread/realtime/start") {
          setTimeout(() => {
            handlers.onNotification?.("thread/realtime/started", { threadId: "voice-thread", version: "v3" });
            handlers.onNotification?.("thread/realtime/sdp", { threadId: "voice-thread", sdp: "v=0\r\nanswer" });
          }, 0);
          return {};
        }
        return {};
      },
    };
  };
  let opened = "";
  active = new ChatGptVoiceSession({
    model: "gpt-5.6-terra",
    transport: "browser",
    tools: [
      { function: { name: "read_file", description: "Read", parameters: { type: "object" } } },
      { function: { name: "write_file", description: "Write", parameters: { type: "object" } } },
      { function: { name: "audio_tool", description: "Audio", parameters: { type: "object" } } },
      { function: { name: "mcp__neko_browser__status", description: "Browser status", parameters: { type: "object" } } },
    ],
    history: [
      { role: "system", content: "private system context" },
      { role: "user", content: "Chúng ta đang sửa voice." },
      { role: "assistant", content: "Mình đã hiểu." },
      { role: "tool", content: "large tool output must not seed realtime" },
    ],
    executeTool: async (call) => {
      routedTool = call.name;
      if (call.name === "write_file") return "Denied by user: write_file (write blocked.txt)";
      if (call.name === "mcp__neko_browser__status") return "browser:ready";
      if (call.name === "audio_tool") return [{ type: "audio", data: "QUJD", mimeType: "audio/wav" }];
      readToolCalls++;
      return `read:${call.arguments.path}`;
    },
    onEvent: (event) => events.push(event),
    clientFactory: factory,
    openUrl: (url) => { opened = url; },
  });

  const { url } = await active.start();
  expect(url).toBe(opened);
  expect(requests.find((request) => request.method === "account/login/start")?.params).toMatchObject({
    type: "chatgptAuthTokens", chatgptAccountId: "acct-voice",
  });
  expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
    model: "gpt-5.6-terra", sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
  });
  expect(requests.find((request) => request.method === "thread/start")?.params.dynamicTools[0].name).toBe("read_file");
  const browserTool = requests.find((request) => request.method === "thread/start")?.params.dynamicTools
    .find((tool: any) => tool.description === "Browser status");
  expect(String(browserTool.name).startsWith("mcp__")).toBe(false);

  if (!url) throw new Error("browser voice did not return a URL");
  const parsed = new URL(url);
  const token = parsed.hash.slice(1);
  const origin = parsed.origin;
  const page = await fetch(origin);
  const html = await page.text();
  expect(html).toContain("Start voice");
  expect(html).toContain("microphone stays off");
  expect(html).not.toContain(token);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1] ?? "";
  expect(script).not.toBe("");
  expect(() => new Function(script)).not.toThrow();

  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/bridge`, { headers: { origin } } as any);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.send(JSON.stringify({ type: "hello", token }));
  expect(await nextMessage(ws)).toEqual({ type: "ready" });
  ws.send(JSON.stringify({ type: "connecting" }));
  ws.send(JSON.stringify({ type: "live" }));
  ws.send(JSON.stringify({ type: "muted", muted: true }));
  await Bun.sleep(10);
  expect(active.snapshot()).toMatchObject({ state: "muted", muted: true });

  const offer = await fetch(`${origin}/offer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0\r\nvalid test offer" }),
  });
  expect(offer.status).toBe(200);
  expect(await offer.json()).toEqual({ sdp: "v=0\r\nanswer" });
  expect(requests.find((request) => request.method === "thread/realtime/start")?.params).toMatchObject({
    threadId: "voice-thread", version: "v3", outputModality: "audio", transport: { type: "webrtc", sdp: "v=0\r\nvalid test offer" },
    codexResponseHandoffMode: "bemTags",
    initialItems: [
      { role: "user", text: "Chúng ta đang sửa voice." },
      { role: "assistant", text: "Mình đã hiểu." },
    ],
  });
  expect(active.snapshot().protocol).toBe("v3");

  const toolRequest = {
    threadId: "voice-thread", callId: "voice-call", tool: "read_file", arguments: { path: "README.md" },
  };
  const [tool, duplicate] = await Promise.all([
    handlers.onRequest?.("item/tool/call", toolRequest),
    handlers.onRequest?.("item/tool/call", toolRequest),
  ]);
  expect(readToolCalls).toBe(1);
  expect(tool).toEqual({ contentItems: [{ type: "inputText", text: "read:README.md" }], success: true });
  expect(duplicate).toEqual(tool);
  expect(await handlers.onRequest?.("item/tool/call", {
    threadId: "voice-thread", callId: "voice-denied", tool: "write_file", arguments: { path: "blocked.txt" },
  })).toEqual({ contentItems: [{ type: "inputText", text: "Denied by user: write_file (write blocked.txt)" }], success: false });
  expect(await handlers.onRequest?.("item/tool/call", {
    threadId: "voice-thread", callId: "voice-audio", tool: "audio_tool", arguments: {},
  })).toEqual({ contentItems: [{ type: "inputAudio", audioUrl: "data:audio/wav;base64,QUJD" }], success: true });
  expect(await handlers.onRequest?.("item/tool/call", {
    threadId: "voice-thread", callId: "voice-mcp", tool: browserTool.name, arguments: {},
  })).toEqual({ contentItems: [{ type: "inputText", text: "browser:ready" }], success: true });
  expect(routedTool).toBe("mcp__neko_browser__status");
  handlers.onNotification?.("thread/realtime/transcript/delta", { threadId: "voice-thread", role: "user", delta: "xin " });
  handlers.onNotification?.("thread/realtime/transcript/done", { threadId: "voice-thread", role: "user", text: "xin chao" });
  expect(events).toContainEqual({ type: "transcript-delta", role: "user", delta: "xin " });
  expect(events).toContainEqual({ type: "transcript-done", role: "user", text: "xin chao" });

  await active.stop();
  active = null;
  expect(requests.some((request) => request.method === "thread/realtime/stop")).toBe(true);
  expect(requests.some((request) => request.method === "thread/unsubscribe")).toBe(true);
  expect(closed).toBe(1);
  ws.close();
});

test("terminal-native voice streams PCM over App Server and keeps Neko tool routing", async () => {
  setupAuth();
  const requests: Array<{ method: string; params: any }> = [];
  let handlers!: CodexAppServerHandlers;
  let audioOptions!: NativeVoiceAudioOptions;
  const played: RealtimePcmChunk[] = [];
  let interrupted = 0;
  let muted = false;
  let stopped = 0;
  const factory: VoiceCodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}),
      close: () => {},
      request: async (method, params: any) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "voice-thread" } };
        if (method === "thread/realtime/start") {
          queueMicrotask(() => handlers.onNotification?.("thread/realtime/started", {
            threadId: "voice-thread", version: "v3",
          }));
        }
        return {};
      },
    };
  };
  let toolName = "";
  active = new ChatGptVoiceSession({
    model: "gpt-5.5",
    transport: "native",
    tools: [{ function: { name: "web_search", description: "Search", parameters: { type: "object" } } }],
    executeTool: async (call) => {
      toolName = call.name;
      return "fresh result";
    },
    clientFactory: factory,
    audioFactory: (options) => {
      audioOptions = options;
      return {
        start: async () => {},
        play: (chunk) => played.push(chunk),
        interruptOutput: () => { interrupted++; },
        setMuted: (value) => { muted = value; },
        stop: async () => { stopped++; },
      };
    },
  });

  expect(await active.start()).toEqual({ transport: "native" });
  expect(active.snapshot()).toMatchObject({ state: "live", protocol: "v3", transport: "native" });
  const start = requests.find((request) => request.method === "thread/realtime/start");
  expect(start?.params.transport).toBeUndefined();
  expect(start?.params.outputModality).toBe("audio");
  expect(start?.params.codexResponseHandoffMode).toBe("bemTags");

  const input = { data: "AQIDBA==", sampleRate: 24_000, numChannels: 1, samplesPerChannel: 2 };
  await audioOptions.onInput(input);
  expect(requests.find((request) => request.method === "thread/realtime/appendAudio")?.params).toEqual({
    threadId: "voice-thread", audio: input,
  });

  handlers.onNotification?.("thread/realtime/outputAudio/delta", {
    threadId: "voice-thread", audio: input,
  });
  expect(played).toEqual([input]);
  handlers.onNotification?.("thread/realtime/transcript/delta", {
    threadId: "voice-thread", role: "user", delta: "dung lai",
  });
  expect(interrupted).toBe(1);

  active.setMuted(true);
  expect(muted).toBe(true);
  expect(active.snapshot().state).toBe("muted");

  expect(await handlers.onRequest?.("item/tool/call", {
    threadId: "voice-thread", callId: "search-1", tool: "web_search", arguments: { query: "Neko" },
  })).toEqual({ contentItems: [{ type: "inputText", text: "fresh result" }], success: true });
  expect(toolName).toBe("web_search");

  await active.stop();
  active = null;
  expect(stopped).toBe(1);
});

test("subscription voice rejects a realtime downgrade instead of claiming V3", async () => {
  setupAuth();
  let handlers!: CodexAppServerHandlers;
  const factory: VoiceCodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "voice-thread" } };
        if (method === "thread/realtime/start") {
          setTimeout(() => {
            handlers.onNotification?.("thread/realtime/started", { threadId: "voice-thread", version: "v2" });
            handlers.onNotification?.("thread/realtime/sdp", { threadId: "voice-thread", sdp: "v=0\r\nanswer" });
          }, 0);
        }
        return {};
      },
    };
  };
  active = new ChatGptVoiceSession({ model: "gpt-5.5", clientFactory: factory, openUrl: () => {} });
  const { url } = await active.start();
  if (!url) throw new Error("browser voice did not return a URL");
  const parsed = new URL(url);
  const response = await fetch(`${parsed.origin}/offer`, {
    method: "POST",
    headers: { authorization: `Bearer ${parsed.hash.slice(1)}`, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0\r\nvalid test offer" }),
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("expected realtime V3 but Codex started v2");
});

test("voice bridge rejects an SDP offer without its one-session capability", async () => {
  setupAuth();
  const factory: VoiceCodexClientFactory = () => ({
    initialize: async () => ({}), close: () => {},
    request: async (method) => method === "thread/start" ? { thread: { id: "voice-thread" } } : {},
  });
  active = new ChatGptVoiceSession({ model: "gpt-5.5", clientFactory: factory, openUrl: () => {} });
  const { url } = await active.start();
  if (!url) throw new Error("browser voice did not return a URL");
  const response = await fetch(`${new URL(url).origin}/offer`, { method: "POST", body: "{}" });
  expect(response.status).toBe(401);
});

test("a backend rollout error survives realtime teardown and reaches the consent page", async () => {
  setupAuth();
  let handlers!: CodexAppServerHandlers;
  const factory: VoiceCodexClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({}), close: () => {},
      request: async (method) => {
        if (method === "thread/start") return { thread: { id: "voice-thread" } };
        if (method === "thread/realtime/start") {
          setTimeout(() => handlers.onNotification?.("thread/realtime/error", {
            threadId: "voice-thread",
            message: "unexpected status 404 Not Found at /backend-api/codex/realtime/calls",
          }), 0);
        }
        return {};
      },
    };
  };
  active = new ChatGptVoiceSession({ model: "gpt-5.5", clientFactory: factory, openUrl: () => {} });
  const { url } = await active.start();
  if (!url) throw new Error("browser voice did not return a URL");
  const parsed = new URL(url);
  const response = await fetch(`${parsed.origin}/offer`, {
    method: "POST",
    headers: { authorization: `Bearer ${parsed.hash.slice(1)}`, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0\r\na=valid-test-offer" }),
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("experimental ChatGPT subscription voice endpoint is not enabled");
});

test("subscription voice survives a control-socket drop mid-call and accepts a reconnect", async () => {
  setupAuth();
  const factory: VoiceCodexClientFactory = () => ({
    initialize: async () => ({}), close: () => {},
    request: async (method) => method === "thread/start" ? { thread: { id: "voice-thread" } } : {},
  });
  active = new ChatGptVoiceSession({ model: "gpt-5.5", transport: "browser", clientFactory: factory, openUrl: () => {} });
  const { url } = await active.start();
  if (!url) throw new Error("browser voice did not return a URL");
  const parsed = new URL(url);
  const token = parsed.hash.slice(1);
  const origin = parsed.origin;
  const open = async () => {
    const ws = new WebSocket(`${origin.replace("http:", "ws:")}/bridge`, { headers: { origin } } as any);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return ws;
  };

  const first = await open();
  first.send(JSON.stringify({ type: "hello", token }));
  expect(await nextMessage(first)).toEqual({ type: "ready" });
  first.send(JSON.stringify({ type: "live" }));
  await Bun.sleep(10);
  expect(active.snapshot().state).toBe("live");

  // The WebRTC audio flows browser<->OpenAI directly; a dropped control socket must not kill
  // the healthy call (this used to stop the session immediately with "browser closed").
  first.close();
  await Bun.sleep(20);
  expect(active.snapshot().state).toBe("live");

  const second = await open();
  second.send(JSON.stringify({ type: "hello", token }));
  expect(await nextMessage(second)).toEqual({ type: "ready" });
  second.send(JSON.stringify({ type: "live" }));
  second.send(JSON.stringify({ type: "muted", muted: true }));
  await Bun.sleep(10);
  expect(active.snapshot()).toMatchObject({ state: "muted", muted: true });

  // An explicit page Stop still ends the session at once - consent is unchanged.
  second.send(JSON.stringify({ type: "stop" }));
  await Bun.sleep(20);
  expect(active.snapshot().state).toBe("stopped");
  second.close();
});

test("voice errors distinguish account rollout, limits, and microphone consent", () => {
  expect(friendlyVoiceError(new Error("HTTP 403 entitlement"))).toContain("not currently eligible");
  expect(friendlyVoiceError(new Error("429 quota reached"))).toContain("did not switch to paid API billing");
  expect(friendlyVoiceError(new Error("NotAllowedError: microphone permission denied"))).toContain("Microphone access was denied");
  expect(friendlyVoiceError(new Error("404 /backend-api/codex/realtime/calls"))).toContain("did not switch to paid API billing");
});

test("voice errors route dead-end failures to the quota-free fallback", () => {
  // Codex 0.145/0.146 realtime_api_key gate: WebSocket realtime is API-key-only, so the raw
  // message must never read as advice to configure API billing.
  const gate = friendlyVoiceError(new Error("Codex App Server: realtime conversation requires API key auth"));
  expect(gate).toContain("only works over WebRTC");
  expect(gate).toContain("did not switch to paid API billing");
  expect(gate).not.toContain("requires API key auth");
  const limit = friendlyVoiceError(new Error("usage limit reached for realtime"));
  expect(limit).toContain("did not switch to paid API billing");
  expect(limit).toContain("Neko Conversational Voice");
});
