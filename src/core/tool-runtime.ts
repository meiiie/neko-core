/**
 * Executable coding-agent tools + the approval gate.
 *
 * read_file / search : safe  -> run immediately.
 * write_file / bash  : gated -> require approval unless approval=auto (--yolo).
 * computer           : host boundary -> requires explicit approval even in auto mode.
 *
 * Each tool returns a STRING observation (errors + denials included) so a failed or denied
 * tool never crashes the agent loop. Mutations stay inside the project or explicit additional roots.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  read,
  readFile,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir as readdirAsync, rm as rmAsync, stat as statAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { McpTools, WebPort } from "./ports.ts";
import { decide, type PermissionMode } from "./permissions.ts";
import { memoryTool } from "./memory.ts";
import { playbookTool } from "./playbook.ts";
import { workflowTool } from "./workflows.ts";
import { destructiveInWorkspace, detectSandbox, executableOnPath, isDockerCommand, sandboxActiveAsync, srtHealthAsync, srtLaunchRefusal, withSrtStateVolumeGuidance, wrapBash } from "./sandbox.ts";
import { effectivePermission, GATED, resolveTool, taskDelegatesReadOnly, toolSchemas } from "./tools.ts";
import { residentUiaHost } from "./windows-uia-host.ts";
import { debug, messageOf } from "../shared/debug.ts";
import { scrubChildEnv } from "../shared/child-env.ts";
import { minimalWindowsSystemEnv, resolveWindowsSystemExecutable } from "../shared/windows-system.ts";
import { MAX_OBS_PAGE_CHARS } from "./agent-constants.ts";
import { deniedCredentialPath } from "./read-policy.ts";
import { isForegroundValidatorOnlyCommand } from "./validation-command.ts";
import { runDiskCleanupScan } from "./disk-cleanup.ts";

import { isJsonObject, isObjectValue, isText } from "../shared/wire.ts";

export { deniedCredentialPath as deniedOutsideRoot } from "./read-policy.ts";

/** An approval gate: given (toolName, the tool's args) -> approve? (may be async).
 * Receiving args lets a UI render a preview/diff before approving. */
export type ApprovalGate = (toolName: string, args: any) => boolean | Promise<boolean>;

/** A host-owned, ephemeral capability intersection for exactly one agent turn. It can only remove
 * tools from the configured/role-restricted registry; it never grants a capability. */
export interface ToolTurnPolicy {
  name: string;
  allowedTools?: Iterable<string>;
  allowBackgroundBash?: boolean;
  /** Canonical project-relative file that `edit` alone may mutate during an exact-file turn. */
  editTarget?: string;
  /** Optional stricter bash contract for a narrow turn. */
  bashPolicy?: "foreground-validator-only";
  reason?: string;
}

export interface ToolTurnLease {
  close(): void;
}

export interface ToolTurnPolicyDescriptor {
  name: string;
  editTarget?: string;
  bashPolicy?: "foreground-validator-only";
  strictEditMatch: boolean;
}

/** Built-ins whose execution can move to a remote native workspace without adding another schema.
 * Host-only tools (computer, skills, memory, web, tasks, and todo state) deliberately stay local. */
export type NativeToolName =
  | "read_file" | "search" | "glob" | "ls"
  | "write_file" | "edit" | "multi_edit" | "bash";

/** Trust statement made by the host-owned remote transport. Core cannot validate a remote inode from
 * the host OS, so the backend owns every lexical, realpath, symlink, hardlink, device, and credential
 * check under this canonical POSIX root. Unsupported features fail closed instead of running locally. */
export interface NativeToolBackendAttestation {
  protocol: "neko-native-posix-v1";
  canonicalPosixRoot: string;
  pathChecks: "backend-enforced";
  structuredWriteConfinement: "backend-enforced";
  exactEditTarget: "backend-enforced" | "unsupported";
  bashSandbox: "backend-enforced" | "unsupported";
  exactValidatorSandbox: "backend-enforced" | "unsupported";
  /** Backend applies the native per-tool observation bounds before returning. */
  boundedObservations: "backend-enforced";
  /** Abort/deadline settlement means the remote process tree is already quiescent. */
  deadlineAndCancellation: "backend-enforced-quiescent";
  /** V1 cannot synchronously participate in ToolRegistry's local checkpoint/rewind API. */
  checkpointRewind: "unsupported";
}

export interface NativeToolCallContext {
  signal?: AbortSignal;
  /** Absolute Unix epoch deadline. The backend must stop and quiesce the remote operation by it. */
  deadlineAt?: number;
  workspace: Readonly<{
    canonicalPosixRoot: string;
    readOutsideRoot: boolean;
    strictEditMatch: boolean;
    /** Raw project-relative spelling; the backend must compare canonical POSIX identities. */
    exactEditTarget?: string;
  }>;
  sandbox: Readonly<{
    enabled: boolean;
    allowNetwork: boolean;
    domains: readonly string[];
    denyReadFiles: readonly string[];
    readOnlyWorkspace: boolean;
  }>;
}

/** A fail-closed execution transport for existing native tools. `execute` must return the ordinary
 * native observation strings (`Edited ...`, `(exit 0)`, etc.) so Agent accounting stays unchanged. */
export interface NativeToolBackend {
  readonly tools: readonly NativeToolName[];
  readonly attestation: NativeToolBackendAttestation;
  execute(
    name: NativeToolName,
    args: Readonly<any>,
    context: NativeToolCallContext,
  ): Promise<string | any[]>;
}

// Leave headroom below core's 48k per-observation guard for the header/continuation hint. Pagination
// must happen here: letting Agent clamp a 100k result would silently discard its middle.
const MAX_READ_BODY_CHARS = MAX_OBS_PAGE_CHARS;
const MAX_INLINE_READ_BYTES = MAX_READ_BODY_CHARS * 4; // UTF-8 is <= 4 bytes/char
const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024;
const MAX_PDF_READ_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LIST = 200;
const MAX_OUTPUT_CHARS = 20_000;
const BASH_TIMEOUT_MS = 60_000;
const BASH_TERMINATE_GRACE_MS = 250;
const BASH_FORCE_WAIT_MS = 750;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
// CIM startup alone can exceed two seconds on a busy Windows workstation. Keep cancellation
// bounded, but leave enough time to capture the descendant set that makes the kill verifiable.
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 5_000;
const MAX_WINDOWS_TREE_PIDS = 256;
const MAX_RESTORE_CONFLICT_PATHS = 20;
const WINDOWS_POWERSHELL = process.platform === "win32"
  ? resolveWindowsSystemExecutable(join("WindowsPowerShell", "v1.0", "powershell.exe"))
  : null;
const WINDOWS_TASKKILL = process.platform === "win32"
  ? resolveWindowsSystemExecutable("taskkill.exe")
  : null;

type BashChild = ReturnType<typeof spawn>;

function readDescriptor(fd: number): Promise<Buffer> {
  return new Promise((resolveRead, rejectRead) => {
    readFile(fd, (error, bytes) => error ? rejectRead(error) : resolveRead(bytes));
  });
}

function readDescriptorChunk(fd: number, buffer: Buffer): Promise<number> {
  return new Promise((resolveRead, rejectRead) => {
    read(fd, buffer, 0, buffer.length, null, (error, bytesRead) =>
      error ? rejectRead(error) : resolveRead(bytesRead));
  });
}

/** Wait for the direct shell to close without letting a broken child stall cancellation forever. */
function waitForBashClose(child: BashChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      child.removeListener("close", done);
      resolve();
    };
    child.once("close", done);
    timer = setTimeout(done, timeoutMs);
  });
}

/** A taskkill process starting successfully is not evidence that its target was terminated. */
export function __taskkillResultSucceededForTest(result: { status: number | null; error?: unknown }): boolean {
  return result.status === 0 && !result.error;
}

type WindowsProcessRow = { pid: number; parentPid: number };

/** Pure tree walk kept exported only as a regression seam for dead-leader Windows cleanup. */
export function __windowsDescendantSnapshotForTest(
  rows: WindowsProcessRow[],
  rootPid: number,
  limit = MAX_WINDOWS_TREE_PIDS,
): any {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0) continue;
    const list = children.get(row.parentPid) ?? [];
    list.push(row.pid);
    children.set(row.parentPid, list);
  }
  const pids: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (pids.length >= limit) return { pids, complete: false };
    pids.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return { pids, complete: true };
}

function trustedWindowsPowerShell(script: string): string | null {
  if (!WINDOWS_POWERSHELL) return null;
  const result = spawnSync(WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: dirname(WINDOWS_POWERSHELL),
    env: minimalWindowsSystemEnv(),
    encoding: "utf-8",
    maxBuffer: 512 * 1024,
    timeout: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
    windowsHide: true,
  });
  return result.status === 0 && !result.error ? String(result.stdout) : null;
}

/** Capture descendants before the graceful attempt. If that attempt removes the leader but leaves a
 * child alive, the saved PIDs still let the force phase address the child directly. */
function snapshotWindowsBashTree(rootPid: number): any {
  const output = trustedWindowsPowerShell(
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { [Console]::Out.WriteLine(('{0},{1}' -f $_.ProcessId, $_.ParentProcessId)) }",
  );
  if (output === null) return { pids: [rootPid], complete: false };
  const rows: WindowsProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+),(\d+)$/.exec(line.trim());
    if (match) rows.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return __windowsDescendantSnapshotForTest(rows, rootPid);
}

/** Windows tree signal through the trusted System32 executable. No PATH/cwd lookup or ambient
 * provider/harness credential reaches the helper. */
function taskkillBashTree(pids: number[], force: boolean): boolean {
  if (!pids.length || !WINDOWS_TASKKILL) return false;
  try {
    const targets = [...new Set(pids)].flatMap((pid) => ["/pid", String(pid)]);
    const result = spawnSync(WINDOWS_TASKKILL, [...targets, "/t", ...(force ? ["/f"] : [])], {
      cwd: dirname(WINDOWS_TASKKILL),
      env: minimalWindowsSystemEnv(),
      stdio: "ignore",
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    });
    return __taskkillResultSucceededForTest(result);
  } catch {
    return false;
  }
}

/** Return captured PIDs that still exist without spawning another helper under cancellation load. */
function liveWindowsProcesses(pids: number[]): number[] {
  const live: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      live.push(pid);
    } catch (error) {
      // EPERM proves the PID still exists even if a higher-integrity child cannot be signalled.
      // SAFETY: contract of the NodeJS.ErrnoException type is established by the surrounding validation/boundary.
      if ((error as NodeJS.ErrnoException).code === "EPERM") live.push(pid);
    }
  }
  return live;
}

/** Signal a fresh POSIX process group, falling back to its direct child only if the group is gone. */
function signalPosixBashTree(child: BashChild, force: boolean): boolean {
  const pid = child.pid;
  if (!pid) return false;
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    try { return child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { return false; }
  }
}

