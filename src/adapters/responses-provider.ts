/** Official API-key provider for the standard Responses API (xAI and compatible endpoints). */
import { abortable, throwIfAborted } from "../shared/abort.ts";
import { randomUUID } from "node:crypto";

import { ProviderAttemptError, type CompleteOptions, type DeltaHook, type Provider, type ProviderResponse } from "../core/ports.ts";
import { VERSION } from "../shared/version.ts";
import type { NekoConfig } from "./config.ts";
import { parseResponsesStream, toResponsesInput, toResponsesTools } from "./chatgpt-provider.ts";
import { providerScope } from "./provider-scope.ts";
import { clampEffort, effortLevelsFromError, requestEffort, resolveEffort } from "./effort.ts";

import { isText } from "../shared/wire.ts";

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export class ResponsesProvider implements Provider {
  private readonly sessionId = randomUUID();

  constructor(
    private readonly cfg: NekoConfig,
    private readonly resolveApiKey: () => string | Promise<string> = () => cfg.apiKey,
    private readonly resolveHeaders: () => Record<string, string> | Promise<Record<string, string>> = () => ({}),
    private readonly recoverUnauthorized?: (rejectedToken: string) => void | Promise<void>,
  ) {}

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    throwIfAborted(signal);
    if (!this.cfg.baseUrl) throw new Error("responses provider needs a base_url.");
    if (!this.cfg.model) throw new Error("responses provider needs a model.");
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/responses`;
    const scope = providerScope("responses", url, this.cfg.model);
    const { instructions, input } = toResponsesInput(messages, scope);
    const responseTools = toResponsesTools(tools ?? []);
    const payload: any = {
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

    let activeKey = "";
    const requestHeaders = async () => {
      const key = await abortable(Promise.resolve(this.resolveApiKey()), signal);
      if (!key && !this.cfg.isLocalEndpoint) {
        throw new Error("No API key for the responses provider. Set the profile key environment variable or NEKO_API_KEY.");
      }
      throwIfAborted(signal);
      const headers = new Headers(await abortable(Promise.resolve(this.resolveHeaders()), signal));
      headers.set("Accept", "text/event-stream");
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", `neko-core/${VERSION}`);
      if (key) headers.set("Authorization", `Bearer ${key}`);
      activeKey = key;
      return headers;
    };
    let headers = await requestHeaders();

    const offlineDeadline = Date.now() + this.cfg.offlineRetrySeconds * 1000;
    let httpAttempt = 0;
    let netAttempt = 0;
    let healedReasoning = false;
    let healedCacheKey = false;
    let recoveredAuth = false;
    let wireAttempt = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
      wireAttempt++;
      await opts?.onAttempt?.({ type: "attempt_started", attempt: wireAttempt });
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
        const waitMs = this.retryDelayMs(Math.min(netAttempt++, 4));
        await opts?.onAttempt?.({ type: "retry_scheduled", attempt: wireAttempt, reason: "transport_unavailable", delayMs: waitMs });
        onDelta?.("(offline - waiting for the network to come back, retrying...)", "reasoning");
        await wait(waitMs, signal);
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
          // The parser also tracks partial tool arguments before onToolCallReady fires.
          const replaySafe = !semanticActivity && (!(error instanceof ProviderAttemptError) || (error.retryable && error.recovery === "replay"));
          if (replaySafe && (idle.signal.aborted || isRetryableStreamFailure(error)) && httpAttempt < this.cfg.maxRetries) {
            httpAttempt++;
            const waitMs = this.retryDelayMs(httpAttempt - 1);
            await opts?.onAttempt?.({ type: "retry_scheduled", attempt: wireAttempt, reason: idle.signal.aborted ? "stream_timeout" : "stream_interrupted", delayMs: waitMs, maxRetries: this.cfg.maxRetries });
            onDelta?.(`(temporary Responses stream failure - retrying, ${httpAttempt}/${this.cfg.maxRetries})`, "reasoning");
            await wait(waitMs, signal);
            continue;
          }
          throw error;
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      }

      if (idleTimer) clearTimeout(idleTimer);
      const body = await response.text().catch(() => "");
      if (response.status === 401 && this.recoverUnauthorized && !recoveredAuth) {
        recoveredAuth = true;
        await this.recoverUnauthorized(activeKey);
        headers = await requestHeaders();
        continue;
      }
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
        await opts?.onAttempt?.({ type: "retry_scheduled", attempt: wireAttempt, reason: response.status === 429 ? "rate_limited" : "server_error", delayMs: waitMs, maxRetries: this.cfg.maxRetries });
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

function isRetryableStreamFailure(error: any): boolean {
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
    return (isText(detail) ? detail : JSON.stringify(detail ?? "request failed")).slice(0, 300);
  } catch {
    return body.replace(/[\r\n]+/g, " ").slice(0, 300) || "request failed";
  }
}

function messageOf(error: any): string {
  return error instanceof Error ? error.message : String(error);
}
