/** Optional local meeting transcription engine, installed from verified upstream release artifacts. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { homeDir } from "../shared/home.ts";

const RELEASE_API = "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest";
const RELEASE_REPO = "ggml-org/whisper.cpp";
const MAX_ENGINE_BYTES = 64 * 1024 * 1024;
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024;
const INTEGRITY_CACHE = new Map<string, Promise<void>>();

export type MeetingModelTier = "quick" | "balanced";

const MODELS = {
  quick: {
    id: "whisper-base-q5_1",
    file: "ggml-base-q5_1.bin",
    bytes: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  },
  balanced: {
    id: "whisper-small-q5_1",
    file: "ggml-small-q5_1.bin",
    bytes: 190_085_487,
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  },
} as const;

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

export interface MeetingSupportTarget {
  assetName: string;
  executableName: string;
}

interface MeetingSupportManifest {
  schemaVersion: 1;
  installedAt: string;
  engine?: {
    version: string;
    releaseTag: string;
    assetName: string;
    assetDigest: string;
    archiveBytes: number;
    executable: string;
    executableBytes: number;
    executableSha256: string;
    sourceUrl: string;
    license: "MIT";
  };
  model: {
    tier: MeetingModelTier;
    id: string;
    file: string;
    bytes: number;
    sha256: string;
    sourceUrl: string;
  };
}

export interface MeetingSupportPackInfo extends MeetingSupportManifest {
  root: string;
  executablePath?: string;
  modelPath: string;
  alreadyInstalled?: boolean;
}

export interface MeetingTranscriber {
  executable: string;
  executableSource: "managed" | "path";
  engineVersion?: string;
  model: string;
  modelId: string;
  modelTier: MeetingModelTier;
  modelSha256: string;
}

export interface MeetingSupportStatus {
  state: "ready" | "missing" | "broken";
  detail: string;
  transcriber?: MeetingTranscriber;
}

export interface InstallMeetingSupportOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  tier?: MeetingModelTier;
  fetchImpl?: typeof fetch;
  force?: boolean;
  notify?: (message: string) => void;
  which?: (name: string) => string | null;
  extractArchive?: (archive: string, destination: string) => void;
  versionOf?: (path: string) => string | null;
}

export function meetingSupportTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): MeetingSupportTarget | null {
  if (platform === "win32" && arch === "x64") return { assetName: "whisper-bin-x64.zip", executableName: "whisper-cli.exe" };
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return { assetName: `whisper-bin-ubuntu-${arch}.tar.gz`, executableName: "whisper-cli" };
  }
  return null;
}

export function meetingSupportRoot(home = homeDir()): string {
  return join(home, ".neko-core", "meeting-support");
}

export function readMeetingSupportPack(home = homeDir()): MeetingSupportPackInfo | null {
  const root = meetingSupportRoot(home);
  try {
    const manifest = JSON.parse(readFileSync(join(root, "support-pack.json"), "utf8")) as MeetingSupportManifest;
    if (manifest.schemaVersion !== 1 || !manifest.model || !isSafeRelative(manifest.model.file)) return null;
    const modelPath = join(root, manifest.model.file);
    if (!existsSync(modelPath) || statSync(modelPath).size !== manifest.model.bytes || !/^[0-9a-f]{64}$/.test(manifest.model.sha256)) return null;
    let executablePath: string | undefined;
    if (manifest.engine) {
      if (!isSafeRelative(manifest.engine.executable) || !/^[0-9a-f]{64}$/.test(manifest.engine.executableSha256)) return null;
      executablePath = join(root, manifest.engine.executable);
      if (!existsSync(executablePath) || statSync(executablePath).size !== manifest.engine.executableBytes) return null;
    }
    return { ...manifest, root, executablePath, modelPath };
  } catch {
    return null;
  }
}

export function discoverMeetingSupport(
  home = homeDir(),
  which: (name: string) => string | null = (name) => Bun.which(name),
): MeetingSupportStatus {
  const pack = readMeetingSupportPack(home);
  const pathEngine = which("whisper-cli") ?? which("whisper.cpp");
  const executable = pack?.executablePath ?? pathEngine;
  if (!pack && !executable) return {
    state: "missing",
    detail: "local meeting transcription is not installed; use /support meeting or `neko support meeting install`",
  };
  if (!pack) return {
    state: "missing",
    detail: "a whisper.cpp executable exists, but Neko's verified meeting model is not installed",
  };
  if (!executable) return {
    state: "missing",
    detail: process.platform === "darwin"
      ? "the meeting model is installed; install whisper.cpp (for example `brew install whisper-cpp`) and retry"
      : "the managed meeting engine is missing",
  };
  return {
    state: "ready",
    detail: `${pack.model.id} (${pack.model.tier}) through ${pack.executablePath ? `managed whisper.cpp ${pack.engine?.version ?? ""}`.trim() : "existing whisper.cpp"}`,
    transcriber: {
      executable,
      executableSource: pack.executablePath ? "managed" : "path",
      engineVersion: pack.engine?.version,
      model: pack.modelPath,
      modelId: pack.model.id,
      modelTier: pack.model.tier,
      modelSha256: pack.model.sha256,
    },
  };
}

export async function verifyMeetingSupportIntegrity(home = homeDir()): Promise<MeetingTranscriber> {
  const status = discoverMeetingSupport(home);
  if (status.state !== "ready" || !status.transcriber) throw new Error(status.detail);
  const pack = readMeetingSupportPack(home)!;
  await verifyInstalledFile(pack.modelPath, pack.model.sha256, "meeting model");
  if (pack.executablePath && pack.engine) await verifyInstalledFile(pack.executablePath, pack.engine.executableSha256, "meeting engine");
  return status.transcriber;
}

export async function installMeetingSupportPack(options: InstallMeetingSupportOptions = {}): Promise<MeetingSupportPackInfo> {
  const home = options.home ?? homeDir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const tier = options.tier ?? "balanced";
  const model = MODELS[tier];
  const fetchImpl = options.fetchImpl ?? fetch;
  const notify = options.notify ?? (() => {});
  const target = meetingSupportTarget(platform, arch);
  const current = readMeetingSupportPack(home);
  if (!options.force && current?.model.sha256 === model.sha256 && (current.executablePath || findPathEngine(options.which ?? ((name: string) => Bun.which(name))))) {
    try {
      await verifyMeetingSupportIntegrity(home);
      notify(`Meeting Support Pack (${model.id}) is already installed.`);
      return { ...current, alreadyInstalled: true };
    } catch {
      notify("Meeting Support Pack integrity needs repair; replacing the managed files...");
    }
  }

  const parent = join(home, ".neko-core");
  const root = meetingSupportRoot(home);
  const staging = join(parent, `.meeting-support-install-${process.pid}-${Date.now()}`);
  const backup = join(parent, `.meeting-support-backup-${process.pid}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  let movedOld = false;
  try {
    let engine: MeetingSupportManifest["engine"];
    let executablePath: string | undefined;
    if (target) {
      notify("Checking the official ggml-org whisper.cpp release...");
      const response = await fetchImpl(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "neko-core-meeting-support" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Could not read the official whisper.cpp release (HTTP ${response.status})`);
      const release = resolveRelease(await response.json() as GitHubRelease, target);
      const archive = join(staging, target.assetName);
      notify(`Downloading ${formatMiB(release.size)} local transcription engine...`);
      const archiveBytes = await download(fetchImpl, release.url, archive, release.size, release.digest.slice(7), MAX_ENGINE_BYTES, "Engine", notify);
      const engineDir = join(staging, "engine");
      mkdirSync(engineDir, { recursive: false, mode: 0o700 });
      (options.extractArchive ?? extractVerifiedArchive)(archive, engineDir);
      rmSync(archive, { force: true });
      executablePath = findNamedFile(engineDir, target.executableName);
      if (!executablePath) throw new Error(`whisper.cpp archive is missing ${target.executableName}`);
      try { chmodSync(executablePath, 0o755); } catch { /* Windows executable ACLs. */ }
      const version = (options.versionOf ?? whisperVersion)(executablePath);
      if (version !== release.version) throw new Error(`whisper.cpp binary version ${version ?? "unknown"} does not match ${release.version}`);
      const executableSha256 = await sha256File(executablePath);
      engine = {
        version,
        releaseTag: release.tag,
        assetName: target.assetName,
        assetDigest: release.digest,
        archiveBytes,
        executable: relative(staging, executablePath).replace(/\\/g, "/"),
        executableBytes: statSync(executablePath).size,
        executableSha256,
        sourceUrl: release.releaseUrl,
        license: "MIT",
      };
    } else if (!findPathEngine(options.which ?? ((name: string) => Bun.which(name)))) {
      throw new Error(platform === "darwin"
        ? "The upstream release has no macOS CLI binary. Install `whisper-cpp` with Homebrew, then rerun this command to add Neko's verified model."
        : `Meeting Support Pack does not yet provide a managed engine for ${platform}/${arch}`);
    }

    const modelDir = join(staging, "models");
    mkdirSync(modelDir, { recursive: false, mode: 0o700 });
    const modelPath = join(modelDir, model.file);
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}?download=true`;
    notify(`Downloading ${formatMiB(model.bytes)} ${tier} multilingual model (Vietnamese supported)...`);
    await download(fetchImpl, modelUrl, modelPath, model.bytes, model.sha256, MAX_MODEL_BYTES, "Model", notify);

    const manifest: MeetingSupportManifest = {
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      ...(engine ? { engine } : {}),
      model: {
        tier,
        id: model.id,
        file: relative(staging, modelPath).replace(/\\/g, "/"),
        bytes: model.bytes,
        sha256: model.sha256,
        sourceUrl: modelUrl,
      },
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
    const installed = readMeetingSupportPack(home);
    if (!installed) throw new Error("Meeting Support Pack manifest did not survive installation");
    notify(`Meeting Support Pack is ready (${formatMiB(model.bytes + (engine?.archiveBytes ?? 0))} downloaded).`);
    return installed;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function removeMeetingSupportPack(home = homeDir()): boolean {
  const root = meetingSupportRoot(home);
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  INTEGRITY_CACHE.clear();
  return true;
}

function resolveRelease(release: GitHubRelease, target: MeetingSupportTarget): {
  version: string; tag: string; digest: string; size: number; url: string; releaseUrl: string;
} {
  if (release.draft || release.prerelease) throw new Error("The latest whisper.cpp release is not stable");
  const tag = String(release.tag_name ?? "");
  const version = tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error(`Unexpected whisper.cpp release tag: ${tag || "unknown"}`);
  const asset = release.assets?.find((candidate) => candidate.name === target.assetName);
  const size = Number(asset?.size ?? 0);
  const digest = String(asset?.digest ?? "").toLowerCase();
  const url = String(asset?.browser_download_url ?? "");
  if (!asset || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ENGINE_BYTES) throw new Error(`Release is missing ${target.assetName}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("whisper.cpp asset does not publish a SHA-256 digest");
  const parsed = new URL(url);
  const expectedPath = `/${RELEASE_REPO}/releases/download/${tag}/${target.assetName}`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.pathname !== expectedPath || basename(parsed.pathname) !== target.assetName) {
    throw new Error("whisper.cpp release returned an unexpected download URL");
  }
  const releaseUrl = String(release.html_url ?? "");
  return { version, tag, digest, size, url, releaseUrl: releaseUrl.startsWith(`https://github.com/${RELEASE_REPO}/`) ? releaseUrl : `https://github.com/${RELEASE_REPO}/releases/tag/${tag}` };
}

