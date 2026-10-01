/** Opt-in task sessions. Legacy v2 sessions are never read or rewritten here. */
/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- This adapter parses untrusted persisted JSON and validates runtime boundary inputs. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { createTaskScope, revokeTaskScope, type TaskScope } from "../core/task-scope.ts";
import { sourceProjectionMatches, validateCompactionSourceEvents, type CompactionSourceEvent } from "../core/compaction-source.ts";
import type { NekoConfig } from "./config.ts";

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^[a-f0-9]{32}$/;

export interface TaskSessionRuntime {
  /** The Agent's current working history, never a merged UI timeline. */
  getMessages(): unknown[];
  /** Raw read_file observations, captured before later working-context compaction/masking. */
  getSourceEvents(): CompactionSourceEvent[];
  /** Reject a switch while a turn, approval, child or background job is still active. */
  assertQuiescent(): void | Promise<void>;
  /** Optional close-only recovery: settle a cancelled turn and mark unanswered tools unknown. */
  settleForClose?(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface TaskRuntimeInput {
  sessionId: string;
  taskId: string;
  label: string;
  root: string;
  scope: TaskScope;
  messages: unknown[];
  sourceEvents: CompactionSourceEvent[];
}

export interface ActiveTaskRuntime<R extends TaskSessionRuntime> {
  id: string;
  label: string;
  root: string;
  scope: TaskScope;
  runtime: R;
}

export type TaskRuntimeFactory<R extends TaskSessionRuntime> = (input: TaskRuntimeInput) => R | Promise<R>;

interface StoredTask {
  id: string;
  label: string;
  canonicalRoot: string;
  revision: number;
  messages: unknown[];
  sourceEvents: CompactionSourceEvent[];
}

interface StoredTaskSession {
  /** Working history and source evidence share one revision-checked JSON snapshot. */
  schemaVersion: 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  canonicalRoot: string;
  /** Entry-point authority identity chosen by trusted host code, never a prompt or tool argument. */
  authorityId: string;
  /** Nonsecret digest of effective provider/model/configuration; no credential bytes are stored. */
  configId: string;
  executionAuthorityId?: string;
  revision: number;
  activeTaskId: string;
  tasks: StoredTask[];
  /** Present only after an explicit ACP task-protocol opt-in. */
  taskProtocol?: StoredFixedTaskProtocolV1;
  /** Metadata-only pointer. V1 transcript is never admitted to a v2 Agent history. */
  importedFrom?: V1ImportOrigin;
}

export interface FixedTaskProtocolV1 {
  readonly version: 1;
  readonly mode: "fixed-active-task";
  readonly executionVersion?: 1;
}

interface StoredFixedTaskProtocolV1 extends FixedTaskProtocolV1 {
  activationEpoch: number;
  activationId: string;
  /** Immediate predecessor only: permits one bounded retry if the load acknowledgement was lost. */
  priorActivation?: { activationEpoch: number; activationId: string };
}

export interface ExpectedTaskActivation {
  readonly id: string;
  readonly root: string;
  readonly activationEpoch: number;
  readonly activationId: string;
}

export interface TaskActivationReceipt extends FixedTaskProtocolV1, ExpectedTaskActivation {
  readonly label: string;
}

interface V1ImportOrigin {
  schemaVersion: 1;
  sourceSessionId: string;
  sourceSha256: string;
  sourceRevision: number;
  sourceActiveTaskId: string;
  importedActiveTaskId: string;
  taskMap: Array<{ sourceTaskId: string; importedTaskId: string }>;
}

interface StoredTaskSessionV1 extends Omit<StoredTaskSession, "schemaVersion" | "tasks" | "importedFrom" | "taskProtocol"> {
  schemaVersion: 1;
  tasks: Array<Omit<StoredTask, "sourceEvents">>;
}

export interface ImportTaskSessionV1Options {
  home: string;
  root: string;
  authorityId: string;
  configId: string;
  sourceSessionId: string;
}

export interface ImportTaskSessionV1Result {
  sessionId: string;
  activeTaskId: string;
  sourceSha256: string;
  sourceSessionId: string;
  importedTaskCount: number;
}

export interface TaskSessionOptions<R extends TaskSessionRuntime> {
  /** Configured HOME, not a model/client-supplied path. */
  home: string;
  /** Existing root already authorized by this entrypoint's host policy. */
  root: string;
  /** Stable identity of the host authority ceiling (`local` or a launcher-owned ACP profile key). */
  authorityId: string;
  /** Digest of the effective config, computed by taskSessionConfigId from trusted runtime config. */
  configId: string;
  /** Optional trusted execution ceiling digest, never read from model/client metadata. */
  executionAuthorityId?: string;
  runtimeFactory: TaskRuntimeFactory<R>;
}

export interface CreateTaskSessionOptions<R extends TaskSessionRuntime> extends TaskSessionOptions<R> {
  label: string;
  /** Explicit opt-in; absence preserves the existing task-session v2 format. */
  taskProtocol?: FixedTaskProtocolV1;
}

export interface LoadTaskSessionOptions<R extends TaskSessionRuntime> extends TaskSessionOptions<R> {
  sessionId: string;
  taskProtocol?: FixedTaskProtocolV1;
  /** Saved receipt from the prior activation; required for fixed task protocol v1. */
  expectedTask?: ExpectedTaskActivation;
}

/** A switch may commit B before retiring A's external resources. Never report that as a rollback. */
export class TaskSwitchCommittedError extends Error {
  readonly committed = true;
  constructor(readonly activeTaskId: string, cause: unknown) {
    super("Task switch committed, but previous runtime cleanup failed", { cause });
    this.name = "TaskSwitchCommittedError";
  }
}

function validLabel(label: unknown): label is string {
  return typeof label === "string" && label.trim().length > 0
    && Buffer.byteLength(label, "utf8") <= 256 && !/[\x00-\x1f\x7f]/.test(label);
}

function assertLabel(label: string): void {
  if (!validLabel(label)) throw new Error("Invalid task label");
}

function assertAuthorityId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9:._-]{1,256}$/.test(value)) {
    throw new Error("Invalid task session authority identity");
  }
}

