/**
 * LLM providers behind one `complete(messages, tools)` contract (provider-agnostic core).
 *
 * One real provider: `openai_compat` — any OpenAI-compatible /chat/completions endpoint
 * (NVIDIA NIM, OpenAI, FPT, or a LOCAL server: llama-server / Ollama). Offline-first needs
 * nothing more than pointing base_url at a local server, so there is no in-process GGUF
 * provider in the TS build (that lives only in the Python reference).
 */
import type { NekoConfig } from "./config.ts";
import type { Usage } from "../core/cost.ts";
import type { DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";

// Re-export the port types so callers can keep importing them from the provider adapter.
export type { DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function getProvider(config: NekoConfig): Provider {
  if (config.provider === "openai_compat") return new OpenAICompatProvider(config);
  throw new Error(
    `Unknown provider '${config.provider}'. Use openai_compat ` +
      "(point base_url at a remote API or a local server such as llama-server / Ollama).",
  );
}

/** List model ids the endpoint offers (OpenAI-compatible GET /models). Used by `/model list`. */
export async function listModels(config: NekoConfig): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const res = await fetch(`${config.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return ((data?.data ?? []) as any[]).map((m) => m?.id).filter(Boolean).sort();
}

export class OpenAICompatProvider implements Provider {
  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal): Promise<ProviderResponse> {
    if (!this.cfg.baseUrl) {
      throw new Error("openai_compat needs a base_url (set base_url or pick a --profile).");
    }
    if (!this.cfg.model) {
      throw new Error("openai_compat needs a model (set model or pick a --profile).");
    }
    const key = this.cfg.apiKey;
    if (!key && !this.cfg.isLocalEndpoint) {
      throw new Error(
        "No API key. Set NEKO_API_KEY (or OPENAI_API_KEY / NVIDIA_API_KEY), or add " +
          '"api_key" to ~/.neko-core/config.json (run `neko init-user`). ' +
          "For a local model (Ollama/llama.cpp) no key is needed - point base_url at it.",
      );
    }

    const stream = Boolean(onDelta);
    const payload: Record<string, any> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature,
      stream,
    };
    if (this.cfg.maxTokens > 0) payload.max_tokens = this.cfg.maxTokens; // 0 -> omit (model's full budget)
    if (stream) payload.stream_options = { include_usage: true };
    if (tools && tools.length) payload.tools = tools;
    if (this.cfg.effort) payload.reasoning_effort = this.cfg.effort; // only when set via /effort

    const url = `${this.cfg.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`; // local servers need no auth

    // HTTP errors (429/5xx) retry a bounded number of times. A LOST CONNECTION (fetch throws -
    // offline, laptop asleep) is different: keep waiting for the network to return, up to the
    // offline budget, so the turn resumes "as if it never paused" when you reopen with Wi-Fi.
    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0;
    let netAttempt = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError"); // Esc: stop now
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(this.cfg.timeoutSeconds * 1000);
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error; // user interrupt, not a network blip
        if (Date.now() >= offlineDeadline) throw new Error(`openai_compat completion failed: ${messageOf(error)}`);
        netAttempt++;
        onDelta?.("(offline - waiting for the network to come back, retrying...)", "reasoning");
        await sleep(this.retryDelayMs(Math.min(netAttempt - 1, 4)), signal);
        continue;
      }
      if (res.ok) {
        // Once the response is OK we commit to it (no mid-stream retry).
        return stream ? await parseStream(res, onDelta!) : parseOpenAIMessage(await res.json());
      }
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

/**
 * Normalize an OpenAI-style response into the provider contract. Throws a clear error
 * (not a raw TypeError) when the endpoint returns an error object / unexpected shape,
 * so the CLI shows the API message and the chat REPL can stay alive.
 */
export function parseOpenAIMessage(data: any): ProviderResponse {
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
  return { content: split.content, tool_calls: toolCalls, usage: data.usage, reasoning };
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
async function parseStream(res: Response, onDelta: DeltaHook): Promise<ProviderResponse> {
  let content = "";
  let reasoning = "";
  let usage: Usage | undefined;
  const acc: { id: string; name: string; argString: string }[] = [];
  const announced = new Set<number>(); // tool calls whose name we've already surfaced
  const think = makeThinkSplitter(
    (s) => { content += s; onDelta(s); },
    (s) => { reasoning += s; onDelta(s, "reasoning"); },
  );

  for await (const line of sseLines(res)) {
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
    if (delta.content) think.push(delta.content); // routes <think>..</think> -> reasoning, rest -> content
    const r = delta.reasoning_content ?? delta.reasoning;
    if (r) {
      reasoning += r;
      onDelta(r, "reasoning");
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      acc[i] ??= { id: "", name: "", argString: "" };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function?.name) {
        acc[i].name = tc.function.name;
        if (!announced.has(i)) { announced.add(i); onDelta(`preparing ${tc.function.name}...`, "reasoning"); } // show activity early
      }
      if (tc.function?.arguments) {
        acc[i].argString += tc.function.arguments;
        onDelta(tc.function.arguments, "tool"); // count a big tool-call's args in the live token meter
      }
    }
  }
  think.flush(); // emit any buffered tail (e.g. trailing content with no closing tag)

  const toolCalls: ToolCall[] = acc.filter(Boolean).map((t) => {
    let args: Record<string, any>;
    try {
      args = t.argString ? JSON.parse(t.argString) : {};
    } catch {
      args = { _raw: t.argString };
    }
    return { id: t.id, name: t.name, arguments: args };
  });
  return { content: content || null, tool_calls: toolCalls, usage, reasoning: reasoning || undefined };
}

/** Yield non-empty lines from an SSE response body. */
async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