function posixProcessGroupGone(child: BashChild): boolean {
  const pid = child.pid;
  if (!pid) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    // SAFETY: contract of the NodeJS.ErrnoException type is established by the surrounding validation/boundary.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForPosixProcessGroupGone(child: BashChild, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!posixProcessGroupGone(child) && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  return posixProcessGroupGone(child);
}

/** Terminate and verify a spawned command tree. Shared with deterministic benchmark oracles so their
 * timeout/output bounds have the same postcondition as the interactive bash tool. POSIX gets a short
 * graceful phase; Windows must force the live root before its descendant ancestry can be severed. */
export async function terminateProcessTree(child: BashChild): Promise<boolean> {
  if (process.platform === "win32") {
    const pid = child.pid;
    if (!pid) return false;
    const snapshot = snapshotWindowsBashTree(pid);
    // Force the live root tree immediately. A graceful first pass can remove the leader before the
    // force pass, severing the only ancestry taskkill has for a descendant omitted by the CIM snapshot.
    const forced = taskkillBashTree([pid], true);
    if (!forced) {
      try { child.kill("SIGKILL"); } catch { /* already gone; tree cleanup remains unconfirmed */ }
    }
    await waitForBashClose(child, BASH_FORCE_WAIT_MS);
    const survivors = liveWindowsProcesses(snapshot.pids);
    if (survivors.length) taskkillBashTree(survivors, true);
    const remaining = liveWindowsProcesses(snapshot.pids);
    return remaining.length === 0 && (snapshot.complete || forced);
  }

  if (posixProcessGroupGone(child)) return true;
  const graceful = signalPosixBashTree(child, false);
  await waitForBashClose(child, BASH_TERMINATE_GRACE_MS);
  if (graceful && await waitForPosixProcessGroupGone(child, BASH_TERMINATE_GRACE_MS)) return true;
  // Always address the process group/tree again: its shell leader may have exited while a child
  // ignored SIGTERM. A force signal prevents that grandchild from mutating after this call returns.
  signalPosixBashTree(child, true);
  await waitForBashClose(child, BASH_FORCE_WAIT_MS);
  return await waitForPosixProcessGroupGone(child, BASH_FORCE_WAIT_MS);
}

interface ResponsiveChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  aborted: boolean;
  cleanupConfirmed: boolean;
}

/** Bounded subprocess capture for UI-facing helpers. Unlike spawnSync, the terminal can render and
 * process Esc/Ctrl+C while the child is running. Timeout/abort owns and verifies the whole tree. */
async function runResponsiveChild(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    shell?: boolean;
    signal?: AbortSignal;
  },
): Promise<ResponsiveChildResult> {
  if (options.signal?.aborted) {
    return { status: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, cleanupConfirmed: true };
  }
  let child: BashChild;
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // SAFETY: spawn failures surface as Error instances from the child_process API.
    return {
      status: null, signal: null, stdout: "", stderr: "", error: error as Error,
      timedOut: false, aborted: false, cleanupConfirmed: true,
    };
  }
  let stdout = "", stderr = "";
  const append = (target: "stdout" | "stderr", chunk: any) => {
    const value = String(chunk);
    if (target === "stdout") stdout += value.slice(0, Math.max(0, options.maxOutputBytes - stdout.length));
    else stderr += value.slice(0, Math.max(0, options.maxOutputBytes - stderr.length));
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortResolve: (() => void) | undefined;
  const onAbort = () => abortResolve?.();
  const outcome = await Promise.race([
    new Promise<{ kind: "close"; status: number | null; signal: NodeJS.Signals | null }>((resolveClose) =>
      child.once("close", (status, signal) => resolveClose({ kind: "close", status, signal }))),
    new Promise<{ kind: "error"; error: Error }>((resolveError) =>
      child.once("error", (error) => resolveError({ kind: "error", error }))),
    new Promise<{ kind: "timeout" }>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), options.timeoutMs);
      timeout.unref?.();
    }),
    new Promise<{ kind: "abort" }>((resolveAbort) => {
      if (!options.signal) return;
      abortResolve = () => resolveAbort({ kind: "abort" });
      options.signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  options.signal?.removeEventListener("abort", onAbort);
  if (outcome.kind === "close") {
    return { status: outcome.status, signal: outcome.signal, stdout, stderr, timedOut: false, aborted: false, cleanupConfirmed: true };
  }
  if (outcome.kind === "error") {
    return { status: null, signal: null, stdout, stderr, error: outcome.error, timedOut: false, aborted: false, cleanupConfirmed: true };
  }
  const cleanupConfirmed = await terminateProcessTree(child);
  return {
    status: null,
    signal: null,
    stdout,
    stderr,
    timedOut: outcome.kind === "timeout",
    aborted: outcome.kind === "abort",
    cleanupConfirmed,
  };
}

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "dist", "build", ".mypy_cache", ".pytest_cache", ".ruff_cache",
]);
export const autoApprove: ApprovalGate = () => true;
export const denyAll: ApprovalGate = () => false;

const NATIVE_BACKEND_TOOL_NAMES: ReadonlySet<NativeToolName> = new Set([
  "read_file", "search", "glob", "ls", "write_file", "edit", "multi_edit", "bash",
]);

function isNativeBackendToolName(name: string): name is NativeToolName {
  // SAFETY: contract of the NativeToolName type is established by the surrounding validation/boundary.
  return NATIVE_BACKEND_TOOL_NAMES.has(name as NativeToolName);
}

function normalizeNativeBackend(backend?: NativeToolBackend): any {
  if (!backend) return { tools: new Set() };
  const attestation = backend.attestation;
  if (attestation?.protocol !== "neko-native-posix-v1"
    || attestation.pathChecks !== "backend-enforced"
    || attestation.structuredWriteConfinement !== "backend-enforced"
    || attestation.boundedObservations !== "backend-enforced"
    || attestation.deadlineAndCancellation !== "backend-enforced-quiescent"
    || attestation.checkpointRewind !== "unsupported") {
    throw new Error("native tool backend is missing the required confinement/quiescence attestation");
  }
  const root = String(attestation.canonicalPosixRoot ?? "");
  const canonicalSegments = root.split("/").slice(1);
  if (!root.startsWith("/") || root === "/" || root.includes("\\") || root.includes("//")
    || /[\x00-\x1f\x7f]/.test(root)
    || root.endsWith("/") || canonicalSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("native tool backend canonicalPosixRoot must be a canonical absolute POSIX workspace path");
  }
  if (!new Set(["backend-enforced", "unsupported"]).has(attestation.exactEditTarget)
    || !new Set(["backend-enforced", "unsupported"]).has(attestation.bashSandbox)
    || !new Set(["backend-enforced", "unsupported"]).has(attestation.exactValidatorSandbox)) {
    throw new Error("native tool backend has an invalid capability attestation");
  }
  const tools = new Set<NativeToolName>();
  for (const name of backend.tools) {
    if (!isNativeBackendToolName(name)) throw new Error(`native tool backend cannot own host-only tool '${String(name)}'`);
    if (tools.has(name)) throw new Error(`native tool backend declares duplicate ownership of '${name}'`);
    tools.add(name);
  }
  return {
    tools,
    attestation: Object.freeze({ ...attestation, canonicalPosixRoot: root }),
  };
}

/**
 * Executes tool calls under a permission `mode`. A gated tool's decision comes from the
 * mode: allow (auto), prompt (ask the interactive gate), or deny (e.g. plan mode). `mode`
 * is mutable so a REPL can cycle it (Shift+Tab) at runtime.
 */
export class ToolRegistry {
  mode: PermissionMode;
  /** Built-in tools turned off at runtime (via `/tools <name>` in chat). */
  disabled = new Set<string>();
  /** Optional fail-closed capability boundary, used by read-only subagents. */
  toolAllowlist?: Set<string>;
  /** Per-turn capability intersection. Separate from toolAllowlist so a queued/later turn cannot
   * inherit a prior turn's optimization or mutate a subagent's durable role boundary. */
  private turnToolPolicy?: {
    generation: number;
    name: string;
    allowedTools?: Set<string>;
    allowBackgroundBash: boolean;
    editTarget?: { display: string; absolute?: string };
    bashPolicy?: "foreground-validator-only";
    reason: string;
  };
  private turnToolGeneration = 0;
  /** Reads may leave the project root (default). Writes never do. Credential paths are refused either
   * way - see OUTSIDE_DENIED. Set false to restore a hard wall around the project. */
  readOutsideRoot = true;
  /** Extra host-owned directory capabilities. Relative write paths still resolve inside `root`; only
   * an absolute path can select one of these roots. Auto mode changes approval, not this boundary. */
  additionalWriteRoots: string[] = [];
  /** The agent's current todo list (set by the todo_write tool; rendered by the REPL). */
  todos: { content: string; status: string }[] = [];
  /** Opt-in shell hooks around tool calls (set from config). */
  hooks?: { preToolUse?: string; postToolUse?: string };
  /** Additional configured credential env names removed from agent-driven child processes. */
  childSecretEnvNames: string[] = [];
  /** Children disable detached jobs because their private registry cannot expose/stop them later. */
  allowBackgroundBash = true;
  /** Spawns an isolated sub-agent (set by the host); enables the `task` tool. */
  subagent?: (prompt: string, type?: string, signal?: AbortSignal) => Promise<string>;
  /** One-shot model call (set by the host); lets web_fetch extract per a prompt (Claude-style). */
  summarize?: (instruction: string, content: string, schema?: any) => Promise<string>;
  /** Web content acquisition (set by the host; core can't import the web adapter). */
  web?: WebPort;
  /** Opt-in adversarial review of auto-approved mutating actions (set by the host). */
  checkAction?: (toolName: string, args: any) => Promise<{ ok: boolean; reason: string }>;
  /** Appended to every denial observation (set by the host). A non-interactive `neko run` sets this so
   * the model learns the FIRST time a gated call bounces that no approval can ever arrive - otherwise it
   * quietly retries or falls back to a text answer and the caller never learns why the file wasn't
   * written (the "ran fine, produced nothing" delegation failure). */
  denialNote = "";
  /** Load a skill's body by name (set by the wiring layer; core can't import the skills adapter). */
  loadSkill?: (name: string) => { body: string; dir: string } | null;
  /** Optional host-owned, per-turn skill gate. The callback hides named skills; the string removes
   * the whole skill tool for a proven no-domain microtask. Neither mutates the global installation. */
  private skillTurnPolicy?: (name: string) => string | null;
  private skillToolUnavailable = "";
  /** Injected desktop backend for the `computer` tool (set by the host). Default unset = the real
   * Windows UIA/PowerShell path in runComputer. A deterministic simulated GUI world sets this to drive
   * the long-horizon computer-use eval in-process (any OS, no desktop); a future remote/other-OS backend
   * would plug in the same way. Returns the same shape as the real path: a string, or image content parts. */
  computerHandler?: (args: any) => string | any[];
  /** When false (default), catastrophic bash commands are refused even in auto mode (seatbelt). */
  allowDangerousBash = false;
  /** Maximum foreground bash timeout. Product default is 10min; bounded evals can fail fast. */
  bashTimeoutCapMs = 600_000;
  /** Opt-in OS sandbox for bash (fs read-only except cwd). Set from config by the host. */
  sandboxBash = false;
  sandboxAllowNetwork = false;
  /** srt (Windows) only: domain allowlist used when sandboxAllowNetwork is true. */
  sandboxDomains: string[] = [];
  /** Trusted host implementation files hidden from sandboxed benchmark commands. */
  sandboxDenyReadFiles: string[] = [];
  /** When explicitly true AND the sandbox is actually live, bash runs without an approval prompt
   * in default/accept-edits mode - the sandbox is the containment (Claude Code's rationale). */
  sandboxAutoApprove = false;
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
  /** Pre-images plus Neko's last known write. Rewind uses the latter as an optimistic-concurrency
   * token: a newer user/editor change is preserved rather than overwritten. */
  private fileSnapshots = new Map<string, { before: string | null; lastWritten?: string; tainted?: boolean }>();
  /** Remote V1 mutations are deliberately not placed in the host filesystem checkpoint. Rewind
   * reports each one as an explicit conflict instead of claiming it was restored. */
  private remoteMutationPaths = new Set<string>();
  private restoreConflictPaths: string[] = [];
  private restoreConflictCount = 0;
  private readonly nativeBackendTools: ReadonlySet<NativeToolName>;
  private readonly nativeBackendAttestation?: Readonly<NativeToolBackendAttestation>;

