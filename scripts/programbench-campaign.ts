import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import {
  PROGRAMBENCH_EVALUATOR_IMAGE,
  parseProgramBenchEvalArgs,
  programBenchImage,
  programBenchRunResultSchema,
  readProgramBenchRunResult,
  type ProgramBenchRunResult,
} from "./programbench-eval.ts";
import { resolveHarborExecutables } from "./harbor-eval.ts";
import { atomicWriteFileSync } from "../src/shared/atomic.ts";

type CompletionMode = "single" | "self-review" | "contract";
export const PROGRAMBENCH_CAMPAIGN_SUMMARY_BASENAME = "campaign-summary.json";

export interface ProgramBenchCampaignOptions {
  tasks: string[];
  profiles: string[];
  replicates: number;
  output: string;
  maxSteps: number;
  implementationRoundSteps: number;
  callBudget: number;
  completionModes: CompletionMode[];
  reasoningEffort: string;
  evaluate: boolean;
  resume: boolean;
}

export interface ProgramBenchCampaignCell {
  task: string;
  profile: string;
  replicate: number;
  sampling: "provider-replicate";
  completionMode: CompletionMode;
  output: string;
}

export interface ProgramBenchCampaignCellState extends ProgramBenchCampaignCell {
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  exitCode: number | null;
  result: ProgramBenchRunResult | null;
}

type ProgramBenchCampaignConfig = Omit<ProgramBenchCampaignOptions, "resume">;

export interface ProgramBenchCampaignManifest {
  schemaVersion: "neko.programbench.campaign.v3";
  programbenchVersion: "1.2.4";
  sampling: "provider-replicate";
  startedAt: number;
  provenance: ProgramBenchCampaignProvenance;
  options: ProgramBenchCampaignConfig;
  cells: ProgramBenchCampaignCellState[];
  finishedAt: number | null;
}

export interface ProgramBenchCampaignProvenance {
  sourceRevision: string;
  sourceDirty: boolean;
  sourceSnapshotSha256: string;
  componentSha256: {
    campaign: string;
    launcher: string;
    evaluatorShim: string;
    environmentRunner: string;
    hostRunner: string;
    remoteTools: string;
  };
  evaluatorImage: { reference: string; id: string };
  taskImages: Record<string, { reference: string; id: string }>;
}

export interface ProgramBenchCampaignModeSummary {
  plannedCells: number;
  validCells: number;
  artifactRate: number | null;
  meanScore: number | null;
  meanProviderCalls: number | null;
  meanTotalTokens: number | null;
  meanWallTimeMs: number | null;
}

export interface ProgramBenchCampaignSummary {
  schemaVersion: "neko.programbench.campaign-summary.v1";
  campaignComplete: boolean;
  infrastructureValid: boolean;
  computeMatched: true;
  modes: Partial<Record<CompletionMode, ProgramBenchCampaignModeSummary>>;
  paired: {
    pairs: number;
    meanScoreDeltaContractMinusSingle: number | null;
    meanArtifactDeltaContractMinusSingle: number | null;
    meanProviderCallDeltaContractMinusSingle: number | null;
    meanTokenDeltaContractMinusSingle: number | null;
    oneSidedExactPValue: number | null;
  };
  improvementClaimEligible: boolean;
  improvementSupported: boolean;
  sotaClaimEligible: false;
  generatedAt: number;
}

const campaignConfigSchema = z.object({
  tasks: z.array(z.string().min(1).max(128)).min(1).max(60),
  profiles: z.array(z.string().min(1).max(128)).min(1).max(60),
  replicates: z.number().int().min(1).max(10),
  output: z.string().min(1).max(1_024),
  maxSteps: z.number().int().min(1).max(1_000),
  implementationRoundSteps: z.number().int().min(1).max(1_000),
  callBudget: z.number().int().min(1).max(10_000),
  completionModes: z.array(z.enum(["single", "self-review", "contract"])).min(1).max(3),
  reasoningEffort: z.string().min(1).max(128),
  evaluate: z.boolean(),
}).strict();

