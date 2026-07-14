/** ChatGPT subscription provider: OpenAI Responses wire format over the Codex backend. */
import { randomUUID } from "node:crypto";

import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import { VERSION } from "../shared/version.ts";
import type { NekoConfig } from "./config.ts";
import { providerScope } from "./provider-scope.ts";
import { effortLevelsFromError, requestEffort, resolveEffort } from "./effort.ts";
import { setModel } from "./project.ts";
import { CHATGPT_CODEX_MODELS_URL, CHATGPT_CODEX_RESPONSES_URL, CHATGPT_CODEX_USAGE_URL, validChatGptCredentials } from "./chatgpt-auth.ts";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// The models endpoint filters entries by Codex client compatibility, not by Neko's app version.
// Bump this only after checking the current Codex Responses/model contract remains supported here.
export const CHATGPT_CODEX_COMPAT_VERSION = "0.144.0";

export interface ChatGptModelInfo {
  slug: string;
  displayName: string;
  description: string;
  defaultEffort: string;
  efforts: Array<{ effort: string; description: string }>;
  contextWindow?: number;
  inputModalities: string[];
  useResponsesLite: boolean;
  toolMode?: string;
  minimalClientVersion?: string;
}

/**
 * The subscription catalog is broader than the third-party Responses surface. In particular,
 * Responses-Lite/code-mode-only models are currently routed only for the official Codex client:
 * the same authenticated request is accepted for codex_cli_rs and returned as model_not_found for
 * honest third-party originators (including Neko and OpenCode). Do not advertise a model that this
 * adapter cannot actually complete with.
 */
export function isDirectChatGptModel(model: Pick<ChatGptModelInfo, "useResponsesLite" | "toolMode">): boolean {
  return !model.useResponsesLite && model.toolMode !== "code_mode_only";
}

export interface ChatGptUsageWindow {
  usedPercent: number;
  windowSeconds: number;
  resetsAt?: number;
}

export interface ChatGptUsageLimit {
  id: string;
  name: string;
  allowed: boolean;
  limitReached: boolean;
  primary?: ChatGptUsageWindow;
  secondary?: ChatGptUsageWindow;
}

