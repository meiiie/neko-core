/**
 * Self-update: `neko update` downloads the latest release binary and swaps the running executable in
 * place, plus a daily-cached startup check that notifies when a newer release exists (Claude-Code style).
 * Releases are published by the `v*` tag CI (.github/workflows/release.yml); assets are per-platform.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";

import { isJsonNumber, isText } from "../shared/wire.ts";

const REPO = "meiiie/neko-core";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const DOWNLOAD_IDLE_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;

/** The release asset for this platform/arch (matches release.yml). */
export function assetName(platform = process.platform, arch = process.arch): string {
  if (platform === "win32") return "neko-windows-x64.exe";
  if (platform === "darwin") return arch === "arm64" ? "neko-macos-arm64" : "neko-macos-x64";
  return arch === "arm64" ? "neko-linux-arm64" : "neko-linux-x64";
}

/** Numeric version compare (ignores a leading 'v'): is `latest` strictly newer than `current`? */
export function isNewer(latest: string, current: string): boolean {
  const norm = (v: string) => v.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = norm(latest);
  const b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Latest stable release tag from GitHub, with a non-API fallback for shared-IP rate limits. */
export async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "neko-core", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data: any = await res.json();
      if (isText(data.tag_name) && STABLE_TAG.test(data.tag_name) && !data.draft && !data.prerelease) {
        return data.tag_name;
      }
    }
  } catch {
    /* fall through to GitHub's official release redirect */
  }
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": "neko-core" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const match = /\/releases\/tag\/(v\d+\.\d+\.\d+)(?:$|[/?#])/.exec(res.url);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseSha256Sidecar(text: string): string | null {
  return /^\s*([0-9a-fA-F]{64})(?:\s|$)/.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** Download with a progress watchdog, not one total wall-clock deadline. A slow 93 MB release remains
 * valid while bytes keep arriving; a genuinely silent transport is aborted and every path stays bounded
 * by the published-binary size ceiling. The fetcher/idle override is a deterministic test seam. */
export async function downloadReleaseBytes(
  url: string,
  onProgress?: (received: number, total: number) => void,
  fetcher: typeof fetch = fetch,
  idleMs = DOWNLOAD_IDLE_MS,
  maxBytes = MAX_DOWNLOAD_BYTES,
): Promise<Buffer> {
  const controller = new AbortController();
  const waitForProgress = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("download made no progress");
            controller.abort(error);
            reject(error);
          }, idleMs);
          // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
          (timer as any).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await waitForProgress(fetcher(url, {
      headers: { "user-agent": "neko-core" },
      signal: controller.signal,
    }));
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error("release binary exceeds the 250 MB safety limit");
    }
    reader = res.body?.getReader();
    if (!reader) {
      const bytes = Buffer.from(await waitForProgress(res.arrayBuffer()));
      if (bytes.byteLength > maxBytes) throw new Error("release binary exceeds the 250 MB safety limit");
      onProgress?.(bytes.byteLength, declared > 0 ? declared : 0);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const chunk = await waitForProgress(reader.read());
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) throw new Error("release binary exceeds the 250 MB safety limit");
      chunks.push(chunk.value);
      onProgress?.(received, declared > 0 ? declared : 0);
    }
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    return Buffer.concat(chunks as any, received);
  } finally {
    if (controller.signal.aborted) void reader?.cancel().catch(() => {});
  }
}

function requiresChecksum(tag: string): boolean {
  const [major = 0, minor = 0] = tag.replace(/^v/, "").split(".").map(Number);
  return major > 0 || minor >= 10;
}

const cachePath = () => join(homeDir(), ".neko-core", ".update-check.json");

/** How long a check result is reused before asking GitHub again.
 *
 * A "you are on the latest" answer is only true until the next release, so caching it for a whole day
 * created a real blind spot: v0.16.0 was recorded as latest at 18:10 and v0.16.1 shipped at 18:16, so
 * every session for the next 24h skipped the check entirely - `auto_update: true` installed nothing
 * because `checkForUpdate` never asked. A found update keeps the day-long cache (auto-update installs
 * it immediately, and re-asking changes nothing), while "up to date" is re-checked a few times a day.
 * Worst case is a handful of unauthenticated calls per day, far under GitHub's rate limit, and
 * `latestVersion` already falls back to the release redirect if that limit is ever hit. */