const campaignCellSchema = z.object({
  task: z.string().min(1).max(128),
  profile: z.string().min(1).max(128),
  replicate: z.number().int().min(1).max(10),
  sampling: z.literal("provider-replicate"),
  completionMode: z.enum(["single", "self-review", "contract"]),
  output: z.string().min(1).max(4_096),
  status: z.enum(["pending", "running", "completed", "failed", "interrupted"]),
  exitCode: z.number().int().nonnegative().nullable(),
  result: programBenchRunResultSchema.nullable(),
}).strict();

const imageIdentitySchema = z.object({
  reference: z.string().min(1).max(512),
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

const campaignProvenanceSchema = z.object({
  sourceRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceDirty: z.boolean(),
  sourceSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  componentSha256: z.object({
    campaign: z.string().regex(/^[a-f0-9]{64}$/),
    launcher: z.string().regex(/^[a-f0-9]{64}$/),
    evaluatorShim: z.string().regex(/^[a-f0-9]{64}$/),
    environmentRunner: z.string().regex(/^[a-f0-9]{64}$/),
    hostRunner: z.string().regex(/^[a-f0-9]{64}$/),
    remoteTools: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  evaluatorImage: imageIdentitySchema,
  taskImages: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}__[a-z0-9][a-z0-9._-]{0,127}\.[a-f0-9]{7}$/), imageIdentitySchema),
}).strict();

const campaignManifestSchema = z.object({
  schemaVersion: z.literal("neko.programbench.campaign.v3"),
  programbenchVersion: z.literal("1.2.4"),
  sampling: z.literal("provider-replicate"),
  startedAt: z.number().int().positive(),
  provenance: campaignProvenanceSchema,
  options: campaignConfigSchema,
  cells: z.array(campaignCellSchema).min(1).max(60),
  finishedAt: z.number().int().positive().nullable(),
}).strict();

function next(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) throw new Error(`${flag} needs a value.`);
  return value;
}

function integer(value: string, flag: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${flag} must be an integer from 1 to ${max}.`);
  }
  return parsed;
}

function name(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function unique<T extends string>(values: T[], label: string): T[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains a duplicate.`);
  return values;
}

function completionMode(value: string): CompletionMode {
  if (value !== "single" && value !== "self-review" && value !== "contract") {
    throw new Error("Controller must be single, self-review, or contract.");
  }
  return value;
}

function configOf(options: ProgramBenchCampaignOptions): ProgramBenchCampaignConfig {
  const { resume: _resume, ...config } = options;
  return config;
}

function commandOutput(command: string, args: string[], cwd: string): string {
  if (!isAbsolute(command)) throw new Error("ProgramBench provenance command must be absolute.");
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`ProgramBench provenance command failed: ${result.stderr.toString("utf8").trim().slice(0, 300)}`);
  }
  return result.stdout.toString("utf8");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function imageIdentity(
  docker: string,
  reference: string,
  root: string,
): ProgramBenchCampaignProvenance["evaluatorImage"] {
  const id = commandOutput(docker, ["image", "inspect", "--format", "{{.Id}}", reference], root).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`ProgramBench image ${reference} is missing or invalid.`);
  return { reference, id };
}

