import type { Usage } from "./cost.ts";
import { isBool, isJsonNumber, isJsonObject, isText, type JsonValue } from "../shared/wire.ts";

export type CompletionCriterionSource = "user" | "repository" | "reference" | "runtime" | "derived";
export type CompletionCriterionStatus = "passed" | "failed" | "blocked" | "unknown";
export type CompletionVerdict = "pass" | "fail" | "blocked";
export type CompletionMeasurementOutcome = "productive" | "empty" | "failed";

export interface CompletionCriterion {
  id: string;
  requirement: string;
  source: CompletionCriterionSource;
  verification: string;
  required: boolean;
  /** Behavioral surface represented by this criterion. Older saved sessions default to `general`. */
  coverageArea?: string;
  /** Approximate case mass, not permission to ignore a low-weight required outcome. */
  weight?: number;
  baselineReceipts?: string[];
  baselineRelation?: "same" | "different";
}

export interface CompletionBaselineFact {
  statement: string;
  receipts: string[];
}

export interface CompletionEvidence {
  criterionId: string;
  status: CompletionCriterionStatus;
  evidence: string;
  receipts?: string[];
}

export interface CompletionMeasurement {
  id: string;
  tool: string;
  outcome: CompletionMeasurementOutcome;
  digest: string;
  digestKind?: "artifact" | "observation";
  subject?: string;
}

export interface CompletionReview {
  verdict: CompletionVerdict;
  artifactRevision: number;
  reviewedAt: string;
  /** False means the validator found a material hole in its own instrument. */
  coverageComplete?: boolean;
  evidence: CompletionEvidence[];
  findings: string[];
  measurements?: CompletionMeasurement[];
}

export interface CompletionContract {
  schemaVersion: 1;
  goal: string;
  revision: number;
  /** Changes only when the validator expands the immutable behavioral surface. */
  instrumentRevision?: number;
  createdAt: string;
  criteria: CompletionCriterion[];
  baselineFacts?: CompletionBaselineFact[];
  baselineMeasurements?: CompletionMeasurement[];
  lastReview?: CompletionReview;
}

export interface CompletionCriterionDraft {
  phase?: JsonValue;
  requirement?: JsonValue;
  source?: JsonValue;
  verification?: JsonValue;
  required?: JsonValue;
  coverageArea?: JsonValue;
  weight?: JsonValue;
  baselineReceipts?: JsonValue;
  baselineRelation?: JsonValue;
  [key: string]: JsonValue | undefined;
}

export interface CompletionBaselineFactDraft {
  statement?: JsonValue;
  receipts?: JsonValue;
  [key: string]: JsonValue | undefined;
}

export interface CompletionContractDraft {
  criteria?: CompletionCriterionDraft[];
  baselineFacts?: CompletionBaselineFactDraft[];
  measurements?: CompletionMeasurementDraft[];
}

interface CompletionMeasurementDraft {
  id?: JsonValue;
  tool?: JsonValue;
  outcome?: JsonValue;
  digest?: JsonValue;
  digestKind?: JsonValue;
  subject?: JsonValue;
}

export interface CompletionReviewDraft {
  verdict?: JsonValue;
  coverageComplete?: JsonValue;
  criteria?: Array<{
    id?: JsonValue;
    status?: JsonValue;
    evidence?: JsonValue;
    receipts?: JsonValue;
    [key: string]: JsonValue | undefined;
  }>;
  findings?: JsonValue;
  additionalCriteria?: CompletionCriterionDraft[];
  measurements?: CompletionMeasurementDraft[];
}

export interface CompletionSupervisor {
  create(goal: string, signal?: AbortSignal): Promise<{ value: CompletionContractDraft; usage?: Usage }>;
  review(contract: CompletionContract, signal?: AbortSignal): Promise<{ value: CompletionReviewDraft; usage?: Usage }>;
}

const MAX_GOAL = 32_000;
const MAX_CRITERIA = 32;
const MAX_TEXT = 4_000;
const MAX_COVERAGE_AREA = 128;
const MAX_WEIGHT = 1_000;
const MAX_FINDINGS = 16;
const MAX_MEASUREMENTS = 64;
const MAX_BASELINE_FACTS = 16;

