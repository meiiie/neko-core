/** Bounded, task-scoped historical read_file tool results kept outside the provider prompt. */
/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- This module validates persisted JSON and untrusted model tool-call shapes before constructing task-scoped records. */
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { LEAN_TAIL_CHARS } from "./agent-constants.ts";
import { assertTaskScope, type TaskScope } from "./task-scope.ts";

export const MAX_COMPACTION_SOURCE_EVENTS = 256;
export const MAX_SOURCE_LOOKUP_CHARS = 8_000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;

/** Captured only from a successfully opened local text file descriptor, never tool arguments. */
export interface TrustedReadFileSource {
  verifiedPath: string;
  resourceRevision: string;
}

export interface CompactionSourceEvent {
  /** A tool result can be a denial or error; this is not proof of a successful file read. */
  kind: "read_file_tool_result";
  seq: number;
  id: string;
  taskId: string;
  canonicalRoot: string;
  callId: string;
  /** Model-requested spelling; never used as a verified resource path. */
  requestedPath: string | null;
  /** Descriptor-matched historical local text path, when available; never current truth. */
  verifiedPath: string | null;
  /** Hash of bytes read from that descriptor, not a coherent/current filesystem revision. */
  resourceRevision: string | null;
  /** Exact tool message admitted to Agent history, before later observation masking. */
  result: Record<string, unknown>;
  messageDigest: string;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function eventId(event: Omit<CompactionSourceEvent, "id">): string {
  const parts = [event.taskId, event.canonicalRoot, event.seq, event.callId,
    event.requestedPath, event.messageDigest];
  // Keep v1 archive IDs stable. New trusted metadata is part of the newer identity.
  if (event.verifiedPath !== null || event.resourceRevision !== null) {
    parts.push(event.verifiedPath, event.resourceRevision);
  }
  return digest(JSON.stringify(parts));
}

export function requestedReadPath(call: unknown): string | null {
  if (!call || typeof call !== "object" || Array.isArray(call)) return null;
  // SAFETY: call was narrowed to a non-array object; its expected fields are parsed below.
  const value = call as Record<string, unknown>;
  const fn = value.function;
  // SAFETY: the conditional admits only a non-array function object.
  const method = fn && typeof fn === "object" && !Array.isArray(fn)
    ? fn as Record<string, unknown> : value;
  if (method.name !== "read_file") return null;
  let args = method.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  // SAFETY: args was parsed and narrowed to a non-array object above.
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" && path.length > 0 && path.length <= 512 ? path : null;
}

export function isReadFileCall(call: unknown): boolean {
  if (!call || typeof call !== "object" || Array.isArray(call)) return false;
  // SAFETY: call was narrowed to a non-array object; only the method name is inspected.
  const value = call as Record<string, unknown>;
  const fn = value.function;
  // SAFETY: the conditional admits only a non-array function object.
  const method = fn && typeof fn === "object" && !Array.isArray(fn)
    ? fn as Record<string, unknown> : value;
  return method.name === "read_file";
}

/** The admitted raw result may be clipped later, but its marker must still match this exact call. */
export function sourceProjectionDigest(result: Record<string, unknown>): string {
  const clean = { ...result };
  delete clean._neko_source_event_id;
  delete clean._neko_source_projection_digest;
  delete clean._neko_source_clipped;
  return digest(JSON.stringify(clean));
}

export function sourceProjectionMatches(event: CompactionSourceEvent, result: Record<string, unknown>): boolean {
  if (result.role !== "tool" || result.tool_call_id !== event.callId
    || result._neko_source_event_id !== event.id) return false;
  const projection = sourceProjectionDigest(result);
  if (result._neko_source_projection_digest !== projection) return false;
  if (result._neko_source_clipped === undefined) return projection === event.messageDigest;
  if (result._neko_source_clipped !== true || typeof result.content !== "string"
    || typeof event.result.content !== "string") return false;
  // A clipping marker alone is forgeable. Check the exact allowed projections of the
  // admitted result, including shrink then tail-clipping across two compactions.
  const clean = { ...result };
  delete clean._neko_source_event_id;
  delete clean._neko_source_projection_digest;
  delete clean._neko_source_clipped;
  const original = event.result.content;
  const seen = new Set([original]);
  let frontier = [original];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const content of frontier) {
      const shrink = shrinkProjection(content);
      const lean = leanProjection(content);
      for (const candidate of [shrink, lean]) {
        if (candidate === undefined || seen.has(candidate)) continue;
        seen.add(candidate);
        next.push(candidate);
      }
    }
    frontier = next;
  }
  if (!seen.has(result.content) || result.content === original) return false;
  return JSON.stringify({ ...clean, content: original }) === JSON.stringify(event.result);
}

