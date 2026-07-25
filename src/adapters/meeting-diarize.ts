/**
 * Optional speaker diarization: splitting the meeting channel into distinct voices.
 *
 * OFF BY DEFAULT, and it must stay that way, because it is confidently wrong often enough to matter.
 * Measured on this repository's machine, Vietnamese, CPU (see docs/process/MEETINGS-RESEARCH-2026-07.md):
 *
 *   two clearly different voices  -> 10/10 transcript lines attributed correctly, 0% speaker confusion
 *   three voices, two same-gender -> 8/11 correct, 19-24% confusion
 *
 * The part that decides the design: in the failing case the overlap between the ASR line and the chosen
 * cluster was 1.00, 0.90, 1.00 - the diarizer is not hesitant when it is wrong, so unlike low-confidence
 * ASR words there is NO per-line signal that separates good attributions from bad. Nothing here may be
 * presented as certain, and the labels are cluster numbers, never names.
 *
 * It runs only on the SYSTEM channel. The microphone channel is already known to be the user, and a
 * clustering guess must never be allowed to overwrite something Neko actually knows.
 *
 * Engine: sherpa-onnx (pyannote-segmentation-3.0 + CAM++ speaker embeddings, both ONNX). Chosen because
 * it is a native binary with no Python, no PyTorch and no GPU - the same supply-chain shape as the ASR
 * pack - and installs from verified upstream release artifacts.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";

import { homeDir } from "../shared/home.ts";
import {
  downloadVerified,
  extractVerifiedArchive,
  findNamedFile,
  formatMiB,
  meetingSupportRoot,
  sha256File,
} from "./meeting-support-pack.ts";
import type { MeetingTranscriptSegment } from "./meeting.ts";

const RELEASE_REPO = "k2-fsa/sherpa-onnx";
const ENGINE_TAG = "v1.13.4";
const MAX_ENGINE_BYTES = 64 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;

/**
 * Model artifacts. These live on old release tags that predate GitHub's published asset digests, so the
 * SHA-256 values are pinned here after being computed from the downloaded bytes. The engine archive DOES
 * publish a digest and is verified against the one GitHub returns.
 */
const MODELS = {
  segmentation: {
    tag: "speaker-segmentation-models",
    file: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    bytes: 6_958_444,
    sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
    entry: "model.onnx",
  },
  embedding: {
    tag: "speaker-recongition-models", // upstream spelling
    file: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    bytes: 28_281_164,
    sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
  },
} as const;

export interface DiarizationTarget {
  assetName: string;
  executableName: string;
}

export interface DiarizationManifest {
  schemaVersion: 1;
  installedAt: string;
  engine: { version: string; assetName: string; assetDigest: string; executable: string; executableSha256: string; sourceUrl: string };
  models: { segmentation: string; embedding: string; segmentationSha256: string; embeddingSha256: string };
}

export interface DiarizationPack {
  root: string;
  executable: string;
  segmentation: string;
  embedding: string;
  version: string;
}

/** One stretch of audio the diarizer assigned to one voice cluster. */
export interface SpeakerSpan {
  cluster: string;
  startMs: number;
  endMs: number;
}

export function diarizationTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): DiarizationTarget | null {
  const base = `sherpa-onnx-${ENGINE_TAG}`;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    // MT links the C runtime statically, so the binary does not need a Visual C++ redistributable.
    return { assetName: `${base}-win-${arch}-shared-MT-MinSizeRel-no-tts.tar.bz2`, executableName: "sherpa-onnx-offline-speaker-diarization.exe" };
  }
  if (platform === "linux" && arch === "x64") {
    return { assetName: `${base}-linux-x64-shared-no-tts.tar.bz2`, executableName: "sherpa-onnx-offline-speaker-diarization" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { assetName: `${base}-osx-${arch === "arm64" ? "arm64" : "x64"}-shared-no-tts.tar.bz2`, executableName: "sherpa-onnx-offline-speaker-diarization" };
  }
  return null;
}

export function diarizationRoot(home = homeDir()): string {
  return join(meetingSupportRoot(home), "diarization");
}

