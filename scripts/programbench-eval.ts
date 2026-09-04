import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { loadConfig } from "../src/adapters/config.ts";
import { executableOnPath } from "../src/core/sandbox.ts";
import { atomicWriteFileSync } from "../src/shared/atomic.ts";
import { resolveWindowsSystemExecutable } from "../src/shared/windows-system.ts";
import {
  HARBOR_HOST_RUNNER_BASENAME,
  HARBOR_RUNNER_HOME_ENV,
  buildTrustedExecutablePath,
  cleanupHarborStaging,
  collectBuildIdentity,
  hardenPrivateHarborRoot,
  harborProcessEnv,
  resolveDockerComposeProgramFiles,
  resolveHarborExecutables,
} from "./harbor-eval.ts";

export const PROGRAMBENCH_VERSION = "1.2.4";
export const PROGRAMBENCH_IMAGE_TAG = "task_cleanroom_v6";
export const PROGRAMBENCH_EVALUATOR_IMAGE = "neko-programbench-evaluator:1.2.4-linux-v4";
export const PROGRAMBENCH_EVALUATOR_MODE = "workspace-snapshot";
export const PROGRAMBENCH_RUN_RESULT_BASENAME = "_neko-programbench-run.json";
const DEFAULT_MAX_STEPS = 160;
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,127}__[a-z0-9][a-z0-9._-]{0,127}\.[a-f0-9]{7}$/;
const RUN_ID = /^[a-f0-9]{32}$/;

export interface ProgramBenchEvalOptions {
  task: string;
  profile?: string;
  output: string;
  maxSteps: number;
  implementationRoundSteps: number;
  reasoningEffort: string;
  completionMode: "single" | "self-review" | "contract";
  callBudget: number;
  evaluate: boolean;
}

export interface ProgramBenchProfile {
  profile: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxSteps: number;
  reasoningEffort: string;
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) throw new Error(`${flag} needs a value.`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error(`${flag} must be an integer from 1 to 1000.`);
  }
  return parsed;
}

function callBudget(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("--call-budget must be an integer from 1 to 10000.");
  }
  return parsed;
}

