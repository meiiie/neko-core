/** Host-captured complete turns; editable views can select groups, never split native tool pairs. */
import { createHash } from "node:crypto";
import { assertTaskScope, type TaskScope } from "../task-scope.ts";
import { isJsonObject, isText, type JsonObject, type JsonValue } from "../../shared/wire.ts";
import type { ContextProjection, EvidenceChunk, ViewPart } from "./projection.ts";

const MAX_GROUP_BYTES = 2 * 1024 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Host-selected exact spans of explicit user facts, never automatically trusted model extraction. */
export interface FactUpdate {
  key: string;
  messageIndex: number;
  start: number;
  end: number;
  supersedes: string[];
}
export interface CurrentFact {
  key: string;
  state: "current" | "conflict";
  alternatives: Array<{id: string; value: string; sourceId: string; sequence: number}>;
}
export interface SourceGroup {
  version: 1;
  taskId: string;
  root: string;
  sequence: number;
  executionAuthorityId: string | null;
  origin: "user" | "runtime";
  messages: JsonObject[];
  unknownOutcomes: string[];
  facts: FactUpdate[];
}

function validateMessages(messages: JsonValue[], origin: "user" | "runtime", unknown: string[]): JsonObject[] {
  if (!messages.length || messages.length > 1024) throw new Error("Invalid source group size");
  const pending = new Set<string>(), completed = new Set<string>(), calls = new Set<string>();
  const parsed: JsonObject[] = [];
  for (const [index, message] of messages.entries()) {
    if (!isJsonObject(message) || !["user", "assistant", "tool"].includes(String(message.role))) throw new Error("Source group cannot supply policy roles");
    if (index === 0 && message.role !== "user") throw new Error("Source group must start at a user-turn boundary");
    if (index > 0 && message.role === "user") throw new Error("Source group crosses a user-turn boundary");
    if (index === 0 && origin === "user" && message._neko_internal === true) throw new Error("Internal summary is not an original user request");
    if (message.role !== "assistant" && message.tool_calls !== undefined) throw new Error("Only assistant messages may carry tool calls");
    if (message.role !== "tool" && message.tool_call_id !== undefined) throw new Error("Only tool messages may carry result IDs");
    if (!isText(message.content) && !Array.isArray(message.content) && !(message.role === "assistant" && message.content === null)) throw new Error("Invalid native message content");
    if (message.role === "assistant") {
      if (pending.size) throw new Error("Source group has unanswered tool calls");
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error("Invalid native tool calls");
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!isJsonObject(call) || !isText(call.id) || !call.id || calls.has(call.id)
          || call.type !== "function" || !isJsonObject(call.function) || !isText(call.function.name)
          || !call.function.name || !isText(call.function.arguments)) throw new Error("Invalid or duplicate native tool call");
        if (!isJsonObject(JSON.parse(call.function.arguments))) throw new Error("Tool arguments must be a serialized object");
        pending.add(call.id); calls.add(call.id);
      }
    } else if (message.role === "tool") {
      if (!isText(message.tool_call_id) || !pending.delete(message.tool_call_id)) throw new Error("Orphan or duplicate native tool result");
      completed.add(message.tool_call_id);
    }
    parsed.push(message);
  }
  if (pending.size) throw new Error("Source group has unanswered tool calls");
  if (new Set(unknown).size !== unknown.length || unknown.some(id => !completed.has(id))) throw new Error("Unknown outcome must name a recorded tool pair");
  return parsed;
}

