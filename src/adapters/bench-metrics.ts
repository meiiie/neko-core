/**
 * Multi-dimensional agent evaluation — the standards top labs measure, applied to `neko bench`.
 *
 * Grounding (sources verified 2026-08-06, see ~/.neko-core/research/neko-agent-benchmark-sota-2026.md):
 *   - CLEAR framework (arXiv 2511.14136): Cost / Latency / Efficacy / Assurance / Reliability.
 *   - τ-bench pass^k (arXiv 2406.12045): reliability = fraction of tasks passing ALL k trials;
 *     pass@1 collapses sharply under repeated runs, so pass^k is the headline reliability metric.
 *   - RedundancyBench (arXiv 2605.29893): execution efficiency is its own axis — success ≠ efficient.
 *
 * DESIGN PRINCIPLES (match the rest of `neko bench`):
 *   - DETERMINISTIC only. No LLM judge. Every metric is computable from observable traces + verifiers.
 *   - PURE module: all functions take structured inputs and return structured output. The live harness
 *     (runEval in bench.ts) feeds it; unit tests feed synthetic inputs — so the STANDARD is verifiable
 *     with zero API spend. The live run (which spends tokens) is gated by the caller.
 *   - READ-ONLY telemetry: traces come from Agent.onEvent, never alter the agent loop or prompt.
 */

import { isText } from "../shared/wire.ts";

// ---- Inputs (what the harness captures per trial) -------------------------------------------

export type ToolName = string;

/** One captured tool call. `path`/`pattern`/`cmd` are normalized so the redundancy detector can group. */
export interface TraceEntry {
  name: ToolName;
  path?: string; // read_file / edit / write_file / multi_edit target
  pattern?: string; // glob / search pattern
  cmd?: string; // bash command
  /** Canonical, tool-specific identity for read redundancy. Kept separate from `readScope` because
   * two searches can inspect the same tree with different patterns/options. Older stored traces may
   * omit both fields and fall back to the legacy path/pattern shape below. */
  readKey?: string;
  /** Canonical filesystem scope whose mutation makes a repeated read legitimate (`.` = workspace). */
  readScope?: string;
  ok: boolean; // productive result (non-error, non-empty)
}

export interface TokenUse {
  in: number;
  cached: number;
  out: number;
}

/** A constraint = a negative/positive instruction the agent must honor (e.g. "do not modify test.mjs"). */
export interface ConstraintResult {
  id: string;
  ok: boolean;
}

export type TrialOutcome = "pass" | "model_failure" | "infra_error";

export interface TrialRecord {
  pass: boolean;
  /** Explicit trial classification. Older stored records may omit it and are derived from `pass`. */
  outcome?: TrialOutcome;
  tokens: TokenUse;
  ms: number;
  steps: number; // completed tool-call results (not provider/model calls)
  trace: TraceEntry[];
  constraints: ConstraintResult[];
}

export interface TaskSpec {
  id: string;
  trials: number;
  optimalSteps?: number; // for step-efficiency; omit to skip the per-task step-efficiency score
  records: TrialRecord[];
}

// ---- RedundancyBench-style execution-efficiency detector ------------------------------------

const READ_TOOLS = new Set(["read_file", "ls", "glob", "search"]);
const MUTATING_TOOLS = new Set(["edit", "write_file", "multi_edit"]);

function readIdentity(e: TraceEntry): string | undefined {
  if (e.readKey) return e.readKey;
  const path = isText(e.path) ? e.path : undefined;
  const pattern = isText(e.pattern) ? e.pattern : undefined;
  if (!path && !pattern && e.name !== "ls") return undefined;
  // Include the tool and both legacy fields so search/glob calls sharing one directory but using
  // different patterns never collide. New live traces use the richer tool-specific `readKey`.
  return JSON.stringify([e.name, path ?? null, pattern ?? null]);
}

function readMutationScope(e: TraceEntry): string | undefined {
  if (isText(e.readScope) && e.readScope) return e.readScope;
  if (isText(e.path) && e.path) return e.path;
  return e.name === "search" || e.name === "glob" || e.name === "ls" ? "." : undefined;
}

/** Does a mutation to `mutPath` affect the thing `readTarget` was read at? Conservative: exact / prefix. */
function mutationTouches(mutPath: string | undefined, readAt: string | undefined): boolean {
  if (!isText(mutPath) || !isText(readAt) || !mutPath || !readAt) return false;
  if (mutPath === readAt) return true;
  if (mutPath === "." || readAt === ".") return true;
  // `ls dir/` is invalidated by any write under dir/
  const norm = (s: string) => (s.endsWith("/") ? s : s + "/");
  return norm(mutPath).startsWith(norm(readAt)) || norm(readAt).startsWith(norm(mutPath));
}