function assertConfigId(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid task session config identity");
  }
}

/** A receipt outside the one-attempt retry window cannot be safely auto-resumed. */
export class TaskSessionRecoveryRequiredError extends Error {
  readonly code = "NEKO_TASK_RECOVERY_REQUIRED";
  readonly kind = "recovery_required";
  constructor() {
    super("Task activation receipt is too old; explicit recovery is required");
    this.name = "TaskSessionRecoveryRequiredError";
  }
}

function assertFixedTaskProtocol(value: FixedTaskProtocolV1 | undefined): void {
  if (value === undefined) return;
  if (!value || value.version !== 1 || value.mode !== "fixed-active-task"
    || (value.executionVersion !== undefined && value.executionVersion !== 1)) {
    throw new Error("Unsupported task protocol");
  }
}

function validStoredTaskProtocol(value: unknown): value is StoredFixedTaskProtocolV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // SAFETY: persisted protocol is a non-array object; every accepted field is checked below.
  const protocol = value as Record<string, unknown>;
  if (protocol.executionVersion !== undefined && protocol.executionVersion !== 1) return false;
  const keys = Object.keys(protocol).filter((key) => key !== "executionVersion").sort().join(",");
  if (keys !== "activationEpoch,activationId,mode,version"
    && keys !== "activationEpoch,activationId,mode,priorActivation,version") return false;
  if (protocol.version !== 1 || protocol.mode !== "fixed-active-task"
    || !Number.isSafeInteger(protocol.activationEpoch) || Number(protocol.activationEpoch) < 1
    || typeof protocol.activationId !== "string" || !SAFE_ID.test(protocol.activationId)) return false;
  if (protocol.priorActivation === undefined) return protocol.activationEpoch === 1;
  if (!protocol.priorActivation || typeof protocol.priorActivation !== "object"
    || Array.isArray(protocol.priorActivation)) return false;
  // SAFETY: the prior activation is an object whose two fields and exact shape are checked below.
  const prior = protocol.priorActivation as Record<string, unknown>;
  return Object.keys(prior).sort().join(",") === "activationEpoch,activationId"
    && Number.isSafeInteger(prior.activationEpoch)
    && Number(prior.activationEpoch) === Number(protocol.activationEpoch) - 1
    && typeof prior.activationId === "string" && SAFE_ID.test(prior.activationId)
    && prior.activationId !== protocol.activationId;
}

function mcpEndpointIdentity(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // URL credentials, query and fragment may contain secrets; only route identity is bound.
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch { return "<invalid-url>"; }
}

