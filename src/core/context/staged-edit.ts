/** Optional host bridge: accept proposals during a turn, commit only at a quiescent CAS boundary. */
import { createHash, randomUUID } from "node:crypto";
import { assertTaskScope, type TaskScope } from "../task-scope.ts";
import { isJsonObject, isText, type JsonObject, type JsonValue } from "../../shared/wire.ts";
import type { ContextProjection, ViewPart } from "./projection.ts";
import { renderStructuredView, originalSourceMessages, type StructuredFactReader } from "./structured-sources.ts";

export interface StagedContextEdit { readonly id: string }
interface Stage {
  scope: TaskScope;
  view: ContextProjection;
  revision: number;
  parts: readonly ViewPart[];
  evidence: readonly string[];
  proposal: JsonValue[];
  prefixCount: number;
  prefixDigest: string;
}
const stages = new WeakMap<StagedContextEdit, Stage>();
const latest = new WeakMap<ContextProjection, StagedContextEdit>();
export const workingContextDigest = (messages: readonly JsonObject[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");

export function cancelStagedContextEdit(view: ContextProjection): void {
  const previous = latest.get(view);
  if (previous) stages.delete(previous);
  latest.delete(view);
}

/** No state mutation or execution authority is granted by a staged proposal. Newer staging replaces older staging. */
export function stageContextEdit(scope: TaskScope, view: ContextProjection, proposal: JsonValue,
  sealedWorkingPrefix: readonly JsonObject[]): StagedContextEdit {
  assertTaskScope(scope);
  if (!Array.isArray(proposal) || proposal.length > 512 || Buffer.byteLength(JSON.stringify(proposal)) > 256 * 1024) throw new Error("Invalid staged context proposal");
  const before = view.snapshot(scope), evidence = view.evidenceIds(scope), allowed = new Set(evidence);
  for (const part of proposal) {
    if (!isJsonObject(part)) throw new Error("Invalid staged context part");
    if (part.kind === "source" && isText(part.id) && allowed.has(part.id)) continue;
    if (part.kind === "note" && Array.isArray(part.sources) && part.sources.every(id => isText(id) && allowed.has(id))) continue;
    throw new Error("Staged proposal may cite only its original evidence snapshot");
  }
  const token = Object.freeze({id: randomUUID()});
  cancelStagedContextEdit(view);
  stages.set(token, {scope, view, revision: before.revision, parts: before.parts, evidence, proposal: structuredClone(proposal), prefixCount: sealedWorkingPrefix.length, prefixDigest: workingContextDigest(sealedWorkingPrefix)});
  latest.set(view, token);
  return token;
}

/** A completed append-only tail is preserved verbatim; any other intervening edit requires a fresh proposal. */
export function commitStagedContextEdit(scope: TaskScope, view: ContextProjection, token: StagedContextEdit,
  working: {messages: JsonObject[]}, expectedWorkingDigest: string, protectedMessages: readonly JsonObject[],
  maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number, factReader?: StructuredFactReader): string {
  assertTaskScope(scope);
  const stage = stages.get(token);
  if (!stage || stage.scope !== scope || stage.view !== view || latest.get(view) !== token) throw new Error("Unknown, consumed or foreign context proposal");
  if (workingContextDigest(working.messages) !== expectedWorkingDigest) throw new Error("Working checkpoint changed before context commit");
  const current = view.snapshot(scope), ids = view.evidenceIds(scope);
  if (JSON.stringify(ids.slice(0, stage.evidence.length)) !== JSON.stringify(stage.evidence)) throw new Error("Original evidence changed after staging");
  const tail = ids.slice(stage.evidence.length).map(id => ({kind: "source" as const, id}));
  if (current.revision !== stage.revision + tail.length
    || JSON.stringify(current.parts) !== JSON.stringify([...stage.parts, ...tail])) throw new Error("Context view changed after staging");
  if (workingContextDigest(working.messages.slice(0, stage.prefixCount)) !== stage.prefixDigest
    || JSON.stringify(working.messages.slice(stage.prefixCount)) !== JSON.stringify(originalSourceMessages(scope, view, ids.slice(stage.evidence.length)))) {
    throw new Error("Working context has an unarchived or changed tail");
  }
  const candidate = [...stage.proposal, ...tail];
  let rendered: JsonObject[] | undefined;
  view.apply(scope, current.revision, candidate, parts => {
    rendered = renderStructuredView(scope, view, protectedMessages, maxTokens, countTokens, parts, factReader);
    if (workingContextDigest(working.messages) !== expectedWorkingDigest) throw new Error("Working checkpoint changed during context validation");
  });
  // apply invokes the synchronous validator before its single state assignment. No await or external
  // provider/tool action separates this host-owned message assignment from the view CAS commit.
  if (!rendered) throw new Error("Context candidate was not validated");
  working.messages = rendered;
  stages.delete(token); latest.delete(view);
  return workingContextDigest(rendered);
}
