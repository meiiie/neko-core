/**
 * Anthropic Messages API provider — speaks `POST {base_url}/v1/messages` (the format Claude uses, and the
 * format Z.ai's GLM Coding Plan / OpenCode endpoint expects: base_url https://api.z.ai/api/anthropic).
 * It implements the same `Provider` port as openai_compat, so it's a config choice (`provider: "anthropic"`),
 * not a core change. Converts Neko's internal OpenAI-shaped messages/tools to Anthropic blocks and back.
 */
import type { Usage } from "../core/cost.ts";
import { SESSION_CONTEXT_MARK } from "../core/agent-constants.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import { NekoConfig } from "./config.ts";
import { providerScope } from "./provider-scope.ts";
import { clampEffort, effortLevelsFromError, requestEffort, resolveEffort } from "./effort.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]); // 529 = Anthropic's documented overloaded_error

export class AnthropicProvider implements Provider {
  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.cfg.baseUrl) throw new Error("anthropic provider needs a base_url (e.g. https://api.z.ai/api/anthropic).");
    if (!this.cfg.model) throw new Error("anthropic provider needs a model (e.g. glm-4.6).");
    const key = this.cfg.apiKey;
    if (!key && !this.cfg.isLocalEndpoint) throw new Error("No API key for the anthropic provider. Set it in the profile's api_key or NEKO_API_KEY.");

    const stream = Boolean(onDelta);
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const continuationScope = providerScope("anthropic", url, this.cfg.model);
    const { system, msgs } = toAnthropicMessages(messages, continuationScope);
    const payload: Record<string, any> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens > 0 ? this.cfg.maxTokens : 8192, // Anthropic REQUIRES max_tokens
      messages: msgs,
      stream,
    };
    const thinkingPolicy = anthropicThinkingPolicy(this.cfg.model);
    const officialAnthropic = isOfficialAnthropic(this.cfg.baseUrl);
    if (thinkingPolicy === "manual") payload.temperature = this.cfg.temperature;
    if (system) payload.system = system;
    if (tools && tools.length) payload.tools = toAnthropicTools(tools);
    // Anthropic's native structured output lives under output_config.format. Compatible Messages
    // endpoints such as Z.ai still use the portable forced-tool fallback.
    let schemaMode = Boolean(opts?.responseSchema);
    const nativeSchema = schemaMode && officialAnthropic;
    if (nativeSchema) {
      payload.output_config = { format: { type: "json_schema", schema: opts!.responseSchema } };
    } else if (schemaMode) {
      payload.tools = [{ name: "emit_extraction", description: "Return the extraction result in the required schema.", input_schema: opts!.responseSchema }];
      payload.tool_choice = { type: "tool", name: "emit_extraction" };
    }

    // Current Claude models use adaptive thinking + output_config.effort. Manual token budgets and a
    // non-default temperature are rejected by Sonnet 5. Legacy Messages-compatible models retain the
    // explicit budget path. Forced tool choice remains incompatible with thinking on compat endpoints.
    const requestedEffort = requestEffort(this.cfg.effort, opts?.reasoningEffort);
    const effort = anthropicEffort(requestedEffort, this.cfg.effortCeiling);
    if (thinkingPolicy !== "manual") {
      if (effort) {
        payload.thinking = { type: "adaptive", display: "summarized" };
        payload.output_config = { ...payload.output_config, effort };
      } else if (!requestedEffort && this.cfg.effort === "off" && thinkingPolicy === "sonnet5") {
        payload.thinking = { type: "disabled" };
      } else if (this.cfg.effort !== "off" || thinkingPolicy === "always-adaptive") {
        // Empty effort means the model's default effort, not "disable reasoning". Explicit adaptive
        // also opts into readable summaries; newest Claude models otherwise return omitted thinking.
        payload.thinking = { type: "adaptive", display: "summarized" };
      }
    } else {
      const budget = schemaMode ? 0 : thinkingBudget(effort);
      if (budget > 0) {
        payload.thinking = { type: "enabled", budget_tokens: budget };
        payload.max_tokens = Math.max(payload.max_tokens, budget + 8192);
        delete payload.temperature;
      }
    }

    // Prompt caching (Anthropic-style explicit breakpoints). Z.ai's compatible endpoint accepts
    // them (Claude Code clients send them on every request); an endpoint that rejects them is
    // healed below by stripping + one retry, so this is safe-by-default (`prompt_cache: false` opts out).
    let cacheOn = this.cfg.promptCache;
    if (cacheOn) addCacheBreakpoints(payload);

    const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
    if (key) {
      headers["x-api-key"] = key;
      if (!officialAnthropic) headers.authorization = `Bearer ${key}`; // Z.ai-compatible endpoints use Bearer
    }

    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0, netAttempt = 0, effortHealTried = false;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      // IDLE timeout (reset on every streamed chunk), NOT a total request cap: a long-but-healthy
      // generation (a big landing page legitimately streams for minutes) must not be killed while tokens
      // keep arriving; only a genuine STALL aborts. AbortSignal.timeout() capped the whole request and
      // aborted long streams mid-generation ("The operation timed out"). Same fix as providers.ts.
      const idle = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new DOMException("Idle timeout", "TimeoutError")), this.cfg.timeoutSeconds * 1000);
      };
      bumpIdle();
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([idle.signal, signal]) : idle.signal });
      } catch (error) {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal?.aborted) throw error;
        if (Date.now() >= offlineDeadline) throw new Error(`anthropic completion failed: ${msgOf(error)}`);
        netAttempt++;
        onDelta?.("(offline - waiting for the network to come back, retrying...)", "reasoning");
        await sleep(this.retryDelayMs(Math.min(netAttempt - 1, 4)), signal);
        continue;
      }
      if (res.ok) {
        try {
          const out = stream
            ? await parseStream(res, onDelta!, bumpIdle, opts?.onToolCallReady, continuationScope)
            : parseMessage(await res.json(), continuationScope);
          if (!schemaMode) return out;
          if (nativeSchema) return { ...out, content: extractJsonLoose(out.content ?? ""), tool_calls: [] };
          // Schema mode: the forced tool's validated input IS the result; in the healed (prompt-JSON)
          // fallback the model may fence/pad the JSON, so extract it loosely before returning.
          const call = out.tool_calls?.[0];
          return call
            ? { ...out, content: JSON.stringify(call.arguments ?? {}), tool_calls: [] }
            : { ...out, content: extractJsonLoose(out.content ?? "") };
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      }
      if (idleTimer) clearTimeout(idleTimer);
      const body = await res.text().catch(() => "");
      // Self-heal: a compat endpoint that rejects cache_control gets one retry without it
      // (mirrors the reasoning_effort self-heal in providers.ts).
      if (cacheOn && res.status >= 400 && res.status < 500 && /cache_control/i.test(body)) {
        cacheOn = false;
        stripCacheBreakpoints(payload);
        continue;
      }
      if (payload.output_config?.effort && res.status >= 400 && res.status < 500 && /effort/i.test(body)) {
        if (!effortHealTried) {
          effortHealTried = true;
          const advertised = effortLevelsFromError(body);
          const resolved = resolveEffort(String(payload.output_config.effort), { efforts: advertised.map((item) => ({ effort: item })) });
          if (advertised.includes(resolved) && resolved !== payload.output_config.effort) {
            payload.output_config.effort = resolved;
            onDelta?.(`(effort -> ${resolved}; highest compatible tier advertised by this Claude model)`, "reasoning");
            continue;
          }
        }
        delete payload.output_config.effort;
        if (!Object.keys(payload.output_config).length) delete payload.output_config;
        onDelta?.("(this Claude model rejected explicit effort; retrying with adaptive default)", "reasoning");
        continue;
      }
      if (payload.thinking && res.status >= 400 && res.status < 500 && /thinking|adaptive/i.test(body)) {
        delete payload.thinking;
        if (payload.output_config?.effort) delete payload.output_config.effort;
        if (payload.output_config && !Object.keys(payload.output_config).length) delete payload.output_config;
        onDelta?.("(this model rejected explicit thinking controls; retrying with its default)", "reasoning");
        continue;
      }
      // Self-heal: an endpoint that rejects forced tool_choice falls back to prompt-JSON (the reply is
      // then loose-extracted above). One retry, same pattern as the other heals.
      if (payload.tool_choice && res.status >= 400 && res.status < 500 && /tool_choice|tool choice/i.test(body)) {
        delete payload.tool_choice;
        delete payload.tools;
        const extra = `\n\nReply with ONLY a single JSON object matching this JSON Schema (no prose, no code fences):\n${JSON.stringify(opts!.responseSchema)}`;
        if (Array.isArray(payload.system)) payload.system.push({ type: "text", text: extra });
        else payload.system = `${payload.system ?? ""}${extra}`;
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && httpAttempt < this.cfg.maxRetries) {
        httpAttempt++;
        const ra = res.headers.get("retry-after");
        const waitMs = ra ? Math.min(this.cfg.retryMaxDelaySeconds * 1000, Math.max(0, (Number(ra) || 1) * 1000)) : this.retryDelayMs(httpAttempt - 1);
        onDelta?.(`(${res.status === 429 ? "rate limited" : `HTTP ${res.status}`} - retrying in ${Math.round(waitMs / 1000)}s, ${httpAttempt}/${this.cfg.maxRetries})`, "reasoning");
        await sleep(waitMs, signal);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(this.cfg.retryMaxDelaySeconds, this.cfg.retryBaseDelaySeconds * 2 ** attempt) * 1000;
  }
}

