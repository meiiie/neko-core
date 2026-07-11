/** Install the optional, standalone Codex App Server used only by GPT-5.6 subscription models. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { homeDir } from "../shared/home.ts";
import {
  clearCodexSupportCache,
  CODEX_APP_SERVER_MIN_VERSION,
  compareCodexVersions,
  startCodexAppServer,
} from "./codex-app-server.ts";

const RELEASE_API = "https://api.github.com/repos/openai/codex/releases/latest";
const RELEASE_PAGE = "https://github.com/openai/codex/releases";
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;

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

interface SupportPackManifest {
  protocolVersion: string;
  releaseTag: string;
  assetName: string;
  assetDigest: string;
  archiveBytes: number;
  installedBytes: number;
  installedAt: string;
  executable: string;
  sourceUrl: string;
}

export interface CodexSupportPackInfo extends SupportPackManifest {
  path: string;
  alreadyInstalled?: boolean;
}

export interface CodexSupportTarget {
  triple: string;
  executable: string;
  archiveName: string;
}

export interface InstallCodexSupportOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetchImpl?: typeof fetch;
  force?: boolean;
  notify?: (message: string) => void;
  extractArchive?: (archive: string, staging: string, entry: string) => void;
  verifyBinary?: (path: string, platform: NodeJS.Platform) => void;
  versionOf?: (path: string) => string | null;
  verifyProtocol?: (path: string, version: string, probeHome: string) => Promise<void>;
}

export function codexSupportTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): CodexSupportTarget {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : "";
  if (!cpu) throw new Error(`GPT-5.6 Support Pack does not support CPU architecture ${arch}`);
  const os = platform === "win32" ? "pc-windows-msvc"
    : platform === "darwin" ? "apple-darwin"
    : platform === "linux" ? "unknown-linux-musl"
    : "";
  if (!os) throw new Error(`GPT-5.6 Support Pack does not support ${platform}`);
  const triple = `${cpu}-${os}`;
  const executable = `codex-app-server-${triple}${platform === "win32" ? ".exe" : ""}`;
  return { triple, executable, archiveName: `${executable}.tar.gz` };
}

export function codexSupportRoot(home = homeDir()): string {
  return join(home, ".neko-core", "codex-support");
}

export function readCodexSupportPack(home = homeDir()): CodexSupportPackInfo | null {
  const root = codexSupportRoot(home);
  try {
    const manifest = JSON.parse(readFileSync(join(root, "support-pack.json"), "utf8")) as SupportPackManifest;
    if (!manifest.executable || isAbsolute(manifest.executable) || /[\\/]/.test(manifest.executable)) return null;
    const path = join(root, manifest.executable);
    if (!manifest.protocolVersion || !existsSync(path)) return null;
    return { ...manifest, path };
  } catch {
    return null;
  }
}

export async function installCodexSupportPack(options: InstallCodexSupportOptions = {}): Promise<CodexSupportPackInfo> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? homeDir();
  const fetchImpl = options.fetchImpl ?? fetch;
  const notify = options.notify ?? (() => {});
  const target = codexSupportTarget(platform, arch);

  notify("Checking the official OpenAI Codex release...");
  const releaseResponse = await fetchImpl(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "neko-core-codex-support" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!releaseResponse.ok) throw new Error(`Could not read the official Codex release (HTTP ${releaseResponse.status})`);
  const release = await releaseResponse.json() as GitHubRelease;
  const resolved = resolveRelease(release, target);

  const current = readCodexSupportPack(home);
  if (!options.force && current?.protocolVersion === resolved.version && current.assetDigest === resolved.digest) {
    notify(`GPT-5.6 Support Pack ${resolved.version} is already installed.`);
    return { ...current, alreadyInstalled: true };
  }

  const parent = join(home, ".neko-core");
  const root = codexSupportRoot(home);
  const staging = join(parent, `.codex-support-install-${process.pid}-${Date.now()}`);
  const backup = join(parent, `.codex-support-backup-${process.pid}`);
  const archive = join(staging, target.archiveName);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  let movedOld = false;
  try {
    notify(`Downloading ${formatMiB(resolved.size)} optional support component...`);
    const downloaded = await downloadAsset(fetchImpl, resolved.url, archive, resolved.size, notify);
    const digest = await sha256File(archive);
    if (`sha256:${digest}` !== resolved.digest) {
      throw new Error(`Codex Support Pack checksum mismatch (expected ${resolved.digest}, got sha256:${digest})`);
    }
    notify("Checksum verified; extracting the standalone App Server...");
    (options.extractArchive ?? extractTarGz)(archive, staging, target.executable);
    const extracted = join(staging, target.executable);
    if (!existsSync(extracted) || !statSync(extracted).isFile()) throw new Error("Codex archive did not contain the expected App Server binary");
    try { chmodSync(extracted, 0o755); } catch { /* Windows uses Authenticode/ACLs instead. */ }

    (options.verifyBinary ?? verifyOfficialBinary)(extracted, platform);
    const version = (options.versionOf ?? binaryVersion)(extracted);
    if (!version || compareCodexVersions(version, resolved.version) !== 0) {
      throw new Error(`Codex binary version ${version ?? "unknown"} does not match release ${resolved.version}`);
    }
    notify("Checking Codex App Server protocol compatibility...");
    const probeHome = join(staging, ".protocol-probe");
    await (options.verifyProtocol ?? verifyProtocolCompatibility)(extracted, version, probeHome);
    rmSync(probeHome, { recursive: true, force: true });

    const installedName = platform === "win32" ? "codex-app-server.exe" : "codex-app-server";
    const installedPath = join(staging, installedName);
    renameSync(extracted, installedPath);
    rmSync(archive, { force: true });
    const manifest: SupportPackManifest = {
      protocolVersion: version,
      releaseTag: resolved.tag,
      assetName: target.archiveName,
      assetDigest: resolved.digest,
      archiveBytes: downloaded,
      installedBytes: statSync(installedPath).size,
      installedAt: new Date().toISOString(),
      executable: installedName,
      sourceUrl: resolved.releaseUrl,
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
    clearCodexSupportCache();
    notify(`GPT-5.6 Support Pack ${version} is ready (${formatMiB(manifest.installedBytes)} on disk).`);
    return { ...manifest, path: join(root, installedName) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function removeCodexSupportPack(home = homeDir()): boolean {
  const root = codexSupportRoot(home);
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  clearCodexSupportCache();
  return true;
}

function resolveRelease(release: GitHubRelease, target: CodexSupportTarget): {
  version: string;
  tag: string;
  digest: string;
  size: number;
  url: string;
  releaseUrl: string;
} {
  if (release.draft || release.prerelease) throw new Error("The latest Codex release is not a stable release");
  const tag = String(release.tag_name ?? "");
  const version = tag.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version || compareCodexVersions(version, CODEX_APP_SERVER_MIN_VERSION) < 0) {
    throw new Error(`The latest official Codex release (${tag || "unknown"}) is not compatible with GPT-5.6`);
  }
  const asset = release.assets?.find((candidate) => candidate.name === target.archiveName);
  const size = Number(asset?.size ?? 0);
  const digest = String(asset?.digest ?? "").toLowerCase();
  const url = String(asset?.browser_download_url ?? "");
  if (!asset || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) throw new Error(`Official release is missing ${target.archiveName}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("Official Codex asset does not publish a usable SHA-256 digest");
  const parsed = new URL(url);
  const expectedPrefix = `/openai/codex/releases/download/${tag}/`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith(expectedPrefix) || basename(parsed.pathname) !== target.archiveName) {
    throw new Error("Official Codex release returned an unexpected download URL");
  }
  const releaseUrl = String(release.html_url ?? "");
  return { version, tag, digest, size, url, releaseUrl: releaseUrl.startsWith("https://github.com/openai/codex/") ? releaseUrl : RELEASE_PAGE };
}

async function downloadAsset(fetchImpl: typeof fetch, url: string, path: string, expectedBytes: number, notify: (message: string) => void): Promise<number> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "neko-core-codex-support" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`Could not download Codex Support Pack (HTTP ${response.status})`);
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_ARCHIVE_BYTES || (announced > 0 && announced !== expectedBytes)) throw new Error("Codex Support Pack download size does not match the release metadata");
  let received = 0;
  let reported = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      const percent = Math.floor(received / expectedBytes * 100);
      if (percent >= reported + 25) { reported = percent; notify(`Download ${Math.min(100, percent)}%...`); }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (received !== expectedBytes) throw new Error(`Codex Support Pack download was incomplete (${received}/${expectedBytes} bytes)`);
  return received;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function extractTarGz(archive: string, staging: string, entry: string): void {
  if (basename(entry) !== entry) throw new Error("Unsafe Codex archive entry");
  const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (listed.status !== 0) throw new Error(`Could not inspect Codex archive: ${(listed.stderr || "tar is unavailable").trim()}`);
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length !== 1 || entries[0] !== entry) throw new Error("Codex archive contains unexpected files");
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", staging, entry], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (extracted.status !== 0) throw new Error(`Could not extract Codex archive: ${(extracted.stderr || "tar failed").trim()}`);
}

function verifyOfficialBinary(path: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:NEKO_CODEX_VERIFY_PATH; [pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress";
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, NEKO_CODEX_VERIFY_PATH: path },
    });
    let signature: { status?: string; subject?: string } = {};
    try { signature = JSON.parse(result.stdout || "{}"); } catch { /* reported below */ }
    if (result.status !== 0 || signature.status !== "Valid" || !/\bOpenAI OpCo, LLC\b/i.test(signature.subject ?? "")) {
      throw new Error("Codex App Server does not have a valid OpenAI Windows signature");
    }
  } else if (platform === "darwin") {
    const result = spawnSync("codesign", ["--verify", "--strict", path], { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) throw new Error("Codex App Server failed macOS code-signature verification");
  }
  // Linux release archives are authenticated by the SHA-256 digest from the official GitHub API.
}

function binaryVersion(path: string): string | null {
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

async function verifyProtocolCompatibility(path: string, version: string, probeHome: string): Promise<void> {
  const client = startCodexAppServer(
    { path, kind: "app-server", source: "managed", version },
    {},
    { codexHome: probeHome },
  );
  try { await client.initialize(20_000); }
  catch (error) { throw new Error(`Codex App Server protocol check failed: ${error instanceof Error ? error.message : error}`); }
  finally { client.close(); }
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