  constructor(
    public readonly root: string,
    mode: PermissionMode = "default",
    public prompt: ApprovalGate = denyAll,
    public mcp?: McpTools,
    public readonly nativeBackend?: NativeToolBackend,
  ) {
    this.mode = mode;
    const normalized = normalizeNativeBackend(nativeBackend);
    this.nativeBackendTools = normalized.tools;
    this.nativeBackendAttestation = normalized.attestation;
  }

  /** True while a foreground bash command is running (so the REPL can show the Ctrl+B hint). */
  bashRunning(): boolean {
    return this.detachCurrent !== null;
  }

  /** Start a fresh file checkpoint (call at the start of a turn). */
  clearCheckpoint(): void {
    this.fileSnapshots.clear();
    this.remoteMutationPaths.clear();
    this.restoreConflictPaths = [];
    this.restoreConflictCount = 0;
  }

  /** Refuse a later mutation when bytes have diverged from Neko's previous write. This is a
   * read-only preflight so a known conflict never reaches approval, adversarial review, or hooks. */
  private checkpointMutationRefusal(absPath: string): string | null {
    const snapshot = this.fileSnapshots.get(absPath);
    if (snapshot) {
      if (snapshot.lastWritten !== undefined) {
        try {
          const current = existsSync(absPath) ? readFileSync(absPath, "utf-8") : null;
          if (current !== snapshot.lastWritten) {
            snapshot.tainted = true;
            return "Error: file changed outside Neko since its previous structured write; no further structured mutation was applied. Start a fresh turn after reconciling the user/editor change.";
          }
        } catch (e) {
          snapshot.tainted = true;
          debug("checkpoint", () => `snapshotFile recheck unreadable ${absPath}: ${messageOf(e)}`);
          return "Error: file identity or bytes could not be rechecked after Neko's previous structured write; no further structured mutation was applied.";
        }
      }
      return null;
    }
    return null;
  }

  /** Record a file's current content (once) immediately before its first mutation this turn. */
  private snapshotFile(absPath: string): void {
    if (this.fileSnapshots.has(absPath)) return;
    try {
      this.fileSnapshots.set(absPath, { before: existsSync(absPath) ? readFileSync(absPath, "utf-8") : null });
    } catch (e) {
      debug("checkpoint", () => `snapshotFile unreadable ${absPath}: ${messageOf(e)}`);
    }
  }

  private structuredMutationRefusal(absPath: string, shown: string): string | null {
    const checkpoint = this.checkpointMutationRefusal(absPath);
    if (checkpoint) return checkpoint;
    try {
      assertSingleLinkStructuredTarget(absPath, shown);
      return null;
    } catch (error) {
      return `Error: ${messageOf(error)}`;
    }
  }

  /** Commit or discard the pending pre-image after a structured mutation returns. Failed first
   * attempts leave no undo entry; a later success snapshots whatever bytes exist at that attempt. */
  private finishStructuredMutation(absPath: string, succeeded: boolean): void {
    const snapshot = this.fileSnapshots.get(absPath);
    if (!snapshot) return;
    if (!succeeded) {
      if (snapshot.lastWritten === undefined) this.fileSnapshots.delete(absPath);
      return;
    }
    try {
      snapshot.lastWritten = readFileSync(absPath, "utf-8");
    } catch (e) {
      debug("checkpoint", () => `finishStructuredMutation unreadable ${absPath}: ${messageOf(e)}`);
      if (snapshot.lastWritten === undefined) this.fileSnapshots.delete(absPath);
    }
  }

  private noteRestoreConflict(path: string): void {
    this.restoreConflictCount++;
    if (this.restoreConflictPaths.length >= MAX_RESTORE_CONFLICT_PATHS) return;
    const shown = relative(this.root, path).split(sep).join("/") || path;
    this.restoreConflictPaths.push(shown.slice(0, 512));
  }

  private noteRemoteRestoreConflict(path: string): void {
    this.restoreConflictCount++;
    if (this.restoreConflictPaths.length >= MAX_RESTORE_CONFLICT_PATHS) return;
    const shown = String(path || "(unknown path)").replaceAll("\\", "/").slice(0, 440);
    this.restoreConflictPaths.push(`${shown} (remote backend checkpoint rewind unsupported)`);
  }

  /** Consume bounded conflict paths from the most recent restore attempt. */
  consumeRestoreConflicts(): string[] {
    const out = [...this.restoreConflictPaths];
    const omitted = this.restoreConflictCount - out.length;
    if (omitted > 0) out.push(`... (${omitted} more)`);
    this.restoreConflictPaths = [];
    this.restoreConflictCount = 0;
    return out;
  }

  /** Restore files to their pre-checkpoint state (undo this turn's write/edit/multi_edit). Returns count. */
  restoreCheckpoint(): number {
    let n = 0;
    this.restoreConflictPaths = [];
    this.restoreConflictCount = 0;
    for (const [path, snapshot] of this.fileSnapshots) {
      // A rejected/failed first mutation did not create restorable state.
      if (snapshot.lastWritten === undefined) continue;
      // A user/editor changed the file between two Neko mutations. Even if the latest bytes now
      // match Neko's last write, the original pre-image is no longer a safe rewind destination.
      if (snapshot.tainted) {
        this.noteRestoreConflict(path);
        continue;
      }
      try {
        // Re-resolve immediately before rewind. A path that became a symlink/junction/hardlink
        // after Neko's write must not turn checkpoint restore into an escape from the granted root.
        const resolved = resolveForWrite(this.root, path, this.additionalWriteRoots);
        if (resolved !== path) throw new Error("checkpoint path identity changed");
        assertSingleLinkStructuredTarget(path, path);
        const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
        if (current !== snapshot.lastWritten) {
          this.noteRestoreConflict(path);
          continue;
        }
        if (snapshot.before === null) {
          if (existsSync(path)) { rmSync(path); n++; }
        } else {
          writeFileSync(path, snapshot.before, "utf-8");
          n++;
        }
      } catch (e) {
        this.noteRestoreConflict(path);
        debug("checkpoint", () => `restoreCheckpoint failed ${path}: ${messageOf(e)}`);
      }
    }
    for (const path of this.remoteMutationPaths) this.noteRemoteRestoreConflict(path);
    this.fileSnapshots.clear();
    this.remoteMutationPaths.clear();
    return n;
  }

  /** Ctrl+B: move the currently-running bash command to the background. Returns false if none runs. */
  detachRunningBash(): boolean {
    if (!this.allowBackgroundBash || this.turnToolPolicy?.allowBackgroundBash === false) return false;
    if (!this.detachCurrent) return false;
    this.detachCurrent();
    return true;
  }

  isToolAvailable(name: string): boolean {
    return !this.noTools
      && !this.disabled.has(name)
      && (!this.toolAllowlist || this.toolAllowlist.has(name))
      && (!this.turnToolPolicy?.allowedTools || this.turnToolPolicy.allowedTools.has(name))
      && !(name === "skill" && this.skillToolUnavailable);
  }

