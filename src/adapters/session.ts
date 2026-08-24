/**
 * Conversation persistence. Sessions are JSON files under ~/.neko-core/sessions/ (in HOME,
 * never committed), keyed by an id and tagged with the project cwd. `neko chat` saves after
 * each turn; `neko chat --resume` reloads the latest session for the current directory.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { atomicWriteFile, atomicWriteFileSync } from "../shared/atomic.ts";
import { hasTerminalControl, terminalSafeText } from "../shared/terminal-text.ts";
import { trustedGitOutput, trustedGitOutputAsync } from "./trusted-git.ts";
import { homeDir } from "../shared/home.ts";
import { isBool, isJsonNumber, isJsonObject, isText, type JsonObject } from "../shared/wire.ts";
import { dirname, join, resolve } from "node:path";
import type { StoredHostProfile } from "./host-profile.ts";

export type SessionTurnStatus = "idle" | "running" | "interrupted";

export interface SessionTurnState {
  status: SessionTurnStatus;
  startedAt?: string;
  recoveredAt?: string;
  lastStopReason?: string;
  activeToolCallIds?: string[];
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  calls: number;
  lastPrompt: number;
  lastCompletion: number;
  lastCached: number;
  lastCacheWrite: number;
}

export interface Session {
  /** Version 2 adds durable host metadata while remaining readable by older Neko builds. */
  schemaVersion?: 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  messages: any[];
  branch?: string; // git branch at last save
  bytes?: number; // approx content size (messages JSON length)
  title?: string; // user-set name (overrides the first-message title)
  provider?: string;
  profile?: string | null;
  mode?: "default" | "accept-edits" | "plan" | "auto";
  reasoningEffort?: string;
  revision?: number;
  turnState?: SessionTurnState;
  usage?: SessionUsage;
  contextFingerprint?: string;
  /** Immutable launch-authorized ACP host authority; absent for ordinary Neko sessions. */
  hostProfile?: StoredHostProfile;
}

/** Lightweight session metadata for the picker/list - everything EXCEPT the (large) messages array.
 * Listing a session store this way avoids parsing every full transcript just to show a menu. */
export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  branch?: string;
  bytes?: number;
  title?: string; // user-set name
  provider?: string;
  profile?: string | null;
  mode?: "default" | "accept-edits" | "plan" | "auto";
  reasoningEffort?: string;
  revision?: number;
  turnState?: SessionTurnState;
  hostProfile?: StoredHostProfile;
  msgCount: number;
  titleText: string; // precomputed first-user-message title (so no messages needed to show a title)
  mtime: number; // file mtimeMs at index time - freshness key (with fsize)
  fsize?: number; // file size at index time. mtimeMs ALONE misses same-millisecond rewrites (ext4 saw two
  // saves land on one tick in tests); size catches the append. rsync-style mtime+size composite check.
}

/** Test hook: point the store at an explicit directory (null restores the default resolution).
 * Env-based isolation (setting HOME per test file) is racy under bun test, so tests that assert on
 * the store's files set the directory directly instead. */
let dirOverride: string | null = null;
export function setSessionsDir(dir: string | null): void {
  dirOverride = dir;
}

function sessionsDir(): string {
  if (dirOverride) return dirOverride;
  // Under `bun test` (which sets NODE_ENV=test; the shipped CLI never runs that way) the store
  // diverts to a per-process temp dir. UI tests render ChatApp, and ChatApp persists after every
  // turn — unisolated runs flooded the real ~/.neko-core/sessions with thousands of fake sessions
  // (6,611 files observed), burying every real conversation in the /resume picker and handing
  // --resume/-c a test transcript as "the latest session". This single choke point isolates every
  // caller — saves, loads, the list, and the .index.json cache — without per-file env juggling.
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `neko-test-sessions-${process.pid}`);
  return join(homeDir(), ".neko-core", "sessions");
}

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_TIME_BYTES = 128;
const MAX_SESSION_CWD_BYTES = 128 * 1024;
const MAX_SESSION_MODEL_BYTES = 4 * 1024;
const MAX_SESSION_TITLE_BYTES = 4 * 1024;
const MAX_SESSION_BRANCH_BYTES = 4 * 1024;
const MAX_SESSION_PROVIDER_BYTES = 4 * 1024;
const MAX_SESSION_PROFILE_BYTES = 4 * 1024;
const MAX_SESSION_EFFORT_BYTES = 4 * 1024;
const MAX_SESSION_FINGERPRINT_BYTES = 4 * 1024;
const MAX_SESSION_TITLE_DISPLAY_CHARS = 240;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id) && !id.endsWith(".") && !WINDOWS_DEVICE.test(id);
}

