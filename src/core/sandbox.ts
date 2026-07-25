/**
 * Optional OS-level sandbox for the `bash` tool (like Claude Code / Codex CLI). When enabled, bash
 * runs with the filesystem READ-ONLY except the workspace (+ /tmp), and optionally with no network.
 *
 *   Linux   -> bubblewrap (bwrap): unprivileged namespaces.
 *   macOS   -> sandbox-exec (Seatbelt): SBPL profile.
 *   Windows -> Anthropic sandbox-runtime (srt): runs the command as a dedicated `srt-sandbox`
 *              user under a restricted token in a job object; NTFS ACLs confine writes and a
 *              WFP egress fence blocks network (one-time `srt windows-install` provisioning).
 *   else    -> "none": bash runs unconfined, but the catastrophic-command seatbelt +
 *              permission gate still apply (documented in WEB/SANDBOX).
 *
 * File TOOLS (write_file/edit) are already confined to the workspace; this contains bash, which can
 * otherwise write anywhere. Pure + node-only (no adapter imports) so it stays in core.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type SandboxKind = "bwrap" | "sandbox-exec" | "srt" | "none";
export interface SpawnTarget {
  file: string;
  args: string[];
  shell: boolean;
  /** Remove per-launch material after the child closes. Must be safe to call more than once. */
  cleanup?: () => void;
}

let cached: SandboxKind | undefined;

function onPath(cmd: string): boolean {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [cmd], { encoding: "utf-8", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

let winBashCached: string | null | undefined;

/** Locate a POSIX bash (Git-Bash / MSYS) on Windows so the `bash` tool actually runs bash — NOT
 * cmd.exe (which chokes on the Unix idioms a model naturally emits: heredocs, single-quotes, $VAR,
 * pipelines) and NOT WSL's C:\Windows\System32\bash.exe (which can't see the Windows-drive cwd our
 * workspace uses). Prefers NEKO_BASH, then a Git install, then a git-derived path. null if none. */
export function findWindowsBash(): string | null {
  if (winBashCached !== undefined) return winBashCached;
  const env = process.env.NEKO_BASH;
  if (env && existsSync(env)) return (winBashCached = env);
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
      if (existsSync(p)) return (winBashCached = p);
    }
  }
  // Derive from git on PATH: <gitroot>\cmd\git.exe (or \bin\git.exe) -> <gitroot>\bin\bash.exe.
  // Deliberately ignore System32\bash.exe (WSL) by only trusting a git-relative bash.
  try {
    const r = spawnSync("where", ["git"], { encoding: "utf-8", timeout: 3000 });
    if (r.status === 0) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const g = line.trim();
        if (!g || /\\System32\\/i.test(g)) continue;
        const p = join(dirname(dirname(g)), "bin", "bash.exe");
        if (existsSync(p)) return (winBashCached = p);
      }
    }
  } catch {
    /* fall through to null */
  }
  return (winBashCached = null);
}

let srtCached: string | null | undefined;

/** Locate the sandbox-runtime CLI (`srt.exe`) on Windows. Only a real .exe is trusted: npm's
 * .cmd shims route argv through cmd.exe, whose quoting a hostile command string can escape --
 * defeating the very sandbox being launched. `bun add -g @anthropic-ai/sandbox-runtime`
 * installs the .exe shim. null if none. */
export function findSrt(): string | null {
  if (srtCached !== undefined) return srtCached;
  try {
    const r = spawnSync("where", ["srt"], { encoding: "utf-8", timeout: 3000 });
    if (r.status === 0) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p && /\.exe$/i.test(p) && existsSync(p)) return (srtCached = p);
      }
    }
  } catch {
    /* fall through to null */
  }
  return (srtCached = null);
}

let srtProvisionedCached: boolean | undefined;

/** Whether the one-time `srt windows-install` provisioning (the srt-sandbox account) has run.
 * Without it srt refuses to launch, so bash under sandbox fails closed with srt's own message.
 * Cached per process (an account appearing mid-session is a re-run-doctor event, not a hot path). */
export function srtProvisioned(): boolean {
  if (srtProvisionedCached !== undefined) return srtProvisionedCached;
  try {
    return (srtProvisionedCached = spawnSync("net", ["user", "srt-sandbox"], { encoding: "utf-8", timeout: 3000 }).status === 0);
  } catch {
    return (srtProvisionedCached = false);
  }
}

/** True when bash would actually run CONFINED right now: a primitive exists and (for srt) the
 * one-time provisioning is live. Sandboxed-bash auto-approval keys off this, never off the config
 * intent alone - "sandbox": true on a machine with no primitive must still prompt. */
