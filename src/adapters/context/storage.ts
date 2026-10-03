/** Experimental host-only checkpoint store. No model-supplied paths, scope, or lock takeover. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertTaskScope, type TaskScope } from "../../core/task-scope.ts";
import { isJsonObject, isText, type JsonObject } from "../../shared/wire.ts";
import { ContextProjection, type ProjectionCheckpoint } from "../../core/context/projection.ts";

import { PagedSources, validSourceJournalRef, type SourceJournalRef } from "./paged-sources.ts";
import { renderStructuredView } from "../../core/context/structured-sources.ts";

const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
interface Envelope {
  version: 1;
  revision: number;
  workingCheckpointDigest: string;
  payloadDigest: string;
  payload: JsonObject | ProjectionCheckpoint;
  workingMessages?: JsonObject[];
  sourceJournal?: SourceJournalRef;
}

function directory(home: string, create: boolean): string {
  if (!isAbsolute(home)) throw new Error("Context store home must be absolute");
  const root = resolve(home);
  const paths = [root, join(root, ".neko-core"), join(root, ".neko-core", "context-projection-experiment")];
  for (const path of paths) {
    if (create && !existsSync(path)) mkdirSync(path, {mode: 0o700});
    if (!lstatSync(path).isDirectory()) throw new Error("Unsafe context store directory");
  }
  return paths[2];
}

function stem(scope: TaskScope): string {
  assertTaskScope(scope);
  return digest(JSON.stringify([scope.id, scope.canonicalRoot, scope.executionAuthorityId ?? null]));
}

function readEnvelope(path: string): Envelope {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CHECKPOINT_BYTES) throw new Error("Unsafe context checkpoint file");
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  let value: unknown;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Context checkpoint changed during read");
    }
    value = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (!isJsonObject(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !isText(value.workingCheckpointDigest) || !DIGEST.test(value.workingCheckpointDigest)
    || !isText(value.payloadDigest) || !DIGEST.test(value.payloadDigest) || !isJsonObject(value.payload)
    || digest(JSON.stringify(value.payload)) !== value.payloadDigest) throw new Error("Invalid context checkpoint integrity");
  const envelope: Envelope = {version: 1, revision: Number(value.revision), workingCheckpointDigest: value.workingCheckpointDigest,
    payloadDigest: value.payloadDigest, payload: value.payload};
  if (value.workingMessages !== undefined || value.sourceJournal !== undefined) {
    if (!Array.isArray(value.workingMessages) || !value.workingMessages.every(isJsonObject) || !validSourceJournalRef(value.sourceJournal)
      || digest(JSON.stringify({messages: value.workingMessages, sourceJournal: value.sourceJournal})) !== value.workingCheckpointDigest) throw new Error("Invalid bundled context binding");
    envelope.workingMessages = value.workingMessages;
    envelope.sourceJournal = value.sourceJournal;
  }
  return envelope;
}

/** Publication already happened; a durability/cleanup failure must not be treated as no effect. */
export class ContextCheckpointPublishedError extends Error {
  readonly kind = "checkpoint_published_followup_failed";
  constructor(readonly revision: number, cause: unknown) {
    super("Context checkpoint was published but durability or lease cleanup failed; inspect the saved revision before retrying", {cause});
  }
}