function text(value: any, max = MAX_TEXT): string {
  return isText(value) ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function timestamp(value: any): value is string {
  return isText(value) && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isCriterionSource(value: any): value is CompletionCriterionSource {
  return value === "user" || value === "repository" || value === "reference" || value === "runtime" || value === "derived";
}

function isCriterionStatus(value: any): value is CompletionCriterionStatus {
  return value === "passed" || value === "failed" || value === "blocked" || value === "unknown";
}

function isVerdict(value: any): value is CompletionVerdict {
  return value === "pass" || value === "fail" || value === "blocked";
}

function isMeasurementOutcome(value: any): value is CompletionMeasurementOutcome {
  return value === "productive" || value === "empty" || value === "failed";
}

function normalizeMeasurements(rows: CompletionMeasurementDraft[], prefix: "B" | "R"): CompletionMeasurement[] {
  const measurements: CompletionMeasurement[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, MAX_MEASUREMENTS)) {
    const id = text(row?.id, 16);
    const tool = text(row?.tool, 64);
    const outcome = text(row?.outcome, 32);
    const digest = text(row?.digest, 64).toLowerCase();
    const rawDigestKind = text(row?.digestKind, 16);
    const digestKind = rawDigestKind === "artifact" || rawDigestKind === "observation" ? rawDigestKind : undefined;
    const subject = text(row?.subject, 512);
    if (!new RegExp(`^${prefix}[1-9][0-9]?$`).test(id) || seen.has(id) || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool)
      || !isMeasurementOutcome(outcome) || !/^[a-f0-9]{64}$/.test(digest)) continue;
    seen.add(id);
    measurements.push({ id, tool, outcome, digest, ...(digestKind ? { digestKind } : undefined), ...(subject ? { subject } : undefined) });
  }
  return measurements;
}

function persistedMeasurement(value: any, prefix: "B" | "R"): CompletionMeasurement | null {
  if (!isJsonObject(value) || !isText(value.id) || !new RegExp(`^${prefix}[1-9][0-9]?$`).test(value.id)
    || !isText(value.tool) || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.tool)
    || !isMeasurementOutcome(value.outcome) || !isText(value.digest) || !/^[a-f0-9]{64}$/.test(value.digest)) return null;
  if (value.digestKind !== undefined && value.digestKind !== "artifact" && value.digestKind !== "observation") return null;
  if (value.subject !== undefined && (!isText(value.subject) || !text(value.subject, 512))) return null;
  const measurement: CompletionMeasurement = {
    id: value.id,
    tool: value.tool,
    outcome: value.outcome,
    digest: value.digest,
  };
  if (value.digestKind === "artifact" || value.digestKind === "observation") measurement.digestKind = value.digestKind;
  if (isText(value.subject)) measurement.subject = value.subject;
  return measurement;
}

function normalizeCriteria(
  rows: CompletionCriterionDraft[],
  existing: CompletionCriterion[] = [],
  baselineMeasurements: CompletionMeasurement[] = [],
): CompletionCriterion[] {
  const baselineById = new Map(baselineMeasurements.map((measurement) => [measurement.id, measurement]));
  const seen = new Set(existing.map((criterion) => criterion.requirement.toLowerCase()));
  const criteria: CompletionCriterion[] = [];
  for (const row of rows) {
    if (existing.length + criteria.length >= MAX_CRITERIA) break;
    const requirement = text(row?.requirement);
    const verification = text(row?.verification);
    const key = requirement.toLowerCase();
    if (!requirement || !verification || seen.has(key)) continue;
    seen.add(key);
    const rawSource = text(row?.source, 32);
    const coverageArea = text(row?.coverageArea, MAX_COVERAGE_AREA) || "general";
    const weight = isJsonNumber(row?.weight) && Number.isSafeInteger(row.weight)
      && row.weight >= 1 && row.weight <= MAX_WEIGHT ? row.weight : 1;
    const rawRelation = text(row?.baselineRelation, 16);
    const baselineRelation = rawRelation === "same" || rawRelation === "different" ? rawRelation : undefined;
    const baselineReceipts = [...new Set((Array.isArray(row?.baselineReceipts) ? row.baselineReceipts : [])
      .map((receipt) => text(receipt, 16))
      .filter((receipt) => {
        const measurement = baselineById.get(receipt);
        return measurement && baselineRelation && baselineMatchesClaim(requirement, baselineRelation, measurement);
      }))].slice(0, 1);
    criteria.push({
      id: `C${existing.length + criteria.length + 1}`,
      requirement,
      source: isCriterionSource(rawSource) ? rawSource : "derived",
      verification,
      required: row?.required !== false,
      coverageArea,
      weight,
      ...(baselineReceipts.length && baselineRelation ? { baselineReceipts, baselineRelation } : undefined),
    });
  }
  return criteria;
}