export const UPDATE_RECHECK_MS = { found: 24 * 3600 * 1000, upToDate: 3 * 3600 * 1000 } as const;

/** Remove the stale `<exe>.old` left by a previous self-update. On Windows the old exe is still LOCKED
 * by the running process during the update itself, so the swap can't delete it - only the NEXT launch
 * (this call) can. Also sweeps ORPHANED staging files (`<exe>.new-<pid>*`) older than 30 minutes -
 * debris of an update that was killed mid-download; fresh ones are left alone because another process
 * may be actively writing them. Cheap no-op when there's nothing to clean; never throws. */
export function cleanupStaleUpdate(exe = process.execPath, now = Date.now()): void {
  try { rmSync(`${exe}.old`, { force: true }); } catch { /* still locked or permission - try again next launch */ }
  try {
    const dir = dirname(exe);
    const prefix = `${basename(exe)}.new`;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      const p = join(dir, f);
      try { if (now - statSync(p).mtimeMs > 30 * 60_000) rmSync(p, { force: true }); } catch { /* next launch */ }
    }
  } catch { /* unreadable dir - nothing to sweep */ }
}

/** One update at a time, MACHINE-wide. Without this, two `neko --yolo` startups (auto_update installs
 * in the background) plus a manual `neko update` all raced over ONE staging file and the same rename -
 * the field failure: garbled progress, an apparent hang, and only luck deciding which copy won.
 * The lock is a `wx`-created file with pid+timestamp+owner token. A dead holder is reclaimed
 * immediately; age is only the fallback for a live/reused/uninspectable pid. The owner token prevents
 * an old updater from deleting a successor's lock during its `finally`. */
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_HEARTBEAT_MS = 30_000;
const lockPath = () => join(homeDir(), ".neko-core", ".update.lock");
let ownedUpdateLock: { path: string; token: string } | null = null;

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this user cannot signal it. Unknown failures are safer to
    // treat as live; only ESRCH proves that the recorded owner is gone.
    return error?.code !== "ESRCH";
  }
}

function createOwnedUpdateLock(path: string, now: number): boolean {
  const token = randomUUID();
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: now, token }), { flag: "wx" });
    ownedUpdateLock = { path, token };
    return true;
  } catch {
    return false;
  }
}

export function acquireUpdateLock(now = Date.now(), isAlive: (pid: number) => boolean = processIsAlive): boolean {
  try { mkdirSync(join(homeDir(), ".neko-core"), { recursive: true }); } catch { /* homeless: let wx decide */ }
  const path = lockPath();
  if (createOwnedUpdateLock(path, now)) return true;

  try {
    const held = JSON.parse(readFileSync(path, "utf-8"));
    const heartbeatAt = Math.max(isJsonNumber(held.at) ? held.at : 0, statSync(path).mtimeMs);
    const fresh = now - heartbeatAt < LOCK_STALE_MS;
    const live = isAlive(held.pid);
    if (fresh && live) return false;
  } catch {
    /* unreadable/malformed -> abandoned */
  }
  try { rmSync(path, { force: true }); } catch { return false; }
  // Re-create exclusively: if another updater won the takeover race, it remains the sole owner.
  return createOwnedUpdateLock(path, now);
}

/** Keep a long, progressing download from looking abandoned to another updater. The file timestamp is
 * refreshed without rewriting/truncating the token-bearing lock file. */
