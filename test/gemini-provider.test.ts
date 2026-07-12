import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { GeminiCliProvider, type GeminiClientFactory } from "../src/adapters/gemini-provider.ts";
import type { GeminiAcpHandlers } from "../src/adapters/gemini-cli.ts";

test("Gemini provider streams through ACP and proxies tools back through Neko's executor", async () => {
  let handlers!: GeminiAcpHandlers;
  const requests: Array<{ method: string; params: any }> = [];
  const factory: GeminiClientFactory = (nextHandlers) => {
    handlers = nextHandlers;
    return {
      initialize: async () => ({ protocolVersion: 1 }),
      authenticate: async () => ({}),
      notify: () => {},
      close: () => {},
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "session/new") return {
          sessionId: "gemini-session",
          modes: { availableModes: [{ id: "default" }, { id: "yolo" }], currentModeId: "default" },
          models: { availableModels: [{ modelId: "auto", name: "Auto" }], currentModelId: "auto" },
        };
        if (method === "session/set_mode") return {};
        if (method === "session/prompt") {
          const mcp = requests.find((request) => request.method === "session/new")!.params.mcpServers[0];
          const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: mcp.headers[0].value };
          const rpc = async (body: any) => (await fetch(mcp.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...body }) })).json() as any;
          await rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gemini-test", version: "1" } } });
          const listed = await rpc({ id: 2, method: "tools/list", params: {} });
          expect(listed.result.tools.map((tool: any) => tool.name)).toContain("read_file");
          const called = await rpc({ id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "README.md" } } });
          expect(called.result.content[0].text).toBe("safe observation");
          handlers.onNotification?.("session/update", { sessionId: "gemini-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } } });
          handlers.onNotification?.("session/update", { sessionId: "gemini-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } });
          return { stopReason: "end_turn", _meta: { quota: { token_count: { input_tokens: 50, output_tokens: 10 }, model_usage: [] } } };
        }
        return {};
      },
    };
  };
  const cfg = new NekoConfig({ provider: "gemini_cli", model: "auto", timeout_seconds: 30 }, "gemini", {
    gemini: { provider: "gemini_cli", auth: "gemini_oauth", model: "auto" },
  }, "");
  const provider = new GeminiCliProvider(cfg, factory);
  const deltas: Array<{ text: string; kind?: string }> = [];
  const executed: any[] = [];
  try {
    const response = await provider.complete(
      [{ role: "system", content: "Stay safe." }, { role: "user", content: "Inspect the readme" }],
      [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
      (text, kind) => deltas.push({ text, kind }),
      undefined,
      { executeTool: async (call) => { executed.push(call); return "safe observation"; } },
    );
    expect(response.content).toBe("Done.");
    expect(response.usage).toEqual({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
    expect(executed).toMatchObject([{ name: "read_file", arguments: { path: "README.md" } }]);
    expect(deltas).toContainEqual({ text: "checking", kind: "reasoning" });
    expect(requests.find((request) => request.method === "session/set_mode")?.params.modeId).toBe("yolo");
  } finally {
    provider.dispose();
  }
}, 15000);

test("Gemini provider fails closed if ACP cannot isolate tools behind Neko", async () => {
  const factory: GeminiClientFactory = () => ({
    initialize: async () => ({}), authenticate: async () => ({}), notify: () => {}, close: () => {},
    request: async (method) => method === "session/new"
      ? { sessionId: "unsafe", modes: { availableModes: [{ id: "default" }] }, models: { currentModelId: "auto" } }
      : {},
  });
  const cfg = new NekoConfig({ provider: "gemini_cli", model: "auto" }, "gemini", { gemini: { auth: "gemini_oauth" } }, "");
  const provider = new GeminiCliProvider(cfg, factory);
  await expect(provider.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/isolated MCP tool mode/);
  provider.dispose();
});