/** Neko's OpenAI-shaped messages -> Anthropic {system, messages}. System messages fold into the top-level
 * `system` string; tool results become tool_result blocks grouped into a user message; assistant tool_calls
 * become tool_use blocks; image_url parts become image blocks. */
const ANTHROPIC_CONTINUATION = "neko_anthropic_continuation";

function anthropicContinuation(providerData: any, scope: string): any[] | undefined {
  if (!scope || !Array.isArray(providerData)) return undefined;
  const match = providerData.find((item) => item?.type === ANTHROPIC_CONTINUATION && item?.scope === scope);
  return Array.isArray(match?.blocks) ? match.blocks : undefined;
}

function wrappedAnthropicContinuation(scope: string, blocks: any[]): any[] | undefined {
  return scope && blocks.length ? [{ type: ANTHROPIC_CONTINUATION, scope, blocks: structuredClone(blocks) }] : undefined;
}

export function toAnthropicMessages(messages: any[], scope = ""): { system: string; msgs: any[] } {
  const sys: string[] = [];
  const msgs: any[] = [];
  for (const m of messages) {
    if (m.role === "system") { sys.push(typeof m.content === "string" ? m.content : textOf(m.content)); continue; }
    if (m.role === "tool") {
      // Anthropic tool_result blocks accept nested text/image blocks. Preserve multimodal tool
      // observations (read_file images and computer screenshots) instead of stringifying them to
      // "[object Object]", which silently made the model blind after a successful capture.
      const nested = Array.isArray(m.content) ? toAnthropicContent(m.content) : null;
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: nested?.length ? nested : String(m.content ?? "") };
      const last = msgs[msgs.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.length > 0 && last.content.every((b: any) => b.type === "tool_result")) last.content.push(block);
      else msgs.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant") {
      // Thinking/signature/redacted_thinking blocks must be replayed byte-for-byte and in their
      // original order during a tool loop. Only trust blocks scoped to this endpoint + model.
      const native = anthropicContinuation(m.provider_data, scope);
      if (native?.length) {
        msgs.push({ role: "assistant", content: structuredClone(native) });
        continue;
      }
      const content: any[] = [];
      const text = typeof m.content === "string" ? m.content : textOf(m.content);
      if (text) content.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        let input: any = {};
        try { input = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}); } catch { input = {}; }
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      msgs.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: " " }] });
      continue;
    }
    // user
    if (Array.isArray(m.content)) {
      msgs.push({ role: "user", content: toAnthropicContent(m.content) });
    } else msgs.push({ role: "user", content: String(m.content ?? "") });
  }
  return { system: sys.filter(Boolean).join("\n\n"), msgs };
}