export function refreshUpdateLock(now = Date.now()): boolean {
  const owned = ownedUpdateLock;
  if (!owned) return false;
  try {
    const current = JSON.parse(readFileSync(owned.path, "utf-8"));
    if (current.token !== owned.token) return false;
    const stamp = new Date(now);
    utimesSync(owned.path, stamp, stamp);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a peer updater while it is making progress. Manual `neko update` uses this path so a
 * startup auto-update does not turn a healthy install into an immediate command failure. */
export async function acquireUpdateLockWithin(waitMs: number, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitMs);
  const interval = Math.max(1, pollMs);
  for (;;) {
    if (acquireUpdateLock()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  }
}

export function releaseUpdateLock(): void {
  const owned = ownedUpdateLock;
  if (!owned) return;
  ownedUpdateLock = null;
  try {
    const current = JSON.parse(readFileSync(owned.path, "utf-8"));
    if (current.token !== owned.token) return;
    rmSync(owned.path, { force: true });
  } catch { /* stale takeover will handle it */ }
}

/** Activate a fully verified staged binary. If the second rename fails, restore the original immediately. */
export function activateStagedBinary(exe: string, staged: string): void {
  const old = `${exe}.old`;
  try { if (existsSync(old)) rmSync(old); } catch { /* a locked stale backup makes the rename fail safely */ }
  renameSync(exe, old);
  try {
    renameSync(staged, exe);
  } catch (error) {
    try { if (!existsSync(exe) && existsSync(old)) renameSync(old, exe); } catch { /* report original error */ }
    throw error;
  }
  try { rmSync(old); } catch { /* in use on Windows; cleaned on next launch */ }
}

/** Cached startup check: returns the newer version string if one exists, else null. Never throws.
 * See UPDATE_RECHECK_MS for why "up to date" expires sooner than "an update is waiting". */
export async function checkForUpdate(now = Date.now()): Promise<string | null> {
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf-8"));
    const cachedNewer = Boolean(c.latest) && isNewer(c.latest, VERSION);
    const ttl = cachedNewer ? UPDATE_RECHECK_MS.found : UPDATE_RECHECK_MS.upToDate;
    if (isJsonNumber(c.at) && now - c.at < ttl) return cachedNewer ? c.latest : null;
  } catch {
    /* no/!valid cache -> fetch fresh */
  }
  const latest = await latestVersion();
  try {
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ at: now, latest }));
  } catch {
    /* cache write is best-effort */
  }
  return latest && isNewer(latest, VERSION) ? latest : null;
}

/** Normalize a user-typed version to a release tag: "0.7.7" / "v0.7.7" -> "v0.7.7". null if unparseable. */
export function normalizeTag(v: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(v.trim());
  return m ? `v${m[1]}` : null;
}

/**
 * Download a release binary and replace the running executable. `up-to-date` is a successful,
 * idempotent outcome; callers must not collapse it into the same state as a transport/install failure.
 *   selfUpdate(log)            -> latest (refuses if already current)
 *   selfUpdate(log, "v0.7.7")  -> that EXACT version, UP or DOWN (a rollback). Downgrades are allowed:
 *                                 the caller pins `auto_update: false` so the daily updater can't undo it.
 * `opts.progressTty` streams inline `\r` download progress to stdout - ONLY for the CLI path on a real
 * TTY. The in-app background updater must never set it: its stdout is an Ink alt-screen, and a stray
 * `\r` line would corrupt the frame. (An 88 MB download with no output at all is the other failure
 * mode: it reads as a hang, and the user kills it mid-swap.)
 */
export type SelfUpdateResult = "updated" | "up-to-date" | "failed";

export function selfUpdateSucceeded(result: SelfUpdateResult): boolean {
  return result !== "failed";
}

