/**
 * Project context loading (config-first memory). Neko Code reads `NEKO.md` (its own) and
 * `CLAUDE.md` (for compatibility with repos that already have one), additively from the
 * current directory up to the repo root, plus a global `~/.neko-core/NEKO.md`. The collected
 * text is prepended to the agent's system prompt so it knows the project's conventions.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
      let text = readFileSync(filePath, "utf-8").trim();
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
  add(join(homedir(), ".neko-core", "NEKO.md"), "~/.neko-core/NEKO.md");

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

/** Directories from the repo root (or home) down to cwd (outermost first). */
function ancestorDirs(start: string): string[] {
  const dirs: string[] = [];
  const home = homedir();
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