/** OpenAI text/image content parts -> Anthropic content blocks (valid for user messages and tool results). */
function toAnthropicContent(parts: any[]): any[] {
  return parts.map((p: any) => {
    if (p?.type === "image_url" && p.image_url?.url) {
      const dm = String(p.image_url.url).match(/^data:([^;]+);base64,(.+)$/);
      if (dm) return { type: "image", source: { type: "base64", media_type: dm[1], data: dm[2] } };
    }
    return { type: "text", text: p?.type === "text" ? String(p.text ?? "") : "" };
  });
}

/** OpenAI {type:function, function:{name,description,parameters}} -> Anthropic {name,description,input_schema}. */
export function toAnthropicTools(tools: any[]): any[] {
  return tools.map((t) => ({ name: t.function?.name, description: t.function?.description ?? "", input_schema: t.function?.parameters ?? { type: "object", properties: {} } }));
}

/** Prompt-caching breakpoints (Anthropic explicit caching; docs order the cache tools -> system ->
 * messages). Two breakpoints: (1) end of the system prompt — one entry covers tools + system, which
 * after the stable-prefix work stay byte-identical across turns; (2) rolling, on the last block of the
 * last message — each request re-reads the previous request's conversation prefix via the API's
 * 20-block lookback, so a 40-step agent turn pays for each step's tail only, not the whole history.
 * A last message that is a plain string is lifted to block form (cache_control is block-only). */