/** Bind task-session resume to a nonsecret effective runtime configuration. */
export function taskSessionConfigId(cfg: NekoConfig, effectiveMode: string = cfg.mode): string {
  const profile = cfg.profile ? cfg.profiles[cfg.profile] : undefined;
  const fields = {
    // Reject older unbound interaction identities; never silently rehash a saved task.
    version: 2,
    computerInputPolicy: cfg.computerUseInputPolicy,
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    profile: cfg.profile ?? null,
    authRoute: profile?.auth ?? null,
    configuredMode: cfg.mode,
    effectiveMode,
    contextWindow: cfg.contextWindow,
    effort: cfg.effort,
    sandbox: cfg.sandbox,
    sandboxNetwork: cfg.sandboxNetwork,
    sandboxDomains: [...cfg.sandboxDomains].sort(),
    sandboxAutoApprove: cfg.sandboxAutoApprove,
    allowDangerousBash: cfg.allowDangerousBash,
    readOutsideRoot: cfg.readOutsideRoot,
    additionalWriteRoots: [...cfg.additionalWriteRoots].sort(),
    // Secrets in MCP env, headers, URL query, and command args never enter this digest.
    // A changed endpoint/command/cwd under the same name still invalidates resume.
    mcpServers: Object.entries(cfg.mcpServers).sort(([a], [b]) => a.localeCompare(b)).map(([name, server]) => ({
      name,
      type: server.type ?? null,
      command: server.command ?? null,
      cwd: server.cwd ?? null,
      endpoint: mcpEndpointIdentity(server.url),
    })),
    mcpLazy: cfg.mcpLazy ?? null,
    mcpAllow: [...cfg.mcpAllow].sort(),
    mcpDeny: [...cfg.mcpDeny].sort(),
    browserExtensionIds: [...cfg.browserExtensionIds].sort(),
  };
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function randomId(): string { return randomBytes(16).toString("hex"); }

function taskStoreDir(home: string): string {
  if (typeof home !== "string" || !isAbsolute(home)) throw new Error("Task session home must be absolute");
  const root = resolve(home);
  const parent = join(root, ".neko-core");
  const dir = join(parent, "task-sessions");
  for (const path of [root, parent, dir]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new Error("Task session store cannot use a link or non-directory");
  }
  return dir;
}

/** Read-only existence probe for restore routing. Any present artifact must be loaded or rejected, never bypassed. */
export function taskSessionExists(home: string, sessionId: string): boolean {
  if (typeof home !== "string" || !isAbsolute(home)) throw new Error("Task session home must be absolute");
  if (!SAFE_ID.test(sessionId)) throw new Error("Invalid task session id");
  const root = resolve(home);
  const parent = join(root, ".neko-core");
  const dir = join(parent, "task-sessions");
  for (const path of [root, parent, dir]) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory()) throw new Error("Task session store cannot use a link or non-directory");
  }
  try { lstatSync(storePath(dir, sessionId)); return true; }
  catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

function storePath(dir: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error("Invalid task session id");
  return join(dir, `${id}.json`);
}

function validateMessages(messages: unknown): messages is unknown[] {
  return Array.isArray(messages) && messages.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    // SAFETY: value is a non-array object; only inspected fields are accepted below.
    const message = value as Record<string, unknown>;
    return ["system", "user", "assistant", "tool"].includes(String(message.role ?? ""))
      && (typeof message.content === "string" || message.content === null || Array.isArray(message.content));
  });
}

function cloneMessages(messages: unknown): unknown[] {
  if (!validateMessages(messages)) throw new Error("Invalid task working messages");
  const text = JSON.stringify(messages);
  if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) throw new Error("Task working messages exceed session size limit");
  const copy: unknown = JSON.parse(text);
  if (!validateMessages(copy)) throw new Error("Invalid task working messages");
  return copy;
}

function cloneSourceEvents(value: unknown, taskId: string, root: string): CompactionSourceEvent[] {
  return validateCompactionSourceEvents(value, taskId, root);
}

function validateSourceReferences(messages: unknown[], events: CompactionSourceEvent[]): void {
  const available = new Map(events.map((event) => [event.id, event]));
  for (const value of messages) {
    // SAFETY: cloneMessages/parseStored already require every message to be a non-array object.
    const message = value as Record<string, unknown>;
    if (message._neko_source_event_id !== undefined) {
      const event = available.get(String(message._neko_source_event_id));
      if (!event || !sourceProjectionMatches(event, message)) {
        throw new Error("Task source marker has no matching raw observation");
      }
    }
    if (message._neko_compaction_source_ids !== undefined) {
      const refs = message._neko_compaction_source_ids;
      if (!Array.isArray(refs) || refs.some((id) => typeof id !== "string" || !available.has(id))
        || message._neko_compaction_source_digest !== createHash("sha256").update(JSON.stringify(refs)).digest("hex")) {
        throw new Error("Task compaction references missing or changed source evidence");
      }
    }
  }
}

/** Read the exact known task-session v1 shape; ordinary v2 load never calls this. */
function parseStoredV1(raw: string, expectedId: string): StoredTaskSessionV1 {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) throw new Error("Task session exceeds size limit");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Invalid task session v1 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task session v1");
  // SAFETY: parsed object shape is checked before use.
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.id !== expectedId || !SAFE_ID.test(expectedId)
    || typeof data.canonicalRoot !== "string" || !isAbsolute(data.canonicalRoot)
    || typeof data.authorityId !== "string" || !/^[A-Za-z0-9:._-]{1,256}$/.test(data.authorityId)
    || typeof data.configId !== "string" || !/^[a-f0-9]{64}$/.test(data.configId)
    || typeof data.createdAt !== "string" || typeof data.updatedAt !== "string"
    || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0
    || data.taskProtocol !== undefined
    || typeof data.activeTaskId !== "string" || !Array.isArray(data.tasks)
    || data.tasks.length < 1 || data.tasks.length > 1024) throw new Error("Invalid task session v1");
  const ids = new Set<string>();
  for (const entry of data.tasks) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid task record v1");
    // SAFETY: the parsed task is a non-array object checked directly above.
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== "string" || !SAFE_ID.test(task.id) || ids.has(task.id)
      || !validLabel(task.label) || task.canonicalRoot !== data.canonicalRoot
      || !Number.isSafeInteger(task.revision) || Number(task.revision) < 0
      || !validateMessages(task.messages) || task.sourceEvents !== undefined) {
      throw new Error("Invalid or ambiguous task record v1");
    }
    ids.add(task.id);
  }
  if (!ids.has(data.activeTaskId)) throw new Error("Task session v1 has no active task");
  // SAFETY: session and every v1 task field were validated against the exact legacy schema.
  return value as StoredTaskSessionV1;
}