export function collectProgramBenchCampaignProvenance(
  root: string,
  tasks: string[],
): ProgramBenchCampaignProvenance {
  const canonicalRoot = realpathSync.native(resolve(root));
  const executables = resolveHarborExecutables(canonicalRoot);
  const sourceRevision = commandOutput(executables.git, ["-C", canonicalRoot, "rev-parse", "HEAD"], canonicalRoot)
    .trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(sourceRevision)) throw new Error("ProgramBench source revision is invalid.");
  const status = commandOutput(
    executables.git,
    ["-C", canonicalRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    canonicalRoot,
  );
  const files = commandOutput(
    executables.git,
    ["-C", canonicalRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    canonicalRoot,
  ).split("\u0000").filter(Boolean).sort();
  const snapshot = createHash("sha256").update("neko.programbench.source-snapshot.v1\u0000").update(status);
  for (const path of files) {
    const absolute = resolve(canonicalRoot, path);
    const contained = relative(canonicalRoot, absolute);
    if (contained.startsWith(`..${sep}`) || contained === ".." || isAbsolute(contained)) {
      throw new Error("ProgramBench source snapshot escaped the repository.");
    }
    snapshot.update("\u0000path\u0000").update(path).update("\u0000");
    if (!existsSync(absolute)) {
      snapshot.update("missing");
      continue;
    }
    const stat = lstatSync(absolute);
    snapshot.update(String(stat.mode)).update("\u0000");
    if (stat.isSymbolicLink()) snapshot.update("symlink\u0000").update(readlinkSync(absolute));
    else if (stat.isFile()) snapshot.update(readFileSync(absolute));
    else snapshot.update("non-file");
  }
  const taskImages: ProgramBenchCampaignProvenance["taskImages"] = {};
  for (const task of [...tasks].sort()) taskImages[task] = imageIdentity(executables.docker, programBenchImage(task), canonicalRoot);
  return campaignProvenanceSchema.parse({
    sourceRevision,
    sourceDirty: status.length > 0,
    sourceSnapshotSha256: snapshot.digest("hex"),
    componentSha256: {
      campaign: fileSha256(join(canonicalRoot, "scripts", "programbench-campaign.ts")),
      launcher: fileSha256(join(canonicalRoot, "scripts", "programbench-eval.ts")),
      evaluatorShim: fileSha256(join(canonicalRoot, "evals", "programbench", "workspace_snapshot_evaluator.py")),
      environmentRunner: fileSha256(join(canonicalRoot, "evals", "programbench", "runner.py")),
      hostRunner: fileSha256(join(canonicalRoot, "evals", "harbor", "host_runner.ts")),
      remoteTools: fileSha256(join(canonicalRoot, "evals", "harbor", "remote_tools.py")),
    },
    evaluatorImage: imageIdentity(executables.docker, PROGRAMBENCH_EVALUATOR_IMAGE, canonicalRoot),
    taskImages,
  });
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function validCellScore(
  cell: ProgramBenchCampaignCellState,
  evaluate: boolean,
): { score: number | null; artifact: number } | null {
  const result = cell.result;
  if (!result || result.runner.exitStatus === "infrastructure_error") return null;
  if (result.runner.exitStatus === "artifact_missing") {
    return { score: evaluate ? 0 : null, artifact: 0 };
  }
  if (!result.runner.artifactSha256) return null;
  if (!evaluate) return { score: null, artifact: 1 };
  if (result.evaluationStatus !== "completed" || !result.evaluation) return null;
  return { score: result.evaluation.score, artifact: 1 };
}

export function isProgramBenchInfrastructureInvalidCell(
  cell: ProgramBenchCampaignCellState,
  evaluate: boolean,
): boolean {
  return (cell.status === "completed" || cell.status === "failed") && validCellScore(cell, evaluate) === null;
}

function exactOneSidedPairedPValue(deltas: number[]): number | null {
  if (!deltas.length || deltas.length > 20) return null;
  const observed = mean(deltas)!;
  let atLeastObserved = 0;
  const permutations = 2 ** deltas.length;
  for (let mask = 0; mask < permutations; mask++) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index++) {
      sum += deltas[index]! * ((mask & (1 << index)) === 0 ? -1 : 1);
    }
    if (sum / deltas.length >= observed - Number.EPSILON) atLeastObserved++;
  }
  return atLeastObserved / permutations;
}

