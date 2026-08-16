import { expect, test, describe } from "bun:test";

// Offline verification of the multi-dimensional agent benchmark standard.
// Grounded in CLEAR (arXiv 2511.14136) + tau-bench pass^k (arXiv 2406.12045) +
// RedundancyBench (arXiv 2605.29893). NO live API — pure metric math.
import {
  analyzeTask,
  aggregate,
  redundantCallMask,
  redundantCalls,
  quantile,
  renderScorecard,
  type TaskSpec,
  type TraceEntry,
  type TrialRecord,
} from "../src/adapters/bench-metrics.ts";

function trial(over: Partial<TrialRecord> = {}): TrialRecord {
  return { pass: false, tokens: { in: 1000, cached: 0, out: 500 }, ms: 5000, steps: 3, trace: [], constraints: [], ...over };
}

describe("quantile", () => {
  test("median of odd/even + p95", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 5);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe("redundantCalls (RedundancyBench axis)", () => {
  test("mask identifies the exact redundant event without changing the count", () => {
    const trace: TraceEntry[] = [
      { name: "read_file", path: "a.ts", ok: true },
      { name: "read_file", path: "a.ts", ok: true },
      { name: "edit", path: "a.ts", ok: true },
      { name: "read_file", path: "a.ts", ok: true },
    ];
    expect(redundantCallMask(trace)).toEqual([false, true, false, false]);
    expect(redundantCalls(trace)).toBe(1);
  });

  const rd = (name: string, extra: Partial<TraceEntry> = {}): TraceEntry => ({ name, ok: true, ...extra });

  test("repeat read of same file with no intervening change = redundant", () => {
    const trace = [
      rd("read_file", { path: "a.mjs" }),
      rd("read_file", { path: "a.mjs" }), // redundant
    ];
    expect(redundantCalls(trace)).toBe(1);
  });

  test("re-read AFTER a mutation to that file is NOT redundant", () => {
    const trace = [
      rd("read_file", { path: "a.mjs" }),
      rd("edit", { path: "a.mjs" }),
      rd("read_file", { path: "a.mjs" }), // legitimate: file changed
    ];
    expect(redundantCalls(trace)).toBe(0);
  });

  test("re-read of a DIFFERENT file is not redundant", () => {
    const trace = [rd("read_file", { path: "a.mjs" }), rd("read_file", { path: "b.mjs" })];
    expect(redundantCalls(trace)).toBe(0);
  });

  test("consecutive identical bash = redundant from 2nd", () => {
    const trace = [
      rd("bash", { cmd: "bun t.mjs" }),
      rd("bash", { cmd: "bun t.mjs" }), // redundant
      rd("bash", { cmd: "bun t.mjs" }), // redundant
    ];
    expect(redundantCalls(trace)).toBe(2);
  });

  test("bash repeat after a different call resets the streak", () => {
    const trace = [
      rd("bash", { cmd: "bun t.mjs" }),
      rd("edit", { path: "a.mjs" }),
      rd("bash", { cmd: "bun t.mjs" }), // not redundant: something happened between
    ];
    expect(redundantCalls(trace)).toBe(0);
  });

  test("a read also breaks the consecutive bash streak", () => {
    const trace = [
      rd("bash", { cmd: "bun t.mjs" }),
      rd("read_file", { path: "a.mjs" }),
      rd("bash", { cmd: "bun t.mjs" }),
    ];
    expect(redundantCallMask(trace)).toEqual([false, false, false]);
  });

  test("a malformed bash call also breaks the consecutive streak", () => {
    const trace = [rd("bash", { cmd: "bun t.mjs" }), rd("bash"), rd("bash", { cmd: "bun t.mjs" })];
    expect(redundantCallMask(trace)).toEqual([false, false, false]);
  });

  test("bash invalidates remembered reads because it may mutate the workspace", () => {
    const trace = [
      rd("read_file", { path: "a.mjs" }),
      rd("bash", { cmd: "unknown-script" }),
      rd("read_file", { path: "a.mjs" }),
    ];
    expect(redundantCallMask(trace)).toEqual([false, false, false]);
  });

  test("tool-specific read identities separate queries and read windows", () => {
    const trace = [
      rd("search", { path: "src", pattern: "foo", readScope: "src", readKey: '["search","src","foo"]' }),
      rd("search", { path: "src", pattern: "bar", readScope: "src", readKey: '["search","src","bar"]' }),
      rd("read_file", { path: "a.mjs", readScope: "a.mjs", readKey: '["read_file","a.mjs",1]' }),
      rd("read_file", { path: "a.mjs", readScope: "a.mjs", readKey: '["read_file","a.mjs",50]' }),
    ];
    expect(redundantCallMask(trace)).toEqual([false, false, false, false]);
  });

  test("a workspace-scoped read is invalidated by any file mutation", () => {
    const key = '["search",".","needle"]';
    const trace = [
      rd("search", { pattern: "needle", readScope: ".", readKey: key }),
      rd("edit", { path: "src/a.mjs" }),
      rd("search", { pattern: "needle", readScope: ".", readKey: key }),
    ];
    expect(redundantCalls(trace)).toBe(0);
  });

  test("malformed mutation paths cannot crash telemetry", () => {
    // SAFETY: deliberately malformed fixture (wrong `path` type); telemetry must survive it.
    const malformed: any = { name: "edit", path: 7, ok: false };
    const trace = [
      rd("read_file", { path: "a.mjs" }),
      malformed,
      rd("read_file", { path: "a.mjs" }),
    ];
    expect(redundantCallMask(trace)).toEqual([false, false, true]);
  });

  test("mutations are never flagged (legit iteration)", () => {
    const trace = [
      rd("edit", { path: "a.mjs" }),
      rd("edit", { path: "a.mjs" }),
      rd("edit", { path: "a.mjs" }),
    ];
    expect(redundantCalls(trace)).toBe(0);
  });

  test("ls dir invalidated by a write under that dir", () => {
    const trace = [
      rd("ls", { path: "src/" }),
      rd("write_file", { path: "src/new.mjs" }),
      rd("ls", { path: "src/" }), // legitimate
    ];
    expect(redundantCalls(trace)).toBe(0);
    // without the write, the second ls IS redundant
    const trace2 = [rd("ls", { path: "src/" }), rd("ls", { path: "src/" })];
    expect(redundantCalls(trace2)).toBe(1);
  });
});

describe("analyzeTask (per-task CLEAR dimensions)", () => {
  test("efficacy = pass@1, pass^k strict", () => {
    const spec: TaskSpec = {
      id: "t", trials: 3,
      records: [trial({ pass: true }), trial({ pass: true }), trial({ pass: false })],
    };
    const m = analyzeTask(spec);
    expect(m.efficacy).toBeCloseTo(2 / 3, 5); // pass@1
    expect(m.passAllK).toBe(0); // not all passed
  });

  test("pass^k = 1 only when every trial passes", () => {
    const spec: TaskSpec = { id: "t", trials: 2, records: [trial({ pass: true }), trial({ pass: true })] };
    expect(analyzeTask(spec).passAllK).toBe(1);
  });

  test("infrastructure errors stay in the denominator and invalidate comparison", () => {
    const spec: TaskSpec = {
      id: "infra",
      trials: 3,
      records: [
        trial({ pass: true, outcome: "pass" }),
        trial({ pass: false, outcome: "model_failure" }),
        trial({ pass: false, outcome: "infra_error" }),
      ],
    };
    const metric = analyzeTask(spec);
    expect(metric.efficacy).toBeCloseTo(1 / 3, 5);
    expect(metric.passAllK).toBe(0);
    expect(metric.passes).toBe(1);
    expect(metric.modelFailures).toBe(1);
    expect(metric.infraErrors).toBe(1);
    expect(metric.comparisonValid).toBe(false);
  });

  test("rejects missing records and contradictory explicit outcomes", () => {
    expect(() => analyzeTask({ id: "missing", trials: 2, records: [trial()] })).toThrow("expected 2 trial record");
    expect(() => analyzeTask({ id: "bad", trials: 1, records: [trial({ pass: true, outcome: "infra_error" })] }))
      .toThrow("conflicts");
  });

  test("tokensPerSuccess penalizes failures", () => {
    // both trials spend in1000+out500 = 1500 uncached each => 3000 total; 1 pass => CPS 3000
    const spec: TaskSpec = { id: "t", trials: 2, records: [trial({ pass: true }), trial({ pass: false })] };
    expect(analyzeTask(spec).tokensPerSuccess).toBe(3000);
    // zero passes => CPS = full spend
    const spec0: TaskSpec = { id: "t", trials: 2, records: [trial({ pass: false }), trial({ pass: false })] };
    expect(analyzeTask(spec0).tokensPerSuccess).toBe(3000);
  });

  test("step-efficiency = optimal/meanSteps, capped at 1", () => {
    const spec: TaskSpec = {
      id: "t", trials: 2, optimalSteps: 2,
      records: [trial({ steps: 4 }), trial({ steps: 6 })],
    };
    // mean steps 5, optimal 2 => 0.4
    expect(analyzeTask(spec).stepEfficiency).toBeCloseTo(0.4, 5);
    const over: TaskSpec = { id: "t", trials: 1, optimalSteps: 5, records: [trial({ steps: 3 })] };
    expect(analyzeTask(over).stepEfficiency).toBe(1); // capped
  });

  test("constraint score = satisfied/declared (1 if none declared)", () => {
    const spec: TaskSpec = {
      id: "t", trials: 1,
      records: [trial({ constraints: [{ id: "c1", ok: true }, { id: "c2", ok: false }] })],
    };
    expect(analyzeTask(spec).constraintScore).toBeCloseTo(0.5, 5);
    const none: TaskSpec = { id: "t", trials: 1, records: [trial()] };
    expect(analyzeTask(none).constraintScore).toBe(1);
  });

  test("redundancy rate accumulates across trials", () => {
    const spec: TaskSpec = {
      id: "t", trials: 2,
      records: [
        trial({ trace: [{ name: "read_file", path: "a.mjs", ok: true }, { name: "read_file", path: "a.mjs", ok: true }] }),
        trial({ trace: [{ name: "read_file", path: "a.mjs", ok: true }] }),
      ],
    };
    const m = analyzeTask(spec);
    expect(m.redundantCalls).toBe(1);
    expect(m.totalCalls).toBe(3);
    expect(m.redundancyRate).toBeCloseTo(1 / 3, 5);
  });
});

describe("aggregate (CLEAR + reliability headline)", () => {
  test("reliability drop = pass@1 - pass^k", () => {
    // 2 tasks, each 2 trials. TaskA: pass,pass (pass^k=1, pass@1=1). TaskB: pass,fail (pass^k=0, pass@1=0.5).
    const tasks = [
      analyzeTask({ id: "A", trials: 2, records: [trial({ pass: true }), trial({ pass: true })] }),
      analyzeTask({ id: "B", trials: 2, records: [trial({ pass: true }), trial({ pass: false })] }),
    ];
    const r = aggregate(tasks);
    expect(r.pass1).toBeCloseTo(0.75, 5); // (1 + 0.5)/2
    expect(r.passK).toBeCloseTo(0.5, 5); // (1 + 0)/2
    expect(r.reliabilityDrop).toBeCloseTo(0.25, 5);
  });

  test("aggregate latency and SLA use every scheduled trial", () => {
    const tasks = [
      analyzeTask({ id: "A", trials: 2, records: [trial({ ms: 10000 }), trial({ ms: 12000 })] }), // p95 ~11.9s < 30s
      analyzeTask({ id: "B", trials: 2, records: [trial({ ms: 40000 }), trial({ ms: 50000 })] }), // p95 49.5s > 30s
    ];
    const r = aggregate(tasks, 30000);
    // Aggregate latency and SLA use the four real trial observations, not per-task proxies.
    expect(r.slaCompliance).toBeCloseTo(0.5, 5);
    expect(r.p50Ms).toBe(26000);
    expect(r.p95Ms).toBe(48500);
  });

  test("renderScorecard produces non-empty, dimensioned output", () => {
    const tasks = [
      analyzeTask({ id: "A", trials: 2, records: [trial({ pass: true }), trial({ pass: true })] }),
    ];
    const out = renderScorecard(aggregate(tasks));
    expect(out).toContain("Efficacy");
    expect(out).toContain("Reliability");
    expect(out).toContain("Cost-eff");
    expect(out).toContain("Exec-eff");
    expect(out).toContain("Assurance");
    expect(out).toContain("Latency");
    expect(out).toContain("pass^k");
  });

  test("renderScorecard marks infrastructure-contaminated results not comparable", () => {
    const metric = analyzeTask({
      id: "infra",
      trials: 1,
      records: [trial({ pass: false, outcome: "infra_error" })],
    });
    const out = renderScorecard(aggregate([metric]));
    expect(out).toContain("1 infra");
    expect(out).toContain("NOT COMPARABLE");
  });
});