function validateImportOrigin(value: unknown, sessionId: string, taskIds: Set<string>): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task import origin");
  // SAFETY: the optional origin is a non-array object checked directly above.
  const origin = value as Record<string, unknown>;
  if (origin.schemaVersion !== 1 || origin.sourceSessionId === sessionId
    || typeof origin.sourceSessionId !== "string" || !SAFE_ID.test(origin.sourceSessionId)
    || typeof origin.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(origin.sourceSha256)
    || !Number.isSafeInteger(origin.sourceRevision) || Number(origin.sourceRevision) < 0
    || typeof origin.sourceActiveTaskId !== "string" || !SAFE_ID.test(origin.sourceActiveTaskId)
    || typeof origin.importedActiveTaskId !== "string" || !taskIds.has(origin.importedActiveTaskId)
    || !Array.isArray(origin.taskMap) || origin.taskMap.length < 1 || origin.taskMap.length > taskIds.size) {
    throw new Error("Invalid task import origin");
  }
  const sourceIds = new Set<string>();
  const importedIds = new Set<string>();
  for (const item of origin.taskMap) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid task import mapping");
    // SAFETY: this mapping is a non-array object checked directly above.
    const mapping = item as Record<string, unknown>;
    if (typeof mapping.sourceTaskId !== "string" || !SAFE_ID.test(mapping.sourceTaskId)
      || typeof mapping.importedTaskId !== "string" || !taskIds.has(mapping.importedTaskId)
      || sourceIds.has(mapping.sourceTaskId) || importedIds.has(mapping.importedTaskId)) {
      throw new Error("Invalid task import mapping");
    }
    sourceIds.add(mapping.sourceTaskId);
    importedIds.add(mapping.importedTaskId);
  }
  if (!origin.taskMap.some((item) => item.sourceTaskId === origin.sourceActiveTaskId
    && item.importedTaskId === origin.importedActiveTaskId)) throw new Error("Invalid task import active mapping");
}

function parseStored(raw: string, expectedId: string): StoredTaskSession {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) throw new Error("Task session exceeds size limit");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task session");
  // SAFETY: JSON parsed as a non-array object; every persisted field is checked below.
  const data = value as Record<string, unknown>;
  if (data.schemaVersion === 1) throw new Error("Task session v1 has no source archive; explicit import is required (file unchanged)");
  if (data.schemaVersion !== 2 || data.id !== expectedId || !SAFE_ID.test(expectedId)
    || typeof data.canonicalRoot !== "string" || !isAbsolute(data.canonicalRoot)
    || typeof data.authorityId !== "string" || !/^[A-Za-z0-9:._-]{1,256}$/.test(data.authorityId)
    || typeof data.configId !== "string" || !/^[a-f0-9]{64}$/.test(data.configId)
    || typeof data.createdAt !== "string" || typeof data.updatedAt !== "string"
    || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0
    || typeof data.activeTaskId !== "string" || !Array.isArray(data.tasks)
    || data.tasks.length < 1 || data.tasks.length > 1024) throw new Error("Invalid task session");
  const ids = new Set<string>();
  for (const entry of data.tasks) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid task record");
    // SAFETY: each task is a non-array object; its fields are checked below.
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== "string" || !SAFE_ID.test(task.id) || ids.has(task.id)
      || !validLabel(task.label) || task.canonicalRoot !== data.canonicalRoot
      || !Number.isSafeInteger(task.revision) || Number(task.revision) < 0
      || !validateMessages(task.messages)) throw new Error("Invalid task record");
    // SAFETY: task.canonicalRoot and task.messages passed the root and message checks above.
    const events = cloneSourceEvents(task.sourceEvents, task.id, task.canonicalRoot as string);
    // SAFETY: validateMessages accepted this task's working history above.
    validateSourceReferences(task.messages as unknown[], events);
    ids.add(task.id);
  }
  if (!ids.has(data.activeTaskId)) throw new Error("Task session has no active task");
  if (data.taskProtocol !== undefined && (!validStoredTaskProtocol(data.taskProtocol)
    || data.tasks.length !== 1 || data.importedFrom !== undefined)) {
    throw new Error("Invalid fixed task protocol");
  }
  if (data.executionAuthorityId !== undefined
    && (typeof data.executionAuthorityId !== "string" || !/^[a-f0-9]{64}$/.test(data.executionAuthorityId))) {
    throw new Error("Invalid task execution authority");
  }
  // SAFETY: validStoredTaskProtocol accepted the optional fixed protocol object above.
  const executionVersion = (data.taskProtocol as StoredFixedTaskProtocolV1 | undefined)?.executionVersion;
  if (Boolean(executionVersion) !== Boolean(data.executionAuthorityId)) throw new Error("Invalid task execution protocol authority");
  validateImportOrigin(data.importedFrom, expectedId, ids);
  // SAFETY: the session and every task field have passed the schema checks above.
  return value as StoredTaskSession;
}

