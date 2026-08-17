/**
 * Optional OS-level sandbox for the `bash` tool (like Claude Code / Codex CLI). When enabled, bash
 * runs with the filesystem READ-ONLY except the workspace, explicit additional write roots (+ /tmp),
 * and optionally with no network.
 *
 *   Linux   -> bubblewrap (bwrap): unprivileged namespaces.
 *   macOS   -> sandbox-exec (Seatbelt): SBPL profile.
 *   Windows -> Anthropic sandbox-runtime (srt): runs the command as a dedicated `srt-sandbox`
 *              user under a restricted token in a job object; NTFS ACLs confine writes and a
 *              WFP egress fence blocks network (one-time `srt windows-install` provisioning).
 *   else    -> "none": bash runs unconfined, but the catastrophic-command seatbelt +
 *              permission gate still apply (documented in WEB/SANDBOX).
 *
 * File tools and bash share the same project-plus-explicit-roots capability boundary. Pure + node-only
 * (no adapter imports) so it stays in core.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimalWindowsSystemEnv, resolveWindowsSystemExecutable } from "../shared/windows-system.ts";

export type SandboxKind = "bwrap" | "sandbox-exec" | "srt" | "none";
export interface SpawnTarget {
  file: string;
  args: string[];
  shell: boolean;
  /** Host-owned environment overrides required by this confinement profile. */
  env?: Record<string, string>;
  /** Remove per-launch material after the child closes. Must be safe to call more than once. */
  cleanup?: () => void;
  /** The primitive itself guarantees that a normal launcher close cannot leave descendants alive. */
  treeContainedOnClose?: boolean;
}

let cached: SandboxKind | undefined;
let cachedPrimitive: string | null | undefined;

/** Resolve a security-relevant executable from explicit PATH entries only. Windows `where` searches
 * cwd first, which lets an untrusted checkout replace `srt.exe`, `git.exe`, or another primitive. */
export function executableOnPath(
  cmd: string,
  pathValue = process.env.PATH ?? "",
  workspace = process.cwd(),
  platform = process.platform,
): string | null {
  const requestedWorkspace = resolve(workspace);
  const workspaceRoot = (() => {
    try { return realpathSync(requestedWorkspace); } catch { return requestedWorkspace; }
  })();
  const withinWorkspace = (candidate: string): boolean => {
    const normalized = resolve(candidate);
    const base = platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
    const value = platform === "win32" ? normalized.toLowerCase() : normalized;
    return value === base || value.startsWith(base + sep);
  };
  const names = platform === "win32" && !/\.exe$/i.test(cmd) ? [`${cmd}.exe`, cmd] : [cmd];
  for (const rawDir of pathValue.split(delimiter)) {
    const trimmed = rawDir.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    const requestedDir = resolve(trimmed);
    const dir = (() => {
      try { return realpathSync(requestedDir); } catch { return requestedDir; }
    })();
    // A repo may deliberately add itself to PATH. That must not make it a source of confinement.
    if (withinWorkspace(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      try {
        const real = realpathSync(candidate);
        if (withinWorkspace(real)) continue;
        const stat = statSync(real);
        if (stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) return real;
      } catch { /* reject missing, linked-away, or non-regular candidates */ }
    }
  }
  return null;
}

let winBashCached: string | null | undefined;

/** Locate a POSIX bash (Git-Bash / MSYS) on Windows so the `bash` tool actually runs bash — NOT
 * cmd.exe (which chokes on the Unix idioms a model naturally emits: heredocs, single-quotes, $VAR,
 * pipelines) and NOT WSL's C:\Windows\System32\bash.exe (which can't see the Windows-drive cwd our
 * workspace uses). Prefers NEKO_BASH, then a Git install, then a git-derived path. null if none. */
export function findWindowsBash(): string | null {
  if (winBashCached !== undefined) return winBashCached;
  const trusted = (candidate: string | undefined): string | null => {
    if (!candidate || !isAbsolute(candidate)) return null;
    // Reuse the canonical regular-file/workspace exclusion used for every security primitive. The
    // explicit env knob is authority to choose an external Bash, not authority for a checkout-local
    // symlink/junction to become the shell enforcing confinement.
    return executableOnPath(basename(candidate), dirname(candidate), process.cwd(), "win32");
  };
  const env = process.env.NEKO_BASH;
  const configured = trusted(env);
  if (configured) return (winBashCached = configured);
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
  ];
  for (const r of roots) {
    if (!r) continue;
    for (const sub of ["Git\\bin\\bash.exe", "Git\\usr\\bin\\bash.exe"]) {
      const p = join(r, sub);
      const accepted = trusted(p);
      if (accepted) return (winBashCached = accepted);
    }
  }
  // Derive from git on PATH: <gitroot>\cmd\git.exe (or \bin\git.exe) -> <gitroot>\bin\bash.exe.
  // Deliberately ignore System32\bash.exe (WSL) by only trusting a git-relative bash.
  const git = executableOnPath("git.exe");
  if (git && !/\\System32\\/i.test(git)) {
    const p = join(dirname(dirname(git)), "bin", "bash.exe");
    const accepted = trusted(p);
    if (accepted) return (winBashCached = accepted);
  }
  return (winBashCached = null);
}

let srtCached: string | null | undefined;

/** Locate the sandbox-runtime CLI (`srt.exe`) on Windows. Only a real .exe is trusted: npm's
 * .cmd shims route argv through cmd.exe, whose quoting a hostile command string can escape --
 * defeating the very sandbox being launched. `bun add -g @anthropic-ai/sandbox-runtime`
 * installs the .exe shim. null if none. */
