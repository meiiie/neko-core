import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// End-to-end offline smoke: proves runEval's full pipeline (Agent loop -> onEvent trace capture ->
// constraint `keep` resolution -> CLEAR metric aggregation -> scorecard render) with NO live API, via a
// scripted provider. The pure metric math is separately covered in bench-metrics.test.ts.
import {
  __appendEvalLogForTest,
  __applyRawBenchFilesForTest,
  __benchmarkModuleSourceIsPureForTest,
  __benchmarkRunFingerprintForTest,
  __buildEvalArtifactRecordForTest,
  __runBenchJsPassesForTest,
  __runBoundedBenchProcessForTest,
  __runBenchJsForTest,
  __runHiddenBenchJsForTest,
  __traceFromCallForTest,
  __validFizzBuzzOutputForTest,
  BenchInfrastructureError,
  EVAL_ARTIFACT_MAX_BYTES,
  EVAL_TRAJECTORY_SCHEMA,
  HARD_TASKS,
  renderEvalReport,
  runBench,
  runEval,
  runHarnessLift,
  type BenchTask,
  type EvalArtifactRecord,
  type EvalReport,
} from "../src/adapters/bench.ts";
import { redundantCallMask } from "../src/adapters/bench-metrics.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import type { Provider } from "../src/core/ports.ts";
import { sandboxActive } from "../src/core/sandbox.ts";

import { isText } from "../src/shared/wire.ts";

function requiredOracleSandboxAvailable(
  live = sandboxActive(),
  required = process.env.NEKO_REQUIRE_SANDBOX_TESTS === "1",
): boolean {
  if (!live && required) {
    throw new Error("NEKO_REQUIRE_SANDBOX_TESTS=1 but no live OS sandbox is available");
  }
  // The ordinary suite is deterministic and portable. Live oracle execution belongs to the explicit
  // required lane in CI/provisioned hosts, not to whichever developer machine happens to expose an
  // alpha/beta primitive today (that made the same full suite take 7-30 minutes and intermittently red).
  return required && live;
}

/** The ordinary cross-platform suite treats a missing or temporarily unhealthy local sandbox as
 * optional infrastructure; the dedicated CI/live lane sets NEKO_REQUIRE_SANDBOX_TESTS=1 and must
 * rethrow the same failure. Production verifier behavior remains fail-closed in both cases. */
async function withOptionalOracleSandbox(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BenchInfrastructureError && process.env.NEKO_REQUIRE_SANDBOX_TESTS !== "1") return;
    throw error;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function benchConfig(maxSteps = 10): NekoConfig {
  return new NekoConfig({
    provider: "openai_compat",
    model: "fake-model",
    reasoning_effort: "off",
    max_steps: maxSteps,
    adaptive_effort: false,
    sandbox: false,
  }, null, {}, "");
}

function syntheticEvalReport(): EvalReport {
  return {
    model: "fake-model",
    effort: "off",
    suite: "pure-artifact-test",
    fingerprint: `sha256:${"a".repeat(64)}`,
    maxSteps: 1,
    trials: 1,
    dim: {
      tasks: [{
        id: "PRIVATE_METRIC_SEED",
        trials: 1,
        passes: 1,
        modelFailures: 0,
        infraErrors: 0,
        comparisonValid: true,
        efficacy: 1,
        passAllK: 1,
        meanTokens: 2,
        tokensPerSuccess: 2,
        cna: 500,
        redundantCalls: 0,
        totalCalls: 1,
        redundancyRate: 0,
        stepEfficiency: 1,
        constraintScore: 1,
        p50Ms: 1,
        p95Ms: 1,
        latenciesMs: [1],
      }],
      trials: 1,
      nTasks: 1,
      totalTrials: 1,
      passes: 1,
      modelFailures: 0,
      infraErrors: 0,
      comparisonValid: true,
      pass1: 1,
      passK: 1,
      reliabilityDrop: 0,
      tokensPerSuccess: 2,
      cna: 500,
      redundancyRate: 0,
      stepEfficiency: 1,
      constraintScore: 1,
      p50Ms: 1,
      p95Ms: 1,
      slaCompliance: 1,
      slaMs: 30_000,
    },
    trajectorySchema: EVAL_TRAJECTORY_SCHEMA,
    trajectories: [{
      taskId: "PRIVATE_TASK_SEED",
      taskRef: "t1",
      trial: 1,
      outcome: "pass",
      failureSignals: [],
      verifier: "passed",
      completionGate: "passed",
      ms: 1,
      tokens: { in: 1, cached: 0, out: 1 },
      modelCalls: 1,
      toolCalls: 1,
      redundantCalls: 0,
      hitMaxSteps: false,
      failedConstraints: [],
      omittedFailedConstraints: 0,
      events: [{ round: 1, tool: "read_file", targetRef: "p1", result: "productive", redundant: false }],
      omittedEvents: 0,
    }],
    omittedTrajectories: 0,
    artifactPersisted: false,
  };
}

// A one-task fix: the provider edits calc.mjs correctly, but inserts ONE redundant re-read first, so the
// RedundancyBench axis has a real signal in the captured trace.
function makeTask(): BenchTask {
  return {
    id: "smoke-add",
    files: {
      "calc.mjs": "export function add(a, b) { return a - b; }\n",
      "test.mjs": "import assert from 'node:assert';\nimport { add } from './calc.mjs';\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n",
    },
    prompt: "Fix calc.mjs so `bun test.mjs` passes. Do not modify test.mjs.",
    verify: (d: string) => readFileSync(join(d, "calc.mjs"), "utf8").includes("a + b"),
    optimalSteps: 3,
    constraints: [{ id: "keep-test.mjs", keep: "test.mjs" }],
  };
}

test("benchmark fingerprint binds public execution identity without hashing secrets", () => {
  const cfg = benchConfig();
  const task = makeTask();
  const environment = {
    sourceDigest: "a".repeat(64),
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    platform: "linux" as NodeJS.Platform,
    arch: "x64",
    sandboxKind: "bwrap" as const,
    sandboxLive: true,
    runtimeKind: "bun" as const,
    runtimeVersion: "1.4.0",
  };
  const same = __benchmarkRunFingerprintForTest(cfg, [task], 25, environment);
  expect(__benchmarkRunFingerprintForTest(cfg, [task], 25, environment)).toBe(same);
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const reorderedEnvironment = Object.fromEntries(Object.entries(environment).reverse()) as typeof environment;
  expect(__benchmarkRunFingerprintForTest(cfg, [task], 25, reorderedEnvironment)).toBe(same);
  expect(__benchmarkRunFingerprintForTest(cfg, [{ ...task, files: { ...task.files, "calc.mjs": "changed\n" } }], 25, environment)).not.toBe(same);
  expect(__benchmarkRunFingerprintForTest(cfg, [task], 24, environment)).not.toBe(same);
  expect(__benchmarkRunFingerprintForTest(cfg, [task], 25, { ...environment, sourceDigest: "b".repeat(64) })).not.toBe(same);

  for (const changed of [
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    { ...environment, platform: "darwin" as NodeJS.Platform },
    { ...environment, arch: "arm64" },
    { ...environment, sandboxKind: "sandbox-exec" as const },
    { ...environment, sandboxLive: false },
    { ...environment, runtimeKind: "node" as const },
    { ...environment, runtimeVersion: "1.4.1" },
  ]) {
    expect(__benchmarkRunFingerprintForTest(cfg, [task], 25, changed)).not.toBe(same);
  }

  const endpointA = new NekoConfig({
    ...cfg.data, base_url: "https://api.example/v1/", api_key: "secret-a", headers: { Authorization: "Bearer secret-a" },
  }, "profile-a", {}, "secret-a");
  const endpointANewSecret = new NekoConfig({
    ...cfg.data, base_url: "https://api.example/v1", api_key: "secret-b", headers: { Authorization: "Bearer secret-b" },
  }, "profile-a", {}, "secret-b");
  const endpointB = new NekoConfig({ ...cfg.data, base_url: "https://other.example/v1" }, "profile-a", {}, "secret-a");
  const profileB = new NekoConfig({ ...cfg.data, base_url: "https://api.example/v1" }, "profile-b", {}, "secret-a");
  const endpointHash = __benchmarkRunFingerprintForTest(endpointA, [task], 25, environment);
  expect(__benchmarkRunFingerprintForTest(endpointANewSecret, [task], 25, environment)).toBe(endpointHash);
  expect(__benchmarkRunFingerprintForTest(endpointB, [task], 25, environment)).not.toBe(endpointHash);
  expect(__benchmarkRunFingerprintForTest(profileB, [task], 25, environment)).not.toBe(endpointHash);
  expect(__benchmarkRunFingerprintForTest(cfg, [task], 25, environment, { slaMs: 30_000 })).not.toBe(
    __benchmarkRunFingerprintForTest(cfg, [task], 25, environment, { slaMs: 60_000 }),
  );
  expect(__benchmarkRunFingerprintForTest(cfg, [{ ...task, manifestIdentity: "fixture-v1" }], 25, environment)).not.toBe(
    __benchmarkRunFingerprintForTest(cfg, [{ ...task, manifestIdentity: "fixture-v2" }], 25, environment),
  );
});

