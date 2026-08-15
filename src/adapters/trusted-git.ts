import { spawn, spawnSync } from "node:child_process";

import { executableOnPath } from "../core/sandbox.ts";
import { scrubChildEnv } from "../shared/child-env.ts";

/** Resolve Git from explicit PATH entries while excluding the untrusted working tree. */
export function trustedGitExecutable(
  cwd: string,
  pathValue = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string | null {
  return executableOnPath(platform === "win32" ? "git.exe" : "git", pathValue, cwd, platform);
}

/** Small, secret-scrubbed Git query used only for prompt/session metadata. */
export function trustedGitOutput(cwd: string, args: string[]): string {
  const executable = trustedGitExecutable(cwd);
  if (!executable) return "";
  try {
    const result = spawnSync(executable, args, {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      windowsHide: true,
      env: scrubChildEnv(process.env),
    });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

/** Async metadata query for UI/ACP checkpoint paths. Output is deliberately small and credentials
 * remain scrubbed exactly like the synchronous compatibility helper. */
export function trustedGitOutputAsync(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const executable = trustedGitExecutable(cwd);
  if (!executable || signal?.aborted) return Promise.resolve("");
  return new Promise((resolveOutput) => {
    let stdout = "";
    let settled = false;
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: scrubChildEnv(process.env),
    });
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveOutput(value);
    };
    const abort = () => {
      try { child.kill(); } catch { /* already gone */ }
      finish("");
    };
    const timer = setTimeout(abort, 2000);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk.slice(0, 64 * 1024 - stdout.length);
    });
    child.once("error", () => finish(""));
    child.once("close", (code) => finish(code === 0 ? stdout.trim() : ""));
  });
}
