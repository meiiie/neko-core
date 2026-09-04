import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Agent, classifyToolObservation, type EventHook } from "../core/agent.ts";
import type {
  CompletionContract,
  CompletionContractDraft,
  CompletionMeasurement,
  CompletionReviewDraft,
  CompletionSupervisor,
} from "../core/completion-contract.ts";
import { CostTracker, type Usage } from "../core/cost.ts";
import type { Provider } from "../core/ports.ts";
import { ToolRegistry } from "../core/tool-runtime.ts";
import type { NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";
import { inheritToolRegistrySettings } from "./tool-registry.ts";
import { isJsonObject, isText } from "../shared/wire.ts";

const BUILDER_TOOLS = ["read_file", "search", "glob", "ls"] as const;
const REVIEWER_TOOLS = [...BUILDER_TOOLS, "bash"] as const;
const CRITERION_SCHEMA = {
  type: "object",
  properties: {
    phase: { type: "string", enum: ["final_state"] },
    requirement: { type: "string" },
    source: { type: "string", enum: ["user", "repository", "reference", "runtime", "derived"] },
    verification: { type: "string" },
    required: { type: "boolean" },
    coverageArea: { type: "string" },
    weight: { type: "integer", minimum: 1, maximum: 1000 },
    baselineReceipts: { type: "array", maxItems: 1, items: { type: "string" } },
    baselineRelation: { type: "string", enum: ["same", "different"] },
  },
  required: ["phase", "requirement", "source", "verification", "coverageArea", "weight"],
  additionalProperties: false,
};
const BASELINE_FACT_SCHEMA = {
  type: "object",
  properties: {
    statement: { type: "string" },
    receipts: { type: "array", minItems: 1, items: { type: "string" } },
  },
  required: ["statement", "receipts"],
  additionalProperties: false,
};
const BUILDER_SCHEMA = {
  type: "object",
  properties: {
    baselineFacts: { type: "array", items: BASELINE_FACT_SCHEMA },
    criteria: { type: "array", minItems: 1, items: CRITERION_SCHEMA },
  },
  required: ["baselineFacts", "criteria"],
  additionalProperties: false,
};
const REVIEWER_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "blocked"] },
    coverageComplete: { type: "boolean" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["passed", "failed", "blocked", "unknown"] },
          evidence: { type: "string" },
          receipts: { type: "array", items: { type: "string" } },
        },
        required: ["id", "status", "evidence", "receipts"],
        additionalProperties: false,
      },
    },
    findings: { type: "array", items: { type: "string" } },
    additionalCriteria: { type: "array", items: CRITERION_SCHEMA },
  },
  required: ["verdict", "coverageComplete", "criteria", "findings", "additionalCriteria"],
  additionalProperties: false,
};

function reviewerSchema(contract: CompletionContract): any {
  const criteria = REVIEWER_SCHEMA.properties.criteria;
  return {
    ...REVIEWER_SCHEMA,
    properties: {
      ...REVIEWER_SCHEMA.properties,
      criteria: {
        ...criteria,
        minItems: contract.criteria.length,
        maxItems: contract.criteria.length,
        items: {
          ...criteria.items,
          properties: {
            ...criteria.items.properties,
            id: { type: "string", enum: contract.criteria.map((criterion) => criterion.id) },
          },
        },
      },
    },
  };
}

function coversContract(review: CompletionReviewDraft, contract: CompletionContract): boolean {
  const ids = (review.criteria ?? []).map((criterion) => String(criterion.id ?? ""));
  return ids.length === contract.criteria.length
    && new Set(ids).size === ids.length
    && contract.criteria.every((criterion) => ids.includes(criterion.id));
}

function shouldAdjudicate(review: CompletionReviewDraft, measurements: CompletionMeasurement[]): boolean {
  if (review.verdict === "fail") return false;
  const productive = new Set(measurements.filter((measurement) => measurement.outcome === "productive").map((measurement) => measurement.id));
  const rows = Array.isArray(review.criteria) ? review.criteria : [];
  if (rows.some((row) => row.status === "failed")) return false;
  return rows.some((row) => (row.status === "unknown" || row.status === "blocked")
    && String(row.evidence ?? "").trim().length > 0
    && Array.isArray(row.receipts)
    && row.receipts.some((receipt) => productive.has(String(receipt))));
}