/** Store CAS and view CAS are distinct: neither a stale writer nor a stale model edit may commit. */
export function saveProjection(home: string, scope: TaskScope, view: ContextProjection,
  workingCheckpointDigest: string, expectedRevision: number | null, binding?: {messages: readonly JsonObject[]; sourceJournal: SourceJournalRef}): number {
  assertTaskScope(scope);
  if (!DIGEST.test(workingCheckpointDigest) || (expectedRevision !== null
    && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))) throw new Error("Invalid context checkpoint binding");
  if (binding && digest(JSON.stringify({messages: binding.messages, sourceJournal: binding.sourceJournal})) !== workingCheckpointDigest) throw new Error("Bundled context digest mismatch");
  const payload = view.checkpoint(scope);
  const dir = directory(home, true), name = stem(scope);
  const path = join(dir, `${name}.json`), lock = join(dir, `${name}.lock`);
  const fd = openSync(lock, "wx", 0o600); // An existing or stale lock is never removed here.
  const lease = fstatSync(fd);
  let temp: string | undefined;
  let publishedRevision: number | undefined;
  let failure: {error: unknown} | undefined;
  try {
    const previous = existsSync(path) ? readEnvelope(path) : null;
    if (previous?.workingMessages && !binding) throw new Error("A bundled context cannot be downgraded to a detached projection");
    const current = previous?.revision ?? null;
    if (current !== expectedRevision) throw new Error("Context checkpoint revision conflict");
    const revision = (current ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("Context checkpoint revision exhausted");
    const envelope: Envelope = {version: 1, revision, workingCheckpointDigest, payloadDigest: digest(JSON.stringify(payload)), payload};
    if (binding) {
      envelope.workingMessages = structuredClone([...binding.messages]);
      envelope.sourceJournal = {...binding.sourceJournal};
    }
    const raw = JSON.stringify(envelope);
    if (Buffer.byteLength(raw, "utf8") > MAX_CHECKPOINT_BYTES) throw new Error("Context checkpoint exceeds storage budget");
    temp = join(dir, `${name}.tmp-${randomUUID()}`);
    const output = openSync(temp, "wx", 0o600);
    try { writeFileSync(output, raw, "utf8"); fsyncSync(output); }
    finally { closeSync(output); }
    renameSync(temp, path);
    publishedRevision = revision;
    temp = undefined;
    if (process.platform !== "win32") {
      const parent = openSync(dir, constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  } catch (error) {
    failure = {error};
  } finally {
    if (temp) { try { unlinkSync(temp); } catch { /* retain the original checkpoint on failed cleanup */ } }
    try {
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.isFile() && current.dev === lease.dev && current.ino === lease.ino) unlinkSync(lock);
    } catch (error) {
      failure = {error: failure ? new AggregateError([failure.error, error], "Checkpoint operation and lease cleanup failed") : error};
    }
  }
  if (failure) {
    if (publishedRevision !== undefined) throw new ContextCheckpointPublishedError(publishedRevision, failure.error);
    throw failure.error;
  }
  if (publishedRevision === undefined) throw new Error("Context checkpoint was not published");
  return publishedRevision;
}

/** Read-only recovery requires exact host task/root/prefix and working-checkpoint identity. */
export function loadProjection(home: string, scope: TaskScope, protectedPrefix: readonly string[],
  maxViewBytes: number, assertQuiescent: () => void, workingCheckpointDigest: string) {
  assertTaskScope(scope);
  if (!DIGEST.test(workingCheckpointDigest)) throw new Error("Invalid context checkpoint binding");
  const value = readEnvelope(join(directory(home, false), `${stem(scope)}.json`));
  if (value.workingCheckpointDigest !== workingCheckpointDigest) throw new Error("Context view does not match the working checkpoint");
  const view = ContextProjection.restore(scope, protectedPrefix, maxViewBytes, assertQuiescent, value.payload);
  return {view, revision: value.revision, payloadDigest: value.payloadDigest};
}

/** Publish provider context, view revision, and immutable source head in ONE atomic parent record. */
export function saveContextBundle(home: string, scope: TaskScope, view: ContextProjection, workingMessages: readonly JsonObject[],
  sourceJournal: SourceJournalRef, expectedRevision: number | null, protectedMessages: readonly JsonObject[],
  maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number): number {
  const journal = new PagedSources(home, scope, sourceJournal);
  journal.assertContains(view.evidenceIds(scope));
  return finishContextBundle(home, scope, view, workingMessages, sourceJournal, expectedRevision, protectedMessages, maxTokens, countTokens, journal);
}

/** Async ancestry preflight, then one synchronous quiescent/CAS-protected publication step.
 * This does not make bounded checkpoint serialization or fsync non-blocking. */
export async function saveContextBundleAsync(home: string, scope: TaskScope, view: ContextProjection, workingMessages: readonly JsonObject[],
  sourceJournal: SourceJournalRef, expectedRevision: number | null, protectedMessages: readonly JsonObject[],
  maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number, signal?: AbortSignal): Promise<number> {
  assertTaskScope(scope);
  signal?.throwIfAborted();
  const journal = new PagedSources(home, scope, sourceJournal);
  const snapshot = () => digest(JSON.stringify({revision: view.snapshot(scope).revision, workingMessages, sourceJournal, protectedMessages}));
  const before = snapshot();
  await journal.assertContainsAsync(view.evidenceIds(scope), signal);
  signal?.throwIfAborted();
  if (snapshot() !== before) throw new Error("Context changed during asynchronous checkpoint preparation");
  return finishContextBundle(home, scope, view, workingMessages, sourceJournal, expectedRevision, protectedMessages, maxTokens, countTokens, journal, signal);
}

function finishContextBundle(home: string, scope: TaskScope, view: ContextProjection, workingMessages: readonly JsonObject[],
  sourceJournal: SourceJournalRef, expectedRevision: number | null, protectedMessages: readonly JsonObject[],
  maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number, journal: PagedSources, signal?: AbortSignal): number {
  const snapshot = () => digest(JSON.stringify({revision: view.snapshot(scope).revision, workingMessages, sourceJournal, protectedMessages}));
  const before = snapshot();
  for (const id of view.evidenceIds(scope)) {
    if (journal.read(id).text !== view.evidence(scope, id).text) throw new Error("Working source does not match durable journal");
  }
  const rendered = renderStructuredView(scope, view, protectedMessages, maxTokens, countTokens, undefined, runtime => journal.facts(runtime));
  if (snapshot() !== before) throw new Error("Context changed during checkpoint validation");
  if (JSON.stringify(rendered) !== JSON.stringify(workingMessages)) throw new Error("Working context does not match its validated projection");
  signal?.throwIfAborted();
  const binding = {messages: workingMessages, sourceJournal};
  return saveProjection(home, scope, view, digest(JSON.stringify(binding)), expectedRevision, binding);
}

/** Restore the exact provider context and source head together, then revalidate host prefix and budgets. */
export function loadContextBundle(home: string, scope: TaskScope, protectedMessages: readonly JsonObject[],
  maxViewBytes: number, assertQuiescent: () => void, maxTokens: number, countTokens: (messages: readonly JsonObject[]) => number) {
  assertTaskScope(scope);
  const envelope = readEnvelope(join(directory(home, false), `${stem(scope)}.json`));
  if (!envelope.workingMessages || !envelope.sourceJournal) throw new Error("Checkpoint has no bundled working context");
  const view = ContextProjection.restore(scope, protectedMessages.map(message => JSON.stringify(message)), maxViewBytes, assertQuiescent, envelope.payload);
  const journal = new PagedSources(home, scope, envelope.sourceJournal);
  journal.assertContains(view.evidenceIds(scope));
  for (const id of view.evidenceIds(scope)) if (journal.read(id).text !== view.evidence(scope, id).text) throw new Error("Working source does not match durable journal");
  const rendered = renderStructuredView(scope, view, protectedMessages, maxTokens, countTokens, undefined, runtime => journal.facts(runtime));
  if (JSON.stringify(rendered) !== JSON.stringify(envelope.workingMessages)) throw new Error("Bundled working context does not match its projection");
  return {view, journal, messages: rendered, revision: envelope.revision, workingCheckpointDigest: envelope.workingCheckpointDigest};
}
