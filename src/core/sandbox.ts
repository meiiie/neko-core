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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type SandboxKind = "bwrap" | "sandbox-exec" | "srt" | "none";
export interface SpawnTarget {
  file: string;
  args: string[];
  shell: boolean;
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

/** Whether the one-time `srt windows-install` provisioning (the srt-sandbox account) has run.
 * Without it srt refuses to launch, so bash under sandbox fails closed with srt's own message. */
export function srtProvisioned(): boolean {
  try {
    return spawnSync("net", ["user", "srt-sandbox"], { encoding: "utf-8", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
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

/** Temp dir holding the per-command scripts, readable by the sandbox account. TEMP lives in
 * the caller's profile, which other local users cannot read -- one additive read+execute ACE
 * for `srt-sandbox` on this subdir (owner-set, no elevation) makes just the scripts visible. */
function srtScriptDir(): string | null {
  if (srtScriptDirCached !== undefined) return srtScriptDirCached;
  try {
    const dir = join(tmpdir(), "neko-srt");
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("icacls", [dir, "/grant", "srt-sandbox:(OI)(CI)(RX)"], { timeout: 10000 });
    return (srtScriptDirCached = r.status === 0 ? dir : null);
  } catch {
    return (srtScriptDirCached = null);
  }
}

/** Write the command script (content-addressed like the settings file). null -> no readable
 * script dir; the caller falls back to srt's own -c (the platform shell, idioms degraded). */
function writeSrtScript(root: string, command: string): string | null {
  const dir = srtScriptDir();
  if (!dir) return null;
  const body = srtScript(root, command);
  const path = join(dir, `cmd-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.sh`);
  if (!existsSync(path)) writeFileSync(path, body);
  return path;
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
    return { file: srt.exe, args: ["--settings", srt.settingsPath, "-c", inner], shell: false };
  }
  return noneTarget(command); // none: git-bash on Windows, else the platform shell (seatbelt + gate still apply)
}

/** Spawn target for a bash command, sandboxed if enabled + available. */
export function wrapBash(command: string, root: string, opts: { enabled: boolean; allowNetwork: boolean; domains?: string[] }): SpawnTarget {
  if (!opts.enabled) return noneTarget(command);
  const kind = detectSandbox();
  const exe = kind === "srt" ? findSrt() : null;
  const bash = exe ? findWindowsBash() : null;
  return buildSandbox(kind, command, root, opts.allowNetwork,
    exe
      ? {
          exe,
          settingsPath: writeSrtSettings(root, opts.allowNetwork, opts.domains ?? []),
          bash,
          scriptPath: bash ? writeSrtScript(root, command) : null,
        }
      : undefined);
}