function errnoCode(error: unknown): string | undefined {
  // SAFETY: Node filesystem/process errors expose the optional errno code; absent code is handled safely.
  return (error as NodeJS.ErrnoException | null)?.code;
}

function readStoredRaw(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > MAX_STORE_BYTES || before.nlink !== 1) {
    throw new Error("Task session file must be a regular unlinked file");
  }
  const fd = openSync(path, fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_STORE_BYTES) {
      throw new Error("Task session file changed during read");
    }
    const raw = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Task session file changed during read");
    return raw;
  } finally { closeSync(fd); }
}

function readStored(path: string, expectedId: string): StoredTaskSession {
  return parseStored(readStoredRaw(path), expectedId);
}

/** A new session ID was published, but its link count could not be confirmed loadable. */
export class TaskSessionImportCommittedError extends Error {
  readonly committed = true;
  constructor(readonly sessionId: string, readonly path: string, readonly temporaryPath: string, cause: unknown) {
    super(`Task session import committed but needs manual recovery: ${sessionId} at ${path}; temporary link ${temporaryPath}`, { cause });
    this.name = "TaskSessionImportCommittedError";
  }
}

/** Publish complete bytes without replacing a pre-existing destination. Fault hook tests lost cleanup acknowledgement. */
export function writeNewStore(path: string, text: string, sessionId: string,
  hooks: { removeTemporary?: (path: string) => void } = {}): void {
  if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) throw new Error("Task session exceeds size limit");
  const temporary = `${path}.import-${randomId()}.tmp`;
  let fd: number | undefined;
  let created = false;
  let published = false;
  try {
    fd = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    created = true;
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const original = lstatSync(temporary);
    // A same-directory hard link publishes complete bytes or fails with EEXIST; no replace-existing rename.
    linkSync(temporary, path);
    published = true;
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { (hooks.removeTemporary ?? unlinkSync)(temporary); cleanupError = undefined; break; }
      catch (error) { cleanupError = error; }
    }
    let target;
    try { target = lstatSync(path); }
    catch (error) { throw new TaskSessionImportCommittedError(sessionId, path, temporary, error); }
    if (!target.isFile() || target.dev !== original.dev || target.ino !== original.ino || target.nlink !== 1) {
      // Never unlink a pathname after a stat check: a non-cooperating process could replace
      // that pathname between the check and deletion. Report the exact uncertain artifact.
      throw new TaskSessionImportCommittedError(sessionId, path, temporary,
        cleanupError ?? "Published session identity or link count changed");
    }
  } catch (error) {
    if (created && !published) {
      try { unlinkSync(temporary); } catch { /* no published session; orphaned temp needs explicit cleanup */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function acquireWriter(dir: string, id: string): () => void {
  const path = join(dir, `${id}.lock`);
  const token = randomId();
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }));
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
      try { unlinkSync(path); } catch { /* preserve the original write error */ }
      throw error;
    }
    if (errnoCode(error) === "EEXIST") {
      // Fail closed: automatic unlinking of a dead PID's lock races with another loader.
      throw new TaskSessionWriterUnavailableError(error);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Never remove another writer's lock if the lock was replaced externally.
    try {
      // SAFETY: token is checked against this writer's opaque value before unlinking.
      const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
      if (current.token === token) unlinkSync(path);
    } catch { /* fail closed: a changed lock needs explicit recovery */ }
  };
}

/** An active or stale writer lock needs explicit recovery; never auto-remove it during load. */
export class TaskSessionWriterUnavailableError extends Error {
  readonly code = "NEKO_TASK_WRITER_UNAVAILABLE";
  readonly kind = "writer_unavailable";
  constructor(cause: unknown) {
    super("Task session already has a writer or stale lock; explicit recovery is required", { cause });
    this.name = "TaskSessionWriterUnavailableError";
  }
}