export function addCacheBreakpoints(payload: Record<string, any>): void {
  if (typeof payload.system === "string" && payload.system) {
    const boundary = payload.system.indexOf(SESSION_CONTEXT_MARK);
    const blocks = boundary > 0
      ? [payload.system.slice(0, boundary), payload.system.slice(boundary)]
      : [payload.system];
    payload.system = blocks
      .filter(Boolean)
      .map((text) => ({ type: "text", text, cache_control: { type: "ephemeral" } }));
  }
  const last = payload.messages?.[payload.messages.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    if (last.content) last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(last.content) && last.content.length) {
    const b = last.content[last.content.length - 1];
    // Thinking blocks and empty text blocks can't carry cache_control.
    if (b && b.type !== "thinking" && !(b.type === "text" && !b.text)) b.cache_control = { type: "ephemeral" };
  }
}

/** Best-effort JSON extraction from a model reply that may fence or pad it (the healed prompt-JSON
 * fallback of schema mode). Prefers a fenced block, else the first-to-last-brace slice; returns the
 * trimmed input when no braces exist so the caller's JSON.parse fails loudly (correct - no silent {}). */
export function extractJsonLoose(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  return a >= 0 && b > a ? body.slice(a, b + 1).trim() : body.trim();
}

/** Undo addCacheBreakpoints (the self-heal path for endpoints that reject cache_control). */
export function stripCacheBreakpoints(payload: Record<string, any>): void {
  if (Array.isArray(payload.system) && payload.system.every((block: any) => block?.type === "text")) {
    payload.system = payload.system.map((block: any) => String(block.text ?? "")).join("");
  }
  for (const m of payload.messages ?? []) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b === "object") delete b.cache_control;
  }
}

export function isOfficialAnthropic(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com"; }
  catch { return false; }
}

type AnthropicThinkingPolicy = "manual" | "adaptive" | "sonnet5" | "always-adaptive";

/** Current native Claude thinking contract. Unknown/compatible models stay on the legacy budget path. */
export function anthropicThinkingPolicy(model: string): AnthropicThinkingPolicy {
  const id = model.toLowerCase();
  if (/claude-(?:fable|mythos)-5/.test(id)) return "always-adaptive";
  if (/claude-sonnet-5(?:$|-)/.test(id)) return "sonnet5";
  if (/claude-(?:opus-4-(?:6|7|8)|sonnet-4-6)/.test(id)) return "adaptive";
  if (/^claude-/.test(id)) return "adaptive"; // forward-compatible official Claude family default
  return "manual";
}

function anthropicEffort(effort: string, ceiling: string): string {
  if (!effort || effort === "off") return "";
  return clampEffort(effort, ceiling);
}

/** Neko reasoning effort -> Anthropic extended-thinking budget (tokens). 0 = no extended thinking (fast).
 *  Matches the effort ladder low|medium|high|xhigh|max (and "off"/unset). */
export function thinkingBudget(effort: string): number {
  switch ((effort || "").toLowerCase()) {
    case "low": return 2048;
    case "medium": return 6000;
    case "high": return 12000;
    case "xhigh": return 24000;
    case "max": return 32000;
    default: return 0; // off / unset -> no extended thinking
  }
}

function textOf(content: any): string {
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "";
}

/** Non-streamed Anthropic message -> ProviderResponse. */
export function parseMessage(data: any, scope = ""): ProviderResponse {
  if (data?.type === "error" || data?.error) throw new Error(`anthropic API error: ${String(data?.error?.message ?? JSON.stringify(data)).slice(0, 300)}`);
  let content = "", reasoning = "";
  const toolCalls: ToolCall[] = [];
  const nativeBlocks = Array.isArray(data?.content) ? data.content : [];
  for (const block of nativeBlocks) {
    if (block.type === "text") content += block.text;
    else if (block.type === "thinking") reasoning += block.thinking ?? "";
    else if (block.type === "tool_use") toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: block.input ?? {} });
  }
  return {
    content: content || null,
    tool_calls: toolCalls,
    usage: usageOf(data?.usage),
    reasoning: reasoning || undefined,
    continuation: wrappedAnthropicContinuation(scope, nativeBlocks),
  };
}

/** Streamed (SSE) Anthropic response: text_delta -> content, thinking_delta -> reasoning, input_json_delta
 * accumulates a tool_use's args. Native blocks and thinking signatures are retained for exact replay. */