async function download(
  fetchImpl: typeof fetch,
  url: string,
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  maxBytes: number,
  label: string,
  notify: (message: string) => void,
): Promise<number> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "neko-core-meeting-support" },
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`${label} download failed (HTTP ${response.status})`);
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (expectedBytes <= 0 || expectedBytes > maxBytes || announced > maxBytes || (announced > 0 && announced !== expectedBytes)) {
    throw new Error(`${label} download size does not match signed metadata`);
  }
  const hash = createHash("sha256");
  let received = 0;
  let reported = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      const percent = Math.floor(received / expectedBytes * 100);
      if (percent >= reported + 10) { reported = percent; notify(`${label} download ${Math.min(100, percent)}%...`); }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (received !== expectedBytes) throw new Error(`${label} download was incomplete (${received}/${expectedBytes} bytes)`);
  const digest = hash.digest("hex");
  if (digest !== expectedSha256) throw new Error(`${label} checksum mismatch`);
  return received;
}

function extractVerifiedArchive(archive: string, destination: string): void {
  const listed = spawnSync("tar", ["-tf", archive], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (listed.status !== 0) throw new Error(`Could not inspect meeting engine archive: ${(listed.stderr || listed.stdout || "tar failed").trim()}`);
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  const verbose = spawnSync("tar", ["-tvf", archive], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (verbose.status !== 0) throw new Error(`Could not inspect meeting engine archive types: ${(verbose.stderr || verbose.stdout || "tar failed").trim()}`);
  const verboseEntries = verbose.stdout.split(/\r?\n/).filter(Boolean);
  validateMeetingArchiveEntries(entries, verboseEntries);
  const extracted = spawnSync("tar", ["-xf", archive, "-C", destination], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (extracted.status !== 0) throw new Error(`Could not unpack meeting engine: ${(extracted.stderr || extracted.stdout || "tar failed").trim()}`);
  assertTreeInside(destination);
}

export function validateMeetingArchiveEntries(entries: string[], verboseEntries: string[]): void {
  if (!entries.length || entries.length > 500) throw new Error("Meeting engine archive has an invalid entry count");
  if (verboseEntries.length !== entries.length) throw new Error("Meeting engine archive listing is inconsistent");
  for (const [index, entry] of entries.entries()) {
    const normalized = entry.replace(/\\/g, "/");
    if (!safeArchivePath(normalized)) throw new Error(`Unsafe meeting engine archive path: ${entry}`);
    const verbose = verboseEntries[index].trimStart();
    const type = verbose[0];
    if (type === "-" || type === "d") continue;
    if (type === "l") {
      const marker = verbose.lastIndexOf(" -> ");
      const target = marker >= 0 ? verbose.slice(marker + 4).replace(/\\/g, "/") : "";
      const resolvedTarget = posix.normalize(posix.join(posix.dirname(normalized), target));
      if (target && safeArchivePath(target, true) && safeArchivePath(resolvedTarget)) continue;
    }
    throw new Error("Meeting engine archive contains an unsafe link or special entry");
  }
}

function safeArchivePath(value: string, allowParents = false): boolean {
  if (!value || isAbsolute(value) || value.startsWith("/") || /^[a-z]:\//i.test(value)) return false;
  return allowParents || !value.split("/").includes("..");
}

function assertTreeInside(root: string): void {
  const base = resolve(root) + sep;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const resolved = resolve(path);
      if (resolved !== resolve(root) && !resolved.startsWith(base)) throw new Error("Meeting engine archive escaped its staging directory");
      if (entry.isDirectory()) walk(path);
      else if (lstatSync(path).isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path));
        if (!target.startsWith(base)) throw new Error("Meeting engine archive contains an unsafe symbolic link");
      }
    }
  };
  walk(root);
}

function findNamedFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) { const found = findNamedFile(path, name); if (found) return found; }
    else if (entry.isFile() && entry.name === name) return path;
  }
  return undefined;
}

function whisperVersion(path: string): string | null {
  const env = { ...process.env, PATH: `${dirname(path)}${delimiter}${process.env.PATH ?? ""}`, LD_LIBRARY_PATH: dirname(path) };
  const result = spawnSync(path, ["--version"], { cwd: dirname(path), encoding: "utf8", timeout: 15_000, windowsHide: true, env });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/whisper\.cpp version:\s*(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}

function findPathEngine(which: (name: string) => string | null): string | null {
  return which("whisper-cli") ?? which("whisper.cpp");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyInstalledFile(path: string, expected: string, label: string): Promise<void> {
  let stamp: ReturnType<typeof statSync>;
  try { stamp = statSync(path); }
  catch { throw new Error(`${label} is missing; run \`neko support meeting update\``); }
  const key = `${path}\0${expected}\0${stamp.size}\0${stamp.mtimeMs}`;
  let check = INTEGRITY_CACHE.get(key);
  if (!check) {
    check = (async () => {
      if (await sha256File(path) !== expected) throw new Error(`${label} checksum mismatch; run \`neko support meeting update\``);
    })();
    INTEGRITY_CACHE.set(key, check);
  }
  try { await check; }
  catch (error) { INTEGRITY_CACHE.delete(key); throw error; }
}

function isSafeRelative(value: string): boolean {
  const normalized = String(value ?? "").replace(/\\/g, "/");
  return !!normalized && !isAbsolute(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
