import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

import {
  PROGRAMBENCH_IMAGE_TAG,
  PROGRAMBENCH_EVALUATOR_IMAGE,
  PROGRAMBENCH_EVALUATOR_MODE,
  PROGRAMBENCH_VERSION,
  buildProgramBenchEvaluatorArgs,
  buildProgramBenchEvaluatorGuardArgs,
  buildProgramBenchEvaluatorListArgs,
  buildProgramBenchRunnerArgs,
  parseProgramBenchEvalArgs,
  programBenchImage,
  readProgramBenchRunnerResult,
  verifyProgramBenchEvaluatorOutput,
  writeProgramBenchProfile,
} from "../scripts/programbench-eval.ts";

test("ProgramBench launcher requires one explicit official task and freezes the protocol", () => {
  expect(parseProgramBenchEvalArgs([
    "--task", "abishekvashok__cmatrix.5c082c6",
    "--profile", "zai",
    "--output", "results/programbench-smoke",
    "--max-steps", "160",
    "--effort", "max",
  ])).toEqual({
    task: "abishekvashok__cmatrix.5c082c6",
    profile: "zai",
    output: "results/programbench-smoke",
    maxSteps: 160,
    implementationRoundSteps: 12,
    reasoningEffort: "max",
    completionMode: "single",
    callBudget: 161,
    evaluate: false,
  });
  expect(() => parseProgramBenchEvalArgs([])).toThrow("--task");
  expect(() => parseProgramBenchEvalArgs(["--task", "bad/task"])).toThrow("instance id");
  expect(() => parseProgramBenchEvalArgs(["--task", "a__b.1234567", "--network", "host"])).toThrow("Unknown option");
  expect(() => parseProgramBenchEvalArgs([
    "--task", "a__b.1234567", "--max-steps", "8", "--round-steps", "9",
  ])).toThrow("cannot exceed");
  expect(PROGRAMBENCH_VERSION).toBe("1.2.4");
  expect(PROGRAMBENCH_IMAGE_TAG).toBe("task_cleanroom_v6");
});

test("ProgramBench scoring runs inside a pinned Linux controller", () => {
  const output = resolve("results/programbench-smoke");
  const runId = "a".repeat(32);
  expect(buildProgramBenchEvaluatorArgs(output, 4, runId)).toEqual([
    "run", "--rm",
    "--label", `dev.neko.programbench.run=${runId}`,
    "--env", `NEKO_PROGRAMBENCH_RUN_ID=${runId}`,
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", `${output}:/results`,
    PROGRAMBENCH_EVALUATOR_IMAGE,
    "eval", "/results",
    "--workers", "1",
    "--branch-workers", "4",
    "--docker-cpus", "4",
  ]);
  const twoCpuArgs = buildProgramBenchEvaluatorArgs(output, 2, runId);
  expect(twoCpuArgs[twoCpuArgs.indexOf("--branch-workers") + 1]).toBe("2");
  expect(twoCpuArgs[twoCpuArgs.indexOf("--docker-cpus") + 1]).toBe("2");
  expect(buildProgramBenchEvaluatorListArgs(runId)).toEqual([
    "ps", "--all", "--quiet", "--filter", `label=dev.neko.programbench.run=${runId}`,
  ]);
  const guardArgs = buildProgramBenchEvaluatorGuardArgs(output, runId);
  expect(guardArgs.slice(0, 7)).toEqual([
    "run", "--detach", "--rm",
    "--name", `neko-programbench-guard-${runId}`,
    "--label", `dev.neko.programbench.guard=${runId}`,
  ]);
  expect(guardArgs).toContain(`${output}:/watch`);
  expect(guardArgs.at(-1)).toContain(`label=dev.neko.programbench.run=${runId}`);
  expect(guardArgs.join(" ")).not.toContain("API_KEY");
  expect(() => buildProgramBenchEvaluatorArgs("relative", 4, runId)).toThrow("absolute");
  expect(() => buildProgramBenchEvaluatorArgs(output, 0, runId)).toThrow("CPU");
  expect(() => buildProgramBenchEvaluatorArgs(output, 4, "bad")).toThrow("run id");
});

