/**
 * Conversation persistence. Sessions are JSON files under ~/.neko-core/sessions/ (in HOME,
 * never committed), keyed by an id and tagged with the project cwd. `neko chat` saves after
 * each turn; `neko chat --resume` reloads the latest session for the current directory.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { hasTerminalControl, terminalSafeText } from "../shared/terminal-text.ts";
import { trustedGitOutput } from "./trusted-git.ts";
import { homeDir } from "../shared/home.ts";
import { dirname, join, resolve } from "node:path";

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

function validMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (!new Set(["system", "user", "assistant", "tool"]).has(String(message.role ?? ""))) return false;
  if (message._neko_internal !== undefined && typeof message._neko_internal !== "boolean") return false;
  return typeof message.content === "string" || message.content === null || Array.isArray(message.content);
}

function validMetadataText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !hasTerminalControl(value);
}

function validTurnState(value: unknown): value is SessionTurnState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!new Set(["idle", "running", "interrupted"]).has(String(state.status ?? ""))) return false;
  if (state.startedAt !== undefined && !validMetadataText(state.startedAt, MAX_SESSION_TIME_BYTES)) return false;
  if (state.recoveredAt !== undefined && !validMetadataText(state.recoveredAt, MAX_SESSION_TIME_BYTES)) return false;
  if (state.lastStopReason !== undefined && !validMetadataText(state.lastStopReason, MAX_SESSION_TITLE_BYTES)) return false;
  return state.activeToolCallIds === undefined || (Array.isArray(state.activeToolCallIds)
    && state.activeToolCallIds.length <= 256
    && state.activeToolCallIds.every((id) => validMetadataText(id, MAX_SESSION_TITLE_BYTES)));
}

function validUsage(value: unknown): value is SessionUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  const keys = ["promptTokens", "completionTokens", "totalTokens", "cachedTokens", "cacheWriteTokens",
    "calls", "lastPrompt", "lastCompletion", "lastCached", "lastCacheWrite"];
  return keys.every((key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0);
}

function parseSession(value: unknown, expectedId: string): Session | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session = value as Record<string, unknown>;
  if (session.id !== expectedId || !isValidSessionId(expectedId)) return null;
  if (!validMetadataText(session.createdAt, MAX_SESSION_TIME_BYTES)
    || !validMetadataText(session.updatedAt, MAX_SESSION_TIME_BYTES)
    || !validMetadataText(session.cwd, MAX_SESSION_CWD_BYTES)
    || !validMetadataText(session.model, MAX_SESSION_MODEL_BYTES)) return null;
  if (!Array.isArray(session.messages) || !session.messages.every(validMessage)) return null;
  if (session.title !== undefined && !validMetadataText(session.title, MAX_SESSION_TITLE_BYTES)) return null;
  if (session.branch !== undefined && !validMetadataText(session.branch, MAX_SESSION_BRANCH_BYTES)) return null;
  if (session.bytes !== undefined && (typeof session.bytes !== "number" || !Number.isFinite(session.bytes))) return null;
  if (session.schemaVersion !== undefined && session.schemaVersion !== 2) return null;
  if (session.provider !== undefined && !validMetadataText(session.provider, MAX_SESSION_PROVIDER_BYTES)) return null;
  if (session.profile !== undefined && session.profile !== null && !validMetadataText(session.profile, MAX_SESSION_PROFILE_BYTES)) return null;
  if (session.mode !== undefined && !new Set(["default", "accept-edits", "plan", "auto"]).has(String(session.mode))) return null;
  if (session.reasoningEffort !== undefined && !validMetadataText(session.reasoningEffort, MAX_SESSION_EFFORT_BYTES)) return null;
  if (session.revision !== undefined && (!Number.isSafeInteger(session.revision) || Number(session.revision) < 0)) return null;
  if (session.turnState !== undefined && !validTurnState(session.turnState)) return null;
  if (session.usage !== undefined && !validUsage(session.usage)) return null;
  if (session.contextFingerprint !== undefined && !validMetadataText(session.contextFingerprint, MAX_SESSION_FINGERPRINT_BYTES)) return null;
  return session as unknown as Session;
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
function currentBranch(cwd: string): string {
  const cached = branchCache.get(cwd);
  if (cached !== undefined) return cached;
  let branch = "";
  branch = trustedGitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  branchCache.set(cwd, branch);
  return branch;
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
    msgCount: session.messages?.length ?? 0, titleText, mtime, fsize,
  };
}

function validMeta(value: unknown, expectedId: string): value is SessionMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
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
    && (meta.turnState === undefined || validTurnState(meta.turnState));
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
        const args = typeof call.function.arguments === "string"
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