function normalizeBaselineFacts(
  rows: CompletionBaselineFactDraft[],
  measurements: CompletionMeasurement[],
): CompletionBaselineFact[] {
  const byId = new Map(measurements.map((measurement) => [measurement.id, measurement]));
  const facts: CompletionBaselineFact[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, MAX_BASELINE_FACTS)) {
    const statement = text(row?.statement);
    const key = statement.toLowerCase();
    const receipts = [...new Set((Array.isArray(row?.receipts) ? row.receipts : [])
      .map((receipt) => text(receipt, 16))
      .filter((receipt) => byId.get(receipt)?.outcome === "productive"))]
      .slice(0, MAX_MEASUREMENTS);
    if (!statement || !receipts.length || seen.has(key)) continue;
    seen.add(key);
    facts.push({ statement, receipts });
  }
  return facts;
}

export function createCompletionContract(
  goal: string,
  draft: CompletionContractDraft,
  createdAt = new Date().toISOString(),
): CompletionContract {
  const normalizedGoal = text(goal, MAX_GOAL);
  if (!normalizedGoal) throw new Error("completion contract needs a non-empty goal");
  const rows = Array.isArray(draft?.criteria) ? draft.criteria.slice(0, MAX_CRITERIA) : [];
  const baselineMeasurements = Array.isArray(draft?.measurements)
    ? normalizeMeasurements(draft.measurements, "B")
    : [];
  const baselineFacts = normalizeBaselineFacts(
    Array.isArray(draft?.baselineFacts) ? draft.baselineFacts : [],
    baselineMeasurements,
  );
  const criteria = normalizeCriteria(rows, [], baselineMeasurements);
  if (!criteria.length) throw new Error("completion contract needs at least one verifiable criterion");
  return {
    schemaVersion: 1,
    goal: normalizedGoal,
    revision: 1,
    instrumentRevision: 1,
    createdAt,
    criteria,
    ...(baselineFacts.length ? { baselineFacts } : undefined),
    ...(baselineMeasurements.length ? { baselineMeasurements } : undefined),
  };
}

function requiresExactBaseline(criterion: Pick<CompletionCriterion, "requirement">): boolean {
  const claim = criterion.requirement;
  return /\b(?:unchanged|unmodified|byte-for-byte)\b/i.test(claim)
    || /^(?:the\s+)?[\w.-]+\.[a-z0-9]{1,12}\b[^\n]{0,120}\b(?:preserv|retain|keep)/i.test(claim)
    || /(?:giữ nguyên|không thay đổi|bảo toàn)[^\n]{0,160}\b[\w.-]+\.[a-z0-9]{1,12}\b/iu.test(claim);
}

function requiresChangedBaseline(criterion: Pick<CompletionCriterion, "requirement">): boolean {
  return /\b[\w./-]+\.[a-z0-9]{1,12}\b[^\n]{0,160}\b(?:differ(?:s|ent)?|change[sd]?|modified|updated)\b/i.test(criterion.requirement)
    || /\b(?:differ(?:s|ent)?|change[sd]?|modified|updated)\b[^\n]{0,160}\b[\w./-]+\.[a-z0-9]{1,12}\b/i.test(criterion.requirement);
}

function baselineMatchesClaim(
  requirement: string,
  relation: "same" | "different",
  measurement: CompletionMeasurement,
): boolean {
  if (measurement.tool !== "read_file" || measurement.digestKind !== "artifact"
    || !measurement.subject?.startsWith("read_file:")) return false;
  const target = measurement.subject.slice("read_file:".length).toLowerCase();
  const basename = target.split("/").at(-1) ?? target;
  const claim = requirement.toLowerCase();
  if (!claim.includes(target) && !claim.includes(basename)) return false;
  return relation === "same"
    ? requiresExactBaseline({ requirement })
    : requiresChangedBaseline({ requirement });
}

