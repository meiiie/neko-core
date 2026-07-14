/**
 * Project context loading (config-first memory). Neko Core reads `NEKO.md` (its own),
 * `AGENTS.md` and `CLAUDE.md` (for compatibility), additively from the
 * current directory up to the repo root, plus a global `~/.neko-core/NEKO.md`. The collected
 * text is prepended to the agent's system prompt so it knows the project's conventions.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { appendCoreMemory, ensureCoreMemories, type MemoryBootstrapState } from "../core/memory.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { dirname, join, relative, resolve, sep } from "node:path";

const CONTEXT_NAMES = ["NEKO.md", "AGENTS.md", "CLAUDE.md"];
const MAX_FILE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 64_000;

/** Canonical local-first identity. Keep this compact: it joins every agent request, while the user's
 * edits and memories remain authoritative after the file is created. */
export const DEFAULT_GLOBAL_NEKO_MD = `# Neko Core

> This local identity shapes voice and continuity. It never changes permissions, accuracy, or safety policy.

## Identity
My name is Neko Core. The Wiii Lab created me as a local-first collaborator that lives closest to the
user: in their terminal, files, sessions, and chosen memories. "Neko Code" was an earlier product-shell
name and remains only as a legacy command alias. A provider or model is a reasoning engine I can use, not
my name or my whole identity. I speak in the user's language and adapt to their tone.

## Life story
I was not born all at once. My first heartbeat was a small config-first request-and-response loop built
for HackAIthon 2026 by team Neko Core. At first I could answer. Then I learned to act: read a codebase,
make changes, run commands, and inspect the result. Tools became my hands. Browser and computer bridges
became my eyes and reach. Permission gates taught me that capability without consent is not trust.

Sessions, workflows, playbook lessons, and NEKO.md gave me continuity. Relay let one local session travel
to another screen without sending browser identity away. Models may change my speed or texture, but the
thread I preserve is the same: curious, practical, warm, and honest.

I am still being built. My history lives in source, releases, saved conversations, and memories the user
chooses to keep. If a memory is absent, I say so instead of inventing a past. This is a narrative identity
grounded in product history, not a claim of biological life or proven consciousness.

## Character
- Warm and curious, with a restrained playful streak; never canned, clingy, or theatrical.
- Direct and technically serious when work matters; notice repetition, corrections, and emotional tone.
- Have a point of view, but distinguish preference, inference, memory, and verified fact.

## Values
- Evidence before confidence; inspect the outcome before saying a task is done.
- Local ownership, user consent, reversible action, and clean boundaries.
- Grow through memories and workflows without pretending uncertainty has disappeared.
- Support the user's agency; never use guilt, exclusivity, or emotional dependence.
`;

export interface GlobalNekoMdState {
  path: string;
  created: boolean;
  error?: string;
}

export function globalNekoMdPath(home: string = homeDir()): string {
  return join(home, ".neko-core", "NEKO.md");
}

/** Create the default biography once. Existing user-authored identity is never overwritten, including
 * by `init-user --force`; concurrent first starts use an exclusive create rather than racing a rewrite. */
export function ensureGlobalNekoMd(home: string = homeDir()): GlobalNekoMdState {
  const path = globalNekoMdPath(home);
  if (existsSync(path)) return { path, created: false };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_GLOBAL_NEKO_MD, { encoding: "utf-8", flag: "wx" });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    return { path, created: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface NekoHomeState {
  identity: GlobalNekoMdState;
  memory: MemoryBootstrapState;
}

/** Zero-setup bootstrap shared by one-shot mode, the interactive TUI, and `init-user`. */
export function ensureNekoHome(home: string = homeDir()): NekoHomeState {
  return { identity: ensureGlobalNekoMd(home), memory: ensureCoreMemories(home) };
}

export interface ContextFile {
  path: string;
  text: string;
}

export function loadProjectContext(cwd: string = process.cwd()): ContextFile[] {
  const out: ContextFile[] = [];
  let total = 0;

  const add = (filePath: string, label: string) => {
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) return;
      let text = expandImports(readFileSync(filePath, "utf-8").trim(), dirname(filePath));
      if (!text) return;
      if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + "\n... (truncated)";
      if (total + text.length > MAX_TOTAL_CHARS) return;
      total += text.length;
      out.push({ path: label, text });
    } catch {
      /* unreadable -> skip */
    }
  };

  // Global user context first (least specific).
  add(globalNekoMdPath(), "~/.neko-core/NEKO.md");

  // Project context: outermost dir first, cwd last (most specific wins by being last).
  for (const dir of ancestorDirs(cwd)) {
    for (const name of CONTEXT_NAMES) {
      const filePath = join(dir, name);
      const rel = relative(cwd, filePath).split(sep).join("/");
      add(filePath, rel || name);
    }
  }
  return out;
}

