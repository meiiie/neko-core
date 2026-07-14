/** Code Assist Standard/Enterprise transport through official Gemini CLI ACP. */
import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import type { NekoConfig } from "./config.ts";
import {
  discoverGeminiCli,
  geminiUsageFromPrompt,
  startGeminiAcp,
  type GeminiAcpClient,
  type GeminiAcpHandlers,
  type GeminiUsageSnapshot,
} from "./gemini-cli.ts";

interface AcpClient {
  initialize(timeoutMs?: number): Promise<any>;
  authenticate(apiKey?: string, timeoutMs?: number): Promise<any>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export type GeminiClientFactory = (handlers: GeminiAcpHandlers) => AcpClient;

function defaultClientFactory(handlers: GeminiAcpHandlers): GeminiAcpClient {
  const status = discoverGeminiCli();
  if (status.state !== "ready" || !status.executable) throw new Error(status.detail);
  return startGeminiAcp(status.executable, handlers);
}

let lastUsage: GeminiUsageSnapshot | undefined;

export function getLastGeminiUsage(): GeminiUsageSnapshot | undefined {
  return lastUsage ? { ...lastUsage, models: lastUsage.models.map((model) => ({ ...model })) } : undefined;
}

class NekoMcpProxy {
  private server: HttpServer | null = null;
  private readonly token = randomBytes(24).toString("base64url");
  private executeTool: CompleteOptions["executeTool"];
  private tools: any[] = [];
  url = "";

  async start(tools: any[], executeTool: CompleteOptions["executeTool"]): Promise<void> {
    this.tools = tools;
    this.executeTool = executeTool;
    this.server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(401).end();
        return;
      }
      const mcp = new Server({ name: "neko", version: "1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.map(toMcpTool) }));
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const spec = this.tools.find((tool) => String(tool?.function?.name ?? "") === params.name);
        if (!spec) return { isError: true, content: [{ type: "text", text: `Unknown Neko tool: ${params.name}` }] };
        if (!this.executeTool) return { isError: true, content: [{ type: "text", text: "No active Neko tool executor" }] };
        const call: ToolCall = {
          id: randomBytes(12).toString("hex"),
          name: params.name,
          arguments: isObject(params.arguments) ? params.arguments : {},
        };
        return toMcpResult(await this.executeTool(call));
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      } finally {
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Neko Gemini MCP proxy did not bind a TCP port");
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }

  setExecutor(executeTool: CompleteOptions["executeTool"]): void {
    this.executeTool = executeTool;
  }

  descriptor(): any {
    return { name: "neko", type: "http", url: this.url, headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] };
  }

  close(): void {
    this.executeTool = undefined;
    this.server?.close();
    this.server = null;
    this.url = "";
  }
}

export class GeminiCliProvider implements Provider {
  private client: AcpClient | null = null;
  private clientReady: Promise<AcpClient> | null = null;
  private sessionId: string | null = null;
  private sessionSignature = "";
  private sessionModel = "";
  private proxy: NekoMcpProxy | null = null;
  private active = false;
  private answer = "";
  private onDelta?: DeltaHook;

  constructor(private readonly cfg: NekoConfig, private readonly clientFactory: GeminiClientFactory = defaultClientFactory) {}

  async complete(messages: any[], tools: any[] = [], onDelta?: DeltaHook, signal?: AbortSignal, opts: CompleteOptions = {}): Promise<ProviderResponse> {
    if (this.active) throw new Error("Gemini CLI already has an active turn");
    if (tools.length && !opts.executeTool) throw new Error("Gemini CLI tools need Neko's safe execution callback");
    this.active = true;
    this.answer = "";
    this.onDelta = onDelta;
    let abort: (() => void) | undefined;
    try {
      const { client, fresh } = await this.ensureSession(messages, tools, opts.executeTool);
      const sessionId = this.sessionId!;
      const prompt = toAcpPrompt(messages, fresh, opts.responseSchema);
      abort = () => client.notify("session/cancel", { sessionId });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const result = await client.request("session/prompt", { sessionId, prompt }, Math.max(60_000, this.cfg.timeoutSeconds * 1000));
      if (signal?.aborted || result?.stopReason === "cancelled") throw new DOMException("Aborted by user", "AbortError");
      if (result?.stopReason && result.stopReason !== "end_turn") {
        this.onDelta?.(`(Gemini stopped: ${result.stopReason})`, "reasoning");
      }
      const usage = geminiUsageFromPrompt(result);
      if (usage) lastUsage = usage;
      return { content: this.answer, tool_calls: [], usage: toNekoUsage(usage) };
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      this.proxy?.setExecutor(undefined);
      this.active = false;
      this.onDelta = undefined;
    }
  }

  dispose(): void {
    this.active = false;
    this.answer = "";
    this.onDelta = undefined;
    this.resetConnection();
  }

  private resetConnection(): void {
    this.sessionId = null;
    this.sessionSignature = "";
    this.sessionModel = "";
    this.clientReady = null;
    this.client?.close();
    this.client = null;
    this.proxy?.close();
    this.proxy = null;
  }

