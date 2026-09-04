import { resolve } from "node:path";
import { expect, test } from "bun:test";

import {
  buildProgramBenchCampaignCells,
  createProgramBenchCampaignManifest,
  isProgramBenchInfrastructureInvalidCell,
  parseProgramBenchCampaignArgs,
  resumeProgramBenchCampaignManifest,
  summarizeProgramBenchCampaign,
  type ProgramBenchCampaignCellState,
  type ProgramBenchCampaignProvenance,
} from "../scripts/programbench-campaign.ts";
import type { ProgramBenchRunResult } from "../scripts/programbench-eval.ts";

function completedResult(task: string): ProgramBenchRunResult {
  return {
    schemaVersion: "neko.programbench.run.v2",
    task,
    runner: {
      exitCode: 0,
      exitStatus: "completed",
      artifactSha256: "a".repeat(64),
      profile: "zai",
      model: "glm-5.3",
      sourceRevision: "b".repeat(40),
      sourceDirty: true,
      implementation: {
        hostRunnerSha256: "c".repeat(64),
        launcherSha256: "d".repeat(64),
        environmentRunnerSha256: "e".repeat(64),
        remoteToolsSha256: "f".repeat(64),
      },
      providerCompleteCalls: 3,
      totalTokens: 100,
      toolCallsCompleted: 4,
      toolCallsFailed: 0,
      wallTimeMs: 1_000,
      artifactCheckpoints: 1,
      validationState: "passed",
      timeBudgetExhausted: false,
      providerCallBudgetExhausted: false,
    },
    evaluationStatus: "not_requested",
    evaluation: null,
    updatedAt: 123,
  };
}

function evaluatedResult(task: string, score: number, calls: number, tokens: number): ProgramBenchRunResult {
  const result = completedResult(task);
  result.runner.providerCompleteCalls = calls;
  result.runner.totalTokens = tokens;
  result.evaluationStatus = "completed";
  result.evaluation = {
    score,
    resolvedTests: Math.round(score * 100),
    scoredTests: 100,
    rawTestCount: 100,
    executableHash: "1".repeat(64),
    errorCode: null,
    evaluatorMode: "workspace-snapshot",
    programbenchVersion: "1.2.4",
    evaluatorShimSha256: "2".repeat(64),
    warningCount: 0,
    systemErrorCount: 0,
    branchErrorCount: 0,
  };
  return result;
}

function provenance(tasks: string[]): ProgramBenchCampaignProvenance {
  return {
    sourceRevision: "3".repeat(40),
    sourceDirty: true,
    sourceSnapshotSha256: "4".repeat(64),
    componentSha256: {
      campaign: "5".repeat(64),
      launcher: "6".repeat(64),
      evaluatorShim: "7".repeat(64),
      environmentRunner: "8".repeat(64),
      hostRunner: "9".repeat(64),
      remoteTools: "a".repeat(64),
    },
    evaluatorImage: {
      reference: "neko-programbench-evaluator:1.2.4-linux-v4",
      id: `sha256:${"b".repeat(64)}`,
    },
    taskImages: Object.fromEntries(tasks.map((task) => [task, {
      reference: `programbench/${task}:task_cleanroom_v6`,
      id: `sha256:${"c".repeat(64)}`,
    }])),
  };
}

test("ProgramBench campaign freezes a bounded task-profile-replicate matrix", () => {
  const options = parseProgramBenchCampaignArgs([
    "--task", "abishekvashok__cmatrix.5c082c6",
    "--task", "astaxie__bat.17d1080",
    "--profiles", "zai,bai",
    "--replicates", "3",
    "--output", "results/programbench-campaign",
    "--max-steps", "160",
    "--call-budget", "80",
    "--controllers", "single,contract",
    "--effort", "max",
    "--evaluate",
  ]);
  expect(options).toEqual({
    tasks: ["abishekvashok__cmatrix.5c082c6", "astaxie__bat.17d1080"],
    profiles: ["zai", "bai"],
    replicates: 3,
    output: "results/programbench-campaign",
    maxSteps: 160,
    implementationRoundSteps: 12,
    callBudget: 80,
    completionModes: ["single", "contract"],
    reasoningEffort: "max",
    evaluate: true,
    resume: false,
  });
  const cells = buildProgramBenchCampaignCells(options, resolve("results/programbench-campaign"));
  expect(cells).toHaveLength(24);
  expect(cells[0]).toMatchObject({
    task: "abishekvashok__cmatrix.5c082c6",
    profile: "zai",
    replicate: 1,
    sampling: "provider-replicate",
    completionMode: "single",
  });
  expect(cells.slice(0, 6).map((cell) => [cell.replicate, cell.completionMode])).toEqual([
    [1, "single"], [1, "contract"],
    [2, "contract"], [2, "single"],
    [3, "single"], [3, "contract"],
  ]);
  expect(cells.at(-1)?.output.replaceAll("\\", "/")).toEndWith("/bai/contract/replicate-03");
});