export function findSrt(refresh = false): string | null {
  if (!refresh && srtCached !== undefined) return srtCached;
  if (refresh) srtCached = undefined;
  // Bun's global bin directory is not automatically added to PATH on every Windows installation.
  // It is still a stable user-owned install root, unlike cwd/the checked-out repository.
  const installRoots = [
    process.env.BUN_INSTALL && join(process.env.BUN_INSTALL, "bin"),
    join(homedir(), ".bun", "bin"),
  ].filter((value): value is string => Boolean(value));
  const installed = executableOnPath("srt.exe", installRoots.join(delimiter));
  if (installed) return (srtCached = installed);
  return (srtCached = executableOnPath("srt.exe"));
}

let srtProvisionedCached: boolean | undefined;
export interface SrtHealthResult { ok: boolean; detail: string }
export interface SrtHealthCacheEntry { result: SrtHealthResult; checkedAt: number }
let srtHealthCached: SrtHealthCacheEntry | undefined;
let srtHealthPending: Promise<SrtHealthResult> | undefined;
const SRT_UNHEALTHY_CACHE_MS = 30_000;
const WINDOWS_NET = process.platform === "win32" ? resolveWindowsSystemExecutable("net.exe") : null;
const WINDOWS_ICACLS = process.platform === "win32" ? resolveWindowsSystemExecutable("icacls.exe") : null;

export interface SrtBunBridge {
  readonly path: string;
  readonly source: "runtime" | "path" | "npm-global" | "official-installer";
}

/** Split a PATH value into Windows-style directories. Git Bash exports a POSIX-style list
 * ("/c/...:/usr/bin:...") whose entries a `;` split cannot see, so drive mounts are normalized
 * first; a compiled Neko launched from either parent shell then resolves tools identically. */
export function windowsSearchDirs(pathValue: string): string[] {
  if (!pathValue) return [];
  if (!pathValue.includes(";") && /(^|:)\/[A-Za-z]\//.test(pathValue)) {
    return pathValue.split(":").filter(Boolean).map((entry) =>
      entry.replace(/^\/([A-Za-z])\//, (_match, drive: string) => `${drive.toUpperCase()}:/`).replace(/\//g, "\\"));
  }
  return pathValue.split(";");
}

/** Select one exact Bun executable for Windows SRT. Per-user tool installs are invisible to the
 * sandbox account unless SRT grants them explicitly, but granting a package/profile directory is
 * unnecessarily broad. Sources, strongest first: the running Bun (source-run identity); a real
 * bun.exe on a trusted PATH; the npm-global layout where `bun.cmd` shims sit on PATH but the real
 * exe lives in node_modules/bun/bin (the common Windows install); the official installer's
 * ~/.bun/bin. Workspace candidates are never promoted. */
export function resolveSrtBunBridge(
  workspace = process.cwd(),
  runtimeExecutable = process.execPath,
  pathValue = process.env.PATH ?? "",
  platform = process.platform,
  appdataValue = process.env.APPDATA ?? "",
  userProfileValue = process.env.USERPROFILE ?? process.env.HOME ?? "",
): SrtBunBridge | null {
  if (platform !== "win32") return null;
  let workspaceRoot: string;
  try { workspaceRoot = realpathSync(resolve(workspace)); } catch { workspaceRoot = resolve(workspace); }
  const rootFolded = workspaceRoot.toLowerCase();
  const rootPrefix = rootFolded.endsWith(sep) ? rootFolded : rootFolded + sep;
  const candidates: Array<{ path: string; source: SrtBunBridge["source"] }> = [];
  if (basename(runtimeExecutable).toLowerCase() === "bun.exe") {
    candidates.push({ path: runtimeExecutable, source: "runtime" });
  }
  const dirs = windowsSearchDirs(pathValue);
  const onPath = executableOnPath("bun.exe", dirs.join(delimiter), workspace, platform);
  if (onPath) candidates.push({ path: onPath, source: "path" });
  // npm shims: `bun.cmd`/`bun.ps1` on PATH without bun.exe -> npm nests the real binary one level down.
  for (const dir of dirs) {
    if (existsSync(join(dir, "bun.cmd")) || existsSync(join(dir, "bun.ps1"))) {
      candidates.push({ path: join(dir, "node_modules", "bun", "bin", "bun.exe"), source: "npm-global" });
    }
  }
  if (appdataValue) candidates.push({ path: join(appdataValue, "npm", "node_modules", "bun", "bin", "bun.exe"), source: "npm-global" });
  if (userProfileValue) candidates.push({ path: join(userProfileValue, ".bun", "bin", "bun.exe"), source: "official-installer" });

  for (const candidate of candidates) {
    try {
      // SRT/Git-Bash bridging below intentionally supports only a local drive path. UNC/device
      // spellings have different parsing and ACL semantics, so they fail closed.
      if (!isAbsolute(candidate.path) || !/^[A-Za-z]:[\\/]/.test(candidate.path)) continue;
      const canonical = realpathSync(candidate.path);
      if (basename(canonical).toLowerCase() !== "bun.exe" || !statSync(canonical).isFile()) continue;
      const folded = canonical.toLowerCase();
      if (folded === rootFolded || folded.startsWith(rootPrefix)) continue;
      return Object.freeze({ path: canonical, source: candidate.source });
    } catch { /* missing, linked-away, non-regular, or otherwise unreadable -> reject */ }
  }
  return null;
}

/** Whether the one-time `srt windows-install` provisioning (the srt-sandbox account) has run.
 * Without it srt refuses to launch, so bash under sandbox fails closed with srt's own message. */
export function srtProvisioned(refresh = false): boolean {
  if (!refresh && srtProvisionedCached !== undefined) return srtProvisionedCached;
  if (refresh) srtProvisionedCached = undefined;
  if (!WINDOWS_NET) return (srtProvisionedCached = false);
  try {
    return (srtProvisionedCached = spawnSync(WINDOWS_NET, ["user", "srt-sandbox"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
      env: minimalWindowsSystemEnv(),
    }).status === 0);
  } catch {
    return (srtProvisionedCached = false);
  }
}

interface AsyncProbeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
}

/** Run a tiny host-owned probe without blocking Ink's event loop. SRT itself owns a kill-on-close
 * Windows Job, so terminating the broker also contains its probe child. Output is diagnostic-only
 * and bounded before it reaches the health cache. */
function runAsyncProbe(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<AsyncProbeResult> {
  return new Promise((resolveProbe) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    const finish = (result: AsyncProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe(result);
    };
    const append = (current: string, chunk: any) => {
      if (current.length >= 64 * 1024) return current;
      return current + String(chunk).slice(0, 64 * 1024 - current.length);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error: NodeJS.ErrnoException) => finish({ status: null, signal: null, error, stdout, stderr }));
    child.once("close", (status, signal) => {
      const error = timedOut
        ? Object.assign(new Error("sandbox health probe timed out"), { code: "ETIMEDOUT" })
        : undefined;
      finish({ status, signal, error, stdout, stderr });
    });
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already closed */ }
    }, options.timeoutMs);
    timer.unref?.();
  });
}

