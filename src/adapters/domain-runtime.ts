import { Agent } from "../core/agent.ts";
import type { EventHook } from "../core/agent-constants.ts";
import type { McpTools, Provider } from "../core/ports.ts";
import { ToolRegistry, type ApprovalGate } from "../core/tool-runtime.ts";
import { isJsonObject, isText, type JsonValue } from "../shared/wire.ts";
import { messageOf } from "../shared/debug.ts";
import { DomainWorkingMemory } from "./domain-memory.ts";
import { decisionEvidence } from "./domain-evidence.ts";
import { reviewInstruction, type PendingActions } from "./domain-review.ts";
import { clarificationContext } from "./domain-clarification.ts";

export type DomainEffect = "read" | "write" | "ask";
export type ReceiptOutcome = "succeeded" | "noop" | "failed" | "unknown";

export interface DomainReceipt {
  sequence: number;
  name: string;
  arguments: JsonValue;
  effect: DomainEffect;
  outcome: ReceiptOutcome;
  observation: string;
}

export interface DomainRuntimeOptions {
  root: string;
  provider: Provider;
  tools: McpTools;
  effects: Readonly<Record<string, DomainEffect>>;
  classifyReceipt: (name: string, observation: string) => ReceiptOutcome;
  systemPrompt: string;
  approval: ApprovalGate;
  mode?: ToolRegistry["mode"];
  maxRequests?: number;
  repairTextTools?: boolean;
  workingNote?: boolean;
  decisionEvidence?: boolean;
  decisionReview?: "terminal" | "prewrite";
  clarificationReview?: boolean;
  onEvent?: EventHook;
  onCheckpoint?: () => void | Promise<void>;
}

/** Detect explicit tool envelopes, not ordinary questions or JSON arguments in prose.
 * This function never turns text into an executable call. */