function shrinkProjection(content: string): string | undefined {
  const clip = 1200;
  const marker = "chars elided to fit context";
  if (content.length <= clip + 80 || content.includes(marker)) return undefined;
  return content.slice(0, clip) + `\n... [${content.length - clip} ${marker}] ...`;
}

function leanProjection(content: string): string | undefined {
  const lines = content.split("\n");
  if (lines.length > 40) return lines.slice(0, 40).join("\n")
    + `\n... (${lines.length - 40} more lines clipped on compaction)`;
  if (content.length > LEAN_TAIL_CHARS) return content.slice(0, LEAN_TAIL_CHARS)
    + `\n... (${content.length - LEAN_TAIL_CHARS} more chars clipped on compaction)`;
  return undefined;
}

/** Prevent a configured API key from bypassing the entrypoint's existing transcript redaction. */
export function assertNoConfiguredCredentialInSourceEvents(
  events: CompactionSourceEvent[], apiKey: string | undefined,
): void {
  if (!apiKey || apiKey.length < 8) return;
  const pending: unknown[] = [events];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes(apiKey)) throw new Error("Read-file source archive contains a configured credential; checkpoint blocked");
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        pending.push(key);
        pending.push(item);
      }
    }
  }
}

export function createCompactionSourceEvent(
  scope: TaskScope, seq: number, callId: string, requestedPath: string | null, result: unknown,
  source?: TrustedReadFileSource,
): CompactionSourceEvent {
  assertTaskScope(scope);
  if (!Number.isSafeInteger(seq) || seq < 1 || typeof callId !== "string" || !callId || callId.length > 128) {
    throw new Error("Invalid read_file source identity");
  }
  if (requestedPath !== null && (typeof requestedPath !== "string" || !requestedPath || requestedPath.length > 512)) {
    throw new Error("Invalid requested read_file path");
  }
  if (source && (!isAbsolute(source.verifiedPath) || source.verifiedPath.length > 2048
    || !REVISION.test(source.resourceRevision))) throw new Error("Invalid trusted read_file source");
  const raw = JSON.stringify(result);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("Read-file source exceeds bounded archive; raw history retained");
  }
  const copy: unknown = JSON.parse(raw);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) throw new Error("Invalid read_file result");
  // SAFETY: the serialized result was narrowed to a non-array object; fields are checked below.
  const message = copy as Record<string, unknown>;
  if (message.role !== "tool" || message.tool_call_id !== callId
    || !(typeof message.content === "string" || message.content === null || Array.isArray(message.content))) {
    throw new Error("Invalid read_file result boundary");
  }
  delete message._neko_source_event_id;
  const event: Omit<CompactionSourceEvent, "id"> = {
    kind: "read_file_tool_result", seq, taskId: scope.id, canonicalRoot: scope.canonicalRoot,
    callId, requestedPath, verifiedPath: source?.verifiedPath ?? null,
    resourceRevision: source?.resourceRevision ?? null,
    result: message, messageDigest: digest(JSON.stringify(message)),
  };
  return { ...event, id: eventId(event) };
}