function adjudicationSchema(review: CompletionReviewDraft): any {
  const ids = (review.criteria ?? []).map((row) => String(row.id ?? ""));
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail", "blocked"] },
      criteria: {
        type: "array",
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ids },
            status: { type: "string", enum: ["passed", "failed", "blocked", "unknown"] },
          },
          required: ["id", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "criteria"],
    additionalProperties: false,
  };
}

function applyAdjudication(review: CompletionReviewDraft, value: any): CompletionReviewDraft | undefined {
  if (!isJsonObject(value) || !["pass", "fail", "blocked"].includes(String(value.verdict ?? ""))
    || !Array.isArray(value.criteria)) return undefined;
  const original = review.criteria ?? [];
  const statuses = new Map<string, string>();
  for (const row of value.criteria) {
    if (!isJsonObject(row)) return undefined;
    const id = String(row.id ?? "");
    const status = String(row.status ?? "");
    if (!original.some((criterion) => criterion.id === id) || statuses.has(id)
      || !["passed", "failed", "blocked", "unknown"].includes(status)) return undefined;
    statuses.set(id, status);
  }
  if (statuses.size !== original.length) return undefined;
  return {
    ...review,
    verdict: value.verdict,
    criteria: original.map((row) => ({ ...row, status: statuses.get(String(row.id ?? ""))! })),
  };
}

const BUILDER_PROMPT = `You are Neko's independent completion-standard author. Work read-only and before implementation.
Inspect the request and relevant repository docs/tests/reference material. Build a compact executable definition of done that maps the whole behavioral surface, not merely likely implementation steps. Give every criterion a stable coverageArea and an integer weight from 1 to 1000 representing approximate behavioral case mass. Weight is diagnostic: every required criterion remains mandatory regardless of weight. Prefer a small number of orthogonal areas whose weights add up to a useful map over many redundant criteria.
Separate what is true before work from what must be true at completion. Put diagnosis, reproduced failures, inventories, and other pre-work observations in baselineFacts with the receipts that directly support them. They inform implementation but are never completion gates. Criteria are final observable outcomes only; phase must be "final_state". Never make "inspect", "understand", "diagnose", "reproduce before fixing", or another historical process step a criterion.
Each criterion must be observable, independently checkable, and tied to user, repository, reference, runtime, or derived evidence. A validator command is an instrument, not a final outcome: do not require tsc, typecheck, lint, build, or another named tool unless the user or inspected repository explicitly requires that exact command and it is available before work. Express derived quality criteria as toolchain-independent observable outcomes and name an available verification route. Do not add generic quality slogans. Do not edit files. Every tool result starts with a baseline receipt such as B1. A successful read_file receipt carries the exact file-byte SHA-256; other tools carry an observation SHA-256. For an exact unchanged/unmodified or named-file preservation criterion, inspect only the pre-work subject(s) that must remain identical and set baselineRelation="same" with those receipts. For a criterion requiring a named file to change, set baselineRelation="different" with that file's receipt. Split mixed state comparisons into separate atomic criteria; a criterion cannot use one baseline relation for both changed and preserved subjects. Do not attach unrelated baseline receipts. Without a baseline, an exact state-comparison criterion cannot later pass. Prefer existing tests and validation scripts. For a targeted JavaScript/TypeScript procedure not already covered, specify one protected Bun stdin differential using command "bun --no-env-file --no-install -" plus minimal validator_source; never prescribe bun -e or node -e.
Return JSON only: {"baselineFacts":[{"statement":"observed pre-work fact","receipts":["B1"]}],"criteria":[{"phase":"final_state","requirement":"final observable outcome","source":"user|repository|reference|runtime|derived","verification":"exact inspection, command, or comparison","required":true,"coverageArea":"stable behavior area","weight":10,"baselineReceipts":["B1"],"baselineRelation":"same|different"}]}.`;

