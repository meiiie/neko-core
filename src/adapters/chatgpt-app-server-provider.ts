/** GPT-5.6 ChatGPT subscription transport through the official local Codex App Server. */
import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import type { NekoConfig } from "./config.ts";
import { validChatGptCredentials } from "./chatgpt-auth.ts";
import { toResponsesInput } from "./chatgpt-provider.ts";
import {
  discoverCodexSupport,
  encodeCodexDynamicTools,
  startCodexAppServer,
  type CodexAppServerHandlers,
} from "./codex-app-server.ts";

interface RpcClient {
  initialize(timeoutMs?: number): Promise<unknown>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  close(): void;
}

export type CodexClientFactory = (handlers: CodexAppServerHandlers) => RpcClient;

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  answer: string;
  usage?: Usage;
  onDelta?: DeltaHook;
  executeTool?: CompleteOptions["executeTool"];
  toolResults: Map<string, Promise<{ contentItems: any[]; success: boolean }>>;
  resolve: () => void;
  reject: (error: Error) => void;
  done: Promise<void>;
}

function defaultClientFactory(handlers: CodexAppServerHandlers): RpcClient {
  const status = discoverCodexSupport();
  if (status.state !== "ready" || !status.executable) {
    throw new Error(
      `GPT-5.6 needs the optional Codex support component (${status.detail}). ` +
      "Install Codex CLI >= 0.144.0 or the Neko GPT-5.6 Support Pack; GPT-5.5 and other providers still work without it.",
    );
  }
  return startCodexAppServer(status.executable, handlers);
}

export class ChatGptAppServerProvider implements Provider {
  private client: RpcClient | null = null;
  private clientReady: Promise<RpcClient> | null = null;
  private threadId: string | null = null;
  private threadSignature = "";
  private active: ActiveTurn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private dynamicToolNames = new Map<string, string>();

  constructor(private readonly cfg: NekoConfig, private readonly clientFactory: CodexClientFactory = defaultClientFactory) {}

  async complete(
    messages: any[],
    tools: any[] = [],
    onDelta?: DeltaHook,
    signal?: AbortSignal,
    opts: CompleteOptions = {},
  ): Promise<ProviderResponse> {
    if (this.active) throw new Error("Codex App Server already has an active turn");
    if (!this.cfg.model.startsWith("gpt-5.6-")) throw new Error(`Codex App Server route is not required for ${this.cfg.model}`);
    if (tools.length && !opts.executeTool) throw new Error("Codex App Server tools need Neko's safe execution callback");

    const client = await this.ensureClient();
    const developerInstructions = messages
      .filter((message) => message?.role === "system")
      .map((message) => textContent(message.content))
      .filter(Boolean)
      .join("\n\n");
    const encodedTools = encodeCodexDynamicTools(tools);
    this.dynamicToolNames = encodedTools.originalNames;
    const signature = JSON.stringify({ developerInstructions, dynamicTools: encodedTools.tools });
    if (!this.threadId || signature !== this.threadSignature) {
      if (this.threadId) void client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
      const started = await client.request("thread/start", {
        model: this.cfg.model,
        allowProviderModelFallback: false,
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions,
        dynamicTools: encodedTools.tools,
      }, 60_000);
      const id = String(started?.thread?.id ?? "");
      if (!id) throw new Error("Codex App Server did not return a thread id");
      this.threadId = id;
      this.threadSignature = signature;

      // Preserve a conversation that began on GPT-5.5 or another provider. The app-server thread is
      // new, so inject only the prior structured items; the final user message starts the live turn.
      const previous = toResponsesInput(messages.slice(0, -1)).input;
      if (previous.length) await client.request("thread/inject_items", { threadId: id, items: previous });
    }

    const threadId = this.threadId;
    const active = makeActiveTurn(threadId, onDelta, opts.executeTool);
    this.active = active;
    let abort: (() => void) | undefined;
    try {
      const input = toUserInput(messages.at(-1)?.content);
      const params: Record<string, any> = { threadId, input, model: this.cfg.model };
      if (this.cfg.effort && this.cfg.effort !== "off") params.effort = this.cfg.effort;
      params.summary = "auto";
      if (opts.responseSchema) params.outputSchema = opts.responseSchema;
      const started = await client.request("turn/start", params, 60_000);
      active.turnId = String(started?.turn?.id ?? "") || undefined;
      abort = () => {
        if (!active.turnId) return;
        void client.request("turn/interrupt", { threadId, turnId: active.turnId }, 5000).catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      await active.done;
      return { content: active.answer, tool_calls: [], usage: active.usage };
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      if (this.active === active) this.active = null;
      this.armIdleStop();
    }
  }

  dispose(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.clientReady = null;
    this.threadId = null;
    this.threadSignature = "";
    this.active?.reject(new Error("Codex App Server stopped"));
    this.active = null;
    this.client?.close();
    this.client = null;
  }

  private armIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfg.codexKeepalive <= 0 || !this.client) { this.idleTimer = null; return; }
    this.idleTimer = setTimeout(() => this.dispose(), this.cfg.codexKeepalive * 60_000);
    (this.idleTimer as any).unref?.();
  }

  private ensureClient(): Promise<RpcClient> {
    if (this.clientReady) return this.clientReady;
    const ready = (async () => {
      let client: RpcClient | null = null;
      try {
        client = this.clientFactory({
          onNotification: (method, params) => this.onNotification(method, params as any),
          onRequest: (method, params) => this.onRequest(method, params as any),
        });
        this.client = client;
        await client.initialize();
        const credentials = await validChatGptCredentials();
        if (!credentials.accountId) throw new Error("ChatGPT credentials do not include an account id; run /login again");
        await client.request("account/login/start", {
          type: "chatgptAuthTokens",
          accessToken: credentials.accessToken,
          chatgptAccountId: credentials.accountId,
          chatgptPlanType: null,
        });
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

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === "account/chatgptAuthTokens/refresh") {
      const credentials = await validChatGptCredentials(fetch, undefined, true);
      if (!credentials.accountId) throw new Error("refreshed ChatGPT credentials do not include an account id");
      return { accessToken: credentials.accessToken, chatgptAccountId: credentials.accountId, chatgptPlanType: null };
    }
    if (method !== "item/tool/call") throw new Error(`Unsupported Codex server request: ${method}`);
    const active = this.active;
    if (!active?.executeTool) throw new Error("No active Neko tool executor");
    if (params?.threadId !== active.threadId) throw new Error("Tool request belongs to a different Codex thread");
    const wireName = String(params?.tool ?? "");
    const call: ToolCall = {
      id: String(params?.callId ?? ""),
      name: this.dynamicToolNames.get(wireName) ?? "",
      arguments: isObject(params?.arguments) ? params.arguments : {},
    };
    if (!call.id || !call.name) throw new Error("Codex returned an invalid dynamic tool call");
    let result = active.toolResults.get(call.id);
    if (!result) {
      result = active.executeTool(call).then(toolResultContent);
      active.toolResults.set(call.id, result);
    }
    return result;
  }

  private onNotification(method: string, params: any): void {
    const active = this.active;
    if (!active || (params?.threadId && params.threadId !== active.threadId)) return;
    if (method === "item/agentMessage/delta") {
      const delta = String(params?.delta ?? "");
      active.answer += delta;
      active.onDelta?.(delta, "content");
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      active.onDelta?.(String(params?.delta ?? ""), "reasoning");
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const last = params?.tokenUsage?.last;
      if (last) active.usage = {
        prompt_tokens: Number(last.inputTokens ?? 0),
        completion_tokens: Number(last.outputTokens ?? 0),
        total_tokens: Number(last.totalTokens ?? 0),
        cached_tokens: Number(last.cachedInputTokens ?? 0),
      };
      return;
    }
    if (method === "error" && params?.willRetry !== true) {
      active.reject(new Error(String(params?.error?.message ?? "Codex App Server turn failed")));
      return;
    }
    if (method === "turn/completed") {
      const turn = params?.turn;
      if (active.turnId && turn?.id && active.turnId !== turn.id) return;
      if (turn?.status === "completed") active.resolve();
      else active.reject(new Error(String(turn?.error?.message ?? `Codex turn ${turn?.status ?? "failed"}`)));
    }
  }
}

function makeActiveTurn(threadId: string, onDelta?: DeltaHook, executeTool?: CompleteOptions["executeTool"]): ActiveTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { threadId, answer: "", onDelta, executeTool, toolResults: new Map(), resolve, reject, done };
}