function boundedName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function boundedMetadata(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} SHA-256 is invalid.`);
  return normalized;
}

function taskId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!INSTANCE_ID.test(normalized)) throw new Error("ProgramBench task must be one official instance id.");
  return normalized;
}

export function parseProgramBenchEvalArgs(argv: string[]): ProgramBenchEvalOptions {
  let task = "";
  const options: ProgramBenchEvalOptions = {
    task: "",
    output: "results/programbench-smoke",
    maxSteps: DEFAULT_MAX_STEPS,
    implementationRoundSteps: 12,
    reasoningEffort: "max",
    completionMode: "single",
    callBudget: 0,
    evaluate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task") task = taskId(valueAfter(argv, i++, arg));
    else if (arg === "--profile") options.profile = boundedName(valueAfter(argv, i++, arg), "ProgramBench profile");
    else if (arg === "--output") options.output = valueAfter(argv, i++, arg);
    else if (arg === "--max-steps") options.maxSteps = positiveInteger(valueAfter(argv, i++, arg), arg);
    else if (arg === "--round-steps") options.implementationRoundSteps = positiveInteger(valueAfter(argv, i++, arg), arg);
    else if (arg === "--effort") options.reasoningEffort = boundedName(valueAfter(argv, i++, arg), "Reasoning effort");
    else if (arg === "--loop") options.completionMode = "self-review";
    else if (arg === "--no-loop") options.completionMode = "single";
    else if (arg === "--contract") options.completionMode = "contract";
    else if (arg === "--call-budget") options.callBudget = callBudget(valueAfter(argv, i++, arg));
    else if (arg === "--evaluate") options.evaluate = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  if (!task) throw new Error("ProgramBench evaluation requires --task <official-instance-id>.");
  if (options.implementationRoundSteps > options.maxSteps) {
    throw new Error("--round-steps cannot exceed --max-steps.");
  }
  options.task = task;
  if (!options.callBudget) options.callBudget = Math.min(10_000, options.maxSteps + 1);
  return options;
}

export function programBenchImage(instanceId: string): string {
  const task = taskId(instanceId);
  return `programbench/${task.replace("__", "_1776_")}:${PROGRAMBENCH_IMAGE_TAG}`;
}

function evaluatorRunId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!RUN_ID.test(normalized)) throw new Error("ProgramBench evaluator run id is invalid.");
  return normalized;
}

export function buildProgramBenchEvaluatorArgs(output: string, cpus: number, runId: string): string[] {
  if (!isAbsolute(output)) throw new Error("ProgramBench evaluator output path must be absolute.");
  if (!Number.isSafeInteger(cpus) || cpus < 1 || cpus > 256) {
    throw new Error("ProgramBench evaluator CPU count is invalid.");
  }
  const branchWorkers = Math.min(4, cpus);
  const owner = evaluatorRunId(runId);
  return [
    "run", "--rm",
    "--label", `dev.neko.programbench.run=${owner}`,
    "--env", `NEKO_PROGRAMBENCH_RUN_ID=${owner}`,
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", `${output}:/results`,
    PROGRAMBENCH_EVALUATOR_IMAGE,
    "eval", "/results",
    "--workers", "1",
    "--branch-workers", String(branchWorkers),
    "--docker-cpus", String(cpus),
  ];
}

const evaluatorMetadataSchema = z.object({
  schemaVersion: z.literal("neko.programbench.evaluator.v2"),
  mode: z.literal(PROGRAMBENCH_EVALUATOR_MODE),
  programbenchVersion: z.literal(PROGRAMBENCH_VERSION),
  shimSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotScope: z.literal("/workspace"),
  runId: z.string().regex(RUN_ID),
  instanceId: z.string().regex(INSTANCE_ID),
  score: z.number().min(0).max(1),
  resolvedTests: z.number().int().nonnegative(),
  scoredTests: z.number().int().nonnegative(),
  errorCode: z.string().min(1).nullable(),
  branchErrorCount: z.number().int().nonnegative(),
  systemErrorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
}).strict();

const evaluatorResultSchema = z.object({
  test_results: z.array(z.object({ status: z.string().min(1) }).passthrough()).min(1),
  error_code: z.string().nullable().optional(),
  executable_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

export interface ProgramBenchEvaluationResult {
  score: number;
  resolvedTests: number;
  scoredTests: number;
  rawTestCount: number;
  executableHash: string | null;
  errorCode: string | null;
  evaluatorMode: typeof PROGRAMBENCH_EVALUATOR_MODE;
  programbenchVersion: typeof PROGRAMBENCH_VERSION;
  evaluatorShimSha256: string;
  warningCount: number;
  systemErrorCount: number;
  branchErrorCount: number;
}

const evaluationResultSchema = z.object({
  score: z.number().min(0).max(1),
  resolvedTests: z.number().int().nonnegative(),
  scoredTests: z.number().int().nonnegative(),
  rawTestCount: z.number().int().nonnegative(),
  executableHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errorCode: z.string().min(1).nullable(),
  evaluatorMode: z.literal(PROGRAMBENCH_EVALUATOR_MODE),
  programbenchVersion: z.literal(PROGRAMBENCH_VERSION),
  evaluatorShimSha256: z.string().regex(/^[a-f0-9]{64}$/),
  warningCount: z.number().int().nonnegative(),
  systemErrorCount: z.number().int().nonnegative(),
  branchErrorCount: z.number().int().nonnegative(),
}).strict();

const implementationIdentitySchema = z.object({
  hostRunnerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  launcherSha256: z.string().regex(/^[a-f0-9]{64}$/),
  environmentRunnerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  remoteToolsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const trajectorySchema = z.object({
  schemaVersion: z.literal("neko.programbench.trajectory.v2"),
  instanceId: z.string().regex(INSTANCE_ID),
  exitStatus: z.enum(["completed", "artifact_missing", "infrastructure_error"]),
  artifact: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().nullable(),
  profile: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceDirty: z.boolean(),
  implementation: implementationIdentitySchema,
  timeBudgetExhausted: z.boolean(),
  providerCallBudgetExhausted: z.boolean(),
  metrics: z.object({
    providerCompleteCalls: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    wallTimeMs: z.number().int().nonnegative(),
    toolCalls: z.object({
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }).passthrough(),
  }).passthrough().nullable(),
  lastCheckpoint: z.object({
    providerCompleteCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    toolCalls: z.object({
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }).passthrough(),
    progress: z.object({
      artifactCheckpoints: z.number().int().nonnegative(),
      validationState: z.string().min(1).max(128),
    }).passthrough(),
  }).passthrough().nullable(),
}).passthrough();

const runnerResultSchema = z.object({
  exitCode: z.number().int().nonnegative(),
  exitStatus: z.enum(["completed", "artifact_missing", "infrastructure_error"]),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  profile: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceDirty: z.boolean(),
  implementation: implementationIdentitySchema,
  providerCompleteCalls: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  toolCallsCompleted: z.number().int().nonnegative().nullable(),
  toolCallsFailed: z.number().int().nonnegative().nullable(),
  wallTimeMs: z.number().int().nonnegative().nullable(),
  artifactCheckpoints: z.number().int().nonnegative().nullable(),
  validationState: z.string().min(1).max(128).nullable(),
  timeBudgetExhausted: z.boolean(),
  providerCallBudgetExhausted: z.boolean(),
}).strict();

export type ProgramBenchRunnerResult = z.infer<typeof runnerResultSchema>;

export interface ProgramBenchRunResult {
  schemaVersion: "neko.programbench.run.v2";
  task: string;
  runner: ProgramBenchRunnerResult;
  evaluationStatus: "not_requested" | "not_run" | "pending" | "completed" | "failed";
  evaluation: ProgramBenchEvaluationResult | null;
  updatedAt: number;
}

export const programBenchRunResultSchema = z.object({
  schemaVersion: z.literal("neko.programbench.run.v2"),
  task: z.string().regex(INSTANCE_ID),
  runner: runnerResultSchema,
  evaluationStatus: z.enum(["not_requested", "not_run", "pending", "completed", "failed"]),
  evaluation: evaluationResultSchema.nullable(),
  updatedAt: z.number().int().positive(),
}).strict();

export function verifyProgramBenchEvaluatorOutput(
  output: string,
  task: string,
  expectedShimSha256: string,
  expectedRunId: string,
): ProgramBenchEvaluationResult {
  if (!isAbsolute(output)) throw new Error("ProgramBench evaluator output path must be absolute.");
  const instanceId = taskId(task);
  const expectedSha = sha256(expectedShimSha256, "evaluator shim");
  let metadata: z.infer<typeof evaluatorMetadataSchema>;
  const metadataPath = join(output, "_neko-evaluator.json");
  try {
    metadata = evaluatorMetadataSchema.parse(JSON.parse(readFileSync(metadataPath, "utf8")));
  } catch {
    throw new Error("ProgramBench evaluator did not produce valid metadata.");
  }
  if (metadata.shimSha256 !== expectedSha) {
    throw new Error("ProgramBench evaluator shim identity does not match the source under test.");
  }
  if (metadata.runId !== evaluatorRunId(expectedRunId) || metadata.instanceId !== instanceId) {
    throw new Error("ProgramBench evaluator result does not belong to this run.");
  }
  if (metadata.errorCode === "LocalEntryNotFoundError" || metadata.errorCode === "no_submission") {
    if (metadata.score !== 0 || metadata.resolvedTests !== 0 || metadata.scoredTests !== 0 ||
      metadata.systemErrorCount !== 0 || metadata.branchErrorCount !== 0) {
      throw new Error("ProgramBench invalid-deliverable result is inconsistent.");
    }
    return {
      score: 0,
      resolvedTests: 0,
      scoredTests: 0,
      rawTestCount: 0,
      executableHash: null,
      errorCode: metadata.errorCode,
      evaluatorMode: metadata.mode,
      programbenchVersion: metadata.programbenchVersion,
      evaluatorShimSha256: metadata.shimSha256,
      warningCount: metadata.warningCount,
      systemErrorCount: metadata.systemErrorCount,
      branchErrorCount: metadata.branchErrorCount,
    };
  }
  if (metadata.errorCode) throw new Error(`ProgramBench evaluator reported ${metadata.errorCode}.`);
  let result: z.infer<typeof evaluatorResultSchema>;
  try {
    result = evaluatorResultSchema.parse(JSON.parse(readFileSync(
      join(output, instanceId, `${instanceId}.eval.json`),
      "utf8",
    )));
  } catch {
    throw new Error("ProgramBench evaluator did not produce a valid, complete result.");
  }
  if (metadata.resolvedTests > metadata.scoredTests || metadata.scoredTests > result.test_results.length) {
    throw new Error("ProgramBench evaluator score counts are inconsistent.");
  }
  if (result.error_code?.trim()) {
    throw new Error(`ProgramBench evaluator reported ${result.error_code.trim()}.`);
  }
  return {
    score: metadata.score,
    resolvedTests: metadata.resolvedTests,
    scoredTests: metadata.scoredTests,
    rawTestCount: result.test_results.length,
    executableHash: result.executable_hash,
    errorCode: null,
    evaluatorMode: metadata.mode,
    programbenchVersion: metadata.programbenchVersion,
    evaluatorShimSha256: metadata.shimSha256,
    warningCount: metadata.warningCount,
    systemErrorCount: metadata.systemErrorCount,
    branchErrorCount: metadata.branchErrorCount,
  };
}

export function readProgramBenchRunnerResult(
  output: string,
  task: string,
  exitCode: number,
): ProgramBenchRunnerResult {
  if (!isAbsolute(output)) throw new Error("ProgramBench run output path must be absolute.");
  const instanceId = taskId(task);
  if (!Number.isSafeInteger(exitCode) || exitCode < 0) throw new Error("ProgramBench runner exit code is invalid.");
  let trajectory: z.infer<typeof trajectorySchema>;
  try {
    trajectory = trajectorySchema.parse(JSON.parse(readFileSync(
      join(output, instanceId, `${instanceId}.traj.json`),
      "utf8",
    )));
  } catch {
    throw new Error("ProgramBench runner trajectory is missing or invalid.");
  }
  if (trajectory.instanceId !== instanceId) throw new Error("ProgramBench runner trajectory task does not match.");
  const checkpoint = trajectory.lastCheckpoint;
  const metrics = trajectory.metrics;
  return {
    exitCode,
    exitStatus: trajectory.exitStatus,
    artifactSha256: trajectory.artifact?.sha256 ?? null,
    profile: trajectory.profile,
    model: trajectory.model,
    sourceRevision: trajectory.sourceRevision,
    sourceDirty: trajectory.sourceDirty,
    implementation: trajectory.implementation,
    providerCompleteCalls: checkpoint?.providerCompleteCalls ?? metrics?.providerCompleteCalls ?? null,
    totalTokens: checkpoint?.totalTokens ?? metrics?.totalTokens ?? null,
    toolCallsCompleted: checkpoint?.toolCalls.completed ?? metrics?.toolCalls.completed ?? null,
    toolCallsFailed: checkpoint?.toolCalls.failed ?? metrics?.toolCalls.failed ?? null,
    wallTimeMs: checkpoint?.wallTimeMs ?? metrics?.wallTimeMs ?? null,
    artifactCheckpoints: checkpoint?.progress.artifactCheckpoints ?? null,
    validationState: checkpoint?.progress.validationState ?? null,
    timeBudgetExhausted: trajectory.timeBudgetExhausted,
    providerCallBudgetExhausted: trajectory.providerCallBudgetExhausted,
  };
}

export function readProgramBenchRunResult(output: string, task: string): ProgramBenchRunResult {
  if (!isAbsolute(output)) throw new Error("ProgramBench run output path must be absolute.");
  let result: ProgramBenchRunResult;
  try {
    result = programBenchRunResultSchema.parse(JSON.parse(readFileSync(join(output, PROGRAMBENCH_RUN_RESULT_BASENAME), "utf8")));
  } catch {
    throw new Error("ProgramBench run result is missing or invalid.");
  }
  if (result.task !== taskId(task)) throw new Error("ProgramBench run result task does not match the campaign cell.");
  return result;
}

function writeProgramBenchRunResult(
  output: string,
  task: string,
  runner: ProgramBenchRunnerResult,
  evaluationStatus: ProgramBenchRunResult["evaluationStatus"],
  evaluation: ProgramBenchEvaluationResult | null,
): void {
  const result = programBenchRunResultSchema.parse({
    schemaVersion: "neko.programbench.run.v2",
    task: taskId(task),
    runner,
    evaluationStatus,
    evaluation,
    updatedAt: Date.now(),
  });
  if ((evaluationStatus === "completed") !== (evaluation !== null)) {
    throw new Error("ProgramBench run evaluation status is inconsistent.");
  }
  atomicWriteFileSync(
    join(output, PROGRAMBENCH_RUN_RESULT_BASENAME),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

export function buildProgramBenchRunnerArgs(input: {
  pythonRunner: string;
  runnerPath: string;
  uvCacheDir: string;
  task: string;
  output: string;
  maxSteps: number;
  implementationRoundSteps: number;
  reasoningEffort: string;
  completionMode: "single" | "self-review" | "contract";
  callBudget: number;
  sourceRevision: string;
  sourceDirty: boolean;
  profile: string;
  model: string;
  hostRunnerSha256: string;
  launcherSha256: string;
  environmentRunnerSha256: string;
  remoteToolsSha256: string;
  runId: string;
}): string[] {
  if (!isAbsolute(input.pythonRunner) || !isAbsolute(input.runnerPath) || !isAbsolute(input.uvCacheDir) ||
    !isAbsolute(input.output)) {
    throw new Error("ProgramBench runner paths must be absolute.");
  }
  if (!/^[a-f0-9]{40,64}$/i.test(input.sourceRevision)) throw new Error("ProgramBench source revision is invalid.");
  const runId = evaluatorRunId(input.runId);
  const args = [
    "run", "--cache-dir", input.uvCacheDir, "--offline", "--isolated", "--no-config", "--no-project",
    "--with", `programbench==${PROGRAMBENCH_VERSION}`,
    "python", input.pythonRunner,
    "--runner", input.runnerPath,
    "--task", taskId(input.task),
    "--output", input.output,
    "--run-id", runId,
    "--max-steps", String(positiveInteger(String(input.maxSteps), "--max-steps")),
    "--round-steps", String(positiveInteger(String(input.implementationRoundSteps), "--round-steps")),
    "--effort", boundedName(input.reasoningEffort, "Reasoning effort"),
    input.completionMode === "contract" ? "--contract"
      : input.completionMode === "self-review" ? "--loop" : "--no-loop",
    "--call-budget", String(callBudget(String(input.callBudget))),
    "--source-revision", input.sourceRevision.toLowerCase(),
  ];
  if (input.sourceDirty) args.push("--source-dirty");
  args.push(
    "--profile", boundedName(input.profile, "ProgramBench profile"),
    "--model", boundedMetadata(input.model, "ProgramBench model"),
    "--host-runner-sha256", sha256(input.hostRunnerSha256, "host runner"),
    "--launcher-sha256", sha256(input.launcherSha256, "launcher"),
    "--environment-runner-sha256", sha256(input.environmentRunnerSha256, "environment runner"),
    "--remote-tools-sha256", sha256(input.remoteToolsSha256, "remote tools"),
  );
  return args;
}

function resolveProgramBenchUvCacheDir(uv: string, root: string): string {
  const resolvedRoot = realpathSync.native(resolve(root));
  const result = Bun.spawnSync([uv, "cache", "dir", "--no-config"], {
    cwd: resolvedRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const candidate = result.stdout.toString("utf8").trim();
  if (result.exitCode !== 0 || !candidate || candidate.length > 4_096 || !isAbsolute(candidate) ||
    /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error("ProgramBench could not resolve a trusted uv package cache.");
  }
  const canonical = realpathSync.native(candidate);
  if (!lstatSync(canonical).isDirectory()) throw new Error("ProgramBench uv package cache is not a directory.");
  const contained = relative(resolvedRoot, canonical);
  if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    return canonical;
  }
  throw new Error("ProgramBench refuses a uv package cache inside the source workspace.");
}

export function writeProgramBenchProfile(root: string, profile: ProgramBenchProfile): string {
  const canonicalRoot = realpathSync.native(resolve(root));
  if (!lstatSync(canonicalRoot).isDirectory()) throw new Error("ProgramBench runner home is invalid.");
  const name = boundedName(profile.profile, "ProgramBench profile");
  if (profile.provider !== "anthropic" && profile.provider !== "openai_compat") {
    throw new Error("ProgramBench pilot supports API-key Anthropic or OpenAI-compatible profiles.");
  }
  const model = profile.model.trim();
  if (!model || model.length > 256) throw new Error("ProgramBench model is invalid.");
  let endpoint: URL;
  try { endpoint = new URL(profile.baseUrl); } catch { throw new Error("ProgramBench base URL is invalid."); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("ProgramBench base URL must be one credential-free HTTPS endpoint.");
  }
  if (!profile.apiKey.trim()) throw new Error("ProgramBench profile has no API key.");
  if (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow < 1) {
    throw new Error("ProgramBench context window is invalid.");
  }
  const nekoDir = join(canonicalRoot, ".neko-core");
  mkdirSync(nekoDir, { recursive: true, mode: 0o700 });
  const path = join(nekoDir, "config.json");
  writeFileSync(path, `${JSON.stringify({
    active_profile: name,
    max_steps: positiveInteger(String(profile.maxSteps), "max_steps"),
    reasoning_effort: boundedName(profile.reasoningEffort, "Reasoning effort"),
    auto_update: false,
    profiles: {
      [name]: {
        provider: profile.provider,
        model,
        base_url: endpoint.toString().replace(/\/$/, ""),
        api_key: profile.apiKey,
        model_context: { [model]: profile.contextWindow },
      },
    },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

async function run(command: string, args: string[], cwd: string, env: Record<string, string>, quiet = false): Promise<number> {
  if (!isAbsolute(command)) throw new Error("ProgramBench launcher refuses a non-absolute executable.");
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return child.exited;
}

async function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  if (!isAbsolute(command)) throw new Error("ProgramBench launcher refuses a non-absolute executable.");
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout };
}

export function buildProgramBenchEvaluatorListArgs(runId: string): string[] {
  return ["ps", "--all", "--quiet", "--filter", `label=dev.neko.programbench.run=${evaluatorRunId(runId)}`];
}

async function cleanupProgramBenchEvaluatorContainers(
  docker: string,
  runId: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const listed = await runCaptured(docker, buildProgramBenchEvaluatorListArgs(runId), cwd, env);
  if (listed.code !== 0) throw new Error("ProgramBench evaluator containers could not be enumerated for cleanup.");
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) {
    throw new Error("ProgramBench evaluator cleanup received an invalid container id.");
  }
  for (const id of ids) {
    if (await run(docker, ["rm", "--force", id], cwd, env, true) === 0) continue;
    if (await run(docker, ["container", "inspect", id], cwd, env, true) === 0) {
      throw new Error("ProgramBench evaluator container could not be removed.");
    }
  }
}

