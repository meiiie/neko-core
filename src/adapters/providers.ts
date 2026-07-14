/**
 * LLM providers behind one `complete(messages, tools)` contract (provider-agnostic core).
 *
 * One real provider: `openai_compat` — any OpenAI-compatible /chat/completions endpoint
 * (NVIDIA NIM, OpenAI, FPT, or a LOCAL server: llama-server / Ollama). Offline-first needs
 * nothing more than pointing base_url at a local server, so there is no in-process GGUF
 * provider in the TS build (that lives only in the Python reference).
 */
import { randomUUID } from "node:crypto";
import { NekoConfig } from "./config.ts";
import type { MoaRef } from "./config.ts";
import { AnthropicProvider, isOfficialAnthropic } from "./anthropic.ts";
import { ChatGptProvider, isDirectChatGptModel, listChatGptModelCatalog } from "./chatgpt-provider.ts";
import { HybridChatGptProvider } from "./chatgpt-app-server-provider.ts";
import { GeminiCliProvider } from "./gemini-provider.ts";
import { providerScope } from "./provider-scope.ts";
import { ResponsesProvider } from "./responses-provider.ts";
import { hasGeminiCredentials, listGeminiModels } from "./gemini-cli.ts";
import { discoverCodexSupport, type CodexSupportStatus } from "./codex-app-server.ts";
import { hasChatGptCredentials } from "./chatgpt-auth.ts";
import { explainKimiAccessError, hasKimiCredentials, kimiIdentityHeaders, validKimiAccessToken } from "./kimi-auth.ts";
import { clampEffort, effortLevelsFromError, requestEffort, resolveEffort } from "./effort.ts";
import { SESSION_CONTEXT_MARK } from "../core/agent-constants.ts";
import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";

// Re-export the port types so callers can keep importing them from the provider adapter.
export type { DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]); // 529 = Anthropic-style overloaded_error (Z.ai sends it too)

export { clampEffort } from "./effort.ts";

/** NVIDIA NIM vision endpoints take the image embedded as an <img> tag inside the message content
 * STRING, not as an OpenAI image_url content-part. Fold any image_url parts into <img> tags so these
 * models actually SEE the image (verified: phi-3-vision / neva read + ground via this format; the
 * OpenAI content-part format is silently ignored). Text-only messages pass through unchanged. */
export function toImgTagMessages(messages: any[]): any[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let content = "";
    let hasImage = false;
    for (const part of m.content) {
      if (part?.type === "text") content += part.text;
      else if (part?.type === "image_url" && part.image_url?.url) {
        content += `<img src="${part.image_url.url}" />`;
        hasImage = true;
      }
    }
    return hasImage ? { ...m, content } : m;
  });
}

/** Chat Completions tool messages are text-only on many OpenAI-compatible endpoints. Move image parts
 * from a consecutive tool-result batch into one following user observation, after every required tool
 * result has been supplied. This keeps the tool protocol valid while making screenshots visible across
 * strict OpenAI servers; Anthropic keeps images natively inside tool_result blocks in its own adapter. */
export function normalizeToolResultImages(messages: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < messages.length;) {
    const message = messages[i];
    if (message?.role !== "tool") { out.push(message); i++; continue; }

    const images: any[] = [];
    while (i < messages.length && messages[i]?.role === "tool") {
      const tool = messages[i++];
      if (!Array.isArray(tool.content)) { out.push(tool); continue; }
      const text = tool.content.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("\n");
      const toolImages = tool.content.filter((p: any) => p?.type === "image_url" && p.image_url?.url);
      images.push(...toolImages);
      out.push({ ...tool, content: text || (toolImages.length ? "[visual observation attached next]" : "") });
    }
    if (images.length) {
      out.push({
        role: "user",
        content: [{ type: "text", text: "Visual observation(s) returned by the preceding tool call(s):" }, ...images],
      });
    }
  }
  return out;
}

const OPENAI_COMPAT_METADATA = "openai_compat_message_metadata";

function record(value: any): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function omit(value: any, keys: Set<string>): Record<string, any> {
  return Object.fromEntries(Object.entries(record(value)).filter(([key]) => !keys.has(key)));
}

function mergeRecords(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = Object.keys(record(out[key])).length && Object.keys(record(value)).length
      ? mergeRecords(record(out[key]), record(value))
      : value;
  }
  return out;
}

function messageMetadata(message: any, keepReasoning = false): Record<string, any> {
  const omitted = new Set(["role", "content", "tool_calls"]);
  if (!keepReasoning) { omitted.add("reasoning"); omitted.add("reasoning_content"); }
  return omit(message, omitted);
}

function toolCallMetadata(call: any): Record<string, any> {
  const metadata = omit(call, new Set(["index", "id", "type", "function"]));
  const functionMetadata = omit(call?.function, new Set(["name", "arguments"]));
  if (Object.keys(functionMetadata).length) metadata.function = functionMetadata;
  return metadata;
}