function toUserInput(content: any): any[] {
  if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? ""), text_elements: [] }];
  const input: any[] = [];
  for (const part of content) {
    if (part?.type === "text" && part.text) input.push({ type: "text", text: String(part.text), text_elements: [] });
    else if (part?.type === "image_url" && part.image_url?.url) input.push({ type: "image", url: String(part.image_url.url) });
  }
  return input.length ? input : [{ type: "text", text: "", text_elements: [] }];
}

function toolResultContent(observation: string | any[]): { contentItems: any[]; success: boolean } {
  const failed = typeof observation === "string" && (/^Error running\b/.test(observation) || /^\[denied\]/.test(observation));
  if (typeof observation === "string") return { contentItems: [{ type: "inputText", text: observation || "(no output)" }], success: !failed };
  const contentItems: any[] = [];
  for (const part of observation) {
    if (part?.type === "text") contentItems.push({ type: "inputText", text: String(part.text ?? "") });
    else if (part?.type === "image_url" && part.image_url?.url) contentItems.push({ type: "inputImage", imageUrl: String(part.image_url.url) });
  }
  return { contentItems: contentItems.length ? contentItems : [{ type: "inputText", text: "(no output)" }], success: true };
}

function textContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n");
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Route ordinary ChatGPT models directly and only use the optional sidecar for GPT-5.6. */
export class HybridChatGptProvider implements Provider {
  private bridge: ChatGptAppServerProvider | null = null;

  constructor(private readonly cfg: NekoConfig, private readonly direct: Provider) {}

  complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.cfg.model.startsWith("gpt-5.6-")) {
      // A live /model switch back to GPT-5.5 should release the optional process immediately.
      this.bridge?.dispose();
      this.bridge = null;
      return this.direct.complete(messages, tools, onDelta, signal, opts);
    }
    this.bridge ??= new ChatGptAppServerProvider(this.cfg);
    return this.bridge.complete(messages, tools, onDelta, signal, opts);
  }

  dispose(): void {
    this.direct.dispose?.();
    this.bridge?.dispose();
    this.bridge = null;
  }
}