async function srtProvisionedAsync(refresh = false): Promise<boolean> {
  if (!refresh && srtProvisionedCached !== undefined) return srtProvisionedCached;
  if (refresh) srtProvisionedCached = undefined;
  if (!WINDOWS_NET) return (srtProvisionedCached = false);
  try {
    const result = await runAsyncProbe(WINDOWS_NET, ["user", "srt-sandbox"], {
      timeoutMs: 3000,
      env: minimalWindowsSystemEnv(),
    });
    return (srtProvisionedCached = result.status === 0);
  } catch {
    return (srtProvisionedCached = false);
  }
}

/** Healthy launches remain stable for the process. Failures are only a short snapshot: SRT startup,
 * Secondary Logon and its state DB can recover while a long-lived Neko session stays open. */
export function srtHealthCacheReusable(entry: SrtHealthCacheEntry, now = Date.now()): boolean {
  return entry.result.ok || now - entry.checkedAt < SRT_UNHEALTHY_CACHE_MS;
}

/** Non-blocking read for prompt composition. `undefined` means no reusable health evidence exists;
 * callers must describe the boundary as deferred, never guess that SRT is healthy or fall back. */
export function srtHealthSnapshot(): SrtHealthResult | undefined {
  return srtHealthCached && srtHealthCacheReusable(srtHealthCached)
    ? srtHealthCached.result
    : undefined;
}

type SrtProbeFailure = {
  status: number | null;
  signal?: NodeJS.Signals | string | null;
  error?: unknown;
  stdout?: unknown;
  stderr?: unknown;
};