function metadataContinuation(
  origin: string,
  message: Record<string, any>,
  calls: Array<{ id: string; index: number; fields: Record<string, any> }>,
): any[] | undefined {
  const keptCalls = calls.filter((call) => Object.keys(call.fields).length);
  if (!origin || (!Object.keys(message).length && !keptCalls.length)) return undefined;
  return [{ type: OPENAI_COMPAT_METADATA, origin, message, calls: keptCalls }];
}

/** Replay opaque Chat Completions metadata only to the endpoint that produced it. Gemini uses this for
 * encrypted thought signatures on multi-turn tool calls; a provider switch must not leak those fields. */
function restoreOpenAICompatMetadata(message: any, origin: string): any {
  if (!message || typeof message !== "object" || !("provider_data" in message)) return message;
  const { provider_data: providerData, ...portable } = message;
  const metadata = Array.isArray(providerData)
    ? providerData.find((item) => item?.type === OPENAI_COMPAT_METADATA && item?.origin === origin)
    : undefined;
  if (!metadata) return portable;
  const restored = mergeRecords(record(metadata.message), portable);
  if (!Array.isArray(restored.tool_calls) || !Array.isArray(metadata.calls)) return restored;
  restored.tool_calls = restored.tool_calls.map((call: any, index: number) => {
    const saved = metadata.calls.find((item: any) => item?.id === call?.id || (!item?.id && item?.index === index));
    return saved ? mergeRecords(record(saved.fields), call) : call;
  });
  return restored;
}

export function getProvider(config: NekoConfig): Provider {
  if (config.provider === "moa") return new MoaProvider(config);
  if (config.provider === "anthropic") return new AnthropicProvider(config);
  if (config.provider === "chatgpt") return new HybridChatGptProvider(config, new ChatGptProvider(config));
  if (config.provider === "gemini_cli") return new GeminiCliProvider(config);
  if (config.provider === "responses") return new ResponsesProvider(config);
  if (config.provider === "kimi") return new KimiProvider(config);
  if (config.provider === "openai_compat") return new OpenAICompatProvider(config);
  throw new Error(
    `Unknown provider '${config.provider}'. Use openai_compat (any OpenAI /chat/completions endpoint or a ` +
      "local server), responses (standard Responses API), chatgpt (Plus/Pro OAuth), gemini_cli (Code Assist Enterprise), kimi (Kimi OAuth/API), anthropic (Claude Messages API), or moa (mixture-of-agents).",
  );
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  defaultEffort?: string;
  efforts?: Array<{ effort: string; description: string }>;
  contextWindow?: number;
  vision?: boolean;
  /** Model is account-visible but needs the optional local Codex bridge on this machine. */
  requiresCodexSupport?: boolean;
  available?: boolean;
}