export function buildProgramBenchEvaluatorGuardArgs(output: string, runId: string): string[] {
  if (!isAbsolute(output)) throw new Error("ProgramBench evaluator guard output path must be absolute.");
  const owner = evaluatorRunId(runId);
  const heartbeat = `/watch/.neko-programbench-heartbeat-${owner}`;
  const script = [
    `heartbeat=${heartbeat}`,
    "while [ -f \"$heartbeat\" ]; do",
    "  first=$(stat -c %Y \"$heartbeat\" 2>/dev/null || echo missing)",
    "  sleep 5",
    "  second=$(stat -c %Y \"$heartbeat\" 2>/dev/null || echo missing)",
    "  if [ \"$first\" = \"$second\" ]; then",
    "    sleep 5",
    "    third=$(stat -c %Y \"$heartbeat\" 2>/dev/null || echo missing)",
    "    [ \"$second\" = \"$third\" ] && break",
    "  fi",
    "done",
    "for attempt in 1 2 3; do",
    `  ids=$(docker ps --all --quiet --filter label=dev.neko.programbench.run=${owner})`,
    "  [ -z \"$ids\" ] && break",
    "  docker rm --force $ids >/dev/null 2>&1 || true",
    "  sleep 1",
    "done",
    "rm -f \"$heartbeat\"",
    `ids=$(docker ps --all --quiet --filter label=dev.neko.programbench.run=${owner})`,
    "[ -z \"$ids\" ]",
  ].join("\n");
  return [
    "run", "--detach", "--rm",
    "--name", `neko-programbench-guard-${owner}`,
    "--label", `dev.neko.programbench.guard=${owner}`,
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", `${output}:/watch`,
    "--entrypoint", "/bin/sh",
    PROGRAMBENCH_EVALUATOR_IMAGE,
    "-c", script,
  ];
}