export function applyCompletionReview(
  contract: CompletionContract,
  draft: CompletionReviewDraft,
  artifactRevision: number,
  reviewedAt = new Date().toISOString(),
): CompletionContract {
  const rows = Array.isArray(draft?.criteria) ? draft.criteria.slice(0, MAX_CRITERIA) : [];
  const byId = new Map(rows.map((row) => [text(row?.id, 32), row]));
  const measurements = Array.isArray(draft?.measurements)
    ? normalizeMeasurements(draft.measurements, "R")
    : undefined;
  const measurementById = new Map(measurements?.map((measurement) => [measurement.id, measurement]));
  const additions = normalizeCriteria(
    Array.isArray(draft?.additionalCriteria) ? draft.additionalCriteria.slice(0, MAX_CRITERIA) : [],
    contract.criteria,
  );
  const criteria = [...contract.criteria, ...additions];
  const evidence = criteria.map((criterion): CompletionEvidence => {
    const row = byId.get(criterion.id);
    const rawStatus = text(row?.status, 32);
    const evidenceText = text(row?.evidence);
    const receipts = measurements === undefined
      ? undefined
      : [...new Set((Array.isArray(row?.receipts) ? row.receipts : [])
        .map((receipt) => text(receipt, 16))
        .filter((receipt) => measurementById.has(receipt)))]
        .slice(0, MAX_MEASUREMENTS);
    let status: CompletionCriterionStatus = isCriterionStatus(rawStatus) ? rawStatus : "unknown";
    if (measurements !== undefined && (status === "passed" || status === "failed")) {
      const grounded = evidenceText.length > 0 && Boolean(receipts?.length);
      const supportsPass = status !== "passed"
        || receipts!.some((receipt) => measurementById.get(receipt)?.outcome !== "failed");
      if (!grounded || !supportsPass) status = "unknown";
    }
    if (measurements !== undefined && status === "passed"
      && (criterion.baselineRelation || requiresExactBaseline(criterion) || requiresChangedBaseline(criterion))) {
      const baselineById = new Map(contract.baselineMeasurements?.map((measurement) => [measurement.id, measurement]));
      const baselines = criterion.baselineReceipts ?? [];
      const current = measurements ?? [];
      const compare = (receipt: string) => {
        const baseline = baselineById.get(receipt);
        if (!baseline) return false;
        const candidates = current.filter((measurement) => measurement.tool === baseline.tool
          && (!baseline.subject || measurement.subject === baseline.subject)
          && (!baseline.digestKind || measurement.digestKind === baseline.digestKind));
        return criterion.baselineRelation === "same"
          ? candidates.some((measurement) => measurement.digest === baseline.digest)
          : candidates.some((measurement) => measurement.digest !== baseline.digest);
      };
      const established = baselines.length > 0 && criterion.baselineRelation
        ? criterion.baselineRelation === "same" ? baselines.every(compare) : baselines.some(compare)
        : false;
      if (!established) status = "unknown";
    }
    const result: CompletionEvidence = {
      criterionId: criterion.id,
      status,
      evidence: evidenceText,
    };
    if (receipts !== undefined) result.receipts = receipts;
    return result;
  });
  const required = evidence.filter((row) => criteria.find((criterion) => criterion.id === row.criterionId)?.required);
  const allPassed = required.length > 0 && required.every((row) => row.status === "passed");
  const anyFailed = required.some((row) => row.status === "failed");
  const requested = text(draft?.verdict, 32);
  const coverageComplete = draft?.coverageComplete !== false;
  const verdict: CompletionVerdict = requested === "pass" && allPassed && coverageComplete
    ? "pass"
    : anyFailed || requested === "fail"
      ? "fail"
      : "blocked";
  const findings = (Array.isArray(draft?.findings) ? draft.findings : [])
    .map((finding) => text(finding))
    .filter(Boolean)
    .slice(0, MAX_FINDINGS);
  const lastReview: CompletionReview = {
    verdict,
    artifactRevision: Math.max(0, Math.floor(artifactRevision)),
    reviewedAt,
    coverageComplete,
    evidence,
    findings,
  };
  if (measurements !== undefined) lastReview.measurements = measurements;
  return {
    ...contract,
    revision: contract.revision + 1,
    instrumentRevision: (contract.instrumentRevision ?? 1) + (additions.length ? 1 : 0),
    criteria,
    lastReview,
  };
}

