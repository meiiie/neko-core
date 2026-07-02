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
}

export class CostTracker {
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  cachedTokens = 0; // prompt tokens served from the provider's prefix cache (cheap + fast)
  calls = 0;
  lastPrompt = 0; // last call's prompt size ~= current context usage
  lastCompletion = 0; // last call's output size (this turn's reply)
  lastCached = 0; // last call's cache-read size (how much of the context was a cache hit)

  add(usage?: Usage): void {
    if (!usage) return;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const cached = usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += usage.total_tokens ?? prompt + completion;
    this.cachedTokens += cached;
    if (usage.prompt_tokens !== undefined) this.lastPrompt = usage.prompt_tokens;
    if (usage.completion_tokens !== undefined) this.lastCompletion = completion;
    this.lastCached = cached;
    this.calls += 1;
  }

  summary(): string {
    const cache = this.cachedTokens > 0 ? `, ${this.cachedTokens} cached (${Math.round((100 * this.cachedTokens) / Math.max(1, this.promptTokens))}% of in)` : "";
    return (
      `tokens: ${this.totalTokens} total (in ${this.promptTokens} / out ${this.completionTokens}${cache}) over ${this.calls} call(s); ` +
      `last turn: ${this.lastPrompt} in / ${this.lastCompletion} out`
    );
  }
}
