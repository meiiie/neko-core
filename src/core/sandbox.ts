/**
 * Optional OS-level sandbox for the `bash` tool (like Claude Code / Codex CLI). When enabled, bash
 * runs with the filesystem READ-ONLY except the workspace (+ /tmp), and optionally with no network.
 *
 *   Linux  -> bubblewrap (bwrap): unprivileged namespaces.
 *   macOS  -> sandbox-exec (Seatbelt): SBPL profile.
 *   else   -> "none": no lightweight primitive (e.g. Windows) -> bash runs unconfined, but the
 *             catastrophic-command seatbelt + permission gate still apply (documented in WEB/SANDBOX).
 *
 * File TOOLS (write_file/edit) are already confined to the workspace; this contains bash, which can
 * otherwise write anywhere. Pure + node-only (no adapter imports) so it stays in core.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type SandboxKind = "bwrap" | "sandbox-exec" | "none";
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
  else cached = "none";
  return cached;
}

/** Build the spawn target for running `command` under the given sandbox kind. Pure (testable). */
export function buildSandbox(kind: SandboxKind, command: string, root: string, allowNetwork: boolean): SpawnTarget {
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
  return noneTarget(command); // none: git-bash on Windows, else the platform shell (seatbelt + gate still apply)
}

/** Spawn target for a bash command, sandboxed if enabled + available. */
export function wrapBash(command: string, root: string, opts: { enabled: boolean; allowNetwork: boolean }): SpawnTarget {
  if (!opts.enabled) return noneTarget(command);
  return buildSandbox(detectSandbox(), command, root, opts.allowNetwork);
}