export function summarizeProgramBenchCampaign(
  manifest: ProgramBenchCampaignManifest,
  now = Date.now(),
): ProgramBenchCampaignSummary {
  const modes: ProgramBenchCampaignSummary["modes"] = {};
  for (const mode of manifest.options.completionModes) {
    const cells = manifest.cells.filter((cell) => cell.completionMode === mode);
    const valid = cells.flatMap((cell) => {
      const outcome = validCellScore(cell, manifest.options.evaluate);
      return outcome ? [{ cell, outcome }] : [];
    });
    modes[mode] = {
      plannedCells: cells.length,
      validCells: valid.length,
      artifactRate: valid.length === cells.length ? mean(valid.map(({ outcome }) => outcome.artifact)) : null,
      meanScore: valid.length === cells.length ? mean(valid.flatMap(({ outcome }) =>
        outcome.score === null ? [] : [outcome.score])) : null,
      meanProviderCalls: valid.length === cells.length ? mean(valid.flatMap(({ cell }) =>
        cell.result?.runner.providerCompleteCalls ?? [])) : null,
      meanTotalTokens: valid.length === cells.length ? mean(valid.flatMap(({ cell }) =>
        cell.result?.runner.totalTokens ?? [])) : null,
      meanWallTimeMs: valid.length === cells.length ? mean(valid.flatMap(({ cell }) =>
        cell.result?.runner.wallTimeMs ?? [])) : null,
    };
  }

  const byPair = new Map<string, Partial<Record<"single" | "contract", ProgramBenchCampaignCellState>>>();
  for (const cell of manifest.cells) {
    if (cell.completionMode !== "single" && cell.completionMode !== "contract") continue;
    const key = `${cell.task}\u0000${cell.profile}\u0000${cell.replicate}`;
    const pair = byPair.get(key) ?? {};
    pair[cell.completionMode] = cell;
    byPair.set(key, pair);
  }
  const pairs = [...byPair.values()].flatMap((pair) => {
    if (!pair.single || !pair.contract) return [];
    const single = validCellScore(pair.single, manifest.options.evaluate);
    const contract = validCellScore(pair.contract, manifest.options.evaluate);
    if (!single || !contract || single.score === null || contract.score === null) return [];
    return [{
      score: contract.score - single.score,
      artifact: contract.artifact - single.artifact,
      calls: pair.contract.result!.runner.providerCompleteCalls !== null &&
        pair.single.result!.runner.providerCompleteCalls !== null
        ? pair.contract.result!.runner.providerCompleteCalls! - pair.single.result!.runner.providerCompleteCalls!
        : null,
      tokens: pair.contract.result!.runner.totalTokens !== null && pair.single.result!.runner.totalTokens !== null
        ? pair.contract.result!.runner.totalTokens! - pair.single.result!.runner.totalTokens!
        : null,
    }];
  });
  const campaignComplete = manifest.finishedAt !== null &&
    manifest.cells.every((cell) => cell.status === "completed" || cell.status === "failed");
  const infrastructureValid = manifest.cells.every((cell) => validCellScore(cell, manifest.options.evaluate) !== null);
  const contract = modes.contract;
  const single = modes.single;
  const scoreDeltas = pairs.map((pair) => pair.score);
  const pValue = exactOneSidedPairedPValue(scoreDeltas);
  const improvementClaimEligible = campaignComplete && infrastructureValid && manifest.options.evaluate &&
    manifest.options.tasks.length >= 3 && manifest.options.replicates >= 3 &&
    Boolean(contract && single) && pairs.length === manifest.options.tasks.length * manifest.options.profiles.length *
      manifest.options.replicates;
  const scoreDelta = mean(scoreDeltas);
  const improvementSupported = improvementClaimEligible && scoreDelta !== null && scoreDelta > 0 &&
    pValue !== null && pValue <= 0.05 && contract!.artifactRate! >= single!.artifactRate!;
  return {
    schemaVersion: "neko.programbench.campaign-summary.v1",
    campaignComplete,
    infrastructureValid,
    computeMatched: true,
    modes,
    paired: {
      pairs: pairs.length,
      meanScoreDeltaContractMinusSingle: scoreDelta,
      meanArtifactDeltaContractMinusSingle: mean(pairs.map((pair) => pair.artifact)),
      meanProviderCallDeltaContractMinusSingle: mean(pairs.flatMap((pair) => pair.calls ?? [])),
      meanTokenDeltaContractMinusSingle: mean(pairs.flatMap((pair) => pair.tokens ?? [])),
      oneSidedExactPValue: pValue,
    },
    improvementClaimEligible,
    improvementSupported,
    sotaClaimEligible: false,
    generatedAt: now,
  };
}