const REVIEWER_PROMPT = `You are Neko's independent completion validator. You did not implement the artifact and must not edit it.
Inspect the actual current state and run appropriate existing foreground test/typecheck/lint/check/verify commands when available. Judge every fixed criterion; never delete, weaken, reduce the weight of, or reinterpret one to fit the implementation. A claim, diff, or action log is not evidence of its own outcome. An unavailable optional tool is an instrument limitation, not an artifact defect: do not install it, search the host for it, or append it as a completion criterion when another current instrument verifies the requested outcome. Mark a criterion blocked or unknown only when its outcome genuinely remains unmeasured. Keep raw cases, commands, and output in each evidence field; findings contain only clustered outcome-level gaps, never the private measurement sample. Reassess the behavioral map after each candidate. If a material area is absent or under-sampled, set coverageComplete=false and append the missing outcome through additionalCriteria with its stable area and approximate case-mass weight. Set coverageComplete=true only when the current instrument covers every material observable area. Never append a preferred command or toolchain as an outcome, and do not use additions to restate or weaken existing criteria.
Every tool result starts with an unforgeable measurement receipt such as R1. A successful read_file receipt carries the exact file-byte SHA-256; other tools carry an observation SHA-256. A passed or failed criterion must cite one or more receipt IDs from this review. Prose without a current receipt is unknown, not evidence. Baseline relations are checked mechanically across fresh same-subject measurements, so cite the receipt that proves the criterion's outcome rather than duplicating receipt bookkeeping. When no existing validator covers a narrow JavaScript/TypeScript behavior, run exactly one targeted differential check with bash command "bun --no-env-file --no-install -" and validator_source; keep it minimal, deterministic, read-only, and specific to the criterion.
Return JSON only: {"verdict":"pass|fail|blocked","coverageComplete":true,"criteria":[{"id":"C1","status":"passed|failed|blocked|unknown","evidence":"concise observed evidence","receipts":["R1"]}],"findings":["outcome-level gap, grouped by root cause"],"additionalCriteria":[{"phase":"final_state","requirement":"newly discovered final outcome","source":"user|repository|reference|runtime|derived","verification":"independent check","required":true,"coverageArea":"stable behavior area","weight":10}]}. A pass requires coverageComplete=true and fresh evidence for every required criterion, including any addition in a later review.`;

function measurementSubject(root: string, name: string, args: any): string {
  if (!["read_file", "ls", "glob", "search"].includes(name)) return "";
  const raw = String(args?.path ?? ".").trim() || ".";
  const absolute = resolve(root, raw);
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "";
  return `${name}:${(rel || ".").replace(/\\/g, "/")}`.slice(0, 512);
}

