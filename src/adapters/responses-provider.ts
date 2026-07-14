/** Official API-key provider for the standard Responses API (xAI and compatible endpoints). */
import { randomUUID } from "node:crypto";

import type { CompleteOptions, DeltaHook, Provider, ProviderResponse } from "../core/ports.ts";
import { VERSION } from "../shared/version.ts";
import type { NekoConfig } from "./config.ts";
import { parseResponsesStream, toResponsesInput, toResponsesTools } from "./chatgpt-provider.ts";
import { providerScope } from "./provider-scope.ts";
import { clampEffort, effortLevelsFromError, requestEffort, resolveEffort } from "./effort.ts";

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export class ResponsesProvider implements Provider {
  private readonly sessionId = randomUUID();

  constructor(private readonly cfg: NekoConfig) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.cfg.baseUrl) throw new Error("responses provider needs a base_url.");
    if (!this.cfg.model) throw new Error("responses provider needs a model.");
    const key = this.cfg.apiKey;
    if (!key && !this.cfg.isLocalEndpoint) throw new Error("No API key for the responses provider. Set the profile key environment variable or NEKO_API_KEY.");

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/responses`;
    const scope = providerScope("responses", url, this.cfg.model);
    const { instructions, input } = toResponsesInput(messages, scope);
    const responseTools = toResponsesTools(tools ?? []);
    const payload: Record<string, any> = {
      model: this.cfg.model,
      instructions,
      input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: this.sessionId,
    };
    if (this.cfg.maxTokens > 0) payload.max_output_tokens = this.cfg.maxTokens;
    if (responseTools.length) {
      payload.tools = responseTools;
      payload.tool_choice = "auto";
      payload.parallel_tool_calls = true;
    }
    const effort = clampEffort(requestEffort(this.cfg.effort, opts?.reasoningEffort), this.cfg.effortCeiling);
    if (effort) payload.reasoning = { effort };
    if (opts?.responseSchema) {
      payload.text = { format: { type: "json_schema", name: "extraction", schema: opts.responseSchema, strict: true } };
    }

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": `neko-core/${VERSION}`,
    };
    if (key) headers.Authorization = `Bearer ${key}`;

    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0;
    let netAttempt = 0;
    let healedReasoning = false;
    let healedCacheKey = false;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      const idle = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new DOMException("Idle timeout", "TimeoutError")), this.cfg.timeoutSeconds * 1000);
      };
      bumpIdle();

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([idle.signal, signal]) : idle.signal,
        });
      } catch (error) {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal?.aborted) throw error;
        if (Date.now() >= offlineDeadline) throw new Error(`Responses completion failed: ${messageOf(error)}`);
        onDelta?.("(offline - waiting for the network to come back, retrying...)", "reasoning");
        await wait(this.retryDelayMs(Math.min(netAttempt++, 4)), signal);
        continue;
      }

      if (response.ok) {
        let semanticActivity = false;
        try {
          return await parseResponsesStream(
            response,
            (text, kind) => { if (text) semanticActivity = true; onDelta?.(text, kind); },
            (call) => { semanticActivity = true; opts?.onToolCallReady?.(call); },
            scope,
            bumpIdle,
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          if ((idle.signal.aborted || (!semanticActivity && isRetryableStreamFailure(error))) && httpAttempt < this.cfg.maxRetries) {
            httpAttempt++;
            onDelta?.(`(temporary Responses stream failure - retrying, ${httpAttempt}/${this.cfg.maxRetries})`, "reasoning");
            await wait(this.retryDelayMs(httpAttempt - 1), signal);
            continue;
          }
          throw error;
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      }

      if (idleTimer) clearTimeout(idleTimer);
      const body = await response.text().catch(() => "");
      if (payload.reasoning?.effort && response.status >= 400 && response.status < 500 && /reasoning|effort/i.test(body)) {
        if (!healedReasoning) {
          healedReasoning = true;
          const advertised = effortLevelsFromError(body);
          const resolved = resolveEffort(String(payload.reasoning.effort), { efforts: advertised.map((item) => ({ effort: item })) });
          if (advertised.includes(resolved) && resolved !== payload.reasoning.effort) {
            payload.reasoning.effort = resolved;
            onDelta?.(`(effort -> ${resolved}; highest compatible tier advertised by this model)`, "reasoning");
            continue;
          }
        }
        delete payload.reasoning;
        onDelta?.("(this model rejected explicit reasoning effort; retrying with its default)", "reasoning");
        continue;
      }
      if (!healedCacheKey && payload.prompt_cache_key && response.status >= 400 && response.status < 500 && /prompt_cache_key/i.test(body)) {
        healedCacheKey = true;
        delete payload.prompt_cache_key;
        continue;
      }
      if (RETRYABLE.has(response.status) && httpAttempt < this.cfg.maxRetries) {
        httpAttempt++;
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, this.cfg.retryMaxDelaySeconds * 1000)
          : this.retryDelayMs(httpAttempt - 1);
        onDelta?.(`(${response.status === 429 ? "rate limited" : `HTTP ${response.status}`} - retrying in ${Math.round(waitMs / 1000)}s, ${httpAttempt}/${this.cfg.maxRetries})`, "reasoning");
        await wait(waitMs, signal);
        continue;
      }
      throw new Error(`Responses HTTP ${response.status}: ${safeError(body)}`);
    }
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(this.cfg.retryMaxDelaySeconds, this.cfg.retryBaseDelaySeconds * 2 ** attempt) * 1000;
  }
}

function isRetryableStreamFailure(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  return message.includes("stream disconnected")
    || message.includes("internal server error")
    || message.includes("temporarily unavailable")
    || message.includes("idle timeout");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted by user", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted by user", "AbortError"));
    }, { once: true });
  });
}

function safeError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    return (typeof detail === "string" ? detail : JSON.stringify(detail ?? "request failed")).slice(0, 300);
  } catch {
    return body.replace(/[\r\n]+/g, " ").slice(0, 300) || "request failed";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