test("ProgramBench campaign rejects ambiguous or unbounded matrices", () => {
  expect(() => parseProgramBenchCampaignArgs([])).toThrow("--task");
  expect(() => parseProgramBenchCampaignArgs([
    "--task", "a__b.1234567", "--profiles", "zai,zai",
  ])).toThrow("duplicate");
  expect(() => parseProgramBenchCampaignArgs([
    "--task", "a__b.1234567", "--profiles", "zai", "--controller", "single,contract",
  ])).toThrow("one controller");
  expect(() => parseProgramBenchCampaignArgs([
    "--task", "a__b.1234567", "--profiles", "zai", "--max-steps", "8", "--round-steps", "9",
  ])).toThrow("cannot exceed");
  const tooManyProfiles = Array.from({ length: 21 }, (_, index) => `p${index}`).join(",");
  expect(() => parseProgramBenchCampaignArgs([
    "--task", "a__b.1234567", "--profiles", tooManyProfiles, "--replicates", "3",
  ])).toThrow("60 cells");
});

test("ProgramBench campaign distinguishes controller zeroes from infrastructure failures", () => {
  const task = "a__b.1234567";
  const missing = completedResult(task);
  missing.runner.exitCode = 2;
  missing.runner.exitStatus = "artifact_missing";
  missing.runner.artifactSha256 = null;
  missing.evaluationStatus = "not_run";
  const cell: ProgramBenchCampaignCellState = {
    task,
    profile: "zai",
    replicate: 1,
    sampling: "provider-replicate",
    completionMode: "single",
    output: resolve("results/programbench-campaign/a/zai/single/replicate-01"),
    status: "failed",
    exitCode: 2,
    result: missing,
  };
  expect(isProgramBenchInfrastructureInvalidCell(cell, true)).toBe(false);
  expect(isProgramBenchInfrastructureInvalidCell({ ...cell, exitCode: 1, result: null }, true)).toBe(true);

  const evaluatorFailed = completedResult(task);
  evaluatorFailed.evaluationStatus = "failed";
  expect(isProgramBenchInfrastructureInvalidCell({
    ...cell,
    exitCode: 1,
    result: evaluatorFailed,
  }, true)).toBe(true);
});

test("ProgramBench campaign resumes only pending cells without rewriting interrupted work", () => {
  const root = resolve("results/programbench-resume");
  const initial = parseProgramBenchCampaignArgs([
    "--task", "a__b.1234567", "--profiles", "zai", "--replicates", "2",
    "--controllers", "single,contract", "--output", "results/programbench-resume",
  ]);
  const frozen = provenance(initial.tasks);
  const manifest = createProgramBenchCampaignManifest(initial, root, frozen, 123);
  manifest.cells[0]!.status = "completed";
  manifest.cells[0]!.exitCode = 0;
  manifest.cells[0]!.result = completedResult(manifest.cells[0]!.task);
  manifest.cells[1]!.status = "failed";
  manifest.cells[1]!.exitCode = 1;
  manifest.cells[2]!.status = "running";
  const resumed = resumeProgramBenchCampaignManifest(
    structuredClone(manifest),
    { ...initial, resume: true },
    root,
    frozen,
  );
  expect(resumed.cells.map((cell) => cell.status)).toEqual([
    "completed", "failed", "interrupted", "pending",
  ]);
  expect(resumed.cells[2]!.exitCode).toBeNull();
  expect(resumed.finishedAt).toBeNull();
});