/** Explicit metadata import. V1 transcript remains only at its original path and never enters model context. */
export async function importTaskSessionV1(options: ImportTaskSessionV1Options): Promise<ImportTaskSessionV1Result> {
  assertAuthorityId(options.authorityId);
  assertConfigId(options.configId);
  const root = createTaskScope(randomId(), options.root).canonicalRoot;
  const dir = taskStoreDir(options.home);
  const sourcePath = storePath(dir, options.sourceSessionId);
  const releaseSource = acquireWriter(dir, options.sourceSessionId);
  try {
    const raw = readStoredRaw(sourcePath);
    const source = parseStoredV1(raw, options.sourceSessionId);
    if (source.canonicalRoot !== root) throw new Error("Task session v1 root changed or is not host-authorized");
    if (source.authorityId !== options.authorityId) throw new Error("Task session v1 host authority changed");
    if (source.configId !== options.configId) throw new Error("Task session v1 provider or safety configuration changed");
    const sourceSha256 = createHash("sha256").update(raw).digest("hex");
    const sessionId = randomId();
    const now = new Date().toISOString();
    const taskMap = source.tasks.map((task) => ({ sourceTaskId: task.id, importedTaskId: randomId() }));
    const tasks: StoredTask[] = source.tasks.map((task, index) => ({
      id: taskMap[index]!.importedTaskId, label: task.label, canonicalRoot: root,
      revision: 0, messages: [], sourceEvents: [],
    }));
    const activeTaskId = taskMap.find((task) => task.sourceTaskId === source.activeTaskId)!.importedTaskId;
    const state: StoredTaskSession = {
      schemaVersion: 2, id: sessionId, createdAt: now, updatedAt: now, canonicalRoot: root,
      authorityId: options.authorityId, configId: options.configId,
      revision: 0, activeTaskId, tasks,
      importedFrom: { schemaVersion: 1, sourceSessionId: source.id, sourceSha256,
        sourceRevision: source.revision, sourceActiveTaskId: source.activeTaskId,
        importedActiveTaskId: activeTaskId, taskMap },
    };
    const path = storePath(dir, sessionId);
    const releaseTarget = acquireWriter(dir, sessionId);
    try {
      // Recheck the snapshot while the cooperative source writer lease is held.
      if (createHash("sha256").update(readStoredRaw(sourcePath)).digest("hex") !== sourceSha256) {
        throw new Error("Task session v1 changed during import");
      }
      writeNewStore(path, JSON.stringify(state), sessionId);
      return { sessionId, activeTaskId, sourceSha256, sourceSessionId: source.id,
        importedTaskCount: tasks.length };
    } finally { releaseTarget(); }
  } finally { releaseSource(); }
}

/** One active task; the runtime factory must bind scope before reading memory/context. */
export class TaskSessionCoordinator<R extends TaskSessionRuntime> {
  private busy = false;
  private closed = false;
  private constructor(
    private readonly path: string,
    private readonly root: string,
    private readonly factory: TaskRuntimeFactory<R>,
    private readonly releaseWriter: () => void,
    private state: StoredTaskSession,
    private runtime: R,
    private scope: TaskScope,
    private readonly recoveredFromPrior = false,
  ) {}

  static async create<R extends TaskSessionRuntime>(options: CreateTaskSessionOptions<R>): Promise<TaskSessionCoordinator<R>> {
    assertLabel(options.label);
    assertAuthorityId(options.authorityId);
    assertConfigId(options.configId);
    assertFixedTaskProtocol(options.taskProtocol);
    if (options.executionAuthorityId !== undefined) assertConfigId(options.executionAuthorityId);
    if (Boolean(options.executionAuthorityId) !== Boolean(options.taskProtocol?.executionVersion)) {
      throw new Error("Task execution protocol requires a trusted authority digest");
    }
    const root = createTaskScope(randomId(), options.root).canonicalRoot;
    const dir = taskStoreDir(options.home);
    const id = randomId();
    const taskId = randomId();
    const release = acquireWriter(dir, id);
    const path = storePath(dir, id);
    const now = new Date().toISOString();
    const state: StoredTaskSession = {
      schemaVersion: 2, id, createdAt: now, updatedAt: now, canonicalRoot: root,
      authorityId: options.authorityId,
      configId: options.configId,
      ...(options.executionAuthorityId ? { executionAuthorityId: options.executionAuthorityId } : undefined),
      revision: 0, activeTaskId: taskId,
      tasks: [{ id: taskId, label: options.label, canonicalRoot: root, revision: 0, messages: [], sourceEvents: [] }],
    };
    if (options.taskProtocol) {
      state.taskProtocol = { version: 1, mode: "fixed-active-task",
        ...(options.taskProtocol.executionVersion ? { executionVersion: 1 } : undefined),
        activationEpoch: 1, activationId: randomId() };
    }
    let scope: TaskScope | undefined;
    try {
      scope = createTaskScope(taskId, options.root, {
        activationEpoch: state.taskProtocol?.activationEpoch ?? 1,
        activationId: state.taskProtocol?.activationId ?? randomId(),
        executionAuthorityId: options.executionAuthorityId,
      });
      const runtime = await options.runtimeFactory({ sessionId: id, taskId, label: options.label, root, scope, messages: [], sourceEvents: [] });
      try {
        if (existsSync(path)) throw new Error("Task session id collision");
        atomicWriteFileSync(path, JSON.stringify(state), 0o600);
        return new TaskSessionCoordinator(path, root, options.runtimeFactory, release, state, runtime, scope);
      } catch (error) {
        revokeTaskScope(scope);
        try { await runtime.close(); } catch { /* retain the original persistence error */ }
        throw error;
      }
    } catch (error) { if (scope) revokeTaskScope(scope); release(); throw error; }
  }

