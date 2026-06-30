/**
 * Project context loading (config-first memory). Neko Code reads `NEKO.md` (its own) and
 * `CLAUDE.md` (for compatibility with repos that already have one), additively from the
 * current directory up to the repo root, plus a global `~/.neko-core/NEKO.md`. The collected
 * text is prepended to the agent's system prompt so it knows the project's conventions.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { platform, release } from "node:os";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { dirname, join, relative, resolve, sep } from "node:path";

const CONTEXT_NAMES = ["NEKO.md", "CLAUDE.md"];
const MAX_FILE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 64_000;

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
  add(join(homeDir(), ".neko-core", "NEKO.md"), "~/.neko-core/NEKO.md");

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
  return "# Project context (from NEKO.md / CLAUDE.md)\n\n" + blocks.join("\n\n");
}

/** Read-only diagnostic for `neko context`. */
export function renderContext(cwd?: string): string {
  const files = loadProjectContext(cwd);
  if (!files.length) {
    return "No project context found (looked for NEKO.md / CLAUDE.md up to the repo root, plus ~/.neko-core/NEKO.md).";
  }
  return ["Neko Code context files:", ...files.map((f) => `- ${f.path} (${f.text.length} chars)`)].join("\n");
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

/** The agent's situational awareness: where it is, when, what it runs on. Goes in the prompt. */
export function environmentBlock(info: { model?: string; provider?: string } = {}, cwd: string = process.cwd()): string {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = branch ? git(cwd, ["status", "--porcelain"]).split("\n").filter(Boolean).length : 0;
  const lines = [
    `Working directory: ${cwd}`,
    `Platform: ${platform()} ${release()}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Git: ${branch ? `${branch}${dirty ? ` (${dirty} uncommitted change${dirty > 1 ? "s" : ""})` : " (clean)"}` : "not a git repo"}`,
  ];
  if (info.model) lines.push(`Model: ${info.model}${info.provider ? ` (${info.provider})` : ""}`);
  return `<env>\n${lines.join("\n")}\n</env>`;
}

/** Append a note under a "## Memory" section of NEKO.md (project) or ~/.neko-core/NEKO.md (user). */
export function rememberNote(text: string, scope: "project" | "user" = "project"): string {
  const note = text.trim();
  if (!note) return "nothing to remember";
  const file = scope === "user" ? join(homeDir(), ".neko-core", "NEKO.md") : join(process.cwd(), "NEKO.md");
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
  return `Remembered in ${scope === "user" ? "~/.neko-core/NEKO.md" : "NEKO.md"}`;
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
