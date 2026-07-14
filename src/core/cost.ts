/**
 * Token usage tracking (the "cost-tracker"). We track TOKENS accurately (the universal,
 * model-agnostic metric). Dollar cost needs a per-model price table — left as a future
 * config (any OpenAI-compatible endpoint can price differently), so we don't fake it.
 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Prompt tokens served from the provider's prompt/prefix cache (read hits — the cheap ones).
   * OpenAI-shaped endpoints report this nested (prompt_tokens_details.cached_tokens); the
   * anthropic adapter maps cache_read_input_tokens here. */
  cached_tokens?: number;
  /** Prompt tokens WRITTEN to the cache this call (Anthropic cache_creation_input_tokens). */
  cache_write_tokens?: number;
  /** OpenAI-compat passthrough (providers.ts forwards usage verbatim). */
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek's cache-hit shape (they pioneered context caching with their own field name). */
  prompt_cache_hit_tokens?: number;
}

export class CostTracker {
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  cachedTokens = 0; // prompt tokens served from the provider's prefix cache (cheap + fast)
  cacheWriteTokens = 0; // prompt tokens written to a billed provider cache (not extra context tokens)
  calls = 0;
  lastPrompt = 0; // last call's prompt size ~= current context usage
  lastCompletion = 0; // last call's output size (this turn's reply)
  lastCached = 0; // last call's cache-read size (how much of the context was a cache hit)
  lastCacheWrite = 0;

  add(usage?: Usage): void {
    if (!usage) return;
    const count = (value: unknown): number => {
      const n = Number(value ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const prompt = count(usage.prompt_tokens);
    const completion = count(usage.completion_tokens);
    // A cache read is a subset of input, not extra input. Clamp malformed compat responses so one
    // provider cannot make the cache percentage exceed 100% or poison every later session counter.
    const cached = Math.min(prompt, count(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens));
    const cacheWrite = Math.min(prompt, count(usage.cache_write_tokens));
    const reportedTotal = count(usage.total_tokens);
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += Math.max(reportedTotal, prompt + completion);
    this.cachedTokens += cached;
    this.cacheWriteTokens += cacheWrite;
    if (usage.prompt_tokens !== undefined) this.lastPrompt = prompt;
    if (usage.completion_tokens !== undefined) this.lastCompletion = completion;
    this.lastCached = cached;
    this.lastCacheWrite = cacheWrite;
    this.calls += 1;
  }

  summary(): string {
    const cache = this.cachedTokens > 0 ? `, ${this.cachedTokens} cached (${Math.round((100 * this.cachedTokens) / Math.max(1, this.promptTokens))}% of in)` : "";
    const writes = this.cacheWriteTokens > 0 ? `, ${this.cacheWriteTokens} cache-written` : "";
    const additional = Math.max(0, this.totalTokens - this.promptTokens - this.completionTokens);
    const extra = additional > 0 ? `, ${additional} additional provider-reported tokens (for example reasoning/advisors)` : "";
    return (
      `session cumulative: ${this.totalTokens} tokens over ${this.calls} provider-reported model call(s) ` +
      `(${this.promptTokens} input / ${this.completionTokens} output${cache}${writes}${extra})\n` +
      `last request: ${this.lastPrompt} input / ${this.lastCompletion} output` +
      (this.lastCached > 0 ? ` (${this.lastCached} input cached)` : "") +
      (this.lastCacheWrite > 0 ? ` (${this.lastCacheWrite} input written to cache)` : "") +
      (this.calls > 1 ? "\ninput is re-sent as context on each model call; session cumulative is not one prompt" : "")
    );
  }
}