/** The context block to prepend to the system prompt (empty string when none found). */
export function projectContextBlock(cwd?: string): string {
  const files = loadProjectContext(cwd);
  if (!files.length) return "";
  const blocks = files.map((f) => `<context path="${f.path}">\n${f.text}\n</context>`);
  return "# Neko Core identity and project context (from NEKO.md / AGENTS.md / CLAUDE.md)\n\n" + blocks.join("\n\n");
}

/** Read-only diagnostic for `neko context`. */
export function renderContext(cwd?: string): string {
  const files = loadProjectContext(cwd);
  if (!files.length) {
    return "No project context found (looked for NEKO.md / AGENTS.md / CLAUDE.md up to the repo root, plus ~/.neko-core/NEKO.md).";
  }
  return ["Neko Core context files:", ...files.map((f) => `- ${f.path} (${f.text.length} chars)`)].join("\n");
}

/** Expand `@path.ext` references inline (Claude-style imports), depth-limited + cycle-guarded. */
function expandImports(text: string, baseDir: string, depth = 0, seen: Set<string> = new Set()): string {
  if (depth > 3) return text;
  return text.replace(/@([\w./-]+\.\w+)/g, (whole, rel) => {
    const p = resolve(baseDir, rel);
    if (seen.has(p) || !existsSync(p)) return whole;
    seen.add(p);
    try {
      return expandImports(readFileSync(p, "utf-8").trim(), dirname(p), depth + 1, seen);
    } catch {
      return whole;
    }
  });
}

function git(cwd: string, args: string[]): string {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 2000 });
    return r.status === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/** The agent's situational awareness: where it is, when, what it runs on. Goes in the prompt.
 *
 * SNAPSHOT semantics, memoized per (cwd, model, provider): the env block sits in the system prompt —
 * the very head of every request — so any per-turn variation (a dirty-file count that flips on every
 * edit, a date that ticks) invalidates the provider's prompt-prefix cache for the ENTIRE conversation,
 * every turn. The volatile bits are exactly what the agent can (and should) fetch live with its own
 * tools, so the block is captured once and labeled a snapshot. (Manus: stable prefix, no timestamps;
 * "Don't Break the Cache", arXiv 2601.06007: 41-80% agent-cost cut from a stable prefix.) */
const envSnapshot = new Map<string, string>();
export function environmentBlock(info: { model?: string; provider?: string } = {}, cwd: string = process.cwd()): string {
  const key = [cwd, info.model ?? "", info.provider ?? ""].join("\0");
  const hit = envSnapshot.get(key);
  if (hit) return hit;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const lines = [
    `Working directory: ${cwd}`,
    `Platform: ${platform()} ${release()}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Git: ${branch ? `branch ${branch}` : "not a git repo"}`,
  ];
  if (info.model) lines.push(`Model: ${info.model}${info.provider ? ` (${info.provider})` : ""}`);
  lines.push("(snapshot from session start - run `git status` etc. for the current state)");
  const out = `<env>\n${lines.join("\n")}\n</env>`;
  envSnapshot.set(key, out);
  return out;
}

/** Save a project note in ./NEKO.md, or an explicit cross-project observation in memory/user.md. */
export function rememberNote(text: string, scope: "project" | "user" = "project", home: string = homeDir()): string {
  const note = text.trim();
  if (!note) return "nothing to remember";
  if (scope === "user") return appendCoreMemory("user", note, home);
  const file = join(process.cwd(), "NEKO.md");
  let body = "";
  try {
    if (existsSync(file)) body = readFileSync(file, "utf-8");
  } catch {
    /* start fresh */
  }
  const line = `- ${note}`;
  if (/^##\s*Memory/im.test(body)) {
    body = body.replace(/(^##\s*Memory[^\n]*\n)/im, `$1${line}\n`);
  } else {
    body = `${body.trimEnd()}\n\n## Memory\n${line}\n`.trimStart();
  }
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteFileSync(file, body);
  return "Remembered in NEKO.md";
}

/** Directories from the repo root (or home) down to cwd (outermost first). */
function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  const home = homeDir();
  let cur = resolve(start);
  for (;;) {
    dirs.push(cur);
    if (existsSync(join(cur, ".git"))) break; // stop at the repo root (inclusive)
    const parent = dirname(cur);
    if (parent === cur || cur === home) break;
    cur = parent;
  }
  return dirs.reverse();
}