test("ProgramBench campaign refuses to resume with changed compute or cell identity", () => {
  const root = resolve("results/programbench-resume");
  const initial = parseProgramBenchCampaignArgs([
    "--task", "a__b.1234567", "--profiles", "zai", "--output", "results/programbench-resume",
  ]);
  const frozen = provenance(initial.tasks);
  const manifest = createProgramBenchCampaignManifest(initial, root, frozen, 123);
  expect(() => resumeProgramBenchCampaignManifest(
    structuredClone(manifest),
    { ...initial, maxSteps: initial.maxSteps + 1, resume: true },
    root,
    frozen,
  )).toThrow("options do not match");
  const changedProvenance = structuredClone(frozen);
  changedProvenance.sourceSnapshotSha256 = "d".repeat(64);
  expect(() => resumeProgramBenchCampaignManifest(
    structuredClone(manifest),
    { ...initial, resume: true },
    root,
    changedProvenance,
  )).toThrow("provenance changed");
  const tampered = structuredClone(manifest);
  tampered.cells[0]!.output = resolve("somewhere-else");
  expect(() => resumeProgramBenchCampaignManifest(tampered, { ...initial, resume: true }, root, frozen))
    .toThrow("cells do not match");
  const inconsistent = structuredClone(manifest);
  inconsistent.cells[0]!.status = "completed";
  expect(() => resumeProgramBenchCampaignManifest(inconsistent, { ...initial, resume: true }, root, frozen))
    .toThrow("status is inconsistent");
});

test("ProgramBench campaign reports only complete paired multi-task evidence as improvement", () => {
  const options = parseProgramBenchCampaignArgs([
    "--task", "a__one.1234567",
    "--task", "b__two.2345678",
    "--task", "c__three.3456789",
    "--profiles", "zai",
    "--replicates", "3",
    "--controllers", "single,contract",
    "--evaluate",
  ]);
  const manifest = createProgramBenchCampaignManifest(
    options,
    resolve("results/programbench-summary"),
    provenance(options.tasks),
    123,
  );
  for (const cell of manifest.cells) {
    cell.status = "completed";
    cell.exitCode = 0;
    cell.result = evaluatedResult(
      cell.task,
      cell.completionMode === "contract" ? 0.4 : 0.2,
      cell.completionMode === "contract" ? 8 : 10,
      cell.completionMode === "contract" ? 800 : 1_000,
    );
  }
  manifest.finishedAt = 456;
  const summary = summarizeProgramBenchCampaign(manifest, 789);
  expect(summary.campaignComplete).toBeTrue();
  expect(summary.infrastructureValid).toBeTrue();
  expect(summary.paired.pairs).toBe(9);
  expect(summary.paired.meanScoreDeltaContractMinusSingle).toBeCloseTo(0.2);
  expect(summary.paired.oneSidedExactPValue).toBeLessThanOrEqual(0.05);
  expect(summary.improvementClaimEligible).toBeTrue();
  expect(summary.improvementSupported).toBeTrue();
  expect(summary.sotaClaimEligible).toBeFalse();

  const missing = manifest.cells[0]!;
  missing.status = "failed";
  missing.exitCode = 2;
  missing.result!.runner.exitCode = 2;
  missing.result!.runner.exitStatus = "artifact_missing";
  missing.result!.runner.artifactSha256 = null;
  missing.result!.evaluationStatus = "not_run";
  missing.result!.evaluation = null;
  const validZero = summarizeProgramBenchCampaign(manifest, 790);
  expect(validZero.infrastructureValid).toBeTrue();
  expect(validZero.modes.single?.artifactRate).toBeCloseTo(8 / 9);

  missing.result!.runner.exitStatus = "infrastructure_error";
  const invalid = summarizeProgramBenchCampaign(manifest, 790);
  expect(invalid.infrastructureValid).toBeFalse();
  expect(invalid.improvementClaimEligible).toBeFalse();
  expect(invalid.modes.single?.meanScore).toBeNull();
});
