/**
 * Voice-activity gating: never hand the ASR audio that has no speech in it.
 *
 * Why this exists, measured on a real Vietnamese recording (see MEETINGS-RESEARCH-2026-07.md 2.10):
 * over breathing and room noise the model invented words - "nuoc" at confidence 0.150, "ya" at 0.262,
 * "loai" at 0.476 - and mangled a real phrase into "du an nguy con den". Decoding only the detected
 * speech recovered the real phrase, "du an lien quan den", and halved the low-confidence words.
 *
 * An energy threshold cannot do this job, and that was measured rather than assumed: in the same
 * recording the invented "loai" sat at RMS 0.1342, among the loudest moments in the clip, while the
 * correctly heard "mot" sat at 0.0221. Gating on loudness would delete real words and keep the
 * hallucinations. Telling speech from sound needs a model, so this uses Silero VAD through sherpa-onnx.
 *
 * Regions are decoded SEPARATELY and their word times shifted back into meeting time, rather than
 * concatenating the speech into one file. Concatenation is simpler and it destroys every timestamp,
 * which is the one thing a meeting transcript may not lose - the summary cites them.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { wavHeader } from "./meeting.ts";
import { readWavFormat } from "./meeting-transcription.ts";
import type { SpeechToolsPack } from "./meeting-diarize.ts";

/** One stretch of audio the VAD believes contains speech, in meeting time. */
export interface SpeechRegion {
  startMs: number;
  endMs: number;
}

/** Room around each region so a word's onset is never clipped by the detector's boundary. */
const PAD_MS = 250;
/** Regions closer than this are decoded together: the engine reloads its model per invocation, so a
 * long meeting cut into hundreds of tiny files would spend most of its time loading. */
const MERGE_GAP_MS = 1_500;
/** Upper bound on one decode, so a long uninterrupted talk still streams through in pieces. */
const MAX_REGION_MS = 60_000;

export interface DetectSpeechOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Ask Silero VAD which parts of a MONO wav contain speech. */
export async function detectSpeechRegions(
  pack: SpeechToolsPack,
  audio: string,
  options: DetectSpeechOptions = {},
): Promise<SpeechRegion[]> {
  const engineDir = dirname(pack.executable);
  const vadExecutable = join(engineDir, pack.executable.endsWith(".exe") ? "sherpa-onnx-vad.exe" : "sherpa-onnx-vad");
  // The CLI insists on an output file it strips silence into; we only want the region list.
  const scratch = `${audio}.vad.wav`;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(vadExecutable, [`--silero-vad-model=${pack.vad}`, audio, scratch], {
        windowsHide: true,
        cwd: engineDir,
        env: {
          ...process.env,
          PATH: `${engineDir}${delimiter}${process.env.PATH ?? ""}`,
          LD_LIBRARY_PATH: [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
          DYLD_LIBRARY_PATH: [engineDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(delimiter),
        },
stdio: ["ignore", "pipe", "pipe"],
      });
      // sherpa-onnx-vad prints its region list to STDERR, alongside the config dump - measured, not
      // assumed, after the first version parsed an always-empty stdout.
      const chunks: Buffer[] = [];
      let bytes = 0;
      const collect = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { child.kill(); return; }
        chunks.push(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
      const abort = () => child.kill();
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(`voice-activity detection failed (${code}): ${Buffer.concat(chunks).toString("utf8").trim().slice(-300)}`));
      });
    });
    return mergeRegions(parseSpeechRegions(stdout), durationMs(audio));
  } finally {
    rmSync(scratch, { force: true });
  }
}

/** sherpa-onnx-vad prints one `start -- end` line per speech region, mixed into its config dump. */
export function parseSpeechRegions(stdout: string): SpeechRegion[] {
  const regions: SpeechRegion[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s*$/);
    if (!match) continue;
    const startMs = Math.round(Number(match[1]) * 1000);
    const endMs = Math.round(Number(match[2]) * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    regions.push({ startMs, endMs });
  }
  return regions.sort((a, b) => a.startMs - b.startMs);
}

/** Pad, join what is nearly touching, and cap the length. Empty input stays empty - that is the caller's
 * signal that the VAD found nothing and the whole file should be decoded instead of nothing at all. */
export function mergeRegions(regions: SpeechRegion[], totalMs = Number.POSITIVE_INFINITY): SpeechRegion[] {
  const merged: SpeechRegion[] = [];
  for (const region of regions) {
    const startMs = Math.max(0, region.startMs - PAD_MS);
    const endMs = Math.min(totalMs, region.endMs + PAD_MS);
    const last = merged.at(-1);
    if (last && startMs - last.endMs <= MERGE_GAP_MS && endMs - last.startMs <= MAX_REGION_MS) {
      last.endMs = Math.max(last.endMs, endMs);
      continue;
    }
    merged.push({ startMs, endMs });
  }
  // A single very long region still has to be decoded in bounded pieces.
  const bounded: SpeechRegion[] = [];
  for (const region of merged) {
    for (let at = region.startMs; at < region.endMs; at += MAX_REGION_MS) {
      bounded.push({ startMs: at, endMs: Math.min(region.endMs, at + MAX_REGION_MS) });
    }
  }
  return bounded;
}

/** Copy one time range of a MONO PCM16 wav into a standalone wav. */
export function sliceWav(source: string, destination: string, startMs: number, endMs: number): void {
  const format = readWavFormat(source);
  if (format.channels !== 1) throw new Error("speech regions are cut from mono audio only");
  const bytesPerMs = (format.sampleRate * 2) / 1000;
  const start = Math.min(format.dataBytes, Math.floor((startMs * bytesPerMs) / 2) * 2);
  const end = Math.min(format.dataBytes, Math.ceil((endMs * bytesPerMs) / 2) * 2);
  const length = Math.max(0, end - start);
  const pcm = Buffer.alloc(length);
  const fd = openSync(source, "r");
  try { readSync(fd, pcm, 0, length, format.dataOffset + start); } finally { closeSync(fd); }
  writeFileSync(destination, Buffer.concat([wavHeader(pcm.length, format.sampleRate, 1), pcm]), { mode: 0o600 });
}

function durationMs(audio: string): number {
  try {
    const format = readWavFormat(audio);
    return Math.floor((format.dataBytes / (format.channels * 2) / format.sampleRate) * 1000);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** How much of the file the VAD considered speech. Reported so a suspicious gate is visible. */
export function speechCoverage(regions: SpeechRegion[], totalMs: number): number {
  if (totalMs <= 0) return 0;
  const heard = regions.reduce((sum, region) => sum + (region.endMs - region.startMs), 0);
  return Math.min(1, heard / totalMs);
}

export function wavDurationMs(audio: string): number {
  return statSync(audio).size > 44 ? durationMs(audio) : 0;
}