  /** Enter one ephemeral turn boundary. Nested turns on the same registry are a lifecycle bug: the
   * caller must settle and close the current turn before draining queued input. */
  enterTurn(policy: ToolTurnPolicy): ToolTurnLease {
    if (this.turnToolPolicy) throw new Error("turn tool policy is already active");
    const generation = ++this.turnToolGeneration;
    const editTarget = String(policy.editTarget ?? "").trim();
    const remoteEdit = this.nativeBackendTools.has("edit");
    this.turnToolPolicy = {
      generation,
      name: String(policy.name || "turn"),
      ...(policy.allowedTools ? { allowedTools: new Set(policy.allowedTools) } : undefined),
      allowBackgroundBash: policy.allowBackgroundBash !== false,
      ...(editTarget ? {
        editTarget: {
          display: editTarget.replaceAll("\\", "/"),
          // Never ask the host OS to resolve a path in a remote POSIX workspace. A supporting
          // backend receives the raw target and attests that it compares canonical identities.
          ...(remoteEdit ? undefined : { absolute: canonicalRegularFileForWrite(this.root, editTarget, this.additionalWriteRoots) }),
        },
      } : undefined),
      ...(policy.bashPolicy ? { bashPolicy: policy.bashPolicy } : undefined),
      reason: String(policy.reason ?? "").trim(),
    };
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        if (this.turnToolPolicy?.generation === generation) this.turnToolPolicy = undefined;
      },
    };
  }

  /** Read-only projection for host context/UX. Never expose the mutable allowlist or lease generation. */
  turnPolicyDescriptor(): Readonly<ToolTurnPolicyDescriptor> | undefined {
    const policy = this.turnToolPolicy;
    if (!policy) return undefined;
    return Object.freeze({
      name: policy.name,
      ...(policy.editTarget ? { editTarget: policy.editTarget.display } : undefined),
      ...(policy.bashPolicy ? { bashPolicy: policy.bashPolicy } : undefined),
      strictEditMatch: Boolean(policy.editTarget),
    });
  }

  setSkillPolicyForTurn(policy?: (name: string) => string | null, toolUnavailableReason = ""): void {
    this.skillTurnPolicy = policy;
    this.skillToolUnavailable = toolUnavailableReason;
  }

  skillUnavailableReason(name: string): string | null {
    return this.skillTurnPolicy?.(name) ?? null;
  }

  /** Intersect with an explicit capability set; a child can only lose authority. */
  allowOnlyTools(names: Iterable<string>): void {
    const requested = new Set(names);
    this.toolAllowlist = this.toolAllowlist
      ? new Set([...this.toolAllowlist].filter((name) => requested.has(name)))
      : requested;
  }

  private nativeBackendFor(name: string): NativeToolBackend | undefined {
    return isNativeBackendToolName(name) && this.nativeBackendTools.has(name)
      ? this.nativeBackend
      : undefined;
  }

  private bashTimeoutMs(args: any): number {
    return Math.min(
      Math.max(Math.floor(Number(args.timeout) || BASH_TIMEOUT_MS), 1000),
      Math.min(600_000, Math.max(1_000, this.bashTimeoutCapMs)),
    );
  }

  /** Run a shell command. Resolves on exit/timeout, OR early (kept running) if Ctrl+B detaches it. */
  private async exactValidatorSandboxRefusal(backend?: NativeToolBackend, signal?: AbortSignal): Promise<string | null> {
    if (!this.sandboxBash) {
      return "Error: exact-file validation requires a live OS sandbox with the project mounted read-only; bash was not executed.";
    }
    if (backend) {
      if (this.nativeBackendAttestation?.exactValidatorSandbox !== "backend-enforced") {
        return "Error: the remote native backend does not attest a read-only exact-validator sandbox; bash was not executed.";
      }
      return null;
    }
    const kind = detectSandbox();
    if (kind === "srt") {
      const health = await srtHealthAsync(signal);
      if (signal?.aborted) return "(interrupted)";
      const unhealthy = srtLaunchRefusal(true, kind, health);
      if (unhealthy) return unhealthy;
    }
    if (kind === "none" || !(await sandboxActiveAsync(signal))) {
      if (signal?.aborted) return "(interrupted)";
      return "Error: exact-file validation requires a live OS sandbox with the project mounted read-only; bash was not executed.";
    }
    return null;
  }

  private async runBash(args: any, signal?: AbortSignal): Promise<string> {
    const command = requireArg(args, "command");
    if (args.run_in_background === true && this.turnToolPolicy?.allowBackgroundBash === false) {
      return `Error: background bash is unavailable for this turn (${this.turnToolPolicy.name}).`;
    }
    if (args.run_in_background === true && !this.allowBackgroundBash) {
      return "Error: background bash is unavailable in a sub-agent; run it in the parent session so /bashes can inspect and stop it.";
    }
    // A pre-cancelled turn must never launch a process, especially a persistent background job.
    if (signal?.aborted) return "(interrupted)";
    // Per-call timeout (default 60s, clamped to [1s, 10min]) so slow builds/tests aren't cut off.
    const timeoutMs = this.bashTimeoutMs(args);
    const exactValidator = this.turnToolPolicy?.bashPolicy === "foreground-validator-only";
    const exactRefusal = exactValidator ? await this.exactValidatorSandboxRefusal(undefined, signal) : null;
    if (exactRefusal) return exactRefusal;
    if (signal?.aborted) return "(interrupted)";
    const sandboxKind = this.sandboxBash ? detectSandbox() : "none";
    const refusal = sandboxKind === "srt"
      ? srtLaunchRefusal(this.sandboxBash, sandboxKind, await srtHealthAsync(signal))
      : null;
    if (refusal) return refusal;
    if (signal?.aborted) return "(interrupted)";
    const sb = wrapBash(command, this.root, {
      enabled: this.sandboxBash,
      allowNetwork: this.sandboxAllowNetwork,
      domains: this.sandboxDomains,
      allowHostDaemon: exactValidator ? false : this.allowDangerousBash,
      readOnlyWorkspace: exactValidator,
      denyReadFiles: this.sandboxDenyReadFiles,
      additionalWriteRoots: this.additionalWriteRoots,
    });
    // Agent-presence opt-in: desktop helpers read NEKO_PRESENCE to show the independent cursor + honour takeover.
    // Desktop input backend opt-in: NEKO_INPUT picks the non-hijacking (inject) vs legacy (sendinput) path.
    const env: NodeJS.ProcessEnv = scrubChildEnv(process.env, this.childSecretEnvNames);
    Object.assign(env, sb.env);
    if (this.presence) env.NEKO_PRESENCE = "1";
    if (this.inputBackend && this.inputBackend !== "auto") env.NEKO_INPUT = this.inputBackend;
    let child: BashChild;
    try {
      child = spawn(sb.file, sb.args, {
        shell: sb.shell,
        cwd: this.root,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      sb.cleanup?.();
      throw error;
    }
    // A script can contain credentials. Keep it only while the process may still read it; cleanup
    // covers foreground, background, detach, timeout, abort and spawn errors.
    child.once("close", () => sb.cleanup?.());
    child.once("error", () => sb.cleanup?.());
    // Cap LIVE accumulation so a runaway command (`yes`, an infinite echo loop) can't grow the buffer
    // to gigabytes and OOM the process before the timeout fires.
    const MAX_BASH_OUTPUT = 200_000;

    // Model-initiated background (run_in_background): start it, return immediately, and keep
    // accumulating output into a record the user reads with /bashes. For servers/watchers/long jobs.
    if (args.run_in_background === true) {
      const id = `bg${++this.bgCounter}`;
      // SAFETY: contract of the number | null | undefined type is established by the surrounding validation/boundary.
      const bg = { id, command, output: "", done: false, code: undefined as number | null | undefined };
      const grab = (d: any) => { bg.output += d.toString().slice(0, Math.max(0, MAX_BASH_OUTPUT - bg.output.length)); };
      child.stdout?.on("data", grab);
      child.stderr?.on("data", grab);
      child.on("close", (code) => { bg.done = true; bg.code = code; });
      child.on("error", (err) => {
        bg.done = true;
        bg.output += `\nError: ${err.message}`.slice(0, Math.max(0, MAX_BASH_OUTPUT - bg.output.length));
      });
      this.backgrounds.push(bg);
      return `Running in background [${id}]: ${command}\nCheck its output later with /bashes.`;
    }

    let output = "";
    const onData = (d: any) => { output += d.toString().slice(0, Math.max(0, MAX_BASH_OUTPUT - output.length)); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let detach!: () => void;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => abortResolve?.({ kind: "abort" });
    let abortResolve: ((value: { kind: "abort" }) => void) | undefined;
    const outcome = await Promise.race([
      new Promise<{ kind: "exit"; code: number | null; signal: NodeJS.Signals | null }>((res) => child.on("close", (code, signal) => res({ kind: "exit", code, signal }))),
      new Promise<{ kind: "error"; err: Error }>((res) => child.on("error", (err) => res({ kind: "error", err }))),
      new Promise<{ kind: "timeout" }>((res) => { timeoutHandle = setTimeout(() => res({ kind: "timeout" }), timeoutMs); }),
      new Promise<{ kind: "detach" }>((res) => { detach = () => res({ kind: "detach" }); this.detachCurrent = detach; }),
      new Promise<{ kind: "abort" }>((res) => {
        if (!signal) return;
        abortResolve = res;
        if (signal.aborted) return res({ kind: "abort" });
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onAbort);
    this.detachCurrent = null;

    // Esc / Ctrl+C while a command runs: terminate the entire shell tree, not just its leader.
    if (outcome.kind === "abort") {
      const stopped = await terminateProcessTree(child);
      sb.cleanup?.();
      const warning = stopped ? "" : "\n(process-tree cleanup could not be confirmed)";
      return `(interrupted)${warning}\n${capOutput(output)}`.trimEnd();
    }
    if (outcome.kind === "error") {
      const result = `Error: ${outcome.err.message}`;
      return sandboxKind === "srt" ? withSrtStateVolumeGuidance(result) : result;
    }
    if (outcome.kind === "timeout") {
      const stopped = await terminateProcessTree(child);
      sb.cleanup?.();
      const warning = stopped ? "" : "\n(process-tree cleanup could not be confirmed)";
      const result = `(timed out after ${timeoutMs}ms)${warning}\n${capOutput(output)}`.trimEnd();
      return sandboxKind === "srt" ? withSrtStateVolumeGuidance(result) : result;
    }
    if (outcome.kind === "detach") {
      const id = `bg${++this.bgCounter}`;
      // SAFETY: contract of the number | null | undefined type is established by the surrounding validation/boundary.
      const bg = { id, command, output, done: false, code: undefined as number | null | undefined };
      // Keep accumulating into the background record (the same `output` string is snapshotted; rebind).
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdout?.on("data", (d: any) => { bg.output += d.toString().slice(0, Math.max(0, MAX_BASH_OUTPUT - bg.output.length)); });
      child.stderr?.on("data", (d: any) => { bg.output += d.toString().slice(0, Math.max(0, MAX_BASH_OUTPUT - bg.output.length)); });
      child.on("close", (code) => { bg.done = true; bg.code = code; });
      this.backgrounds.push(bg);
      return `Running in background [${id}]: ${command}\nCheck output with /bashes.`;
    }
    const result = __formatBashExitForTest(outcome.code, output, outcome.signal);
    return sandboxKind === "srt" && outcome.code !== 0
      ? withSrtStateVolumeGuidance(result)
      : result;
  }

  private async runNativeBackend(
    backend: NativeToolBackend,
    name: NativeToolName,
    args: any,
    signal?: AbortSignal,
  ): Promise<string | any[]> {
    const attestation = this.nativeBackendAttestation;
    if (!attestation) throw new Error("native backend attestation is unavailable");
    if (name === "bash" && signal?.aborted) return "(interrupted)";
    if (name === "bash" && this.sandboxBash && attestation.bashSandbox !== "backend-enforced") {
      return "Error: the remote native backend does not attest the configured bash sandbox; bash was not executed.";
    }
    const exactValidator = name === "bash" && this.turnToolPolicy?.bashPolicy === "foreground-validator-only";
    const context: NativeToolCallContext = {
      ...(signal ? { signal } : undefined),
      ...(name === "bash" ? { deadlineAt: Date.now() + this.bashTimeoutMs(args) } : undefined),
      workspace: Object.freeze({
        canonicalPosixRoot: attestation.canonicalPosixRoot,
        readOutsideRoot: this.readOutsideRoot,
        strictEditMatch: name === "edit" && Boolean(this.turnToolPolicy?.editTarget),
        ...(name === "edit" && this.turnToolPolicy?.editTarget
          ? { exactEditTarget: this.turnToolPolicy.editTarget.display }
          : undefined),
      }),
      sandbox: Object.freeze({
        enabled: this.sandboxBash,
        allowNetwork: this.sandboxAllowNetwork,
        domains: Object.freeze([...this.sandboxDomains]),
        denyReadFiles: Object.freeze([...this.sandboxDenyReadFiles]),
        readOnlyWorkspace: exactValidator,
      }),
    };
    try {
      const out = await backend.execute(name, Object.freeze({ ...args }), context);
      if (!isText(out) && !Array.isArray(out)) {
        throw new Error("returned an invalid native observation");
      }
      return out;
    } catch (error) {
      if (signal?.aborted) return "(interrupted)";
      throw new Error(`native backend failed for ${name}: ${messageOf(error)}`);
    }
  }

  /** Progressive disclosure: return a skill's full instructions on demand so the model can go deep on
   * a domain it just decided is relevant, without that body ever sitting in context unused. */
  private runSkill(args: any): string {
    const name = String(requireArg(args, "name"));
    const unavailable = this.skillUnavailableReason(name);
    if (unavailable) return `(skill '${name}' is unavailable for this turn: ${unavailable})`;
    const s = this.loadSkill?.(name);
    if (!s) return `(no skill '${name}' in Neko's catalog - do not search for or read a provider-native skill path; continue with the available Neko tools or report the missing capability)`;
    const files = s.dir
      ? `(skill files dir: ${s.dir} - run any bundled scripts from here by absolute path)`
      : "(project skill is prompt-only; do not execute files from its live project directory)";
    return `# Skill: ${name}\n${files}\n${s.body}`;
  }

  /** All tool schemas shown to the model: enabled built-in + connected MCP tools. */
  schemas(): any[] {
    if (this.noTools) return []; // perception mode: a vision-only endpoint 400s if sent any tools
    return [
      ...toolSchemas()
        .filter((s) => !(s.function.name === "disk_cleanup_scan" && !this.readOutsideRoot))
        .filter((s) => this.isToolAvailable(s.function.name))
        .map((schema) => this.schemaForTurn(schema)),
      ...(this.mcp?.toolSchemas() ?? []).filter((s) => {
        const name = String(s?.function?.name ?? "");
        // SAFETY: contract of the NativeToolName type is established by the surrounding validation/boundary.
        return !this.nativeBackendTools.has(name as NativeToolName) && this.isToolAvailable(name);
      }),
    ];
  }

  /** Clone and narrow model-facing schemas for a turn. Runtime checks remain authoritative; this only
   * prevents the model wasting a round on an action the active lease will refuse. */
  private schemaForTurn(schema: any): any {
    const name = String(schema?.function?.name ?? "");
    const fn = schema?.function;
    const parameters = fn?.parameters;
    const properties = parameters?.properties;
    if (name === "edit" && this.turnToolPolicy?.editTarget && properties) {
      const target = this.turnToolPolicy.editTarget.display;
      return {
        ...schema,
        function: {
          ...fn,
          description: `Edit only ${target} in this exact-file turn. old_string must match current bytes exactly once; re-read after any mismatch.`,
          parameters: {
            ...parameters,
            properties: {
              ...properties,
              path: { ...properties.path, description: `The only allowed file for this turn: ${target}.` },
              old_string: { ...properties.old_string, description: "Exact current bytes to replace; must occur exactly once. Whitespace-tolerant matching is disabled. For a small change, prefer the shortest unique substring and omit line-number padding or unnecessary leading indentation." },
            },
          },
        },
      };
    }
    if (name === "bash" && this.turnToolPolicy?.bashPolicy === "foreground-validator-only" && properties) {
      const { run_in_background: _background, ...validatorProperties } = properties;
      return {
        ...schema,
        function: {
          ...fn,
          description: "Run foreground validators only (test, typecheck, lint, check, verify) in an isolated read-only project workspace. Project test code may write only to a unique temporary directory. Every && segment must be a validator; build targets, fix/write/snapshot-update flags, masking, redirection, substitution, and background execution are unavailable.",
          parameters: {
            ...parameters,
            properties: {
              ...validatorProperties,
              command: { ...properties.command, description: "Foreground validator command in a read-only project workspace. Validator && validator is allowed; build targets, ordinary shell probes, and mutating flags are not." },
            },
          },
        },
      };
    }
    return schema;
  }

  async execute(name: string, args: any, signal?: AbortSignal): Promise<string | any[]> {
    if (!isJsonObject(args)) {
      return `Error: arguments for ${name} must be an object`;
    }
    const nativeBackend = this.nativeBackendFor(name);
    if (this.noTools) {
      return `Tool '${name}' is unavailable because tools are disabled for this request.`;
    }
    if (this.disabled.has(name)) {
      return `Tool '${name}' is disabled (enable with /tools ${name}).`;
    }
    if (this.toolAllowlist && !this.toolAllowlist.has(name)) {
      return `Tool '${name}' is not available to this sub-agent.`;
    }
    if (this.turnToolPolicy?.allowedTools && !this.turnToolPolicy.allowedTools.has(name)) {
      const why = this.turnToolPolicy.reason ? `: ${this.turnToolPolicy.reason}` : "";
      return `Tool '${name}' is not available for this turn (${this.turnToolPolicy.name})${why}.`;
    }
    if (name === "bash" && args.run_in_background === true && this.turnToolPolicy?.allowBackgroundBash === false) {
      return `Error: background bash is unavailable for this turn (${this.turnToolPolicy.name}).`;
    }
    if (name === "edit" && this.turnToolPolicy?.editTarget) {
      if (nativeBackend) {
        if (this.nativeBackendAttestation?.exactEditTarget !== "backend-enforced") {
          return "Error: the remote native backend does not support canonical exact-file identity; edit was not executed.";
        }
      } else {
        let requested: string;
        try {
          requested = canonicalRegularFileForWrite(this.root, requireArg(args, "path"), this.additionalWriteRoots);
        } catch (error) {
          return `Error: ${messageOf(error)}`;
        }
        if (requested !== this.turnToolPolicy.editTarget.absolute) {
          return `Tool 'edit' is restricted to ${this.turnToolPolicy.editTarget.display} for this turn (${this.turnToolPolicy.name}).`;
        }
      }
    }
    if (name === "bash" && this.turnToolPolicy?.bashPolicy === "foreground-validator-only"
      && !isForegroundValidatorOnlyCommand(String(args.command ?? ""), args)) {
      return `Tool 'bash' is restricted to a foreground validator in an isolated read-only project workspace for this turn (${this.turnToolPolicy.name}). ` +
        "Run one or more recognized test/typecheck/lint/check/verify commands joined only by &&; build targets, source-fixing flags, shell substitution, redirection, masking, and background execution are unavailable.";
    }
    if (name === "bash" && this.turnToolPolicy?.bashPolicy === "foreground-validator-only") {
      const refusal = await this.exactValidatorSandboxRefusal(nativeBackend, signal);
      if (refusal) return refusal;
    }
    if (name === "skill" && this.skillToolUnavailable) {
      return `Tool 'skill' is unavailable for this turn: ${this.skillToolUnavailable}`;
    }
    if (name === "task" && signal?.aborted) return "(interrupted)";

    // A trusted hook is executable policy. Run it only after the native/MCP permission decision,
    // so a denied action cannot mutate through its hook. Read-only reviewer/explorer tasks skip
    // parent hooks entirely; their SAFE/parallel contract must remain side-effect free.
    const preHookApplies = Boolean(this.hooks?.preToolUse)
      && !(name === "task" && taskDelegatesReadOnly(args));
    const runPreHook = async (): Promise<string | null> => {
      const r = await runResponsiveChild(this.hooks!.preToolUse!, [], {
        shell: true, cwd: this.root, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, signal,
        env: { ...scrubChildEnv(process.env, this.childSecretEnvNames), NEKO_TOOL: name, NEKO_ARGS: JSON.stringify(args) },
      });
      if (r.aborted) return "(interrupted)";
      if (r.status !== 0) {
        const reason = r.timedOut ? "timed out after 10s"
          : r.error ? r.error.message
          : `exit ${r.status ?? "?"}`;
        const cleanup = r.cleanupConfirmed ? "" : " (process-tree cleanup unconfirmed)";
        return `Blocked by pre_tool_use hook (${reason})${cleanup}: ${String(r.stderr || r.stdout || "").trim().slice(0, 200)}`;
      }
      return null;
    };

    // Seatbelt: refuse clearly catastrophic bash even in auto mode (not a full sandbox - a
    // last-resort guard against accidents / prompt injection). Override: allow_dangerous_bash.
    if (name === "bash" && !this.allowDangerousBash) {
      if (this.mode === "auto" && isDockerCommand(String(args.command ?? ""))) {
        return "Refused: Docker/podman uses the host daemon outside Neko's OS sandbox. In auto mode this requires the explicit allow_dangerous_bash override.";
      }
      const danger = dangerousCommand(String(args.command ?? ""));
      if (danger) return `Refused: '${danger}' is blocked as catastrophic. Set "allow_dangerous_bash": true in config to override.`;
    }

    // web_search: pick the best configured backend (SearXNG > Tavily > DuckDuckGo).
    if (name === "web_search") {
      const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;
      if (!this.web) return "Error: web adapter is not configured";
      return this.web.search(String(args.query ?? ""), { searxngUrl: this.searxngUrl, backend: this.searchBackend, keepaliveMin: this.searxngKeepalive, tavilyKey: this.tavilyKey });
    }

    // web_fetch: fetch the page, then (if a prompt + summarizer are available) extract just what
    // was asked via a single model pass — instead of dumping the whole page into context.
    if (name === "web_fetch") {
      const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;
      if (!this.web) return "Error: web adapter is not configured";
      return this.web.fetch(this.root, args, this.scrapeBackend, this.summarize);
    }

    // exit_plan_mode: always asks the user to approve the plan (the plan-review gate).
    if (name === "exit_plan_mode") {
      const ok = await this.prompt(name, args);
      if (!ok) return "The user did NOT approve the plan. Ask what to change, then call exit_plan_mode again with a revised plan.";
      const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;
      return "Plan approved by the user. Implement it now.";
    }

    // todo_write: safe, no approval — record the plan for the REPL to render.
    if (name === "todo_write") {
      const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;
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
      const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;
      const names = Array.isArray(args.names) ? args.names.map(String) : [String(args.name ?? "")].filter(Boolean);
      return this.mcp.loadTools(names);
    }

    // MCP tools default to gated. A trusted adapter may explicitly declare a read-only call safe.
    if (!nativeBackend && this.mcp?.has(name)) {
      const declaredSafe = this.mcp.permission?.(name) === "safe";
      const decision = declaredSafe ? "allow" : this.mode === "auto" ? "allow" : this.mode === "plan" ? "deny" : "prompt";
      if (decision === "deny") return `Blocked: ${name} (MCP) is not allowed in 'plan' mode.`;
      if (decision === "prompt" && !(await this.prompt(name, args))) {
        return `Denied by user: ${name}${this.denialNote ? `\n${this.denialNote}` : ""}`;
      }
      // Auto-approved + adversarial review on: vet the call (MCP tools are a prime injection vector).
      if (!declaredSafe && decision === "allow" && this.checkAction) {
        const v = await this.checkAction(name, args);
        if (!v.ok) return `Blocked by adversarial check: ${v.reason || "looks unsafe"}`;
      }
      const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;
      try {
        return await this.mcp.call(name, args, signal);
      } catch (error) {
        // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
        return `Error: ${(error as Error).message}`;
      }
    }

    let structuredPath: string | undefined;
    let spec;
    try {
      spec = resolveTool(name);
      const structuredMutation = name === "write_file" || name === "edit" || name === "multi_edit";
      structuredPath = !nativeBackend && structuredMutation && args.path
        ? resolveForWrite(this.root, String(args.path), this.additionalWriteRoots)
        : undefined;
    } catch (error) {
      // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
      return `Error: ${(error as Error).message}`;
    }
    if (structuredPath) {
      const refusal = this.structuredMutationRefusal(structuredPath, String(args.path));
      if (refusal) return refusal;
    }

    // Sandboxed-bash auto-approval keys off LIVE confinement (primitive present + provisioned),
    // never off config intent alone - see decide() for the policy rationale. It is WITHHELD for
    // commands that irreversibly destroy data inside the workspace: the sandbox contains the blast
    // radius, but the user's own code + .git are writable, so those still get one confirmation.
    // (mode=auto/yolo still allows everything - that's the point of yolo; always-allow-bash too.)
    const needsLiveSandboxDecision = spec.name === "bash" && this.sandboxBash
      && this.sandboxAutoApprove && this.mode !== "auto";
    const liveBashSandbox = nativeBackend
      ? this.nativeBackendAttestation?.bashSandbox === "backend-enforced"
      : needsLiveSandboxDecision ? await sandboxActiveAsync(signal) : false;
    if (signal?.aborted) return "(interrupted)";
    const sandboxedBash = spec.name === "bash" && this.sandboxBash && this.sandboxAutoApprove
      && liveBashSandbox && !destructiveInWorkspace(String(args.command ?? ""))
      && !isDockerCommand(String(args.command ?? "")); // docker runs unsandboxed -> don't sandbox-auto-approve it
    const decision = decide(this.mode, spec, args, { sandboxedBash });
    if (decision === "deny") {
      return `Blocked: ${name} is not allowed in '${this.mode}' mode (read-only).`;
    }
    if (decision === "prompt" && !(await this.prompt(name, args))) {
      return `Denied by user: ${name} (${describe(name, args)})${this.denialNote ? `\n${this.denialNote}` : ""}`;
    }
    // Adversarial review: when a mutating tool is auto-approved (no human in the loop), a model
    // pass vets it for prompt injection / destructive intent before it runs.
    if (decision === "allow" && effectivePermission(spec, args) === GATED && this.checkAction) {
      const v = await this.checkAction(name, args);
      if (!v.ok) return `Blocked by adversarial check: ${v.reason || "looks unsafe"}`;
    }
    if (structuredPath) {
      const refusal = this.structuredMutationRefusal(structuredPath, String(args.path));
      if (refusal) return refusal;
    }
    const blocked = preHookApplies ? await runPreHook() : null; if (blocked) return blocked;

    // A generic/custom child inherits mutating authority, so task reaches this point only after the
    // ordinary gated decision. reviewer/explorer are dynamically safe and capability-restricted by
    // the host builder. The parent signal is the child's cancellation authority.
    if (name === "task") {
      if (signal?.aborted) return "(interrupted)"; // approval/review may have waited after the early check
      if (!this.subagent) return "Sub-agents are not available in this context.";
      const prompt = String(args.prompt ?? args.description ?? "");
      if (!prompt) return "Error: task needs a 'prompt'.";
      try {
        return await this.subagent(prompt, args.subagent_type ? String(args.subagent_type) : undefined, signal);
      } catch (error) {
        // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
        return signal?.aborted ? "(interrupted)" : `Sub-agent error: ${(error as Error).message}`;
      }
    }

    try {
      if (structuredPath) {
        const refusal = this.structuredMutationRefusal(structuredPath, String(args.path));
        if (refusal) return refusal;
        this.snapshotFile(structuredPath);
      }
      // SAFETY: contract of the NativeToolName type is established by the surrounding validation/boundary.
      const out = nativeBackend ? await this.runNativeBackend(nativeBackend, name as NativeToolName, args, signal)
        : name === "bash" ? await this.runBash(args, signal)
        : name === "read_file" ? await this.runReadFile(args, signal)
        : name === "disk_cleanup_scan" ? (this.readOutsideRoot
          ? await runDiskCleanupScan(signal)
          : "Error: disk_cleanup_scan is disabled because read_outside_root=false sets a hard project read wall.")
        : name === "skill" ? this.runSkill(args)
        : name === "computer" ? await this.runComputer(args, signal)
        : await DISPATCH[name](this.root, args, {
          readOutsideRoot: this.readOutsideRoot,
          additionalWriteRoots: this.additionalWriteRoots,
          childSecretEnvNames: this.childSecretEnvNames,
          strictEditMatch: name === "edit" && Boolean(this.turnToolPolicy?.editTarget),
          exactEditTarget: name === "edit" ? this.turnToolPolicy?.editTarget?.absolute : undefined,
          signal,
        });
      if (structuredPath) {
        const succeeded = isText(out) && (name === "write_file" ? out.startsWith("Wrote ") : out.startsWith("Edited "));
        this.finishStructuredMutation(structuredPath, succeeded);
      }
      if (nativeBackend && (name === "write_file" || name === "edit" || name === "multi_edit")) {
        const succeeded = isText(out) && (name === "write_file" ? out.startsWith("Wrote ") : out.startsWith("Edited "));
        if (succeeded) this.remoteMutationPaths.add(String(args.path ?? "(unknown path)"));
      }
      await this.runPostHook(name, args, isText(out) ? out : "[image]", signal);
      return out;
    } catch (error) {
      if (structuredPath) this.finishStructuredMutation(structuredPath, false);
      // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
      return `Error: ${(error as Error).message}`;
    }
  }

  /** read_file with media awareness: images -> vision content (if enabled), PDFs -> extracted text,
   * everything else -> the line-numbered text path. */
  private async runReadFile(args: any, signal?: AbortSignal): Promise<string | any[]> {
    const raw = requireArg(args, "path");
    const path = resolveForRead(this.root, raw, this.readOutsideRoot);
    if (!existsSync(path)) return `Error: no such file: ${raw}`;
    const ext = (raw.split(".").pop() ?? "").toLowerCase();
    if (IMAGE_EXTS.has(ext) || ext === "pdf") {
      const opened = openRegularFile(path, raw);
      try {
        const cap = IMAGE_EXTS.has(ext) ? MAX_IMAGE_READ_BYTES : MAX_PDF_READ_BYTES;
        if (opened.size > cap) return `Error: ${ext === "pdf" ? "PDF" : "image"} exceeds the ${Math.floor(cap / 1024 / 1024)} MiB read limit: ${raw}`;
        const bytes = await readDescriptor(opened.fd);
        if (IMAGE_EXTS.has(ext)) return renderImageFile(bytes, raw, ext, this.vision);
        return await readPdfFile(bytes, raw, args, this.root, this.childSecretEnvNames, signal);
      } finally {
        try { closeSync(opened.fd); } catch { /* Bun streams may close an adopted fd despite autoClose:false. */ }
      }
    }
    return await toolReadFile(this.root, args, {
      readOutsideRoot: this.readOutsideRoot,
      additionalWriteRoots: this.additionalWriteRoots,
    });
  }

  /** First-class desktop/GUI control (Windows): dispatches to the computer-use skill's accessibility-tree
   * scripts. Reads/acts on a window BY NAME (no vision); pointer acts use touch injection (no mouse hijack).
   * Unicode element names go through a temp UTF-8 file (@file) -- the cp1252 console mangles non-ASCII args. */
  private async runComputer(args: any, signal?: AbortSignal): Promise<string | any[]> {
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
    const env: NodeJS.ProcessEnv = scrubChildEnv(process.env, this.childSecretEnvNames);
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
        // Set-of-Marks: a `mark` (an [N] from the last ocr) is the preferred, grounding-free target -
        // it resolves to coords in the resident host, so a text model never emits pixels. x,y still work.
        const hasMark = args.mark !== undefined && Number.isInteger(Number(args.mark));
        const x = Number(args.x), y = Number(args.y);
        if (!hasMark && (!Number.isFinite(x) || !Number.isFinite(y))) return "Error: computer click needs a 'mark' number from a prior ocr, or numeric 'x' and 'y'.";
        // One-shot fallback path only (resident is default): mark can't resolve without the warm host.
        script = "inject.ps1"; sa = hasMark ? ["tap", "0", "0"] : ["tap", String(Math.round(x)), String(Math.round(y))]; break;
      }
      case "stroke": {
        const nums = Array.isArray(args.points) ? args.points.map((n: any) => Number(n)) : [];
        if (nums.length < 4 || nums.length % 2 !== 0 || nums.some((n: number) => !Number.isFinite(n))) return "Error: computer stroke needs an even 'points' array of NUMBERS [x1,y1,x2,y2,...] (>= 2 points).";
        script = "inject.ps1"; sa = ["stroke", ...nums.map((n: number) => String(Math.round(n)))]; break;
      }
      case "type": {
        if (!isText(args.text) || !args.text.length) return "Error: computer type needs non-empty 'text'.";
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
      if (!skill) return "Error: the trusted built-in/global computer-use support pack is unavailable.";
      if (!WINDOWS_POWERSHELL) return "Error: trusted Windows PowerShell was not found under System32.";
      const scriptsDir = join(skill.dir, "scripts");
      let residentOutput: string | null = null;
      if (this.residentUia && ["list", "read", "get", "ocr", "watch", "invoke", "setvalue", "toggle", "click", "stroke", "type", "key", "scroll", "wait", "screenshot"].includes(action)) {
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
            mark: args.mark === undefined ? undefined : Math.round(Number(args.mark)),
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
        if (action === "click" && args.mark !== undefined) return "Error: click by mark needs the resident host (computer_use_resident). Enable it and re-run ocr, or use a freshly verified screenshot with explicit x,y.";
        const r = await runResponsiveChild(
          WINDOWS_POWERSHELL,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scriptsDir, script), ...sa],
          { cwd: this.root, env, timeoutMs: 90_000, maxOutputBytes: 8 * 1024 * 1024, signal },
        );
        // Surface failures instead of swallowing them into "(no output)" — the agent can only adapt to a
        // failure it can SEE (same contract as the rest of the loop). Timeout/spawn error -> r.error.
        if (r.aborted) return `(interrupted)${r.cleanupConfirmed ? "" : "\n(process-tree cleanup could not be confirmed)"}`;
        if (r.error) return `Error: computer ${action} could not run PowerShell: ${r.error.message}`;
        if (r.timedOut) {
          return `Error: computer ${action} timed out after 90s (the PowerShell action hung).` +
            (r.cleanupConfirmed ? "" : " Process-tree cleanup could not be confirmed.");
        }
        out = r.stdout.trim(); err = r.stderr.trim();
        if (r.status && r.status !== 0) return `Error: computer ${action} failed (PowerShell exit ${r.status}). ${err || out || ""}`.trim();
      }
      if (capturePath) {
        if (!existsSync(capturePath)) return `Error: computer screenshot did not create an image. ${err || out || ""}`.trim();
        // Return the observation itself, not a dead temp-file path. This closes the GUI loop in one
        // tool round-trip: with vision on, the next model call sees the screen; without it, the legacy
        // saved path remains available to the separate vision helper. Keep scale/view dimensions because
        // grounded coordinates must map back to physical pixels. The temp image is removed in finally
        // after its bytes have been embedded in the result.
        const observation = renderImageFile(readFileSync(capturePath), "desktop screenshot", "gif", this.vision);
        if (isText(observation)) return [out, observation].filter(Boolean).join("\n");
        const info = out.replace(/^saved\s+.*?\s+(?=view=)/i, "captured ");
        let annotated = false;
        return observation.map((part: any) => {
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

  /** post_tool_use hook: ordered after the tool, but asynchronous so rendering/input stay live. */
  private async runPostHook(name: string, args: any, result: string, signal?: AbortSignal): Promise<void> {
    if (!this.hooks?.postToolUse) return;
    try {
      const outcome = await runResponsiveChild(this.hooks.postToolUse, [], {
        shell: true, cwd: this.root, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, signal,
        env: { ...scrubChildEnv(process.env, this.childSecretEnvNames), NEKO_TOOL: name, NEKO_ARGS: JSON.stringify(args), NEKO_RESULT: String(result).slice(0, 4000) },
      });
      if (outcome.status !== 0 && !outcome.aborted) {
        debug("hook", () => `post_tool_use hook failed for ${name}: ${outcome.timedOut ? "timeout" : outcome.error?.message ?? `exit ${outcome.status ?? "?"}`}`);
      }
      } catch (e) {
        debug("hook", () => `post_tool_use hook threw for ${name}: ${messageOf(e)}`);
      }
  }
}

async function toolReadFile(root: string, args: any, opts: ToolOpts): Promise<string> {
  const raw = requireArg(args, "path");
  const path = resolveForRead(root, raw, opts.readOutsideRoot);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  const opened = openRegularFile(path, raw);
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1)); // 1-based
  const column = Math.max(1, Math.floor(Number(args.column) || 1)); // 1-based
  const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : undefined;
  try {
    if (opened.size > MAX_INLINE_READ_BYTES) return await readLargeFileWindow(opened.fd, raw, offset, column, limit);
    let text: string;
    try {
      text = (await readDescriptor(opened.fd)).toString("utf-8");
    } catch {
      return `Error: cannot read file: ${raw}`;
    }
    return formatReadWindow(text.split("\n"), raw, offset, column, limit);
  } finally {
    try { closeSync(opened.fd); } catch { /* best effort; never replace a successful bounded read */ }
  }
}

/** Open one already-resolved path without following a last-moment link or blocking on a device/FIFO. */
function openRegularFile(path: string, raw: string): any {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error(`not a regular file: ${raw}`);
  if (before.nlink !== 1) throw new Error(`not a single-link regular file: ${raw}`);
  let flags = constants.O_RDONLY;
  if (process.platform !== "win32") flags |= constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`not a regular file: ${raw}`);
    if (opened.nlink !== 1) throw new Error(`not a single-link regular file: ${raw}`);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== before.nlink) {
      throw new Error(`file changed while opening: ${raw}`);
    }
    return { fd, size: opened.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
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
async function readLargeFileWindow(fd: number, raw: string, offset: number, column = 1, limit?: number): Promise<string> {
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
  const consume = (text: string): void => {
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
  };
  // Read from the already-validated descriptor. Bun's createReadStream currently closes adopted
  // descriptors asynchronously even with autoClose:false, which can race a later open that reuses
  // the same descriptor number. A bounded synchronous chunk loop keeps ownership deterministic.
  const decoder = new TextDecoder("utf-8");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let lastYield = performance.now();
  while (!stopped) {
    const count = await readDescriptorChunk(fd, buffer);
    if (count === 0) break;
    consume(decoder.decode(buffer.subarray(0, count), { stream: true }));
    if (performance.now() - lastYield >= 8) {
      await new Promise<void>((resolveYield) => setTimeout(resolveYield, 0));
      lastYield = performance.now();
    }
  }
  if (!stopped) consume(decoder.decode());
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
function renderImageFile(buf: Buffer, raw: string, ext: string, vision: boolean): string | any[] {
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
async function readPdfFile(
  bytes: Buffer,
  raw: string,
  args: any,
  root: string,
  childSecretEnvNames: Iterable<string>,
  signal?: AbortSignal,
): Promise<string> {
  const exe = executableOnPath("pdftotext", process.env.PATH ?? "", root);
  if (!exe) return `[PDF ${raw}] - text extraction needs 'pdftotext' (poppler) on PATH (not found). Install it, or open the pages with a vision model.`;
  const dir = mkdtempSync(join(tmpdir(), "neko-pdf-"));
  const path = join(dir, "document.pdf");
  try {
    await writeFileAsync(path, bytes, { flag: "wx", mode: 0o600 });
    const r = await runResponsiveChild(exe, ["-layout", path, "-"], {
      cwd: root,
      maxOutputBytes: 16 * 1024 * 1024,
      timeoutMs: 30_000,
      env: scrubChildEnv(process.env, childSecretEnvNames),
      signal,
    });
    if (r.aborted) return `(interrupted)${r.cleanupConfirmed ? "" : "\n(process-tree cleanup could not be confirmed)"}`;
    if (r.error) return `Error extracting PDF: ${r.error.message}`;
    if (r.timedOut) return `Error extracting PDF: timed out after 30s${r.cleanupConfirmed ? "" : " (process-tree cleanup unconfirmed)"}`;
    const text = r.stdout;
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
  } finally {
    await rmAsync(dir, { recursive: true, force: true });
  }
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

async function toolSearch(root: string, args: any, opts: ToolOpts): Promise<string> {
  const pattern = requireArg(args, "pattern");
  // Search through descriptor-verified reads. A recursive external process cannot prove that an
  // innocently named file is not a hard-link alias to a credential inode.
  return await jsSearch(root, pattern, args, opts);
}

/** Turn an rg exit into an observation. Exit 2 means "an error occurred" - INCLUDING one unreadable
 * file in an otherwise fine tree (a Windows `nul`, a vanished temp file, a permission hole), where
 * stdout still carries every real match. Treating any exit-2 as fatal threw the whole search away
 * over one bad file (field report: `rg: .\nul: Incorrect function`); it is fatal only when NOTHING
 * matched, and partial trouble is a note under the matches instead. Exported for tests. */
export function formatRipgrepResult(status: number | null, stdout: string, stderr: string): string {
  const lines = stdout.split("\n").filter(Boolean);
  if (status === 2 && !lines.length) return `Error: ${stderr.trim().slice(0, 200) || "search failed"}`; // e.g. bad regex
  if (!lines.length) return "(no matches)";
  const shown = lines.slice(0, MAX_SEARCH_MATCHES).map((l) => l.replace(/\\/g, "/"));
  if (lines.length > MAX_SEARCH_MATCHES) shown.push(`... (truncated at ${MAX_SEARCH_MATCHES} matches)`);
  if (status === 2) {
    const first = stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    shown.push(`(some files could not be read${first ? `: ${first.slice(0, 120)}` : ""})`);
  }
  return shown.join("\n");
}

/** Built-in regex walk — the fallback when ripgrep isn't installed. Also supports glob/case/context. */
async function jsSearch(root: string, pattern: string, args: any, opts: ToolOpts): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.case_insensitive ? "i" : "");
  } catch (error) {
    // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
    return `Error: invalid regex: ${(error as Error).message}`;
  }
  const base = resolveForRead(root, args.path || ".", opts.readOutsideRoot);
  const rootResolved = resolve(root);
  const ctx = Math.max(0, Math.min(5, Math.floor(Number(args.context) || 0)));
  const glob = args.glob ? new Bun.Glob(String(args.glob)) : null;
  const matches: string[] = [];
  let lastYield = performance.now();
  for await (const file of walkFilesAsync(base, opts.signal)) {
    if (opts.signal?.aborted) return "(interrupted)";
    if (glob) {
      const relToBase = relative(base, file).split(sep).join("/");
      if (!glob.match(relToBase) && !glob.match(file.split(sep).pop() ?? "")) continue;
    }
    let text: string;
    let opened: ReturnType<typeof openRegularFile> | undefined;
    try {
      opened = openRegularFile(file, relative(rootResolved, file));
      if (opened.size > MAX_SEARCH_FILE_BYTES) continue;
      text = (await readDescriptor(opened.fd)).toString("utf-8");
    } catch {
      continue; // binary / unreadable
    } finally {
      if (opened) try { closeSync(opened.fd); } catch { /* best effort */ }
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
    if (performance.now() - lastYield >= 8) {
      await new Promise<void>((resolveYield) => setTimeout(resolveYield, 0));
      lastYield = performance.now();
    }
  }
  return matches.length ? matches.join("\n") : "(no matches)";
}

async function toolGlob(root: string, args: any, opts: ToolOpts): Promise<string> {
  const pattern = requireArg(args, "pattern");
  const base = resolveForRead(root, args.path || ".", opts.readOutsideRoot);
  const rootResolved = resolve(root);
  const results: string[] = [];
  try {
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({ cwd: base, onlyFiles: true })) {
      if (opts.signal?.aborted) return "(interrupted)";
      const abs = resolve(base, rel);
      if (deniedReadPath(abs)) continue;
      const relToRoot = relative(rootResolved, abs).split(sep).join("/");
      if (relToRoot.split("/").some((seg) => IGNORE_DIRS.has(seg))) continue;
      results.push(relToRoot);
      if (results.length >= MAX_LIST) {
        results.push(`... (truncated at ${MAX_LIST})`);
        break;
      }
    }
  } catch (error) {
    // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
    return `Error: ${(error as Error).message}`;
  }
  return results.length ? results.sort().join("\n") : "(no files)";
}

async function toolLs(root: string, args: any, opts: ToolOpts): Promise<string> {
  const raw = args.path || ".";
  const path = resolveForRead(root, raw, opts.readOutsideRoot);
  let info;
  try { info = await statAsync(path); }
  catch { return `Error: no such directory: ${raw}`; }
  if (!info.isDirectory()) return `Error: not a directory: ${raw}`;
  const entries = (await readdirAsync(path, { withFileTypes: true }))
    .filter((e) => !IGNORE_DIRS.has(e.name) && !deniedReadPath(join(path, e.name)))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  let out = entries.slice(0, MAX_LIST).join("\n") || "(empty)";
  if (entries.length > MAX_LIST) out += `\n... (${entries.length - MAX_LIST} more)`;
  return out;
}

function toolWriteFile(root: string, args: any, opts: ToolOpts): string {
  const raw = requireArg(args, "path");
  const content = args.content;
  if (content === undefined || content === null) throw new Error("missing required argument: content");
  const path = resolveForWrite(root, raw, opts.additionalWriteRoots);
  const existed = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  assertSingleLinkStructuredTarget(path, raw);
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

function toolEdit(root: string, args: any, opts: ToolOpts): string {
  const raw = requireArg(args, "path");
  const oldStr = args.old_string;
  const newStr = args.new_string;
  if (oldStr === undefined || oldStr === null) throw new Error("missing required argument: old_string");
  if (newStr === undefined || newStr === null) throw new Error("missing required argument: new_string");
  const path = resolveForWrite(root, raw, opts.additionalWriteRoots);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  assertSingleLinkStructuredTarget(path, raw);
  if (opts.exactEditTarget && canonicalRegularFileForWrite(root, raw, opts.additionalWriteRoots) !== opts.exactEditTarget) {
    return `Error: exact-file target identity changed before read: ${raw}`;
  }
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
  } else if (opts.strictEditMatch) {
    return `Error: exact-file edit requires old_string to match current bytes exactly once in ${raw} ` +
      `(found ${occurrences}). The file may have changed since read_file; re-read it and use the shortest unique exact substring without line-number padding or unnecessary leading indentation. No change written.`;
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
  assertSingleLinkStructuredTarget(path, raw);
  if (opts.exactEditTarget && canonicalRegularFileForWrite(root, raw, opts.additionalWriteRoots) !== opts.exactEditTarget) {
    return `Error: exact-file target identity changed before write: ${raw}`;
  }
  writeFileSync(path, text, "utf-8");
  return editDiff(raw, origLines, startLine, removed, newLines);
}

/** Apply several exact-match edits to one file, in order, atomically (writes only if all succeed). */
function toolMultiEdit(root: string, args: any, opts: ToolOpts): string {
  const raw = requireArg(args, "path");
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return "Error: multi_edit needs a non-empty 'edits' array";
  if (edits.length > 100) return "Error: multi_edit accepts at most 100 edits (no change written)";
  const path = resolveForWrite(root, raw, opts.additionalWriteRoots);
  if (!existsSync(path)) return `Error: no such file: ${raw}`;
  assertSingleLinkStructuredTarget(path, raw);
  let text = readFileSync(path, "utf-8");
  let added = 0;
  let removed = 0;
  for (let k = 0; k < edits.length; k++) {
    const edit = edits[k];
    if (!isJsonObject(edit) || !isText(edit.old_string)) {
      return `Error: edit ${k + 1} needs string old_string (no change written)`;
    }
    if (!Object.prototype.hasOwnProperty.call(edit, "new_string") || !isText(edit.new_string)) {
      return `Error: edit ${k + 1} needs string new_string (no change written)`;
    }
    const oldStr = edit.old_string;
    const newStr = edit.new_string;
    if (!oldStr) return `Error: edit ${k + 1} is missing old_string (no change written)`;
    const occ = text.split(oldStr).length - 1;
    if (occ === 0) return `Error: edit ${k + 1}: old_string not found (no change written)`;
    if (occ > 1) return `Error: edit ${k + 1}: old_string occurs ${occ} times, not unique (no change written)`;
    text = text.replace(oldStr, () => newStr);
    removed += oldStr.split("\n").length;
    added += newStr.split("\n").length;
  }
  assertSingleLinkStructuredTarget(path, raw);
  writeFileSync(path, text, "utf-8");
  return `Edited ${raw}  (${edits.length} edits, +${added} -${removed})`;
}

/** Keep native bash completion machine-readable. A null close code means signal/unknown termination,
 * never success; this seam also makes that rare process event deterministic in regression tests. */
export function __formatBashExitForTest(code: number | null, output: string, signal: string | null = null): string {
  if (code === null) {
    const cause = signal ? ` (signal ${signal})` : "";
    return `Error: bash process ended without an exit code${cause}.\n${capOutput(output)}`.trimEnd();
  }
  const tag = code === 0 ? "(exit 0)" : `(exit ${code} -- command FAILED)`;
  return `${tag}\n${capOutput(output)}`.trimEnd();
}

function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated at ${MAX_OUTPUT_CHARS} chars)` : s;
}

function requireArg(args: any, key: string): string {
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
    // Native realpath is required on Windows: the generic implementation can preserve an 8.3
    // spelling such as RUNNER~1 while a configured capability was canonicalized to the long path.
    const real = realpathSync.native(probe);
    return probe === p ? real : real + p.slice(probe.length); // re-attach the not-yet-existing tail
  } catch {
    return p;
  }
}

/** Apply the credential deny policy to both the requested spelling and its real filesystem target.
 * The realpath check closes innocently named symlink/junction aliases into key stores. */
function deniedReadPath(path: string): string | null {
  const lexical = deniedCredentialPath(path);
  if (lexical) return lexical;
  const real = realpathNearest(path);
  const canonical = real === path ? null : deniedCredentialPath(real);
  if (canonical) return canonical;
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && stat.nlink !== 1) return "a multiply-linked file";
  } catch { /* missing paths are handled by the caller */ }
  return null;
}

function pathWithin(basePath: string, candidatePath: string): boolean {
  const base = process.platform === "win32" ? basePath.toLowerCase() : basePath;
  const candidate = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  return candidate === base || candidate.startsWith(base + sep);
}

/**
 * Resolve a path for a READ. Credential material is refused everywhere. For ordinary paths outside
 * the root, the host decides: `allowOutside` opens reads while the closed mode keeps the old wall.
 * Writes never come through here - they keep `resolveInRoot`.
 */
function resolveForRead(root: string, p: string, allowOutside: boolean): string {
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, p);
  const denied = deniedReadPath(resolved);
  if (denied) throw new Error(`refused: ${denied} is never read, inside the project or out: ${p}`);
  if (!allowOutside) return resolveInRoot(root, p);
  if (pathWithin(rootResolved, resolved)) return resolveInRoot(root, p);
  return resolved;
}

function resolveInRoot(root: string, p: string): string {
  const resolved = resolve(root, p);
  const rootResolved = resolve(root);
  // 1) lexical containment — catches ../ escapes cheaply.
  if (!pathWithin(rootResolved, resolved)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  // 2) symlink containment — a symlink INSIDE the root pointing OUTSIDE would pass the lexical check but
  // actually escape. Compare realpaths (both via realpathNearest so a new file's existing parent is resolved).
  const rootReal = realpathNearest(rootResolved);
  const real = realpathNearest(resolved);
  if (!pathWithin(rootReal, real)) {
    throw new Error(`path escapes project root via a symlink: ${p}`);
  }
  return resolved;
}

/** Resolve a structured mutation against the project plus explicit additional directory capabilities.
 * An allowed root is still canonicalized, so a symlink/junction inside it cannot escape to another
 * directory. Credential/device paths remain immutable outside the project even when their parent was
 * granted broadly. */
function resolveForWrite(root: string, p: string, additionalRoots: readonly string[]): string {
  const primary = resolve(root);
  const resolved = resolve(primary, p);
  if (pathWithin(primary, resolved)) return resolveInRoot(root, p);
  const targetReal = realpathNearest(resolved);
  for (const rawRoot of additionalRoots) {
    const allowed = resolve(rawRoot);
    const allowedReal = realpathNearest(allowed);
    if (!pathWithin(allowedReal, targetReal)) {
      // Preserve the specific escape diagnostic when the requested spelling starts inside a grant
      // but a child link redirects it elsewhere. A platform-owned alias above the grant (macOS
      // `/var`, Windows 8.3 names) is different: its canonical target is inside allowedReal.
      if (!pathWithin(allowed, resolved)) continue;
      throw new Error(`path escapes additional write root via a symlink: ${p}`);
    }
    const denied = deniedReadPath(resolved) ?? deniedReadPath(targetReal);
    if (denied) throw new Error(`refused: ${denied} may not be modified outside the project: ${p}`);
    // Never continue mutation through the alias spelling after admission: use the already-resolved
    // canonical parent plus the not-yet-existing tail.
    return targetReal;
  }
  return resolveInRoot(root, p);
}

/** Existing multiply-linked files can alias an inode outside the workspace even when their path is
 * inside it. Refuse them immediately before every structured read/write; creating a new file is OK. */
function assertSingleLinkStructuredTarget(path: string, shown: string): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile() && stat.nlink !== 1) {
    throw new Error(`refused multiply-linked structured-write target: ${shown}`);
  }
}

/** Resolve a pre-existing direct regular file without accepting a symlink/junction spelling. Exact-file
 * turn policy is a capability boundary, so a project cannot swap its named target for an in-root alias. */
function canonicalRegularFileForWrite(root: string, p: string, additionalRoots: readonly string[]): string {
  const path = resolveForWrite(root, p, additionalRoots);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`not a canonical regular file: ${p}`);
  const real = realpathSync(path);
  if (relative(path, real) !== "") throw new Error(`not a canonical regular file: ${p}`);
  return real;
}

async function* walkFilesAsync(base: string, signal?: AbortSignal): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdirAsync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal?.aborted) return;
    const path = join(base, entry.name);
    if (deniedReadPath(path)) continue;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      yield* walkFilesAsync(path, signal);
    } else if (entry.isFile()) {
      yield path;
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

function describe(name: string, args: any): string {
  if (name === "write_file") return `write ${args.path ?? "?"}`;
  if (name === "edit") return `edit ${args.path ?? "?"}`;
  if (name === "bash") return `run: ${args.command ?? "?"}`;
  return name;
}

export interface ToolOpts {
  readOutsideRoot: boolean;
  additionalWriteRoots: readonly string[];
  childSecretEnvNames?: Iterable<string>;
  /** Exact-file leases refuse the legacy whitespace-tolerant edit fallback. */
  strictEditMatch?: boolean;
  /** Canonical identity captured when the exact-file lease was entered. */
  exactEditTarget?: string;
  signal?: AbortSignal;
}

const DISPATCH: any = {
  read_file: toolReadFile,
  search: toolSearch,
  glob: toolGlob,
  ls: toolLs,
  write_file: toolWriteFile,
  edit: toolEdit,
  multi_edit: toolMultiEdit,
  // bash is handled by ToolRegistry.runBash (needs instance state for Ctrl+B backgrounding).
  // web_search + web_fetch are handled in execute() (need backend config / a summarizer).
  memory: (_root: string, args: any) => memoryTool(args),
  workflow: (_root: string, args: any) => workflowTool(args),
  playbook: (_root: string, args: any) => playbookTool(args),
};