async function listKimiModelOptions(config: NekoConfig): Promise<ModelOption[]> {
  const profile = config.profile ? config.profiles[config.profile] : undefined;
  const fallback = [...new Set([config.model, ...(profile?.models ?? [])].filter(Boolean))].map((id) => ({
    id,
    label: id,
    contextWindow: profile?.model_context?.[id] ?? profile?.context_window ?? config.contextWindow,
    vision: profile?.vision ?? config.vision,
  }));
  if (config.usesKimiAuth && !hasKimiCredentials()) return fallback;
  let key = "";
  try { key = config.usesKimiAuth ? await validKimiAccessToken() : config.apiKey; }
  catch { return fallback; }
  if (!key) return fallback;

  const request = async (force = false): Promise<Response> => {
    const token = force && config.usesKimiAuth ? await validKimiAccessToken({ force: true }) : key;
    return fetch(`${config.baseUrl}/models`, {
      headers: {
        ...(config.usesKimiAuth ? kimiIdentityHeaders() : {}),
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  };
  try {
    let response = await request();
    if (response.status === 401 && config.usesKimiAuth) response = await request(true);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { data?: any[] };
    const live = (payload.data ?? []).flatMap((model): ModelOption[] => {
      const id = typeof model?.id === "string" ? model.id : "";
      const contextWindow = Number(model?.context_length ?? 0);
      if (!id) return [];
      const efforts = Array.isArray(model?.think_efforts?.valid_efforts)
        ? model.think_efforts.valid_efforts.filter((value: unknown): value is string => typeof value === "string")
        : undefined;
      const features = [model?.supports_reasoning ? "thinking" : "", model?.supports_image_in ? "vision" : "", model?.supports_video_in ? "video" : ""]
        .filter(Boolean).join(", ");
      return [{
        id,
        label: typeof model?.display_name === "string" ? model.display_name : id,
        description: features || undefined,
        defaultEffort: typeof model?.think_efforts?.default_effort === "string" ? model.think_efforts.default_effort : undefined,
        efforts: efforts?.map((effort: string) => ({ effort, description: "" })),
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : config.contextWindow,
        vision: Boolean(model?.supports_image_in),
      }];
    });
    return live.length ? live : fallback;
  } catch {
    return fallback;
  }
}

/** Rich model metadata when the provider exposes it; plain `/models` endpoints degrade to ids. */
export async function listModelOptions(config: NekoConfig, codexSupport?: CodexSupportStatus): Promise<ModelOption[]> {
  if (config.provider === "chatgpt") {
    const known = config.profile ? config.profiles[config.profile]?.models ?? [] : [];
    const fallback = [...new Set([config.model, ...known].filter(Boolean))]
      .filter((id) => !id.startsWith("gpt-5.6-"))
      .map(fallbackChatGptOption);
    if (hasChatGptCredentials()) {
      try {
        const live = await listChatGptModelCatalog();
        const support = codexSupport ?? discoverCodexSupport();
        const compatible = live.filter((model) => isDirectChatGptModel(model) || model.slug.startsWith("gpt-5.6-"));
        if (compatible.length) return compatible.map((model) => ({
          id: model.slug,
          label: model.displayName,
          description: model.description,
          defaultEffort: model.defaultEffort,
          efforts: model.efforts,
          contextWindow: model.contextWindow,
          vision: model.inputModalities.includes("image"),
          requiresCodexSupport: !isDirectChatGptModel(model),
          available: isDirectChatGptModel(model) || support.state === "ready",
        }));
      } catch {
        // Catalog availability must not make /model unusable. The fixed, non-secret profile list is
        // an intentional degraded mode; an actual completion still reports model entitlement errors.
      }
    }
    // Keep /model useful while signed out or during a transient catalog failure. A successful live
    // account catalog always wins, so plan/rollout availability remains authoritative when reachable.
    return fallback;
  }
  if (config.provider === "gemini_cli") {
    const known = config.profile ? config.profiles[config.profile]?.models ?? [] : [];
    const fallback = [...new Set([config.model, ...known].filter(Boolean))].map((id) => ({
      id,
      label: id,
      description: id === "auto" ? "Gemini CLI chooses the best model for the task and available quota" : undefined,
      contextWindow: config.contextWindow,
      vision: true,
    }));
    if ((config.usesGeminiAuth && hasGeminiCredentials()) || (!config.usesGeminiAuth && Boolean(config.apiKey))) {
      try {
        const live = await listGeminiModels(config.usesGeminiAuth ? undefined : config.apiKey);
        if (live.length) return live.map((model) => ({
          id: model.id,
          label: model.name || model.id,
          description: model.description,
          contextWindow: config.contextWindow,
          vision: true,
        }));
      } catch {
        // Keep /model usable during a transient CLI/auth/catalog failure; completion reports the cause.
      }
    }
    return fallback;
  }
  if (config.provider === "kimi") return listKimiModelOptions(config);
  const anthropic = config.provider === "anthropic";
  const profile = config.profile ? config.profiles[config.profile] : undefined;
  const configured = [...new Set([config.model, ...(profile?.models ?? [])].filter(Boolean))].map((id) => ({
    id,
    label: id,
    contextWindow: profile?.model_context?.[id] ?? profile?.context_window ?? config.contextWindow,
    vision: profile?.vision ?? config.vision,
  }));
  if (!config.apiKey && configured.length) return configured;
  const url = `${config.baseUrl}${anthropic ? "/v1/models" : "/models"}`;
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      if (anthropic) {
        headers["x-api-key"] = config.apiKey;
        if (!isOfficialAnthropic(config.baseUrl)) headers.authorization = `Bearer ${config.apiKey}`;
        headers["anthropic-version"] = "2023-06-01";
      }
      else headers.Authorization = `Bearer ${config.apiKey}`;
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const live = ((data?.data ?? []) as any[]).map((m) => String(m?.id ?? "")).filter(Boolean).sort().map((id) => ({ id, label: id }));
    return live.length ? live : configured;
  } catch (error) {
    if (configured.length) return configured;
    throw error;
  }
}

/** Backward-compatible id-only view for CLI/tests and callers that do not need metadata. */
export async function listModels(config: NekoConfig): Promise<string[]> {
  return (await listModelOptions(config)).map((model) => model.id);
}

function fallbackChatGptOption(id: string): ModelOption {
  const efforts = ["low", "medium", "high", "xhigh"];
  const description = id.endsWith("sol") ? "Frontier quality for the hardest work"
    : id.endsWith("terra") ? "Balanced quality and speed for everyday work"
    : id.endsWith("luna") ? "Fast, efficient work and high throughput"
    : undefined;
  return {
    id,
    label: id,
    description,
    defaultEffort: "medium",
    efforts: efforts.map((effort) => ({ effort, description: "" })),
    contextWindow: id.includes("spark") ? 128_000 : 272_000,
    vision: true,
  };
}

export function isOfficialOpenAI(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com"; }
  catch { return false; }
}

/** GPT-5.6+ Chat Completions supports explicit cache breakpoints on text blocks. Mark Neko's stable
 * system prefix, leaving volatile session context after it. Older models and compatible vendors keep
 * the ordinary string message shape. */
function withOpenAICacheBreakpoint(messages: any[], model: string): any[] {
  const version = model.match(/^gpt-(\d+)(?:\.(\d+))?/i);
  if (!version) return messages;
  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);
  if (major < 5 || (major === 5 && minor < 6)) return messages;
  let marked = false;
  return messages.map((message) => {
    if (marked || message?.role !== "system" || typeof message.content !== "string") return message;
    const seam = message.content.indexOf(SESSION_CONTEXT_MARK);
    if (seam <= 0) return message;
    marked = true;
    return {
      ...message,
      content: [
        { type: "text", text: message.content.slice(0, seam), prompt_cache_breakpoint: { mode: "explicit" } },
        { type: "text", text: message.content.slice(seam) },
      ],
    };
  });
}

export class OpenAICompatProvider implements Provider {
  private readonly promptCacheKey = randomUUID();
  /** Models whose endpoint rejected `reasoning_effort` (HTTP 400/422). We then omit the field for
   * that model for the rest of the session, so a configured effort degrades gracefully instead of
   * hard-failing — and any value (low..high, 'max', future tiers) still passes through where supported. */
  private readonly effortUnsupported = new Set<string>();
  /** Per-model effort clamp: an endpoint that caps at 'high' makes 'max' -> 'high' (intent preserved). */
  private readonly effortOverride = new Map<string, string>();
  constructor(
    private readonly cfg: NekoConfig,
    private readonly resolveApiKey: () => string | Promise<string> = () => cfg.apiKey,
    private readonly resolveHeaders: () => Record<string, string> | Promise<Record<string, string>> = () => ({}),
  ) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.cfg.baseUrl) {
      throw new Error("openai_compat needs a base_url (set base_url or pick a --profile).");
    }
    if (!this.cfg.model) {
      throw new Error("openai_compat needs a model (set model or pick a --profile).");
    }
    const key = await this.resolveApiKey();
    if (!key && !this.cfg.isLocalEndpoint) {
      const keyEnv = this.cfg.profile ? this.cfg.profiles[this.cfg.profile]?.key_env : undefined;
      throw new Error(
        `No API key. Set NEKO_API_KEY${keyEnv ? ` or ${keyEnv}` : " (or OPENAI_API_KEY / NVIDIA_API_KEY)"}, or add ` +
          '"api_key" to ~/.neko-core/config.json (run `neko init-user`). ' +
          "For a local model (Ollama/llama.cpp) no key is needed - point base_url at it.",
      );
    }

    const stream = Boolean(onDelta);
    // NVIDIA NIM vision models need the image as an <img> tag in the content string, not an OpenAI
    // image_url part (which they silently ignore). Convert when the endpoint needs it -- config-first,
    // auto for an NVIDIA base_url. No-op for text-only messages, so it's safe to always apply.
    const imgTag = this.cfg.imageFormat === "img-tag" || (this.cfg.imageFormat === "auto" && /nvidia/i.test(this.cfg.baseUrl));
    // Opaque metadata belongs to the protocol, endpoint, and model that created it. Never leak an
    // encrypted thought signature after a live endpoint or model switch.
    const continuationScope = providerScope("chat-completions", this.cfg.baseUrl, this.cfg.model);
    const normalizedMessages = normalizeToolResultImages(messages.map((message) => restoreOpenAICompatMetadata(message, continuationScope)));
    const cacheAwareMessages = isOfficialOpenAI(this.cfg.baseUrl)
      ? withOpenAICacheBreakpoint(normalizedMessages, this.cfg.model)
      : normalizedMessages;
    const payload: Record<string, any> = {
      model: this.cfg.model,
      messages: imgTag ? toImgTagMessages(cacheAwareMessages) : cacheAwareMessages,
      temperature: this.cfg.temperature,
      stream,
    };
    // OpenAI's current cache router needs a stable per-session key for the most reliable prefix
    // matching (especially GPT-5.6+). Do not send the non-standard field to compatibility vendors.
    if (isOfficialOpenAI(this.cfg.baseUrl)) payload.prompt_cache_key = this.promptCacheKey;
    if (this.cfg.maxTokens > 0) payload[this.cfg.completionTokensField] = this.cfg.maxTokens; // 0 -> omit (model's full budget)
    if (stream) payload.stream_options = { include_usage: true };
    if (tools && tools.length) payload.tools = tools;
    // Proactively map a configured effort down to the endpoint's declared ceiling (e.g. 'max' -> 'high'
    // for an endpoint that caps at high), so the intent is honored without a wasted 400 round-trip.
    const requestedEffort = requestEffort(this.cfg.effort, opts?.reasoningEffort);
    const effort = clampEffort(requestedEffort, this.effortOverride.get(this.cfg.model) ?? this.cfg.effortCeiling);
    if (effort && !this.effortUnsupported.has(this.cfg.model)) {
      payload.reasoning_effort = effort;
      if (this.cfg.thinkingWire) payload.thinking = {
        type: "enabled",
        ...(this.cfg.thinkingWire === "effort" ? { effort } : {}),
      };
    }
    // Schema-constrained structured output: the endpoint fills the given JSON Schema (constrained
    // decoding where supported). Self-healed below if the endpoint rejects it.
    if (opts?.responseSchema) {
      payload.response_format = { type: "json_schema", json_schema: { name: "extraction", schema: opts.responseSchema } };
    }

    const url = `${this.cfg.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { ...(await this.resolveHeaders()), "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`; // local servers need no auth

    // HTTP errors (429/5xx) retry a bounded number of times. A LOST CONNECTION (fetch throws -
    // offline, laptop asleep) is different: keep waiting for the network to return, up to the
    // offline budget, so the turn resumes "as if it never paused" when you reopen with Wi-Fi.
    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0;
    let netAttempt = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError"); // Esc: stop now
      // IDLE timeout, not a total one. `timeoutSeconds` bounds a STALL (no bytes), reset on every
      // streamed chunk — so a long-but-healthy generation (a big landing page legitimately streams for
      // minutes) is never killed while tokens keep arriving. `AbortSignal.timeout()` capped the WHOLE
      // request, which aborted long streams mid-generation ("The operation timed out").
      const idle = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new DOMException("Idle timeout", "TimeoutError")), this.cfg.timeoutSeconds * 1000);
      };
      bumpIdle();
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([idle.signal, signal]) : idle.signal,
        });
      } catch (error) {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal?.aborted) throw error; // user interrupt, not a network blip
        if (Date.now() >= offlineDeadline) throw new Error(`openai_compat completion failed: ${messageOf(error)}`);
        netAttempt++;
        onDelta?.("(offline - waiting for the network to come back, retrying...)", "reasoning");
        await sleep(this.retryDelayMs(Math.min(netAttempt - 1, 4)), signal);
        continue;
      }
      if (res.ok) {
        // Committed (no mid-stream retry). Keep the idle timer live through the body read — bumpIdle on
        // each chunk resets it — and clear it once the stream is fully consumed.
        try {
          return stream
            ? await parseStream(res, onDelta!, bumpIdle, opts?.onToolCallReady, continuationScope)
            : parseOpenAIMessage(await res.json(), continuationScope);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      }
      if (idleTimer) clearTimeout(idleTimer); // non-ok response: stop the timer before retry/throw
      const body = await res.text().catch(() => "");
      if (RETRYABLE_STATUS.has(res.status) && httpAttempt < this.cfg.maxRetries) {
        httpAttempt++;
        // Honor Retry-After (429/503) when the server sends it; else exponential backoff.
        const ra = res.headers.get("retry-after");
        const waitMs = ra ? this.retryAfterMs(ra) : this.retryDelayMs(httpAttempt - 1);
        const label = res.status === 429 ? "rate limited" : `HTTP ${res.status}`;
        onDelta?.(`(${label} - retrying in ${Math.round(waitMs / 1000)}s, attempt ${httpAttempt}/${this.cfg.maxRetries})`, "reasoning");
        await sleep(waitMs, signal);
        continue;
      }
      // Self-heal: some endpoints reject `reasoning_effort` (the field, or a value they don't accept -
      // e.g. NVIDIA's vLLM takes only low/medium/high, not 'max'). If that's the sole problem, drop the
      // field once and retry, so a configured effort works where supported and degrades where it isn't.
      if ((res.status === 400 || res.status === 422) && payload.reasoning_effort !== undefined && /reasoning_effort/i.test(body)) {
        const advertised = effortLevelsFromError(body);
        const resolved = resolveEffort(String(payload.reasoning_effort), {
          efforts: advertised.map((effort) => ({ effort })),
        });
        if (advertised.includes(resolved) && resolved !== payload.reasoning_effort) {
          this.effortOverride.set(this.cfg.model, resolved);
          payload.reasoning_effort = resolved;
          if (payload.thinking?.effort) payload.thinking.effort = resolved;
          onDelta?.(`(effort -> ${resolved}; highest compatible tier advertised by this model)`, "reasoning");
          continue;
        }
        this.effortUnsupported.add(this.cfg.model);
        delete payload.reasoning_effort;
        if (payload.thinking?.effort) delete payload.thinking.effort;
        onDelta?.("(this endpoint rejected reasoning_effort - retrying without it)", "reasoning");
        continue;
      }
      // `thinking` is an optional compatibility extension. If an endpoint/model does not implement
      // it, fall back to that endpoint's default reasoning mode without failing the turn.
      if ((res.status === 400 || res.status === 422) && payload.thinking !== undefined && /thinking/i.test(body)) {
        delete payload.thinking;
        onDelta?.("(this endpoint rejected the thinking toggle - retrying with its default)", "reasoning");
        continue;
      }
      // Self-heal: if the endpoint rejects response_format/json_schema, drop it once and retry - the
      // caller then falls back to prompt-guided JSON instead of the whole call failing.
      if ((res.status === 400 || res.status === 422) && payload.response_format !== undefined && /response_format|json_schema|guided/i.test(body)) {
        delete payload.response_format;
        onDelta?.("(this endpoint rejected response_format - retrying without it)", "reasoning");
        continue;
      }
      const hint = res.status === 429 ? " (rate limited - slow down or raise max_retries)" : "";
      throw new Error(`HTTP ${res.status}${hint}: ${body.slice(0, 300)}`);
    }
  }

  private retryDelayMs(attempt: number): number {
    const seconds = Math.min(this.cfg.retryMaxDelaySeconds, this.cfg.retryBaseDelaySeconds * 2 ** attempt);
    return seconds * 1000;
  }

  /** Parse a Retry-After header (delta-seconds or HTTP date), capped at retryMaxDelaySeconds. */
  private retryAfterMs(header: string): number {
    const capMs = this.cfg.retryMaxDelaySeconds * 1000;
    const secs = Number(header);
    if (!Number.isNaN(secs)) return Math.min(Math.max(0, secs * 1000), capMs);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
    return Math.min(1000, capMs);
  }
}

