import { expect, test } from "bun:test";

import { renderBenchReport } from "../src/adapters/bench.ts";

test("renderBenchReport: pass@1 summary, marks PASS / FAIL / FLAKY per task", () => {
  const out = renderBenchReport({
    model: "openai/gpt-oss-120b",
    effort: "high",
    fingerprint: "sha256:test-fingerprint",
    maxSteps: 25,
    trials: 3,
    results: [
      { id: "fizzbuzz", passes: 3, modelFailures: 0, infraErrors: 0, trials: 3, tokens: 100, inTok: 70, cachedTok: 0, outTok: 30, calls: 3, ms: 1500 }, // PASS (all)
      { id: "bugfix", passes: 0, modelFailures: 3, infraErrors: 0, trials: 3, tokens: 200, inTok: 150, cachedTok: 0, outTok: 50, calls: 6, ms: 3000 },   // FAIL (none)
      { id: "roman", passes: 1, modelFailures: 2, infraErrors: 0, trials: 3, tokens: 300, inTok: 200, cachedTok: 0, outTok: 100, calls: 4, ms: 2000 },   // FLAKY (some)
    ],
    passed: 4,
    modelFailures: 5,
    infraErrors: 0,
    comparisonValid: true,
    total: 9,
    tokens: 600,
    inTok: 420,
    cachedTok: 210,
    outTok: 180,
    calls: 13,
    seconds: 12,
  });
  expect(out).toContain("3 trials/task");
  expect(out).toContain("PASS");
  expect(out).toContain("FAIL");
  expect(out).toContain("FLAKY");
  expect(out).toContain("pass@1: 4/9 (44%)");
  expect(out).toContain("50% cached"); // 210 of 420 in-tokens came from the prefix cache
  expect(out).toContain("comparison: VALID");
  expect(out).toContain("sha256:test-fingerprint");
  expect(out).toContain("maxSteps=25");
});
