/**
 * LLM providers behind one `complete(messages, tools)` contract (provider-agnostic core).
 *
 * One real provider: `openai_compat` — any OpenAI-compatible /chat/completions endpoint
 * (NVIDIA NIM, OpenAI, FPT, or a LOCAL server: llama-server / Ollama). Offline-first needs
 * nothing more than pointing base_url at a local server, so there is no in-process GGUF
 * provider in the TS build (that lives only in the Python reference).
 */
import type { NekoConfig } from "./config.ts";
import type { Usage } from "./cost.ts";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ProviderResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage?: Usage;
}

/** onDelta, when supplied, streams assistant content chunks as they arrive (SSE). */
export type DeltaHook = (text: string) => void;

export interface Provider {
  complete(messages: any[], tools?: any[], onDelta?: DeltaHook): Promise<ProviderResponse>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function getProvider(config: NekoConfig): Provider {
  if (config.provider === "openai_compat") return new OpenAICompatProvider(config);
  throw new Error(
    `Unknown provider '${config.provider}'. Use openai_compat ` +
      "(point base_url at a remote API or a local server such as llama-server / Ollama).",
  );
}

export class OpenAICompatProvider implements Provider {
  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook): Promise<ProviderResponse> {
    if (!this.cfg.baseUrl) {
      throw new Error("openai_compat needs a base_url (set base_url or pick a --profile).");
    }
    if (!this.cfg.model) {
      throw new Error("openai_compat needs a model (set model or pick a --profile).");
    }
    const key = this.cfg.apiKey;
    if (!key) {
      throw new Error(
        "No API key. Set NEKO_API_KEY (or OPENAI_API_KEY / NVIDIA_API_KEY), or add " +
          '"api_key" to ~/.neko-core/config.json (run `neko init-user`).',
      );
    }

    const stream = Boolean(onDelta);
    const payload: Record<string, any> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens,
      stream,
    };
    if (stream) payload.stream_options = { include_usage: true };
    if (tools && tools.length) payload.tools = tools;

    const url = `${this.cfg.baseUrl}/chat/completions`;
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.cfg.timeoutSeconds * 1000),
        });
        if (res.ok) {
          // Once the response is OK we commit to it (no mid-stream retry).
          return stream ? await parseStream(res, onDelta!) : parseOpenAIMessage(await res.json());
        }

        const body = await res.text().catch(() => "");
        if (RETRYABLE_STATUS.has(res.status) && attempt < this.cfg.maxRetries) {
          lastError = new Error(`HTTP ${res.status}`);
          await sleep(this.retryDelayMs(attempt));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      } catch (error) {
        lastError = error;
        // Retry network/timeout errors; do NOT retry our own deliberate HTTP errors.
        const isHttp = error instanceof Error && error.message.startsWith("HTTP ");
        if (isHttp || attempt >= this.cfg.maxRetries) break;
        await sleep(this.retryDelayMs(attempt));
      }
    }
    throw new Error(`openai_compat completion failed: ${messageOf(lastError)}`);
  }

  private retryDelayMs(attempt: number): number {
    const seconds = Math.min(this.cfg.retryMaxDelaySeconds, this.cfg.retryBaseDelaySeconds * 2 ** attempt);
    return seconds * 1000;
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
  return { content: message.content ?? null, tool_calls: toolCalls, usage: data.usage };
}

/** Parse a streamed (SSE) chat completion, calling onDelta for each content chunk. */
async function parseStream(res: Response, onDelta: DeltaHook): Promise<ProviderResponse> {
  let content = "";
  let usage: Usage | undefined;
  const acc: { id: string; name: string; argString: string }[] = [];

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
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      acc[i] ??= { id: "", name: "", argString: "" };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function?.name) acc[i].name = tc.function.name;
      if (tc.function?.arguments) acc[i].argString += tc.function.arguments;
    }
  }

  const toolCalls: ToolCall[] = acc.filter(Boolean).map((t) => {
    let args: Record<string, any>;
    try {
      args = t.argString ? JSON.parse(t.argString) : {};
    } catch {
      args = { _raw: t.argString };
    }
    return { id: t.id, name: t.name, arguments: args };
  });
  return { content: content || null, tool_calls: toolCalls, usage };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
