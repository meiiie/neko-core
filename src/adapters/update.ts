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

/** Download the latest release binary and replace the running executable. Returns true on success. */
export async function selfUpdate(log: (s: string) => void): Promise<boolean> {
  const exe = process.execPath;
  if (basename(exe).replace(/\.exe$/i, "").toLowerCase() === "bun") {
    log("Running from source (bun). Update with:  git pull && bun run build");
    return false;
  }
  const latest = await latestVersion();
  if (!latest) {
    log("Could not reach the release server (check your connection).");
    return false;
  }
  if (!isNewer(latest, VERSION)) {
    log(`Already up to date (v${VERSION}).`);
    return false;
  }
  log(`Updating v${VERSION} -> ${latest} ...`);
  const url = `https://github.com/${REPO}/releases/download/${latest}/${assetName()}`;
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
    log(`Updated to ${latest}. Restart neko to use it.`);
    return true;
  } catch (e) {
    log(`Install failed: ${(e as Error).message}`);
    try { if (existsSync(tmp)) rmSync(tmp); } catch { /* */ }
    return false;
  }
}