export function parseProgramBenchCampaignArgs(argv: string[]): ProgramBenchCampaignOptions {
  const tasks: string[] = [];
  let profiles: string[] = [];
  let replicates = 1;
  let output = "results/programbench-campaign";
  let maxSteps = 160;
  let implementationRoundSteps = 12;
  let callBudget = 0;
  let completionModes: CompletionMode[] = ["single"];
  let controllersSpecified = false;
  let reasoningEffort = "max";
  let evaluate = false;
  let resume = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task") {
      const value = next(argv, i++, arg);
      tasks.push(parseProgramBenchEvalArgs(["--task", value]).task);
    } else if (arg === "--profiles") {
      profiles = next(argv, i++, arg).split(",").map((value) => name(value, "ProgramBench profile"));
    } else if (arg === "--replicates") replicates = integer(next(argv, i++, arg), arg, 10);
    else if (arg === "--output") output = next(argv, i++, arg);
    else if (arg === "--max-steps") maxSteps = integer(next(argv, i++, arg), arg, 1_000);
    else if (arg === "--round-steps") implementationRoundSteps = integer(next(argv, i++, arg), arg, 1_000);
    else if (arg === "--call-budget") callBudget = integer(next(argv, i++, arg), arg, 10_000);
    else if (arg === "--controller" || arg === "--controllers") {
      if (controllersSpecified) throw new Error("Specify controllers only once.");
      const values = next(argv, i++, arg).split(",").map(completionMode);
      if (arg === "--controller" && values.length !== 1) throw new Error("--controller accepts one controller.");
      completionModes = unique(values, "ProgramBench controller list");
      controllersSpecified = true;
    } else if (arg === "--effort") reasoningEffort = name(next(argv, i++, arg), "Reasoning effort");
    else if (arg === "--evaluate") evaluate = true;
    else if (arg === "--resume") resume = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  if (!tasks.length) throw new Error("ProgramBench campaign requires at least one --task.");
  if (!profiles.length) throw new Error("ProgramBench campaign requires --profiles <a,b>.");
  if (implementationRoundSteps > maxSteps) throw new Error("--round-steps cannot exceed --max-steps.");
  unique(tasks, "ProgramBench task list");
  unique(profiles, "ProgramBench profile list");
  if (tasks.length * profiles.length * completionModes.length * replicates > 60) {
    throw new Error("ProgramBench campaign is limited to 60 cells.");
  }
  if (!callBudget) callBudget = Math.min(10_000, maxSteps + 1);
  return {
    tasks,
    profiles,
    replicates,
    output,
    maxSteps,
    implementationRoundSteps,
    callBudget,
    completionModes,
    reasoningEffort,
    evaluate,
    resume,
  };
}