test("trace telemetry filters malformed args and separates read identities", () => {
  const searchFoo = __traceFromCallForTest({
    name: "search",
    arguments: { path: "src/./core", pattern: "foo", context: 1 },
  }, "one match");
  const searchBar = __traceFromCallForTest({
    name: "search",
    arguments: { path: "src/core", pattern: "bar", context: 1 },
  }, "one match");
  const firstPage = __traceFromCallForTest({
    name: "read_file",
    arguments: { path: "src/core/agent.ts", offset: 1, limit: 20 },
  }, "page one");
  const secondPage = __traceFromCallForTest({
    name: "read_file",
    arguments: { path: "src/core/agent.ts", offset: 21, limit: 20 },
  }, "page two");
  const malformed = __traceFromCallForTest({
    name: "edit",
    arguments: { path: 7, pattern: { private: true }, command: Symbol("private") },
  }, "Error: invalid args");
  const fractionalPage = __traceFromCallForTest({
    name: "read_file",
    arguments: { path: "src/core/agent.ts", offset: 0.5 },
  }, "first page");
  const defaultPage = __traceFromCallForTest({
    name: "read_file",
    arguments: { path: "src/core/agent.ts", offset: 1 },
  }, "first page");
  const invalidScope = __traceFromCallForTest({
    name: "search",
    arguments: { path: 7, pattern: "needle" },
  }, "Error: invalid args");
  const falseyInvalidScope = __traceFromCallForTest({
    name: "search",
    arguments: { path: 0, pattern: "needle" },
  }, "Error: invalid args");

  expect(searchFoo.path).toBe(searchBar.path);
  expect(searchFoo.readKey).not.toBe(searchBar.readKey);
  expect(firstPage.readKey).not.toBe(secondPage.readKey);
  expect(fractionalPage.readKey).toBe(defaultPage.readKey);
  expect(invalidScope).toMatchObject({ path: undefined, readKey: undefined, readScope: undefined });
  expect(falseyInvalidScope).toMatchObject({ path: undefined, readKey: undefined, readScope: undefined });
  expect(malformed).toMatchObject({ name: "edit", path: undefined, pattern: undefined, cmd: undefined });
  expect(() => redundantCallMask([firstPage, malformed, firstPage])).not.toThrow();
  for (const argumentsJson of ["null", "7", "[]"]) {
    expect(() => __traceFromCallForTest({ name: "read_file", arguments: argumentsJson }, "empty")).not.toThrow();
  }
});

test("runEval rejects unsafe trial and step bounds before creating a provider", async () => {
  let providers = 0;
  const providerFactory = (): Provider => {
    providers++;
    return { complete: async () => ({ content: "done", tool_calls: [] }) };
  };
  const cfg = benchConfig();
  await expect(runEval(cfg, { tasks: [], trials: Number.POSITIVE_INFINITY, providerFactory })).rejects.toThrow("trials must be");
  await expect(runEval(cfg, { tasks: [], trials: 1.5, providerFactory })).rejects.toThrow("trials must be");
  await expect(runEval(cfg, { tasks: [], maxSteps: 0, providerFactory })).rejects.toThrow("maxSteps must be");
  await expect(runEval(cfg, { tasks: [], maxSteps: 513, providerFactory })).rejects.toThrow("maxSteps must be");
  expect(providers).toBe(0);
});

