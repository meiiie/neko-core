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