function probeBinaryVersion(exe: string): string | null {
  const probe = spawnSync(exe, ["version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  if (probe.status !== 0) return null;
  return /^neko-core\s+([0-9]+\.[0-9]+\.[0-9]+)/m.exec(probe.stdout ?? "")?.[1] ?? null;
}

export async function selfUpdate(log: (s: string) => void, target?: string, opts: { progressTty?: boolean; waitForLockMs?: number } = {}): Promise<SelfUpdateResult> {
  const exe = process.execPath;
  if (basename(exe).replace(/\.exe$/i, "").toLowerCase() === "bun") {
    log("Running from source (bun). Update with:  git pull && bun run build");
    return "failed";
  }
  let tag: string;
  if (target) {
    const t = normalizeTag(target);
    if (!t) { log(`Not a version: "${target}" (use e.g. 0.7.7).`); return "failed"; }
    tag = t;
    if (t.replace(/^v/, "") === VERSION) { log(`Already on ${t}.`); return "up-to-date"; }
    log(isNewer(t, VERSION) ? `Switching v${VERSION} -> ${t} ...` : `Rolling back v${VERSION} -> ${t} ...`);
  } else {
    const latest = await latestVersion();
    if (!latest) {
      log("Could not reach the release server (check your connection).");
      return "failed";
    }
    if (!isNewer(latest, VERSION)) {
      log(`Already up to date (v${VERSION}).`);
      return "up-to-date";
    }
    tag = latest;
    log(`Updating v${VERSION} -> ${tag} ...`);
  }
  // One installer at a time, machine-wide (see acquireUpdateLock). Background callers leave rather
  // than racing the swap; the explicit CLI waits briefly for that background work to settle.
  const waitForLockMs = opts.waitForLockMs ?? 0;
  let waitedForPeer = false;
  let acquired = acquireUpdateLock();
  if (!acquired && waitForLockMs > 0) {
    waitedForPeer = true;
    log("Another neko is already installing an update; waiting for it to finish ...");
    acquired = await acquireUpdateLockWithin(waitForLockMs);
  }
  if (!acquired) {
    log("Another neko is still installing an update. Try again later, then check with `neko --version`.");
    return "failed";
  }
  try {
    if (waitedForPeer && !target) {
      const installed = probeBinaryVersion(exe);
      if (installed && !isNewer(tag, installed)) {
        log(`Another neko finished installing v${installed}. Restart neko to use it.`);
        return "up-to-date";
      }
    }
    const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName()}`;
    let expectedSha: string | null = null;
    try {
      const sum = await fetch(`${url}.sha256`, { headers: { "user-agent": "neko-core" }, signal: AbortSignal.timeout(15000) });
      if (sum.ok) expectedSha = parseSha256Sidecar(await sum.text());
    } catch {
      /* handled by the required-check below */
    }
    if (!expectedSha && requiresChecksum(tag)) {
      log(`Release ${tag} is missing its required SHA-256 sidecar.`);
      return "failed";
    }
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    const showProgress = Boolean(opts.progressTty) && Boolean((process.stdout as any).isTTY);
    let bytes: Buffer;
    try {
      const mb = (n: number) => (n / 1048576).toFixed(1);
      let lastShown = 0;
      let lastHeartbeat = Date.now();
      let got = 0;
      bytes = await downloadReleaseBytes(url, (received, total) => {
        got = received;
        const now = Date.now();
        if (now - lastHeartbeat >= LOCK_HEARTBEAT_MS) {
          if (!refreshUpdateLock(now)) throw new Error("update lock ownership was lost");
          lastHeartbeat = now;
        }
        if (!showProgress || Date.now() - lastShown <= 250) return;
        lastShown = Date.now();
        const line = total > 0
          ? `  downloading ${mb(received)} / ${mb(total)} MB (${Math.floor((100 * received) / total)}%)`
          : `  downloading ${mb(received)} MB`;
        process.stdout.write(`\r${line.padEnd(48)}`);
      });
      if (showProgress) process.stdout.write(`\r${`  downloaded ${mb(got)} MB - verifying ...`.padEnd(48)}\n`);
    } catch (e) {
      if (showProgress) process.stdout.write("\n");
      // SAFETY: caught value comes from the typed API calls in this try block; a non-Error throw would surface as undefined message text.
      log(`Download failed: ${(e as Error).message}`);
      return "failed";
    }
    if (!refreshUpdateLock()) {
      log("Install stopped because update lock ownership was lost.");
      return "failed";
    }
    if (expectedSha) {
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (actualSha !== expectedSha) {
        log(`Downloaded SHA-256 does not match the official ${tag} release.`);
        return "failed";
      }
    }
    // Replace the running binary. Windows can't OVERWRITE a running exe, but it CAN rename it out of
    // the way and put the new one in place; the stale .old is cleaned up next launch. The staging file
    // is PER-PROCESS (pid suffix): even if the lock is ever bypassed, two updaters can no longer write
    // into each other's half-downloaded binary.
    const tmp = process.platform === "win32" ? `${exe}.new-${process.pid}.exe` : `${exe}.new-${process.pid}`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o755 });
      const probed = probeBinaryVersion(tmp);
      if (!probed || `v${probed}` !== tag) {
        rmSync(tmp, { force: true });
        log(`Downloaded binary failed its version probe (expected ${tag}).`);
        return "failed";
      }
      activateStagedBinary(exe, tmp);
      log(`Installed ${tag}. Restart neko to use it.`);
      return "updated";
    } catch (e) {
      // SAFETY: caught value comes from the typed API calls in this try block; a non-Error throw would surface as undefined message text.
      log(`Install failed: ${(e as Error).message}`);
      try { if (existsSync(tmp)) rmSync(tmp); } catch { /* */ }
      return "failed";
    }
  } finally {
    releaseUpdateLock();
  }
}