/** Preserve the host-owned launch diagnostics that `status ?? "?"` used to erase. */
export function formatSrtProbeFailure(probe: SrtProbeFailure, elapsedMs: number): string {
  const output = String(probe.stderr || probe.stdout || "").replace(/\s+/g, " ").trim().slice(0, 300);
  // SAFETY: fs errors from this module's own typed calls carry the errno contract.
  const error = probe.error as NodeJS.ErrnoException | undefined;
  const code = String(error?.code || "none").replace(/\s+/g, " ").slice(0, 80);
  const timedOut = code.toUpperCase() === "ETIMEDOUT";
  const base = `status=${probe.status ?? "null"} signal=${probe.signal ?? "none"} code=${code} timeout=${timedOut} elapsed_ms=${Math.max(0, Math.round(elapsedMs))}`;
  // Ordinary non-zero exits usually carry the most useful SRT-owned explanation. A launch
  // timeout/error may still leave partial output, so retain both that text and the host metadata.
  if (output && probe.status !== null && !probe.signal && !error) return output;
  if (output) return `${output}; ${base}`;
  if (!error || error.code) return base;
  return `${base} error=${String(error.message || error).replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

/** A behavioral probe can time out under host contention even though the next exact SRT launch works.
 * This is not authority to fall back to the host: it only permits one ordinary command to attempt the
 * same configured SRT boundary and let that real launch succeed or fail on its own. */
export function transientSrtHealthFailure(detail: string): boolean {
  return /(?:\bETIMEDOUT\b|\btimeout=true\b)/i.test(String(detail));
}

/** Behavioral Windows health check. Account existence alone is insufficient: package ACL drift,
 * WFP setup, Secondary Logon, or the credential store can still make every sandbox launch fail. */
export function srtHealth(): SrtHealthResult {
  if (srtHealthCached && srtHealthCacheReusable(srtHealthCached)) return srtHealthCached.result;
  const refreshDependencies = Boolean(srtHealthCached);
  const remember = (result: SrtHealthResult): SrtHealthResult => {
    srtHealthCached = { result, checkedAt: Date.now() };
    return result;
  };
  const exe = findSrt(refreshDependencies);
  if (!exe) return remember({ ok: false, detail: "srt.exe not found" });
  if (!srtProvisioned(refreshDependencies)) return remember({ ok: false, detail: "sandbox account is not provisioned" });
  let settings: ReturnType<typeof writeEphemeralSrtSettings> | undefined;
  try {
    settings = writeEphemeralSrtSettings(tmpdir(), process.cwd(), false, []);
    const startedAt = Date.now();
    const probe = spawnSync(exe, ["--settings", settings.path, "-c", "exit /b 0"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 20_000,
      windowsHide: true,
    });
    if (probe.status === 0) return remember({ ok: true, detail: "behavioral sandbox launch passed (egress policy not probed here)" });
    return remember({ ok: false, detail: formatSrtProbeFailure(probe, Date.now() - startedAt) });
  } catch (error) {
    const detail = `behavioral probe failed: ${String(error)}`.replace(/\s+/g, " ").trim().slice(0, 300);
    return remember({ ok: false, detail });
  } finally {
    settings?.cleanup();
  }
}

/** The same behavioral SRT check as srtHealth(), but event-loop friendly. A shared in-flight probe
 * prevents simultaneous tool calls from multiplying the expensive Windows account/SRT startup.
 * The synchronous form remains for explicit doctor/policy commands, never the interactive turn. */
export function srtHealthAsync(signal?: AbortSignal): Promise<SrtHealthResult> {
  const interrupted = (): SrtHealthResult => ({ ok: false, detail: "health check wait interrupted" });
  if (signal?.aborted) return Promise.resolve(interrupted());
  const cached = srtHealthSnapshot();
  if (cached) return Promise.resolve(cached);
  if (!srtHealthPending) {
    const refreshDependencies = Boolean(srtHealthCached);
    const remember = (result: SrtHealthResult): SrtHealthResult => {
      srtHealthCached = { result, checkedAt: Date.now() };
      return result;
    };
    srtHealthPending = (async () => {
      const exe = findSrt(refreshDependencies);
      if (!exe) return remember({ ok: false, detail: "srt.exe not found" });
      if (!(await srtProvisionedAsync(refreshDependencies))) {
        return remember({ ok: false, detail: "sandbox account is not provisioned" });
      }
      let settings: ReturnType<typeof writeEphemeralSrtSettings> | undefined;
      try {
        settings = writeEphemeralSrtSettings(tmpdir(), process.cwd(), false, []);
        const startedAt = Date.now();
        const probe = await runAsyncProbe(exe, ["--settings", settings.path, "-c", "exit /b 0"], {
          cwd: process.cwd(),
          timeoutMs: 20_000,
        });
        if (probe.status === 0) {
          return remember({ ok: true, detail: "behavioral sandbox launch passed (egress policy not probed here)" });
        }
        return remember({ ok: false, detail: formatSrtProbeFailure(probe, Date.now() - startedAt) });
      } catch (error) {
        const detail = `behavioral probe failed: ${String(error)}`.replace(/\s+/g, " ").trim().slice(0, 300);
        return remember({ ok: false, detail });
      } finally {
        settings?.cleanup();
      }
    })().finally(() => {
      srtHealthPending = undefined;
    });
  }
  const pending = srtHealthPending;
  if (!signal) return pending;
  return new Promise((resolveHealth) => {
    let settled = false;
    const finish = (result: SrtHealthResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolveHealth(result);
    };
    const abort = () => finish(interrupted());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(finish);
  });
}

/** Async policy query for interactive tool dispatch. The health probe may be slow on Windows, but
 * timers, streaming, Esc/Ctrl+C, and the rest of the TUI remain responsive while it runs. */
export async function sandboxActiveAsync(signal?: AbortSignal): Promise<boolean> {
  const kind = detectSandbox();
  if (kind === "none") return false;
  return kind !== "srt" || (await srtHealthAsync(signal)).ok;
}

/** True when bash would actually run CONFINED right now: a primitive exists and (for srt) the
 * one-time provisioning is live. Sandboxed-bash auto-approval keys off this, never off the config
 * intent alone - "sandbox": true on a machine with no primitive must still prompt. */
export function sandboxActive(): boolean {
  const kind = detectSandbox();
  if (kind === "none") return false;
  return kind !== "srt" || srtHealth().ok;
}

/** Refuse a configured-but-unhealthy Windows sandbox BEFORE launching the user's command. Presence
 * and health have different jobs: an absent primitive retains Neko's documented unconfined fallback,
 * while a present SRT whose behavioral probe failed must never be bypassed implicitly. */
export function srtLaunchRefusal(
  enabled: boolean,
  kind: SandboxKind,
  health: { ok: boolean; detail: string },
): string | null {
  if (!enabled || kind !== "srt" || health.ok) return null;
  const raw = String(health.detail || "behavioral health check failed").replace(/\s+/g, " ").trim().slice(0, 500);
  // The actual command still launches only through srt.exe + an exact settings file. A transient
  // preflight timeout therefore cannot weaken confinement; refusing it here only creates a false
  // negative like a busy Windows host did in the field.
  if (transientSrtHealthFailure(raw)) return null;
  return withSrtStateVolumeGuidance(
    `Error: configured SRT sandbox is unusable; bash was not executed: ${raw}`,
  );
}

/** SRT can pass its cached health probe and then fail opening SQLite shared memory at launch time.
 * Keep the recovery bounded and safe: no database surgery, state relocation, or reinstall advice. */
export function withSrtStateVolumeGuidance(raw: string): string {
  const value = String(raw).trimEnd();
  if (!/(?:\b4874\b|xShmMap|SQLITE_IOERR_SHMSIZE)/i.test(value)
    || /%LOCALAPPDATA% may be full/i.test(value)) return value;
  return `${value}\nThe volume containing %LOCALAPPDATA% may be full; free disk space there, then re-run \`neko doctor\`.`;
}

/** Detect a command that IRREVERSIBLY destroys data INSIDE the workspace. The OS sandbox already
 * contains the blast radius to the workspace, but the workspace itself (the user's code + .git) is
 * writable - so sandboxed-bash auto-approval still asks a one-time confirmation for these. Unlike
 * dangerousCommand (a safety seatbelt that runs even unsandboxed), this is only a "should we still
 * prompt?" heuristic: a miss just means a contained command ran, not a system-level disaster, and a
 * false positive costs one extra prompt. Returns a human reason, or null. Pure + testable.
 *
 * Deliberately does NOT fire on a plain single-file delete (`rm file.txt`) - that keeps ordinary
 * cleanup convenient; it fires on the mass/irreversible forms (recursive/force/glob rm, git history
 * or worktree wipers, find -delete, script-driven deletion, shred/truncate). Users who want zero
 * prompts still have "always allow bash" and mode=auto (yolo). */
