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
  return { file: command, args: [], shell: true }; // none: as-is (seatbelt + gate still apply)
}

/** Spawn target for a bash command, sandboxed if enabled + available. */
export function wrapBash(command: string, root: string, opts: { enabled: boolean; allowNetwork: boolean }): SpawnTarget {
  if (!opts.enabled) return { file: command, args: [], shell: true };
  return buildSandbox(detectSandbox(), command, root, opts.allowNetwork);
}