export function readDiarizationPack(home = homeDir()): DiarizationPack | null {
  const root = diarizationRoot(home);
  try {
    const manifest = JSON.parse(readFileSync(join(root, "diarization.json"), "utf8")) as DiarizationManifest;
    if (manifest.schemaVersion !== 1) return null;
    const executable = join(root, manifest.engine.executable);
    const segmentation = join(root, manifest.models.segmentation);
    const embedding = join(root, manifest.models.embedding);
    for (const path of [executable, segmentation, embedding]) if (!existsSync(path) || !statSync(path).isFile()) return null;
    return { root, executable, segmentation, embedding, version: manifest.engine.version };
  } catch {
    return null;
  }
}

export interface InstallDiarizationOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  fetchImpl?: typeof fetch;
  notify?: (message: string) => void;
  extractArchive?: (archive: string, destination: string) => void;
}

export async function installDiarization(options: InstallDiarizationOptions = {}): Promise<DiarizationPack> {
  const home = options.home ?? homeDir();
  const notify = options.notify ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = diarizationTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  if (!target) throw new Error(`Speaker diarization has no verified binary for ${options.platform ?? process.platform}/${options.arch ?? process.arch}`);

  const root = diarizationRoot(home);
  const staging = mkdtempSync(`${root}-staging-`);
  try {
    notify("Checking the official sherpa-onnx release...");
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${ENGINE_TAG}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "neko-core-meeting-support" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not read the sherpa-onnx release (HTTP ${response.status})`);
    const release = await response.json() as { assets?: Array<{ name?: string; size?: number; digest?: string; browser_download_url?: string }> };
    const asset = release.assets?.find((candidate) => candidate.name === target.assetName);
    const digest = String(asset?.digest ?? "").toLowerCase();
    const size = Number(asset?.size ?? 0);
    if (!asset || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ENGINE_BYTES) throw new Error(`sherpa-onnx release is missing ${target.assetName}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("sherpa-onnx asset does not publish a SHA-256 digest");
    const url = new URL(String(asset.browser_download_url ?? ""));
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== `/${RELEASE_REPO}/releases/download/${ENGINE_TAG}/${target.assetName}`) {
      throw new Error("sherpa-onnx release returned an unexpected download URL");
    }

    const archive = join(staging, target.assetName);
    notify(`Downloading ${formatMiB(size)} speaker diarization engine...`);
    await downloadVerified(fetchImpl, url.toString(), archive, size, digest.slice(7), MAX_ENGINE_BYTES, "Diarization engine", notify);
    const engineDir = join(staging, "engine");
    mkdirSync(engineDir, { recursive: false, mode: 0o700 });
    (options.extractArchive ?? extractVerifiedArchive)(archive, engineDir);
    rmSync(archive, { force: true });
    const executable = findNamedFile(engineDir, target.executableName);
    if (!executable) throw new Error(`sherpa-onnx archive is missing ${target.executableName}`);
    try { chmodSync(executable, 0o755); } catch { /* Windows executable ACLs. */ }

    const modelDir = join(staging, "models");
    mkdirSync(modelDir, { recursive: false, mode: 0o700 });
    const segArchive = join(modelDir, MODELS.segmentation.file);
    notify(`Downloading ${formatMiB(MODELS.segmentation.bytes)} speaker segmentation model...`);
    await downloadVerified(fetchImpl, modelUrl(MODELS.segmentation.tag, MODELS.segmentation.file), segArchive, MODELS.segmentation.bytes, MODELS.segmentation.sha256, MAX_MODEL_BYTES, "Segmentation model", notify);
    (options.extractArchive ?? extractVerifiedArchive)(segArchive, modelDir);
    rmSync(segArchive, { force: true });
    const segmentation = findNamedFile(modelDir, MODELS.segmentation.entry);
    if (!segmentation) throw new Error("segmentation archive is missing model.onnx");

    const embedding = join(modelDir, MODELS.embedding.file);
    notify(`Downloading ${formatMiB(MODELS.embedding.bytes)} speaker embedding model...`);
    await downloadVerified(fetchImpl, modelUrl(MODELS.embedding.tag, MODELS.embedding.file), embedding, MODELS.embedding.bytes, MODELS.embedding.sha256, MAX_MODEL_BYTES, "Embedding model", notify);

    const manifest: DiarizationManifest = {
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      engine: {
        version: ENGINE_TAG.slice(1),
        assetName: target.assetName,
        assetDigest: digest,
        executable: relative(staging, executable).replace(/\\/g, "/"),
        executableSha256: await sha256File(executable),
        sourceUrl: `https://github.com/${RELEASE_REPO}/releases/tag/${ENGINE_TAG}`,
      },
      models: {
        segmentation: relative(staging, segmentation).replace(/\\/g, "/"),
        embedding: relative(staging, embedding).replace(/\\/g, "/"),
        segmentationSha256: MODELS.segmentation.sha256,
        embeddingSha256: MODELS.embedding.sha256,
      },
    };
    writeFileSync(join(staging, "diarization.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    renameSync(staging, root);
    return readDiarizationPack(home)!;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function modelUrl(tag: string, file: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${file}`;
}

export interface DiarizeOptions {
  /** Exact number of voices, when the user knows it. Otherwise clusters are found automatically. */
  speakers?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Run the diarizer over one MONO wav and return the voice spans it found. */
export async function diarizeMono(pack: DiarizationPack, audio: string, options: DiarizeOptions = {}): Promise<SpeakerSpan[]> {
  const args = [
    `--segmentation.pyannote-model=${pack.segmentation}`,
    "--segmentation.num-threads=4",
    `--embedding.model=${pack.embedding}`,
    "--embedding.num-threads=4",
    // Measured on Vietnamese: any threshold from 0.4 to 0.7 gave the same result and found the right
    // number of voices; 0.8 collapsed everyone into one. The upstream default sits mid-band.
    ...(options.speakers && options.speakers > 0 ? [`--clustering.num-clusters=${Math.floor(options.speakers)}`] : ["--clustering.cluster-threshold=0.5"]),
    audio,
  ];
  const engineDir = dirname(pack.executable);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(pack.executable, args, {
      cwd: engineDir,
      env: {
        ...process.env,
        PATH: `${engineDir}${delimiter}${process.env.PATH ?? ""}`,
        LD_LIBRARY_PATH: [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
        DYLD_LIBRARY_PATH: [engineDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(delimiter),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill(); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { tail = `${tail}${chunk.toString("utf8")}`.slice(-4_000); });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`speaker diarization failed (${code}): ${tail.trim().slice(-300)}`));
    });
  });
  return parseSpeakerSpans(stdout);
}

/** sherpa-onnx prints one `start -- end speaker_NN` line per span, mixed into progress output. */
export function parseSpeakerSpans(stdout: string): SpeakerSpan[] {
  const spans: SpeakerSpan[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s+(\S+)\s*$/);
    if (!match) continue;
    const startMs = Math.round(Number(match[1]) * 1000);
    const endMs = Math.round(Number(match[2]) * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    spans.push({ cluster: match[3], startMs, endMs });
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Give each transcript segment the voice that overlaps it most.
 *
 * Clusters are renumbered by first appearance so the labels read in the order people spoke, and they are
 * labelled `Speaker 1`, `Speaker 2` - numbers, never names. A segment no voice overlaps keeps whatever
 * it had, because "unknown" is a truthful answer and a guess is not.
 */
export function attributeSpeakers(
  segments: MeetingTranscriptSegment[],
  spans: SpeakerSpan[],
): MeetingTranscriptSegment[] {
  if (!spans.length) return segments;
  const order = new Map<string, number>();
  for (const span of spans) if (!order.has(span.cluster)) order.set(span.cluster, order.size + 1);
  return segments.map((segment) => {
    const overlaps = new Map<string, number>();
    for (const span of spans) {
      const overlap = Math.min(segment.endMs, span.endMs) - Math.max(segment.startMs, span.startMs);
      if (overlap > 0) overlaps.set(span.cluster, (overlaps.get(span.cluster) ?? 0) + overlap);
    }
    const best = [...overlaps.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) return segment;
    return { ...segment, speaker: `Speaker ${order.get(best[0])}` };
  });
}

/** How many distinct voices were found. Reported as a count, which is far safer than per-line identity. */
export function speakerCount(spans: SpeakerSpan[]): number {
  return new Set(spans.map((span) => span.cluster)).size;
}

export const DIARIZATION_CAVEAT =
  "Speaker labels are voice clusters, not names, and they are not reliable enough to assign an action item on their own: measured on Vietnamese, attribution was correct for every line when voices differed clearly but only 8 of 11 when two speakers had similar voices, and the wrong ones looked just as confident as the right ones. Confirm who said something before recording it as theirs.";
