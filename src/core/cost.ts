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
  lastPrompt = 0; // last call's prompt size ~= current context usage
  lastCompletion = 0; // last call's output size (this turn's reply)

  add(usage?: Usage): void {
    if (!usage) return;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += usage.total_tokens ?? prompt + completion;
    if (usage.prompt_tokens !== undefined) this.lastPrompt = usage.prompt_tokens;
    if (usage.completion_tokens !== undefined) this.lastCompletion = completion;
    this.calls += 1;
  }

  summary(): string {
    return (
      `tokens: ${this.totalTokens} total (in ${this.promptTokens} / out ${this.completionTokens}) over ${this.calls} call(s); ` +
      `last turn: ${this.lastPrompt} in / ${this.lastCompletion} out`
    );
  }
}
