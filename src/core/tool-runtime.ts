/**
 * Executable coding-agent tools + the approval gate.
 *
 * read_file / search : safe  -> run immediately.
 * write_file / bash  : gated -> require approval unless approval=auto (--yolo).
 *
 * Each tool returns a STRING observation (errors + denials included) so a failed or denied
 * tool never crashes the agent loop. Path-taking tools refuse to escape the project root.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { McpTools } from "./ports.ts";
import { decide, type PermissionMode } from "./permissions.ts";
import { GATED, resolveTool, toolSchemas } from "./tools.ts";

/** An approval gate: given (toolName, the tool's args) -> approve? (may be async).
 * Receiving args lets a UI render a preview/diff before approving. */
export type ApprovalGate = (toolName: string, args: Record<string, any>) => boolean | Promise<boolean>;

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
  /** Built-in tools turned off at runtime (via `/tools <name>` in chat). */
  disabled = new Set<string>();
  /** The agent's current todo list (set by the todo_write tool; rendered by the REPL). */
  todos: { content: string; status: string }[] = [];
  /** Opt-in shell hooks around tool calls (set from config). */
  hooks?: { preToolUse?: string; postToolUse?: string };
  /** Spawns an isolated sub-agent (set by the host); enables the `task` tool. */
  subagent?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** One-shot model call (set by the host); lets web_fetch extract per a prompt (Claude-style). */
  summarize?: (instruction: string, content: string) => Promise<string>;
  /** Opt-in adversarial review of auto-approved mutating actions (set by the host). */
  checkAction?: (toolName: string, args: Record<string, any>) => Promise<{ ok: boolean; reason: string }>;
  /** When false (default), catastrophic bash commands are refused even in auto mode (seatbelt). */
  allowDangerousBash = false;
  /** Bash commands moved to the background (Ctrl+B); output keeps accumulating. Read via /bashes. */
  backgrounds: { id: string; command: string; output: string; done: boolean; code?: number | null }[] = [];
  private bgCounter = 0;
  private detachCurrent: (() => void) | null = null;
  /** Pre-images of files touched since the last checkpoint, so /rewind can restore the disk. */
  private fileSnapshots = new Map<string, string | null>();

  constructor(
    public readonly root: string,
    mode: PermissionMode = "default",
    public prompt: ApprovalGate = denyAll,
    public mcp?: McpTools,
  ) {
    this.mode = mode;
  }

  /** True while a foreground bash command is running (so the REPL can show the Ctrl+B hint). */
  bashRunning(): boolean {
    return this.detachCurrent !== null;
  }

  /** Start a fresh file checkpoint (call at the start of a turn). */
  clearCheckpoint(): void {
    this.fileSnapshots.clear();
  }

  /** Record a file's current content (once) before it's mutated this turn. */
  private snapshotFile(absPath: string): void {
    if (this.fileSnapshots.has(absPath)) return;
    try {
      this.fileSnapshots.set(absPath, existsSync(absPath) ? readFileSync(absPath, "utf-8") : null);
    } catch {
      /* unreadable -> skip */
    }
  }

  /** Restore files to their pre-checkpoint state (undo this turn's write/edit/multi_edit). Returns count. */
  restoreCheckpoint(): number {
    let n = 0;
    for (const [path, content] of this.fileSnapshots) {
      try {
        if (content === null) {
          if (existsSync(path)) { rmSync(path); n++; }
        } else {
          writeFileSync(path, content, "utf-8");
          n++;
        }
      } catch {
        /* skip */
      }
    }
    this.fileSnapshots.clear();
    return n;
  }

  /** Ctrl+B: move the currently-running bash command to the background. Returns false if none runs. */
  detachRunningBash(): boolean {
    if (!this.detachCurrent) return false;
    this.detachCurrent();
    return true;
  }

  /** Run a shell command. Resolves on exit/timeout, OR early (kept running) if Ctrl+B detaches it. */
  private async runBash(args: Record<string, any>): Promise<string> {
    const command = requireArg(args, "command");
    const child = spawn(command, { shell: true, cwd: this.root });
    let output = "";
    const onData = (d: any) => { output += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let detach!: () => void;
    const outcome = await Promise.race([
      new Promise<{ kind: "exit"; code: number | null }>((res) => child.on("close", (code) => res({ kind: "exit", code }))),
      new Promise<{ kind: "error"; err: Error }>((res) => child.on("error", (err) => res({ kind: "error", err }))),
      new Promise<{ kind: "timeout" }>((res) => setTimeout(() => res({ kind: "timeout" }), BASH_TIMEOUT_MS)),
      new Promise<{ kind: "detach" }>((res) => { detach = () => res({ kind: "detach" }); this.detachCurrent = detach; }),
    ]);
    this.detachCurrent = null;

    if (outcome.kind === "error") return `Error: ${outcome.err.message}`;
    if (outcome.kind === "timeout") {
      try { child.kill(); } catch { /* already gone */ }
      return `(timed out after ${BASH_TIMEOUT_MS}ms)\n${capOutput(output)}`.trimEnd();
    }
    if (outcome.kind === "detach") {
      const id = `bg${++this.bgCounter}`;
      const bg = { id, command, output, done: false, code: undefined as number | null | undefined };
      // Keep accumulating into the background record (the same `output` string is snapshotted; rebind).
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdout?.on("data", (d: any) => { bg.output += d.toString(); });
      child.stderr?.on("data", (d: any) => { bg.output += d.toString(); });
      child.on("close", (code) => { bg.done = true; bg.code = code; });
      this.backgrounds.push(bg);
      return `Running in background [${id}]: ${command}\nCheck output with /bashes.`;
    }
    return `(exit ${outcome.code ?? "?"})\n${capOutput(output)}`.trimEnd();
  }

  /** All tool schemas shown to the model: enabled built-in + connected MCP tools. */
  schemas(): any[] {
    return [
      ...toolSchemas().filter((s) => !this.disabled.has(s.function.name)),
      ...(this.mcp?.toolSchemas() ?? []),
    ];
  }

  async execute(name: string, args: Record<string, any>): Promise<string> {
    if (typeof args !== "object" || args === null) {
      return `Error: arguments for ${name} must be an object`;
    }
    if (this.disabled.has(name)) {
      return `Tool '${name}' is disabled (enable with /tools ${name}).`;
    }

    // pre_tool_use hook: a non-zero exit blocks the tool (audit / policy gate).
    if (this.hooks?.preToolUse) {
      const r = spawnSync(this.hooks.preToolUse, {
        shell: true, cwd: this.root, encoding: "utf-8", timeout: 10000,
        env: { ...process.env, NEKO_TOOL: name, NEKO_ARGS: JSON.stringify(args) },
      });
      if (r.status !== 0) {
        return `Blocked by pre_tool_use hook (exit ${r.status ?? "?"}): ${String(r.stderr || r.stdout || "").trim().slice(0, 200)}`;
      }
    }

    // Seatbelt: refuse clearly catastrophic bash even in auto mode (not a full sandbox - a
    // last-resort guard against accidents / prompt injection). Override: allow_dangerous_bash.
    if (name === "bash" && !this.allowDangerousBash) {
      const danger = dangerousCommand(String(args.command ?? ""));
      if (danger) return `Refused: '${danger}' is blocked as catastrophic. Set "allow_dangerous_bash": true in config to override.`;
    }

    // web_fetch: fetch the page, then (if a prompt + summarizer are available) extract just what
    // was asked via a single model pass — instead of dumping the whole page into context.
    if (name === "web_fetch") {
      const raw = await toolWebFetch(this.root, args);
      const prompt = String(args.prompt ?? "");
      if (prompt && this.summarize && !raw.startsWith("Error")) {
        try {
          return await this.summarize(prompt, raw);
        } catch {
          return raw;
        }
      }
      return raw;
    }

    // task: delegate to an isolated sub-agent (its own context + tools); return its result.
    if (name === "task") {
      if (!this.subagent) return "Sub-agents are not available in this context.";
      const prompt = String(args.prompt ?? args.description ?? "");
      if (!prompt) return "Error: task needs a 'prompt'.";
      try {
        return await this.subagent(prompt);
      } catch (error) {
        return `Sub-agent error: ${(error as Error).message}`;
      }
    }

    // exit_plan_mode: always asks the user to approve the plan (the plan-review gate).
    if (name === "exit_plan_mode") {
      const ok = await this.prompt(name, args);
      return ok
        ? "Plan approved by the user. Implement it now."
        : "The user did NOT approve the plan. Ask what to change, then call exit_plan_mode again with a revised plan.";
    }

    // todo_write: safe, no approval — record the plan for the REPL to render.
    if (name === "todo_write") {
      this.todos = Array.isArray(args.todos)
        ? args.todos.map((t: any) => ({ content: String(t?.content ?? ""), status: String(t?.status ?? "pending") }))
        : [];
      return renderTodos(this.todos);
    }

    // MCP tools: their effects are unknown, so treat them as gated (mode-governed).
    if (this.mcp?.has(name)) {
      const decision = this.mode === "auto" ? "allow" : this.mode === "plan" ? "deny" : "prompt";
      if (decision === "deny") return `Blocked: ${name} (MCP) is not allowed in 'plan' mode.`;
      if (decision === "prompt" && !(await this.prompt(name, args))) {
        return `Denied by user: ${name}`;
      }
      // Auto-approved + adversarial review on: vet the call (MCP tools are a prime injection vector).
      if (decision === "allow" && this.checkAction) {
        const v = await this.checkAction(name, args);
        if (!v.ok) return `Blocked by adversarial check: ${v.reason || "looks unsafe"}`;
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
    if (decision === "prompt" && !(await this.prompt(name, args))) {
      return `Denied by user: ${name} (${describe(name, args)})`;
    }
    // Adversarial review: when a mutating tool is auto-approved (no human in the loop), a model
    // pass vets it for prompt injection / destructive intent before it runs.
    if (decision === "allow" && spec.permission === GATED && this.checkAction) {
      const v = await this.checkAction(name, args);
      if (!v.ok) return `Blocked by adversarial check: ${v.reason || "looks unsafe"}`;
    }

    // Snapshot the target before a structured mutation so /rewind can restore it.
    if ((name === "write_file" || name === "edit" || name === "multi_edit") && args.path) {
      this.snapshotFile(resolveInRoot(this.root, String(args.path)));
    }
    try {
      const out = name === "bash" ? await this.runBash(args) : await DISPATCH[name](this.root, args);
      this.runPostHook(name, args, out);
      return out;
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }

  /** post_tool_use hook: fire-and-observe after a tool runs (logging/formatting; never blocks). */
  private runPostHook(name: string, args: Record<string, any>, result: string): void {
    if (!this.hooks?.postToolUse) return;
    try {
      spawnSync(this.hooks.postToolUse, {
        shell: true, cwd: this.root, timeout: 10000,
        env: { ...process.env, NEKO_TOOL: name, NEKO_ARGS: JSON.stringify(args), NEKO_RESULT: String(result).slice(0, 4000) },
      });
    } catch {
      /* hooks never break the turn */
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
  // Line-numbered for reference (the model cites lines; numbers are display-only).
  return text.split("\n").map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
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
  const existed = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(content), "utf-8");
  const lines = String(content).split("\n");
  return [
    `Wrote ${raw}  (${existed ? "overwrote, " : ""}+${lines.length})`,
    ...lines.slice(0, 16).map((l) => `+ ${l}`),
  ].join("\n");
}

/** A Claude-style unified diff: context lines (plain), removed (-), added (+) with a header. */
function editDiff(path: string, origLines: string[], startLine: number, removed: string[], added: string[]): string {
  const ctx = 2;
  const before = origLines.slice(Math.max(0, startLine - ctx), startLine);
  const afterStart = startLine + removed.length;
  const after = origLines.slice(afterStart, afterStart + ctx);
  const cap = (arr: string[], sign: string) => arr.slice(0, 16).map((l) => `${sign} ${l}`);
  return [
    `Edited ${path}  (+${added.length} -${removed.length})`,
    ...before.map((l) => `  ${l}`),
    ...cap(removed, "-"),
    ...cap(added, "+"),
    ...after.map((l) => `  ${l}`),
  ].join("\n");
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
  const origLines = text.split("\n");
  const oldLines = String(oldStr).split("\n");
  const newLines = String(newStr).split("\n");
  let startLine: number;
  let removed = oldLines;
  const occurrences = text.split(String(oldStr)).length - 1;
  if (occurrences === 1) {
    const idx = text.indexOf(String(oldStr));
    startLine = text.slice(0, idx).split("\n").length - 1;
    text = text.slice(0, idx) + String(newStr) + text.slice(idx + String(oldStr).length);
  } else if (occurrences > 1) {
    return `Error: old_string occurs ${occurrences} times in ${raw} (must be unique; add more surrounding context)`;
  } else {
    // Exact match failed (often indentation/trailing-whitespace drift): retry by matching lines
    // ignoring leading/trailing whitespace. Must still be unique. new_string replaces verbatim.
    const oldTrim = oldLines.map((l) => l.trim());
    let at = -1;
    let count = 0;
    for (let i = 0; i + oldLines.length <= origLines.length; i++) {
      if (oldLines.every((_, j) => origLines[i + j].trim() === oldTrim[j])) { count++; at = i; }
    }
    if (count === 0) return `Error: old_string not found in ${raw}`;
    if (count > 1) return `Error: old_string matches ${count} places in ${raw} (add more surrounding context)`;
    startLine = at;
    removed = origLines.slice(at, at + oldLines.length); // the actual file lines (real whitespace)
    const next = [...origLines];
    next.splice(at, oldLines.length, ...newLines);
    text = next.join("\n");
  }
  writeFileSync(path, text, "utf-8");
  return editDiff(raw, origLines, startLine, removed, newLines);
}

/** Apply several exact-match edits to one file, in order, atomically (writes only if all succeed). */
function toolMultiEdit(root: string, args: Record<string, any>): string {
  const raw = requireArg(args, "path");
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return "Error: multi_edit needs a non-empty 'edits' array";
  const path = resolveInRoot(root, raw);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  let text = readFileSync(path, "utf-8");
  let added = 0;
  let removed = 0;
  for (let k = 0; k < edits.length; k++) {
    const oldStr = String(edits[k]?.old_string ?? "");
    const newStr = String(edits[k]?.new_string ?? "");
    if (!oldStr) return `Error: edit ${k + 1} is missing old_string (no change written)`;
    const occ = text.split(oldStr).length - 1;
    if (occ === 0) return `Error: edit ${k + 1}: old_string not found (no change written)`;
    if (occ > 1) return `Error: edit ${k + 1}: old_string occurs ${occ} times, not unique (no change written)`;
    text = text.replace(oldStr, () => newStr);
    removed += oldStr.split("\n").length;
    added += newStr.split("\n").length;
  }
  writeFileSync(path, text, "utf-8");
  return `Edited ${raw}  (${edits.length} edits, +${added} -${removed})`;
}

function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated at ${MAX_OUTPUT_CHARS} chars)` : s;
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

/** Conservative catastrophic-command detector (clearest data/disk-destroying forms only). */
function dangerousCommand(command: string): string | null {
  const c = String(command).replace(/\s+/g, " ").trim();
  if (/\brm\b/.test(c) && /-[a-z]*r/i.test(c) && /-[a-z]*f/i.test(c) && /\s(\/|\/\*|~|\$HOME)(\s|$)/.test(c)) {
    return "recursive force-delete of / or home";
  }
  if (/\bdd\b.*\bof=\/dev\//i.test(c)) return "dd to a raw device";
  if (/\bmkfs(\.\w+)?\b/i.test(c)) return "filesystem format (mkfs)";
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) return "fork bomb";
  if (/\bformat\s+[a-z]:/i.test(c)) return "Windows drive format";
  if (/\b(rd|rmdir|del)\b\s+\/s\b.*\b[a-z]:\\?($|\s)/i.test(c)) return "recursive delete of a Windows drive";
  if (/>\s*\/dev\/(sd|nvme|disk)/i.test(c)) return "overwrite a disk device";
  return null;
}

function renderTodos(todos: { content: string; status: string }[]): string {
  if (!todos.length) return "(todos cleared)";
  const mark = (s: string) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
  return "Todos:\n" + todos.map((t) => `${mark(t.status)} ${t.content}`).join("\n");
}

function describe(name: string, args: Record<string, any>): string {
  if (name === "write_file") return `write ${args.path ?? "?"}`;
  if (name === "edit") return `edit ${args.path ?? "?"}`;
  if (name === "bash") return `run: ${args.command ?? "?"}`;
  return name;
}

const DISPATCH: Record<string, (root: string, args: Record<string, any>) => string | Promise<string>> = {
  read_file: toolReadFile,
  search: toolSearch,
  glob: toolGlob,
  ls: toolLs,
  write_file: toolWriteFile,
  edit: toolEdit,
  multi_edit: toolMultiEdit,
  // bash is handled by ToolRegistry.runBash (needs instance state for Ctrl+B backgrounding).
  web_search: toolWebSearch,
  // web_fetch is handled in execute() (it may post-process with a summarizer).
};

const WEB_HEADERS = { "User-Agent": "Mozilla/5.0 (NekoCore)" };

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ""; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; } })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Search the web via DuckDuckGo's HTML endpoint (no API key). Best-effort markup parse. */
async function toolWebSearch(_root: string, args: Record<string, any>): Promise<string> {
  const query = requireArg(args, "query");
  let html: string;
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: WEB_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    html = await res.text();
  } catch (error) {
    return `Error: web search failed: ${(error as Error).message}`;
  }
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
  const out: string[] = [];
  for (let i = 0; i < titles.length && i < 6; i++) {
    let url = titles[i][1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    out.push(`${i + 1}. ${stripTags(titles[i][2])}\n   ${url}${snippets[i] ? `\n   ${snippets[i]}` : ""}`);
  }
  return out.length ? out.join("\n") : "No results.";
}

/** Fetch a URL and return readable text (scripts/styles/tags stripped). */
async function toolWebFetch(_root: string, args: Record<string, any>): Promise<string> {
  const url = requireArg(args, "url");
  if (!/^https?:\/\//i.test(url)) return "Error: url must start with http:// or https://";
  let text: string;
  let contentType: string;
  try {
    const res = await fetch(url, { headers: WEB_HEADERS, signal: AbortSignal.timeout(20000) });
    contentType = res.headers.get("content-type") ?? "";
    text = await res.text();
  } catch (error) {
    return `Error: fetch failed: ${(error as Error).message}`;
  }
  if (contentType.includes("html")) {
    text = stripTags(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ""));
  }
  return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + "\n... (truncated)" : text;
}