function buildProgramBenchEvaluatorGuardListArgs(runId: string): string[] {
  return ["ps", "--all", "--quiet", "--filter", `label=dev.neko.programbench.guard=${evaluatorRunId(runId)}`];
}

async function launchProgramBenchEvaluatorGuard(
  docker: string,
  output: string,
  runId: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const launched = await runCaptured(docker, buildProgramBenchEvaluatorGuardArgs(output, runId), cwd, env);
  if (launched.code !== 0 || !/^[a-f0-9]{12,64}$/.test(launched.stdout.trim())) {
    throw new Error("ProgramBench evaluator cleanup guard could not start.");
  }
}

async function awaitProgramBenchEvaluatorGuard(
  docker: string,
  runId: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const listed = await runCaptured(docker, buildProgramBenchEvaluatorGuardListArgs(runId), cwd, env);
    if (listed.code !== 0) throw new Error("ProgramBench evaluator cleanup guard could not be inspected.");
    if (!listed.stdout.trim()) return;
    await Bun.sleep(500);
  }
  throw new Error("ProgramBench evaluator cleanup guard did not exit.");
}

interface ProgramBenchContainerLease {
  runId: string;
  close(): Promise<void>;
}

async function acquireProgramBenchContainerLease(
  docker: string,
  output: string,
  cwd: string,
  env: Record<string, string>,
): Promise<ProgramBenchContainerLease> {
  const runId = randomBytes(16).toString("hex");
  const heartbeatPath = join(output, `.neko-programbench-heartbeat-${runId}`);
  writeFileSync(heartbeatPath, `${Date.now()}\n`, { encoding: "ascii", flag: "wx" });
  try { await launchProgramBenchEvaluatorGuard(docker, output, runId, cwd, env); }
  catch (error) {
    if (existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
    throw error;
  }
  const heartbeat = setInterval(() => {
    try { writeFileSync(heartbeatPath, `${Date.now()}\n`, { encoding: "ascii" }); }
    catch { clearInterval(heartbeat); }
  }, 1_000);
  let closed = false;
  return {
    runId,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      let cleanupError: Error | null = null;
      try { await cleanupProgramBenchEvaluatorContainers(docker, runId, cwd, env); }
      catch (error) { cleanupError = error instanceof Error ? error : new Error(String(error)); }
      if (existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
      await awaitProgramBenchEvaluatorGuard(docker, runId, cwd, env);
      if (cleanupError) throw cleanupError;
    },
  };
}

export async function runManagedProgramBenchEvaluator(
  docker: string,
  output: string,
  cpus: number,
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; runId: string }> {
  const lease = await acquireProgramBenchContainerLease(docker, output, cwd, env);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    try { child?.kill(); } catch {}
  };
  let listening = false;
  try {
    child = Bun.spawn([docker, ...buildProgramBenchEvaluatorArgs(output, cpus, lease.runId)], {
      cwd,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    listening = true;
    const code = await child.exited;
    return { code: interrupted ? 130 : code, runId: lease.runId };
  } finally {
    if (listening) {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    await lease.close();
  }
}

async function dockerCpuCount(docker: string, cwd: string, env: Record<string, string>): Promise<number> {
  const child = Bun.spawn([docker, "info", "--format", "{{.NCPU}}"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Docker CPU capacity could not be measured.");
  const cpus = Number(stdout.trim());
  if (!Number.isSafeInteger(cpus) || cpus < 1 || cpus > 256) {
    throw new Error("Docker reported an invalid CPU capacity.");
  }
  return cpus;
}

async function ensureProgramBenchEvaluator(
  docker: string,
  root: string,
  cwd: string,
  env: Record<string, string>,
): Promise<number> {
  if (await run(docker, ["image", "inspect", PROGRAMBENCH_EVALUATOR_IMAGE], cwd, env, true) === 0) return 0;
  const context = join(root, "evals", "programbench");
  return run(docker, [
    "build",
    "--file", join(context, "Dockerfile.evaluator"),
    "--tag", PROGRAMBENCH_EVALUATOR_IMAGE,
    context,
  ], cwd, env);
}

async function main(): Promise<number> {
  const root = realpathSync.native(resolve(import.meta.dir, ".."));
  const options = parseProgramBenchEvalArgs(process.argv.slice(2));
  const cfg = loadConfig({ cwd: root, profile: options.profile });
  if (!cfg.profile) throw new Error("ProgramBench needs an active API-key profile.");
  if (!cfg.apiKey) throw new Error(`ProgramBench profile ${cfg.profile} has no API key.`);
  if (cfg.provider !== "anthropic" && cfg.provider !== "openai_compat") {
    throw new Error("ProgramBench pilot supports API-key Anthropic or OpenAI-compatible profiles.");
  }
  if (cfg.isLocalEndpoint) throw new Error("ProgramBench pilot refuses a local provider endpoint.");

  const executables = resolveHarborExecutables(root);
  const uv = executableOnPath(process.platform === "win32" ? "uv.exe" : "uv", process.env.PATH ?? "", root);
  if (!uv) throw new Error("Trusted uv executable was not found outside the workspace.");
  const uvCacheDir = resolveProgramBenchUvCacheDir(uv, root);
  const optionalNode = executableOnPath(process.platform === "win32" ? "node.exe" : "node", process.env.PATH ?? "", root);
  const optionalWindowsSystem = process.platform === "win32" ? resolveWindowsSystemExecutable("cmd.exe") : null;
  const trustedPath = buildTrustedExecutablePath(root, [
    ...(optionalNode ? [optionalNode] : []),
    realpathSync.native(process.execPath),
    executables.git,
    executables.docker,
    uv,
    ...(optionalWindowsSystem ? [optionalWindowsSystem] : []),
  ]);
  const buildRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-eval-")));
  let privateRoot = "";
  try {
    privateRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-private-")));
    hardenPrivateHarborRoot(privateRoot);
    const runtimeRoot = join(buildRoot, "runtime");
    for (const directory of [runtimeRoot, join(runtimeRoot, "tmp"), join(runtimeRoot, "AppData", "Roaming"), join(runtimeRoot, "AppData", "Local")]) {
      mkdirSync(directory, { recursive: true });
    }
    const dockerProgramFiles = resolveDockerComposeProgramFiles(root, executables.docker);
    const baseEnv = harborProcessEnv(process.env, trustedPath, runtimeRoot, undefined, dockerProgramFiles);
    if (await run(executables.docker, ["info", "--format", "{{.ServerVersion}}"], buildRoot, baseEnv, true) !== 0) {
      throw new Error("Docker Desktop is not running.");
    }

    const runnerPath = join(buildRoot, HARBOR_HOST_RUNNER_BASENAME);
    console.log("Building the credential-safe ProgramBench host runner...");
    const built = await run(process.execPath, [
      "build", join(root, "evals", "harbor", "host_runner.ts"), "--compile",
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", `--outfile=${runnerPath}`,
    ], buildRoot, baseEnv);
    if (built !== 0) return built;
    const identity = collectBuildIdentity(root, runnerPath, cfg.profile, {
      gitExecutable: executables.git,
      launcherCwd: buildRoot,
      sourceEnv: baseEnv,
      trustedPath,
    });

    const runnerHome = join(privateRoot, "runner-home");
    const bridge = join(privateRoot, "bridge");
    for (const directory of [runnerHome, join(runnerHome, "tmp"), join(runnerHome, "AppData", "Roaming"),
      join(runnerHome, "AppData", "Local"), join(bridge, "evals", "harbor"), join(bridge, "evals", "programbench")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    for (const packageFile of [join(bridge, "evals", "__init__.py"), join(bridge, "evals", "harbor", "__init__.py"),
      join(bridge, "evals", "programbench", "__init__.py")]) {
      writeFileSync(packageFile, "", { encoding: "ascii", mode: 0o600, flag: "wx" });
    }
    copyFileSync(join(root, "evals", "harbor", "remote_tools.py"), join(bridge, "evals", "harbor", "remote_tools.py"));
    const pythonRunner = join(bridge, "evals", "programbench", "runner.py");
    copyFileSync(join(root, "evals", "programbench", "runner.py"), pythonRunner);
    writeProgramBenchProfile(runnerHome, {
      profile: cfg.profile,
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      contextWindow: cfg.contextWindow,
      maxSteps: options.maxSteps,
      reasoningEffort: options.reasoningEffort,
    });

    if (await ensureProgramBenchEvaluator(executables.docker, root, buildRoot, baseEnv) !== 0) {
      return 1;
    }
    const output = resolve(root, options.output);
    mkdirSync(output, { recursive: true });
    const launcherEnv = {
      ...baseEnv,
      PYTHONPATH: bridge,
      [HARBOR_RUNNER_HOME_ENV]: runnerHome,
    };
    console.log(`ProgramBench ${PROGRAMBENCH_VERSION}: ${options.task}`);
    console.log(`profile=${cfg.profile}, model=${cfg.model}, max_steps=${options.maxSteps}, ` +
      `round_steps=${options.implementationRoundSteps}, controller=${options.completionMode}, call_budget=${options.callBudget}`);
    console.log(`image=${programBenchImage(options.task)}`);
    console.log(`host runner sha256=${identity.runnerSha256}; source=${identity.sourceRevision}${identity.sourceDirty ? " (dirty)" : ""}`);
    const cleanroomLease = await acquireProgramBenchContainerLease(
      executables.docker,
      output,
      buildRoot,
      baseEnv,
    );
    let code: number;
    try {
      code = await run(uv, buildProgramBenchRunnerArgs({
        pythonRunner,
        runnerPath: identity.runnerPath,
        uvCacheDir,
        task: options.task,
        output,
        maxSteps: options.maxSteps,
        implementationRoundSteps: options.implementationRoundSteps,
        reasoningEffort: options.reasoningEffort,
        completionMode: options.completionMode,
        callBudget: options.callBudget,
        sourceRevision: identity.sourceRevision,
        sourceDirty: identity.sourceDirty,
        profile: cfg.profile,
        model: cfg.model,
        hostRunnerSha256: identity.runnerSha256,
        launcherSha256: sha256File(join(root, "scripts", "programbench-eval.ts")),
        environmentRunnerSha256: sha256File(join(root, "evals", "programbench", "runner.py")),
        remoteToolsSha256: sha256File(join(root, "evals", "harbor", "remote_tools.py")),
        runId: cleanroomLease.runId,
      }), buildRoot, launcherEnv);
    } finally {
      await cleanroomLease.close();
    }
    const runner = readProgramBenchRunnerResult(output, options.task, code);
    if (code !== 0) {
      writeProgramBenchRunResult(output, options.task, runner, "not_run", null);
      return code;
    }
    if (!options.evaluate) {
      writeProgramBenchRunResult(output, options.task, runner, "not_requested", null);
      return 0;
    }
    writeProgramBenchRunResult(output, options.task, runner, "pending", null);
    try {
      const evaluatorCpus = await dockerCpuCount(executables.docker, buildRoot, baseEnv);
      console.log(`Scoring through the pinned Linux evaluator (${evaluatorCpus} CPUs)...`);
      const evaluator = await runManagedProgramBenchEvaluator(
        executables.docker,
        output,
        evaluatorCpus,
        buildRoot,
        baseEnv,
      );
      if (evaluator.code !== 0) {
        writeProgramBenchRunResult(output, options.task, runner, "failed", null);
        return evaluator.code;
      }
      const shimSha256 = sha256File(join(root, "evals", "programbench", "workspace_snapshot_evaluator.py"));
      const verified = verifyProgramBenchEvaluatorOutput(
        output,
        options.task,
        shimSha256,
        evaluator.runId,
      );
      writeProgramBenchRunResult(output, options.task, runner, "completed", verified);
      console.log(`Evaluator result verified (${verified.rawTestCount} raw tests, ` +
        `${(verified.score * 100).toFixed(2)} score).`);
      return 0;
    } catch (error) {
      writeProgramBenchRunResult(output, options.task, runner, "failed", null);
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  } finally {
    cleanupHarborStaging(privateRoot, buildRoot);
  }
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`programbench-eval: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
