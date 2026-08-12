/**
 * Conversation persistence. Sessions are JSON files under ~/.neko-core/sessions/ (in HOME,
 * never committed), keyed by an id and tagged with the project cwd. `neko chat` saves after
 * each turn; `neko chat --resume` reloads the latest session for the current directory.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { hasTerminalControl, terminalSafeText } from "../shared/terminal-text.ts";
import { trustedGitOutput } from "./trusted-git.ts";
import { homeDir } from "../shared/home.ts";
import { dirname, join, resolve } from "node:path";

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  messages: any[];
  branch?: string; // git branch at last save
  bytes?: number; // approx content size (messages JSON length)
  title?: string; // user-set name (overrides the first-message title)
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
  return path && existsSync(path) ? readSessionPath(path, id) : null;
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
    && (meta.bytes === undefined || (typeof meta.bytes === "number" && Number.isFinite(meta.bytes)));
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
      const s = readSessionPath(path, id);
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