/** Kimi uses the same Chat Completions transport with either a platform key or Neko-owned OAuth. */
export class KimiProvider implements Provider {
  private forceRefresh = false;
  private readonly delegate: OpenAICompatProvider;

  constructor(private readonly cfg: NekoConfig) {
    this.delegate = new OpenAICompatProvider(cfg, async () => {
      if (!cfg.usesKimiAuth) return cfg.apiKey;
      const token = await validKimiAccessToken({ force: this.forceRefresh });
      this.forceRefresh = false;
      return token;
    }, () => cfg.usesKimiAuth ? kimiIdentityHeaders() : {});
  }

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    try {
      return await this.delegate.complete(messages, tools, onDelta, signal, opts);
    } catch (error) {
      // One forced refresh repairs a token revoked server-side before its local expiry. A second 401
      // is authoritative and surfaces normally; never loop or silently switch to API billing.
      if (!this.cfg.usesKimiAuth) throw error;
      if (!/\bHTTP 401\b/i.test(messageOf(error))) throw explainKimiAccessError(error);
      this.forceRefresh = true;
      try {
        return await this.delegate.complete(messages, tools, onDelta, signal, opts);
      } catch (retryError) {
        throw explainKimiAccessError(retryError);
      }
    } finally {
      this.forceRefresh = false;
    }
  }
}

