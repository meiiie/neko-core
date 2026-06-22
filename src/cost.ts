/**
 * Token usage tracking (the "cost-tracker"). We track TOKENS accurately (the universal,
 * model-agnostic metric). Dollar cost needs a per-model price table — left as a future
 * config (any OpenAI-compatible endpoint can price differently), so we don't fake it.
 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export class CostTracker {
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  calls = 0;

  add(usage?: Usage): void {
    if (!usage) return;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += usage.total_tokens ?? prompt + completion;
    this.calls += 1;
  }

  summary(): string {
    return `tokens: ${this.totalTokens} (in ${this.promptTokens} / out ${this.completionTokens}) over ${this.calls} call(s)`;
  }
}