  private async ensureSession(messages: any[], tools: any[], executeTool: CompleteOptions["executeTool"]): Promise<{ client: AcpClient; fresh: boolean }> {
    const signature = JSON.stringify({
      system: messages.filter((message) => message?.role === "system").map((message) => textContent(message.content)),
      tools: tools.map((tool) => tool?.function ?? tool),
    });
    if (this.sessionId && signature !== this.sessionSignature) this.resetConnection();
    const client = await this.ensureClient();
    let fresh = false;
    if (!this.sessionId) {
      if (tools.length) {
        this.proxy = new NekoMcpProxy();
        await this.proxy.start(tools, executeTool);
      }
      const session = await client.request("session/new", {
        cwd: process.cwd(),
        mcpServers: this.proxy ? [this.proxy.descriptor()] : [],
      }, 60_000);
      const id = String(session?.sessionId ?? "");
      if (!id) throw new Error("Gemini CLI did not return a session id");
      const modes = Array.isArray(session?.modes?.availableModes) ? session.modes.availableModes : [];
      if (!modes.some((mode: any) => mode?.id === "yolo")) throw new Error("Gemini CLI ACP cannot enforce Neko's isolated MCP tool mode");
      await client.request("session/set_mode", { sessionId: id, modeId: "yolo" });
      this.sessionId = id;
      this.sessionSignature = signature;
      this.sessionModel = String(session?.models?.currentModelId ?? "");
      fresh = true;
    }
    this.proxy?.setExecutor(executeTool);
    const requestedModel = this.cfg.model || "auto";
    if (requestedModel !== this.sessionModel) {
      await client.request("session/set_model", { sessionId: this.sessionId, modelId: requestedModel });
      this.sessionModel = requestedModel;
    }
    return { client, fresh };
  }

  private ensureClient(): Promise<AcpClient> {
    if (this.clientReady) return this.clientReady;
    const ready = (async () => {
      let client: AcpClient | null = null;
      try {
        client = this.clientFactory({
          onNotification: (method, params) => this.onNotification(method, params),
          // Permission prompts should never occur: built-ins are system-disabled and the isolated
          // Neko MCP session is set to yolo. Fail closed if an old/incompatible CLI violates that.
          onRequest: async (method) => {
            if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
            throw new Error(`Unsupported Gemini CLI request: ${method}`);
          },
        });
        this.client = client;
        await client.initialize();
        await client.authenticate(this.cfg.usesGeminiAuth ? undefined : this.cfg.apiKey || undefined);
        return client;
      } catch (error) {
        client?.close();
        this.client = null;
        throw error;
      }
    })();
    this.clientReady = ready;
    void ready.catch(() => { if (this.clientReady === ready) this.clientReady = null; });
    return ready;
  }

  private onNotification(method: string, params: any): void {
    if (method !== "session/update" || (this.sessionId && params?.sessionId !== this.sessionId)) return;
    const update = params?.update;
    const text = update?.content?.type === "text" ? String(update.content.text ?? "") : "";
    if (update?.sessionUpdate === "agent_message_chunk" && text) {
      this.answer += text;
      this.onDelta?.(text, "content");
    } else if (update?.sessionUpdate === "agent_thought_chunk" && text) {
      this.onDelta?.(text, "reasoning");
    } else if (update?.sessionUpdate === "usage_update") {
      const usage = update?.usage;
      if (usage) lastUsage = {
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        models: [],
      };
    }
  }
}

function toMcpTool(tool: any): any {
  return {
    name: String(tool?.function?.name ?? ""),
    description: String(tool?.function?.description ?? ""),
    inputSchema: tool?.function?.parameters ?? { type: "object", properties: {} },
  };
}

function toMcpResult(observation: string | any[]): any {
  if (typeof observation === "string") {
    const failed = /^Error running\b/.test(observation) || /^\[denied\]/.test(observation);
    return { isError: failed, content: [{ type: "text", text: observation || "(no output)" }] };
  }
  const content: any[] = [];
  for (const part of observation) {
    if (part?.type === "text") content.push({ type: "text", text: String(part.text ?? "") });
    else if (part?.type === "image_url" && part.image_url?.url) {
      const image = parseDataUrl(String(part.image_url.url));
      if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
  }
  return { content: content.length ? content : [{ type: "text", text: "(no output)" }] };
}

function toAcpPrompt(messages: any[], fresh: boolean, responseSchema?: Record<string, any>): any[] {
  const last = messages.at(-1);
  const blocks: any[] = [];
  let text = textContent(last?.content);
  if (fresh) {
    const system = messages.filter((message) => message?.role === "system").map((message) => textContent(message.content)).filter(Boolean).join("\n\n");
    const history = messages.slice(0, -1).filter((message) => message?.role !== "system").map((message) => {
      const role = message?.role === "assistant" ? "ASSISTANT" : message?.role === "tool" ? "TOOL" : "USER";
      return `${role}: ${textContent(message?.content)}`;
    }).filter((line) => !line.endsWith(": ")).join("\n\n");
    text = [
      "You are running inside Neko Core. Follow the host instructions and use only the Neko MCP tools exposed in this session.",
      system ? `<NEKO_HOST_INSTRUCTIONS>\n${system}\n</NEKO_HOST_INSTRUCTIONS>` : "",
      history ? `<PREVIOUS_CONVERSATION>\n${history}\n</PREVIOUS_CONVERSATION>` : "",
      `<CURRENT_USER_MESSAGE>\n${text}\n</CURRENT_USER_MESSAGE>`,
    ].filter(Boolean).join("\n\n");
  }
  if (responseSchema) text += `\n\nReturn JSON that matches this schema exactly:\n${JSON.stringify(responseSchema)}`;
  blocks.push({ type: "text", text });
  for (const part of Array.isArray(last?.content) ? last.content : []) {
    if (part?.type !== "image_url" || !part.image_url?.url) continue;
    const image = parseDataUrl(String(part.image_url.url));
    if (image) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}

function parseDataUrl(value: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function textContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n");
}

function toNekoUsage(usage?: GeminiUsageSnapshot): Usage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