/**
 * Normalize an OpenAI-style response into the provider contract. Throws a clear error
 * (not a raw TypeError) when the endpoint returns an error object / unexpected shape,
 * so the CLI shows the API message and the chat REPL can stay alive.
 */
export function parseOpenAIMessage(data: any, origin = ""): ProviderResponse {
  const choices = data?.choices;
  if (!choices || !choices.length) {
    const error = data?.error;
    const detail = error && typeof error === "object" ? error.message : (error ?? JSON.stringify(data));
    throw new Error(`unexpected API response: ${String(detail).slice(0, 300)}`);
  }
  const message = choices[0]?.message ?? {};
  const toolCalls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    const fn = call.function ?? {};
    let args: Record<string, any>;
    try {
      args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments ?? {});
    } catch {
      args = { _raw: fn.arguments };
    }
    toolCalls.push({ id: call.id ?? "", name: fn.name ?? "", arguments: args });
  }
  // Reasoning comes either as a dedicated field OR embedded as <think>..</think> in content.
  const split = splitThink(message.content);
  const fieldReasoning = message.reasoning_content ?? message.reasoning ?? "";
  const reasoning = [fieldReasoning, split.reasoning].filter(Boolean).join("\n") || undefined;
  const continuation = metadataContinuation(
    origin,
    // DeepSeek/Kimi require reasoning_content to be replayed on the assistant tool-call turn.
    // Keep it opaque and endpoint/model-scoped; final non-tool reasoning is deliberately not stored.
    messageMetadata(message, toolCalls.length > 0),
    (message.tool_calls ?? []).map((call: any, index: number) => ({ id: String(call?.id ?? ""), index, fields: toolCallMetadata(call) })),
  );
  return { content: split.content, tool_calls: toolCalls, usage: data.usage, reasoning, continuation };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Streaming splitter that routes <think>...</think> EMBEDDED IN CONTENT to the reasoning channel.
 * Many open reasoning models (DeepSeek-R1, QwQ, local thinking models) stream thinking inside content
 * tags instead of the reasoning_content field — without this it would leak into the answer. Holds a
 * small tail so a tag split across SSE deltas is still recognized. */