  static async load<R extends TaskSessionRuntime>(options: LoadTaskSessionOptions<R>): Promise<TaskSessionCoordinator<R>> {
    assertAuthorityId(options.authorityId);
    assertConfigId(options.configId);
    assertFixedTaskProtocol(options.taskProtocol);
    if (options.executionAuthorityId !== undefined) assertConfigId(options.executionAuthorityId);
    if (Boolean(options.executionAuthorityId) !== Boolean(options.taskProtocol?.executionVersion)) {
      throw new Error("Task execution protocol requires a trusted authority digest");
    }
    const root = createTaskScope(randomId(), options.root).canonicalRoot;
    const dir = taskStoreDir(options.home);
    const path = storePath(dir, options.sessionId);
    const release = acquireWriter(dir, options.sessionId);
    let scope: TaskScope | undefined;
    try {
      const state = readStored(path, options.sessionId);
      let recoveredFromPrior = false;
      if (state.canonicalRoot !== root) throw new Error("Task session root changed or is not host-authorized");
      if (state.authorityId !== options.authorityId) throw new Error("Task session host authority changed");
      if (state.configId !== options.configId) throw new Error("Task session provider or safety configuration changed");
      if (state.executionAuthorityId !== options.executionAuthorityId) throw new Error("Task session execution authority changed");
      if (state.taskProtocol?.executionVersion !== options.taskProtocol?.executionVersion) {
        throw new Error("Task execution protocol opt-in changed");
      }
      if (Boolean(state.taskProtocol) !== Boolean(options.taskProtocol)) {
        throw new Error("Task protocol opt-in changed; explicit matching protocol is required");
      }
      if (state.taskProtocol) {
        const expected = options.expectedTask;
        if (!expected || typeof expected.id !== "string" || !SAFE_ID.test(expected.id)
          || typeof expected.root !== "string" || !isAbsolute(expected.root)
          || !Number.isSafeInteger(expected.activationEpoch) || expected.activationEpoch < 1
          || typeof expected.activationId !== "string" || !SAFE_ID.test(expected.activationId)) {
          throw new Error("A valid prior task activation receipt is required");
        }
        const expectedRoot = createTaskScope(expected.id, expected.root).canonicalRoot;
        const current = expected.activationEpoch === state.taskProtocol.activationEpoch
          && expected.activationId === state.taskProtocol.activationId;
        const priorActivation = state.taskProtocol.priorActivation;
        const prior = priorActivation !== undefined
          && expected.activationEpoch === priorActivation.activationEpoch
          && expected.activationId === priorActivation.activationId;
        if (expected.id !== state.activeTaskId || expectedRoot !== root) {
          throw new Error("Task activation receipt does not match the saved task and root");
        }
        if (!current && !prior) {
          if (expected.activationEpoch < state.taskProtocol.activationEpoch - 1) {
            throw new TaskSessionRecoveryRequiredError();
          }
          throw new Error("Task activation receipt does not match the saved task and root");
        }
        recoveredFromPrior = prior;
        if (state.taskProtocol.activationEpoch >= Number.MAX_SAFE_INTEGER) {
          throw new Error("Task activation epoch exhausted");
        }
      } else if (options.expectedTask !== undefined) {
        throw new Error("Task activation receipt requires explicit task protocol opt-in");
      }
      const task = state.tasks.find((item) => item.id === state.activeTaskId)!;
      scope = createTaskScope(task.id, options.root, {
        activationEpoch: (state.taskProtocol?.activationEpoch ?? state.revision) + 1,
        activationId: randomId(), executionAuthorityId: options.executionAuthorityId,
      });
      if (scope.canonicalRoot !== task.canonicalRoot) throw new Error("Task root changed");
      const runtime = await options.runtimeFactory({
        sessionId: state.id, taskId: task.id, label: task.label, root, scope,
        messages: cloneMessages(task.messages), sourceEvents: cloneSourceEvents(task.sourceEvents, task.id, task.canonicalRoot),
      });
      const coordinator = new TaskSessionCoordinator(path, root, options.runtimeFactory, release, state, runtime,
        scope, recoveredFromPrior);
      if (state.taskProtocol) {
        try {
          coordinator.persist({ ...state, taskProtocol: { ...state.taskProtocol,
            priorActivation: { activationEpoch: state.taskProtocol.activationEpoch,
              activationId: state.taskProtocol.activationId },
            activationEpoch: scope.activationEpoch, activationId: scope.activationId } });
        } catch (error) {
          revokeTaskScope(scope);
          try { await runtime.close(); } catch { /* preserve the original activation error */ }
          throw error;
        }
      }
      return coordinator;
    } catch (error) { if (scope) revokeTaskScope(scope); release(); throw error; }
  }