export function destructiveInWorkspace(command: string): string | null {
  const c = String(command).replace(/\s+/g, " ").trim();
  if (/\brm\b/.test(c) && (/\s-[a-z]*r/i.test(c) || /\s-[a-z]*f/i.test(c) || /[*?]/.test(c))) return "recursive/force/wildcard delete (rm)";
  if (/\bgit\s+clean\b/.test(c) && /\s-[a-z]*f/i.test(c)) return "git clean -f (removes untracked files)";
  if (/\bgit\s+reset\b[^|;]*--hard/.test(c)) return "git reset --hard (discards uncommitted work)";
  if (/\bgit\s+checkout\b[^|;]*(--\s*\.|\s\.\s*$)/.test(c)) return "git checkout -- . (discards changes)";
  if (/\bfind\b[^|;]*-(delete|exec\s+rm)\b/.test(c)) return "find -delete / -exec rm";
  if (/\b(python3?|node|ruby|perl|deno|bun)\b[^|;]*\b(rmtree|removedirs|shutil|os\.remove|os\.unlink|fs\.rm|unlink\(|rimraf)/i.test(c)) return "script-driven deletion";
  if (/\b(shred|truncate)\b/.test(c)) return "shred/truncate (irrecoverable)";
  return null;
}

/** srt settings JSON: writes confined to the workspace; reads stay default-allowed like the
 * bwrap/Seatbelt rungs. srt has NO allow-all egress -- network is always an allowlist (its
 * design, same as Claude Code/Codex) -- so allowNetwork=true exposes only the configured
 * sandbox_domains, and allowNetwork=false hard-blocks (deniedDomains "*" wins over everything).
 * All four fs/network keys are schema-required in srt >= 0.0.66. Pure. */
export function srtSettings(
  root: string,
  allowNetwork: boolean,
  domains: string[] = [],
  allowRead: readonly string[] = [],
  allowWrite: readonly string[] = [root],
  denyWrite: readonly string[] = [],
  denyRead: readonly string[] = [],
): string {
  return JSON.stringify({
    network: allowNetwork
      ? { allowedDomains: domains, deniedDomains: [], strictAllowlist: true }
      : { allowedDomains: [], deniedDomains: ["*"] },
    filesystem: { denyRead: [...denyRead], allowRead: [...allowRead], allowWrite: [...allowWrite], denyWrite: [...denyWrite] },
  });
}

/** Write one launch's settings with exclusive creation at an unpredictable path. Reusing a
 * content-addressed temp filename lets an untrusted local process pre-create poisoned JSON (or a
 * link) before Neko starts. `wx` makes creation atomic, while the UUID prevents useful guessing.
 * The caller owns the short-lived file and must run cleanup after the child closes. */
export function writeEphemeralSrtSettings(
  dir: string,
  root: string,
  allowNetwork: boolean,
  domains: string[] = [],
  allowRead: readonly string[] = [],
  allowWrite: readonly string[] = [root],
  denyWrite: readonly string[] = [],
  denyRead: readonly string[] = [],
): any {
  const json = srtSettings(root, allowNetwork, domains, allowRead, allowWrite, denyWrite, denyRead);
  const path = join(dir, `neko-srt-settings-${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const written = statSync(path);
  if (!written.isFile() || written.size !== Buffer.byteLength(json)) {
    try { rmSync(path, { force: true }); } catch { /* best-effort cleanup of rejected material */ }
    throw new Error("refusing non-regular or truncated srt settings file");
  }
  let removed = false;
  return {
    path,
    cleanup: () => {
      if (removed) return;
      removed = true;
      try { rmSync(path, { force: true }); } catch { /* cleanup must never crash the agent */ }
    },
  };
}

/** The bash script srt runs inside the sandbox. srt's CLI re-parses its command line through
 * the sandbox account's cmd.exe, so arbitrary bash text cannot ride the command line safely
 * (cmd quoting is escapable -- the same reason findSrt refuses .cmd shims). The command bytes
 * go in a script FILE instead; only two quoted paths ever reach the command line. The cd
 * preamble restores the workspace cwd, which the two-hop user switch does not preserve. Pure. */
export function srtScript(root: string, command: string, bunPath: string | null = null): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const bunForBash = bunPath
    ? bunPath.replace(/^([A-Za-z]):[\\/]/, (_all, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/")
    : null;
  const bridge = bunForBash
    ? `bun() { ${q(bunForBash)} "$@"; }\nexport -f bun\n` +
      // SRT preserves PATH but filters arbitrary parent variables. Export the launch-owned values
      // from the protected script so npm's child cmd.exe receives them without batch interpolation.
      `export NEKO_SRT_BUN_EXE=${q(bunPath!)}\n` +
      "export NoDefaultCurrentDirectoryInExePath=1\n"
    : "";
  return `cd ${q(root)} || exit 1\n${bridge}${command}\n`;
}

/** Remove scripts left by the old persistent implementation and crash-orphaned ephemeral scripts. */
export function purgeStaleSrtScripts(dir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^cmd-.*\.sh$/.test(name)) continue;
      const path = join(dir, name);
      const legacy = /^cmd-[0-9a-f]{12}\.sh$/.test(name);
      let stale = legacy;
      try { stale ||= now - statSync(path).mtimeMs > 24 * 60 * 60_000; } catch { stale = true; }
      if (stale) {
        try { rmSync(path, { force: true }); } catch { /* another process may still have it open */ }
      }
    }
  } catch { /* best-effort hygiene; launch still has per-process cleanup */ }
}

/** Create one unpredictable per-launch script directory. A shared readable directory lets another
 * concurrent job under the same sandbox account enumerate credential-bearing command files. */
function createSrtScriptDir(): string | null {
  if (!WINDOWS_ICACLS) return null;
  let dir = "";
  try {
    dir = join(tmpdir(), `neko-srt-${process.pid}-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    const r = spawnSync(WINDOWS_ICACLS, [dir, "/grant", "srt-sandbox:(OI)(CI)(RX)"], {
      timeout: 10000,
      windowsHide: true,
      env: minimalWindowsSystemEnv(),
    });
    if (r.status !== 0) throw new Error("could not grant the sandbox account access to its launch directory");
    return dir;
  } catch {
    if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    return null;
  }
}

/** Create a unique, short-lived command script. Commands can contain credentials, so scripts are
 * never content-addressed/reused and their cleanup is tied to the spawned child's lifecycle. */
export function writeEphemeralSrtScript(
  dir: string,
  root: string,
  command: string,
  bunPath: string | null = null,
): any {
  const path = join(dir, `cmd-${process.pid}-${randomUUID()}.sh`);
  writeFileSync(path, srtScript(root, command, bunPath), { encoding: "utf8", flag: "wx", mode: 0o600 });
  let removed = false;
  return {
    path,
    cleanup: () => {
      if (removed) return;
      removed = true;
      try { rmSync(path, { force: true }); } catch { /* cleanup must never crash the agent */ }
    },
  };
}

/** A fixed Windows child-process bridge for package scripts. The canonical Bun path stays in a
 * host-owned launch environment variable instead of being interpolated into batch syntax. */
export function writeEphemeralSrtBunShim(dir: string) {
  const path = join(dir, "bun.cmd");
  const body = '@"%NEKO_SRT_BUN_EXE%" %*\r\n';
  writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o500 });
  const written = statSync(path);
  if (!written.isFile() || written.size !== Buffer.byteLength(body)) {
    try { rmSync(path, { force: true }); } catch { /* best-effort cleanup of rejected material */ }
    throw new Error("refusing non-regular or truncated SRT Bun shim");
  }
  let removed = false;
  return {
    path,
    cleanup: () => {
      if (removed) return;
      removed = true;
      try { rmSync(path, { force: true }); } catch { /* cleanup must never crash the agent */ }
    },
  };
}