export function makeThinkSplitter(onContent: (s: string) => void, onReasoning: (s: string) => void) {
  let inThink = false;
  let buf = "";
  const emit = (s: string) => { if (s) (inThink ? onReasoning : onContent)(s); };
  const partialTail = (s: string): number => {
    const tag = inThink ? THINK_CLOSE : THINK_OPEN;
    for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(s.length - k))) return k;
    return 0;
  };
  return {
    push(chunk: string) {
      buf += chunk;
      for (;;) {
        const idx = buf.indexOf(inThink ? THINK_CLOSE : THINK_OPEN);
        if (idx === -1) break;
        emit(buf.slice(0, idx));
        buf = buf.slice(idx + (inThink ? THINK_CLOSE : THINK_OPEN).length);
        inThink = !inThink;
      }
      const keep = partialTail(buf);
      if (buf.length > keep) { emit(buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); }
    },
    flush() { emit(buf); buf = ""; },
  };
}

/** Pull <think>...</think> out of a non-streamed message body into reasoning. */
function splitThink(text: string | null | undefined): { content: string | null; reasoning: string } {
  if (!text) return { content: text ?? null, reasoning: "" };
  let reasoning = "";
  const content = text.replace(/<think>([\s\S]*?)<\/think>/g, (_m, t) => { reasoning += t; return ""; });
  return { content: content.trim() || null, reasoning };
}

