/**
 * Anthropic Messages API provider — speaks `POST {base_url}/v1/messages` (the format Claude uses, and the
 * format Z.ai's GLM Coding Plan / OpenCode endpoint expects: base_url https://api.z.ai/api/anthropic).
 * It implements the same `Provider` port as openai_compat, so it's a config choice (`provider: "anthropic"`),
 * not a core change. Converts Neko's internal OpenAI-shaped messages/tools to Anthropic blocks and back.
 */
import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";
import { NekoConfig } from "./config.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
    if (key) { headers["x-api-key"] = key; headers["authorization"] = `Bearer ${key}`; } // x-api-key (Anthropic) + Bearer (Z.ai)

    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0, netAttempt = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(this.cfg.timeoutSeconds * 1000);
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (Date.now() >= offlineDeadline) throw new Error(`anthropic completion failed: ${msgOf(error)}`);
        netAttempt++;
        onDelta?.("(offline - waiting for the network to come back, retrying...)", "reasoning");
        await sleep(this.retryDelayMs(Math.min(netAttempt - 1, 4)), signal);
        continue;
      }
      if (res.ok) return stream ? await parseStream(res, onDelta!) : parseMessage(await res.json());
      const body = await res.text().catch(() => "");
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
async function parseStream(res: Response, onDelta: DeltaHook): Promise<ProviderResponse> {
  if (!res.body) throw new Error("anthropic streaming response had no body");
  let content = "", reasoning = "";
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};
  const toolCalls: ToolCall[] = [];
  const usage: Usage = {};
  for await (const ev of sseEvents(res)) {
    switch (ev.type) {
      case "message_start": { const u = ev.message?.usage ?? {}; if (u.input_tokens != null) usage.prompt_tokens = u.input_tokens; if (u.output_tokens != null) usage.completion_tokens = u.output_tokens; break; }
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
  const input = u?.input_tokens ?? 0, output = u?.output_tokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

/** Yield the parsed JSON of each `data:` line in an Anthropic SSE stream (the `event:` line is redundant — the
 *  JSON carries its own `type`). */
async function* sseEvents(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