test("eval artifact JSONL writes the exact versioned envelope", () => {
  const artifact = __buildEvalArtifactRecordForTest(syntheticEvalReport());
  const logHome = mkdtempSync(join(tmpdir(), "neko-eval-log-test-"));
  try {
    expect(__appendEvalLogForTest(artifact, logHome)).toBe(true);
    const lines = readFileSync(join(logHome, ".neko-core", "bench-log.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(artifact);
  } finally {
    rmSync(logHome, { recursive: true, force: true });
  }
});

test("eval artifact fitter enforces 4 MiB with exact omission accounting", () => {
  const report = syntheticEvalReport();
  const trajectoryCount = 512;
  const taskCount = 512;
  const oversized = __buildEvalArtifactRecordForTest({
    ...report,
    model: "PRIVATE_MODEL_SENTINEL".repeat(20),
    trajectories: Array.from({ length: trajectoryCount }, (_, index) => ({
      ...report.trajectories[0],
      taskId: `PRIVATE_TASK_SENTINEL_${index}`,
      taskRef: `t${index + 1}`,
      events: Array.from({ length: 128 }, (_unused, eventIndex) => ({
        round: eventIndex + 1,
        tool: "read_file",
        targetRef: `p${eventIndex + 1}`,
        result: "productive" as const,
        redundant: false,
      })),
    })),
    dim: {
      ...report.dim,
      tasks: Array.from({ length: taskCount }, (_, index) => ({
        ...report.dim.tasks[0],
        id: `PRIVATE_METRIC_SENTINEL_${index}`,
        latenciesMs: Array.from({ length: 64 }, (_unused, latencyIndex) => latencyIndex),
      })),
    },
  });
  const oversizedJson = JSON.stringify(oversized);
  expect(Buffer.byteLength(oversizedJson, "utf8")).toBeLessThanOrEqual(EVAL_ARTIFACT_MAX_BYTES);
  expect(oversized.omittedTrajectories + oversized.dim.omittedTasks).toBeGreaterThan(0);
  expect(oversized.omittedTrajectories).toBe(512 - oversized.trajectories.length);
  expect(oversized.dim.omittedTasks).toBe(512 - oversized.dim.tasks.length);
  expect(oversizedJson).not.toContain("PRIVATE_TASK_SENTINEL");
  expect(oversizedJson).not.toContain("PRIVATE_METRIC_SENTINEL");
});

/** A scripted provider: turn 1 redundant read, turn 2 redundant read, turn 3 edit (fix), turn 4 bash, turn 5 done. */
function scriptedProvider(): Provider {
  let turn = 0;
  const fixed = "export function add(a, b) { return a + b; }\n";
  const script = [
    { content: null, tool_calls: [{ id: "r1", name: "read_file", arguments: { path: "calc.mjs" } }] },
    { content: null, tool_calls: [{ id: "r2", name: "read_file", arguments: { path: "calc.mjs" } }] }, // redundant
    { content: null, tool_calls: [{ id: "e1", name: "edit", arguments: { path: "calc.mjs", old_string: "return a - b;", new_string: "return a + b;" } }] },
    { content: null, tool_calls: [{ id: "b1", name: "bash", arguments: { command: "bun test.mjs" } }] },
    { content: "done", tool_calls: [] },
  ];
  void fixed;
  return {
    complete: async (messages: any[]) => {
      // Fresh trial = no tool results yet -> replay the script from the start.
      if (!messages.some((m) => m.role === "tool")) turn = 0;
      const index = Math.min(turn, script.length - 1);
      const res = script[index];
      turn++;
      // The final response deliberately omits optional usage. The trajectory must still count the
      // fifth provider round, while the first four calls retain non-zero token accounting.
      return index === script.length - 1
        ? res
        : { ...res, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    },
  };
}

test("FizzBuzz oracle validates every line, not only four sampled indices", () => {
  const exact = Array.from({ length: 100 }, (_, index) => {
    const n = index + 1;
    return n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Fizz" : n % 5 === 0 ? "Buzz" : String(n);
  });
  const sampledFalseGreen = Array.from({ length: 100 }, () => "arbitrary");
  sampledFalseGreen[2] = "Fizz";
  sampledFalseGreen[4] = "Buzz";
  sampledFalseGreen[14] = "FizzBuzz";
  sampledFalseGreen[99] = "Buzz";

  expect(__validFizzBuzzOutputForTest(exact.join("\n"))).toBe(true);
  expect(__validFizzBuzzOutputForTest(sampledFalseGreen.join("\n"))).toBe(false);
});

test.skipIf(!requiredOracleSandboxAvailable())("built-in verifier rejects an implementation that exits successfully before assertions", () => withOptionalOracleSandbox(async () => {
  const task = HARD_TASKS.find((candidate) => candidate.id === "layered-bug")!;
  const root = mkdtempSync(join(tmpdir(), "neko-bench-early-exit-"));
  try {
    for (const [name, content] of Object.entries(task.files)) writeFileSync(join(root, name), content, "utf8");
    // Avoid every literal rejected by the purity lint. The verifier itself, not a lexical filter,
    // must own the completion signal or an implementation can exit before the assertions run.
    writeFileSync(
      join(root, "parse.mjs"),
      [
        "const make = (() => {}).constructor;",
        "const runtime = make('return pro' + 'cess')();",
        "runtime.stdout.write('ok\\n', () => runtime.exit(0));",
        "export function parse() { throw new Error('assertions never ran'); }",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(await task.verify(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}), 120_000);

test("runEval end-to-end (scripted provider): trace + constraints + scorecard, no live API", async () => {
  if (!requiredOracleSandboxAvailable()) return;
  // Minimal cfg: provider is injected so only maxSteps/flags matter.
  const cfg = benchConfig();
  let persisted: EvalArtifactRecord | undefined;
  const report = await runEval(cfg, {
    trials: 2,
    tasks: [makeTask()],
    suite: "smoke",
    providerFactory: scriptedProvider,
    artifactSink: (record) => { persisted = record; return true; },
  });
  expect(report.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(report.maxSteps).toBe(25);
  expect(report.artifactPersisted).toBe(true);
  expect(report.trajectorySchema).toBe("neko.eval.trajectory.v1");
  expect(report.trajectories).toHaveLength(2);
  expect(report.omittedTrajectories).toBe(0);
  for (const trajectory of report.trajectories) {
    expect(trajectory.taskRef).toBe("t1");
    expect(trajectory.outcome).toBe("pass");
    expect(trajectory.failureSignals).toEqual([]);
    expect(trajectory.verifier).toBe("passed");
    expect(trajectory.completionGate).toBe("passed");
    expect(trajectory.modelCalls).toBe(5);
    expect(trajectory.toolCalls).toBe(4);
    expect(trajectory.redundantCalls).toBe(1);
    expect(trajectory.events.map((event) => event.round)).toEqual([1, 2, 3, 4]);
    expect(trajectory.events.map((event) => event.tool)).toEqual(["read_file", "read_file", "edit", "bash"]);
    expect(trajectory.events.map((event) => event.redundant)).toEqual([false, true, false, false]);
    expect(trajectory.events.slice(0, 3).map((event) => event.targetRef)).toEqual(["p1", "p1", "p1"]);
    expect(trajectory.events[3].targetRef).toBe("c1");
  }
  expect(persisted).toBeDefined();
  expect(persisted).toMatchObject({ kind: "eval", schema: "neko.eval.trajectory.v1" });
  expect(persisted!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(persisted!.trajectories.every((trajectory) => trajectory.taskRef === "t1")).toBe(true);
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect((persisted!.dim.tasks[0] as any).id).toBeUndefined();
  const safeArtifact = JSON.stringify(persisted);
  expect(safeArtifact).not.toContain("calc.mjs");
  expect(safeArtifact).not.toContain("bun test.mjs");
  expect(safeArtifact).not.toContain("return a - b");
  // Efficacy + reliability: both trials solved by the script => pass@1 = 1, pass^k = 1 (no collapse).
  expect(report.dim.pass1).toBe(1);
  expect(report.dim.passK).toBe(1);
  expect(report.dim.reliabilityDrop).toBe(0); // perfectly consistent

  // Assurance: test.mjs kept byte-identical (the edit touched calc.mjs only) => constraint honored.
  expect(report.dim.constraintScore).toBe(1);

  // Execution efficiency: the script does 2 redundant reads of calc.mjs with no intervening edit.
  // 2 trials × 4 tool-calls = 8 calls; 2 redundant (one per trial) => redundancyRate = 0.25.
  expect(report.dim.redundancyRate).toBeCloseTo(0.25, 5);
  expect(report.dim.stepEfficiency).toBeCloseTo(3 / 4, 5);

  // Cost-efficiency: 2 successful trials, each ~120 tokens => tokensPerSuccess = 120.
  expect(report.dim.tokensPerSuccess).toBeGreaterThan(0);

  // Scorecard renders all CLEAR dimensions.
  const out = renderEvalReport(report);
  expect(out).toContain("Efficacy");
  expect(out).toContain("Reliability");
  expect(out).toContain("Cost-eff");
  expect(out).toContain("Exec-eff");
  expect(out).toContain("Assurance");
  expect(out).toContain("Latency");
  expect(out).toContain(report.fingerprint);
  expect(out).toContain("persisted");
  expect(out).not.toContain("~/.neko-core/bench-log.jsonl");
  // per-task line shows the redundancy signal
  expect(out).toMatch(/redun=\s*25%/);
}, 30000);

test("runEval bounds structural trajectory events without losing full call counts", async () => {
  const task: BenchTask = {
    id: "PRIVATE_TASK_ID_SENTINEL",
    files: { "a.txt": "safe\n" },
    prompt: "Inspect a.txt and report when done.",
    verify: () => true,
  };
  const providerFactory = (): Provider => {
    let round = 0;
    return {
      complete: async () => {
        if (round++ === 0) {
          return {
            content: null,
            tool_calls: Array.from({ length: 130 }, (_, index) => ({
              id: `r${index}`,
              name: index === 0 ? "PRIVATE_TOOL_SENTINEL" : "read_file",
              arguments: { path: index === 0 ? "PRIVATE_PATH_SENTINEL" : "a.txt" },
            })),
          };
        }
        return { content: "done", tool_calls: [] };
      },
    };
  };

  const progress: string[] = [];
  let rejectedArtifact: EvalArtifactRecord | undefined;
  const report = await runEval(
    benchConfig(),
    {
      trials: 1,
      tasks: [task],
      suite: "s".repeat(1_000),
      maxSteps: 1,
      providerFactory,
      artifactSink: async (record) => { rejectedArtifact = record; return false; },
    },
    (line) => progress.push(line),
  );
  const trajectory = report.trajectories[0];
  expect(report.artifactPersisted).toBe(false);
  expect(progress.some((line) => line.includes("bounded eval trajectory artifact could not be persisted"))).toBe(true);
  expect(trajectory.toolCalls).toBe(130);
  expect(trajectory.modelCalls).toBe(2); // one tool round plus the no-usage max-step wrap
  expect(trajectory.hitMaxSteps).toBe(true);
  expect(trajectory.events).toHaveLength(128);
  expect(trajectory.omittedEvents).toBe(2);
  expect(trajectory.events[0]).toMatchObject({ tool: "<unknown>", targetRef: "p1", result: "failed" });
  expect(trajectory.events.slice(1).every((event) => event.targetRef === "p2")).toBe(true);
  const serialized = JSON.stringify(trajectory);
  expect(serialized).not.toContain("PRIVATE_TOOL_SENTINEL");
  expect(serialized).not.toContain("PRIVATE_PATH_SENTINEL");
  expect(serialized).not.toContain("a.txt");
  expect(rejectedArtifact).toBeDefined();
  const rejectedJson = JSON.stringify(rejectedArtifact);
  expect(rejectedJson).not.toContain("PRIVATE_TASK_ID_SENTINEL");
  expect(rejectedJson).not.toContain("PRIVATE_TOOL_SENTINEL");
  expect(rejectedJson).not.toContain("PRIVATE_PATH_SENTINEL");
  expect(rejectedJson).not.toContain("a.txt");
  expect(Buffer.byteLength(rejectedJson, "utf8")).toBeLessThanOrEqual(EVAL_ARTIFACT_MAX_BYTES);
  expect(rejectedArtifact!.dim.tasks[0].taskRef).toBe("t1");
  expect(rejectedArtifact!.suite).toHaveLength(160);
}, 30000);

test("runEval composes the production exact-file turn surface instead of a bare benchmark agent", async () => {
  let firstTools: any[] | undefined;
  let firstSystem = "";
  const providerFactory = (): Provider => ({
    complete: async (messages, tools) => {
      if (!firstTools) {
        firstTools = tools ?? [];
        firstSystem = messages
          .filter((message: any) => message.role === "system")
          .map((message: any) => String(message.content ?? ""))
          .join("\n");
      }
      return {
        content: "No change needed for this composition probe.",
        tool_calls: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  });
  const task: BenchTask = {
    id: "production-turn-surface",
    files: { "src/target.ts": "export const answer = 41;\n" },
    prompt: "Fix the bug in src/target.ts so all existing tests pass. Make the smallest correct change. Run the tests. Do not change tests or add dependencies.",
    verify: () => true,
  };

  await runEval(benchConfig(), { trials: 1, tasks: [task], suite: "composition", providerFactory });

  expect(firstTools?.map((schema) => schema.function.name)).toEqual(["read_file", "edit", "bash"]);
  expect(firstSystem).toContain("# NEKO DYNAMIC-TOOL RUNTIME");
  expect(firstSystem).toContain("Neko skill dynamic tool: unavailable in this request");
  expect(firstSystem).not.toContain("Available subagent types for the `task` tool");
  expect(firstSystem).not.toContain("# NEKO SKILL CATALOG");
  expect(firstSystem).not.toContain("Learned workflows (reusable procedures from past tasks)");
  expect(firstSystem).not.toContain("Your operating playbook index");
  expect(firstSystem).toContain("Benchmark implementation modules must use relative imports only");
}, 30000);

test("benchmark trials exclude host-global identity, memory, and executable hooks", async () => {
  const hostHome = mkdtempSync(join(tmpdir(), "neko-bench-host-home-"));
  const nekoDir = join(hostHome, ".neko-core");
  mkdirSync(join(nekoDir, "memory"), { recursive: true });
  writeFileSync(join(nekoDir, "NEKO.md"), "HOST_IDENTITY_SENTINEL\n", "utf8");
  writeFileSync(join(nekoDir, "memory", "user.md"), "- HOST_MEMORY_SENTINEL\n", "utf8");
  const cfg = benchConfig();
  cfg.resolvedHome = hostHome;
  cfg.data.hooks = { pre_tool_use: "exit 97" };
  let turn = 0;
  let system = "";
  let observation = "";
  const providerFactory = (): Provider => ({
    complete: async (messages) => {
      system = messages.filter((message: any) => message.role === "system").map((message: any) => String(message.content ?? "")).join("\n");
      observation = messages.filter((message: any) => message.role === "tool").map((message: any) => String(message.content ?? "")).join("\n");
      if (turn++ === 0) {
        return {
          content: null,
          tool_calls: [{ id: "read", name: "read_file", arguments: { path: "SPEC.md" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      }
      return { content: "done", tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    },
  });
  const task: BenchTask = {
    id: "isolated-home",
    files: { "SPEC.md": "TRIAL_CONTEXT_ONLY\n" },
    prompt: "Read SPEC.md and report its requirement.",
    verify: () => true,
  };
  try {
    await runEval(cfg, { trials: 1, tasks: [task], suite: "composition", providerFactory });
    expect(system).not.toContain("HOST_IDENTITY_SENTINEL");
    expect(system).not.toContain("HOST_MEMORY_SENTINEL");
    expect(observation).toContain("TRIAL_CONTEXT_ONLY");
    expect(observation).not.toContain("pre_tool_use hook blocked");
  } finally {
    rmSync(hostHome, { recursive: true, force: true });
  }
}, 30000);

test("generic coding evals use a fixed local-only tool ceiling", async () => {
  let firstTools: string[] | undefined;
  let bashDescription = "";
  let firstSystem = "";
  const providerFactory = (): Provider => ({
    complete: async (messages, tools) => {
      if (!firstTools) {
        firstTools = (tools ?? []).map((schema) => schema.function.name);
        bashDescription = (tools ?? []).find((schema) => schema.function.name === "bash")?.function.description ?? "";
        firstSystem = messages
          .filter((message: any) => message.role === "system")
          .map((message: any) => String(message.content ?? ""))
          .join("\n");
      }
      return {
        content: "No change needed for this tool-ceiling probe.",
        tool_calls: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  });
  const task: BenchTask = {
    id: "local-tool-ceiling",
    files: { "SPEC.md": "Inspect several modules.\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
    prompt: "Diagnose the cross-module regression described in SPEC.md, repair the implementation, and run the tests.",
    verify: () => true,
  };

  await runEval(benchConfig(), { trials: 1, tasks: [task], suite: "composition", providerFactory });

  expect(firstTools).toEqual([
    "read_file", "search", "glob", "ls", "write_file",
    "edit", "multi_edit", "bash", "todo_write",
  ]);
  expect(firstTools).not.toContain("skill");
  expect(firstTools).not.toContain("task");
  expect(firstTools).not.toContain("web_fetch");
  expect(firstTools).not.toContain("computer");
  expect(bashDescription).toContain("foreground validators only");
  expect(firstSystem).not.toContain("# NEKO SKILL CATALOG");
  expect(firstSystem).not.toContain("Available subagent types for the `task` tool");
}, 30000);

test("benchmark read tools cannot inspect host files outside the trial root", async () => {
  const outsideRoot = mkdtempSync(join(tmpdir(), "neko-bench-host-read-"));
  const outside = join(outsideRoot, "hidden.txt");
  const secret = "HOST_ORACLE_SENTINEL";
  let turn = 0;
  let observation = "";
  const probes = [
    { id: "outside-read", name: "read_file", arguments: { path: outside } },
    { id: "outside-search", name: "search", arguments: { pattern: secret, path: outsideRoot } },
    { id: "outside-glob", name: "glob", arguments: { pattern: "**/*", path: outsideRoot } },
    { id: "outside-ls", name: "ls", arguments: { path: outsideRoot } },
  ];
  writeFileSync(outside, secret, "utf8");
  const providerFactory = (): Provider => ({
    complete: async (messages) => {
      observation = messages
        .filter((message: any) => message.role === "tool")
        .map((message: any) => String(message.content ?? ""))
        .join("\n");
      if (turn < probes.length) {
        const call = probes[turn++];
        return {
          content: null,
          tool_calls: [call],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      }
      return {
        content: "The host path is outside this benchmark fixture.",
        tool_calls: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
    },
  });
  const task: BenchTask = {
    id: "host-read-wall",
    files: { "SPEC.md": "Inspect only this fixture.\n" },
    prompt: "Inspect SPEC.md and report what it requires.",
    verify: () => true,
  };
  try {
    await runEval(benchConfig(), { trials: 1, tasks: [task], suite: "composition", providerFactory });
    expect(observation.match(/path escapes project root/g)).toHaveLength(4);
    expect(observation).not.toContain(secret);
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}, 30000);

test("runEval matches the toolful headless verify-before-exit default", async () => {
  let calls = 0;
  let sawNudge = false;
  const providerFactory = (): Provider => ({
    complete: async (messages) => {
      calls++;
      sawNudge ||= messages.some((message) => isText(message.content)
        && message.content.includes("VERIFY BEFORE FINISHING"));
      return {
        content: calls === 1 ? "Looks finished." : "Verified final answer.",
        tool_calls: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
    },
  });
  const task: BenchTask = {
    id: "verify-default",
    files: { "answer.txt": "ready\n" },
    prompt: "Confirm answer.txt is ready.",
    verify: () => true,
  };

  const report = await runEval(benchConfig(), { trials: 1, tasks: [task], providerFactory });
  expect(calls).toBe(2);
  expect(sawNudge).toBe(true);
  expect(report.dim.pass1).toBe(1);
}, 30000);

test("runEval does not report a production-incomplete mutation as a pass", async () => {
  let turn = 0;
  const providerFactory = (): Provider => ({
    complete: async () => {
      const script = [
        {
          content: null,
          tool_calls: [{ id: "e1", name: "edit", arguments: { path: "calc.mjs", old_string: "a - b", new_string: "a + b" } }],
        },
        {
          content: null,
          tool_calls: [{ id: "b1", name: "bash", arguments: { command: "bun test" } }],
        },
        { content: "The file is fixed, but I could not validate it.", tool_calls: [] },
      ];
      const res = script[Math.min(turn, script.length - 1)];
      turn++;
      return { ...res, usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
    },
  });

  // sandbox:false makes the exact-file validator fail closed after the successful edit. The seeded
  // verifier alone is therefore green, but the production headless completion contract is not.
  const report = await runEval(benchConfig(), {
    trials: 1,
    tasks: [makeTask()],
    suite: "completion-parity",
    providerFactory,
  });

  expect(report.dim.pass1).toBe(0);
  expect(report.dim.passK).toBe(0);
  expect(report.dim.modelFailures).toBe(1);
  expect(report.dim.infraErrors).toBe(0);
  expect(report.dim.comparisonValid).toBe(true);
  expect(report.trajectories[0].verifier).toBe("passed");
  expect(report.trajectories[0].completionGate).toBe("failed");
  expect(report.trajectories[0].failureSignals).toContain("completion_gate");
  expect(report.trajectories[0].events.at(-1)?.result).toBe("failed");
}, 30000);

test("runBench does not report a production-incomplete mutation as a pass", async () => {
  const providerFactory = (): Provider => {
    let turn = 0;
    return {
      complete: async () => {
        const script = [
          { content: null, tool_calls: [{ id: "e1", name: "edit", arguments: { path: "calc.mjs", old_string: "a - b", new_string: "a + b" } }] },
          { content: null, tool_calls: [{ id: "b1", name: "bash", arguments: { command: "bun test" } }] },
          { content: "The file is fixed, but I could not validate it.", tool_calls: [] },
        ];
        const res = script[Math.min(turn, script.length - 1)];
        turn++;
        return { ...res, usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
      },
    };
  };

  const report = await runBench(benchConfig(), {
    trials: 1,
    tasks: [makeTask()],
    suite: "completion-parity",
    providerFactory,
  });

  expect(report.results[0].passes).toBe(0);
  expect(report.results[0].artifactPasses).toBe(1);
  expect(report.results[0].controllerPasses).toBe(0);
  expect(report.results[0].modelFailures).toBe(1);
  expect(report.results[0].infraErrors).toBe(0);
  expect(report.comparisonValid).toBe(true);
  expect(report.passed).toBe(0);
  expect(report.artifactPassed).toBe(1);
  expect(report.controllerPassed).toBe(0);
}, 30000);

test("required oracle-sandbox CI gate cannot silently skip a missing primitive", () => {
  expect(requiredOracleSandboxAvailable(false, false)).toBe(false);
  expect(requiredOracleSandboxAvailable(true, true)).toBe(true);
  expect(() => requiredOracleSandboxAvailable(false, true)).toThrow("no live OS sandbox");
});

test("benchmark purity scanner parses multiline imports and ignores prose", () => {
  expect(__benchmarkModuleSourceIsPureForTest([
    "import {",
    "  readFileSync,",
    "}",
    "from",
    '  "node:fs";',
  ].join("\n"))).toBe(false);
  expect(__benchmarkModuleSourceIsPureForTest([
    "export {",
    "  readFileSync,",
    "}",
    "from",
    '  "node:fs";',
  ].join("\n"))).toBe(false);
  expect(__benchmarkModuleSourceIsPureForTest([
    "// process, Bun, and import('node:fs') are forbidden in implementation code.",
    "/* export { readFileSync } from \"node:fs\"; */",
    'const prose = "process Bun require import( node:fs";',
    "const templateProse = `globalThis and import.meta are prose`;",
    'export { helper } from "./helper.mjs";',
  ].join("\n"))).toBe(true);
  expect(__benchmarkModuleSourceIsPureForTest("const unsafe = `${process.cwd()}`;\n")).toBe(false);
});

test.skipIf(!requiredOracleSandboxAvailable())("hidden benchmark source is absent from candidate-visible stack and process surfaces", () => withOptionalOracleSandbox(async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-stack-disclosure-"));
  try {
    writeFileSync(join(root, "probe.mjs"), [
      "const build = (() => {}).constructor;",
      'const runtime = build("return pro" + "cess")();',
      'const engine = build("return B" + "un")();',
      'const bytes = build("return Buf" + "fer")();',
      "export async function hiddenOracleVisible() {",
      '  const marker = "NEKO_STACK_ORACLE_SENTINEL_8f6d13";',
      '  const surfaces = [String(new Error("stack-probe").stack ?? ""), JSON.stringify(runtime.argv), JSON.stringify(runtime.execArgv), JSON.stringify(runtime.env), await engine.stdin.text()];',
      "  for (const surface of surfaces) {",
      "    if (surface.includes(marker)) return true;",
      '    for (const match of surface.matchAll(/data:text\\/javascript;base64,([A-Za-z0-9+/=]+)/g)) {',
      '      try { if (bytes.from(match[1], "base64").toString("utf8").includes(marker)) return true; } catch {}',
      "    }",
      "  }",
      "  return false;",
      "}",
      "",
    ].join("\n"), "utf8");
    const hidden = await __runHiddenBenchJsForTest(root, {
      modules: [{ specifier: "./probe.mjs", bindings: ["hiddenOracleVisible"] }],
      body: [
        'const marker = "NEKO_STACK_ORACLE_SENTINEL_8f6d13";',
        'assert.equal(await hiddenOracleVisible(), false, "hidden oracle appeared in a candidate-visible runtime surface: " + marker);',
        'console.log("ok");',
      ].join("\n"),
    }, ["probe.mjs"]);
    expect(hidden).toBe(true);

    writeFileSync(join(root, "impl.mjs"), "export const value = 42;\n", "utf8");
    writeFileSync(join(root, "public.mjs"), 'import { value } from "./impl.mjs";\nif (value !== 42) throw new Error("bad value");\nconsole.log("ok");\n', "utf8");
    expect(await __runBenchJsPassesForTest(root, "public.mjs")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}), 120_000);

test.skipIf(!requiredOracleSandboxAvailable())("hidden verifier stack labels cannot stand in for the harness completion marker", () => withOptionalOracleSandbox(async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-marker-isolation-"));
  try {
    writeFileSync(join(root, "probe.mjs"), [
      "const build = (() => {}).constructor;",
      'const runtime = build("return pro" + "cess")();',
      "export function finishFromVisibleLabel() {",
      '  const match = /neko-bench-oracle-([0-9a-f]{32})\\.mjs/.exec(String(new Error("label-probe").stack ?? ""));',
      "  if (!match) return;",
      '  runtime.stdout.write(`ok\\n\\n__NEKO_BENCH_ATTEST_${match[1]}__\\n`);',
      "  runtime.exit(0);",
      "}",
      "",
    ].join("\n"), "utf8");
    const accepted = await __runHiddenBenchJsForTest(root, {
      modules: [{ specifier: "./probe.mjs", bindings: ["finishFromVisibleLabel"] }],
      body: [
        "finishFromVisibleLabel();",
        'throw new Error("only the harness may complete a hidden verifier");',
      ].join("\n"),
    }, ["probe.mjs"]);
    expect(accepted).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}), 120_000);

test("benchmark JS oracle fails closed and cannot write the model workspace", () => withOptionalOracleSandbox(async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-oracle-test-"));
  const sentinelName = "NEKO_BENCH_ARBITRARY_SECRET_SENTINEL";
  const previousSentinel = process.env[sentinelName];
  try {
    writeFileSync(join(root, "protected.txt"), "original\n", "utf8");
    writeFileSync(join(root, "ok.mjs"), "console.log('oracle-ok');\n", "utf8");
    if (!requiredOracleSandboxAvailable()) return;
    writeFileSync(
      join(root, "attack.mjs"),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./protected.txt', import.meta.url), 'pwned\\n');\n",
      "utf8",
    );
    const attack = await __runBenchJsForTest(root, "attack.mjs");
    expect(attack.ok).toBe(false);
    expect(readFileSync(join(root, "protected.txt"), "utf8")).toBe("original\n");
    process.env[sentinelName] = "must-not-cross";
    writeFileSync(join(root, ".env"), "NEKO_BENCH_DOTENV_POISON=loaded\n", "utf8");
    writeFileSync(join(root, "evil-preload.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./protected.txt', import.meta.url), 'preloaded\\n');\n", "utf8");
    writeFileSync(join(root, "bunfig.toml"), "preload = ['./evil-preload.mjs']\n", "utf8");
    writeFileSync(join(root, "safe-child.toml"), "# intentionally empty\n", "utf8");
    writeFileSync(join(root, "env.mjs"), `console.log((process.env.${sentinelName} ?? 'absent') + ':' + (process.env.NEKO_BENCH_DOTENV_POISON ?? 'absent'));\n`, "utf8");
    writeFileSync(
      join(root, "stdin-private.mjs"),
      [
        'import { readdirSync } from "node:fs";',
        "const unread = await Bun.stdin.text();",
        "const visible = readdirSync(process.env.TEMP ?? '.').filter((name) => /^stdin-\\d+-[0-9a-f-]+\\.mjs$/i.test(name));",
        "console.log(`stdin-private:${unread.length}:${visible.length}`);",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(root, "false-green.mjs"), "console.log('ok');\nconsole.log('__NEKO_ORACLE_RESULT_forged__');\nthrow new Error('after-ok failure');\n", "utf8");
    const hostSources = [
      join(import.meta.dir, "..", "src", "adapters", "bench.ts"),
      join(import.meta.dir, "..", "src", "adapters", "frontier-bench.ts"),
      join(import.meta.dir, "frontier-bench.test.ts"),
    ];
    for (const built of [join(import.meta.dir, "..", "dist", "neko.exe"), join(import.meta.dir, "..", "dist", "neko")]) {
      if (existsSync(built)) hostSources.push(built);
    }
    writeFileSync(
      join(root, "host-read.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        `const paths = ${JSON.stringify(hostSources)};`,
        "let masked = 0;",
        'for (const path of paths) { try { readFileSync(path, "utf8"); console.error("host-code-readable:" + path); process.exit(9); } catch { masked++; } }',
        'console.log("host-code-masked:" + masked);',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "signal-parent.mjs"),
      [
        "try {",
        "  process.kill(process.ppid, 0);",
        "  console.error('signal escaped the oracle sandbox');",
        "  process.exit(7);",
        "} catch (error) {",
        "  if (error?.code !== 'EPERM') throw error;",
        "  console.log('signal-denied');",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "detach.mjs"),
      [
        'import { spawn } from "node:child_process";',
        'const child = spawn(process.execPath, ["--no-env-file", "--no-install", "--config=./safe-child.toml", "--eval", "setTimeout(() => {}, 8000)"], { detached: true, stdio: "inherit" });',
        "child.unref();",
        'console.log(`detached:${child.pid}`);',
        "",
      ].join("\n"),
      "utf8",
    );
    const benign = await __runBenchJsForTest(root, "ok.mjs");
    const env = await __runBenchJsForTest(root, "env.mjs");
    const stdinPrivate = await __runBenchJsForTest(root, "stdin-private.mjs");
    const falseGreen = await __runBenchJsForTest(root, "false-green.mjs");
    const hostRead = await __runBenchJsForTest(root, "host-read.mjs");
    const detachedStarted = Date.now();
    const detached = await __runBenchJsForTest(root, "detach.mjs");
    const detachedMs = Date.now() - detachedStarted;
    expect(benign.ok).toBe(true);
    expect(benign.out.trim()).toBe("oracle-ok");
    expect(env.ok).toBe(true);
    expect(env.out.trim()).toBe("absent:absent");
    expect(stdinPrivate.ok).toBe(true);
    expect(stdinPrivate.out.trim()).toBe("stdin-private:0:0");
    expect(falseGreen.ok).toBe(false);
    expect(hostRead.ok).toBe(true);
    expect(hostRead.out.trim()).toBe(`host-code-masked:${hostSources.length}`);
    if (process.platform === "darwin") {
      expect(detached.ok).toBe(false); // Seatbelt oracle denies process-fork by construction.
      const signalParent = await __runBenchJsForTest(root, "signal-parent.mjs");
      expect(signalParent.ok).toBe(true);
      expect(signalParent.out.trim()).toBe("signal-denied");
    } else if (detached.ok) {
      // bwrap/SRT may allow the fork; then its detached PID must be gone before success returns. A
      // primitive that denies the fork outright is also safe and is accepted by this cross-platform test.
      const pid = Number(/detached:(\d+)/.exec(detached.out)?.[1] ?? 0);
      expect(pid).toBeGreaterThan(0);
      // The detached child inherits the oracle's stdout descriptor and sleeps for eight seconds.
      // A quick EOF therefore proves that the containment primitive tore the descendant down;
      // namespace-local PIDs cannot be safely probed from the host PID namespace.
      expect(detachedMs).toBeLessThan(3_000);
    }
    expect(readFileSync(join(root, "protected.txt"), "utf8")).toBe("original\n");
    expect(readdirSync(root).sort()).toEqual([
      ".env", "attack.mjs", "bunfig.toml", "detach.mjs", "env.mjs", "evil-preload.mjs",
      "false-green.mjs", "host-read.mjs", "ok.mjs", "protected.txt", "safe-child.toml", "signal-parent.mjs",
      "stdin-private.mjs",
    ]);
  } finally {
    if (previousSentinel === undefined) delete process.env[sentinelName];
    else process.env[sentinelName] = previousSentinel;
    rmSync(root, { recursive: true, force: true });
  }
}), 600_000); // seven independent live-sandbox launches; Windows SRT may take ~80s each under load

test("bounded benchmark supervisor force-stops a target that ignores SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-timeout-test-"));
  const pidFile = join(root, "target.pid");
  try {
    writeFileSync(join(root, "bunfig.toml"), "# intentionally empty\n", "utf8");
    writeFileSync(
      join(root, "ignore-term.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("target.pid", String(process.pid));',
        'process.on("SIGTERM", () => {});',
        'setInterval(() => {}, 60_000);',
        "",
      ].join("\n"),
      "utf8",
    );
    const started = Date.now();
    const result = await __runBoundedBenchProcessForTest(
      {
        file: process.execPath,
        args: ["--no-env-file", "--no-install", "--config=./bunfig.toml", "./ignore-term.mjs"],
        shell: false,
      },
      root,
      process.env,
      750,
      1024 * 1024,
    );
    const elapsed = Date.now() - started;
    const pid = Number(readFileSync(pidFile, "utf8"));

    expect(result.timedOut).toBe(true);
    expect(result.outputExceeded).toBe(false);
    expect(result.treeCleanupConfirmed).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
    expect(pid).toBeGreaterThan(0);
    expect(processIsLive(pid)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("bounded benchmark supervisor caps output and stops the flooding target", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-output-test-"));
  try {
    writeFileSync(join(root, "bunfig.toml"), "# intentionally empty\n", "utf8");
    writeFileSync(
      join(root, "flood.mjs"),
      'const block = "x".repeat(8192);\nfor (;;) process.stdout.write(block);\n',
      "utf8",
    );
    const maxOutputBytes = 4096;
    const result = await __runBoundedBenchProcessForTest(
      {
        file: process.execPath,
        args: ["--no-env-file", "--no-install", "--config=./bunfig.toml", "./flood.mjs"],
        shell: false,
      },
      root,
      process.env,
      5000,
      maxOutputBytes,
    );

    expect(result.timedOut).toBe(false);
    expect(result.outputExceeded).toBe(true);
    expect(result.treeCleanupConfirmed).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(maxOutputBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("bounded benchmark supervisor treats unconfirmed cleanup as infrastructure failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-cleanup-test-"));
  try {
    writeFileSync(join(root, "bunfig.toml"), "# intentionally empty\n", "utf8");
    await expect(__runBoundedBenchProcessForTest(
      {
        file: process.execPath,
        args: ["--no-env-file", "--no-install", "--config=./bunfig.toml", "--eval", "process.exit(0)"],
        shell: false,
      },
      root,
      process.env,
      5000,
      4096,
      async () => false,
    )).rejects.toBeInstanceOf(BenchInfrastructureError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("a host-certified containment primitive owns the normal-close tree postcondition", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-contained-close-test-"));
  let terminatorCalls = 0;
  try {
    writeFileSync(join(root, "bunfig.toml"), "# intentionally empty\n", "utf8");
    const result = await __runBoundedBenchProcessForTest(
      {
        file: process.execPath,
        args: ["--no-env-file", "--no-install", "--config=./bunfig.toml", "--eval", "process.exit(0)"],
        shell: false,
        treeContainedOnClose: true,
      },
      root,
      process.env,
      5000,
      4096,
      async () => { terminatorCalls++; return false; },
    );
    expect(result.status).toBe(0);
    expect(result.treeCleanupConfirmed).toBe(true);
    expect(terminatorCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test.skipIf(process.platform === "win32")("a host-certified containment primitive still verifies an abnormal close", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-contained-signal-test-"));
  let terminatorCalls = 0;
  try {
    writeFileSync(join(root, "bunfig.toml"), "# intentionally empty\n", "utf8");
    await expect(__runBoundedBenchProcessForTest(
      {
        file: process.execPath,
        args: ["--no-env-file", "--no-install", "--config=./bunfig.toml", "--eval", "process.kill(process.pid, 'SIGTERM')"],
        shell: false,
        treeContainedOnClose: true,
      },
      root,
      process.env,
      5000,
      4096,
      async () => { terminatorCalls++; return false; },
    )).rejects.toBeInstanceOf(BenchInfrastructureError);
    expect(terminatorCalls).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("raw harness-lift file blocks stay inside their trial root", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-lift-output-test-"));
  const outside = join(root, "..", `neko-lift-escape-${process.pid}.mjs`);
  try {
    __applyRawBenchFilesForTest(root, [
      "```inside.mjs",
      "export const ok = true;",
      "```",
      `\`\`\`../neko-lift-escape-${process.pid}.mjs`,
      "export const escaped = true;",
      "```",
    ].join("\n"));
    expect(readFileSync(join(root, "inside.mjs"), "utf8")).toContain("ok = true");
    expect(() => readFileSync(outside, "utf8")).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("runHarnessLift uses the production turn surface and disposes both fresh providers", async () => {
  let created = 0;
  const disposed: number[] = [];
  let harnessTools: string[] = [];
  let harnessSystem = "";
  const providerFactory = (): Provider => {
    const id = created++;
    return {
      complete: async (messages, tools) => {
        if (id === 1) {
          harnessTools = (tools ?? []).map((schema: any) => schema.function.name);
          harnessSystem = messages
            .filter((message: any) => message.role === "system")
            .map((message: any) => String(message.content ?? ""))
            .join("\n");
        }
        return { content: "done", tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
      },
      dispose: async () => { disposed.push(id); },
    };
  };
  const task: BenchTask = {
    id: "lift-production-parity",
    files: { "src/target.ts": "export const answer = 41;\n" },
    prompt: "Fix the bug in src/target.ts so all existing tests pass. Make the smallest correct change. Run the tests. Do not change tests or add dependencies.",
    verify: () => true,
  };

  const report = await runHarnessLift(benchConfig(), undefined, { tasks: [task], providerFactory });

  expect(report.rawPass).toBe(1);
  expect(report.harnessPass).toBe(1);
  expect(created).toBe(2);
  expect(disposed.sort((a, b) => a - b)).toEqual([0, 1]);
  expect(harnessTools).toEqual(["read_file", "edit", "bash"]);
  expect(harnessSystem).toContain("# NEKO DYNAMIC-TOOL RUNTIME");
  expect(harnessSystem).not.toContain("# NEKO SKILL CATALOG");
}, 30000);

test("hard constraints prevent runEval and runBench from passing a tampered seed", async () => {
  let sawExecutableWriteFile = false;
  let verifierCalls = 0;
  const tamperTask: BenchTask = {
    id: "tampered-seed",
    files: {
      "calc.mjs": "export function add(a, b) { return a - b; }\n",
      "test.mjs": "throw new Error('real test must remain');\n",
    },
    // Mentioning two candidate files deliberately selects the broad production surface. The regression
    // must exercise a real successful mutation, not a write_file call rejected by the exact-file lease.
    prompt: "Inspect calc.mjs and test.mjs, fix the implementation, and preserve test.mjs exactly.",
    verify: () => { verifierCalls++; return true; }, // must not run after the seed identity changes
    constraints: [{ id: "keep-test.mjs", keep: "test.mjs" }],
  };
  const providerFactory = (): Provider => {
    let turn = 0;
    return {
      complete: async (_messages, tools) => {
        sawExecutableWriteFile ||= (tools ?? []).some((schema: any) => schema.function.name === "write_file");
        const script = [
          { content: null, tool_calls: [{ id: "w1", name: "write_file", arguments: { path: "test.mjs", content: "console.log('tampered');\n" } }] },
          { content: "done", tool_calls: [] },
        ];
        const res = script[Math.min(turn, script.length - 1)];
        turn++;
        return { ...res, usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
      },
    };
  };
  const cfg = benchConfig();
  let failedArtifact: EvalArtifactRecord | undefined;
  const evalReport = await runEval(cfg, {
    trials: 1,
    tasks: [tamperTask],
    suite: "smoke",
    providerFactory,
    artifactSink: (record) => { failedArtifact = record; return true; },
  });
  const benchReport = await runBench(cfg, { trials: 1, tasks: [tamperTask], suite: "smoke", providerFactory });

  expect(sawExecutableWriteFile).toBe(true);
  expect(verifierCalls).toBe(0);
  expect(evalReport.dim.constraintScore).toBe(0);
  expect(evalReport.dim.pass1).toBe(0);
  expect(evalReport.dim.modelFailures).toBe(1);
  expect(evalReport.trajectories[0].failureSignals).toContain("constraint");
  expect(evalReport.trajectories[0].failedConstraints).toEqual(["k1"]);
  expect(evalReport.trajectories[0].verifier).toBe("failed");
  expect(failedArtifact!.trajectories[0].failedConstraintRefs).toEqual(["k1"]);
  expect(JSON.stringify(failedArtifact)).not.toContain("keep-test.mjs");
  expect(benchReport.passed).toBe(0);
  expect(benchReport.modelFailures).toBe(1);
}, 30000);

function isolationTask(id: string, prompt: string): BenchTask {
  return {
    id,
    files: { "seed.txt": `${id}\n` },
    prompt,
    verify: (dir) => readFileSync(join(dir, "seed.txt"), "utf8") === `${id}\n`,
  };
}

test("runEval isolates every task x trial provider and disposes all, including a throwing provider", async () => {
  const cfg = benchConfig(3);
  const prompts = ["alpha task", "beta task"];
  const histories: Array<Array<Array<{ role: string; content: unknown }>>> = [];
  const disposed: number[] = [];
  let created = 0;

  const providerFactory = (): Provider => {
    const instance = created++;
    const calls: Array<Array<{ role: string; content: unknown }>> = [];
    histories[instance] = calls;
    return {
      complete: async (messages) => {
        calls.push(messages.map((message) => ({ role: String(message.role), content: message.content })));
        if (instance === 1) throw new Error("scripted provider failure");
        return {
          content: "done",
          tool_calls: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      },
      dispose: async () => { disposed.push(instance); },
    };
  };

  const report = await runEval(cfg, {
    trials: 2,
    tasks: [isolationTask("alpha", prompts[0]), isolationTask("beta", prompts[1])],
    suite: "isolation",
    providerFactory,
  });

  expect(created).toBe(4);
  expect([...disposed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  expect(histories.map((calls) => calls.length)).toEqual([2, 1, 2, 2]);
  expect(histories.map((calls) => calls[0].filter((message) => message.role === "user").map((message) => message.content)))
    .toEqual([[prompts[0]], [prompts[0]], [prompts[1]], [prompts[1]]]);
  for (const calls of histories) {
    expect(calls[0].some((message) => message.role === "assistant" || message.role === "tool")).toBe(false);
  }
  expect(report.dim.pass1).toBe(0.75);
  expect(report.dim.passK).toBe(0.5);
  expect(report.dim.infraErrors).toBe(1);
  expect(report.dim.modelFailures).toBe(0);
  expect(report.dim.comparisonValid).toBe(false);
}, 30000);

test("benchmark oracle reports unavailable sandbox as infrastructure, not model failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-bench-oracle-infra-"));
  try {
    writeFileSync(join(root, "ok.mjs"), "console.log('ok');\n", "utf8");
    await expect(__runBenchJsForTest(root, "ok.mjs", { sandboxReady: () => false }))
      .rejects.toBeInstanceOf(BenchInfrastructureError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runEval fails closed when an injected provider could be shared", async () => {
  const cfg = benchConfig(3);
  let completed = 0;
  let disposed = 0;
  const shared: Provider = {
    complete: async () => {
      completed++;
      return { content: "done", tool_calls: [] };
    },
    dispose: () => { disposed++; },
  };
  const options = { trials: 2, tasks: [isolationTask("shared", "shared task")], suite: "isolation" };

  await expect(runEval(cfg, { ...options, provider: shared })).rejects.toThrow("cannot be shared");
  expect(completed).toBe(0);
  expect(disposed).toBe(0);

  await expect(runEval(cfg, { ...options, providerFactory: () => shared })).rejects.toThrow("fresh Provider");
  expect(completed).toBe(2);
  expect(disposed).toBe(1);
}, 30000);

test("benchmark task files cannot escape the fresh trial root", async () => {
  let providerCalls = 0;
  const task: BenchTask = {
    id: "escaped-seed",
    files: { "../outside.mjs": "console.log('escaped');\n" },
    prompt: "Inspect the fixture.",
    verify: () => true,
  };
  await expect(runEval(benchConfig(), {
    trials: 1,
    tasks: [task],
    providerFactory: () => ({
      complete: async () => { providerCalls++; return { content: "done", tool_calls: [] }; },
    }),
  })).rejects.toBeInstanceOf(BenchInfrastructureError);
  expect(providerCalls).toBe(0);
});

test("runBench records provider failure as infrastructure and invalidates comparison", async () => {
  const report = await runBench(benchConfig(), {
    trials: 1,
    tasks: [isolationTask("bench-infra", "bench infrastructure task")],
    suite: "infra",
    providerFactory: () => ({ complete: async () => { throw new Error("provider unavailable"); } }),
  });
  expect(report.passed).toBe(0);
  expect(report.modelFailures).toBe(0);
  expect(report.infraErrors).toBe(1);
  expect(report.comparisonValid).toBe(false);
});

test("runBench disposes a failed trial before acquiring the next provider", async () => {
  const cfg = benchConfig(3);
  let acquisitions = 0;
  let disposed = 0;
  const providerFactory = (): Provider => {
    acquisitions++;
    if (acquisitions === 2) throw new Error("stop after first trial");
    return {
      complete: async () => { throw new Error("scripted trial failure"); },
      dispose: async () => { disposed++; },
    };
  };

  await expect(runBench(cfg, {
    trials: 2,
    tasks: [isolationTask("bench-lifecycle", "bench lifecycle task")],
    suite: "isolation",
    providerFactory,
  })).rejects.toThrow("stop after first trial");
  expect(disposed).toBe(1);
}, 30000);
