/**
 * Anthropic Messages API provider — speaks `POST {base_url}/v1/messages` (the format Claude uses, and the
 * format Z.ai's GLM Coding Plan / OpenCode endpoint expects: base_url https://api.z.ai/api/anthropic).
 * It implements the same `Provider` port as openai_compat, so it's a config choice (`provider: "anthropic"`),
 * not a core change. Converts Neko's internal OpenAI-shaped messages/tools to Anthropic blocks and back.
 */
import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import { NekoConfig } from "./config.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]); // 529 = Anthropic's documented overloaded_error

export class AnthropicProvider implements Provider {
  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, _opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.cfg.baseUrl) throw new Error("anthropic provider needs a base_url (e.g. https://api.z.ai/api/anthropic).");
    if (!this.cfg.model) throw new Error("anthropic provider needs a model (e.g. glm-4.6).");
    const key = this.cfg.apiKey;
    if (!key && !this.cfg.isLocalEndpoint) throw new Error("No API key for the anthropic provider. Set it in the profile's api_key or NEKO_API_KEY.");

    const stream = Boolean(onDelta);
    const { system, msgs } = toAnthropicMessages(messages);
    const payload: Record<string, any> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens > 0 ? this.cfg.maxTokens : 8192, // Anthropic REQUIRES max_tokens
      messages: msgs,
      stream,
      temperature: this.cfg.temperature,
    };
    if (system) payload.system = system;
    if (tools && tools.length) payload.tools = toAnthropicTools(tools);
    // Reasoning EFFORT on the Anthropic API = extended thinking. Map Neko's effort -> a `thinking` budget so
    // low..max actually deepen GLM's reasoning on Z.ai (the OpenAI `reasoning_effort` field doesn't apply here).
    const budget = thinkingBudget(this.cfg.effort);
    if (budget > 0) {
      payload.thinking = { type: "enabled", budget_tokens: budget };
      payload.max_tokens = Math.max(payload.max_tokens, budget + 8192); // room for the answer AFTER thinking
      delete payload.temperature; // extended thinking requires the default temperature (can't set it)
    }

    // Prompt caching (Anthropic-style explicit breakpoints). Z.ai's compatible endpoint accepts
    // them (Claude Code clients send them on every request); an endpoint that rejects them is
    // healed below by stripping + one retry, so this is safe-by-default (`prompt_cache: false` opts out).
    let cacheOn = this.cfg.promptCache;
    if (cacheOn) addCacheBreakpoints(payload);

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
    if (key) { headers["x-api-key"] = key; headers["authorization"] = `Bearer ${key}`; } // x-api-key (Anthropic) + Bearer (Z.ai)

    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0, netAttempt = 0;
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
          return stream ? await parseStream(res, onDelta!, bumpIdle) : parseMessage(await res.json());
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
export function toAnthropicMessages(messages: any[]): { system: string; msgs: any[] } {
  const sys: string[] = [];
  const msgs: any[] = [];
  for (const m of messages) {
    if (m.role === "system") { sys.push(typeof m.content === "string" ? m.content : textOf(m.content)); continue; }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") };
      const last = msgs[msgs.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.length > 0 && last.content.every((b: any) => b.type === "tool_result")) last.content.push(block);
      else msgs.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant") {
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
      msgs.push({ role: "user", content: m.content.map((p: any) => {
        if (p?.type === "image_url" && p.image_url?.url) {
          const dm = String(p.image_url.url).match(/^data:([^;]+);base64,(.+)$/);
          if (dm) return { type: "image", source: { type: "base64", media_type: dm[1], data: dm[2] } };
        }
        return { type: "text", text: p?.type === "text" ? p.text : "" };
      }) });
    } else msgs.push({ role: "user", content: String(m.content ?? "") });
  }
  return { system: sys.filter(Boolean).join("\n\n"), msgs };
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
    payload.system = [{ type: "text", text: payload.system, cache_control: { type: "ephemeral" } }];
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

/** Undo addCacheBreakpoints (the self-heal path for endpoints that reject cache_control). */
export function stripCacheBreakpoints(payload: Record<string, any>): void {
  if (Array.isArray(payload.system) && payload.system.length === 1 && payload.system[0]?.type === "text") {
    payload.system = payload.system[0].text;
  }
  for (const m of payload.messages ?? []) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b === "object") delete b.cache_control;
  }
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
export function parseMessage(data: any): ProviderResponse {
  if (data?.type === "error" || data?.error) throw new Error(`anthropic API error: ${String(data?.error?.message ?? JSON.stringify(data)).slice(0, 300)}`);
  let content = "", reasoning = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data?.content ?? []) {
    if (block.type === "text") content += block.text;
    else if (block.type === "thinking") reasoning += block.thinking ?? "";
    else if (block.type === "tool_use") toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: block.input ?? {} });
  }
  return { content: content || null, tool_calls: toolCalls, usage: usageOf(data?.usage), reasoning: reasoning || undefined };
}

/** Streamed (SSE) Anthropic response: text_delta -> content, thinking_delta -> reasoning, input_json_delta
 * accumulates a tool_use's args. */
async function parseStream(res: Response, onDelta: DeltaHook, onActivity?: () => void): Promise<ProviderResponse> {
  if (!res.body) throw new Error("anthropic streaming response had no body");
  let content = "", reasoning = "";
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};
  const toolCalls: ToolCall[] = [];
  const usage: Usage = {};
  for await (const ev of sseEvents(res, onActivity)) {
    switch (ev.type) {
      case "message_start": { const u = ev.message?.usage ?? {}; const su = usageOf(u); if (u.input_tokens != null) usage.prompt_tokens = su.prompt_tokens; if (u.output_tokens != null) usage.completion_tokens = su.completion_tokens; if (su.cached_tokens) usage.cached_tokens = su.cached_tokens; if (su.cache_write_tokens) usage.cache_write_tokens = su.cache_write_tokens; break; }
      case "content_block_start": blocks[ev.index] = { type: ev.content_block?.type, id: ev.content_block?.id, name: ev.content_block?.name, json: "" }; break;
      case "content_block_delta": {
        const d = ev.delta;
        if (d?.type === "text_delta") { content += d.text; onDelta(d.text); }
        else if (d?.type === "thinking_delta") { reasoning += d.thinking; onDelta(d.thinking, "reasoning"); }
        else if (d?.type === "input_json_delta") { const b = blocks[ev.index]; if (b) { b.json += d.partial_json; onDelta(d.partial_json, "tool"); } }
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b?.type === "tool_use") { let input: any = {}; try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = { _raw: b.json }; } toolCalls.push({ id: b.id ?? "", name: b.name ?? "", arguments: input }); }
        break;
      }
      case "message_delta": { const u = ev.usage ?? {}; if (u.output_tokens != null) usage.completion_tokens = u.output_tokens; if (u.input_tokens != null) usage.prompt_tokens = u.input_tokens; break; }
      case "error": throw new Error(`anthropic stream error: ${String(JSON.stringify(ev.error)).slice(0, 200)}`);
      case "message_stop": break;
    }
  }
  usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  return { content: content || null, tool_calls: toolCalls, usage, reasoning: reasoning || undefined };
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
