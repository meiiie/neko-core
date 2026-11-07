import { Agent } from "../core/agent.ts";
import type { EventHook } from "../core/agent-constants.ts";
import type { McpTools, Provider } from "../core/ports.ts";
import { ToolRegistry, type ApprovalGate } from "../core/tool-runtime.ts";
import { isJsonObject, isText, type JsonValue } from "../shared/wire.ts";
import { messageOf } from "../shared/debug.ts";
import { DomainWorkingMemory } from "./domain-memory.ts";

export type DomainEffect = "read" | "write" | "ask";
export type ReceiptOutcome = "succeeded" | "failed" | "unknown";

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
  onEvent?: EventHook;
  onCheckpoint?: () => void | Promise<void>;
}

/** Detect explicit tool envelopes, not ordinary questions or JSON arguments in prose.
 * This function never turns text into an executable call. */
export function textToolEnvelope(text: string, names: ReadonlySet<string>): boolean {
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
  const toolNames = new Set(names.flatMap((name) => [name, name.replace(/^mcp__.+?__/, "")]));
  const tools: McpTools = {
    toolSchemas: () => structuredClone(schemas),
    has: (name) => names.includes(name),
    permission: (name) => effects[name] === "read" && options.tools.permission?.(name) === "safe" ? "safe" : "gated",
    async call(name, args, signal) {
      if (!names.includes(name)) throw new Error("Tool outside domain capability ceiling");
      if (waitingForUser) return "Error: clarification already executed; wait for the next user turn.";
      if (uncertainMutation) throw new DomainUncertainMutation();
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
      const response = await options.provider.complete(memory ? memory.context(messages, receipts) : messages, schema, delta, signal, opts);
      if (memory?.observe(response.content)) options.onEvent?.("domain_working_note", memory.snapshot());
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
      memory?.start(instruction);
      let answer = await agent.runResilient(instruction, { signal, maxRecoveries: 0 });
      let repairs = 0;
      if (!signal?.aborted && options.repairTextTools !== false && requests < maxRequests && textToolEnvelope(answer, toolNames)) {
        repairs++;
        options.onEvent?.("domain_protocol_repair", { reason: "text_tool_envelope", attempt: repairs });
        answer = await agent.runResilient(
          "PROTOCOL REPAIR: The last answer contained tool-call JSON as text; that text did not execute any tool. " +
          "If an action or clarification is still required, issue the actual native tool call using the advertised name/schema. " +
          "Do not replay successful calls already present in tool results, invent results, or perform a lookup merely to verify completion. " +
          "If no action remains, answer briefly in ordinary text.",
          { signal, internal: true, maxRecoveries: 0 },
        );
      }
      return {
        answer: memory ? memory.visibleAnswer(answer) : answer, requests, repairs,
        workingMemory: memory?.snapshot(),
        protocolStatus: signal?.aborted ? "interrupted" : stepLimitReached ? "step_limit"
          : waitingForUser ? "waiting_for_user" : textToolEnvelope(answer, toolNames) ? "unresolved_tool_text" : "finished",
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