export function isCompletionContract(value: any): value is CompletionContract {
  if (!isJsonObject(value)) return false;
  if (value.schemaVersion !== 1 || !text(value.goal, MAX_GOAL) || !isText(value.goal) || value.goal.length > MAX_GOAL
    || !isJsonNumber(value.revision) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !timestamp(value.createdAt)
    || !Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > MAX_CRITERIA) return false;
  if (value.instrumentRevision !== undefined && (!isJsonNumber(value.instrumentRevision)
    || !Number.isSafeInteger(value.instrumentRevision) || value.instrumentRevision < 1)) return false;
  const ids = new Set<string>();
  const baselineMeasurements = value.baselineMeasurements;
  if (baselineMeasurements !== undefined && (!Array.isArray(baselineMeasurements) || baselineMeasurements.length > MAX_MEASUREMENTS)) return false;
  const baselineById = new Map<string, CompletionMeasurement>();
  for (const measurement of baselineMeasurements ?? []) {
    const parsed = persistedMeasurement(measurement, "B");
    if (!parsed || baselineById.has(parsed.id)) return false;
    baselineById.set(parsed.id, parsed);
  }
  const baselineFacts = value.baselineFacts;
  if (baselineFacts !== undefined && (!Array.isArray(baselineFacts) || baselineFacts.length > MAX_BASELINE_FACTS)) return false;
  const baselineFactKeys = new Set<string>();
  for (const fact of baselineFacts ?? []) {
    if (!isJsonObject(fact) || !isText(fact.statement) || !text(fact.statement) || fact.statement.length > MAX_TEXT
      || baselineFactKeys.has(fact.statement.toLowerCase()) || !Array.isArray(fact.receipts) || fact.receipts.length < 1
      || fact.receipts.length > MAX_MEASUREMENTS
      || fact.receipts.some((receipt) => !isText(receipt) || baselineById.get(receipt)?.outcome !== "productive")) return false;
    baselineFactKeys.add(fact.statement.toLowerCase());
  }
  for (const criterion of value.criteria) {
    if (!isJsonObject(criterion) || !isText(criterion.id) || !/^C[1-9][0-9]?$/.test(criterion.id) || ids.has(criterion.id)
      || !isText(criterion.requirement) || !text(criterion.requirement) || criterion.requirement.length > MAX_TEXT
      || !isCriterionSource(criterion.source) || !isText(criterion.verification) || !text(criterion.verification) || criterion.verification.length > MAX_TEXT
      || !isBool(criterion.required)) return false;
    if (criterion.coverageArea !== undefined && (!isText(criterion.coverageArea)
      || !text(criterion.coverageArea, MAX_COVERAGE_AREA) || criterion.coverageArea.length > MAX_COVERAGE_AREA)) return false;
    if (criterion.weight !== undefined && (!isJsonNumber(criterion.weight) || !Number.isSafeInteger(criterion.weight)
      || criterion.weight < 1 || criterion.weight > MAX_WEIGHT)) return false;
    if (criterion.baselineReceipts !== undefined && (!Array.isArray(criterion.baselineReceipts)
      || criterion.baselineReceipts.length > MAX_MEASUREMENTS
      || criterion.baselineReceipts.some((receipt) => !isText(receipt) || !baselineById.has(receipt)))) return false;
    if ((criterion.baselineReceipts === undefined) !== (criterion.baselineRelation === undefined)
      || (criterion.baselineRelation !== undefined && criterion.baselineRelation !== "same" && criterion.baselineRelation !== "different")) return false;
    ids.add(criterion.id);
  }
  const review = value.lastReview;
  if (!review) return true;
  if (!isJsonObject(review) || !isVerdict(review.verdict)
    || !isJsonNumber(review.artifactRevision) || !Number.isSafeInteger(review.artifactRevision) || review.artifactRevision < 0 || !timestamp(review.reviewedAt)
    || !Array.isArray(review.evidence) || review.evidence.length !== value.criteria.length
    || !Array.isArray(review.findings) || review.findings.length > MAX_FINDINGS
    || review.findings.some((finding) => !isText(finding) || !text(finding) || finding.length > MAX_TEXT)) return false;
  if (review.coverageComplete !== undefined && !isBool(review.coverageComplete)) return false;
  const measurements = review.measurements;
  if (measurements !== undefined && (!Array.isArray(measurements) || measurements.length > MAX_MEASUREMENTS)) return false;
  const measurementById = new Map<string, CompletionMeasurement>();
  for (const measurement of measurements ?? []) {
    const parsed = persistedMeasurement(measurement, "R");
    if (!parsed || measurementById.has(parsed.id)) return false;
    measurementById.set(parsed.id, parsed);
  }
  const evidenceIds = new Set<string>();
  const evidenceStatus = new Map<string, CompletionCriterionStatus>();
  for (const row of review.evidence) {
    if (!isJsonObject(row) || !isText(row.criterionId) || !ids.has(row.criterionId) || evidenceIds.has(row.criterionId)
      || !isCriterionStatus(row.status) || !isText(row.evidence) || row.evidence.length > MAX_TEXT) return false;
    const receipts = row.receipts;
    if (receipts !== undefined && (!Array.isArray(receipts) || receipts.length > MAX_MEASUREMENTS
      || receipts.some((receipt) => !isText(receipt) || !measurementById.has(receipt)))) return false;
    if (measurements !== undefined && (row.status === "passed" || row.status === "failed")) {
      if (!text(row.evidence) || !Array.isArray(receipts) || receipts.length < 1) return false;
      if (row.status === "passed" && !receipts.some((receipt) => measurementById.get(String(receipt))?.outcome !== "failed")) return false;
    }
    evidenceIds.add(row.criterionId);
    evidenceStatus.set(row.criterionId, row.status);
  }
  if (review.verdict === "pass") {
    for (const criterion of value.criteria) {
      if (!isJsonObject(criterion) || !isText(criterion.id)) return false;
      if (criterion.required === true && evidenceStatus.get(criterion.id) !== "passed") return false;
    }
  }
  return true;
}