test("ProgramBench scoring accepts only a complete result from the pinned evaluator shim", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-programbench-result-"));
  const task = "abishekvashok__cmatrix.5c082c6";
  const shimSha256 = "a".repeat(64);
  const runId = "d".repeat(32);
  const instance = join(root, task);
  mkdirSync(instance, { recursive: true });
  try {
    writeFileSync(join(root, "_neko-evaluator.json"), JSON.stringify({
      schemaVersion: "neko.programbench.evaluator.v2",
      mode: PROGRAMBENCH_EVALUATOR_MODE,
      programbenchVersion: PROGRAMBENCH_VERSION,
      shimSha256,
      snapshotScope: "/workspace",
      runId,
      instanceId: task,
      score: 1,
      resolvedTests: 1,
      scoredTests: 1,
      errorCode: null,
      branchErrorCount: 0,
      systemErrorCount: 0,
      warningCount: 0,
    }));
    const resultPath = join(instance, `${task}.eval.json`);
    writeFileSync(resultPath, JSON.stringify({
      test_results: [{ name: "one", status: "passed" }],
      executable_hash: "b".repeat(64),
    }));
    expect(verifyProgramBenchEvaluatorOutput(root, task, shimSha256, runId)).toEqual({
      score: 1,
      resolvedTests: 1,
      scoredTests: 1,
      rawTestCount: 1,
      executableHash: "b".repeat(64),
      errorCode: null,
      evaluatorMode: PROGRAMBENCH_EVALUATOR_MODE,
      programbenchVersion: PROGRAMBENCH_VERSION,
      evaluatorShimSha256: shimSha256,
      warningCount: 0,
      systemErrorCount: 0,
      branchErrorCount: 0,
    });

    writeFileSync(resultPath, JSON.stringify({
      test_results: [{ name: "one", status: "not_run" }],
      error_code: "compile_failed",
      executable_hash: "b".repeat(64),
    }));
    expect(() => verifyProgramBenchEvaluatorOutput(root, task, shimSha256, runId)).toThrow("compile_failed");
    expect(() => verifyProgramBenchEvaluatorOutput(root, task, "c".repeat(64), runId)).toThrow("identity");
    expect(() => verifyProgramBenchEvaluatorOutput(root, task, shimSha256, "e".repeat(32))).toThrow("belong");

    rmSync(resultPath, { force: true });
    writeFileSync(join(root, "_neko-evaluator.json"), JSON.stringify({
      schemaVersion: "neko.programbench.evaluator.v2",
      mode: PROGRAMBENCH_EVALUATOR_MODE,
      programbenchVersion: PROGRAMBENCH_VERSION,
      shimSha256,
      snapshotScope: "/workspace",
      runId,
      instanceId: task,
      score: 0,
      resolvedTests: 0,
      scoredTests: 0,
      errorCode: "LocalEntryNotFoundError",
      branchErrorCount: 0,
      systemErrorCount: 0,
      warningCount: 0,
    }));
    expect(verifyProgramBenchEvaluatorOutput(root, task, shimSha256, runId)).toMatchObject({
      score: 0,
      resolvedTests: 0,
      scoredTests: 0,
      rawTestCount: 0,
      executableHash: null,
      errorCode: "LocalEntryNotFoundError",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ProgramBench runner telemetry survives an artifact-missing outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-programbench-trajectory-"));
  const task = "abishekvashok__cmatrix.5c082c6";
  const instance = join(root, task);
  mkdirSync(instance, { recursive: true });
  try {
    writeFileSync(join(instance, `${task}.traj.json`), JSON.stringify({
      schemaVersion: "neko.programbench.trajectory.v2",
      instanceId: task,
      exitStatus: "artifact_missing",
      artifact: null,
      profile: "zai",
      model: "glm-5.3",
      sourceRevision: "a".repeat(40),
      sourceDirty: true,
      implementation: {
        hostRunnerSha256: "b".repeat(64),
        launcherSha256: "c".repeat(64),
        environmentRunnerSha256: "d".repeat(64),
        remoteToolsSha256: "e".repeat(64),
      },
      timeBudgetExhausted: true,
      providerCallBudgetExhausted: false,
      metrics: null,
      lastCheckpoint: {
        providerCompleteCalls: 9,
        totalTokens: 1234,
        wallTimeMs: 5678,
        toolCalls: { completed: 10, failed: 2 },
        progress: { artifactCheckpoints: 3, validationState: "not_started" },
      },
    }));
    expect(readProgramBenchRunnerResult(root, task, 2)).toMatchObject({
      exitCode: 2,
      exitStatus: "artifact_missing",
      artifactSha256: null,
      providerCompleteCalls: 9,
      totalTokens: 1234,
      toolCallsCompleted: 10,
      toolCallsFailed: 2,
      wallTimeMs: 5678,
      artifactCheckpoints: 3,
      validationState: "not_started",
      timeBudgetExhausted: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ProgramBench image and Python invocation are deterministic", () => {
  const task = "abishekvashok__cmatrix.5c082c6";
  expect(programBenchImage(task)).toBe(`programbench/abishekvashok_1776_cmatrix.5c082c6:${PROGRAMBENCH_IMAGE_TAG}`);
  expect(buildProgramBenchRunnerArgs({
    pythonRunner: resolve("evals/programbench/runner.py"),
    runnerPath: resolve("neko-harbor-host.exe"),
    uvCacheDir: resolve(".test-cache/uv"),
    task,
    output: resolve("results/programbench-smoke"),
    maxSteps: 160,
    implementationRoundSteps: 12,
    reasoningEffort: "max",
    completionMode: "contract",
    callBudget: 160,
    sourceRevision: "a".repeat(40),
    sourceDirty: true,
    profile: "zai",
    model: "glm-5.3",
    hostRunnerSha256: "b".repeat(64),
    launcherSha256: "c".repeat(64),
    environmentRunnerSha256: "d".repeat(64),
    remoteToolsSha256: "e".repeat(64),
    runId: "f".repeat(32),
  })).toEqual([
    "run", "--cache-dir", resolve(".test-cache/uv"), "--offline", "--isolated", "--no-config", "--no-project",
    "--with", `programbench==${PROGRAMBENCH_VERSION}`,
    "python", resolve("evals/programbench/runner.py"),
    "--runner", resolve("neko-harbor-host.exe"),
    "--task", task,
    "--output", resolve("results/programbench-smoke"),
    "--run-id", "f".repeat(32),
    "--max-steps", "160",
    "--round-steps", "12",
    "--effort", "max",
    "--contract",
    "--call-budget", "160",
    "--source-revision", "a".repeat(40),
    "--source-dirty",
    "--profile", "zai",
    "--model", "glm-5.3",
    "--host-runner-sha256", "b".repeat(64),
    "--launcher-sha256", "c".repeat(64),
    "--environment-runner-sha256", "d".repeat(64),
    "--remote-tools-sha256", "e".repeat(64),
  ]);
  expect(() => buildProgramBenchRunnerArgs({
    pythonRunner: resolve("evals/programbench/runner.py"),
    runnerPath: resolve("neko-harbor-host.exe"),
    uvCacheDir: resolve(".test-cache/uv"),
    task,
    output: resolve("results/programbench-smoke"),
    maxSteps: 1,
    implementationRoundSteps: 1,
    reasoningEffort: "max",
    completionMode: "single",
    callBudget: 1,
    sourceRevision: "a".repeat(40),
    sourceDirty: false,
    profile: "zai",
    model: "glm-5.3",
    hostRunnerSha256: "b".repeat(64),
    launcherSha256: "c".repeat(64),
    environmentRunnerSha256: "d".repeat(64),
    remoteToolsSha256: "e".repeat(64),
    runId: "bad",
  })).toThrow("run id");
});

test("ProgramBench host profile stages only one bounded provider route", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-programbench-profile-"));
  try {
    const path = writeProgramBenchProfile(root, {
      profile: "zai",
      provider: "anthropic",
      model: "glm-5.3",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKey: "private-test-value",
      contextWindow: 202_752,
      maxSteps: 160,
      reasoningEffort: "max",
    });
    const staged = JSON.parse(readFileSync(path, "utf8"));
    expect(staged).toEqual({
      active_profile: "zai",
      max_steps: 160,
      reasoning_effort: "max",
      auto_update: false,
      profiles: {
        zai: {
          provider: "anthropic",
          model: "glm-5.3",
          base_url: "https://api.z.ai/api/anthropic",
          api_key: "private-test-value",
          model_context: { "glm-5.3": 202_752 },
        },
      },
    });
    expect(JSON.stringify(staged)).not.toContain("mcp_servers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