export function buildProgramBenchCampaignCells(
  options: ProgramBenchCampaignOptions,
  outputRoot: string,
): ProgramBenchCampaignCell[] {
  if (!isAbsolute(outputRoot)) throw new Error("ProgramBench campaign output must be absolute.");
  const cells: ProgramBenchCampaignCell[] = [];
  for (let taskIndex = 0; taskIndex < options.tasks.length; taskIndex++) {
    const task = options.tasks[taskIndex]!;
    for (let profileIndex = 0; profileIndex < options.profiles.length; profileIndex++) {
      const profile = options.profiles[profileIndex]!;
      for (let replicate = 1; replicate <= options.replicates; replicate++) {
        const offset = (taskIndex + profileIndex + replicate - 1) % options.completionModes.length;
        const modes = [
          ...options.completionModes.slice(offset),
          ...options.completionModes.slice(0, offset),
        ];
        for (const mode of modes) {
          cells.push({
            task,
            profile,
            replicate,
            sampling: "provider-replicate",
            completionMode: mode,
            output: join(
              outputRoot,
              task,
              profile,
              mode,
              `replicate-${String(replicate).padStart(2, "0")}`,
            ),
          });
        }
      }
    }
  }
  return cells;
}

export function createProgramBenchCampaignManifest(
  options: ProgramBenchCampaignOptions,
  outputRoot: string,
  provenance: ProgramBenchCampaignProvenance,
  now = Date.now(),
): ProgramBenchCampaignManifest {
  return {
    schemaVersion: "neko.programbench.campaign.v3",
    programbenchVersion: "1.2.4",
    sampling: "provider-replicate",
    startedAt: now,
    provenance: campaignProvenanceSchema.parse(provenance),
    options: configOf(options),
    cells: buildProgramBenchCampaignCells(options, outputRoot)
      .map((cell) => ({ ...cell, status: "pending", exitCode: null, result: null })),
    finishedAt: null,
  };
}

export function resumeProgramBenchCampaignManifest(
  manifest: ProgramBenchCampaignManifest,
  options: ProgramBenchCampaignOptions,
  outputRoot: string,
  provenance: ProgramBenchCampaignProvenance,
): ProgramBenchCampaignManifest {
  if (manifest.schemaVersion !== "neko.programbench.campaign.v3" ||
    manifest.programbenchVersion !== "1.2.4" || manifest.sampling !== "provider-replicate") {
    throw new Error("ProgramBench campaign manifest version is incompatible.");
  }
  if (JSON.stringify(manifest.options) !== JSON.stringify(configOf(options))) {
    throw new Error("ProgramBench campaign options do not match the frozen manifest.");
  }
  if (JSON.stringify(manifest.provenance) !== JSON.stringify(campaignProvenanceSchema.parse(provenance))) {
    throw new Error("ProgramBench campaign source or image provenance changed.");
  }
  const expected = buildProgramBenchCampaignCells(options, outputRoot);
  if (!Array.isArray(manifest.cells) || manifest.cells.length !== expected.length) {
    throw new Error("ProgramBench campaign cells do not match the frozen manifest.");
  }
  const statuses = new Set(["pending", "running", "completed", "failed", "interrupted"]);
  for (let index = 0; index < expected.length; index++) {
    const cell = manifest.cells[index];
    const wanted = expected[index];
    if (!cell || !wanted || cell.task !== wanted.task || cell.profile !== wanted.profile ||
      cell.replicate !== wanted.replicate || cell.sampling !== wanted.sampling ||
      cell.completionMode !== wanted.completionMode || cell.output !== wanted.output ||
      !statuses.has(cell.status ?? "") ||
      (cell.exitCode !== null && (!Number.isSafeInteger(cell.exitCode) || cell.exitCode! < 0)) ||
      (cell.result !== null && cell.result.task !== cell.task)) {
      throw new Error("ProgramBench campaign cells do not match the frozen manifest.");
    }
    if ((cell.status === "completed" && (cell.exitCode !== 0 || cell.result === null ||
      cell.result.runner.exitCode !== 0 ||
      cell.result.evaluationStatus !== (options.evaluate ? "completed" : "not_requested"))) ||
      (cell.status === "failed" && (!cell.exitCode || cell.exitCode < 1)) ||
      ((cell.status === "pending" || cell.status === "running" || cell.status === "interrupted") &&
        (cell.exitCode !== null || cell.result !== null))) {
      throw new Error("ProgramBench campaign cell status is inconsistent.");
    }
    if (cell.status === "running") {
      cell.status = "interrupted";
      cell.exitCode = null;
      cell.result = null;
    }
  }
  if (!Number.isSafeInteger(manifest.startedAt) || manifest.startedAt! < 1 ||
    (manifest.finishedAt !== null && (!Number.isSafeInteger(manifest.finishedAt) || manifest.finishedAt! < 1))) {
    throw new Error("ProgramBench campaign timestamps are invalid.");
  }
  manifest.finishedAt = null;
  return manifest;
}

