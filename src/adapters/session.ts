/**
 * Conversation persistence. Sessions are JSON files under ~/.neko-core/sessions/ (in HOME,
 * never committed), keyed by an id and tagged with the project cwd. `neko chat` saves after
 * each turn; `neko chat --resume` reloads the latest session for the current directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), "utf-8");
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

export function listSessions(): Session[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: Session[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as Session);
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function latestSession(cwd: string): Session | null {
  const all = listSessions();
  return all.find((s) => s.cwd === cwd) ?? null;
}

export function sessionTitle(session: Session): string {
  if (session.title) return session.title;
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
  writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
}

export function renderSessions(): string {
  const list = listSessions();
  if (!list.length) {
    return "No saved sessions. Start one with `neko chat`; resume the latest with `neko chat --resume`.";
  }
  return [
    "Neko Code sessions (newest first):",
    ...list.slice(0, 20).map((s) => `- ${s.id}  ${s.cwd}\n    "${sessionTitle(s)}"`),
  ].join("\n");
}