function sessionPath(id: string): string | null {
  if (!isValidSessionId(id)) return null;
  const dir = resolve(sessionsDir());
  const path = resolve(dir, `${id}.json`);
  return dirname(path) === dir ? path : null;
}

function validMessage(value: any): boolean {
  if (!isJsonObject(value)) return false;
  // SAFETY: wire/config payload shape; keys are produced by the boundary that owns this data.
  const message = value as any;
  if (!new Set(["system", "user", "assistant", "tool"]).has(String(message.role ?? ""))) return false;
  if (message._neko_internal !== undefined && !isBool(message._neko_internal)) return false;
  return isText(message.content) || message.content === null || Array.isArray(message.content);
}

function validMetadataText(value: any, maxBytes: number): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !hasTerminalControl(value);
}

function validTurnState(value: any): value is SessionTurnState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // SAFETY: wire/config payload shape; keys are produced by the boundary that owns this data.
  const state = value as any;
  if (!new Set(["idle", "running", "interrupted"]).has(String(state.status ?? ""))) return false;
  if (state.startedAt !== undefined && !validMetadataText(state.startedAt, MAX_SESSION_TIME_BYTES)) return false;
  if (state.recoveredAt !== undefined && !validMetadataText(state.recoveredAt, MAX_SESSION_TIME_BYTES)) return false;
  if (state.lastStopReason !== undefined && !validMetadataText(state.lastStopReason, MAX_SESSION_TITLE_BYTES)) return false;
  return state.activeToolCallIds === undefined || (Array.isArray(state.activeToolCallIds)
    && state.activeToolCallIds.length <= 256
    && state.activeToolCallIds.every((id: any) => validMetadataText(id, MAX_SESSION_TITLE_BYTES)));
}

function validUsage(value: any): value is SessionUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // SAFETY: wire/config payload shape; keys are produced by the boundary that owns this data.
  const usage = value as any;
  const keys = ["promptTokens", "completionTokens", "totalTokens", "cachedTokens", "cacheWriteTokens",
    "calls", "lastPrompt", "lastCompletion", "lastCached", "lastCacheWrite"];
  return keys.every((key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0);
}

function validStoredHostProfile(value: any): value is StoredHostProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value;
  return profile.schemaVersion === 1
    && /^[a-z][a-z0-9-]{0,63}$/.test(String(profile.id ?? ""))
    && Number.isSafeInteger(profile.version) && profile.version >= 1
    && /^[a-z][a-z0-9-]{0,63}$/.test(String(profile.mcpServerName ?? ""))
    && /^[a-f0-9]{64}$/.test(String(profile.toolSurfaceHash ?? ""));
}

function parseSession(value: any, expectedId: string): Session | null {
  const session = isJsonObject(value) ? value : null;
  if (session === null) return null;
  if (session.id !== expectedId || !isValidSessionId(expectedId)) return null;
  if (!validMetadataText(session.createdAt, MAX_SESSION_TIME_BYTES)
    || !validMetadataText(session.updatedAt, MAX_SESSION_TIME_BYTES)
    || !validMetadataText(session.cwd, MAX_SESSION_CWD_BYTES)
    || !validMetadataText(session.model, MAX_SESSION_MODEL_BYTES)) return null;
  if (!Array.isArray(session.messages) || !session.messages.every(validMessage)) return null;
  if (session.title !== undefined && !validMetadataText(session.title, MAX_SESSION_TITLE_BYTES)) return null;
  if (session.branch !== undefined && !validMetadataText(session.branch, MAX_SESSION_BRANCH_BYTES)) return null;
  if (session.bytes !== undefined && !isJsonNumber(session.bytes)) return null;
  if (session.schemaVersion !== undefined && session.schemaVersion !== 2) return null;
  if (session.provider !== undefined && !validMetadataText(session.provider, MAX_SESSION_PROVIDER_BYTES)) return null;
  if (session.profile !== undefined && session.profile !== null && !validMetadataText(session.profile, MAX_SESSION_PROFILE_BYTES)) return null;
  if (session.mode !== undefined && !new Set(["default", "accept-edits", "plan", "auto"]).has(String(session.mode))) return null;
  if (session.reasoningEffort !== undefined && !validMetadataText(session.reasoningEffort, MAX_SESSION_EFFORT_BYTES)) return null;
  if (session.revision !== undefined && (!Number.isSafeInteger(session.revision) || Number(session.revision) < 0)) return null;
  if (session.turnState !== undefined && !validTurnState(session.turnState)) return null;
  if (session.usage !== undefined && !validUsage(session.usage)) return null;
  if (session.contextFingerprint !== undefined && !validMetadataText(session.contextFingerprint, MAX_SESSION_FINGERPRINT_BYTES)) return null;
  if (session.hostProfile !== undefined && !validStoredHostProfile(session.hostProfile)) return null;
  // SAFETY: every field above is validated against the session schema before this cast.
  return value as Session;
}