export function sandboxActive(): boolean {
  const kind = detectSandbox();
  if (kind === "none") return false;
  return kind !== "srt" || srtProvisioned();
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
export function srtSettings(root: string, allowNetwork: boolean, domains: string[] = []): string {
  return JSON.stringify({
    network: allowNetwork
      ? { allowedDomains: domains, deniedDomains: [], strictAllowlist: true }
      : { allowedDomains: [], deniedDomains: ["*"] },
    filesystem: { denyRead: [], allowWrite: [root], denyWrite: [] },
  });
}

/** Write the settings file srt reads. Content-addressed in tmp: same root+network -> same path,
 * already-written files are reused, and no clock/randomness is involved. */
function writeSrtSettings(root: string, allowNetwork: boolean, domains: string[]): string {
  const json = srtSettings(root, allowNetwork, domains);
  const path = join(tmpdir(), `neko-srt-${createHash("sha256").update(json).digest("hex").slice(0, 12)}.json`);
  if (!existsSync(path)) writeFileSync(path, json);
  return path;
}

/** The bash script srt runs inside the sandbox. srt's CLI re-parses its command line through
 * the sandbox account's cmd.exe, so arbitrary bash text cannot ride the command line safely
 * (cmd quoting is escapable -- the same reason findSrt refuses .cmd shims). The command bytes
 * go in a script FILE instead; only two quoted paths ever reach the command line. The cd
 * preamble restores the workspace cwd, which the two-hop user switch does not preserve. Pure. */
export function srtScript(root: string, command: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `cd ${q(root)} || exit 1\n${command}\n`;
}

let srtScriptDirCached: string | null | undefined;

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

/** Temp dir holding the per-command scripts, readable by the sandbox account. TEMP lives in
 * the caller's profile, which other local users cannot read -- one additive read+execute ACE
 * for `srt-sandbox` on this subdir (owner-set, no elevation) makes just the scripts visible. */
function srtScriptDir(): string | null {
  if (srtScriptDirCached !== undefined) return srtScriptDirCached;
  try {
    const dir = join(tmpdir(), "neko-srt");
    mkdirSync(dir, { recursive: true });
    purgeStaleSrtScripts(dir);
    const r = spawnSync("icacls", [dir, "/grant", "srt-sandbox:(OI)(CI)(RX)"], { timeout: 10000 });
    return (srtScriptDirCached = r.status === 0 ? dir : null);
  } catch {
    return (srtScriptDirCached = null);
  }
}

/** Create a unique, short-lived command script. Commands can contain credentials, so scripts are
 * never content-addressed/reused and their cleanup is tied to the spawned child's lifecycle. */
export function writeEphemeralSrtScript(dir: string, root: string, command: string): { path: string; cleanup: () => void } {
  const path = join(dir, `cmd-${process.pid}-${randomUUID()}.sh`);
  writeFileSync(path, srtScript(root, command), { encoding: "utf8", mode: 0o600 });
  let removed = false;
  return {
    path,
    cleanup: () => {
      if (removed) return;
      removed = true;
      rmSync(path, { force: true });
    },
  };
}

/** null -> no readable script dir; caller falls back to srt's own -c (idioms degraded). */
function writeSrtScript(root: string, command: string): { path: string; cleanup: () => void } | null {
  const dir = srtScriptDir();
  if (!dir) return null;
  return writeEphemeralSrtScript(dir, root, command);
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
  if (process.platform === "linux" && onPath("bwrap")) cached = "bwrap";
  else if (process.platform === "darwin" && onPath("sandbox-exec")) cached = "sandbox-exec";
  else if (process.platform === "win32" && findSrt()) cached = "srt";
  else cached = "none";
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

/** Build the spawn target for running `command` under the given sandbox kind. Pure (testable). */
export function buildSandbox(kind: SandboxKind, command: string, root: string, allowNetwork: boolean, srt?: SrtLaunch): SpawnTarget {
  if (kind === "bwrap") {
    return {
      file: "bwrap",
      args: [
        "--ro-bind", "/", "/", // whole fs read-only...
        "--dev-bind", "/dev", "/dev",
        "--proc", "/proc",
        "--bind", "/tmp", "/tmp",
        "--bind", root, root, // ...except the workspace (read-write)
        "--chdir", root,
        ...(allowNetwork ? [] : ["--unshare-net"]),
        "--", "bash", "-c", command,
      ],
      shell: false,
    };
  }
  if (kind === "sandbox-exec") {
    const esc = (p: string) => p.replace(/"/g, '\\"');
    const profile =
      "(version 1)(allow default)(deny file-write*)" +
      `(allow file-write* (subpath "${esc(root)}") (subpath "/tmp") (subpath "/private/tmp") (subpath "/dev"))` +
      (allowNetwork ? "" : "(deny network*)");
    return { file: "sandbox-exec", args: ["-p", profile, "bash", "-c", command], shell: false };
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
      ...(srt.cleanup ? { cleanup: srt.cleanup } : {}),
    };
  }
  return noneTarget(command); // none: git-bash on Windows, else the platform shell (seatbelt + gate still apply)
}

/** Spawn target for a bash command, sandboxed if enabled + available. */
/** Docker/podman talk to a local daemon over a socket/pipe the srt sandbox user can't reach, and a
 * container has host-level power anyway - so sandboxing the CLI just breaks it (the "cannot connect to
 * the Docker daemon" failure). Detect it so it runs unsandboxed (still approval-gated in default mode;
 * smooth in auto/yolo, like Claude Code / Codex). Tolerates leading env assignments and `sudo`. */
export function isDockerCommand(command: string): boolean {
  return /^(?:[A-Za-z_]\w*=\S*\s+)*(?:sudo\s+)?(?:docker-compose|docker|podman)(?:\s|$)/.test(command.trim());
}

export function wrapBash(command: string, root: string, opts: { enabled: boolean; allowNetwork: boolean; domains?: string[] }): SpawnTarget {
  if (!opts.enabled) return noneTarget(command);
  if (isDockerCommand(command)) return noneTarget(command); // docker needs the host daemon; never sandbox it
  const kind = detectSandbox();
  const exe = kind === "srt" ? findSrt() : null;
  const bash = exe ? findWindowsBash() : null;
  const script = bash ? writeSrtScript(root, command) : null;
  return buildSandbox(kind, command, root, opts.allowNetwork,
    exe
      ? {
          exe,
          settingsPath: writeSrtSettings(root, opts.allowNetwork, opts.domains ?? []),
          bash,
          scriptPath: script?.path ?? null,
          cleanup: script?.cleanup,
        }
      : undefined);
}
