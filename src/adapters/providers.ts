/**
 * LLM providers behind one `complete(messages, tools)` contract (provider-agnostic core).
 *
 * One real provider: `openai_compat` — any OpenAI-compatible /chat/completions endpoint
 * (NVIDIA NIM, OpenAI, FPT, or a LOCAL server: llama-server / Ollama). Offline-first needs
 * nothing more than pointing base_url at a local server, so there is no in-process GGUF
 * provider in the TS build (that lives only in the Python reference).
 */
import { NekoConfig } from "./config.ts";
import type { MoaRef } from "./config.ts";
import type { Usage } from "../core/cost.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";

// Re-export the port types so callers can keep importing them from the provider adapter.
export type { DeltaHook, Provider, ProviderResponse, ToolCall } from "../core/ports.ts";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
/** Clamp a configured reasoning effort down to the endpoint's declared ceiling. Unknown tiers pass through. */
export function clampEffort(effort: string, ceiling: string): string {
  if (!effort || !ceiling) return effort;
  const e = EFFORT_ORDER.indexOf(effort);
  const c = EFFORT_ORDER.indexOf(ceiling);
  if (e === -1 || c === -1) return effort;
  return e > c ? ceiling : effort;
}

export function getProvider(config: NekoConfig): Provider {
  if (config.provider === "moa") return new MoaProvider(config);
  if (config.provider === "openai_compat") return new OpenAICompatProvider(config);
  throw new Error(
    `Unknown provider '${config.provider}'. Use openai_compat ` +
      "(point base_url at a remote API or a local server such as llama-server / Ollama), or moa (mixture-of-agents).",
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
  /** Models whose endpoint rejected `reasoning_effort` (HTTP 400/422). We then omit the field for
   * that model for the rest of the session, so a configured effort degrades gracefully instead of
   * hard-failing — and any value (low..high, 'max', future tiers) still passes through where supported. */
  private readonly effortUnsupported = new Set<string>();
  /** Per-model effort clamp: an endpoint that caps at 'high' makes 'max' -> 'high' (intent preserved). */
  private readonly effortOverride = new Map<string, string>();
  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
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
    // Proactively map a configured effort down to the endpoint's declared ceiling (e.g. 'max' -> 'high'
    // for an endpoint that caps at high), so the intent is honored without a wasted 400 round-trip.
    const effort = clampEffort(this.effortOverride.get(this.cfg.model) ?? this.cfg.effort, this.cfg.effortCeiling);
    if (effort && !this.effortUnsupported.has(this.cfg.model)) payload.reasoning_effort = effort;
    // Schema-constrained structured output: the endpoint fills the given JSON Schema (constrained
    // decoding where supported). Self-healed below if the endpoint rejects it.
    if (opts?.responseSchema) {
      payload.response_format = { type: "json_schema", json_schema: { name: "extraction", schema: opts.responseSchema } };
    }

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
      // Self-heal: some endpoints reject `reasoning_effort` (the field, or a value they don't accept -
      // e.g. NVIDIA's vLLM takes only low/medium/high, not 'max'). If that's the sole problem, drop the
      // field once and retry, so a configured effort works where supported and degrades where it isn't.
      if ((res.status === 400 || res.status === 422) && payload.reasoning_effort !== undefined && /reasoning_effort/i.test(body)) {
        // The field is supported but this VALUE isn't (e.g. 'max' on an endpoint that caps at 'high').
        // Clamp to the highest accepted tier first, so high-effort intent survives instead of vanishing.
        if (payload.reasoning_effort !== "high" && /high/i.test(body) && /(low|medium)/i.test(body)) {
          this.effortOverride.set(this.cfg.model, "high");
          payload.reasoning_effort = "high";
          onDelta?.("(endpoint accepts only low/medium/high - retrying with 'high')", "reasoning");
          continue;
        }
        this.effortUnsupported.add(this.cfg.model);
        delete payload.reasoning_effort;
        onDelta?.("(this endpoint rejected reasoning_effort - retrying without it)", "reasoning");
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
    // 1. References analyze IN PARALLEL, WITHOUT tools (they advise; they don't act). A failing
    //    reference degrades to a noted gap instead of sinking the turn.
    const refs = await Promise.all(this.references.map((r) =>
      r.provider.complete(messages, undefined, undefined, signal)
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