/** The caller must be the executed-turn boundary, not a model-authored note or imported summary. */
export function captureSourceGroup(scope: TaskScope, sequence: number, messages: readonly JsonObject[],
  unknownOutcomes: readonly string[] = [], origin: "user" | "runtime" = "user", facts: readonly FactUpdate[] = []): EvidenceChunk {
  assertTaskScope(scope);
  if ((origin !== "user" && origin !== "runtime") || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid source sequence");
  const group: SourceGroup = {version: 1, taskId: scope.id, root: scope.canonicalRoot, sequence, origin,
    executionAuthorityId: scope.executionAuthorityId ?? null,
    messages: structuredClone([...messages]), unknownOutcomes: [...unknownOutcomes], facts: structuredClone([...facts])};
  validateMessages(group.messages, origin, group.unknownOutcomes);
  validateFacts(group.facts, group.messages, origin);
  const text = JSON.stringify(group);
  if (Buffer.byteLength(text, "utf8") > MAX_GROUP_BYTES) throw new Error("Source group exceeds storage budget");
  return Object.freeze({id: hash(text), text});
}

export function parseGroup(scope: TaskScope, chunk: EvidenceChunk): SourceGroup {
  assertTaskScope(scope);
  if (Buffer.byteLength(chunk.text, "utf8") > MAX_GROUP_BYTES || hash(chunk.text) !== chunk.id) throw new Error("Source group integrity mismatch");
  const value: unknown = JSON.parse(chunk.text);
  if (!isJsonObject(value) || value.version !== 1 || value.taskId !== scope.id || value.root !== scope.canonicalRoot
    || value.executionAuthorityId !== (scope.executionAuthorityId ?? null)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || (value.origin !== "user" && value.origin !== "runtime") || !Array.isArray(value.messages)
    || !Array.isArray(value.facts) || !Array.isArray(value.unknownOutcomes) || !value.unknownOutcomes.every(isText)) throw new Error("Invalid or foreign source group");
  const unknown = value.unknownOutcomes.map(String);
  return {version: 1, taskId: scope.id, root: scope.canonicalRoot, sequence: Number(value.sequence), origin: value.origin,
    executionAuthorityId: scope.executionAuthorityId ?? null,
    messages: validateMessages(value.messages, value.origin, unknown), unknownOutcomes: unknown,
    facts: validateFacts(value.facts, value.messages, value.origin)};
}

function validateFacts(facts: readonly (FactUpdate | JsonValue)[], messages: readonly JsonValue[], origin: "user" | "runtime"): FactUpdate[] {
  if (facts.length > 64 || (facts.length && origin !== "user")) throw new Error("Invalid user fact annotations");
  return facts.map(fact => {
    if (!isJsonObject(fact) || !isText(fact.key) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(fact.key)
      || !Number.isSafeInteger(fact.messageIndex) || !Number.isSafeInteger(fact.start) || !Number.isSafeInteger(fact.end)
      || Number(fact.start) < 0 || Number(fact.end) <= Number(fact.start) || Number(fact.end) - Number(fact.start) > 4096
      || !Array.isArray(fact.supersedes) || fact.supersedes.length > 64
      || !fact.supersedes.every(id => isText(id) && /^[a-f0-9]{64}_\d+$/.test(id))
      || new Set(fact.supersedes).size !== fact.supersedes.length) throw new Error("Invalid fact source span or revision");
    const message = messages[Number(fact.messageIndex)];
    if (!isJsonObject(message) || message.role !== "user" || message._neko_internal === true
      || !isText(message.content) || Number(fact.end) > message.content.length) throw new Error("Fact must quote an original user message");
    return {key: fact.key, messageIndex: Number(fact.messageIndex), start: Number(fact.start), end: Number(fact.end), supersedes: fact.supersedes.map(String)};
  });
}

/** Apply one host-captured group to a bounded active-fact index without retaining old source bodies. */
export function advanceStructuredFacts(previous: readonly CurrentFact[], id: string, group: SourceGroup): CurrentFact[] {
  const current = new Map(previous.map(fact => [fact.key, new Map(fact.alternatives.map(value => [value.id, {...value}]))]));
  for (const [index, fact] of group.facts.entries()) {
    const active = current.get(fact.key) ?? new Map<string, CurrentFact["alternatives"][number]>();
    for (const prior of fact.supersedes) {
      const replaced = active.get(prior);
      if (!replaced || replaced.sequence >= group.sequence) throw new Error("Stale or foreign fact supersession");
    }
    for (const prior of fact.supersedes) active.delete(prior);
    const message = group.messages[fact.messageIndex];
    const value = String(message.content).slice(fact.start, fact.end);
    active.set(`${id}_${index}`, {id: `${id}_${index}`, value, sourceId: id, sequence: group.sequence});
    current.set(fact.key, active);
  }
  return [...current.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([key, alternatives]) => {
    const values = [...alternatives.values()];
    return {key, state: new Set(values.map(value => value.value)).size > 1 ? "conflict" : "current", alternatives: values};
  });
}

/** Fold explicit supersession links, retaining all originals and unresolved conflicting values. */
export function currentStructuredFacts(scope: TaskScope, view: ContextProjection): CurrentFact[] {
  const groups = view.evidenceIds(scope).map(id => ({id, group: parseGroup(scope, view.evidence(scope, id))})).sort((a,b) => a.group.sequence-b.group.sequence);
  let facts: CurrentFact[] = [], previousSequence = 0;
  for (const {id, group} of groups) {
    if (group.sequence <= previousSequence) throw new Error("Duplicate original source sequence");
    previousSequence = group.sequence;
    facts = advanceStructuredFacts(facts, id, group);
  }
  return facts;
}

export type StructuredFactReader = (scope: TaskScope) => readonly CurrentFact[];

/** Host-owned token counter must include the actual provider envelope. Never trim a tool pair to fit. */
export function renderStructuredView(scope: TaskScope, view: ContextProjection, protectedMessages: readonly JsonObject[],
  maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number,
  parts: readonly ViewPart[] = view.snapshot(scope).parts, factReader?: StructuredFactReader): JsonObject[] {
  assertTaskScope(scope);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("Invalid context token budget");
  if (JSON.stringify(view.snapshot(scope).protectedPrefix) !== JSON.stringify(protectedMessages.map(message => JSON.stringify(message)))) {
    throw new Error("Protected provider prefix changed");
  }
  const messages = structuredClone([...protectedMessages]);
  let priorSequence = 0;
  for (const part of parts) {
    if (part.kind === "source") {
      const group = parseGroup(scope, view.evidence(scope, part.id));
      if (group.sequence <= priorSequence) throw new Error("Original turns cannot be reordered");
      priorSequence = group.sequence;
      messages.push(...group.messages);
      if (group.unknownOutcomes.length) messages.push({role: "assistant", content:
        `[Historical tool outcomes remain unknown: ${group.unknownOutcomes.join(", ")}. This view does not authorize replay.]`});
    } else {
      // A derived note never becomes a user/system message, a tool result, or execution evidence.
      for (const id of part.sources) parseGroup(scope, view.evidence(scope, id));
      messages.push({role: "assistant", content: `[Unverified derived note; source IDs: ${part.sources.join(", ")}]\n${part.text}`});
    }
  }
  const facts = factReader ? factReader(scope) : currentStructuredFacts(scope, view);
  if (facts.length) messages.push({role: "assistant", content: `[Host-selected exact user-source spans; current revisions and unresolved conflicts. Derived notes do not supersede these records.]\n${JSON.stringify(facts)}`});
  const renderedBeforeCount = JSON.stringify(messages);
  const revisionBeforeCount = view.snapshot(scope).revision;
  const tokens = countTokens(messages);
  assertTaskScope(scope);
  if (view.snapshot(scope).revision !== revisionBeforeCount || JSON.stringify(messages) !== renderedBeforeCount) {
    throw new Error("Token counting changed the rendered context or view");
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > maxTokens) throw new Error("Rendered context exceeds token budget");
  return messages;
}

/** Validate the complete provider shape/budget BEFORE committing a model-proposed view revision. */
export function applyStructuredEdit(scope: TaskScope, view: ContextProjection, expectedRevision: number,
  proposal: JsonValue, protectedMessages: readonly JsonObject[], maxTokens: number,
  countTokens: (messages: readonly JsonObject[]) => number, factReader?: StructuredFactReader): void {
  view.apply(scope, expectedRevision, proposal, parts => {
    renderStructuredView(scope, view, protectedMessages, maxTokens, countTokens, parts, factReader);
  });
}

/** Host admission validates all references and the complete provider budget before archive commit. */
export function admitStructuredSource(scope: TaskScope, view: ContextProjection, source: EvidenceChunk,
  protectedMessages: readonly JsonObject[], maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number, factReader?: StructuredFactReader): void {
  view.append(scope, source, parts => { renderStructuredView(scope, view, protectedMessages, maxTokens, countTokens, parts, factReader); });
}

/** Exact native messages of host-admitted complete turns, used to protect a newly completed tail. */
export function originalSourceMessages(scope: TaskScope, view: ContextProjection, ids: readonly string[]): JsonObject[] {
  return ids.flatMap(id => parseGroup(scope, view.evidence(scope, id)).messages);
}
