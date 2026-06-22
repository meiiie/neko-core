/**
 * Executable coding-agent tools + the approval gate.
 *
 * read_file / search : safe  -> run immediately.
 * write_file / bash  : gated -> require approval unless approval=auto (--yolo).
 *
 * Each tool returns a STRING observation (errors + denials included) so a failed or denied
 * tool never crashes the agent loop. Path-taking tools refuse to escape the project root.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { McpHub } from "./mcp.ts";
import { decide, type PermissionMode } from "./permissions.ts";
import { resolveTool, toolSchemas } from "./tools.ts";

/** An approval gate: given (toolName, human-readable action) -> approve? (may be async) */
export type ApprovalGate = (toolName: string, action: string) => boolean | Promise<boolean>;

const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_LIST = 200;
const MAX_OUTPUT_CHARS = 20_000;
const BASH_TIMEOUT_MS = 60_000;
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "dist", "build", ".mypy_cache", ".pytest_cache", ".ruff_cache",
]);

export const autoApprove: ApprovalGate = () => true;
export const denyAll: ApprovalGate = () => false;

/**
 * Executes tool calls under a permission `mode`. A gated tool's decision comes from the
 * mode: allow (auto), prompt (ask the interactive gate), or deny (e.g. plan mode). `mode`
 * is mutable so a REPL can cycle it (Shift+Tab) at runtime.
 */
export class ToolRegistry {
  mode: PermissionMode;

  constructor(
    public readonly root: string,
    mode: PermissionMode = "default",
    public prompt: ApprovalGate = denyAll,
    public mcp?: McpHub,
  ) {
    this.mode = mode;
  }

  /** All tool schemas shown to the model: built-in + connected MCP tools. */
  schemas(): any[] {
    return [...toolSchemas(), ...(this.mcp?.toolSchemas() ?? [])];
  }

  async execute(name: string, args: Record<string, any>): Promise<string> {
    if (typeof args !== "object" || args === null) {
      return `Error: arguments for ${name} must be an object`;
    }

    // MCP tools: their effects are unknown, so treat them as gated (mode-governed).
    if (this.mcp?.has(name)) {
      const decision = this.mode === "auto" ? "allow" : this.mode === "plan" ? "deny" : "prompt";
      if (decision === "deny") return `Blocked: ${name} (MCP) is not allowed in 'plan' mode.`;
      if (decision === "prompt" && !(await this.prompt(name, `mcp ${name}`))) {
        return `Denied by user: ${name}`;
      }
      try {
        return await this.mcp.call(name, args);
      } catch (error) {
        return `Error: ${(error as Error).message}`;
      }
    }

    let spec;
    try {
      spec = resolveTool(name);
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }

    const decision = decide(this.mode, spec);
    if (decision === "deny") {
      return `Blocked: ${name} is not allowed in '${this.mode}' mode (read-only).`;
    }
    if (decision === "prompt") {
      const action = describe(name, args);
      if (!(await this.prompt(name, action))) {
        return `Denied by user: ${name} (${action})`;
      }
    }

    try {
      return DISPATCH[name](this.root, args);
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }
}

function toolReadFile(root: string, args: Record<string, any>): string {
  const raw = requireArg(args, "path");
  const path = resolveInRoot(root, raw);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  if (statSync(path).isDirectory()) return `Error: is a directory: ${raw}`;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return `Error: not a UTF-8 text file: ${raw}`;
  }
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS) + `\n... (truncated at ${MAX_READ_CHARS} chars)`;
  }
  return text;
}

function toolSearch(root: string, args: Record<string, any>): string {
  const pattern = requireArg(args, "pattern");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return `Error: invalid regex: ${(error as Error).message}`;
  }
  const base = resolveInRoot(root, args.path || ".");
  const rootResolved = resolve(root);
  const matches: string[] = [];
  for (const file of walkFiles(base)) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue; // binary / unreadable
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const rel = relative(rootResolved, file).split(sep).join("/");
        matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          matches.push(`... (truncated at ${MAX_SEARCH_MATCHES} matches)`);
          return matches.join("\n");
        }
      }
    }
  }
  return matches.length ? matches.join("\n") : "(no matches)";
}

