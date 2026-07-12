/** Atomic installer for the optional official Gemini CLI bundle and a private Node runtime. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { homeDir } from "../shared/home.ts";
import {
  clearGeminiCliCache,
  compareGeminiVersions,
  GEMINI_CLI_MIN_VERSION,
  startGeminiAcp,
} from "./gemini-cli.ts";

const GEMINI_RELEASE_API = "https://api.github.com/repos/google-gemini/gemini-cli/releases/latest";
const GEMINI_RELEASES = "https://github.com/google-gemini/gemini-cli/releases";
const NODE_INDEX = "https://nodejs.org/dist/index.json";
const BUNDLE_ASSET = "gemini-cli-bundle.zip";
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_INSTALLED_BYTES = 420 * 1024 * 1024;

interface ReleaseAsset {
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
  assets?: ReleaseAsset[];
}

interface NodeRelease {
  version?: string;
  lts?: string | boolean;
  files?: string[];
}

interface GeminiSupportManifest {
  protocolVersion: "1";
  geminiVersion: string;
  nodeVersion: string;
  releaseTag: string;
  bundleAsset: string;
  bundleDigest: string;
  bundleArchiveBytes: number;
  nodeAsset: string;
  nodeDigest: string;
  nodeArchiveBytes: number;
  installedBytes: number;
  installedAt: string;
  entry: string;
  runtime: string;
  sourceUrl: string;
  nodeSourceUrl: string;
}

export interface GeminiSupportPackInfo extends GeminiSupportManifest {
  root: string;
  entryPath: string;
  runtimePath: string;
  alreadyInstalled?: boolean;
}

export interface GeminiSupportTarget {
  nodeArchive: string;
  nodeFolder: string;
  nodeExecutable: string;
  nodeFileMarker: string;
}

export interface InstallGeminiSupportOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetchImpl?: typeof fetch;
  force?: boolean;
  notify?: (message: string) => void;
  extractBundle?: (archive: string, destination: string) => void;
  extractNode?: (archive: string, destination: string, target: GeminiSupportTarget) => void;
  versionsOf?: (runtime: string, entry: string) => { node: string | null; gemini: string | null };
  verifyProtocol?: (runtime: string, entry: string, version: string, probeHome: string) => Promise<void>;
}

export function geminiSupportTarget(
  nodeTag: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): GeminiSupportTarget {
  if (!/^v\d+\.\d+\.\d+$/.test(nodeTag)) throw new Error(`Invalid Node release ${nodeTag}`);
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : "";
  if (!cpu) throw new Error(`Gemini Support Pack does not support CPU architecture ${arch}`);
  const os = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  if (!os) throw new Error(`Gemini Support Pack does not support ${platform}`);
  const suffix = platform === "win32" ? ".zip" : ".tar.gz";
  const nodeFolder = `node-${nodeTag}-${os}-${cpu}`;
  return {
    nodeArchive: `${nodeFolder}${suffix}`,
    nodeFolder,
    nodeExecutable: platform === "win32" ? "node.exe" : "bin/node",
    nodeFileMarker: platform === "win32" ? `win-${cpu}-zip` : platform === "darwin" ? `osx-${cpu}-tar` : `linux-${cpu}`,
  };
}

export function geminiSupportRoot(home = homeDir()): string {
  return join(home, ".neko-core", "gemini-support");
}

export function readGeminiSupportPack(home = homeDir()): GeminiSupportPackInfo | null {
  const root = geminiSupportRoot(home);
  try {
    const manifest = JSON.parse(readFileSync(join(root, "support-pack.json"), "utf8")) as GeminiSupportManifest;
    if (manifest.protocolVersion !== "1" || !safeRelative(manifest.entry) || !safeRelative(manifest.runtime)) return null;
    const entryPath = join(root, manifest.entry);
    const runtimePath = join(root, manifest.runtime);
    if (!existsSync(entryPath) || !existsSync(runtimePath)) return null;
    return { ...manifest, root, entryPath, runtimePath };
  } catch {
    return null;
  }
}

export async function installGeminiSupportPack(options: InstallGeminiSupportOptions = {}): Promise<GeminiSupportPackInfo> {
  const home = options.home ?? homeDir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const notify = options.notify ?? (() => {});

  notify("Checking the official Google Gemini CLI release...");
  const bundle = await resolveGeminiRelease(fetchImpl);
  notify("Selecting a private Node LTS runtime...");
  const node = await resolveNodeRelease(fetchImpl, platform, arch);
  const current = readGeminiSupportPack(home);
  if (!options.force && current?.geminiVersion === bundle.version && current.bundleDigest === bundle.digest
    && current.nodeVersion === node.version.slice(1) && current.nodeDigest === node.digest) {
    notify(`Gemini Support Pack ${bundle.version} is already installed.`);
    return { ...current, alreadyInstalled: true };
  }

  const parent = join(home, ".neko-core");
  const root = geminiSupportRoot(home);
  const staging = join(parent, `.gemini-support-install-${process.pid}-${Date.now()}`);
  const backup = join(parent, `.gemini-support-backup-${process.pid}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  let movedOld = false;
  try {
    const bundleArchive = join(staging, BUNDLE_ASSET);
    const nodeArchive = join(staging, node.target.nodeArchive);
    notify(`Downloading Gemini engine (${formatMiB(bundle.size)})...`);
    const bundleBytes = await download(fetchImpl, bundle.url, bundleArchive, bundle.size, bundle.digest, "Gemini", notify);
    notify("Downloading private Node runtime...");
    const nodeBytes = await download(fetchImpl, node.url, nodeArchive, undefined, node.digest, "Node", notify);

    notify("Verified downloads; unpacking the optional Support Pack...");
    const geminiDir = join(staging, "gemini");
    const nodeDir = join(staging, "node");
    (options.extractBundle ?? extractBundleArchive)(bundleArchive, geminiDir);
    (options.extractNode ?? extractNodeArchive)(nodeArchive, nodeDir, node.target);
    rmSync(bundleArchive, { force: true });
    rmSync(nodeArchive, { force: true });

    const entryPath = join(geminiDir, "gemini.js");
    const runtimePath = join(nodeDir, node.target.nodeExecutable);
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) throw new Error("Gemini bundle does not contain gemini.js");
    if (!existsSync(runtimePath) || !statSync(runtimePath).isFile()) throw new Error("Node archive does not contain the expected runtime");
    try { chmodSync(runtimePath, 0o755); } catch { /* Windows uses ACLs. */ }

    const versions = (options.versionsOf ?? realVersions)(runtimePath, entryPath);
    if (versions.node !== node.version.slice(1)) throw new Error(`Node runtime version ${versions.node ?? "unknown"} does not match ${node.version}`);
    if (versions.gemini !== bundle.version) throw new Error(`Gemini bundle version ${versions.gemini ?? "unknown"} does not match ${bundle.version}`);
    if (compareGeminiVersions(bundle.version, GEMINI_CLI_MIN_VERSION) < 0) throw new Error(`Gemini ${bundle.version} is older than required ${GEMINI_CLI_MIN_VERSION}`);

    notify("Checking Gemini ACP compatibility...");
    const probeHome = join(staging, ".protocol-probe");
    await (options.verifyProtocol ?? verifyProtocolCompatibility)(runtimePath, entryPath, bundle.version, probeHome);
    rmSync(probeHome, { recursive: true, force: true });

    const installedBytes = directoryBytes(staging);
    if (installedBytes <= 0 || installedBytes > MAX_INSTALLED_BYTES) throw new Error("Gemini Support Pack installed size is outside the safe limit");
    const manifest: GeminiSupportManifest = {
      protocolVersion: "1",
      geminiVersion: bundle.version,
      nodeVersion: node.version.slice(1),
      releaseTag: bundle.tag,
      bundleAsset: BUNDLE_ASSET,
      bundleDigest: bundle.digest,
      bundleArchiveBytes: bundleBytes,
      nodeAsset: node.target.nodeArchive,
      nodeDigest: node.digest,
      nodeArchiveBytes: nodeBytes,
      installedBytes,
      installedAt: new Date().toISOString(),
      entry: "gemini/gemini.js",
      runtime: `node/${node.target.nodeExecutable.replaceAll("\\", "/")}`,
      sourceUrl: bundle.releaseUrl,
      nodeSourceUrl: `https://nodejs.org/dist/${node.version}/`,
    };
    writeFileSync(join(staging, "support-pack.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    rmSync(backup, { recursive: true, force: true });
    if (existsSync(root)) { renameSync(root, backup); movedOld = true; }
    try { renameSync(staging, root); }
    catch (error) {
      if (movedOld && !existsSync(root)) renameSync(backup, root);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    clearGeminiCliCache();
    notify(`Gemini Support Pack ${bundle.version} is ready (${formatMiB(installedBytes)} on disk).`);
    return { ...manifest, root, entryPath: join(root, manifest.entry), runtimePath: join(root, manifest.runtime) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function removeGeminiSupportPack(home = homeDir()): boolean {
  const root = geminiSupportRoot(home);
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  clearGeminiCliCache();
  return true;
}

async function resolveGeminiRelease(fetchImpl: typeof fetch): Promise<{
  version: string; tag: string; digest: string; size: number; url: string; releaseUrl: string;
}> {
  const response = await fetchImpl(GEMINI_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "neko-core-gemini-support" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read the official Gemini release (HTTP ${response.status})`);
  const release = await response.json() as GitHubRelease;
  if (release.draft || release.prerelease) throw new Error("The latest Gemini CLI release is not stable");
  const tag = String(release.tag_name ?? "");
  const version = tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  const asset = release.assets?.find((candidate) => candidate.name === BUNDLE_ASSET);
  const size = Number(asset?.size ?? 0);
  const digest = String(asset?.digest ?? "").toLowerCase();
  const url = String(asset?.browser_download_url ?? "");
  if (!version || !asset || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) throw new Error("Official Gemini release is missing a usable CLI bundle");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("Official Gemini bundle does not publish a usable SHA-256 digest");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.pathname !== `/google-gemini/gemini-cli/releases/download/${tag}/${BUNDLE_ASSET}`) {
    throw new Error("Official Gemini release returned an unexpected download URL");
  }
  const html = String(release.html_url ?? "");
  return { version, tag, digest, size, url, releaseUrl: html.startsWith("https://github.com/google-gemini/gemini-cli/") ? html : GEMINI_RELEASES };
}

async function resolveNodeRelease(fetchImpl: typeof fetch, platform: NodeJS.Platform, arch: NodeJS.Architecture): Promise<{
  version: string; digest: string; url: string; target: GeminiSupportTarget;
}> {
  const response = await fetchImpl(NODE_INDEX, { headers: { "User-Agent": "neko-core-gemini-support" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not read official Node releases (HTTP ${response.status})`);
  const releases = await response.json() as NodeRelease[];
  const candidates = releases.filter((item) => item.lts && /^v\d+\.\d+\.\d+$/.test(String(item.version ?? "")))
    .sort((a, b) => compareGeminiVersions(String(b.version).slice(1), String(a.version).slice(1)));
  let selected: NodeRelease | undefined;
  let target: GeminiSupportTarget | undefined;
  for (const candidate of candidates) {
    const major = Number(String(candidate.version).slice(1).split(".")[0]);
    if (major < 20) continue;
    const mapped = geminiSupportTarget(String(candidate.version), platform, arch);
    if (candidate.files?.includes(mapped.nodeFileMarker)) { selected = candidate; target = mapped; break; }
  }
  if (!selected?.version || !target) throw new Error(`No compatible Node LTS runtime is available for ${platform}/${arch}`);
  const sumsUrl = `https://nodejs.org/dist/${selected.version}/SHASUMS256.txt`;
  const sums = await fetchImpl(sumsUrl, { headers: { "User-Agent": "neko-core-gemini-support" }, signal: AbortSignal.timeout(30_000) });
  if (!sums.ok) throw new Error(`Could not read the Node checksum list (HTTP ${sums.status})`);
  const line = (await sums.text()).split(/\r?\n/).find((value) => value.endsWith(`  ${target!.nodeArchive}`));
  const digest = line?.match(/^([0-9a-f]{64})\s{2}/i)?.[1]?.toLowerCase();
  if (!digest) throw new Error(`Node checksum list is missing ${target.nodeArchive}`);
  return {
    version: selected.version,
    digest: `sha256:${digest}`,
    url: `https://nodejs.org/dist/${selected.version}/${target.nodeArchive}`,
    target,
  };
}

async function download(
  fetchImpl: typeof fetch,
  url: string,
  path: string,
  expectedBytes: number | undefined,
  expectedDigest: string,
  label: string,
  notify: (message: string) => void,
): Promise<number> {
  const response = await fetchImpl(url, { headers: { "User-Agent": "neko-core-gemini-support" }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Could not download ${label} Support Pack component (HTTP ${response.status})`);
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_ARCHIVE_BYTES || (expectedBytes && announced > 0 && announced !== expectedBytes)) throw new Error(`${label} download size does not match release metadata`);
  let received = 0;
  let reported = 0;
  const total = expectedBytes || announced;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) return callback(new Error(`${label} download exceeds the safe size limit`));
      if (total) {
        const percent = Math.floor(received / total * 100);
        if (percent >= reported + 25) { reported = percent; notify(`${label} download ${Math.min(100, percent)}%...`); }
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (expectedBytes && received !== expectedBytes) throw new Error(`${label} download was incomplete (${received}/${expectedBytes} bytes)`);
  const digest = await sha256File(path);
  if (`sha256:${digest}` !== expectedDigest) throw new Error(`${label} Support Pack checksum mismatch`);
  return received;
}

function extractBundleArchive(archive: string, destination: string): void {
  const entries = listArchive(archive, true);
  validateEntries(entries);
  if (!entries.includes("gemini.js")) throw new Error("Gemini bundle archive does not contain gemini.js");
  mkdirSync(destination, { recursive: true });
  extractArchive(archive, destination, true);
}

function extractNodeArchive(archive: string, destination: string, target: GeminiSupportTarget): void {
  const zipped = archive.endsWith(".zip");
  const entries = listArchive(archive, zipped);
  validateEntries(entries);
  if (!entries.some((entry) => entry.replace(/\/$/, "") === `${target.nodeFolder}/${target.nodeExecutable}`)) {
    throw new Error("Node archive does not contain the expected runtime");
  }
  const unpack = `${destination}-unpack`;
  mkdirSync(unpack, { recursive: true });
  try {
    extractArchive(archive, unpack, zipped);
    renameSync(join(unpack, target.nodeFolder), destination);
  } finally {
    rmSync(unpack, { recursive: true, force: true });
  }
}

function listArchive(archive: string, zipped: boolean): string[] {
  const command = process.platform === "win32" || !zipped ? "tar" : "unzip";
  const args = command === "tar" ? [zipped ? "-tf" : "-tzf", archive] : ["-Z1", archive];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not inspect Support Pack archive: ${(result.stderr || `${command} is unavailable`).trim()}`);
  return result.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
}

function extractArchive(archive: string, destination: string, zipped: boolean): void {
  const command = process.platform === "win32" || !zipped ? "tar" : "unzip";
  const args = command === "tar"
    ? [zipped ? "-xf" : "-xzf", archive, "-C", destination]
    : ["-q", archive, "-d", destination];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not unpack Support Pack: ${(result.stderr || `${command} failed`).trim()}`);
}

function validateEntries(entries: string[]): void {
  if (!entries.length || entries.length > 4000) throw new Error("Support Pack archive has an invalid file count");
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      || normalized.split("/").some((part) => part === "..")) throw new Error("Support Pack archive contains an unsafe path");
  }
}

function realVersions(runtime: string, entry: string): { node: string | null; gemini: string | null } {
  const node = spawnSync(runtime, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  const gemini = spawnSync(runtime, [entry, "--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return {
    node: node.status === 0 ? `${node.stdout ?? ""}\n${node.stderr ?? ""}`.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null : null,
    gemini: gemini.status === 0 ? `${gemini.stdout ?? ""}\n${gemini.stderr ?? ""}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null : null,
  };
}

async function verifyProtocolCompatibility(runtime: string, entry: string, version: string, probeHome: string): Promise<void> {
  const client = startGeminiAcp({ path: entry, runtime, source: "managed", version }, {}, { geminiHome: probeHome });
  try { await client.initialize(30_000); }
  catch (error) { throw new Error(`Gemini ACP protocol check failed: ${error instanceof Error ? error.message : error}`); }
  finally { client.close(); }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function directoryBytes(path: string): number {
  let total = 0;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  visit(path);
  return total;
}

function safeRelative(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  const normalized = relative(".", path);
  return normalized !== ".." && !normalized.startsWith(`..${sep}`) && !isAbsolute(normalized);
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