/** Parse a streamed (SSE) chat completion, calling onDelta for each content chunk. */
async function parseStream(
  res: Response,
  onDelta: DeltaHook,
  onActivity?: () => void,
  onToolCallReady?: (call: ToolCall) => void,
  origin = "",
): Promise<ProviderResponse> {
  if (!res.body) throw new Error("streaming response had no body (the endpoint returned a 200 with an empty stream)");
  let content = "";
  let reasoning = "";
  let usage: Usage | undefined;
  let reasoningField: "reasoning_content" | "reasoning" | null = null;
  const acc: { id: string; name: string; argString: string; metadata: Record<string, any> }[] = [];
  let streamedMessageMetadata: Record<string, any> = {};
  const announced = new Set<number>(); // tool calls whose name we've already surfaced
  // OpenAI streams index-keyed argument deltas and may interleave several indexes in one chunk. There
  // is no per-call stop marker, so an index switch does NOT mean completion. A call is eager-ready only
  // once its accumulated arguments parse as a complete JSON object; invalid tails finalize at stream end.
  const finalized = new Map<number, ToolCall>();
  const finalize = (i: number, force = false): void => {
    const t = acc[i];
    if (!t || finalized.has(i)) return;
    let args: Record<string, any>;
    try {
      const parsed = t.argString ? JSON.parse(t.argString) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments must be an object");
      args = parsed;
    } catch {
      if (!force) return;
      args = { _raw: t.argString };
    }
    if (!force && (!t.id || !t.name)) return;
    const call = { id: t.id, name: t.name, arguments: args };
    finalized.set(i, call);
    try { onToolCallReady?.(call); } catch { /* an eager-start failure never breaks parsing */ }
  };
  const think = makeThinkSplitter(
    (s) => { content += s; onDelta(s); },
    (s) => { reasoning += s; onDelta(s, "reasoning"); },
  );

  for await (const line of sseLines(res, onActivity)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    streamedMessageMetadata = mergeRecords(streamedMessageMetadata, messageMetadata(delta));
    if (delta.content) think.push(delta.content); // routes <think>..</think> -> reasoning, rest -> content
    if (delta.reasoning_content !== undefined) reasoningField = "reasoning_content";
    else if (delta.reasoning !== undefined) reasoningField = "reasoning";
    const r = delta.reasoning_content ?? delta.reasoning;
    if (r) {
      reasoning += r;
      onDelta(r, "reasoning");
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      acc[i] ??= { id: "", name: "", argString: "", metadata: {} };
      acc[i].metadata = mergeRecords(acc[i].metadata, toolCallMetadata(tc));
      if (tc.id) acc[i].id = tc.id;
      if (tc.function?.name) {
        acc[i].name = tc.function.name;
        if (!announced.has(i)) { announced.add(i); onDelta(`preparing ${tc.function.name}...`, "reasoning"); } // show activity early
      }
      if (tc.function?.arguments) {
        acc[i].argString += tc.function.arguments;
        onDelta(tc.function.arguments, "tool"); // count a big tool-call's args in the live token meter
      }
      finalize(i); // eager only when this index now holds a complete JSON object
    }
  }
  think.flush(); // emit any buffered tail (e.g. trailing content with no closing tag)

  // Finalize every accumulated call (fires onToolCallReady for the last/open one) and build the
  // response from the SAME finalized objects so eager consumers and the loop see identical calls.
  acc.forEach((_t, i) => finalize(i, true));
  const toolCalls: ToolCall[] = acc.map((_t, i) => finalized.get(i)!).filter(Boolean);
  if (toolCalls.length && reasoning && reasoningField) streamedMessageMetadata[reasoningField] = reasoning;
  const continuation = metadataContinuation(
    origin,
    streamedMessageMetadata,
    acc.map((call, index) => ({ id: call.id, index, fields: call.metadata })),
  );
  return { content: content || null, tool_calls: toolCalls, usage, reasoning: reasoning || undefined, continuation };
}