export interface CompletionCoverage {
  totalWeight: number;
  passedWeight: number;
  failedWeight: number;
  blockedWeight: number;
  unknownWeight: number;
  score: number;
}

/** Weighted coverage is diagnostic only; every required criterion must still pass. */
export function completionCoverage(contract: CompletionContract): CompletionCoverage {
  const statuses = new Map(contract.lastReview?.evidence.map((row) => [row.criterionId, row.status]));
  let totalWeight = 0, passedWeight = 0, failedWeight = 0, blockedWeight = 0, unknownWeight = 0;
  for (const criterion of contract.criteria) {
    if (!criterion.required) continue;
    const weight = criterion.weight ?? 1;
    totalWeight += weight;
    const status = statuses.get(criterion.id) ?? "unknown";
    if (status === "passed") passedWeight += weight;
    else if (status === "failed") failedWeight += weight;
    else if (status === "blocked") blockedWeight += weight;
    else unknownWeight += weight;
  }
  return {
    totalWeight,
    passedWeight,
    failedWeight,
    blockedWeight,
    unknownWeight,
    score: totalWeight ? passedWeight / totalWeight : 0,
  };
}

export function renderCompletionContract(contract: CompletionContract): string {
  const evidence = new Map(contract.lastReview?.evidence.map((row) => [row.criterionId, row.status]));
  const coverage = completionCoverage(contract);
  const lines = contract.criteria.map((criterion) =>
    `- [${evidence.get(criterion.id) === "passed" ? "x" : " "}] ${criterion.id} ${criterion.requirement} (${criterion.source}; area=${criterion.coverageArea ?? "general"}; weight=${criterion.weight ?? 1})\n  verify: ${criterion.verification}` +
    (criterion.baselineReceipts?.length ? `\n  baseline ${criterion.baselineRelation}: ${criterion.baselineReceipts.join(", ")}` : ""));
  const verdict = contract.lastReview?.verdict ?? "not reviewed";
  const baselineFacts = contract.baselineFacts?.map((fact) => `- ${fact.statement} [${fact.receipts.join(", ")}]`) ?? [];
  return [
    `Completion contract v${contract.revision} / instrument v${contract.instrumentRevision ?? 1}: ${verdict}`,
    `Weighted coverage: ${coverage.passedWeight}/${coverage.totalWeight} (${Math.round(coverage.score * 100)}%)`,
    ...(baselineFacts.length ? ["Pre-work facts:", ...baselineFacts] : []),
    ...lines,
  ].join("\n");
}
