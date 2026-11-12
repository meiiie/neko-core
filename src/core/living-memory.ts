/**
 * Living memory: a heuristic episode journal between raw sessions and the tiny core profiles.
 * Sessions stay the source of truth; this store never duplicates a transcript. Each episode is a
 * bounded markdown digest (first intent, last outcome, tools, cwd, time) written after a session
 * persists, so the next chat can wake up already knowing the last work in this folder without
 * re-briefing and without loading session JSON into context.
 *
 * File-based, no vector DB, no model call on the write path. Search is NFD keyword scoring —
 * the same philosophy as memory.ts. Pure + node-only (stays core).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";
import { isJsonObject, isText, type JsonObject } from "../shared/wire.ts";

const SCHEMA = "neko.journal/v1";
const DIR_NAME = "journal";
const DISABLED_FILE = ".disabled";
const MAX_FILES = 200;
const MAX_QUOTE_CHARS = 280;
const MAX_BODY_CHARS = 2400;
const MIN_MESSAGES = 4;
const THROTTLE_MS = 15_000;
const WAKE_EPISODES = 4;
const WAKE_MAX_CHARS = 900;

export interface JournalableSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model?: string;
  messages: unknown[];
}

export interface Episode {
  file: string;
  sessionId: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  model: string;
  turns: number;
  tools: string[];
  firstUser: string;
  lastOutcome: string;
}

interface Draft {
  sessionId: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  model: string;
  turns: number;
  tools: string[];
  firstUser: string;
  lastOutcome: string;
}

const lastWrite = new Map<string, { at: number; messages: number }>();

function journalDir(home: string = homeDir()): string {
  return join(home, ".neko-core", "memory", DIR_NAME);
}

export function livingEnabled(home: string = homeDir()): boolean {
  if (process.env.NEKO_LIVING_MEMORY === "off") return false;
  return !existsSync(join(journalDir(home), DISABLED_FILE));
}

export function setLivingEnabled(enabled: boolean, home: string = homeDir()): string {
  const dir = journalDir(home);
  mkdirSync(dir, { recursive: true });
  const flag = join(dir, DISABLED_FILE);
  if (enabled) {
    if (existsSync(flag)) rmSync(flag);
    return "Living memory on. Sessions will leave a bounded episode journal.";
  }
  writeFileSync(flag, "off\n", "utf-8");
  return "Living memory off. Existing journal files are kept, not deleted.";
}

interface JournalMessage {
  role?: any;
  content?: any;
  _neko_internal?: any;
  tool_calls?: any;
}

interface UserSpan {
  first: string;
  last: string;
  count: number;
}

interface Frontmatter {
  schema?: string;
  sessionId?: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  model?: string;
  turns?: string;
  tools?: string;
}

interface BackfillReport {
  written: number;
  skipped: number;
}

function asMessage(raw: any): JournalMessage | null {
  if (!isJsonObject(raw)) return null;
  // SAFETY: isJsonObject proved an object; JournalMessage only reads role/content/_neko_internal/tool_calls.
  return raw as JournalMessage;
}

function partText(content: any): string {
  if (isText(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (isText(part)) return part;
      if (!isJsonObject(part)) return "";
      if (part.type === "text" && isText(part.text)) return part.text;
      return "";
    })
    .join(" ");
}

const GREETING = /^(xin\s?chao|xin\s?chào|chào|chao|hello|hi|yo|hey|alooo?|alo|hí|yo bro)\b/i;

function visibleUserText(messages: unknown[]): UserSpan {
  let first = "";
  let firstReal = "";
  let last = "";
  let count = 0;
  for (const raw of messages) {
    const m = asMessage(raw);
    if (!m || m.role !== "user" || m._neko_internal === true) continue;
    const text = partText(m.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.startsWith("[Summary of earlier conversation]")) continue;
    count += 1;
    if (!first) first = text;
    if (!firstReal && !GREETING.test(text)) firstReal = text;
    last = text;
  }
  // A greeting is a bad index. Prefer the first substantive ask so "Yo bro" does not become the memory.
  return { first: firstReal || first, last, count } satisfies UserSpan;
}

function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asMessage(messages[i]);
    if (!m || m.role !== "assistant") continue;
    const text = partText(m.content).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

function toolNames(messages: unknown[]): string[] {
  const seen = new Set<string>();
  for (const raw of messages) {
    const m = asMessage(raw);
    if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      if (!isJsonObject(call)) continue;
      const fn = isJsonObject(call.function) ? call.function : null;
      const name = fn?.name ?? call.name;
      if (isText(name) && name) seen.add(name);
    }
  }
  return [...seen].slice(0, 12);
}

function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,})/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)(\S+)/gi, "$1[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1).trimEnd()}…`;
}

function draftOf(session: JournalableSession): Draft | null {
  const id = String(session.id ?? "");
  if (!id) return null;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (messages.length < MIN_MESSAGES) return null;
  const user = visibleUserText(messages);
  if (!user.first || user.count < 1) return null;
  const firstTrim = user.first.trim();
  // Skip benchmark/binary noise: "0:xxxx…", long hex, or one-character prompts.
  if (firstTrim.length < 4) return null;
  if (/^[0-9a-f:]{12,}$/i.test(firstTrim)) return null;
  if (/^0:[0-9a-f]/i.test(firstTrim)) return null;
  // A handful of greetings is not an episode. Real work after "Yo bro" still journals,
  // indexed by the first substantive ask (visibleUserText already prefers that).
  if (user.count < 3 && GREETING.test(firstTrim)) return null;
  const cwd = String(session.cwd ?? "").trim();
  if (!cwd) return null;
  const startedAt = String(session.createdAt ?? session.updatedAt ?? "");
  const endedAt = String(session.updatedAt ?? session.createdAt ?? "");
  if (!startedAt || !endedAt) return null;
  const assistant = lastAssistantText(messages);
  const lastOutcome = assistant || user.last;
  if (!lastOutcome) return null;
  return {
    sessionId: id,
    cwd,
    startedAt,
    endedAt,
    model: clip(String(session.model ?? ""), 80),
    turns: user.count,
    tools: toolNames(messages),
    firstUser: clip(redact(user.first), MAX_QUOTE_CHARS),
    lastOutcome: clip(redact(lastOutcome), MAX_QUOTE_CHARS),
  };
}

function serialize(draft: Draft): string {
  const tools = draft.tools.length ? draft.tools.join(", ") : "-";
  const body = [
    "---",
    `schema: ${SCHEMA}`,
    `sessionId: ${draft.sessionId}`,
    `cwd: ${draft.cwd}`,
    `startedAt: ${draft.startedAt}`,
    `endedAt: ${draft.endedAt}`,
    `model: ${draft.model}`,
    `turns: ${draft.turns}`,
    `tools: ${tools}`,
    "---",
    "",
    `First ask: "${draft.firstUser}"`,
    `Last outcome: "${draft.lastOutcome}"`,
    "",
  ].join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 1)}…\n` : body;
}

function parseFrontmatter(text: string): Frontmatter {
  const out: Frontmatter = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const keys = new Set(["schema", "sessionId", "cwd", "startedAt", "endedAt", "model", "turns", "tools"]);
  for (const line of text.slice(4, end).split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!keys.has(key)) continue;
    // SAFETY: keys.has proved the key is a Frontmatter field.
    out[key as keyof Frontmatter] = line.slice(i + 1).trim();
  }
  return out;
}

function episodeFrom(file: string, text: string): Episode | null {
  const fm = parseFrontmatter(text);
  const sessionId = fm.sessionId ?? file.replace(/\.md$/, "");
  if (!sessionId) return null;
  const body = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 5) : text;
  const first = /First ask:\s*"([\s\S]*?)"/.exec(body)?.[1] ?? "";
  const last = /Last outcome:\s*"([\s\S]*?)"/.exec(body)?.[1] ?? "";
  return {
    file,
    sessionId,
    cwd: fm.cwd ?? "",
    startedAt: fm.startedAt ?? "",
    endedAt: fm.endedAt ?? fm.startedAt ?? "",
    model: fm.model ?? "",
    turns: Number(fm.turns) || 0,
    tools: (fm.tools ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== "-"),
    firstUser: first,
    lastOutcome: last,
  };
}

export function listEpisodes(home: string): Episode[] {
  const dir = journalDir(home);
  if (!existsSync(dir)) return [];
  const out: Episode[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file.startsWith(".")) continue;
    try {
      const text = readFileSync(join(dir, file), "utf-8");
      const ep = episodeFrom(file, text);
      if (ep) out.push(ep);
    } catch {
      // A torn journal file is skipped, never fatal for recall.
    }
  }
  out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : a.file.localeCompare(b.file)));
  return out;
}

function prune(home: string, dir: string): void {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (files.length <= MAX_FILES) return;
  const dated = files
    .map((f) => {
      try {
        return { f, t: statSync(join(dir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a!.t - b!.t);
  for (const entry of dated.slice(0, dated.length - MAX_FILES)) rmSync(join(dir, entry!.f), { force: true });
}

/** Write/overwrite the episode for one session. Cheap enough to call from the save path. */
export function journalSession(session: JournalableSession, home: string = homeDir()): string {
  if (!livingEnabled(home)) return "";
  const draft = draftOf(session);
  if (!draft) return "";
  const key = `${home}:${draft.sessionId}`;
  const messages = Array.isArray(session.messages) ? session.messages.length : 0;
  const prior = lastWrite.get(key);
  const now = Date.now();
  if (prior && now - prior.at < THROTTLE_MS && prior.messages === messages) return "";
  const dir = journalDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${draft.sessionId}.md`);
  writeFileSync(file, serialize(draft), "utf-8");
  lastWrite.set(key, { at: now, messages });
  prune(home, dir);
  return file;
}

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "?";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function cwdTail(cwd: string): string {
  const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:$/.test(norm)) return norm;
  const parts = norm.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function episodeLine(ep: Episode): string {
  const when = fmtWhen(ep.endedAt);
  const where = cwdTail(ep.cwd);
  const what = clip(ep.firstUser || ep.lastOutcome, 90);
  const got = ep.lastOutcome && ep.lastOutcome !== ep.firstUser ? ` → ${clip(ep.lastOutcome, 70)}` : "";
  return `- ${when} · ${where} · "${what}"${got}`;
}

/** Human/TUI recap of recent episodes, optionally excluding the session being resumed. */
export function wakeRecap(home: string = homeDir(), cwd: string = process.cwd(), opts?: { excludeSessionId?: string }): string {
  if (!livingEnabled(home)) return "";
  const cwdKey = cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const all = listEpisodes(home).filter((ep) => ep.sessionId !== opts?.excludeSessionId);
  if (!all.length) return "";
  const same = all.filter((ep) => ep.cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === cwdKey);
  const other = all.filter((ep) => !same.includes(ep));
  const picked = [...same.slice(0, WAKE_EPISODES), ...other.slice(0, 1)];
  if (!picked.length) return "";
  const lines = picked.map(episodeLine);
  const text = ["Recent episodes:", ...lines].join("\n");
  return text.length > WAKE_MAX_CHARS ? `${text.slice(0, WAKE_MAX_CHARS - 1)}…` : text;
}

/** Compact model-facing pointer. Deliberately tiny — Anthropic context engineering: smallest set of
 * high-signal tokens. Episodes stay on disk; the model pulls them just-in-time via memory journal.
 * Pre-loading four digests every turn is how attention budget dies (context rot, lost-in-the-middle). */
export function livingWakeBlock(home: string = homeDir(), cwd: string = process.cwd(), opts?: { excludeSessionId?: string }): string {
  if (!livingEnabled(home)) return "";
  const cwdKey = cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const all = listEpisodes(home).filter((ep) => ep.sessionId !== opts?.excludeSessionId);
  if (!all.length) return "";
  const same = all.filter((ep) => ep.cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === cwdKey);
  const latest = same[0] ?? all[0];
  const when = fmtWhen(latest.endedAt);
  const what = clip(latest.firstUser || latest.lastOutcome, 90);
  const where = same.length ? "this folder" : cwdTail(latest.cwd);
  const n = all.length;
  const hint = same.length
    ? `Last work here: ${when} — "${what}".`
    : `Last work elsewhere (${where}): ${when} — "${what}".`;
  const text = `${hint} Living journal has ${n} episodes; recall with memory action=journal or journal_search when the user references past work. Heuristic — verify before relying.`;
  return text.length > 320 ? `${text.slice(0, 319)}…` : text;
}

function normalizedTerms(query: string): string[] {
  const nfd = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return nfd.split(/\s+/).filter(Boolean);
}

/** Keyword search over journal bodies. Same scoring family as memory.ts (no embeddings). */
export function searchJournal(query: string, home: string = homeDir(), limit = 10): Episode[] {
  const terms = normalizedTerms(query);
  if (!terms.length) return listEpisodes(home).slice(0, limit);
  const dir = journalDir(home);
  if (!existsSync(dir)) return [];
  const scored: { ep: Episode; score: number }[] = [];
  for (const ep of listEpisodes(home)) {
    try {
      const raw = readFileSync(join(dir, ep.file), "utf-8");
      const nfd = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (nfd.includes(term)) score += 1;
        if (ep.file.toLowerCase().includes(term)) score += 2;
      }
      if (score > 0) scored.push({ ep, score });
    } catch {
      // skip torn file
    }
  }
  return scored.sort((a, b) => b.score - a.score || (a.ep.endedAt < b.ep.endedAt ? 1 : -1)).slice(0, limit).map((x) => x.ep);
}

export function readJournal(file: string, home: string = homeDir()): string {
  const safe = file.replace(/[/\\]/g, "_");
  const path = join(journalDir(home), safe.endsWith(".md") ? safe : `${safe}.md`);
  if (!existsSync(path)) return `(no journal '${safe}')`;
  return readFileSync(path, "utf-8");
}

/** One-shot backfill from already-saved sessions, newest first. Never rewrites a fresher journal. */
export function backfillJournals(load: (id: string) => JournalableSession | null, ids: string[], home: string = homeDir(), limit = 80): BackfillReport {
  let written = 0;
  let skipped = 0;
  const dir = journalDir(home);
  mkdirSync(dir, { recursive: true });
  for (const id of ids.slice(0, limit)) {
    const target = join(dir, `${id}.md`);
    if (existsSync(target)) {
      skipped += 1;
      continue;
    }
    let session: JournalableSession | null = null;
    try {
      session = load(id);
    } catch {
      session = null;
    }
    if (!session) {
      skipped += 1;
      continue;
    }
    const key = `${home}:${id}`;
    const before = lastWrite.get(key);
    lastWrite.delete(key);
    const file = journalSession(session, home);
    if (file) written += 1;
    else skipped += 1;
    if (before) lastWrite.set(key, before);
  }
  return { written, skipped } satisfies BackfillReport;
}

/** Surface for the `memory` tool so the model can recall without a new tool slot. */
export function journalTool(args: any, home: string = homeDir()): string {
  if (!livingEnabled(home)) return "Living memory is off. /ngu on to re-enable.";
  const action = String(args?.action ?? "").toLowerCase();
  const query = String(args?.query ?? args?.name ?? "").trim();
  if (action === "journal_read" || (action === "journal" && query && !query.includes(" "))) {
    return readJournal(query, home);
  }
  if (action === "journal_search" || (action === "journal" && query)) {
    const hits = searchJournal(query, home, 8);
    return hits.length ? hits.map(episodeLine).join("\n") : "(no matching episodes)";
  }
  const eps = listEpisodes(home).slice(0, 8);
  if (!eps.length) return "(no episodes yet — /ngu writes one from this session; they also accumulate on save)";
  return ["Recent episodes:", ...eps.map(episodeLine)].join("\n");
}
