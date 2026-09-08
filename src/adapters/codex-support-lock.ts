import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abortableDelay, throwIfAborted } from "../shared/abort.ts";

export async function acquireCodexInstallLock(home: string, signal?: AbortSignal, notify?: (message: string) => void): Promise<() => void> {
  throwIfAborted(signal);
  const parent = join(home, ".neko-core");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, ".codex-support.lock");
  const owner = `${process.pid}-${randomUUID()}`;
  const candidate = join(parent, `.codex-support-lock-${owner}`);
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, owner), "", { flag: "wx", mode: 0o600 });
  const until = Date.now() + 12 * 60_000;
  let notified = false;
  try {
  for (;;) {
    throwIfAborted(signal);
    try {
      renameSync(candidate, path);
      return () => {
        try { unlinkSync(join(path, owner)); } catch {}
        try { rmdirSync(path); } catch {}
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(String(error.code))) throw error;
    }
    try {
      const owners = readdirSync(path);
      if (owners.length === 1 && /^[1-9]\d*-[a-f0-9-]{36}$/.test(owners[0])) {
        const pid = Number(owners[0].split("-")[0]);
        try { process.kill(pid, 0); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") unlinkSync(join(path, owners[0]));
        }
      }
      // SAFETY: non-recursive removal fails if a successor published its distinct owner file.
      rmdirSync(path);
      continue;
    } catch {}
    if (Date.now() >= until) throw new Error("Another Neko window is still preparing ChatGPT. Your request is kept; please try again shortly.");
    if (!notified) { notify?.("Another Neko window is preparing ChatGPT; waiting... Esc cancels."); notified = true; }
    await abortableDelay(250, signal);
  }
  } finally {
    try { unlinkSync(join(candidate, owner)); } catch {}
    try { rmdirSync(candidate); } catch {}
  }
}
