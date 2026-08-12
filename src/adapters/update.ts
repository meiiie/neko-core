/**
 * Self-update: `neko update` downloads the latest release binary and swaps the running executable in
 * place, plus a daily-cached startup check that notifies when a newer release exists (Claude-Code style).
 * Releases are published by the `v*` tag CI (.github/workflows/release.yml); assets are per-platform.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";

const REPO = "meiiie/neko-core";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

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
      if (typeof data.tag_name === "string" && STABLE_TAG.test(data.tag_name) && !data.draft && !data.prerelease) {
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
    const fresh = typeof held.at === "number" && now - held.at < LOCK_STALE_MS;
    const live = isAlive(held.pid);
    if (fresh && live) return false;
  } catch {
    /* unreadable/malformed -> abandoned */
  }
  try { rmSync(path, { force: true }); } catch { return false; }
  // Re-create exclusively: if another updater won the takeover race, it remains the sole owner.
  return createOwnedUpdateLock(path, now);
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
    if (typeof c.at === "number" && now - c.at < ttl) return cachedNewer ? c.latest : null;
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
 * Download a release binary and replace the running executable. Returns true on success.
 *   selfUpdate(log)            -> latest (refuses if already current)
 *   selfUpdate(log, "v0.7.7")  -> that EXACT version, UP or DOWN (a rollback). Downgrades are allowed:
 *                                 the caller pins `auto_update: false` so the daily updater can't undo it.
 * `opts.progressTty` streams inline `\r` download progress to stdout - ONLY for the CLI path on a real
 * TTY. The in-app background updater must never set it: its stdout is an Ink alt-screen, and a stray
 * `\r` line would corrupt the frame. (An 88 MB download with no output at all is the other failure
 * mode: it reads as a hang, and the user kills it mid-swap.)
 */
export async function selfUpdate(log: (s: string) => void, target?: string, opts: { progressTty?: boolean } = {}): Promise<boolean> {
  const exe = process.execPath;
  if (basename(exe).replace(/\.exe$/i, "").toLowerCase() === "bun") {
    log("Running from source (bun). Update with:  git pull && bun run build");
    return false;
  }
  let tag: string;
  if (target) {
    const t = normalizeTag(target);
    if (!t) { log(`Not a version: "${target}" (use e.g. 0.7.7).`); return false; }
    tag = t;
    if (t.replace(/^v/, "") === VERSION) { log(`Already on ${t}.`); return false; }
    log(isNewer(t, VERSION) ? `Switching v${VERSION} -> ${t} ...` : `Rolling back v${VERSION} -> ${t} ...`);
  } else {
    const latest = await latestVersion();
    if (!latest) {
      log("Could not reach the release server (check your connection).");
      return false;
    }
    if (!isNewer(latest, VERSION)) {
      log(`Already up to date (v${VERSION}).`);
      return false;
    }
    tag = latest;
    log(`Updating v${VERSION} -> ${tag} ...`);
  }
  // One installer at a time, machine-wide (see acquireUpdateLock). A second caller says so and
  // leaves, instead of silently double-downloading and racing the swap.
  if (!acquireUpdateLock()) {
    log("Another neko is already installing an update. Let it finish, then check with `neko --version`.");
    return false;
  }
  try {
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
      return false;
    }
    const showProgress = Boolean(opts.progressTty) && Boolean((process.stdout as any).isTTY);
    let bytes: Buffer;
    try {
      const res = await fetch(url, { headers: { "user-agent": "neko-core" }, signal: AbortSignal.timeout(300000) });
      if (!res.ok) {
        log(`Download failed: HTTP ${res.status} (${url})`);
        return false;
      }
      // Stream so the CLI can SHOW the download moving. A silent 88 MB fetch reads as a hang - the
      // field screenshot was a user killing exactly that wait.
      const reader = res.body?.getReader?.();
      if (!reader) {
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        const total = Number(res.headers.get("content-length") ?? 0);
        const mb = (n: number) => (n / 1048576).toFixed(1);
        const chunks: Uint8Array[] = [];
        let got = 0;
        let lastShown = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
          got += chunk.value.byteLength;
          if (showProgress && Date.now() - lastShown > 250) {
            lastShown = Date.now();
            const line = total > 0
              ? `  downloading ${mb(got)} / ${mb(total)} MB (${Math.floor((100 * got) / total)}%)`
              : `  downloading ${mb(got)} MB`;
            process.stdout.write(`\r${line.padEnd(48)}`);
          }
        }
        if (showProgress) process.stdout.write(`\r${`  downloaded ${mb(got)} MB - verifying ...`.padEnd(48)}\n`);
        bytes = Buffer.concat(chunks as any);
      }
    } catch (e) {
      if (showProgress) process.stdout.write("\n");
      log(`Download failed: ${(e as Error).message}`);
      return false;
    }
    if (expectedSha) {
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (actualSha !== expectedSha) {
        log(`Downloaded SHA-256 does not match the official ${tag} release.`);
        return false;
      }
    }
    // Replace the running binary. Windows can't OVERWRITE a running exe, but it CAN rename it out of
    // the way and put the new one in place; the stale .old is cleaned up next launch. The staging file
    // is PER-PROCESS (pid suffix): even if the lock is ever bypassed, two updaters can no longer write
    // into each other's half-downloaded binary.
    const tmp = process.platform === "win32" ? `${exe}.new-${process.pid}.exe` : `${exe}.new-${process.pid}`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o755 });
      const probe = spawnSync(tmp, ["version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
      const probed = /^neko-core\s+([0-9]+\.[0-9]+\.[0-9]+)/m.exec(probe.stdout ?? "")?.[1];
      if (probe.status !== 0 || !probed || `v${probed}` !== tag) {
        rmSync(tmp, { force: true });
        log(`Downloaded binary failed its version probe (expected ${tag}).`);
        return false;
      }
      activateStagedBinary(exe, tmp);
      log(`Installed ${tag}. Restart neko to use it.`);
      return true;
    } catch (e) {
      log(`Install failed: ${(e as Error).message}`);
      try { if (existsSync(tmp)) rmSync(tmp); } catch { /* */ }
      return false;
    }
  } finally {
    releaseUpdateLock();
  }
}