export function textToolEnvelope(text: string, names: ReadonlySet<string>): boolean {
  if (/(?:^|\n)\s*[\[{][\s\S]*?"tool_(?:calls|results)"\s*:/.test(text)
      && [...names].some((name) => text.includes(JSON.stringify(name)))) return true;
  const candidates = [text.trim(),
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g), (m) => m[1]),
    ...Array.from(text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g), (m) => m[1]),
    ...Array.from(text.matchAll(/\n\s*(?=[{\[])/g), (m) => text.slice(m.index).trim())];
  const isCall = (value: JsonValue): boolean => {
    if (!isJsonObject(value)) return false;
    const fn = isJsonObject(value.function) ? value.function : value;
    return isText(fn.name) && names.has(fn.name)
      && ("arguments" in fn || "parameters" in fn);
  };
  for (const candidate of candidates) {
    let value: JsonValue;
    try { value = JSON.parse(candidate); } catch { continue; }
    if (isCall(value)) return true;
    if (Array.isArray(value) && value.some(isCall)) return true;
    if (isJsonObject(value) && Array.isArray(value.tool_calls) && value.tool_calls.some(isCall)) return true;
  }
  return false;
}

export class DomainRequestLimit extends Error {
  constructor() { super("Domain provider request budget exhausted"); }
}

export class DomainUncertainMutation extends Error {
  constructor() { super("Domain write outcome is unknown; preserve receipts and reconcile before resuming"); }
}

/** A single isolated domain task, composed through Neko's existing provider/tool ports.
 * Domain receipts replace coding verification; they are not a business-success verdict. */
export function createDomainRuntime(options: DomainRuntimeOptions) {
  const effects = Object.freeze({ ...options.effects });
  const schemas = structuredClone(options.tools.toolSchemas());
  const names = schemas.map((s) => String(s?.function?.name ?? ""));
  if (!names.length || new Set(names).size !== names.length
      || names.some((name) => !/^mcp__[a-z0-9_]+__.+$/.test(name) || !effects[name] || !options.tools.has(name))
      || Object.keys(effects).some((name) => !names.includes(name))
      || Object.values(effects).some((effect) => !["read", "write", "ask"].includes(effect))) {
    throw new Error("Domain capability schemas and trusted effect map must match exactly");
  }
  const maxRequests = options.maxRequests ?? 16;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("Invalid domain request budget");
  const receipts: DomainReceipt[] = [];
  const memory = options.workingNote ? new DomainWorkingMemory() : undefined;
  let requests = 0;
  let started = false;
  let closed = false;
  let stepLimitReached = false;
  let waitingForUser = false;
  let uncertainMutation = false;
  let originalRequest = "";
  let quarantinedProtocol = false;
  let pendingWrite: PendingActions | undefined;
  let reviewingNextResponse = false;
  let heldClarification: PendingActions | undefined;
  let holdCurrentBatch = false;
  let clarificationReviews = 0;
  const toolNames = new Set(names.flatMap((name) => [name, name.replace(/^mcp__.+?__/, "")]));
  const tools: McpTools = {
    toolSchemas: () => structuredClone(schemas),
    has: (name) => names.includes(name),
    permission: (name) => effects[name] === "read" && options.tools.permission?.(name) === "safe" ? "safe" : "gated",
    async call(name, args, signal) {
      if (!names.includes(name)) throw new Error("Tool outside domain capability ceiling");
      if (waitingForUser) return "Error: clarification already executed; wait for the next user turn.";
      if (uncertainMutation) throw new DomainUncertainMutation();
      if (holdCurrentBatch) return JSON.stringify({ ok: false, executed: false, user_asked: false,
        status: "held_for_clarification_review", message: "This entire proposed batch is unexecuted. Reconsider the missing fields using the conversation before issuing the next native actions." });
      let observation: string;
      let outcome: ReceiptOutcome = "unknown";
      let observed = false;
      try {
        observation = await options.tools.call(name, args, signal);
        observed = true;
      } catch (error) {
        observation = `Error: tool observation unavailable: ${messageOf(error)}`;
      }
      if (observed) {
        try { outcome = options.classifyReceipt(name, observation); }
        catch (error) { options.onEvent?.("domain_receipt_classification_error", { name, error: messageOf(error) }); }
      }
      const receipt: DomainReceipt = {
        sequence: receipts.length + 1, name, arguments: structuredClone(args),
        effect: effects[name], observation, outcome,
      };
      receipts.push(receipt);
      if (receipt.effect === "ask" && receipt.outcome === "succeeded") waitingForUser = true;
      if (receipt.effect === "write" && receipt.outcome === "unknown") uncertainMutation = true;
      options.onEvent?.("domain_receipt", structuredClone(receipt));
      return observation;
    },
  };
  const provider: Provider = {
    async complete(messages, schema, delta, signal, opts) {
      signal?.throwIfAborted();
      if (uncertainMutation) throw new DomainUncertainMutation();
      if (waitingForUser) return { content: "Đã yêu cầu bổ sung thông tin.", tool_calls: [] };
      if (requests >= maxRequests) throw new DomainRequestLimit();
      requests++;
      let context = memory ? memory.context(messages, receipts) : messages;
      if (options.decisionEvidence) context = decisionEvidence(context, originalRequest, receipts);
      if (heldClarification) {
        context = clarificationContext(context, originalRequest, receipts, heldClarification);
        heldClarification = undefined;
      }
      holdCurrentBatch = false;
      const isReviewResponse = reviewingNextResponse;
      reviewingNextResponse = false;
      const response = await options.provider.complete(context, schema, delta, signal,
        options.decisionReview || options.clarificationReview ? { ...opts, onToolCallReady: undefined, executeTool: undefined } : opts);
      if (options.repairTextTools !== false && textToolEnvelope(response.content ?? "", toolNames)) {
        quarantinedProtocol = true;
        options.onEvent?.("domain_protocol_quarantine", {
          text: response.content, native_proposals_not_executed: response.tool_calls,
        });
        return { content: "Invalid text tool envelope quarantined. No tool in this response was executed; claimed tool results are not observations.",
          tool_calls: [], usage: response.usage };
      }
      if (options.decisionReview === "prewrite" && !isReviewResponse
          && response.tool_calls.some((call) => effects[call.name] === "write")) {
        pendingWrite = structuredClone(response.tool_calls.map(({ name, arguments: args }) => ({ name, arguments: args })));
        options.onEvent?.("domain_pending_actions", { proposals_not_executed: pendingWrite });
        return { content: "Proposed actions held for pre-execution review. No tool from this response has executed.",
          tool_calls: [], usage: response.usage };
      }
      if (memory?.observe(response.content)) options.onEvent?.("domain_working_note", memory.snapshot());
      if (options.clarificationReview && clarificationReviews === 0 && requests < maxRequests
          && response.tool_calls.some((call) => effects[call.name] === "ask")) {
        heldClarification = structuredClone(response.tool_calls.map(({ name, arguments: args }) => ({ name, arguments: args })));
        holdCurrentBatch = true;
        clarificationReviews++;
        options.onEvent?.("domain_clarification_review", { attempt: clarificationReviews, held_proposals: heldClarification });
      }
      return response;
    },
  };
  const registry = new ToolRegistry(options.root, options.mode ?? "default", options.approval, tools);
  registry.allowOnlyTools(names);
  registry.allowBackgroundBash = false;
  registry.readOutsideRoot = false;
  const agent = new Agent({
    provider, tools: registry, systemPrompt: options.systemPrompt, maxSteps: maxRequests,
    verifyBeforeExit: false, verifyStateChangesBeforeExit: false, adaptiveEffort: false,
    onEvent: (kind, detail) => {
      if (kind === "max_steps") stepLimitReached = true;
      options.onEvent?.(kind, detail);
    }, onCheckpoint: options.onCheckpoint,
  });
  agent.appendSystem("");
  return {
    agent,
    registry,
    get receipts(): readonly DomainReceipt[] { return structuredClone(receipts); },
    async run(instruction: string, signal?: AbortSignal) {
      if (started || closed) throw new Error("Create a fresh domain runtime for each independent task");
      started = true;
      originalRequest = instruction;
      memory?.start(instruction);
      let answer = await agent.runResilient(instruction, { signal, maxRecoveries: 0 });
      let repairs = 0;
      let terminalReviews = 0;
      let writeReviews = 0;
      while (!signal?.aborted && requests < maxRequests && !waitingForUser && !stepLimitReached) {
        let instruction: string;
        if (pendingWrite) {
          instruction = reviewInstruction(originalRequest, receipts, pendingWrite);
          pendingWrite = undefined;
          reviewingNextResponse = true;
          writeReviews++;
          options.onEvent?.("domain_write_review", { attempt: writeReviews });
        } else if (options.repairTextTools !== false && quarantinedProtocol && repairs < 1) {
          repairs++;
          quarantinedProtocol = false;
          options.onEvent?.("domain_protocol_repair", { reason: "text_tool_envelope", attempt: repairs });
          instruction =
          "PROTOCOL REPAIR: The last answer contained tool-call JSON as text; that text did not execute any tool. " +
          "If an action or clarification is still required, issue the actual native tool call using the advertised name/schema. " +
          "Do not replay successful calls already present in tool results, invent results, or perform a lookup merely to verify completion. " +
          "If no action remains, answer briefly in ordinary text.";
        } else if (options.decisionReview && !quarantinedProtocol && terminalReviews === 0) {
          instruction = reviewInstruction(originalRequest, receipts);
          terminalReviews++;
          options.onEvent?.("domain_terminal_review", { attempt: terminalReviews });
        } else break;
        answer = await agent.runResilient(instruction, { signal, internal: true, maxRecoveries: 0 });
      }
      return {
        answer: memory ? memory.visibleAnswer(answer) : answer, requests, repairs,
        terminalReviews, writeReviews, clarificationReviews,
        workingMemory: memory?.snapshot(),
        protocolStatus: signal?.aborted ? "interrupted" : stepLimitReached || pendingWrite || heldClarification ? "step_limit"
          : waitingForUser ? "waiting_for_user" : quarantinedProtocol || textToolEnvelope(answer, toolNames) ? "unresolved_tool_text" : "finished",
        semanticSuccess: null,
        receipts: structuredClone(receipts),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await options.tools.close?.(); }
      finally { await options.provider.dispose?.(); }
    },
  };
}
