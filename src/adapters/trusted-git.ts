import { spawnSync } from "node:child_process";

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