  get id(): string { return this.state.id; }
  get sessionId(): string { return this.state.id; }
  get recoveredFromPriorReceipt(): boolean { return this.recoveredFromPrior; }
  get executionVersion(): 1 | undefined { return this.state.taskProtocol?.executionVersion; }
  get receipt(): TaskActivationReceipt | null {
    const protocol = this.state.taskProtocol;
    if (!protocol) return null;
    const task = this.activeTask();
    return Object.freeze({ version: protocol.version, mode: protocol.mode,
      id: task.id, label: task.label, root: task.canonicalRoot,
      activationEpoch: protocol.activationEpoch, activationId: protocol.activationId });
  }
  get active(): ActiveTaskRuntime<R> {
    const task = this.activeTask();
    return { id: task.id, label: task.label, root: this.root, scope: this.scope, runtime: this.runtime };
  }
  get tasks(): ReadonlyArray<{ id: string; label: string; root: string }> {
    return this.state.tasks.map((task) => ({ id: task.id, label: task.label, root: task.canonicalRoot }));
  }

  private activeTask(): StoredTask { return this.state.tasks.find((task) => task.id === this.state.activeTaskId)!; }
  private assertReady(): void {
    if (this.closed) throw new Error("Task session is closed");
    if (this.busy) throw new Error("Task session transition is already in progress");
  }
  private persist(next: StoredTaskSession): void {
    const current = readStored(this.path, this.state.id);
    if (current.revision !== this.state.revision) throw new Error("Task session revision conflict");
    next.revision = current.revision + 1;
    next.updatedAt = new Date().toISOString();
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) throw new Error("Task session exceeds size limit");
    atomicWriteFileSync(this.path, text, 0o600);
    this.state = next;
  }
  private capture(): StoredTaskSession {
    const task = this.activeTask();
    const messages = cloneMessages(this.runtime.getMessages());
    const sourceEvents = cloneSourceEvents(this.runtime.getSourceEvents(), task.id, task.canonicalRoot);
    validateSourceReferences(messages, sourceEvents);
    return {
      ...this.state,
      tasks: this.state.tasks.map((item) => item.id === task.id
        ? { ...item, messages, sourceEvents, revision: item.revision + 1 } : item),
    };
  }

  /** Synchronous serialization under the writer lease captures one ordered message snapshot. */
  checkpoint(): void {
    this.assertReady();
    this.persist(this.capture());
  }

  /** Metadata-only; safe during a turn because it neither captures nor retargets that turn. */
  createTask(label: string): string {
    this.assertReady();
    if (this.state.taskProtocol) throw new Error("Fixed task protocol does not permit task creation");
    assertLabel(label);
    const id = randomId();
    this.persist({
      ...this.state,
      tasks: [...this.state.tasks, { id, label, canonicalRoot: this.root, revision: 0, messages: [], sourceEvents: [] }],
    });
    return id;
  }

  async switchTask(id: string): Promise<void> {
    this.assertReady();
    if (this.state.taskProtocol) throw new Error("Fixed task protocol does not permit task switching");
    if (!SAFE_ID.test(id) || !this.state.tasks.some((task) => task.id === id)) throw new Error("Unknown task id");
    if (id === this.state.activeTaskId) return;
    this.busy = true;
    let candidateScope: TaskScope | undefined;
    try {
      await this.runtime.assertQuiescent();
      this.persist(this.capture());
      const target = this.state.tasks.find((task) => task.id === id)!;
      // Revalidate the physical root at every activation; a task id grants no filesystem rights.
      const scope = createTaskScope(id, this.root, {
        activationEpoch: this.scope.activationEpoch + 1, activationId: randomId(),
        executionAuthorityId: this.state.executionAuthorityId,
      });
      candidateScope = scope;
      if (scope.canonicalRoot !== target.canonicalRoot) throw new Error("Task root changed");
      const nextRuntime = await this.factory({
        sessionId: this.state.id, taskId: id, label: target.label, root: this.root, scope,
        messages: cloneMessages(target.messages), sourceEvents: cloneSourceEvents(target.sourceEvents, target.id, target.canonicalRoot),
      });
      try { this.persist({ ...this.state, activeTaskId: id }); }
      catch (error) { revokeTaskScope(scope); await nextRuntime.close(); throw error; }
      const previous = this.runtime;
      revokeTaskScope(this.scope);
      this.runtime = nextRuntime;
      this.scope = scope;
      candidateScope = undefined;
      try { await previous.close(); }
      catch (error) { throw new TaskSwitchCommittedError(id, error); }
    } finally { if (candidateScope) revokeTaskScope(candidateScope); this.busy = false; }
  }

  async close(): Promise<void> {
    this.assertReady();
    this.busy = true;
    try {
      if (this.runtime.settleForClose) await this.runtime.settleForClose();
      else await this.runtime.assertQuiescent();
      this.persist(this.capture());
      revokeTaskScope(this.scope);
      await this.runtime.close();
      this.closed = true;
      this.releaseWriter();
    } finally { this.busy = false; }
  }
}

export const createTaskSession = TaskSessionCoordinator.create;
export const loadTaskSession = TaskSessionCoordinator.load;
