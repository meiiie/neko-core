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
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { McpTools, WebPort } from "./ports.ts";
import { decide, type PermissionMode } from "./permissions.ts";
import { memoryTool } from "./memory.ts";
import { playbookTool } from "./playbook.ts";
import { workflowTool } from "./workflows.ts";
import { destructiveInWorkspace, sandboxActive, wrapBash } from "./sandbox.ts";
import { effectivePermission, GATED, resolveTool, toolSchemas } from "./tools.ts";
import { residentUiaHost } from "./windows-uia-host.ts";
import { debug, messageOf } from "../shared/debug.ts";
import { MAX_OBS_PAGE_CHARS } from "./agent-constants.ts";

/** An approval gate: given (toolName, the tool's args) -> approve? (may be async).
 * Receiving args lets a UI render a preview/diff before approving. */
export type ApprovalGate = (toolName: string, args: Record<string, any>) => boolean | Promise<boolean>;

// Leave headroom below core's 48k per-observation guard for the header/continuation hint. Pagination
// must happen here: letting Agent clamp a 100k result would silently discard its middle.
const MAX_READ_BODY_CHARS = MAX_OBS_PAGE_CHARS;
const MAX_INLINE_READ_BYTES = MAX_READ_BODY_CHARS * 4; // UTF-8 is <= 4 bytes/char
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
  subagent?: (prompt: string, type?: string) => Promise<string>;
  /** One-shot model call (set by the host); lets web_fetch extract per a prompt (Claude-style). */
  summarize?: (instruction: string, content: string, schema?: Record<string, any>) => Promise<string>;
  /** Web content acquisition (set by the host; core can't import the web adapter). */
  web?: WebPort;
  /** Opt-in adversarial review of auto-approved mutating actions (set by the host). */
  checkAction?: (toolName: string, args: Record<string, any>) => Promise<{ ok: boolean; reason: string }>;
  /** Load a skill's body by name (set by the wiring layer; core can't import the skills adapter). */
  loadSkill?: (name: string) => { body: string; dir: string } | null;
  /** Injected desktop backend for the `computer` tool (set by the host). Default unset = the real
   * Windows UIA/PowerShell path in runComputer. A deterministic simulated GUI world sets this to drive
   * the long-horizon computer-use eval in-process (any OS, no desktop); a future remote/other-OS backend
   * would plug in the same way. Returns the same shape as the real path: a string, or image content parts. */
  computerHandler?: (args: Record<string, any>) => string | any[];
  /** When false (default), catastrophic bash commands are refused even in auto mode (seatbelt). */
  allowDangerousBash = false;
  /** Maximum foreground bash timeout. Product default is 10min; bounded evals can fail fast. */
  bashTimeoutCapMs = 600_000;
  /** Opt-in OS sandbox for bash (fs read-only except cwd). Set from config by the host. */
  sandboxBash = false;
  sandboxAllowNetwork = false;
  /** srt (Windows) only: domain allowlist used when sandboxAllowNetwork is true. */
  sandboxDomains: string[] = [];
  /** When true (default) AND the sandbox is actually live, bash runs without an approval prompt
   * in default/accept-edits mode - the sandbox is the containment (Claude Code's rationale). */
  sandboxAutoApprove = true;
  /** When true, read_file returns image files as vision content (needs a vision-capable model). */
  vision = false;
  /** When true, expose NO tools to the model — for a pure perception/vision pass (image Q&A), since
   * vision-only endpoints reject tool-calling ("auto tool choice requires --enable-auto-tool-choice"). */
  noTools = false;
  /** Agent-presence overlay (computer_use_overlay): when on, bash gets NEKO_PRESENCE=1 so the desktop
   * helpers (mouse.ps1 / ground.ts) show the independent agent cursor + honour click-to-takeover. */
  presence = false;
  /** Reuse one warm Windows UIA/input/capture process; false keeps the proven one-shot PowerShell path. */
  residentUia = true;
  /** Desktop input backend (computer_use_input): when "inject"/"sendinput", bash gets NEKO_INPUT=<value> so
   * mouse.ps1 routes clicks/strokes to the non-hijacking touch-injection path or the legacy SendInput path. */
  inputBackend = "";
  /** Web-search backend (set from config). searxng_url -> self-hosted metasearch; else Tavily (env
   * key or `tavily_api_key` config) -> agent search; else DuckDuckGo (free, zero-config).
   * `searchBackend` forces one. */
  searxngUrl = "";
  searchBackend = ""; // "" = auto-pick by what's configured
  /** Idle minutes before a NEKO-STARTED SearXNG container auto-stops (0 = keep running). */
  searxngKeepalive = 15;
  /** Tavily key from config (`tavily_api_key`, via `neko setup tavily`); TAVILY_API_KEY env wins. */
  tavilyKey = "";
  /** Optional hosted scrape backend for web_fetch (renders JS/SPAs -> markdown). "" = direct fetch; "jina" = r.jina.ai. */
  scrapeBackend = "";
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
      } catch (e) {
        debug("checkpoint", () => `snapshotFile unreadable ${absPath}: ${messageOf(e)}`);
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
        } catch (e) {
          debug("checkpoint", () => `restoreCheckpoint failed ${path}: ${messageOf(e)}`);
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
  private async runBash(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const command = requireArg(args, "command");
    // Per-call timeout (default 60s, clamped to [1s, 10min]) so slow builds/tests aren't cut off.
    const timeoutMs = Math.min(
      Math.max(Math.floor(Number(args.timeout) || BASH_TIMEOUT_MS), 1000),
      Math.min(600_000, Math.max(1_000, this.bashTimeoutCapMs)),
    );
    const sb = wrapBash(command, this.root, { enabled: this.sandboxBash, allowNetwork: this.sandboxAllowNetwork, domains: this.sandboxDomains });
    // Agent-presence opt-in: desktop helpers read NEKO_PRESENCE to show the independent cursor + honour takeover.
    // Desktop input backend opt-in: NEKO_INPUT picks the non-hijacking (inject) vs legacy (sendinput) path.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.presence) env.NEKO_PRESENCE = "1";
    if (this.inputBackend && this.inputBackend !== "auto") env.NEKO_INPUT = this.inputBackend;
    const child = spawn(sb.file, sb.args, { shell: sb.shell, cwd: this.root, env });
    // Cap LIVE accumulation so a runaway command (`yes`, an infinite echo loop) can't grow the buffer
    // to gigabytes and OOM the process before the timeout fires.
    const MAX_BASH_OUTPUT = 200_000;

    // Model-initiated background (run_in_background): start it, return immediately, and keep
    // accumulating output into a record the user reads with /bashes. For servers/watchers/long jobs.
    if (args.run_in_background === true) {
      const id = `bg${++this.bgCounter}`;
      const bg = { id, command, output: "", done: false, code: undefined as number | null | undefined };
      const grab = (d: any) => { if (bg.output.length < MAX_BASH_OUTPUT) bg.output += d.toString(); };
      child.stdout?.on("data", grab);
      child.stderr?.on("data", grab);
      child.on("close", (code) => { bg.done = true; bg.code = code; });
      child.on("error", (err) => { bg.done = true; bg.output += `\nError: ${err.message}`; });
      this.backgrounds.push(bg);
      return `Running in background [${id}]: ${command}\nCheck its output later with /bashes.`;
    }

    let output = "";
    const onData = (d: any) => { if (output.length < MAX_BASH_OUTPUT) output += d.toString(); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let detach!: () => void;
    const outcome = await Promise.race([
      new Promise<{ kind: "exit"; code: number | null }>((res) => child.on("close", (code) => res({ kind: "exit", code }))),
      new Promise<{ kind: "error"; err: Error }>((res) => child.on("error", (err) => res({ kind: "error", err }))),
      new Promise<{ kind: "timeout" }>((res) => setTimeout(() => res({ kind: "timeout" }), timeoutMs)),
      new Promise<{ kind: "detach" }>((res) => { detach = () => res({ kind: "detach" }); this.detachCurrent = detach; }),
      new Promise<{ kind: "abort" }>((res) => {
        if (!signal) return;
        if (signal.aborted) return res({ kind: "abort" });
        signal.addEventListener("abort", () => res({ kind: "abort" }), { once: true });
      }),
    ]);
    this.detachCurrent = null;

    // Esc / Ctrl+C while a command runs: kill the child at once (don't wait out the 60s timeout) and
    // stop it leaking as an orphan.
    if (outcome.kind === "abort") {
      try { child.kill(); } catch { /* already gone */ }
      return `(interrupted)\n${capOutput(output)}`.trimEnd();
    }
    if (outcome.kind === "error") return `Error: ${outcome.err.message}`;
    if (outcome.kind === "timeout") {
      try { child.kill(); } catch { /* already gone */ }
      return `(timed out after ${timeoutMs}ms)\n${capOutput(output)}`.trimEnd();
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
    const code = outcome.code ?? 0;
    // Make failures unmistakable so the model reacts (diagnoses + retries) instead of moving on.
    const tag = code === 0 ? "(exit 0)" : `(exit ${code} -- command FAILED)`;
    return `${tag}\n${capOutput(output)}`.trimEnd();
  }

  /** Progressive disclosure: return a skill's full instructions on demand so the model can go deep on
   * a domain it just decided is relevant, without that body ever sitting in context unused. */
  private runSkill(args: Record<string, any>): string {
    const name = String(requireArg(args, "name"));
    const s = this.loadSkill?.(name);
    if (!s) return `(no skill '${name}' - check the skills listed in your context)`;
    return `# Skill: ${name}\n(skill files dir: ${s.dir} - run any bundled scripts from here by absolute path)\n${s.body}`;
  }

  /** All tool schemas shown to the model: enabled built-in + connected MCP tools. */
  schemas(): any[] {
    if (this.noTools) return []; // perception mode: a vision-only endpoint 400s if sent any tools
    return [
      ...toolSchemas().filter((s) => !this.disabled.has(s.function.name)),
      ...(this.mcp?.toolSchemas() ?? []),
    ];
  }

  async execute(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string | any[]> {
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

    // web_search: pick the best configured backend (SearXNG > Tavily > DuckDuckGo).
    if (name === "web_search") {
      if (!this.web) return "Error: web adapter is not configured";
      return this.web.search(String(args.query ?? ""), { searxngUrl: this.searxngUrl, backend: this.searchBackend, keepaliveMin: this.searxngKeepalive, tavilyKey: this.tavilyKey });
    }

    // web_fetch: fetch the page, then (if a prompt + summarizer are available) extract just what
    // was asked via a single model pass — instead of dumping the whole page into context.
    if (name === "web_fetch") {
      if (!this.web) return "Error: web adapter is not configured";
      return this.web.fetch(this.root, args, this.scrapeBackend, this.summarize);
    }

    // task: delegate to an isolated sub-agent (its own context + tools); return its result.
    if (name === "task") {
      if (!this.subagent) return "Sub-agents are not available in this context.";
      const prompt = String(args.prompt ?? args.description ?? "");
      if (!prompt) return "Error: task needs a 'prompt'.";
      try {
        return await this.subagent(prompt, args.subagent_type ? String(args.subagent_type) : undefined);
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
      if (!Array.isArray(args.todos)) return "Error: todo_write needs a 'todos' array.";
      if (args.todos.length > 64) return "Error: todo_write accepts at most 64 items; keep the plan at the useful working level.";
      const next = args.todos.map((t: any) => ({ content: String(t?.content ?? "").trim(), status: String(t?.status ?? "") }));
      if (next.some((t) => !t.content)) return "Error: todo_write items need non-empty content.";
      if (next.some((t) => !["pending", "in_progress", "completed"].includes(t.status))) {
        return "Error: todo_write status must be pending, in_progress, or completed.";
      }
      const seen = new Set<string>();
      if (next.some((t) => { const key = t.content.toLowerCase(); if (seen.has(key)) return true; seen.add(key); return false; })) {
        return "Error: todo_write items must be unique.";
      }
      const active = next.filter((t) => t.status === "in_progress").length;
      const pending = next.some((t) => t.status === "pending");
      if (active > 1 || (pending && active !== 1)) {
        return "Error: todo_write needs exactly one in_progress item while pending work remains; an all-completed list has none.";
      }
      this.todos = next;
      return renderTodos(this.todos);
    }

    // mcp_load: a SAFE meta-tool that pulls MCP tool schemas on demand (lazy mode). No side effects.
    if (name === "mcp_load" && this.mcp?.loadTools) {
      const names = Array.isArray(args.names) ? args.names.map(String) : [String(args.name ?? "")].filter(Boolean);
      return this.mcp.loadTools(names);
    }

    // MCP tools default to gated. A trusted adapter may explicitly declare a read-only call safe.
    if (this.mcp?.has(name)) {
      const declaredSafe = this.mcp.permission?.(name) === "safe";
      const decision = declaredSafe ? "allow" : this.mode === "auto" ? "allow" : this.mode === "plan" ? "deny" : "prompt";
      if (decision === "deny") return `Blocked: ${name} (MCP) is not allowed in 'plan' mode.`;
      if (decision === "prompt" && !(await this.prompt(name, args))) {
        return `Denied by user: ${name}`;
      }
      // Auto-approved + adversarial review on: vet the call (MCP tools are a prime injection vector).
      if (!declaredSafe && decision === "allow" && this.checkAction) {
        const v = await this.checkAction(name, args);
        if (!v.ok) return `Blocked by adversarial check: ${v.reason || "looks unsafe"}`;
      }
      try {
        return await this.mcp.call(name, args, signal);
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

    // Sandboxed-bash auto-approval keys off LIVE confinement (primitive present + provisioned),
    // never off config intent alone - see decide() for the policy rationale. It is WITHHELD for
    // commands that irreversibly destroy data inside the workspace: the sandbox contains the blast
    // radius, but the user's own code + .git are writable, so those still get one confirmation.
    // (mode=auto/yolo still allows everything - that's the point of yolo; always-allow-bash too.)
    const sandboxedBash = spec.name === "bash" && this.sandboxBash && this.sandboxAutoApprove
      && sandboxActive() && !destructiveInWorkspace(String(args.command ?? ""));
    const decision = decide(this.mode, spec, args, { sandboxedBash });
    if (decision === "deny") {
      return `Blocked: ${name} is not allowed in '${this.mode}' mode (read-only).`;
    }
    if (decision === "prompt" && !(await this.prompt(name, args))) {
      return `Denied by user: ${name} (${describe(name, args)})`;
    }
    // Adversarial review: when a mutating tool is auto-approved (no human in the loop), a model
    // pass vets it for prompt injection / destructive intent before it runs.
    if (decision === "allow" && effectivePermission(spec, args) === GATED && this.checkAction) {
      const v = await this.checkAction(name, args);
      if (!v.ok) return `Blocked by adversarial check: ${v.reason || "looks unsafe"}`;
    }

    // Snapshot the target before a structured mutation so /rewind can restore it.
    if ((name === "write_file" || name === "edit" || name === "multi_edit") && args.path) {
      this.snapshotFile(resolveInRoot(this.root, String(args.path)));
    }
    try {
      const out = name === "bash" ? await this.runBash(args, signal)
        : name === "read_file" ? await this.runReadFile(args)
        : name === "skill" ? this.runSkill(args)
        : name === "computer" ? await this.runComputer(args, signal)
        : await DISPATCH[name](this.root, args);
      this.runPostHook(name, args, typeof out === "string" ? out : "[image]");
      return out;
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }

  /** read_file with media awareness: images -> vision content (if enabled), PDFs -> extracted text,
   * everything else -> the line-numbered text path. */
  private async runReadFile(args: Record<string, any>): Promise<string | any[]> {
    const raw = requireArg(args, "path");
    const path = resolveInRoot(this.root, raw);
    if (!existsSync(path)) return `Error: no such file: ${raw}`;
    const ext = (raw.split(".").pop() ?? "").toLowerCase();
    if (IMAGE_EXTS.has(ext)) return readImageFile(path, raw, ext, this.vision);
    if (ext === "pdf") return readPdfFile(path, raw, args);
    return await toolReadFile(this.root, args);
  }

  /** First-class desktop/GUI control (Windows): dispatches to the computer-use skill's accessibility-tree
   * scripts. Reads/acts on a window BY NAME (no vision); pointer acts use touch injection (no mouse hijack).
   * Unicode element names go through a temp UTF-8 file (@file) -- the cp1252 console mangles non-ASCII args. */
  private async runComputer(args: Record<string, any>, signal?: AbortSignal): Promise<string | any[]> {
    // An injected backend (e.g. the simulated GUI world in the long-horizon eval) takes over the whole
    // tool: it needs no real desktop, so it also bypasses the Windows-only guard below. Default unset.
    if (this.computerHandler) return this.computerHandler(args);
    // The computer tool drives Windows UI Automation via PowerShell scripts - Windows-only by design.
    // Fail honestly and immediately on other platforms instead of a confusing spawn error 90s later.
    if (process.platform !== "win32") {
      return "Error: the computer tool is Windows-only (it drives Windows UI Automation via PowerShell). It is not available on this platform.";
    }
    const action = String(args.action ?? "");
    const skill = this.loadSkill?.("computer-use");
    const scriptsDir = skill ? join(skill.dir, "scripts") : join(this.root, "skills", "computer-use", "scripts");
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (args.window) { env.NEKO_UIA_WINDOW = String(args.window); env.NEKO_DRAW_WINDOW = String(args.window); }
    if (this.presence) env.NEKO_PRESENCE = "1";
    if (this.inputBackend && this.inputBackend !== "auto") env.NEKO_INPUT = this.inputBackend;
    const tmp: string[] = [];
    const atFile = (s: string): string => { const p = join(tmpdir(), `neko_uia_${Date.now()}_${tmp.length}.txt`); writeFileSync(p, s, "utf8"); tmp.push(p); return "@" + p; };
    let script: string, sa: string[];
    let capturePath = "";
    switch (action) {
      case "list": case "read": script = "uia.ps1"; sa = [action]; break;
      case "activate": script = "uia.ps1"; sa = ["activate"]; break; // restore + foreground a (possibly minimized) window
      case "ocr": script = "ocr.ps1"; sa = []; break; // read on-screen TEXT via Windows OCR (no vision model; for Chromium/Electron apps)
      case "display": script = "display.ps1"; sa = []; break;
      case "get": case "invoke": case "toggle": {
        const nm = String(args.name ?? ""); if (!nm) return `Error: computer ${action} needs 'name'.`;
        script = "uia.ps1"; sa = [action, atFile(nm)]; break;
      }
      case "setvalue": {
        const nm = String(args.name ?? ""); if (!nm) return "Error: computer setvalue needs 'name'.";
        script = "uia.ps1"; sa = ["setvalue", atFile(nm), atFile(String(args.value ?? ""))]; break;
      }
      case "click": {
        const x = Number(args.x), y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return "Error: computer click needs numeric 'x' and 'y'.";
        script = "inject.ps1"; sa = ["tap", String(Math.round(x)), String(Math.round(y))]; break;
      }
      case "stroke": {
        const nums = Array.isArray(args.points) ? args.points.map((n: any) => Number(n)) : [];
        if (nums.length < 4 || nums.length % 2 !== 0 || nums.some((n) => !Number.isFinite(n))) return "Error: computer stroke needs an even 'points' array of NUMBERS [x1,y1,x2,y2,...] (>= 2 points).";
        script = "inject.ps1"; sa = ["stroke", ...nums.map((n) => String(Math.round(n)))]; break;
      }
      case "type": {
        if (typeof args.text !== "string" || !args.text.length) return "Error: computer type needs non-empty 'text'.";
        if (args.text.length > 20_000) return "Error: computer type is limited to 20000 characters; use a file or programmatic path for larger content.";
        const name = String(args.name ?? "");
        script = "input.ps1"; sa = ["type", atFile(args.text), "1", name ? atFile(name) : ""]; break;
      }
      case "key": {
        const keys = String(args.keys ?? "").trim();
        if (!keys) return "Error: computer key needs 'keys' (for example ENTER or CTRL+L).";
        if (keys.length > 80) return "Error: computer key 'keys' is too long.";
        const name = String(args.name ?? "");
        script = "input.ps1"; sa = ["key", atFile(keys), "1", name ? atFile(name) : ""]; break;
      }
      case "scroll": {
        const direction = String(args.direction ?? "").toLowerCase();
        if (!["up", "down", "left", "right"].includes(direction)) return "Error: computer scroll needs direction: up | down | left | right.";
        const amount = args.amount === undefined ? 1 : Number(args.amount);
        if (!Number.isInteger(amount) || amount < 1 || amount > 10) return "Error: computer scroll 'amount' must be an integer from 1 to 10.";
        script = "input.ps1"; sa = ["scroll", direction, String(amount)]; break;
      }
      case "wait": {
        const duration = args.duration_ms === undefined ? 500 : Number(args.duration_ms);
        if (!Number.isInteger(duration) || duration < 0 || duration > 10_000) return "Error: computer wait 'duration_ms' must be an integer from 0 to 10000.";
        script = "input.ps1"; sa = ["wait", "", String(duration)]; break;
      }
      case "watch": {
        const duration = args.duration_ms === undefined ? 10_000 : Number(args.duration_ms);
        const settle = args.settle_ms === undefined ? 500 : Number(args.settle_ms);
        if (!Number.isInteger(duration) || duration < 250 || duration > 30_000) return "Error: computer watch 'duration_ms' must be an integer from 250 to 30000.";
        if (!Number.isInteger(settle) || settle < 100 || settle > 2_000 || settle >= duration) return "Error: computer watch 'settle_ms' must be an integer from 100 to 2000 and less than duration_ms.";
        // watch is a resident-only event primitive. The assignments satisfy the shared fallback shape;
        // an unavailable/disabled host returns an explicit wait+read alternative below.
        script = "uia.ps1"; sa = ["read"]; break;
      }
      case "open": {
        const target = String(args.target ?? "");
        if (!target) return "Error: computer open needs 'target' (an executable, file path, or URL).";
        if (target.length > 4096) return "Error: computer open 'target' is too long.";
        script = "input.ps1"; sa = ["open", atFile(target)]; break;
      }
      case "screenshot": {
        capturePath = join(tmpdir(), `neko_shot_${Date.now()}.gif`);
        // A vision-capable main model gets embedded bytes, so its temp capture can be removed. Keep
        // the legacy file for a text-only driver: it may hand that path to the separate vision helper.
        if (this.vision) tmp.push(capturePath);
        script = "screenshot.ps1";
        sa = [capturePath];
        break;
      }
      default: return `Unknown computer action '${action}'. Use: list | read | get | display | activate | ocr | watch | invoke | setvalue | toggle | click | stroke | type | key | scroll | wait | open | screenshot.`;
    }
    try {
      let residentOutput: string | null = null;
      if (this.residentUia && ["list", "read", "get", "watch", "invoke", "setvalue", "toggle", "click", "stroke", "type", "key", "scroll", "wait", "screenshot"].includes(action)) {
        try {
          const response = await residentUiaHost(join(scriptsDir, "resident-uia.ps1")).request({
            action,
            window: args.window ? String(args.window) : undefined,
            name: args.name === undefined ? undefined : String(args.name),
            value: args.value === undefined ? undefined : String(args.value),
            text: args.text === undefined ? undefined : String(args.text),
            keys: args.keys === undefined ? undefined : String(args.keys),
            direction: args.direction === undefined ? undefined : String(args.direction),
            amount: args.amount === undefined ? undefined : Number(args.amount),
            durationMs: args.duration_ms === undefined ? undefined : Number(args.duration_ms),
            settleMs: args.settle_ms === undefined ? undefined : Number(args.settle_ms),
            x: args.x === undefined ? undefined : Math.round(Number(args.x)),
            y: args.y === undefined ? undefined : Math.round(Number(args.y)),
            points: Array.isArray(args.points) ? args.points.map((n: any) => Math.round(Number(n))) : undefined,
            presence: this.presence,
            inputBackend: this.inputBackend,
            capturePath: capturePath || undefined,
            width: action === "screenshot" ? 768 : undefined,
          }, action === "watch" ? Number(args.duration_ms ?? 10_000) + 5_000 : 15_000, signal);
          if (!response.ok) return `Error: computer ${action} failed (resident Windows host). ${response.error || "unknown error"}`;
          if (action === "screenshot") residentOutput = response.output?.trim() || "";
          else return response.output?.trim() || "(no output)";
        } catch (error) {
          if (signal?.aborted) return "(interrupted)";
          // Transport/startup failure only: preserve the proven one-shot adapter as the rollback path.
          debug("computer", () => `resident Windows host unavailable, using one-shot fallback: ${messageOf(error)}`);
        }
      }
      let out = residentOutput ?? "", err = "";
      if (residentOutput === null) {
        if (action === "watch") return "Error: computer watch requires the resident Windows UIA host. Enable computer_use_resident, or use wait then read as the slower fallback.";
        const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scriptsDir, script), ...sa], { encoding: "utf-8", cwd: this.root, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
        // Surface failures instead of swallowing them into "(no output)" — the agent can only adapt to a
        // failure it can SEE (same contract as the rest of the loop). Timeout/spawn error -> r.error.
        if (r.error) {
          const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
          return `Error: computer ${action} ${timedOut ? "timed out after 90s (the PowerShell action hung)" : "could not run PowerShell"}: ${r.error.message}`;
        }
        out = (r.stdout || "").trim(); err = (r.stderr || "").trim();
        if (r.status && r.status !== 0) return `Error: computer ${action} failed (PowerShell exit ${r.status}). ${err || out || ""}`.trim();
      }
      if (capturePath) {
        if (!existsSync(capturePath)) return `Error: computer screenshot did not create an image. ${err || out || ""}`.trim();
        // Return the observation itself, not a dead temp-file path. This closes the GUI loop in one
        // tool round-trip: with vision on, the next model call sees the screen; without it, the legacy
        // saved path remains available to the separate vision helper. Keep scale/view dimensions because
        // grounded coordinates must map back to physical pixels. The temp image is removed in finally
        // after its bytes have been embedded in the result.
        const observation = readImageFile(capturePath, "desktop screenshot", "gif", this.vision);
        if (typeof observation === "string") return [out, observation].filter(Boolean).join("\n");
        const info = out.replace(/^saved\s+.*?\s+(?=view=)/i, "captured ");
        let annotated = false;
        return observation.map((part) => {
          if (!annotated && part?.type === "text") {
            annotated = true;
            return { ...part, text: [info, part.text].filter(Boolean).join("\n") };
          }
          return part;
        });
      }
      return out || (err && `Error: computer ${action}: ${err}`) || "(no output)";
    } finally {
      for (const p of tmp) { try { rmSync(p, { force: true }); } catch {} }
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
      } catch (e) {
        debug("hook", () => `post_tool_use hook threw for ${name}: ${messageOf(e)}`);
      }
  }
}

async function toolReadFile(root: string, args: Record<string, any>): Promise<string> {
  const raw = requireArg(args, "path");
  const path = resolveInRoot(root, raw);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  const stat = statSync(path);
  if (stat.isDirectory()) return `Error: is a directory: ${raw}`;
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1)); // 1-based
  const column = Math.max(1, Math.floor(Number(args.column) || 1)); // 1-based
  const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : undefined;
  if (stat.size > MAX_INLINE_READ_BYTES) return await readLargeFileWindow(path, raw, offset, column, limit);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return `Error: cannot read file: ${raw}`;
  }
  return formatReadWindow(text.split("\n"), raw, offset, column, limit);
}

/** Format an in-memory line window below the agent observation cap. A rare overlong single line is
 * character-pageable via `column`, so minified JSON/bundles stay lossless too. */
function formatReadWindow(lines: string[], raw: string, offset: number, column = 1, limit?: number): string {
  const start = offset - 1;
  if (start >= lines.length) return `(offset ${offset} is beyond end of file at line ${lines.length})`;
  const rendered: string[] = [];
  let chars = 0;
  let index = start;
  let partialColumn: number | undefined;
  while (index < lines.length && (limit === undefined || index - start < limit)) {
    const lineNo = index + 1;
    const source = index === start ? lines[index].slice(column - 1) : lines[index];
    const prefix = `${String(lineNo).padStart(5)}  `;
    const separator = rendered.length ? 1 : 0;
    const needed = separator + prefix.length + source.length;
    if (chars + needed <= MAX_READ_BODY_CHARS) {
      rendered.push(prefix + source);
      chars += needed;
      index++;
      continue;
    }
    if (!rendered.length) {
      const available = Math.max(1, MAX_READ_BODY_CHARS - prefix.length);
      const chunk = source.slice(0, available);
      rendered.push(prefix + chunk);
      chars = prefix.length + chunk.length;
      partialColumn = column + chunk.length;
    }
    break;
  }
  const end = partialColumn !== undefined ? offset : Math.max(offset, index);
  const hasMore = partialColumn !== undefined || index < lines.length;
  const explicitlyWindowed = offset > 1 || column > 1 || limit !== undefined;
  const header = explicitlyWindowed || hasMore ? `(lines ${offset}-${end} of ${lines.length})\n` : "";
  const continuation = !hasMore ? "" : partialColumn !== undefined
    ? `\n... (more available; continue with read_file path:${JSON.stringify(raw)} offset:${offset} column:${partialColumn})`
    : `\n... (more available; continue with read_file path:${JSON.stringify(raw)} offset:${index + 1})`;
  return header + rendered.join("\n") + continuation;
}

/** Stream a line window from a large file without retaining the skipped prefix in memory. */
async function readLargeFileWindow(path: string, raw: string, offset: number, column = 1, limit?: number): Promise<string> {
  const input = createReadStream(path, { encoding: "utf-8", highWaterMark: 64 * 1024 });
  const rendered: string[] = [];
  let lineNo = 1;
  let currentColumn = 1;
  let currentIndex = -1;
  let selectedLines = 0;
  let lastRenderedLine = 0;
  let chars = 0;
  let more = false;
  let nextOffset = offset;
  let nextColumn = 1;
  let stopped = false;
  let currentHasData = false;

  const stopBefore = (atColumn = 1) => {
    more = true;
    nextOffset = lineNo;
    nextColumn = atColumn;
    stopped = true;
  };
  const startSelectedLine = (): boolean => {
    if (currentIndex >= 0) return true;
    const prefix = `${String(lineNo).padStart(5)}  `;
    const separator = rendered.length ? 1 : 0;
    if (chars + separator + prefix.length > MAX_READ_BODY_CHARS) {
      stopBefore(lineNo === offset ? Math.max(column, currentColumn) : currentColumn);
      return false;
    }
    rendered.push(prefix);
    currentIndex = rendered.length - 1;
    chars += separator + prefix.length;
    lastRenderedLine = lineNo;
    return true;
  };
  const appendPiece = (piece: string): boolean => {
    currentHasData ||= piece.length > 0;
    if (lineNo < offset) { currentColumn += piece.length; return true; }
    if (limit !== undefined && selectedLines >= limit) { stopBefore(); return false; }
    const skip = lineNo === offset && currentColumn < column
      ? Math.min(piece.length, column - currentColumn)
      : 0;
    const displayColumn = currentColumn + skip;
    const content = piece.slice(skip);
    currentColumn += piece.length;
    if (!content.length) return true;
    if (!startSelectedLine()) return false;
    const remaining = MAX_READ_BODY_CHARS - chars;
    if (content.length > remaining) {
      rendered[currentIndex] += content.slice(0, remaining);
      chars += remaining;
      stopBefore(displayColumn + remaining);
      return false;
    }
    rendered[currentIndex] += content;
    chars += content.length;
    return true;
  };
  const finishLine = (): boolean => {
    if (lineNo >= offset && (limit === undefined || selectedLines < limit)) {
      if (!startSelectedLine()) return false;
      // createReadStream preserves CR in CRLF; match readFile(...).split("\n") line content.
      if (rendered[currentIndex].endsWith("\r")) {
        rendered[currentIndex] = rendered[currentIndex].slice(0, -1);
        chars--;
      }
      selectedLines++;
    }
    lineNo++;
    currentColumn = 1;
    currentIndex = -1;
    currentHasData = false;
    return true;
  };
  try {
    for await (const chunk of input) {
      const text = String(chunk);
      let cursor = 0;
      while (!stopped && cursor < text.length) {
        if (limit !== undefined && selectedLines >= limit) { stopBefore(); break; }
        const newline = text.indexOf("\n", cursor);
        const end = newline < 0 ? text.length : newline;
        if (!appendPiece(text.slice(cursor, end))) break;
        if (newline < 0) break;
        if (!finishLine()) break;
        cursor = newline + 1;
      }
      if (stopped) break;
    }
  } finally {
    input.destroy();
  }
  // A final non-newline-terminated line still counts. Empty large files never reach this path.
  if (!stopped && currentHasData && lineNo >= offset && (limit === undefined || selectedLines < limit)) {
    startSelectedLine();
    lastRenderedLine = lineNo;
  }
  if (!rendered.length) return `(offset ${offset} is beyond end of file at line ${lineNo})`;
  const continuation = !more ? "" : nextColumn > 1
    ? `\n... (more available; continue with read_file path:${JSON.stringify(raw)} offset:${nextOffset} column:${nextColumn})`
    : `\n... (more available; continue with read_file path:${JSON.stringify(raw)} offset:${nextOffset})`;
  return `(lines ${offset}-${lastRenderedLine}${more ? "; more available" : ""})\n${rendered.join("\n")}${continuation}`;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** Read an image as vision content (caption + data URL) when vision is on, else as metadata text. */
function readImageFile(path: string, raw: string, ext: string, vision: boolean): string | any[] {
  const buf = readFileSync(path);
  const dims = imageDims(buf, ext);
  const meta = `image ${raw}${dims ? ` ${dims.w}x${dims.h}` : ""}, ${Math.max(1, Math.round(buf.length / 1024))} KB`;
  if (!vision) {
    return `[${meta}] - to view it, set "vision": true in config with a vision-capable model, or paste it (Alt+V).`;
  }
  const mime = ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext;
  return [
    { type: "text", text: `[${meta}]` },
    { type: "image_url", image_url: { url: `data:image/${mime};base64,${buf.toString("base64")}` } },
  ];
}

/** Extract text from a PDF via pdftotext (poppler) when available; else explain how to read it. */
function readPdfFile(path: string, raw: string, args: Record<string, any>): string {
  const exe = Bun.which("pdftotext");
  if (!exe) return `[PDF ${raw}] - text extraction needs 'pdftotext' (poppler) on PATH (not found). Install it, or open the pages with a vision model.`;
  const r = spawnSync(exe, ["-layout", path, "-"], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (r.error) return `Error extracting PDF: ${r.error.message}`;
  const text = String(r.stdout || "");
  if (!text.trim()) {
    const err = String(r.stderr || "").trim().slice(0, 150);
    return r.status !== 0 && err
      ? `[PDF ${raw}] - could not extract text: ${err}`
      : `[PDF ${raw}] - no extractable text (likely a scanned/image PDF; needs OCR or a vision model).`;
  }
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
  const column = Math.max(1, Math.floor(Number(args.column) || 1));
  const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : undefined;
  return formatReadWindow(text.split("\n"), raw, offset, column, limit);
}

/** Cheap width/height from common image headers (PNG/GIF/JPEG), or null. No decoding, no deps. */
function imageDims(buf: Buffer, ext: string): { w: number; h: number } | null {
  try {
    if (ext === "png" && buf.length >= 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (ext === "gif" && buf.length >= 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if ((ext === "jpg" || ext === "jpeg") && buf.length > 4) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; // SOF segment: height then width
        }
        i += 2 + buf.readUInt16BE(i + 2); // skip this segment
      }
    }
  } catch {
    /* malformed header -> no dims */
  }
  return null;
}

function toolSearch(root: string, args: Record<string, any>): string {
  const pattern = requireArg(args, "pattern");
  // Prefer ripgrep when installed: far faster on big trees + honors .gitignore. Fall back to the
  // built-in walk (no rg) — both support glob/case_insensitive/context so behavior is consistent.
  const rg = Bun.which("rg");
  if (rg) {
    const out = ripgrepSearch(rg, root, pattern, args);
    if (out !== null) return out; // null = rg couldn't run -> use the JS walk
  }
  return jsSearch(root, pattern, args);
}

/** ripgrep search. Returns null only if rg fails to spawn (so the caller falls back to jsSearch). */
function ripgrepSearch(rgPath: string, root: string, pattern: string, args: Record<string, any>): string | null {
  const rel = args.path ? relative(resolve(root), resolveInRoot(root, args.path)).split(sep).join("/") || "." : ".";
  const ctx = Math.max(0, Math.min(5, Math.floor(Number(args.context) || 0)));
  const rgArgs = ["--line-number", "--no-heading", "--color=never", "--max-columns=250", "--max-count=2000"];
  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) rgArgs.push("--glob", String(args.glob));
  if (ctx) rgArgs.push("-C", String(ctx));
  rgArgs.push("--", pattern, rel); // -- so a pattern starting with '-' isn't read as a flag
  const r = spawnSync(rgPath, rgArgs, { cwd: root, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (r.error) return null; // couldn't spawn -> let the JS fallback handle it
  if (r.status === 2) return `Error: ${String(r.stderr || "").trim().slice(0, 200) || "search failed"}`; // e.g. bad regex
  const lines = String(r.stdout || "").split("\n").filter(Boolean);
  if (!lines.length) return "(no matches)";
  const shown = lines.slice(0, MAX_SEARCH_MATCHES).map((l) => l.replace(/\\/g, "/"));
  if (lines.length > MAX_SEARCH_MATCHES) shown.push(`... (truncated at ${MAX_SEARCH_MATCHES} matches)`);
  return shown.join("\n");
}

/** Built-in regex walk — the fallback when ripgrep isn't installed. Also supports glob/case/context. */
function jsSearch(root: string, pattern: string, args: Record<string, any>): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.case_insensitive ? "i" : "");
  } catch (error) {
    return `Error: invalid regex: ${(error as Error).message}`;
  }
  const base = resolveInRoot(root, args.path || ".");
  const rootResolved = resolve(root);
  const ctx = Math.max(0, Math.min(5, Math.floor(Number(args.context) || 0)));
  const glob = args.glob ? new Bun.Glob(String(args.glob)) : null;
  const matches: string[] = [];
  for (const file of walkFiles(base)) {
    if (glob) {
      const relToBase = relative(base, file).split(sep).join("/");
      if (!glob.match(relToBase) && !glob.match(file.split(sep).pop() ?? "")) continue;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue; // binary / unreadable
    }
    const lines = text.split(/\r?\n/);
    const rel = relative(rootResolved, file).split(sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        if (ctx) {
          for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
            matches.push(`${rel}:${j + 1}:${j === i ? " " : "-"}${lines[j].slice(0, 200)}`);
          }
        } else {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
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
  // Claude-style row: line number (1-based, right-aligned), then the "+" marker, then the content -
  // same format editDiff uses, so a written file's preview shows line numbers like an edit's does.
  const num = (i: number) => String(i + 1).padStart(4);
  return [
    `Wrote ${raw}  (${existed ? "overwrote, " : ""}+${lines.length})`,
    ...lines.slice(0, 16).map((l, i) => `${num(i)} + ${l}`),
  ].join("\n");
}

/** A Claude-style unified diff: context lines (plain), removed (-), added (+) with a header. */
function editDiff(path: string, origLines: string[], startLine: number, removed: string[], added: string[]): string {
  const ctx = 2;
  const num = (i: number) => String(i + 1).padStart(4); // 1-based line number, right-aligned
  // Claude-style row: line number FIRST, then the +/-/space marker, then the content.
  const row = (i: number, sign: string, l: string) => `${num(i)} ${sign} ${l}`;
  const out = [`Edited ${path}  (+${added.length} -${removed.length})`];
  const beforeStart = Math.max(0, startLine - ctx);
  origLines.slice(beforeStart, startLine).forEach((l, i) => out.push(row(beforeStart + i, " ", l))); // context
  removed.slice(0, 16).forEach((l, i) => out.push(row(startLine + i, "-", l))); // removed (red)
  added.slice(0, 16).forEach((l, i) => out.push(row(startLine + i, "+", l))); // added (green)
  const afterStart = startLine + removed.length;
  origLines.slice(afterStart, afterStart + ctx).forEach((l, i) => out.push(row(afterStart + i, " ", l)));
  return out.join("\n");
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

/** realpath that tolerates a not-yet-existing path: resolves the nearest EXISTING ancestor (so a new file's
 *  symlinked parent dir is still caught), falling back to the lexical path if realpath fails. */
function realpathNearest(p: string): string {
  let probe = p;
  while (probe !== dirname(probe) && !existsSync(probe)) probe = dirname(probe);
  try {
    const real = realpathSync(probe);
    return probe === p ? real : real + p.slice(probe.length); // re-attach the not-yet-existing tail
  } catch {
    return p;
  }
}

function resolveInRoot(root: string, p: string): string {
  const resolved = resolve(root, p);
  const rootResolved = resolve(root);
  // 1) lexical containment — catches ../ escapes cheaply.
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  // 2) symlink containment — a symlink INSIDE the root pointing OUTSIDE would pass the lexical check but
  // actually escape. Compare realpaths (both via realpathNearest so a new file's existing parent is resolved).
  const rootReal = realpathNearest(rootResolved);
  const real = realpathNearest(resolved);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`path escapes project root via a symlink: ${p}`);
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

/** Conservative catastrophic-command detector (clearest data/disk-destroying forms only). Exported
 * so the security audit can probe exactly what it does and does NOT catch (the OS sandbox, not this
 * regex, is the real containment - this only stops the clearest accidents/injections even unsandboxed). */
export function dangerousCommand(command: string): string | null {
  const c = String(command).replace(/\s+/g, " ").trim();
    // The dangerous token may be QUOTED (`rm -rf "$HOME"`, `rm -rf "/"`, `rm -rf '~'`) -- without
    // the optional quotes here the seatbelt is bypassed: the quoted target slips through as "allowed".
    if (/\brm\b/.test(c) && /-[a-z]*r/i.test(c) && /-[a-z]*f/i.test(c) && /\s["']?(\/|\/\*|~|\$HOME)["']?(\s|$)/.test(c)) {
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

/** The active todo list as a context block ("" if none), carried through compaction so the plan stays
 * in front of the model on long tasks without mutating the cache-friendly system-message prefix. */
export function todosContextBlock(todos: { content: string; status: string }[]): string {
  return todos.length ? `Current plan (todos):\n${renderTodos(todos)}` : "";
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
  // web_search + web_fetch are handled in execute() (need backend config / a summarizer).
  memory: (_root, args) => memoryTool(args),
  workflow: (_root, args) => workflowTool(args),
  playbook: (_root, args) => playbookTool(args),
};