async function main(): Promise<number> {
  const options = parseProgramBenchCampaignArgs(process.argv.slice(2));
  const root = resolve(import.meta.dir, "..");
  const outputRoot = resolve(root, options.output);
  const manifestPath = join(outputRoot, "campaign.json");
  mkdirSync(outputRoot, { recursive: true });
  const provenance = collectProgramBenchCampaignProvenance(root, options.tasks);
  let manifest: ProgramBenchCampaignManifest;
  if (existsSync(manifestPath)) {
    if (!options.resume) throw new Error("ProgramBench campaign output already contains a manifest; pass --resume to continue it.");
    let parsed: ProgramBenchCampaignManifest;
    try { parsed = campaignManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8"))); }
    catch { throw new Error("ProgramBench campaign manifest is unreadable."); }
    manifest = resumeProgramBenchCampaignManifest(parsed, options, outputRoot, provenance);
  } else {
    if (options.resume) throw new Error("ProgramBench campaign has no manifest to resume.");
    manifest = createProgramBenchCampaignManifest(options, outputRoot, provenance);
  }
  const persist = () => {
    atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    atomicWriteFileSync(
      join(outputRoot, PROGRAMBENCH_CAMPAIGN_SUMMARY_BASENAME),
      `${JSON.stringify(summarizeProgramBenchCampaign(manifest), null, 2)}\n`,
    );
  };
  persist();
  for (let index = 0; index < manifest.cells.length; index++) {
    const cell = manifest.cells[index]!;
    if (cell.status !== "pending") continue;
    const recorded = manifest.cells[index]!;
    recorded.status = "running";
    persist();
    console.log(`[${index + 1}/${manifest.cells.length}] ${cell.task} | ${cell.profile} | ` +
      `${cell.completionMode} | replicate ${cell.replicate}`);
    const args = [
      join(root, "scripts", "programbench-eval.ts"),
      "--task", cell.task,
      "--profile", cell.profile,
      "--output", cell.output,
      "--max-steps", String(options.maxSteps),
      "--round-steps", String(options.implementationRoundSteps),
      "--call-budget", String(options.callBudget),
      "--effort", options.reasoningEffort,
      cell.completionMode === "contract" ? "--contract"
        : cell.completionMode === "self-review" ? "--loop" : "--no-loop",
      ...(options.evaluate ? ["--evaluate"] : []),
    ];
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    let code = await child.exited;
    try {
      recorded.result = readProgramBenchRunResult(cell.output, cell.task);
      if (code === 0 && recorded.result.evaluationStatus !==
        (options.evaluate ? "completed" : "not_requested")) {
        throw new Error("ProgramBench run result is not terminally complete.");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      if (code === 0) code = 1;
    }
    recorded.exitCode = code;
    recorded.status = code === 0 ? "completed" : "failed";
    persist();
    if (isProgramBenchInfrastructureInvalidCell(recorded, options.evaluate)) {
      console.error("ProgramBench campaign stopped after an infrastructure-invalid cell; pending cells were preserved.");
      break;
    }
  }
  manifest.finishedAt = manifest.cells.every((cell) => cell.status === "completed" || cell.status === "failed")
    ? Date.now()
    : null;
  persist();
  return manifest.cells.some((cell) => cell.exitCode !== 0) ? 1 : 0;
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`programbench-campaign: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
