/** Optional OfficeCLI binary used by Neko's typed Office artifact adapter. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { homeDir } from "../shared/home.ts";

const RELEASE_API = "https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest";
const RELEASE_PAGE = "https://github.com/iOfficeAI/OfficeCLI/releases";
const MAX_BINARY_BYTES = 80 * 1024 * 1024;

interface GitHubAsset {
  name?: string;
  size?: number;
  digest?: string;
  browser_download_url?: string;
}

interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  assets?: GitHubAsset[];
}

interface OfficeSupportManifest {
  officeVersion: string;
  releaseTag: string;
  assetName: string;
  assetDigest: string;
  archiveBytes: number;
  installedBytes: number;
  installedAt: string;
  executable: string;
  sourceUrl: string;
  license: "Apache-2.0";
}

export interface OfficeSupportPackInfo extends OfficeSupportManifest {
  path: string;
  alreadyInstalled?: boolean;
}

export interface OfficeSupportTarget {
  assetName: string;
  executable: string;
}

export interface OfficeExecutable {
  path: string;
  source: "managed" | "path";
  version?: string;
  digest?: string;
}

export interface OfficeSupportStatus {
  state: "ready" | "missing" | "broken";
  detail: string;
  executable?: OfficeExecutable;
}

export interface InstallOfficeSupportOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  alpine?: boolean;
  fetchImpl?: typeof fetch;
  force?: boolean;
  notify?: (message: string) => void;
  verifyBinary?: (path: string, platform: NodeJS.Platform) => void;
  versionOf?: (path: string) => string | null;
  verifyProtocol?: (path: string, staging: string) => void;
}

export function officeSupportTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  alpine = platform === "linux" && existsSync("/etc/alpine-release"),
): OfficeSupportTarget {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Office Support Pack does not support CPU architecture ${arch}`);
  const cpu = arch === "x64" ? "x64" : "arm64";
  const os = platform === "win32" ? "win"
    : platform === "darwin" ? "mac"
    : platform === "linux" ? (alpine ? "linux-alpine" : "linux")
    : "";
  if (!os) throw new Error(`Office Support Pack does not support ${platform}`);
  const suffix = platform === "win32" ? ".exe" : "";
  return { assetName: `officecli-${os}-${cpu}${suffix}`, executable: `officecli${suffix}` };
}

export function officeSupportRoot(home = homeDir()): string {
  return join(home, ".neko-core", "office-support");
}

export function readOfficeSupportPack(home = homeDir()): OfficeSupportPackInfo | null {
  const root = officeSupportRoot(home);
  try {
    const manifest = JSON.parse(readFileSync(join(root, "support-pack.json"), "utf8")) as OfficeSupportManifest;
    if (!manifest.executable || isAbsolute(manifest.executable) || /[\\/]/.test(manifest.executable)) return null;
    const path = join(root, manifest.executable);
    if (!manifest.officeVersion || manifest.license !== "Apache-2.0" || !/^sha256:[0-9a-f]{64}$/.test(manifest.assetDigest) || !existsSync(path)) return null;
    if (!statSync(path).isFile() || statSync(path).size !== manifest.installedBytes) return null;
    return { ...manifest, path };
  } catch {
    return null;
  }
}

export function resolveOfficeExecutable(home = homeDir(), which: (name: string) => string | null = (name) => Bun.which(name)): OfficeExecutable | null {
  const managed = readOfficeSupportPack(home);
  if (managed) return { path: managed.path, source: "managed", version: managed.officeVersion, digest: managed.assetDigest };
  const path = which("officecli");
  return path ? { path, source: "path" } : null;
}

export function discoverOfficeCli(
  home = homeDir(),
  options: { which?: (name: string) => string | null; versionOf?: (path: string) => string | null } = {},
): OfficeSupportStatus {
  const executable = resolveOfficeExecutable(home, options.which);
  if (!executable) return {
    state: "missing",
    detail: "optional Office engine is not installed; use /support office or `neko support office install`",
  };
  const version = executable.version ?? (options.versionOf ?? binaryVersion)(executable.path) ?? undefined;
  if (!version) return { state: "broken", detail: `${executable.source} OfficeCLI did not pass the version probe`, executable };
  return {
    state: "ready",
    detail: `OfficeCLI ${version} (${executable.source === "managed" ? "managed by Neko" : "existing PATH install"})`,
    executable: { ...executable, version },
  };
}

export async function installOfficeSupportPack(options: InstallOfficeSupportOptions = {}): Promise<OfficeSupportPackInfo> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? homeDir();
  const fetchImpl = options.fetchImpl ?? fetch;
  const notify = options.notify ?? (() => {});
  const target = officeSupportTarget(platform, arch, options.alpine);

  notify("Checking the official iOfficeAI OfficeCLI release...");
  const response = await fetchImpl(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "neko-core-office-support" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read the official OfficeCLI release (HTTP ${response.status})`);
  const resolved = resolveRelease(await response.json() as GitHubRelease, target);

  const current = readOfficeSupportPack(home);
  if (!options.force && current?.officeVersion === resolved.version && current.assetDigest === resolved.digest) {
    const actual = `sha256:${await sha256File(current.path)}`;
    if (actual === resolved.digest) {
      notify(`Office Support Pack ${resolved.version} is already installed.`);
      return { ...current, alreadyInstalled: true };
    }
    notify("The existing Office Support Pack failed its integrity check; repairing it...");
  }

  const parent = join(home, ".neko-core");
  const root = officeSupportRoot(home);
  const staging = join(parent, `.office-support-install-${process.pid}-${Date.now()}`);
  const backup = join(parent, `.office-support-backup-${process.pid}`);
  const downloadedPath = join(staging, target.assetName);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  let movedOld = false;
  try {
    notify(`Downloading ${formatMiB(resolved.size)} optional Office component...`);
    const downloaded = await downloadAsset(fetchImpl, resolved.url, downloadedPath, resolved.size, notify);
    const digest = await sha256File(downloadedPath);
    if (`sha256:${digest}` !== resolved.digest) {
      throw new Error(`Office Support Pack checksum mismatch (expected ${resolved.digest}, got sha256:${digest})`);
    }
    try { chmodSync(downloadedPath, 0o755); } catch { /* Windows uses executable ACLs. */ }
    (options.verifyBinary ?? verifyExecutableFormat)(downloadedPath, platform);
    // The SHA-256 digest above already cryptographically proves this IS the exact published asset
    // for resolved.version, so the --version string is only a smoke test. Some builds don't expose a
    // parseable --version (probe returns null); trust the checksum + the protocol probe below rather
    // than hard-failing on "version unknown". A NON-null version that disagrees is still a real
    // mismatch and must fail. This was the false "binary version unknown does not match" loop.
    const probed = (options.versionOf ?? binaryVersion)(downloadedPath);
    if (probed !== null && probed !== undefined && probed !== resolved.version) {
      throw new Error(`OfficeCLI binary version ${probed} does not match release ${resolved.version}`);
    }
    const version = resolved.version;
    notify("Checksum verified; checking document protocol compatibility...");
    (options.verifyProtocol ?? verifyOfficeProtocol)(downloadedPath, staging);

    const installedPath = join(staging, target.executable);
    renameSync(downloadedPath, installedPath);
    const manifest: OfficeSupportManifest = {
      officeVersion: version,
      releaseTag: resolved.tag,
      assetName: target.assetName,
      assetDigest: resolved.digest,
      archiveBytes: downloaded,
      installedBytes: statSync(installedPath).size,
      installedAt: new Date().toISOString(),
      executable: target.executable,
      sourceUrl: resolved.releaseUrl,
      license: "Apache-2.0",
    };
    writeFileSync(join(staging, "support-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    rmSync(backup, { recursive: true, force: true });
    if (existsSync(root)) { renameSync(root, backup); movedOld = true; }
    try {
      renameSync(staging, root);
    } catch (error) {
      if (movedOld && !existsSync(root)) renameSync(backup, root);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    notify(`Office Support Pack ${version} is ready (${formatMiB(manifest.installedBytes)} on disk).`);
    return { ...manifest, path: join(root, target.executable) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function removeOfficeSupportPack(home = homeDir()): boolean {
  const root = officeSupportRoot(home);
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  return true;
}

function resolveRelease(release: GitHubRelease, target: OfficeSupportTarget): {
  version: string; tag: string; digest: string; size: number; url: string; releaseUrl: string;
} {
  if (release.draft || release.prerelease) throw new Error("The latest OfficeCLI release is not a stable release");
  const tag = String(release.tag_name ?? "");
  const version = tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error(`The latest official OfficeCLI release tag (${tag || "unknown"}) is invalid`);
  const asset = release.assets?.find((candidate) => candidate.name === target.assetName);
  const size = Number(asset?.size ?? 0);
  const digest = String(asset?.digest ?? "").toLowerCase();
  const url = String(asset?.browser_download_url ?? "");
  if (!asset || !Number.isSafeInteger(size) || size <= 0 || size > MAX_BINARY_BYTES) throw new Error(`Official release is missing ${target.assetName}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("Official OfficeCLI asset does not publish a usable SHA-256 digest");
  const parsed = new URL(url);
  const expectedPath = `/iOfficeAI/OfficeCLI/releases/download/${tag}/${target.assetName}`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.pathname !== expectedPath || basename(parsed.pathname) !== target.assetName) {
    throw new Error("Official OfficeCLI release returned an unexpected download URL");
  }
  const releaseUrl = String(release.html_url ?? "");
  return { version, tag, digest, size, url, releaseUrl: releaseUrl.startsWith("https://github.com/iOfficeAI/OfficeCLI/") ? releaseUrl : RELEASE_PAGE };
}

async function downloadAsset(fetchImpl: typeof fetch, url: string, path: string, expectedBytes: number, notify: (message: string) => void): Promise<number> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "neko-core-office-support" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`Could not download Office Support Pack (HTTP ${response.status})`);
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_BINARY_BYTES || (announced > 0 && announced !== expectedBytes)) throw new Error("Office Support Pack download size does not match release metadata");
  let received = 0;
  let reported = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      const percent = Math.floor(received / expectedBytes * 100);
      if (percent >= reported + 25) { reported = percent; notify(`Office download ${Math.min(100, percent)}%...`); }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (received !== expectedBytes) throw new Error(`Office Support Pack download was incomplete (${received}/${expectedBytes} bytes)`);
  return received;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function officeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OFFICECLI_SKIP_UPDATE: "1",
    OFFICECLI_NO_AUTO_INSTALL: "1",
    OFFICECLI_NO_AUTO_RESIDENT: "1",
  };
}

function verifyExecutableFormat(path: string, platform: NodeJS.Platform): void {
  const header = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length) throw new Error("Office Support Pack binary is truncated");
  } finally { closeSync(fd); }
  const valid = platform === "win32" ? header[0] === 0x4d && header[1] === 0x5a
    : platform === "linux" ? header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    : platform === "darwin" ? new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]).has(header.readUInt32BE(0))
    : false;
  if (!valid) throw new Error("Office Support Pack does not match the expected executable format");
}

function binaryVersion(path: string): string | null {
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: officeEnv() });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

function verifyOfficeProtocol(path: string, staging: string): void {
  const probe = join(staging, "neko-office-probe.docx");
  const create = spawnSync(path, ["create", probe, "--json"], { encoding: "utf8", timeout: 30_000, windowsHide: true, env: officeEnv() });
  if (create.status !== 0 || !existsSync(probe)) throw new Error(`OfficeCLI create probe failed: ${(create.stderr || create.stdout || "no output").trim()}`);
  const validate = spawnSync(path, ["validate", probe, "--json"], { encoding: "utf8", timeout: 30_000, windowsHide: true, env: officeEnv() });
  rmSync(probe, { force: true });
  if (validate.status !== 0) throw new Error(`OfficeCLI validation probe failed: ${(validate.stderr || validate.stdout || "no output").trim()}`);
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
