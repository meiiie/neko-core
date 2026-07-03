/**
 * Conversation persistence. Sessions are JSON files under ~/.neko-core/sessions/ (in HOME,
 * never committed), keyed by an id and tagged with the project cwd. `neko chat` saves after
 * each turn; `neko chat --resume` reloads the latest session for the current directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

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
  mtime: number; // file mtimeMs at index time - the freshness key
}

function sessionsDir(): string {
  return join(homeDir(), ".neko-core", "sessions");
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
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf-8", timeout: 2000 });
    branch = r.status === 0 ? r.stdout.trim() : "";
  } catch {
    branch = "";
  }
  branchCache.set(cwd, branch);
  return branch;
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function saveSession(session: Session): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  session.branch = currentBranch(session.cwd);
  session.bytes = JSON.stringify(session.messages).length;
  // Atomic: a kill/crash mid-write must never truncate the transcript (loadSession would then drop the whole
  // conversation as unparseable). temp + rename = the file is always the old or the new session, never half.
  atomicWriteFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export function loadSession(id: string): Session | null {
  const path = join(sessionsDir(), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Session;
  } catch {
    return null;
  }
}

const INDEX_FILE = () => join(sessionsDir(), ".index.json");

function metaOf(session: Session, mtime: number): SessionMeta {
  const firstUser = session.messages?.find((m) => m.role === "user");
  const titleText = firstUser ? String(firstUser.content).replace(/\s+/g, " ").slice(0, 60) : "(no messages)";
  return {
    id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt, cwd: session.cwd,
    model: session.model, branch: session.branch, bytes: session.bytes, title: session.title,
    msgCount: session.messages?.length ?? 0, titleText, mtime,
  };
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
    const path = join(dir, file);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    const cached = index[id];
    if (cached && cached.mtime === mtime) { next[id] = cached; out.push(cached); continue; }
    // New or changed file -> parse it once and (re)build its meta.
    try {
      const s = JSON.parse(readFileSync(path, "utf-8")) as Session;
      const m = metaOf(s, mtime);
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
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as Session);
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function latestSession(cwd: string): Session | null {
  const meta = listSessionMetas().find((s) => s.cwd === cwd);
  return meta ? loadSession(meta.id) : null;
}

/** True when a session was left MID-TURN (interrupted before a final answer): it doesn't end with a
 * plain assistant TEXT message. A completed turn ends with the assistant's answer; an interrupted one
 * ends on a user message, a tool result, or an assistant that's still calling tools. Used to decide
 * whether a bare `neko` should auto-resume so you pick up exactly where you left off (no flag). */
export function wasInterrupted(session: Session): boolean {
  const msgs = session.messages.filter((m) => m.role !== "system");
  const last = msgs[msgs.length - 1];
  if (!last) return false;
  if (last.role !== "assistant") return true; // ends on a user/tool turn -> mid-work
  const text = typeof last.content === "string" ? last.content.trim()
    : Array.isArray(last.content) ? last.content.map((p: any) => p?.text ?? "").join("").trim() : "";
  const hasToolCalls = Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
  return !text || hasToolCalls; // no final text, or still mid-tool-call -> interrupted
}

export function sessionTitle(session: Session | SessionMeta): string {
  if (session.title) return session.title;
  if ("titleText" in session) return session.titleText; // SessionMeta (precomputed)
  const firstUser = session.messages.find((m) => m.role === "user");
  return firstUser ? String(firstUser.content).replace(/\s+/g, " ").slice(0, 60) : "(no messages)";
}

/** Rename a session (sets a title override); preserves updatedAt so it doesn't jump the list. */
export function renameSession(id: string, title: string): void {
  const path = join(sessionsDir(), `${id}.json`);
  if (!existsSync(path)) return;
  const s = loadSession(id);
  if (!s) return;
  s.title = title.trim() || undefined;
  atomicWriteFileSync(path, JSON.stringify(s, null, 2));
}

export function renderSessions(): string {
  const list = listSessionMetas();
  if (!list.length) {
    return "No saved sessions. Start one with `neko chat`; resume the latest with `neko chat --resume`.";
  }
  return [
    "Neko Code sessions (newest first):",
    ...list.slice(0, 20).map((s) => `- ${s.id}  ${s.cwd}\n    "${sessionTitle(s)}"`),
  ].join("\n");
}