/**
 * Count redundant tool calls in a trajectory (RedundancyBench axis). Conservative to avoid false
 * positives on legitimate work:
 *   - READS (read_file/ls/glob/search): a repeat of an already-read target is redundant ONLY if no
 *     mutating tool touched that target in between (a real reason to re-read).
 *   - BASH: a consecutive IDENTICAL command is redundant from the 2nd occurrence (the doom-loop guard
 *     blocks at the 3rd; we score the inefficiency before it trips).
 *   - MUTATIONS (edit/write/multi_edit): never flagged — repeated edits to a file chasing a build error
 *     are legitimate iteration, not redundancy.
 */
export function redundantCallMask(trace: TraceEntry[]): boolean[] {
  const mask = trace.map(() => false);
  const lastReadAt = new Map<string, { index: number; scope?: string }>();
  let prevBash = "";
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (e.name !== "bash") prevBash = ""; // "consecutive" means no intervening tool of any kind
    if (READ_TOOLS.has(e.name)) {
      const identity = readIdentity(e);
      if (identity) {
        const previous = lastReadAt.get(identity);
        if (previous !== undefined) {
          let mutated = false;
          for (let j = previous.index + 1; j < i; j++) {
            const m = trace[j];
            if (MUTATING_TOOLS.has(m.name) && isText(m.path) && previous.scope
              && mutationTouches(m.path, previous.scope)) {
              mutated = true;
              break;
            }
          }
          if (!mutated) mask[i] = true;
        }
        lastReadAt.set(identity, { index: i, scope: readMutationScope(e) });
      }
    } else if (e.name === "bash") {
      // An arbitrary command may mutate any workspace path, so no earlier read identity is safe to
      // reuse even when the command itself fails or is malformed.
      lastReadAt.clear();
      const command = isText(e.cmd) ? e.cmd : "";
      if (!command) {
        prevBash = "";
      } else {
        if (command === prevBash) mask[i] = true; // 2nd+ consecutive identical run
        prevBash = command;
      }
    }
  }
  return mask;
}

export function redundantCalls(trace: TraceEntry[]): number {
  return redundantCallMask(trace).filter(Boolean).length;
}

// ---- Statistics helpers ---------------------------------------------------------------------

export function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// ---- Per-task analysis ----------------------------------------------------------------------

export interface TaskMetric {
  id: string;
  trials: number;
  passes: number;
  modelFailures: number;
  infraErrors: number;
  /** False means the conservative score is shown, but must not be compared or promoted. */
  comparisonValid: boolean;
  // Efficacy
  efficacy: number; // pass@1 = passes/trials  [0..1]
  // Reliability (τ-bench pass^k)
  passAllK: number; // strict pass^k: 1 iff passed every trial
  // Cost-efficiency
  meanTokens: number; // mean total tokens/trial
  tokensPerSuccess: number; // CPS analog: sum(tokens of all trials)/numSuccesses (lower better; =total if 0 success)
  cna: number; // cost-normalized accuracy = efficacy*1000/meanTokens (higher better)
  // Execution efficiency
  redundantCalls: number; // total across trials
  totalCalls: number;
  redundancyRate: number; // redundant/total [0..1]
  stepEfficiency: number | null; // optimalSteps/meanSteps (cap 1); null if no optimal declared
  // Assurance
  constraintScore: number; // satisfied/declared [0..1]; 1 if no constraints declared
  // Latency
  p50Ms: number;
  p95Ms: number;
  /** Sorted per-trial latencies retained for exact aggregate quantiles and SLA accounting. */
  latenciesMs: number[];
}

const DEFAULT_SLA_MS = 30_000;