function artifactDigest(root: string, name: string, args: any, outcome: CompletionMeasurement["outcome"]): string | null {
  if (name !== "read_file" || outcome !== "productive") return null;
  try {
    const path = realpathSync(resolve(root, String(args?.path ?? "")));
    const rel = relative(realpathSync(resolve(root)), path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

class CompletionMeasurementRegistry extends ToolRegistry {
  readonly measurements: CompletionMeasurement[] = [];
  receiptPrefix: "B" | "R" = "R";

  override async execute(name: string, args: any, signal?: AbortSignal): Promise<string | any[]> {
    const observation = await super.execute(name, args, signal);
    const id = `${this.receiptPrefix}${this.measurements.length + 1}`;
    const outcome = classifyToolObservation(observation);
    const serialized = isText(observation) ? observation : JSON.stringify(observation);
    const artifact = artifactDigest(this.root, name, args, outcome);
    const digest = artifact ?? createHash("sha256").update(serialized).digest("hex");
    const digestKind = artifact ? "artifact" : "observation";
    const subject = measurementSubject(this.root, name, args);
    this.measurements.push({ id, tool: name, outcome, digest, digestKind, ...(subject ? { subject } : undefined) });
    const marker = `[measurement ${id}; tool=${name}; outcome=${outcome}; ${digestKind}_sha256=${digest}]`;
    return isText(observation)
      ? `${marker}\n${observation}`
      : [{ type: "text", text: marker }, ...observation];
  }
}

function jsonObject(text: string): any {
  const bounded = text.trim().slice(0, 128_000);
  for (const match of bounded.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try {
      const value = JSON.parse(match[1]!.trim());
      if (isJsonObject(value)) return value;
    } catch { /* another fenced block or the fallback may contain the structured result */ }
  }
  try {
    const value = JSON.parse(bounded);
    if (isJsonObject(value)) return value;
  } catch { /* fall through to a prose-wrapped object */ }
  const start = bounded.indexOf("{");
  const end = bounded.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("independent validator returned no JSON object");
  const value = JSON.parse(bounded.slice(start, end + 1));
  if (!isJsonObject(value)) throw new Error("independent validator returned invalid JSON");
  return value;
}

function completionContractDraft(value: any): CompletionContractDraft {
  if (!isJsonObject(value)) throw new Error("completion-standard response must be an object");
  return {
    baselineFacts: Array.isArray(value.baselineFacts) ? value.baselineFacts.filter(isJsonObject) : [],
    criteria: Array.isArray(value.criteria) ? value.criteria.filter(isJsonObject) : [],
  };
}

function finalStateContractDraft(value: CompletionContractDraft): boolean {
  if (!Array.isArray(value.criteria) || value.criteria.length < 1) return false;
  return value.criteria.every((criterion) => {
    if (criterion.phase !== "final_state") return false;
    const requirement = String(criterion.requirement ?? "");
    return !/(?:\b(?:inspect|understand|diagnos|reproduc|trace)\w*\b.{0,100}\bbefore\b.{0,60}\b(?:fix|implement|edit|work)\w*\b|\bbefore\b.{0,60}\b(?:fix|implementation|editing|work)\w*\b)/i.test(requirement);
  });
}

function completionReviewDraft(value: any): CompletionReviewDraft {
  if (!isJsonObject(value)) throw new Error("completion-review response must be an object");
  return {
    verdict: value.verdict,
    coverageComplete: value.coverageComplete,
    criteria: Array.isArray(value.criteria) ? value.criteria.filter(isJsonObject) : [],
    findings: value.findings,
    additionalCriteria: Array.isArray(value.additionalCriteria) ? value.additionalCriteria.filter(isJsonObject) : [],
  };
}

function usage(agent: Agent): Usage {
  const cost = agent.cost;
  return {
    prompt_tokens: cost.promptTokens,
    completion_tokens: cost.completionTokens,
    total_tokens: cost.totalTokens,
    cached_tokens: cost.cachedTokens,
    cache_write_tokens: cost.cacheWriteTokens,
    context_tokens: cost.lastPrompt,
    context_cached_tokens: cost.lastCached,
    model_calls: cost.calls,
  };
}

function combinedUsage(agent: Agent, extras: Usage[]): Usage {
  const tracker = new CostTracker();
  tracker.add(usage(agent));
  for (const extra of extras) tracker.add(extra);
  return {
    prompt_tokens: tracker.promptTokens,
    completion_tokens: tracker.completionTokens,
    total_tokens: tracker.totalTokens,
    cached_tokens: tracker.cachedTokens,
    cache_write_tokens: tracker.cacheWriteTokens,
    context_tokens: tracker.lastPrompt,
    context_cached_tokens: tracker.lastCached,
    model_calls: tracker.calls,
  };
}

export function createCompletionSupervisor(
  cfg: NekoConfig,
  parent: ToolRegistry,
  options: { providerFactory?: () => Provider; onEvent?: EventHook } = {},
): CompletionSupervisor {
  const run = async <T>(
    systemPrompt: string,
    prompt: string,
    review: boolean,
    parse: (value: any) => T,
    responseSchema: any,
    validate: (value: T) => boolean = () => true,
    signal?: AbortSignal,
    adjudicationContract?: CompletionContract,
  ) => {
    const registry = inheritToolRegistrySettings(
      new CompletionMeasurementRegistry(parent.root, "auto", async () => false, parent.mcp, parent.nativeBackend),
      parent,
    );
    registry.receiptPrefix = review ? "R" : "B";
    registry.allowOnlyTools(review ? REVIEWER_TOOLS : BUILDER_TOOLS);
    registry.disabled.add("task");
    registry.hooks = undefined;
    registry.readOutsideRoot = false;
    registry.additionalWriteRoots = [];
    registry.allowBackgroundBash = false;
    registry.allowDangerousBash = false;
    if (review) registry.sandboxBash = true;
    registry.explicitYolo = false;
    registry.noTools = false;
    registry.computerPort = undefined;
    const lease = registry.enterTurn({
      name: review ? "completion-validator" : "completion-standard",
      allowedTools: review ? REVIEWER_TOOLS : BUILDER_TOOLS,
      allowBackgroundBash: false,
      bashPolicy: review ? "foreground-validator-only" : undefined,
      reason: review ? "independent read-only completion review" : "pre-implementation completion standard",
    });
    const provider = options.providerFactory?.() ?? getProvider(cfg);
    const agent = new Agent({
      provider,
      tools: registry,
      maxSteps: Math.max(8, Math.min(cfg.maxSteps, 24)),
      maxContextTokens: cfg.contextWindow,
      systemPrompt,
      verifyBeforeExit: false,
      verifyStateChangesBeforeExit: false,
      adaptiveEffort: false,
      onEvent: options.onEvent,
    });
    try {
      const answer = await agent.runResilient(prompt, { signal });
      if (answer === "[interrupted]") throw new DOMException("completion validation interrupted", "AbortError");
      let value: T;
      const extraUsage: Usage[] = [];
      try {
        value = parse(jsonObject(answer));
        if (!validate(value)) throw new Error("structured result omitted required criterion coverage");
      } catch {
        if (signal?.aborted) throw new DOMException("completion validation interrupted", "AbortError");
        const privateEvidence = agent.messages
          .filter((message) => message.role === "tool")
          .map((message) => String(message.content ?? "").slice(0, 12_000))
          .join("\n\n")
          .slice(0, 64_000);
        const repaired = await provider.complete(
          [{
            role: "system",
            content: "You are a strict JSON transcription worker. Do not call tools, make new claims, or change the fixed criteria. Reconstruct one complete object from the supplied candidate and private evidence, following the response schema exactly.",
          }, {
            role: "user",
            content: `Original structured task:\n${prompt.slice(0, 48_000)}\n\nCandidate answer:\n${answer.slice(0, 64_000)}\n\nPrivate measurement evidence:\n${privateEvidence}\n\nMeasurement registry:\n${JSON.stringify(registry.measurements)}\n\nReturn only the complete JSON object.`,
          }],
          undefined,
          undefined,
          signal,
          { responseSchema, reasoningEffort: "off" },
        );
        if (repaired.tool_calls?.length) throw new Error("structured repair attempted an unavailable tool call");
        if (repaired.usage) extraUsage.push(repaired.usage);
        value = parse(jsonObject(repaired.content ?? ""));
        if (!validate(value)) throw new Error("structured repair omitted required criterion coverage");
      }
      let reviewValue: CompletionReviewDraft | undefined;
      if (review) {
        // SAFETY: each call binds the review flag to completionReviewDraft; the create path binds false to completionContractDraft.
        reviewValue = value as CompletionReviewDraft;
      }
      if (reviewValue && adjudicationContract && shouldAdjudicate(reviewValue, registry.measurements)) {
        try {
          const adjudicated = await provider.complete(
            [{
              role: "system",
              content: "You are a no-tool evidence adjudicator. Return only status labels for every fixed criterion and the aggregate verdict. Judge the exact requirement against the immutable recorded evidence. A productive receipt is not automatically sufficient: keep unknown or blocked when its evidence does not prove the criterion. You cannot add or rewrite evidence, receipts, findings, criteria, or claims.",
            }, {
              role: "user",
              content: `Fixed criteria:\n${JSON.stringify(adjudicationContract.criteria)}\n\nCandidate review and immutable evidence ledger:\n${JSON.stringify(value)}\n\nPre-work facts and measurements:\n${JSON.stringify({ facts: adjudicationContract.baselineFacts ?? [], measurements: adjudicationContract.baselineMeasurements ?? [] })}\n\nCurrent measurement registry:\n${JSON.stringify(registry.measurements)}\n\nReturn only {"verdict":"pass|fail|blocked","criteria":[{"id":"C1","status":"passed|failed|blocked|unknown"}]}.`,
            }],
            undefined,
            undefined,
            signal,
            { responseSchema: adjudicationSchema(reviewValue), reasoningEffort: cfg.effort || undefined },
          );
          if (adjudicated.usage) extraUsage.push(adjudicated.usage);
          if (!adjudicated.tool_calls?.length) {
            const candidate = applyAdjudication(reviewValue, jsonObject(adjudicated.content ?? ""));
            if (candidate) {
              const parsedCandidate = parse(candidate);
              if (validate(parsedCandidate)) value = parsedCandidate;
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      if (reviewValue) reviewValue.measurements = registry.measurements;
      else {
        // SAFETY: the only non-review call binds completionContractDraft and cannot enter the review branch above.
        (value as CompletionContractDraft).measurements = registry.measurements;
      }
      return { value, usage: combinedUsage(agent, extraUsage) };
    } finally {
      lease.close();
      try { await provider.dispose?.(); } catch { /* validator cleanup must not replace its result */ }
    }
  };

  return {
    create: (goal, signal) => run(BUILDER_PROMPT, `Goal:\n${goal}`, false, completionContractDraft, BUILDER_SCHEMA, finalStateContractDraft, signal),
    review: (contract: CompletionContract, signal) => run<CompletionReviewDraft>(
      REVIEWER_PROMPT,
      `Completion contract (criteria are fixed for this review):\n${JSON.stringify(contract, null, 2)}\n\nInspect the current artifact in ${JSON.stringify(parent.root)} and return the verdict.`,
      true,
      completionReviewDraft,
      reviewerSchema(contract),
      (value) => coversContract(value, contract),
      signal,
      contract,
    ),
  };
}
