/**
 * Self-update: `neko update` downloads the latest release binary and swaps the running executable in
 * place, plus a daily-cached startup check that notifies when a newer release exists (Claude-Code style).
 * Releases are published by the `v*` tag CI (.github/workflows/release.yml); assets are per-platform.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";

const REPO = "meiiie/neko-core";

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

/** Latest release tag from GitHub (e.g. "v0.3.0"), or null if unreachable. */
export async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "neko-core", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data.tag_name === "string" ? data.tag_name : null;
  } catch {
    return null;
  }
}

const cachePath = () => join(homeDir(), ".neko-core", ".update-check.json");

/** Remove the stale `<exe>.old` left by a previous self-update. On Windows the old exe is still LOCKED
 * by the running process during the update itself, so the swap can't delete it - only the NEXT launch
 * (this call) can. Cheap no-op when there's nothing to clean; never throws. Called from startup. */
export function cleanupStaleUpdate(exe = process.execPath): void {
  try { rmSync(`${exe}.old`, { force: true }); } catch { /* still locked or permission - try again next launch */ }
}

/** Daily-cached check: returns the newer version string if one exists, else null. Never throws. */
export async function checkForUpdate(now = Date.now()): Promise<string | null> {
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf-8"));
    if (typeof c.at === "number" && now - c.at < 24 * 3600 * 1000) {
      return c.latest && isNewer(c.latest, VERSION) ? c.latest : null;
    }
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
 */
export async function selfUpdate(log: (s: string) => void, target?: string): Promise<boolean> {
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
  const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName()}`;
  let bytes: Buffer;
  try {
    const res = await fetch(url, { headers: { "user-agent": "neko-core" }, signal: AbortSignal.timeout(300000) });
    if (!res.ok) {
      log(`Download failed: HTTP ${res.status} (${url})`);
      return false;
    }
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log(`Download failed: ${(e as Error).message}`);
    return false;
  }
  // Replace the running binary. Windows can't OVERWRITE a running exe, but it CAN rename it out of the
  // way and put the new one in place; the stale .old is cleaned up next launch.
  const tmp = `${exe}.new`;
  const old = `${exe}.old`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    try { if (existsSync(old)) rmSync(old); } catch { /* may be locked */ }
    renameSync(exe, old);
    renameSync(tmp, exe);
    try { rmSync(old); } catch { /* in use on Windows; harmless */ }
    log(`Installed ${tag}. Restart neko to use it.`);
    return true;
  } catch (e) {
    log(`Install failed: ${(e as Error).message}`);
    try { if (existsSync(tmp)) rmSync(tmp); } catch { /* */ }
    return false;
  }
}
