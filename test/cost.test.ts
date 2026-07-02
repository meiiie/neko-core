import { expect, test } from "bun:test";

import { CostTracker } from "../src/core/cost.ts";

// CostTracker.add() has three real branches that nothing exercised before:
//  - the `if (!usage) return;` no-op
//  - `total_tokens ?? prompt + completion` (fallback when the provider omits total)
//  - the `!== undefined` guards that decide whether lastPrompt/lastCompletion advance
// These are pure and model-agnostic, so they're exactly the kind of thing that should
// stay locked by a deterministic unit test rather than a live provider call.
test("CostTracker.add handles missing usage, total fallback, and partial fields", () => {
  const t = new CostTracker();

  // no usage -> a strict no-op: counters and per-call snapshots must not move
  t.add(undefined);
  expect(t.calls).toBe(0);
  expect(t.totalTokens).toBe(0);
  expect(t.lastPrompt).toBe(0);
  expect(t.lastCompletion).toBe(0);

  // only prompt_tokens given -> total falls back to prompt+completion; lastCompletion stays put
  t.add({ prompt_tokens: 100 });
  expect(t.calls).toBe(1);
  expect(t.promptTokens).toBe(100);
  expect(t.completionTokens).toBe(0);
  expect(t.totalTokens).toBe(100); // 100 + 0 fallback, NOT undefined/NaN
  expect(t.lastPrompt).toBe(100);
  expect(t.lastCompletion).toBe(0); // guard held: no completion field -> not advanced

  // explicit total_tokens wins over the prompt+completion sum
  t.add({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 999 });
  expect(t.calls).toBe(2);
  expect(t.totalTokens).toBe(1099); // 100 + 999, the explicit value, not 100 + 70
  expect(t.lastPrompt).toBe(50);
  expect(t.lastCompletion).toBe(20);
});

// Cache-read accounting is provider-shape-agnostic: the anthropic adapter reports a flat
// `cached_tokens`, OpenAI-compatible endpoints report `prompt_tokens_details.cached_tokens`
// (forwarded verbatim by providers.ts). Both must land in the same counter so /cost and the
// bench can report a real prefix-cache hit rate.
test("CostTracker counts cached tokens from both usage shapes and reports the hit rate", () => {
  const t = new CostTracker();
  t.add({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80 }); // anthropic-adapter shape
  expect(t.cachedTokens).toBe(80);
  expect(t.lastCached).toBe(80);
  t.add({ prompt_tokens: 200, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 150 } }); // OpenAI shape
  expect(t.cachedTokens).toBe(230);
  expect(t.lastCached).toBe(150);
  t.add({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60 }); // DeepSeek shape
  expect(t.cachedTokens).toBe(290);
  t.add({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: null as any }); // NVIDIA sends null details -> safe 0
  expect(t.cachedTokens).toBe(290);
  t.add({ prompt_tokens: 50, completion_tokens: 5 }); // no cache info -> lastCached resets, total holds
  expect(t.cachedTokens).toBe(290);
  expect(t.lastCached).toBe(0);
  expect(t.summary()).toContain("290 cached"); // surfaced, with a share of prompt tokens
  const noCache = new CostTracker();
  noCache.add({ prompt_tokens: 10, completion_tokens: 1 });
  expect(noCache.summary()).not.toContain("cached"); // silent when the provider reports none
});
