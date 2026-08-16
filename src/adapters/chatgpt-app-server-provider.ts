/** GPT-5.6 ChatGPT subscription transport through the official local Codex App Server. */
import { writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import type { NekoConfig } from "./config.ts";
import { requestEffort } from "./effort.ts";
import { isText, type JsonValue } from "../shared/wire.ts";
import { validChatGptCredentials } from "./chatgpt-auth.ts";
import { toResponsesInput } from "./chatgpt-provider.ts";
import {
  discoverCodexSupport,
  codexIsolationHome,
  encodeCodexDynamicTools,
  startCodexAppServer,
  type CodexAppServerHandlers,
} from "./codex-app-server.ts";

interface RpcClient {
  initialize(timeoutMs?: number): Promise<JsonValue>;
  /** Outgoing params are call-site payloads; they must be JSON-serializable. */
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  close(): void;
  closeAndWait?(reason?: Error, timeoutMs?: number): Promise<void>;
}

export type CodexClientFactory = (handlers: CodexAppServerHandlers) => RpcClient;

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  answer: string;
  /** Sum of every internal model call's usage this turn (the app-server runs its own tool loop, so
   * one complete() can be many model calls - reporting only the last one undercounted every turn). */
  usageSum: { prompt: number; completion: number; total: number; cached: number };
  /** The latest per-call usage - its prompt size is the live context (for ctx%). */
  lastCall?: { prompt: number; completion: number; total: number; cached: number };
  /** The thread-cumulative usage as last reported (preferred over usageSum when present: duplicate
   * or coalesced notifications cannot double- or under-count a running total). */
  cumulative?: { prompt: number; completion: number; total: number; cached: number };
  modelCalls: number;
  onDelta?: DeltaHook;
  onUsage?: CompleteOptions["onUsage"];
  executeTool?: CompleteOptions["executeTool"];
  toolResults: Map<string, Promise<{ contentItems: any[]; success: boolean }>>;
  activeTools: number;
  heartbeat?: () => void;
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
  /** Thread-cumulative usage at the end of the previous turn - this turn's usage is the delta. */
  private cumulativeBase = { prompt: 0, completion: 0, total: 0, cached: 0 };

  constructor(
    private readonly cfg: NekoConfig,
    private readonly clientFactory: CodexClientFactory = defaultClientFactory,
    private readonly interruptGraceMs = 5_000,
  ) {}

  async complete(
    messages: any[],
    tools: any[] = [],
    onDelta?: DeltaHook,
    signal?: AbortSignal,
    opts: CompleteOptions = {},
  ): Promise<ProviderResponse> {
    if (this.active) throw new Error("Codex App Server already has an active turn");
    if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
    if (!this.cfg.model.startsWith("gpt-5.6-")) throw new Error(`Codex App Server route is not required for ${this.cfg.model}`);
    if (tools.length && !opts.executeTool) throw new Error("Codex App Server tools need Neko's safe execution callback");
    // Disarm the idle stop the moment a turn begins. It is armed at the END of a turn, so a LONG
    // next turn (a deep-research run streaming past codex_keepalive minutes) used to have the timer
    // fire mid-flight: dispose() rejected the live turn with "Codex App Server stopped" - the field
    // failure. Idle means idle: the countdown runs only between turns.
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

    let startupCleanup: Promise<void> | null = null;
    const abortStartup = () => {
      startupCleanup ??= this.shutdown(new DOMException("Aborted by user", "AbortError"));
      void startupCleanup.catch(() => {});
    };
    signal?.addEventListener("abort", abortStartup, { once: true });
    let client: RpcClient;
    try {
      client = await this.ensureClient();
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
    } catch (error) {
      signal?.removeEventListener("abort", abortStartup);
      // SAFETY: contract of the Promise<void> | null type is established by the surrounding validation/boundary.
      const pendingStartup = startupCleanup as Promise<void> | null;
      if (pendingStartup) await pendingStartup.catch(() => {});
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      throw error;
    }
    try {
    // `thread/start.environments=[]` below removes Codex's native environment-backed tools entirely:
    // every real execution must pass Neko's approval gate, never a second path. Tell the model which
    // action surface remains so it does not waste a call looking for a native shell/apply_patch.
    const toolRouting = tools.length
      ? "\n\n# Tool routing (Codex App Server route)\n" +
        "The Codex process cwd is an isolated transport directory, not the user's project. The " +
        "authoritative Neko environment block names the real project root. " +
        "This thread has no provider-native execution environment. For any command, file write, edit, " +
        "or network work, call the provided dynamic tools (bash, write_file, edit, ...) - they execute " +
        "in Neko with the user's real permissions. Do not look for or attempt a built-in shell or " +
        "apply_patch."
      : "";
    const developerInstructions = messages
      .filter((message) => message?.role === "system")
      .map((message) => textContent(message.content))
      .filter(Boolean)
      .join("\n\n") + toolRouting;
    const encodedTools = encodeCodexDynamicTools(tools);
    this.dynamicToolNames = encodedTools.originalNames;
    const signature = JSON.stringify({ developerInstructions, dynamicTools: encodedTools.tools });
    if (!this.threadId || signature !== this.threadSignature) {
      if (this.threadId) void client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => {});
      const started = await client.request("thread/start", {
        model: this.cfg.model,
        allowProviderModelFallback: false,
        cwd: codexIsolationHome(this.cfg.resolvedHome),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        environments: [],
        developerInstructions,
        dynamicTools: encodedTools.tools,
      }, 60_000);
      const id = String(started?.thread?.id ?? "");
      if (!id) throw new Error("Codex App Server did not return a thread id");
      this.threadId = id;
      this.threadSignature = signature;
      this.cumulativeBase = { prompt: 0, completion: 0, total: 0, cached: 0 }; // fresh thread, fresh running total

      // Preserve a conversation that began on GPT-5.5 or another provider. The app-server thread is
      // new, so inject only the prior structured items; the final user message starts the live turn.
      const previous = toInjectItems(toResponsesInput(messages.slice(0, -1)).input);
      if (previous.length) await client.request("thread/inject_items", { threadId: id, items: previous });
    }
    } catch (error) {
      signal?.removeEventListener("abort", abortStartup);
      // SAFETY: contract of the Promise<void> | null type is established by the surrounding validation/boundary.
      const pendingStartup = startupCleanup as Promise<void> | null;
      if (pendingStartup) await pendingStartup.catch(() => {});
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      throw error;
    }

    const threadId = this.threadId;
    const active = makeActiveTurn(threadId, onDelta, opts.onUsage, opts.executeTool);
    this.active = active;
    signal?.removeEventListener("abort", abortStartup);
    let abort: (() => void) | undefined;
    let abortCleanup: Promise<void> | null = null;
    let forcedCleanup: Promise<void> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const stopWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };
    const forceStop = (reason: Error) => {
      forcedCleanup ??= this.shutdown(reason);
      void forcedCleanup.catch(() => {});
      return forcedCleanup;
    };
    const heartbeat = () => {
      stopWatchdog();
      // Dynamic tools own their own bounded timeout and receive the user's AbortSignal. Do not mistake
      // a quiet long-running validator for a wedged model transport; restart the idle clock when the
      // tool settles. Everything else (deltas, usage, RPC activity) is a real transport heartbeat.
      if (active.activeTools > 0 || this.active !== active) return;
      const idleMs = Math.max(0.01, this.cfg.timeoutSeconds) * 1_000;
      watchdog = setTimeout(() => {
        void forceStop(new DOMException(
          `Codex App Server produced no activity for ${this.cfg.timeoutSeconds}s`,
          "TimeoutError",
        ));
      }, idleMs);
      // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
      (watchdog as any).unref?.();
    };
    active.heartbeat = heartbeat;
    try {
      const input = toUserInput(messages.at(-1)?.content);
      const params: Record<string, any> = { threadId, input, model: this.cfg.model };
      const effort = requestEffort(this.cfg.effort, opts.reasoningEffort);
      if (effort) params.effort = effort;
      params.summary = "auto";
      if (opts.responseSchema) params.outputSchema = opts.responseSchema;
      abort = () => {
        if (abortCleanup) return;
        if (active.turnId) {
          void client.request("turn/interrupt", { threadId, turnId: active.turnId }, 5000).catch(() => {});
        }
        // Cooperative interrupt gets a short chance. If the App Server never acknowledges it, tear
        // down the sidecar and wait for transport exit so Esc/Ctrl+C cannot leave the UI busy forever.
        abortCleanup = waitForSettlement(active.done, this.interruptGraceMs).then((settled) => {
          if (!settled && this.active === active) {
            return forceStop(new DOMException("Aborted by user", "AbortError"));
          }
        });
        void abortCleanup.catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const started = await client.request("turn/start", params, 60_000);
      active.turnId = String(started?.turn?.id ?? "") || undefined;
      if (signal?.aborted && active.turnId) {
        void client.request("turn/interrupt", { threadId, turnId: active.turnId }, 5000).catch(() => {});
      }
      heartbeat();
      await active.done;
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      return { content: active.answer, tool_calls: [], usage: this.finishUsage(active) };
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      stopWatchdog();
      // SAFETY: contract of the Promise<void> | null type is established by the surrounding validation/boundary.
      const pendingAbort = abortCleanup as Promise<void> | null;
      // SAFETY: contract of the Promise<void> | null type is established by the surrounding validation/boundary.
      const pendingForced = forcedCleanup as Promise<void> | null;
      if (pendingAbort) await pendingAbort.catch(() => {});
      if (pendingForced) await pendingForced.catch(() => {});
      this.syncCumulativeBase(active); // rejected/aborted turns still belong to the thread running total
      if (this.active === active) this.active = null;
      this.armIdleStop();
    }
  }

  async dispose(): Promise<void> {
    await this.shutdown(new Error("Codex App Server stopped"));
  }

  private async shutdown(reason: Error): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.clientReady = null;
    this.threadId = null;
    this.threadSignature = "";
    this.syncCumulativeBase(this.active);
    this.active?.reject(reason);
    this.active = null;
    const client = this.client;
    this.client = null;
    if (client?.closeAndWait) await client.closeAndWait(reason);
    else client?.close();
  }

  private armIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfg.codexKeepalive <= 0 || !this.client) { this.idleTimer = null; return; }
    // Belt + suspenders to the disarm in complete(): if the timer somehow fires while a turn is
    // live, re-arm instead of killing the turn out from under the model.
    this.idleTimer = setTimeout(() => {
      if (this.active) this.armIdleStop();
      else void this.dispose().catch(() => {});
    }, this.cfg.codexKeepalive * 60_000);
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (this.idleTimer as any).unref?.();
  }

  /** The turn's usage: the delta of the thread-cumulative when available (duplicate-proof), else the
   * sum of per-call reports. Carries the LAST call's prompt as `context_tokens` (the live context for
   * ctx%) and the internal call count, so one multi-call codex turn counts like the N calls it was. */
  private usageSnapshot(active: ActiveTurn): Usage | undefined {
    if (!active.modelCalls && !active.cumulative) return undefined;
    let use = active.usageSum;
    if (active.cumulative) {
      const delta = {
        prompt: active.cumulative.prompt - this.cumulativeBase.prompt,
        completion: active.cumulative.completion - this.cumulativeBase.completion,
        total: active.cumulative.total - this.cumulativeBase.total,
        cached: active.cumulative.cached - this.cumulativeBase.cached,
      };
      // A cumulative that moved backwards means the server reset behind us; trust the per-call sum.
      if (delta.prompt >= 0 && delta.completion >= 0 && delta.total >= 0 && delta.cached >= 0) use = delta;
    }
    return {
      prompt_tokens: use.prompt,
      completion_tokens: use.completion,
      total_tokens: use.total,
      cached_tokens: use.cached,
      context_tokens: active.lastCall?.prompt,
      context_cached_tokens: active.lastCall?.cached,
      model_calls: Math.max(1, active.modelCalls),
    };
  }

  private syncCumulativeBase(active: ActiveTurn | null | undefined): void {
    if (active?.cumulative) this.cumulativeBase = active.cumulative;
  }

  private finishUsage(active: ActiveTurn): Usage | undefined {
    const usage = this.usageSnapshot(active);
    this.syncCumulativeBase(active);
    return usage;
  }

  private ensureClient(): Promise<RpcClient> {
    if (this.clientReady) return this.clientReady;
    const ready = (async () => {
      let client: RpcClient | null = null;
      try {
        client = this.clientFactory({
          // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
          onNotification: (method, params) => this.onNotification(method, params as any),
          // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
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

  private async onRequest(method: string, params: any): Promise<JsonValue> {
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
    active.heartbeat?.();
    let result = active.toolResults.get(call.id);
    if (!result) {
      result = (async () => {
        active.activeTools++;
        active.heartbeat?.();
        try { return toolResultContent(await active.executeTool!(call)); }
        finally {
          active.activeTools--;
          active.heartbeat?.();
        }
      })();
      active.toolResults.set(call.id, result);
    }
    return result;
  }

  private onNotification(method: string, params: any): void {
    const active = this.active;
    if (!active || (params?.threadId && params.threadId !== active.threadId)) return;
    active.heartbeat?.();
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
    // Codex's built-in image_gen tool finished: surface the picture instead of dropping the item.
    // The item carries base64 (`result`) and usually a path codex already saved (`savedPath`); when
    // only base64 arrives, write it next to the user's work so the answer can point at a real file.
    if (method === "item/completed" && params?.item?.type === "imageGeneration") {
      const item = params.item;
      let saved: string = isText(item.savedPath) ? item.savedPath : "";
      if (!saved && isText(item.result) && item.result.length) {
        try {
          saved = joinPath(process.cwd(), `neko-image-${Date.now()}.png`);
          writeFileSync(saved, Buffer.from(item.result, "base64"));
        } catch { saved = ""; }
      }
      if (saved) {
        const note = `\n[image saved: ${saved}]${item.revisedPrompt ? `\n(prompt as rendered: ${String(item.revisedPrompt).slice(0, 200)})` : ""}\n`;
        active.answer += note;
        active.onDelta?.(note, "content");
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      // One notification per completed internal model call: `last` is that call, `total` is the
      // thread-cumulative. Both are kept - the sum of lasts for the turn, the cumulative as the
      // preferred (duplicate-proof) source, and the last call's prompt as the live context size.
      const last = readTokenUsage(params?.tokenUsage?.last);
      const total = readTokenUsage(params?.tokenUsage?.total);
      if (last) {
        active.lastCall = last;
        active.modelCalls += 1;
        active.usageSum.prompt += last.prompt;
        active.usageSum.completion += last.completion;
        active.usageSum.total += last.total;
        active.usageSum.cached += last.cached;
      }
      if (total) active.cumulative = total;
      const usage = this.usageSnapshot(active);
      if (usage) active.onUsage?.(usage);
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

function makeActiveTurn(
  threadId: string,
  onDelta?: DeltaHook,
  onUsage?: CompleteOptions["onUsage"],
  executeTool?: CompleteOptions["executeTool"],
): ActiveTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return {
    threadId, answer: "", usageSum: { prompt: 0, completion: 0, total: 0, cached: 0 }, modelCalls: 0,
    onDelta, onUsage, executeTool, toolResults: new Map(), activeTools: 0, resolve, reject, done,
  };
}

async function waitForSettlement(done: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (timer as any).unref?.();
  });
  const settled = done.then(() => true, () => true);
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/** One usage shape from a codex tokenUsage record ({input,output,total,cachedInput}Tokens). */
function readTokenUsage(raw: any): { prompt: number; completion: number; total: number; cached: number } | null {
  if (!isObject(raw)) return null;
  const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0; };
  return { prompt: n(raw.inputTokens), completion: n(raw.outputTokens), total: n(raw.totalTokens), cached: n(raw.cachedInputTokens) };
}

/**
 * Codex's `thread/inject_items` deserializes into a strict `#[serde(tag = "type")]` ResponseItem
 * enum, so every item needs an explicit `type`. `toResponsesInput` targets the OpenAI Responses
 * REST API, which leaves `type: "message"` implicit on role-bearing items; function_call and
 * function_call_output already carry their tag. Add the missing message tag for the inject path
 * only, without changing the shared REST converter.
 */
function toInjectItems(items: any[]): any[] {
  return items.map((item) => {
    if (isObject(item) && !("type" in item) && isText(item.role)) {
      return { type: "message", role: item.role, content: Array.isArray(item.content) ? item.content : [] };
    }
    return item;
  });
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
  const failed = isText(observation) && (/^Error running\b/.test(observation) || /^\[denied\]/.test(observation));
  if (isText(observation)) return { contentItems: [{ type: "inputText", text: observation || "(no output)" }], success: !failed };
  const contentItems: any[] = [];
  for (const part of observation) {
    if (part?.type === "text") contentItems.push({ type: "inputText", text: String(part.text ?? "") });
    else if (part?.type === "image_url" && part.image_url?.url) contentItems.push({ type: "inputImage", imageUrl: String(part.image_url.url) });
  }
  return { contentItems: contentItems.length ? contentItems : [{ type: "inputText", text: "(no output)" }], success: true };
}

function textContent(content: any): string {
  if (isText(content)) return content;
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
      const bridge = this.bridge;
      this.bridge = null;
      if (bridge) {
        return bridge.dispose().then(() => this.direct.complete(messages, tools, onDelta, signal, opts));
      }
      return this.direct.complete(messages, tools, onDelta, signal, opts);
    }
    this.bridge ??= new ChatGptAppServerProvider(this.cfg);
    return this.bridge.complete(messages, tools, onDelta, signal, opts);
  }

  async dispose(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = null;
    const settle = (cleanup: () => void | Promise<void>): Promise<{} | { error: unknown }> => {
      try { return Promise.resolve(cleanup()).then(() => ({}), (error) => ({ error })); }
      catch (error) { return Promise.resolve({ error }); }
    };
    // Start both cleanups before awaiting either so one slow provider cannot keep the sidecar alive.
    const [directResult, bridgeResult] = await Promise.all([
      settle(() => this.direct.dispose?.()),
      settle(() => bridge?.dispose()),
    ]);
    if ("error" in directResult) throw directResult.error;
    if ("error" in bridgeResult) throw bridgeResult.error;
  }
}