export interface ChatGptUsageReport {
  planType: string;
  limits: ChatGptUsageLimit[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  reachedType?: string;
}

/** Fetch the account-aware Codex catalog including model-specific effort and context metadata. */
export async function listChatGptModelCatalog(fetchImpl: typeof fetch = fetch): Promise<ChatGptModelInfo[]> {
  const url = new URL(CHATGPT_CODEX_MODELS_URL);
  url.searchParams.set("client_version", CHATGPT_CODEX_COMPAT_VERSION);
  const data = await chatGptGetJson(url, "model catalog", fetchImpl) as { models?: any[] };
  if (!Array.isArray(data.models)) throw new Error("ChatGPT model catalog returned an invalid response");
  const seen = new Set<string>();
  const models: ChatGptModelInfo[] = [];
  for (const raw of data.models) {
    if (raw?.visibility !== undefined && raw.visibility !== "list") continue;
    const slug = String(raw?.slug ?? "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const efforts = Array.isArray(raw?.supported_reasoning_levels)
      ? raw.supported_reasoning_levels.map((level: any) => ({
          effort: String(level?.effort ?? "").trim().toLowerCase(),
          description: String(level?.description ?? "").trim(),
        })).filter((level: { effort: string }) => level.effort)
      : [];
    const contextWindow = Number(raw?.context_window);
    const inputModalities = Array.isArray(raw?.input_modalities)
      ? raw.input_modalities.map((modality: unknown) => String(modality).trim().toLowerCase()).filter(Boolean)
      : [];
    models.push({
      slug,
      displayName: String(raw?.display_name ?? slug).trim() || slug,
      description: String(raw?.description ?? "").trim(),
      defaultEffort: String(raw?.default_reasoning_level ?? "").trim().toLowerCase(),
      efforts,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
      inputModalities,
      useResponsesLite: raw?.use_responses_lite === true,
      toolMode: typeof raw?.tool_mode === "string" ? raw.tool_mode : undefined,
      minimalClientVersion: typeof raw?.minimal_client_version === "string" ? raw.minimal_client_version : undefined,
    });
  }
  return models;
}

export async function listChatGptModels(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await listChatGptModelCatalog(fetchImpl)).map((model) => model.slug);
}

/** Clamp only when the selected model's live catalog explicitly declares its supported levels. */
export function resolveChatGptEffort(requested: string, model?: { efforts?: ChatGptModelInfo["efforts"]; defaultEffort?: string }): string {
  return resolveEffort(requested, model);
}

/** Read ChatGPT subscription windows/credits. This endpoint is read-only and does not consume model quota. */
export async function getChatGptUsage(fetchImpl: typeof fetch = fetch): Promise<ChatGptUsageReport> {
  const raw = await chatGptGetJson(CHATGPT_CODEX_USAGE_URL, "usage", fetchImpl) as any;
  const limits: ChatGptUsageLimit[] = [];
  const addLimit = (id: string, name: string, value: any) => {
    const rate = value?.rate_limit ?? value;
    limits.push({
      id,
      name,
      allowed: rate?.allowed !== false,
      limitReached: rate?.limit_reached === true,
      primary: usageWindow(rate?.primary_window),
      secondary: usageWindow(rate?.secondary_window),
    });
  };
  addLimit("codex", "Codex", raw?.rate_limit);
  for (const extra of Array.isArray(raw?.additional_rate_limits) ? raw.additional_rate_limits : []) {
    addLimit(String(extra?.metered_feature ?? extra?.limit_name ?? "additional"), String(extra?.limit_name ?? extra?.metered_feature ?? "Additional"), extra);
  }
  const credits = raw?.credits;
  const reached = raw?.rate_limit_reached_type;
  return {
    planType: String(raw?.plan_type ?? "unknown"),
    limits,
    credits: credits && typeof credits === "object" ? {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: credits.balance == null ? undefined : String(credits.balance),
    } : undefined,
    reachedType: typeof reached === "string" ? reached : String(reached?.type ?? "") || undefined,
  };
}

async function chatGptGetJson(url: string | URL, label: string, fetchImpl: typeof fetch): Promise<unknown> {
  let forceRefresh = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await validChatGptCredentials(fetchImpl, undefined, forceRefresh);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      originator: "neko",
      "User-Agent": `neko-core/${VERSION}`,
    };
    if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (response.status === 401 && attempt === 0) { forceRefresh = true; continue; }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ChatGPT ${label} HTTP ${response.status}: ${safeError(body)}`);
    }
    return response.json();
  }
  throw new Error(`ChatGPT ${label} authentication failed after refresh`);
}

function usageWindow(raw: any): ChatGptUsageWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usedPercent = Number(raw.used_percent ?? raw.usedPercent);
  const windowSeconds = Number(raw.limit_window_seconds ?? raw.window_seconds ?? raw.windowSeconds ?? 0);
  const resetsAt = Number(raw.reset_at ?? raw.resets_at ?? raw.resetsAt);
  if (!Number.isFinite(usedPercent)) return undefined;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 0,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined,
  };
}

export class ChatGptProvider implements Provider {
  private readonly sessionId = randomUUID();
  private catalog: Promise<ChatGptModelInfo[]> | null = null;
  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.cfg.model) throw new Error("chatgpt provider needs a model (the chatgpt profile supplies one).");
    let modelId = this.cfg.model;
    let modelInfo: ChatGptModelInfo | undefined;
    const configuredEffort = requestEffort(this.cfg.effort, opts?.reasoningEffort);
    const effortNeedsCatalog = Boolean(configuredEffort && configuredEffort !== "off"
      && !["low", "medium", "high", "xhigh"].includes(configuredEffort));
    // 5.6 is currently returned in the account catalog but gated to the official Codex identity.
    // Recover old saved selections before spending a request on a guaranteed 404. The live picker
    // filters these entries, so this path is primarily a migration for existing configurations.
    if (modelId.startsWith("gpt-5.6-") || effortNeedsCatalog) {
      this.catalog ??= listChatGptModelCatalog().catch(() => []);
      const catalog = await this.catalog;
      modelInfo = catalog.find((candidate) => candidate.slug === modelId);
      if ((modelInfo && !isDirectChatGptModel(modelInfo)) || (!modelInfo && modelId.startsWith("gpt-5.6-"))) {
        const fallback = catalog.find((candidate) => candidate.slug === "gpt-5.5" && isDirectChatGptModel(candidate))
          ?? catalog.find(isDirectChatGptModel)
          ?? fallbackDirectModel("gpt-5.5");
        onDelta?.(`(${modelId} requires the official Codex Responses-Lite/code-mode transport; switched to ${fallback.slug})`, "reasoning");
        modelId = fallback.slug;
        modelInfo = fallback;
        this.cfg.data.model = modelId;
        if (fallback.inputModalities.length) this.cfg.data.vision = fallback.inputModalities.includes("image");
        // Make the one-time recovery stick for ordinary user-profile selections. If a malformed
        // settings file prevents persistence, keep the live turn working and let its normal config
        // diagnostic name the file instead of turning a model fallback into a completion failure.
        try {
          setModel(modelId, this.cfg.profile, fallback.contextWindow, fallback.inputModalities.includes("image"));
        } catch { /* runtime recovery remains valid even when settings cannot be written */ }
      }
    }
    const continuationScope = providerScope("responses", CHATGPT_CODEX_RESPONSES_URL, modelId);
    const { instructions, input } = toResponsesInput(messages, continuationScope);
    const responseTools = toResponsesTools(tools ?? []);
    const payload: Record<string, any> = {
      model: modelId,
      instructions,
      input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    };
    if (responseTools.length) {
      payload.tools = responseTools;
      payload.tool_choice = "auto";
      payload.parallel_tool_calls = true;
    }
    let effort = configuredEffort;
    // The live account catalog is authoritative for every explicit tier, including provider-defined
    // future names. Preserve the saved preference; only this request is negotiated for this model.
    if (effort && effort !== "off" && (modelInfo || effortNeedsCatalog)) {
      this.catalog ??= listChatGptModelCatalog().catch(() => []);
      modelInfo ??= (await this.catalog).find((candidate) => candidate.slug === modelId);
      const resolved = resolveChatGptEffort(effort, modelInfo);
      if (resolved !== effort) onDelta?.(`(effort ${effort} -> ${resolved}; highest supported by ${modelId})`, "reasoning");
      effort = resolved;
    }
    if (effort && effort !== "off") payload.reasoning = { effort, summary: "auto" };
    if (opts?.responseSchema) payload.text = { format: { type: "json_schema", name: "extraction", schema: opts.responseSchema, strict: true } };

    let attempt = 0;
    let refreshedAfter401 = false;
    let healedEffort = false;
    let forceRefresh = false;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      const credentials = await validChatGptCredentials(fetch, undefined, forceRefresh);
      forceRefresh = false;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        originator: "neko",
        "User-Agent": `neko-core/${VERSION}`,
        "session-id": this.sessionId,
      };
      if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;

      let response: Response;
      try {
        response = await fetch(CHATGPT_CODEX_RESPONSES_URL, { method: "POST", headers, body: JSON.stringify(payload), signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt >= this.cfg.maxRetries) throw new Error(`ChatGPT completion failed: ${messageOf(error)}`);
        await retryDelay(this.cfg, attempt++, signal, onDelta, "network error");
        continue;
      }
      if (response.ok) {
        let streamActivity = false;
        try {
          return await parseResponsesStream(
            response,
            (text, kind) => { if (text) streamActivity = true; onDelta?.(text, kind); },
            (call) => { streamActivity = true; opts?.onToolCallReady?.(call); },
            continuationScope,
          );
        } catch (error) {
          if (!streamActivity && isRetryableStreamFailure(error) && attempt < this.cfg.maxRetries) {
            await retryDelay(this.cfg, attempt++, signal, onDelta, "temporary stream failure");
            continue;
          }
          throw error;
        }
      }
      const body = await response.text().catch(() => "");
      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        forceRefresh = true;
        continue;
      }
      if (payload.reasoning?.effort && (response.status === 400 || response.status === 422) && /reasoning|effort/i.test(body)) {
        if (!healedEffort) {
          healedEffort = true;
          const advertised = effortLevelsFromError(body);
          const resolved = resolveEffort(String(payload.reasoning.effort), { efforts: advertised.map((item) => ({ effort: item })) });
          if (advertised.includes(resolved) && resolved !== payload.reasoning.effort) {
            payload.reasoning.effort = resolved;
            onDelta?.(`(effort -> ${resolved}; highest compatible tier advertised by ${modelId})`, "reasoning");
            continue;
          }
        }
        delete payload.reasoning.effort;
        onDelta?.(`(${modelId} rejected explicit effort; retrying with its default)`, "reasoning");
        continue;
      }
      if (RETRYABLE.has(response.status) && attempt < this.cfg.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) await wait(Math.min(retryAfter * 1000, this.cfg.retryMaxDelaySeconds * 1000), signal);
        else await retryDelay(this.cfg, attempt, signal, onDelta, response.status === 429 ? "rate limited" : `HTTP ${response.status}`);
        attempt++;
        continue;
      }
      throw new Error(`ChatGPT Codex HTTP ${response.status}: ${safeError(body)}`);
    }
  }
}

function fallbackDirectModel(slug: string): ChatGptModelInfo {
  return {
    slug,
    displayName: slug,
    description: "",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort, description: "" })),
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    useResponsesLite: false,
  };
}

function isRetryableStreamFailure(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  return message.includes("stream disconnected")
    || message.includes("error occurred while processing")
    || message.includes("internal server error")
    || message.includes("temporarily unavailable");
}

const RESPONSES_CONTINUATION = "neko_responses_continuation";

function responsesContinuation(providerData: any, scope: string): any[] {
  if (!Array.isArray(providerData)) return [];
  if (!scope) return providerData;
  const scoped = providerData.find((item) => item?.type === RESPONSES_CONTINUATION && item?.scope === scope);
  return Array.isArray(scoped?.items) ? scoped.items : [];
}

/** Convert Neko's Chat-Completions-shaped history into Responses input items. */
export function toResponsesInput(messages: any[], scope = ""): { instructions: string; input: any[] } {
  const systems: string[] = [];
  const input: any[] = [];
  for (const message of messages) {
    if (message?.role === "system") {
      systems.push(textContent(message.content));
      continue;
    }
    if (message?.role === "assistant") {
      input.push(...responsesContinuation(message.provider_data, scope));
      const text = textContent(message.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name ?? "",
          arguments: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
        });
      }
      continue;
    }
    if (message?.role === "tool") {
      const parts = Array.isArray(message.content) ? message.content : null;
      const output = parts ? parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("\n") : String(message.content ?? "");
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: output || "(no text output)" });
      const images = parts?.filter((p: any) => p?.type === "image_url" && p.image_url?.url) ?? [];
      if (images.length) input.push({ role: "user", content: images.map((p: any) => ({ type: "input_image", image_url: p.image_url.url })) });
      continue;
    }
    input.push({ role: "user", content: responseContent(message?.content) });
  }
  return { instructions: systems.filter(Boolean).join("\n\n"), input };
}

export function toResponsesTools(tools: any[]): any[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function?.name ?? "",
    description: tool.function?.description ?? "",
    parameters: tool.function?.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

function responseContent(content: any): any[] {
  if (!Array.isArray(content)) return [{ type: "input_text", text: String(content ?? "") }];
  return content.flatMap((part: any): any[] => {
    if (part?.type === "text") return [{ type: "input_text", text: String(part.text ?? "") }];
    if (part?.type === "image_url" && part.image_url?.url) return [{ type: "input_image", image_url: part.image_url.url }];
    return [];
  });
}

function textContent(content: any): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "")).join("\n") : "";
}

/** Parse standard Responses SSE events (OpenAI Codex, xAI, and compatible APIs). */
export async function parseResponsesStream(
  response: Response,
  onDelta?: DeltaHook,
  onToolCallReady?: (call: ToolCall) => void,
  scope = "",
  onActivity?: () => void,
): Promise<ProviderResponse> {
  if (!response.body) throw new Error("Responses streaming response had no body.");
  let content = "";
  let reasoning = "";
  let usage: Usage | undefined;
  let completed = false;
  const continuation = new Map<string, any>();
  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  const emitted = new Set<string>();
  const mergeArguments = (current: string, incoming: unknown): string => {
    if (incoming == null) return current;
    const next = String(incoming);
    if (!next) return current;
    if (!current) return next;
    try {
      const before = JSON.parse(current);
      const after = JSON.parse(next);
      const beforeKeys = before && typeof before === "object" && !Array.isArray(before) ? Object.keys(before).length : -1;
      const afterKeys = after && typeof after === "object" && !Array.isArray(after) ? Object.keys(after).length : -1;
      return beforeKeys > afterKeys ? current : next;
    } catch {
      return next;
    }
  };
  const emitCall = (key: string, force = false): ToolCall | null => {
    const item = calls.get(key);
    if (!item || emitted.has(key)) return null;
    let args: Record<string, any>;
    try {
      args = item.arguments ? JSON.parse(item.arguments) : {};
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
    } catch {
      if (!force) return null;
      args = { _raw: item.arguments };
    }
    if (!force && (!item.id || !item.name)) return null;
    const call = { id: item.id, name: item.name, arguments: args };
    emitted.add(key);
    try { onToolCallReady?.(call); } catch { /* eager execution must not break the stream */ }
    return call;
  };

  for await (const event of responseEvents(response, onActivity)) {
    const type = String(event?.type ?? "");
    if (type === "response.output_text.delta") {
      const delta = String(event.delta ?? ""); content += delta; onDelta?.(delta, "content");
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const delta = String(event.delta ?? ""); reasoning += delta; onDelta?.(delta, "reasoning");
    } else if (type === "response.output_item.added" && event.item?.type === "function_call") {
      const key = String(event.item.id ?? event.output_index ?? calls.size);
      calls.set(key, { id: String(event.item.call_id ?? event.item.id ?? ""), name: String(event.item.name ?? ""), arguments: String(event.item.arguments ?? "") });
      if (event.item.name) onDelta?.(`preparing ${event.item.name}...`, "reasoning");
    } else if (type === "response.function_call_arguments.delta") {
      const key = String(event.item_id ?? event.output_index ?? "");
      const item = calls.get(key) ?? { id: String(event.call_id ?? event.item_id ?? ""), name: String(event.name ?? ""), arguments: "" };
      item.arguments += String(event.delta ?? ""); calls.set(key, item); onDelta?.(String(event.delta ?? ""), "tool"); emitCall(key);
    } else if (type === "response.function_call_arguments.done") {
      const key = String(event.item_id ?? event.output_index ?? "");
      const item = calls.get(key) ?? { id: String(event.call_id ?? event.item_id ?? ""), name: String(event.name ?? ""), arguments: "" };
      item.id = String(event.call_id ?? item.id ?? event.item_id ?? "");
      item.name = String(event.name ?? item.name ?? "");
      item.arguments = mergeArguments(item.arguments, event.arguments);
      calls.set(key, item); emitCall(key, true);
    } else if (type === "response.output_item.done" && event.item?.type === "reasoning") {
      const item = reasoningContinuation(event.item);
      if (item) continuation.set(item.id || String(event.output_index ?? continuation.size), item);
    } else if (type === "response.output_item.done" && event.item?.type === "function_call") {
      const key = String(event.item.id ?? event.output_index ?? "");
      const item = calls.get(key) ?? { id: "", name: "", arguments: "" };
      item.id = String(event.item.call_id ?? item.id ?? event.item.id ?? "");
      item.name = String(event.item.name ?? item.name ?? "");
      item.arguments = mergeArguments(item.arguments, event.item.arguments);
      calls.set(key, item); emitCall(key, true);
    } else if (type === "response.completed") {
      completed = true;
      usage = responsesUsage(event.response?.usage);
      for (const item of event.response?.output ?? []) {
        if (item?.type === "reasoning") {
          const kept = reasoningContinuation(item);
          if (kept) continuation.set(kept.id || String(continuation.size), kept);
          continue;
        }
        if (item?.type === "message" && !content) {
          content = (item.content ?? []).filter((part: any) => part?.type === "output_text").map((part: any) => String(part.text ?? "")).join("");
          continue;
        }
        if (item?.type !== "function_call") continue;
        const key = String(item.id ?? item.call_id ?? calls.size);
        const previous = calls.get(key);
        calls.set(key, {
          id: String(item.call_id ?? previous?.id ?? item.id ?? ""),
          name: String(item.name ?? previous?.name ?? ""),
          arguments: mergeArguments(previous?.arguments ?? "", item.arguments),
        });
        emitCall(key, true);
      }
    } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      throw new Error(`Responses request failed: ${String(event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? event.error?.message ?? event.message ?? "unknown error").slice(0, 300)}`);
    }
  }
  if (!completed) throw new Error("Responses stream disconnected before response.completed.");
  for (const key of calls.keys()) emitCall(key, true);
  const toolCalls = [...calls.keys()].map((key) => {
    const item = calls.get(key)!;
    let args: Record<string, any>;
    try { args = JSON.parse(item.arguments || "{}"); } catch { args = { _raw: item.arguments }; }
    return { id: item.id, name: item.name, arguments: args };
  });
  const continuationItems = [...continuation.values()];
  const keptContinuation = scope && continuationItems.length
    ? [{ type: RESPONSES_CONTINUATION, scope, items: continuationItems }]
    : continuationItems;
  return { content: content || null, tool_calls: toolCalls, usage, reasoning: reasoning || undefined, continuation: keptContinuation };
}

function reasoningContinuation(item: any): any | null {
  if (!item || item.type !== "reasoning" || !item.encrypted_content) return null;
  return {
    type: "reasoning",
    ...(item.id ? { id: String(item.id) } : {}),
    encrypted_content: String(item.encrypted_content),
    summary: Array.isArray(item.summary) ? item.summary : [],
  };
}

async function* responseEvents(response: Response, onActivity?: () => void): AsyncGenerator<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") { try { yield JSON.parse(data); } catch { /* ignore malformed event */ } }
    }
  }
}

function responsesUsage(raw: any): Usage | undefined {
  if (!raw) return undefined;
  const input = raw.input_tokens ?? 0, output = raw.output_tokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: raw.total_tokens ?? input + output, cached_tokens: raw.input_tokens_details?.cached_tokens ?? 0 };
}

async function retryDelay(cfg: NekoConfig, attempt: number, signal: AbortSignal | undefined, onDelta: DeltaHook | undefined, reason: string): Promise<void> {
  const ms = Math.min(cfg.retryMaxDelaySeconds, cfg.retryBaseDelaySeconds * 2 ** attempt) * 1000;
  onDelta?.(`(${reason} - retrying in ${Math.round(ms / 1000)}s)`, "reasoning");
  await wait(ms, signal);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted by user", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted by user", "AbortError")); }, { once: true });
  });
}

function safeError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    return (typeof detail === "string" ? detail : JSON.stringify(detail ?? "request failed")).slice(0, 300);
  }
  catch { return body.replace(/[\r\n]+/g, " ").slice(0, 300) || "request failed"; }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