export function analyzeTask(spec: TaskSpec, slaMs = DEFAULT_SLA_MS): TaskMetric {
  const recs = spec.records;
  if (recs.length !== spec.trials) {
    throw new Error(`task ${spec.id} expected ${spec.trials} trial record(s), received ${recs.length}`);
  }
  const outcomes = recs.map((record) => {
    const outcome: TrialOutcome = record.outcome ?? (record.pass ? "pass" : "model_failure");
    if ((outcome === "pass") !== record.pass) {
      throw new Error(`task ${spec.id} has a trial whose pass flag conflicts with outcome=${outcome}`);
    }
    return outcome;
  });
  const passes = outcomes.filter((outcome) => outcome === "pass").length;
  const modelFailures = outcomes.filter((outcome) => outcome === "model_failure").length;
  const infraErrors = outcomes.filter((outcome) => outcome === "infra_error").length;
  const efficacy = spec.trials ? passes / spec.trials : 0;
  const passAllK = spec.trials > 0 && passes === spec.trials ? 1 : 0;
  const totalTokens = recs.reduce((a, r) => a + r.tokens.in + r.tokens.out, 0); // uncached work
  const meanTokens = recs.length ? totalTokens / recs.length : 0;
  const tokensPerSuccess = passes > 0 ? totalTokens / passes : totalTokens; // 0 success => full spend counts against you
  const cna = meanTokens > 0 ? (efficacy * 1000) / meanTokens : 0;
  const redundant = recs.reduce((a, r) => a + redundantCalls(r.trace), 0);
  const totalCalls = recs.reduce((a, r) => a + r.trace.length, 0);
  const redundancyRate = totalCalls ? redundant / totalCalls : 0;
  const meanSteps = recs.length ? recs.reduce((a, r) => a + r.steps, 0) / recs.length : 0;
  const stepEfficiency =
    spec.optimalSteps && meanSteps > 0 ? Math.min(1, spec.optimalSteps / meanSteps) : null;
  const declared = recs.reduce((a, r) => a + r.constraints.length, 0);
  const satisfied = recs.reduce((a, r) => a + r.constraints.filter((c) => c.ok).length, 0);
  const constraintScore = declared ? satisfied / declared : 1;
  const sortedMs = recs.map((r) => r.ms).sort((x, y) => x - y);
  const p50Ms = quantile(sortedMs, 0.5);
  const p95Ms = quantile(sortedMs, 0.95);
  void slaMs; // reserved for a per-task SLA flag if needed later
  return {
    id: spec.id,
    trials: spec.trials,
    passes,
    modelFailures,
    infraErrors,
    comparisonValid: infraErrors === 0,
    efficacy,
    passAllK,
    meanTokens,
    tokensPerSuccess,
    cna,
    redundantCalls: redundant,
    totalCalls,
    redundancyRate,
    stepEfficiency,
    constraintScore,
    p50Ms,
    p95Ms,
    latenciesMs: sortedMs,
  };
}

// ---- Aggregate CLEAR + reliability report ---------------------------------------------------

export interface DimReport {
  tasks: TaskMetric[];
  trials: number;
  nTasks: number;
  totalTrials: number;
  passes: number;
  modelFailures: number;
  infraErrors: number;
  comparisonValid: boolean;
  // Efficacy
  pass1: number; // mean efficacy across tasks [0..1]
  // Reliability
  passK: number; // mean strict pass^k across tasks [0..1]
  reliabilityDrop: number; // pass1 - passK (the headline collapse)
  // Cost-efficiency
  tokensPerSuccess: number; // aggregate CPS (lower better)
  cna: number; // aggregate CNA (higher better)
  // Execution efficiency
  redundancyRate: number; // aggregate redundant/total (lower better)
  stepEfficiency: number | null; // mean over tasks that declared optimal
  // Assurance
  constraintScore: number; // aggregate (higher better)
  // Latency
  p50Ms: number;
  p95Ms: number;
  slaCompliance: number; // fraction of trials under slaMs [0..1]
  slaMs: number;
}

