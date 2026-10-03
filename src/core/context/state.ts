/* eslint-disable anti-slop/no-unknown-parameters -- Decode and validate untrusted persisted context metadata at the storage boundary. */
/** Persisted context provenance. Hashes bind bytes and scope, never model-written authority. */
import {createHash} from "node:crypto";
import {isJsonObject, isText, type JsonObject} from "../../shared/wire.ts";

const HASH = /^[a-f0-9]{64}$/;
export interface StructuredJournalRef {version: 1; scope: string; head: string | null}
export interface StructuredContextState {
  version: 1;
  journal: StructuredJournalRef;
  capsule: {messageDigest: string; sources: string[]} | null;
}
export const structuredScopeDigest = (taskId: string, root: string, executionAuthorityId?: string) =>
  createHash("sha256").update(JSON.stringify([taskId, root, executionAuthorityId ?? null])).digest("hex");
export const structuredCapsuleDigest = (message: JsonObject) => {
  const content = {...message};
  delete content._neko_acp_message_id; // presentation identity cannot rewrite historical evidence
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
};

/** Decode a defensive copy and require its capsule to match the same parent working snapshot. */
export function decodeStructuredContextState(value: unknown, messages: readonly unknown[], taskId: string, root: string,
  executionAuthorityId?: string): StructuredContextState {
  const raw = JSON.stringify(value);
  if (!raw || Buffer.byteLength(raw) > 64 * 1024) throw new Error("Structured context metadata exceeds its budget");
  const data: unknown = JSON.parse(raw);
  if (!isJsonObject(data) || data.version !== 1 || !isJsonObject(data.journal) || data.journal.version !== 1
    || data.journal.scope !== structuredScopeDigest(taskId, root, executionAuthorityId)
    || !(data.journal.head === null || isText(data.journal.head) && HASH.test(data.journal.head))) {
    throw new Error("Invalid or foreign structured context journal");
  }
  const capsules = messages.filter(message => isJsonObject(message) && message._neko_context_capsule === true);
  if (data.capsule === null) {
    if (capsules.length) throw new Error("Structured capsule has no parent provenance");
    return {version: 1, journal: {version: 1, scope: String(data.journal.scope), head: data.journal.head}, capsule: null};
  }
  const capsule = data.capsule;
  if (data.journal.head === null || !isJsonObject(capsule) || !isText(capsule.messageDigest) || !HASH.test(capsule.messageDigest)
    || !Array.isArray(capsule.sources) || !capsule.sources.length || capsule.sources.length > 64
    || !capsule.sources.every(id => isText(id) && HASH.test(id)) || new Set(capsule.sources).size !== capsule.sources.length
    || capsules.length !== 1) throw new Error("Invalid structured capsule provenance");
  const message = capsules[0];
  if (!isJsonObject(message) || message.role !== "assistant" || message._neko_internal !== true || !isText(message.content)
    || JSON.stringify(message._neko_context_sources) !== JSON.stringify(capsule.sources)
    || structuredCapsuleDigest(message) !== capsule.messageDigest) throw new Error("Structured capsule does not match its parent checkpoint");
  return {version: 1, journal: {version: 1, scope: String(data.journal.scope), head: data.journal.head},
    capsule: {messageDigest: capsule.messageDigest, sources: capsule.sources.map(String)}};
}