/** Yield non-empty lines from an SSE response body. */
async function* sseLines(res: Response, onActivity?: () => void): AsyncGenerator<string> {
  const reader = res.body!.getReader(); // parseStream guards res.body before calling this
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.(); // bytes arrived -> reset the idle timeout so a healthy long stream never times out
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

/** Sleep that rejects immediately if the signal aborts, so a retry backoff is interruptible. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted by user", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted by user", "AbortError"));
      },
      { once: true },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mixture-of-Agents (clean-room from the Together AI MoA paper, arXiv 2406.04692, + Hermes Agent's
 * design): N reference models analyze the request IN PARALLEL and WITHOUT tools; their analyses become
 * private advice for an aggregator model, and ONLY the aggregator carries the tools and drives the agent
 * loop. Diverse advisors lift quality on hard turns; the cost is N+1 model calls per turn, so it is an
 * opt-in "quality" provider (`provider: "moa"` + a `moa` config block), not a default.
 */
export class MoaProvider implements Provider {
  private readonly references: { provider: OpenAICompatProvider; label: string }[];
  private readonly aggregator: OpenAICompatProvider;

  constructor(cfg: NekoConfig) {
    const moa = cfg.moa;
    if (!moa) throw new Error("provider 'moa' needs a 'moa' config block with references + an aggregator.");
    this.references = moa.references.map((r) => ({
      provider: new OpenAICompatProvider(moaSubConfig(cfg, r, moa.referenceTemperature)),
      label: r.model,
    }));
    this.aggregator = new OpenAICompatProvider(moaSubConfig(cfg, moa.aggregator, moa.aggregatorTemperature));
  }

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    // 1. References analyze IN PARALLEL, WITHOUT tools (they advise; they don't act), on an
    //    ADVISORY-SAFE view of the conversation (user/assistant text only — no system prompt to
    //    re-bill, no tool_calls/tool results that strict providers 400 on). A failing reference
    //    degrades to a noted gap instead of sinking the turn.
    const refMessages = advisoryMessages(messages);
    const refs = await Promise.all(this.references.map((r) =>
      r.provider.complete(refMessages, undefined, undefined, signal)
        .then((res) => ({ label: r.label, content: (res.content ?? "").trim(), usage: res.usage }))
        .catch((e) => ({ label: r.label, content: `(unavailable: ${messageOf(e)})`, usage: undefined as Usage | undefined })),
    ));
    if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");

    // 2. Fold the advisors' analyses into the system prompt for THIS call only (ephemeral — the agent
    //    persists only the returned message, so advice never pollutes the saved conversation).
    const advice = refs.map((r, i) => `### Advisor ${i + 1} (${r.label})\n${r.content || "(no answer)"}`).join("\n\n");
    const guidance =
      `MIXTURE-OF-AGENTS: ${refs.length} independent model(s) analyzed the current request. Treat their ` +
      `analyses below as ADVICE - they may disagree or be wrong; weigh them critically, take what's correct, ` +
      `then give the best answer and perform any tool actions yourself.\n\n${advice}`;
    const aggMessages = withSystemAppendix(messages, guidance);

    // 3. The aggregator alone holds the tools and produces the streamed answer.
    const res = await this.aggregator.complete(aggMessages, tools, onDelta, signal, opts);

    // 4. Bill the whole mixture: total_tokens sums every call, but prompt/completion stay the
    //    aggregator's so the context-window / auto-compaction math isn't inflated by the references.
    return { ...res, usage: moaUsage(refs.map((r) => r.usage), res.usage) };
  }
}

/** Advisory-safe message view for reference models (learned from Hermes Agent's moa_loop): keep only
 * user/assistant TEXT turns. Drops the system prompt (don't re-bill it per reference), tool-result
 * messages, and tool_calls payloads (strict providers 400 on orphan tool messages). Falls back to the
 * last user turn if everything was stripped. */
function advisoryMessages(messages: any[]): any[] {
  const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "");
  const trimmed: any[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue; // drop system + tool-result roles
    const text = textOf(m.content).trim();
    if (!text) continue; // drop tool-call-only assistant turns / empty
    trimmed.push({ role: m.role, content: text });
  }
  if (trimmed.length) return trimmed;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = textOf(messages[i]?.content).trim();
    if (messages[i]?.role === "user" && t) return [{ role: "user", content: t }];
  }
  return [{ role: "user", content: "" }];
}

/** A single-model sub-config: base settings (+ a named profile's base_url/key) with this model + temp. */
function moaSubConfig(cfg: NekoConfig, ref: MoaRef, temperature: number): NekoConfig {
  const profileData = ref.profile && cfg.profiles[ref.profile] ? cfg.profiles[ref.profile] : {};
  const data = { ...cfg.data, ...profileData, model: ref.model, temperature, provider: "openai_compat" };
  return new NekoConfig(data, null, cfg.profiles, cfg.apiKey);
}

/** Append text to the conversation's system message (on a copy), or prepend one if there's none. */
function withSystemAppendix(messages: any[], text: string): any[] {
  const copy = messages.map((m) => ({ ...m }));
  const sys = copy.find((m) => m.role === "system");
  if (sys && typeof sys.content === "string") {
    sys.content = `${sys.content}\n\n${text}`;
    return copy;
  }
  return [{ role: "system", content: text }, ...copy];
}

/** Mixture usage: total_tokens sums every reference + aggregator; prompt/completion stay the aggregator's. */
function moaUsage(refUsages: (Usage | undefined)[], aggUsage: Usage | undefined): Usage | undefined {
  const all = [...refUsages, aggUsage].filter((u): u is Usage => !!u);
  if (!all.length) return undefined;
  const total = all.reduce((a, u) => a + (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)), 0);
  return { prompt_tokens: aggUsage?.prompt_tokens, completion_tokens: aggUsage?.completion_tokens, total_tokens: total };
}