async function parseStream(
  res: Response,
  onDelta: DeltaHook,
  onActivity?: () => void,
  onToolCallReady?: (call: ToolCall) => void,
  scope = "",
): Promise<ProviderResponse> {
  if (!res.body) throw new Error("anthropic streaming response had no body");
  let content = "", reasoning = "";
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string; raw: Record<string, any> }> = {};
  const completedBlocks: Record<number, any> = {};
  const toolCalls: ToolCall[] = [];
  const usage: Usage = {};
  let completed = false;
  for await (const ev of sseEvents(res, onActivity)) {
    switch (ev.type) {
      case "message_start": { const u = ev.message?.usage ?? {}; const su = usageOf(u); if (u.input_tokens != null) usage.prompt_tokens = su.prompt_tokens; if (u.output_tokens != null) usage.completion_tokens = su.completion_tokens; if (su.cached_tokens) usage.cached_tokens = su.cached_tokens; if (su.cache_write_tokens) usage.cache_write_tokens = su.cache_write_tokens; break; }
      case "content_block_start": {
        const raw = structuredClone(ev.content_block ?? {});
        const block = blocks[ev.index] = { type: raw.type, id: raw.id, name: raw.name, json: "", raw };
        if (block.type === "text" && raw.text) { content += raw.text; onDelta(raw.text); }
        else if (block.type === "thinking" && raw.thinking) { reasoning += raw.thinking; onDelta(raw.thinking, "reasoning"); }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta;
        const b = blocks[ev.index];
        if (d?.type === "text_delta") {
          content += d.text; onDelta(d.text);
          if (b) b.raw.text = `${b.raw.text ?? ""}${d.text ?? ""}`;
        }
        else if (d?.type === "thinking_delta") {
          reasoning += d.thinking; onDelta(d.thinking, "reasoning");
          if (b) b.raw.thinking = `${b.raw.thinking ?? ""}${d.thinking ?? ""}`;
        }
        else if (d?.type === "signature_delta" && b) b.raw.signature = `${b.raw.signature ?? ""}${d.signature ?? ""}`;
        else if (d?.type === "input_json_delta") { const b = blocks[ev.index]; if (b) { b.json += d.partial_json; onDelta(d.partial_json, "tool"); } }
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b?.type === "tool_use") {
          let input: any = {};
          try { input = b.json ? JSON.parse(b.json) : (b.raw.input ?? {}); } catch { input = { _raw: b.json }; }
          b.raw.input = input;
          const call = { id: b.id ?? "", name: b.name ?? "", arguments: input };
          toolCalls.push(call);
          // The call is complete while the rest of the response still streams - let the agent
          // start a read-only execution NOW (stream-eager execution). Errors must not kill the stream.
          try { onToolCallReady?.(call); } catch { /* an eager-start failure never breaks parsing */ }
        }
        if (b) completedBlocks[ev.index] = structuredClone(b.raw);
        break;
      }
      case "message_delta": { const u = ev.usage ?? {}; if (u.output_tokens != null) usage.completion_tokens = u.output_tokens; if (u.input_tokens != null) usage.prompt_tokens = u.input_tokens; break; }
      case "error": throw new Error(`anthropic stream error: ${String(JSON.stringify(ev.error)).slice(0, 200)}`);
      case "message_stop": completed = true; break;
    }
  }
  if (!completed) throw new Error("anthropic stream disconnected before message_stop");
  usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  for (const [index, block] of Object.entries(blocks)) completedBlocks[Number(index)] ??= structuredClone(block.raw);
  const nativeBlocks = Object.keys(completedBlocks).map(Number).sort((a, b) => a - b).map((index) => completedBlocks[index]);
  return {
    content: content || null,
    tool_calls: toolCalls,
    usage,
    reasoning: reasoning || undefined,
    continuation: wrappedAnthropicContinuation(scope, nativeBlocks),
  };
}

function usageOf(u: any): Usage {
  // Anthropic's input_tokens EXCLUDES cache reads/writes; sum them back so prompt_tokens is the
  // true context size, and surface the cache split so the cost tracker can report the hit rate.
  const read = u?.cache_read_input_tokens ?? 0, write = u?.cache_creation_input_tokens ?? 0;
  const input = (u?.input_tokens ?? 0) + read + write, output = u?.output_tokens ?? 0;
  const usage: Usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  if (read) usage.cached_tokens = read;
  if (write) usage.cache_write_tokens = write;
  return usage;
}

/** Yield the parsed JSON of each `data:` line in an Anthropic SSE stream (the `event:` line is redundant — the
 *  JSON carries its own `type`). */
async function* sseEvents(res: Response, onActivity?: () => void): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.(); // bytes arrived -> reset the idle timeout so a healthy long stream never times out
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d && d !== "[DONE]") { try { yield JSON.parse(d); } catch { /* skip a partial/non-JSON line */ } }
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted by user", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted by user", "AbortError")); }, { once: true });
  });
}

function msgOf(e: unknown): string { return e instanceof Error ? e.message : String(e); }