function readSessionPath(path: string, expectedId: string): Session | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > MAX_SESSION_BYTES) return null;
    const flags = fsConstants.O_RDONLY | (process.platform === "win32"
      ? 0
      : (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    fd = openSync(path, flags);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_SESSION_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SESSION_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_SESSION_BYTES) return null;
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || total !== opened.size) return null;
    return parseSession(JSON.parse(Buffer.concat(chunks, total).toString("utf-8")), expectedId);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Current git branch for a directory, or "" if not a repo. */
// Cache the branch per cwd: git rarely changes mid-session, so look it up ONCE instead of spawning
// git (a blocking spawnSync, up to 2s) on every per-turn save — that hitch adds up and is what made
// the session test flaky under load.
const branchCache = new Map<string, string>();
const branchPromiseCache = new Map<string, Promise<string>>();
function currentBranch(cwd: string): string {
  const cached = branchCache.get(cwd);
  if (cached !== undefined) return cached;
  let branch = "";
  branch = trustedGitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  branchCache.set(cwd, branch);
  return branch;
}

async function currentBranchAsync(cwd: string): Promise<string> {
  const cached = branchCache.get(cwd);
  if (cached !== undefined) return cached;
  let pending = branchPromiseCache.get(cwd);
  if (!pending) {
    pending = trustedGitOutputAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
      .then((branch) => {
        branchCache.set(cwd, branch);
        branchPromiseCache.delete(cwd);
        return branch;
      }, () => {
        branchCache.set(cwd, "");
        branchPromiseCache.delete(cwd);
        return "";
      });
    branchPromiseCache.set(cwd, pending);
  }
  return pending;
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${String(d.getMilliseconds()).padStart(3, "0")}-${randomBytes(8).toString("hex")}`;
}

export function saveSession(session: Session): void {
  const path = sessionPath(session.id);
  if (!path || !parseSession(session, session.id)) throw new Error(`Invalid session '${session.id}'`);
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  session.branch = currentBranch(session.cwd);
  session.bytes = JSON.stringify(session.messages).length;
  if (!parseSession(session, session.id)) throw new Error(`Invalid session '${session.id}'`);
  const serialized = serializeSession(session);
  // Atomic: a kill/crash mid-write must never truncate the transcript (loadSession would then drop the whole
  // conversation as unparseable). temp + rename = the file is always the old or the new session, never half.
  const previous = existsSync(path) ? readSessionPath(path, session.id) : null;
  if (previous) atomicWriteFileSync(`${path}.bak`, serializeSession(previous));
  atomicWriteFileSync(path, serialized);
}

const yieldToEventLoop = () => new Promise<void>((resolveYield) => setTimeout(resolveYield, 0));

async function serializeSessionAsync(session: Session): Promise<string> {
  const messageJson: string[] = [];
  let messageChars = 2; // []
  let lastYield = performance.now();
  for (const message of session.messages) {
    const serialized = JSON.stringify(message);
    if (serialized === undefined) throw new Error(`Invalid session '${session.id}'`);
    if (messageJson.length) messageChars++;
    messageChars += serialized.length;
    messageJson.push(serialized);
    if (performance.now() - lastYield >= 8) {
      await yieldToEventLoop();
      lastYield = performance.now();
    }
  }
  session.bytes = messageChars;
  if (!parseSession(session, session.id)) throw new Error(`Invalid session '${session.id}'`);
  const { messages: _messages, ...metadata } = session;
  const head = JSON.stringify(metadata);
  const serialized = `${head.slice(0, -1)},"messages":[${messageJson.join(",")}]}`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
    throw new Error(`Session '${session.id}' exceeds 64 MiB`);
  }
  return serialized;
}

async function readSessionPathAsync(path: string, expectedId: string): Promise<{ session: Session; text: string } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_SESSION_BYTES) return null;
    const flags = fsConstants.O_RDONLY | (process.platform === "win32"
      ? 0
      : (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_SESSION_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.byteLength !== opened.size) return null;
    const text = bytes.toString("utf-8");
    const session = parseSession(JSON.parse(text), expectedId);
    return session ? { session, text } : null;
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch { /* already closed */ }
  }
}

/** Event-loop-friendly durable checkpoint. Serialization yields between messages, filesystem I/O is
 * asynchronous, and the previous readable primary remains the backup before the atomic publish. */
export async function saveSessionAsync(session: Session): Promise<void> {
  const path = sessionPath(session.id);
  if (!path || !parseSession(session, session.id)) throw new Error(`Invalid session '${session.id}'`);
  await mkdir(sessionsDir(), { recursive: true });
  session.updatedAt = new Date().toISOString();
  session.branch = await currentBranchAsync(session.cwd);
  const serialized = await serializeSessionAsync(session);
  const previous = await readSessionPathAsync(path, session.id);
  if (previous) await atomicWriteFile(`${path}.bak`, previous.text);
  await atomicWriteFile(path, serialized);
}

interface SessionSaveWaiter {
  generation: number;
  resolve(): void;
  reject(error: any): void;
}

/** Latest-wins checkpoint queue. A long save never creates an unbounded 750ms checkpoint backlog;
 * callers that require durability can await their generation before provider/tool side effects. */
export class AsyncSessionWriter {
  private generation = 0;
  private pending: { generation: number; create: () => Session | Promise<Session> } | null = null;
  private running: Promise<void> | null = null;
  private readonly waiters: SessionSaveWaiter[] = [];
  private latest: Promise<void> = Promise.resolve();

  constructor(private readonly saver: (session: Session) => Promise<void> = saveSessionAsync) {}

  save(session: Session): Promise<void> {
    return this.saveLazy(() => ({ ...session, messages: [...session.messages] }));
  }

  /** Lazy form for adapters that must redact/copy a large trajectory. Coalesced generations that
   * never reach disk also never pay that CPU/memory cost. */
  saveLazy(create: () => Session | Promise<Session>): Promise<void> {
    const generation = ++this.generation;
    this.pending = { generation, create };
    const result = new Promise<void>((resolve, reject) => this.waiters.push({ generation, resolve, reject }));
    this.latest = result;
    if (!this.running) this.running = this.drain();
    return result;
  }

  /** Wait for the newest generation known at call time. */
  flush(): Promise<void> {
    return this.latest;
  }

  private settle(generation: number, ok: boolean, error?: any): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index];
      if (waiter.generation > generation) continue;
      this.waiters.splice(index, 1);
      if (ok) waiter.resolve();
      else waiter.reject(error);
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        try {
          await this.saver(await next.create());
          this.settle(next.generation, true);
        } catch (error) {
          this.settle(next.generation, false, error);
        }
      }
    } finally {
      this.running = null;
      if (this.pending) this.running = this.drain();
    }
  }
}

function serializeSession(session: Session): string {
  const serialized = JSON.stringify(session, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) {
    // Never publish a transcript that the matching read boundary will immediately refuse. Since the
    // atomic write has not started yet, an earlier readable checkpoint remains intact on overflow.
    throw new Error(`Session '${session.id}' exceeds 64 MiB`);
  }
  return serialized;
}

export function loadSession(id: string): Session | null {
  const path = sessionPath(id);
  if (!path) return null;
  const current = existsSync(path) ? readSessionPath(path, id) : null;
  if (current) return current;
  const backup = `${path}.bak`;
  return existsSync(backup) ? readSessionPath(backup, id) : null;
}

export interface SessionLease {
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** Cross-process single-writer lease. A crash leaves a tiny lock file; the next process recovers it
 * only after the recorded PID is no longer alive. The random token prevents an old owner from
 * unlinking a lock that has already been replaced by a newer process. */
export function acquireSessionLease(id: string): SessionLease {
  const path = sessionPath(id);
  if (!path) throw new Error(`Invalid session '${id}'`);
  mkdirSync(sessionsDir(), { recursive: true });
  const lockPath = `${path}.lock`;
  const token = randomBytes(16).toString("hex");
  const body = JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeSync(fd, body, null, "utf8");
      closeSync(fd);
      fd = undefined;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(readFileSync(lockPath, "utf8"));
            if (current?.token === token) unlinkSync(lockPath);
          } catch { /* a replaced/missing lock is not ours to remove */ }
        },
      };
    } catch (error: any) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const stat = lstatSync(lockPath);
        if (!stat.isFile() || stat.size > 4096) throw new Error("unsafe lock");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        stale = !processIsAlive(Number(lock?.pid));
      } catch {
        throw new Error(`Session '${id}' is already active or has an unsafe lock`);
      }
      if (!stale) throw new Error(`Session '${id}' already has an active writer`);
      try { unlinkSync(lockPath); } catch (unlinkError: any) {
        if (unlinkError?.code !== "ENOENT") throw new Error(`Session '${id}' lock could not be recovered`);
      }
    }
  }
  throw new Error(`Session '${id}' already has an active writer`);
}

const INDEX_FILE = () => join(sessionsDir(), ".index.json");

function metaOf(session: Session, mtime: number, fsize: number): SessionMeta {
  const firstUser = session.messages?.find((m) => m.role === "user");
  const titleText = firstUser
    ? terminalSafeText(String(firstUser.content).replace(/\s+/g, " "), { maxChars: 60 })
    : "(no messages)";
  return {
    id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt, cwd: session.cwd,
    model: session.model, branch: session.branch, bytes: session.bytes, title: session.title,
    provider: session.provider, profile: session.profile, mode: session.mode,
    reasoningEffort: session.reasoningEffort, revision: session.revision, turnState: session.turnState,
    hostProfile: session.hostProfile,
    msgCount: session.messages?.length ?? 0, titleText, mtime, fsize,
  };
}

function validMeta(value: any, expectedId: string): value is SessionMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // SAFETY: wire/config payload shape; keys are produced by the boundary that owns this data.
  const meta = value as any;
  return meta.id === expectedId
    && isValidSessionId(expectedId)
    && validMetadataText(meta.createdAt, MAX_SESSION_TIME_BYTES)
    && validMetadataText(meta.updatedAt, MAX_SESSION_TIME_BYTES)
    && validMetadataText(meta.cwd, MAX_SESSION_CWD_BYTES)
    && validMetadataText(meta.model, MAX_SESSION_MODEL_BYTES)
    && validMetadataText(meta.titleText, MAX_SESSION_TITLE_BYTES)
    && typeof meta.msgCount === "number" && Number.isFinite(meta.msgCount) && meta.msgCount >= 0
    && typeof meta.mtime === "number" && Number.isFinite(meta.mtime)
    && (meta.fsize === undefined || (typeof meta.fsize === "number" && Number.isFinite(meta.fsize)))
    && (meta.title === undefined || validMetadataText(meta.title, MAX_SESSION_TITLE_BYTES))
    && (meta.branch === undefined || validMetadataText(meta.branch, MAX_SESSION_BRANCH_BYTES))
    && (meta.bytes === undefined || (typeof meta.bytes === "number" && Number.isFinite(meta.bytes)))
    && (meta.provider === undefined || validMetadataText(meta.provider, MAX_SESSION_PROVIDER_BYTES))
    && (meta.profile === undefined || meta.profile === null || validMetadataText(meta.profile, MAX_SESSION_PROFILE_BYTES))
    && (meta.mode === undefined || new Set(["default", "accept-edits", "plan", "auto"]).has(String(meta.mode)))
    && (meta.reasoningEffort === undefined || validMetadataText(meta.reasoningEffort, MAX_SESSION_EFFORT_BYTES))
    && (meta.revision === undefined || (Number.isSafeInteger(meta.revision) && Number(meta.revision) >= 0))
    && (meta.turnState === undefined || validTurnState(meta.turnState))
    && (meta.hostProfile === undefined || validStoredHostProfile(meta.hostProfile));
}

/** Session metadata for the list/picker WITHOUT parsing every full transcript. Backed by a persistent
 * index (`.index.json`) validated by file mtime: `stat` each file (cheap), reuse the cached meta when
 * the mtime matches, and re-parse ONLY files that changed. First run builds the index once; after that a
 * 2860-session store lists in ~50ms of stat calls instead of ~600ms of JSON parsing (measured). The index
 * is a cache - mtime is the source of truth - so a stale/clobbered index self-heals on the next call. */
export function listSessionMetas(): SessionMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  let index: Record<string, SessionMeta> = {};
  try {
    const raw = JSON.parse(readFileSync(INDEX_FILE(), "utf-8"));
    if (raw?.v === 1 && raw.metas) index = raw.metas;
  } catch { /* missing/corrupt -> rebuild */ }

  const out: SessionMeta[] = [];
  const next: Record<string, SessionMeta> = {};
  let dirty = false;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === ".index.json") continue;
    const id = file.slice(0, -5);
    if (!isValidSessionId(id)) continue;
    const path = join(dir, file);
    let mtime = 0, fsize = 0;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_SESSION_BYTES) continue;
      mtime = st.mtimeMs; fsize = st.size;
    } catch { continue; }
    const cached = index[id];
    if (validMeta(cached, id) && cached.mtime === mtime && (cached.fsize === fsize || cached.fsize === undefined)) {
      // fsize undefined = a legacy (pre-fsize) index entry. mtime matching was the OLD freshness key, so
      // it is exactly as trustworthy as it ever was - MIGRATE by stamping the size instead of re-parsing.
      // Without this, the first /resume after upgrading re-parsed EVERY session (thousands of real files,
      // a seconds-long one-time picker stall - the "resume lag"). fsize still guards same-ms rewrites
      // for every entry written from now on.
      const m = cached.fsize === undefined ? { ...cached, fsize } : cached;
      if (m !== cached) dirty = true;
      next[id] = m; out.push(m); continue;
    }
    // New or changed file -> parse it once and (re)build its meta.
    try {
      const s = readSessionPath(path, id) ?? loadSession(id);
      if (!s) continue;
      const m = metaOf(s, mtime, fsize);
      next[id] = m; out.push(m); dirty = true;
    } catch { /* skip corrupt */ }
  }
  if (dirty || Object.keys(index).length !== out.length) {
    try { atomicWriteFileSync(INDEX_FILE(), JSON.stringify({ v: 1, metas: next })); } catch { /* cache write is best-effort */ }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** Full session list (parses every transcript). Prefer listSessionMetas for the picker; this stays for
 * the rare caller that genuinely needs full messages. */
export function listSessions(): Session[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: Session[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === ".index.json") continue;
    const id = file.slice(0, -5);
    const session = loadSession(id);
    if (session) out.push(session);
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function latestSession(cwd: string): Session | null {
  const meta = listSessionMetas().find((s) => s.cwd === cwd);
  return meta ? loadSession(meta.id) : null;
}

export function sessionTitle(session: Session | SessionMeta): string {
  if (session.title) return terminalSafeText(session.title, { maxChars: MAX_SESSION_TITLE_DISPLAY_CHARS });
  if ("titleText" in session) return terminalSafeText(session.titleText, { maxChars: MAX_SESSION_TITLE_DISPLAY_CHARS }); // SessionMeta (precomputed)
  const firstUser = session.messages.find((m) => m.role === "user");
  return firstUser
    ? terminalSafeText(String(firstUser.content).replace(/\s+/g, " "), { maxChars: 60 })
    : "(no messages)";
}

/** Rebuild the task tracker from the last durable todo_write call. The registry itself is ephemeral,
 * so every host (TUI, ACP, or future GUI) must hydrate this model-visible state on resume. */
export function recoverSessionTodos(messages: any[]): { content: string; status: string }[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const call of messages[i]?.tool_calls ?? []) {
      if (call?.function?.name !== "todo_write") continue;
      try {
        const args = isText(call.function.arguments)
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
        if (Array.isArray(args?.todos)) {
          return args.todos.map((todo: any) => ({
            content: String(todo?.content ?? ""),
            status: String(todo?.status ?? "pending"),
          }));
        }
      } catch { /* keep scanning for an earlier valid task tracker */ }
    }
  }
  return [];
}

/** Rename a session (sets a title override); preserves updatedAt so it doesn't jump the list. */
export function renameSession(id: string, title: string): void {
  const path = sessionPath(id);
  if (!path || !existsSync(path)) return;
  const s = loadSession(id);
  if (!s) return;
  const normalized = title.trim();
  if (normalized && !validMetadataText(normalized, MAX_SESSION_TITLE_BYTES)) {
    throw new Error("Invalid session title");
  }
  const renamed: Session = { ...s, title: normalized || undefined };
  if (!parseSession(renamed, id)) throw new Error("Invalid session title");
  atomicWriteFileSync(path, serializeSession(renamed));
}

export function renderSessions(): string {
  const list = listSessionMetas();
  if (!list.length) {
    return "No saved sessions. Start one with `neko chat`; resume the latest with `neko chat --resume`.";
  }
  return [
    "Neko Core sessions (newest first):",
    ...list.slice(0, 20).map((s) =>
      `- ${s.id}  ${terminalSafeText(s.cwd, { maxChars: 512 })}\n    "${sessionTitle(s)}"`),
  ].join("\n");
}