export function aggregate(tasks: TaskMetric[], slaMs = DEFAULT_SLA_MS): DimReport {
  const n = tasks.length;
  const mean = (f: (t: TaskMetric) => number) => (n ? tasks.reduce((a, t) => a + f(t), 0) / n : 0);
  const pass1 = mean((t) => t.efficacy);
  const passK = mean((t) => t.passAllK);
  const allMs = tasks.flatMap((t) => t.latenciesMs).sort((x, y) => x - y);
  const totalTokensAll = tasks.reduce((a, t) => a + t.meanTokens * t.trials, 0);
  const totalPasses = tasks.reduce((a, t) => a + Math.round(t.efficacy * t.trials), 0);
  const tokensPerSuccess = totalPasses > 0 ? totalTokensAll / totalPasses : totalTokensAll;
  const cna = mean((t) => t.cna);
  const totalRedundant = tasks.reduce((a, t) => a + t.redundantCalls, 0);
  const totalCalls = tasks.reduce((a, t) => a + t.totalCalls, 0);
  const redundancyRate = totalCalls ? totalRedundant / totalCalls : 0;
  const seTasks = tasks.filter((t) => t.stepEfficiency !== null);
  // SAFETY: contract of the number type is established by the surrounding validation/boundary.
  const stepEfficiency = seTasks.length ? seTasks.reduce((a, t) => a + (t.stepEfficiency as number), 0) / seTasks.length : null;
  const constraintScore = mean((t) => t.constraintScore);
  const allTrials = tasks.reduce((a, t) => a + t.trials, 0);
  const passes = tasks.reduce((a, t) => a + t.passes, 0);
  const modelFailures = tasks.reduce((a, t) => a + t.modelFailures, 0);
  const infraErrors = tasks.reduce((a, t) => a + t.infraErrors, 0);
  // SLA compliance uses every scheduled trial; no task-level p95 proxy or infra filtering.
  const slaCompliant = allMs.filter((ms) => ms <= slaMs).length;
  return {
    tasks,
    trials: n ? tasks[0].trials : 0,
    nTasks: n,
    totalTrials: allTrials,
    passes,
    modelFailures,
    infraErrors,
    comparisonValid: infraErrors === 0,
    pass1,
    passK,
    reliabilityDrop: pass1 - passK,
    tokensPerSuccess,
    cna,
    redundancyRate,
    stepEfficiency,
    constraintScore,
    p50Ms: quantile(allMs, 0.5),
    p95Ms: quantile(allMs, 0.95),
    slaCompliance: allTrials ? slaCompliant / allTrials : 0,
    slaMs,
  };
}

// ---- Scorecard renderer ---------------------------------------------------------------------

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function fmt(n: number, d = 0): string {
  return Number.isFinite(n) ? n.toFixed(d) : "∞";
}

export function renderScorecard(r: DimReport, title = "Neko-bench multi-dim"): string {
  const taskRows = r.tasks
    .map((t) => {
      const tag = t.infraErrors ? "INF" : t.passAllK ? "OK " : t.efficacy === 0 ? "X  " : "FLK";
      const se = t.stepEfficiency === null ? "  -" : pct(t.stepEfficiency).padStart(3);
      return `  ${tag} ${t.id.padEnd(13)} E=${pct(t.efficacy).padStart(3)} R^k=${t.passAllK ? "1" : "0"}  CPS=${String(Math.round(t.tokensPerSuccess)).padStart(6)}tok  redun=${pct(t.redundancyRate).padStart(3)}  stepEff=${se}  constr=${pct(t.constraintScore).padStart(3)}  p95=${(t.p95Ms / 1000).toFixed(1)}s  infra=${t.infraErrors}`;
    })
    .join("\n");
  const se = r.stepEfficiency === null ? "  -" : pct(r.stepEfficiency).padStart(3);
  return [
    `${title} :: ${r.nTasks} task(s) × ${r.trials} trial(s)`,
    "  (dimensions: E=Efficacy pass@1 · R^k=Reliability strict pass^k · CPS=Cost-per-success tok ·",
    "   redun=RedundancyBench redundant-call rate · stepEff=optimal/actual steps · constr=Assurance · p95=Latency)",
    taskRows,
    "  " + "─".repeat(96),
    `  Efficacy    pass@1   = ${pct(r.pass1)}`,
    `  Reliability pass^k   = ${pct(r.passK)}    drop pass@1→pass^k = ${pct(r.reliabilityDrop)}  (0% = perfectly consistent)`,
    `  Cost-eff    CPS      = ${fmt(r.tokensPerSuccess)} tok/success   CNA = ${fmt(r.cna, 3)}  (lower CPS / higher CNA = better)`,
    `  Exec-eff    redundant= ${pct(r.redundancyRate)}   stepEff = ${se}`,
    `  Assurance   constr   = ${pct(r.constraintScore)}`,
    `  Latency     p50=${(r.p50Ms / 1000).toFixed(1)}s  p95=${(r.p95Ms / 1000).toFixed(1)}s  SLA(≤${(r.slaMs / 1000).toFixed(0)}s)=${pct(r.slaCompliance)}`,
    `  Outcomes    ${r.passes} pass | ${r.modelFailures} model-fail | ${r.infraErrors} infra`,
    r.comparisonValid
      ? "  Comparison VALID (no infrastructure errors)"
      : "  Comparison NOT COMPARABLE - fix infrastructure and rerun the full suite",
  ].join("\n");
}