/** Validate persisted evidence before any direct-ID lookup or compaction admission. */
export function validateCompactionSourceEvents(
  value: unknown, taskId: string, canonicalRoot: string,
): CompactionSourceEvent[] {
  if (!Array.isArray(value) || value.length > MAX_COMPACTION_SOURCE_EVENTS) throw new Error("Invalid read-file source archive");
  const raw = JSON.stringify(value);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_ARCHIVE_BYTES) {
    throw new Error("Read-file source archive exceeds size limit");
  }
  const copy: unknown = JSON.parse(raw);
  if (!Array.isArray(copy)) throw new Error("Invalid read-file source archive");
  for (let i = 0; i < copy.length; i++) {
    const value = copy[i];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid read-file source event");
    // SAFETY: the parsed event was narrowed to a non-array object; every persisted field is validated below.
    const event = value as CompactionSourceEvent;
    if (event.kind !== "read_file_tool_result" || event.seq !== i + 1
      || event.taskId !== taskId || event.canonicalRoot !== canonicalRoot
      || typeof event.callId !== "string" || !event.callId || event.callId.length > 128
      || !(event.requestedPath === null || typeof event.requestedPath === "string" && event.requestedPath.length > 0 && event.requestedPath.length <= 512)
      || !(event.verifiedPath === null || typeof event.verifiedPath === "string"
        && isAbsolute(event.verifiedPath) && event.verifiedPath.length <= 2048)
      || !(event.resourceRevision === null || typeof event.resourceRevision === "string"
        && REVISION.test(event.resourceRevision))
      || (event.verifiedPath === null) !== (event.resourceRevision === null)
      || !event.result || typeof event.result !== "object" || Array.isArray(event.result)
      || event.result.role !== "tool" || event.result.tool_call_id !== event.callId
      || !(typeof event.result.content === "string" || event.result.content === null || Array.isArray(event.result.content))
      || typeof event.messageDigest !== "string" || !DIGEST.test(event.messageDigest)
      || event.messageDigest !== digest(JSON.stringify(event.result))
      || typeof event.id !== "string" || !DIGEST.test(event.id)
      || event.id !== eventId(event)) throw new Error("Invalid read-file source event identity or digest");
  }
  // SAFETY: every parsed event passed scope, sequence, shape, digest, and size validation above.
  return copy as CompactionSourceEvent[];
}

export function appendCompactionSourceEvent(
  events: CompactionSourceEvent[], event: CompactionSourceEvent,
): CompactionSourceEvent[] {
  if (events.length >= MAX_COMPACTION_SOURCE_EVENTS) {
    throw new Error("Read-file source archive is full; raw history retained");
  }
  return validateCompactionSourceEvents([...events, event], event.taskId, event.canonicalRoot);
}

/** One bounded page of evidence already admitted into the active task's Agent history. */
export function renderCompactionSourceLookup(
  event: CompactionSourceEvent | undefined, id: unknown, offset: unknown,
): string {
  if (typeof id !== "string" || !DIGEST.test(id)) return "Error: invalid historical source ID.";
  if (offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0)) {
    return "Error: invalid historical source offset.";
  }
  if (!event || event.id !== id) return "Historical source ID not found in the active task.";
  const content = event.result.content;
  if (typeof content !== "string") return "Historical source result is non-text; no replay is available. Read the current file directly if needed.";
  const start = offset === undefined ? 0 : Number(offset);
  if (start >= content.length && start !== 0) return "Error: historical source offset is outside the result range.";
  const end = Math.min(content.length, start + MAX_SOURCE_LOOKUP_CHARS);
  const inside = event.verifiedPath === null ? null : relative(event.canonicalRoot, event.verifiedPath);
  const scopedPath = inside !== null && inside !== "" && inside !== ".." && inside.length <= 256
    && !inside.startsWith(".." + sep) && !isAbsolute(inside) ? inside : null;
  const path = scopedPath === null ? `requested path ${JSON.stringify(event.requestedPath)} (unverified for model; canonical host path withheld)`
    : `root-relative path ${JSON.stringify(scopedPath)} (matched opened descriptor at historical read)`;
  const revision = event.resourceRevision === null ? "source revision unverified"
    : `historical observed-byte digest ${event.resourceRevision} (not a current filesystem revision)`;
  return `[historical read_file tool result; ID ${event.id}; ${path}; ${revision}; `
    + `result digest ${event.messageDigest}; chars ${start}-${end} of ${content.length}. `
    + "This record may contain a denial or error. It does not prove current file contents; "
    + "use a new read_file for a current claim.]\n"
    + content.slice(start, end)
    + (end < content.length ? `\n[More historical result: source_lookup with this ID and offset ${end}.]` : "");
}