/** null -> no readable script dir; caller falls back to srt's own -c (idioms degraded). */
function writeSrtScript(root: string, command: string, bunPath: string | null): any {
  const dir = createSrtScriptDir();
  if (!dir) return null;
  let shim: ReturnType<typeof writeEphemeralSrtBunShim> | null = null;
  try {
    shim = bunPath ? writeEphemeralSrtBunShim(dir) : null;
    const script = writeEphemeralSrtScript(dir, root, command, bunPath);
    let cleaned = false;
    return {
      path: script.path,
      toolchainDir: shim ? dir : null,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        script.cleanup();
        shim?.cleanup();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
  } catch (error) {
    shim?.cleanup();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Unsandboxed spawn target. On Windows, run through real git-bash if available (so Unix idioms
 * work), else fall back to the platform shell (cmd.exe on Windows, /bin/sh elsewhere). `bash` is
 * injectable so this stays pure + testable. */
export function plainTarget(command: string, bash: string | null): SpawnTarget {
  if (bash) return { file: bash, args: ["-c", command], shell: false };
  return { file: command, args: [], shell: true };
}

function noneTarget(command: string): SpawnTarget {
  return plainTarget(command, process.platform === "win32" ? findWindowsBash() : null);
}

/** Which sandbox primitive this machine offers (cached). */
export function detectSandbox(): SandboxKind {
  if (cached !== undefined) return cached;
  if (process.platform === "linux") {
    cachedPrimitive = executableOnPath("bwrap");
    cached = cachedPrimitive ? "bwrap" : "none";
  } else if (process.platform === "darwin") {
    cachedPrimitive = executableOnPath("sandbox-exec");
    cached = cachedPrimitive ? "sandbox-exec" : "none";
  } else if (process.platform === "win32") {
    cachedPrimitive = findSrt();
    cached = cachedPrimitive ? "srt" : "none";
  } else {
    cachedPrimitive = null;
    cached = "none";
  }
  return cached;
}

/** Environment-derived pieces the "srt" kind needs (resolved by wrapBash, injected for purity). */
export interface SrtLaunch {
  exe: string;
  settingsPath: string;
  bash: string | null;
  scriptPath: string | null;
  cleanup?: () => void;
}

export interface SandboxBuildOptions {
  /** Validator-only turns keep the original project read-only. */
  readOnlyWorkspace?: boolean;
  /** The sole ordinary writable directory for a read-only workspace launch. */
  writableTemp?: string;
  /** Canonical host shell selected outside the untrusted workspace/PATH prefix. */
  shellExe?: string;
  /** Oracle-only profile: the shell must `exec` its target; target forks are denied. */
  denyChildProcesses?: boolean;
  /** Trusted host implementation files hidden from benchmark candidates. */
  denyReadFiles?: readonly string[];
  /** Explicit host-owned writable directory capabilities for ordinary (non-validator) turns. */
  additionalWriteRoots?: readonly string[];
}

/** Build the spawn target for running `command` under the given sandbox kind. Pure (testable). */
export function buildSandbox(
  kind: SandboxKind,
  command: string,
  root: string,
  allowNetwork: boolean,
  srt?: SrtLaunch,
  primitiveExe?: string,
  options: SandboxBuildOptions = {},
): SpawnTarget {
  if (kind === "bwrap") {
    if (options.readOnlyWorkspace && !options.writableTemp) throw new Error("read-only sandbox requires a writable temp directory");
    return {
      file: primitiveExe ?? "bwrap",
      args: [
        // A timed-out validator must not leave detached descendants. Run the command itself as
        // PID 1: when it exits, Linux tears down every process left in that PID namespace. The
        // parent-death contract also closes abrupt harness exits.
        "--unshare-pid",
        "--as-pid-1",
        "--die-with-parent",
        "--ro-bind", "/", "/", // whole fs read-only...
        "--tmpfs", "/run", // hide Docker/Podman/rootless daemon sockets from the sandbox
        "--dev-bind", "/dev", "/dev",
        "--proc", "/proc",
        ...(options.readOnlyWorkspace
          ? [
              // An isolated tmpfs prevents hardlink aliases back into the read-only project.
              "--tmpfs", options.writableTemp!,
              // Re-assert the project after the temp mount: a checkout below /tmp must stay read-only.
              "--ro-bind", root, root,
            ]
          : [
              "--bind", "/tmp", "/tmp",
              "--bind", root, root,
              ...(options.additionalWriteRoots ?? []).flatMap((path) => ["--bind", path, path]),
            ]), // full turns keep the workspace + explicit additional roots writable
        ...(options.denyReadFiles ?? []).flatMap((path) => ["--ro-bind", "/dev/null", path]),
        "--chdir", root,
        ...(allowNetwork ? [] : ["--unshare-net"]),
        "--", options.shellExe ?? "bash", "-c", command,
      ],
      shell: false,
      treeContainedOnClose: true,
    };
  }
  if (kind === "sandbox-exec") {
    const esc = (p: string) => p.replace(/"/g, '\\"');
    if (options.readOnlyWorkspace && !options.writableTemp) throw new Error("read-only sandbox requires a writable temp directory");
    const writes = options.readOnlyWorkspace
      ? `(allow file-write* (subpath "${esc(options.writableTemp!)}") (subpath "/dev"))` +
        `(deny file-write* (subpath "${esc(root)}"))`
      : `(allow file-write* (subpath "${esc(root)}") ` +
        (options.additionalWriteRoots ?? []).map((path) => `(subpath "${esc(path)}") `).join("") +
        `(subpath "/tmp") (subpath "/private/tmp") (subpath "/dev"))`;
    const profile =
      "(version 1)(allow default)(deny file-write*)" +
      writes +
      (options.denyChildProcesses
        ? "(deny process-fork)(deny signal)(allow signal (target same-sandbox))"
        : "") +
      (options.denyReadFiles ?? []).map((path) => `(deny file-read* (literal "${esc(path)}"))`).join("") +
      `(deny file-read* (literal "/var/run/docker.sock") (literal "${esc(join(homedir(), ".docker", "run", "docker.sock"))}"))` +
      (allowNetwork ? "" : "(deny network*)");
    return {
      file: primitiveExe ?? "sandbox-exec",
      args: ["-p", profile, options.shellExe ?? "bash", "-c", command],
      shell: false,
      ...(options.denyChildProcesses ? { treeContainedOnClose: true } : undefined),
    };
  }
  if (kind === "srt" && srt) {
    // `srt -c` hands the string to the sandbox account's platform shell. With git-bash, that
    // string is just `"<bash>" "<script>"` -- two quoted paths, no command bytes on any shell
    // command line (they live in the script file). Without git-bash, degrade to the raw
    // command via srt's own -c, same posture as the unsandboxed Windows fallback.
    const inner = srt.bash && srt.scriptPath ? `"${srt.bash}" "${srt.scriptPath}"` : command;
    return {
      file: srt.exe,
      args: ["--settings", srt.settingsPath, "-c", inner],
      shell: false,
      treeContainedOnClose: true,
      ...(srt.cleanup ? { cleanup: srt.cleanup } : undefined),
    };
  }
  return noneTarget(command); // none: git-bash on Windows, else the platform shell (seatbelt + gate still apply)
}

/** Spawn target for a bash command, sandboxed if enabled + available. */
/** Detect common direct and shell-wrapped Docker/Podman CLI invocations. This is a policy signal,
 * not the confinement boundary: commands that evade the heuristic still stay sandboxed, and Linux/
 * macOS sandbox profiles hide the standard daemon sockets. */
export function isDockerCommand(command: string): boolean {
  const wrappers = new Set(["env", "sudo", "command", "nohup", "time", "bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh"]);
  const daemon = (raw: string): boolean => {
    const token = raw.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/");
    const leaf = token.slice(token.lastIndexOf("/") + 1).replace(/\.exe$/i, "").toLowerCase();
    return leaf === "docker" || leaf === "docker-compose" || leaf === "podman";
  };
  for (const segment of String(command).split(/\r?\n|&&|\|\||[;|]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    if (daemon(tokens[0])) return true;
    const first = tokens[0].replace(/^["']+|["']+$/g, "").replace(/\.exe$/i, "").toLowerCase();
    if (wrappers.has(first) && tokens.slice(1, 9).some(daemon)) return true;
    if (/^[A-Za-z_]\w*=/.test(tokens[0]) && tokens.slice(1, 9).some(daemon)) return true;
  }
  return false;
}

export function wrapBash(command: string, root: string, opts: { enabled: boolean; allowNetwork: boolean; domains?: string[]; allowHostDaemon?: boolean; readOnlyWorkspace?: boolean; denyChildProcesses?: boolean; denyReadFiles?: readonly string[]; additionalWriteRoots?: readonly string[]; stdinSource?: string }): SpawnTarget {
  const requiresLiveSandbox = opts.readOnlyWorkspace || Boolean(opts.denyReadFiles?.length);
  if (!opts.enabled) {
    if (requiresLiveSandbox) throw new Error("restricted bash profile requires a live OS sandbox");
    return noneTarget(command);
  }
  // Host-daemon access is an explicit capability, not a side effect of recognizing a CLI name.
  // Without the override even an obfuscated/missed invocation remains inside the OS sandbox.
  if (!opts.readOnlyWorkspace && opts.allowHostDaemon && isDockerCommand(command)) return noneTarget(command);
  const kind = detectSandbox();
  if (requiresLiveSandbox && kind === "none") throw new Error("restricted bash profile requires a live OS sandbox");
  const exe = kind === "srt" ? findSrt() : null;
  // Use the exact primitive that detection already canonicalized. Spawning a bare name would ask
  // the OS to search PATH again and could select a workspace-local binary that detection rejected.
  const primitiveExe = kind === "srt" ? exe : cachedPrimitive;
  const bash = exe ? findWindowsBash() : null;
  const sandboxShell = kind === "bwrap" || kind === "sandbox-exec"
    ? executableOnPath("bash", process.env.PATH ?? "", root)
    : null;
  if ((kind === "bwrap" || kind === "sandbox-exec") && !sandboxShell) {
    throw new Error("sandbox primitive is present but no trusted bash executable exists outside the workspace");
  }
  // Resolve this once: the exact same immutable value controls both SRT's transient read ACE and
  // the Git-Bash alias. No directory or user-profile grant is ever inferred from it.
  const bunBridge = exe ? resolveSrtBunBridge(root) : null;
  const bunPath = bunBridge?.path ?? null;
  let validationTemp: { path: string; cleanup: () => void } | null = null;
  let script: ReturnType<typeof writeSrtScript> = null;
  let settings: ReturnType<typeof writeEphemeralSrtSettings> | null = null;
  try {
    if (opts.readOnlyWorkspace) validationTemp = createValidationTemp(root);
    let sandboxCommand = command;
    if (opts.stdinSource !== undefined) {
      if (kind !== "srt" || !validationTemp) {
        throw new Error("protected stdin source requires the Windows SRT read-only profile");
      }
      const bytes = Buffer.byteLength(opts.stdinSource);
      if (bytes > 8 * 1024 * 1024 || opts.stdinSource.includes("\0")) {
        throw new Error("protected stdin source exceeded its bounded text contract");
      }
      const inputPath = join(validationTemp.path, `stdin-${process.pid}-${randomUUID()}.mjs`);
      writeFileSync(inputPath, opts.stdinSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const written = statSync(inputPath);
      if (!written.isFile() || written.size !== bytes) throw new Error("protected stdin source was not written atomically");
      const shellPath = inputPath
        .replace(/^([A-Za-z]):[\\/]/, (_all, drive: string) => `/${drive.toLowerCase()}/`)
        .replace(/\\/g, "/");
      const quoted = `'${shellPath.replace(/'/g, "'\\''")}'`;
      // SRT's broker does not forward the parent stdin pipe. Open and unlink the launch-private file,
      // then copy it through Git's fixed cat into a pipe. A direct fd redirect stays seekable on
      // Windows and Bun.stdin could reread the runner after module initialization.
      sandboxCommand = `exec 3<${quoted} || exit 97\nrm -- ${quoted} || exit 98\n/usr/bin/cat <&3 | ${command}`;
    }
    script = bash ? writeSrtScript(root, sandboxCommand, bunPath) : null;
    settings = exe
      ? writeEphemeralSrtSettings(
          tmpdir(),
          root,
          opts.allowNetwork,
          opts.domains ?? [],
          opts.readOnlyWorkspace ? [root, ...(bunPath ? [bunPath] : [])] : (bunPath ? [bunPath] : []),
          opts.readOnlyWorkspace ? [validationTemp!.path] : [root, ...(opts.additionalWriteRoots ?? [])],
          opts.readOnlyWorkspace ? [root] : [],
          opts.denyReadFiles ?? [],
        )
      : null;
    let cleaned = false;
    const cleanup = settings || script || validationTemp
      ? () => {
          if (cleaned) return;
          cleaned = true;
          script?.cleanup();
          settings?.cleanup();
          validationTemp?.cleanup();
        }
      : undefined;
    const target = buildSandbox(kind, sandboxCommand, root, opts.allowNetwork,
      exe
        ? {
            exe,
            settingsPath: settings!.path,
            bash,
            scriptPath: script?.path ?? null,
            cleanup,
          }
        : undefined,
      primitiveExe ?? undefined,
      {
        readOnlyWorkspace: opts.readOnlyWorkspace,
        writableTemp: validationTemp?.path,
        shellExe: sandboxShell ?? undefined,
        denyChildProcesses: opts.denyChildProcesses,
        denyReadFiles: opts.denyReadFiles,
        additionalWriteRoots: opts.additionalWriteRoots,
      });
    const srtBridgeEnv: Record<string, string> = kind === "srt" && bunPath && script?.toolchainDir
      ? {
          // npm runs package scripts in a child cmd.exe, where Bash functions do not exist. The
          // launch-owned RX-only shim wins bare-name lookup without granting Bun's parent/profile
          // directory; disabling cwd lookup also rejects a root bun.cmd.
          PATH: `${script.toolchainDir}${delimiter}${process.env.PATH ?? ""}`,
          NEKO_SRT_BUN_EXE: bunPath,
          NoDefaultCurrentDirectoryInExePath: "1",
        }
      : {};
    return opts.readOnlyWorkspace
      ? {
          ...target,
          env: {
            ...srtBridgeEnv,
            TEMP: validationTemp!.path,
            TMP: validationTemp!.path,
            TMPDIR: validationTemp!.path,
          },
          cleanup,
        }
      : Object.keys(srtBridgeEnv).length
        ? { ...target, env: srtBridgeEnv }
        : target;
  } catch (error) {
    script?.cleanup();
    settings?.cleanup();
    validationTemp?.cleanup();
    throw error;
  }
}

/** Create an unpredictable writable scratch directory that is provably outside the project. */
function createValidationTemp(root: string) {
  const created = mkdtempSync(join(tmpdir(), "neko-validator-"));
  try {
    const rootReal = realpathSync(resolve(root));
    const tempReal = realpathSync(created);
    const rel = relative(rootReal, tempReal);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new Error("writable validation temp resolved inside the project");
    }
    let removed = false;
    return {
      path: tempReal,
      cleanup: () => {
        if (removed) return;
        removed = true;
        try { rmSync(tempReal, { recursive: true, force: true }); } catch { /* cleanup must not mask tool output */ }
      },
    };
  } catch (error) {
    try { rmSync(created, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}