function toolGlob(root: string, args: Record<string, any>): string {
  const pattern = requireArg(args, "pattern");
  const base = resolveInRoot(root, args.path || ".");
  const rootResolved = resolve(root);
  const results: string[] = [];
  try {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: base, onlyFiles: true })) {
      const abs = resolve(base, rel);
      const relToRoot = relative(rootResolved, abs).split(sep).join("/");
      if (relToRoot.split("/").some((seg) => IGNORE_DIRS.has(seg))) continue;
      results.push(relToRoot);
      if (results.length >= MAX_LIST) {
        results.push(`... (truncated at ${MAX_LIST})`);
        break;
      }
    }
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
  return results.length ? results.sort().join("\n") : "(no files)";
}

function toolLs(root: string, args: Record<string, any>): string {
  const raw = args.path || ".";
  const path = resolveInRoot(root, raw);
  if (!existsSync(path)) return `Error: no such directory: ${raw}`;
  if (!statSync(path).isDirectory()) return `Error: not a directory: ${raw}`;
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((e) => !IGNORE_DIRS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  let out = entries.slice(0, MAX_LIST).join("\n") || "(empty)";
  if (entries.length > MAX_LIST) out += `\n... (${entries.length - MAX_LIST} more)`;
  return out;
}

function toolWriteFile(root: string, args: Record<string, any>): string {
  const raw = requireArg(args, "path");
  const content = args.content;
  if (content === undefined || content === null) throw new Error("missing required argument: content");
  const path = resolveInRoot(root, raw);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(content), "utf-8");
  return `Wrote ${String(content).length} chars to ${raw}`;
}

function toolEdit(root: string, args: Record<string, any>): string {
  const raw = requireArg(args, "path");
  const oldStr = args.old_string;
  const newStr = args.new_string;
  if (oldStr === undefined || oldStr === null) throw new Error("missing required argument: old_string");
  if (newStr === undefined || newStr === null) throw new Error("missing required argument: new_string");
  const path = resolveInRoot(root, raw);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  let text = readFileSync(path, "utf-8");
  const occurrences = text.split(String(oldStr)).length - 1;
  if (occurrences === 0) return `Error: old_string not found in ${raw}`;
  if (occurrences > 1) {
    return `Error: old_string occurs ${occurrences} times in ${raw} (must be unique; add more surrounding context)`;
  }
  // Function replacement avoids `$` patterns in new_string being interpreted.
  text = text.replace(String(oldStr), () => String(newStr));
  writeFileSync(path, text, "utf-8");
  return `Edited ${raw} (1 replacement)`;
}

function toolBash(root: string, args: Record<string, any>): string {
  const command = requireArg(args, "command");
  const result = spawnSync(command, {
    shell: true,
    cwd: root,
    encoding: "utf-8",
    timeout: BASH_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let output = (result.stdout || "") + (result.stderr || "");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated at ${MAX_OUTPUT_CHARS} chars)`;
  }
  return `(exit ${result.status ?? "?"})\n${output}`.trimEnd();
}

function requireArg(args: Record<string, any>, key: string): string {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing required argument: ${key}`);
  }
  return String(value);
}

function resolveInRoot(root: string, p: string): string {
  const resolved = resolve(root, p);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  return resolved;
}

function* walkFiles(base: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      yield* walkFiles(join(base, entry.name));
    } else if (entry.isFile()) {
      yield join(base, entry.name);
    }
  }
}

function describe(name: string, args: Record<string, any>): string {
  if (name === "write_file") return `write ${args.path ?? "?"}`;
  if (name === "edit") return `edit ${args.path ?? "?"}`;
  if (name === "bash") return `run: ${args.command ?? "?"}`;
  return name;
}

const DISPATCH: Record<string, (root: string, args: Record<string, any>) => string> = {
  read_file: toolReadFile,
  search: toolSearch,
  glob: toolGlob,
  ls: toolLs,
  write_file: toolWriteFile,
  edit: toolEdit,
  bash: toolBash,
};
