/**
 * Live meeting transcription: provisional text WHILE the meeting runs.
 *
 * The capture path already streams interleaved PCM16 to a growing raw file and only wraps it in a WAV
 * header at stop, so this reads windows out of that same file and decodes them with the Meeting Support
 * Pack binary that is already downloaded, digest-verified, and version-probed. No second engine, no
 * second supply chain, and no cloud upload.
 *
 * Why windows rather than a streaming model: as of 2026-07 no open streaming ASR model covers Vietnamese
 * (Voxtral Realtime is 13 languages without it; Kyutai is EN/FR), while every model that does Vietnamese
 * well - PhoWhisper, Omnilingual, Whisper - is batch. Windowed decoding is what makes local Vietnamese
 * live notes possible at all. See docs/process/MEETINGS-RESEARCH-2026-07.md.
 *
 * Live output is PROVISIONAL by construction: a window can cut a word, and a late window can be skipped
 * under load. The finalized WAV plus the existing single-pass transcription stays the canonical record.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { wavHeader, type MeetingTranscriptSegment } from "./meeting.ts";
import { parseWhisperTranscript } from "./meeting-transcription.ts";
import type { MeetingTranscriber } from "./meeting-support-pack.ts";

/** One decoded window. `offsetMs` is where the window starts inside the meeting. */
export interface LiveWindow {
  wavPath: string;
  offsetMs: number;
  durationMs: number;
}

/** Decodes one window into meeting-relative segments. Injected so the loop is testable without an engine. */
export type LiveWindowTranscriber = (window: LiveWindow, signal?: AbortSignal) => Promise<MeetingTranscriptSegment[]>;

export interface LiveMeetingOptions {
  /** The growing interleaved PCM16 file written by the capture bridge. */
  rawPath: string;
  sampleRate: number;
  channels: 2;
  transcribeWindow: LiveWindowTranscriber;
  onSegments?: (segments: MeetingTranscriptSegment[]) => void;
  /** Audio decoded per pass. Longer gives Whisper more context; shorter lowers latency. */
  windowMs?: number;
  /** Re-decoded tail, so a word split across two windows still lands in one of them. */
  overlapMs?: number;
  /** Smallest amount of new audio worth a pass. */
  minWindowMs?: number;
  /** When unprocessed audio exceeds this, skip ahead instead of falling further behind. */
  maxLagMs?: number;
  workDir?: string;
  now?: () => number;
}

export interface LiveMeetingSnapshot {
  processedMs: number;
  segments: number;
  /** Audio the live loop skipped to keep up. The canonical pass still covers it. */
  skippedMs: number;
  windows: number;
  lastError?: string;
}

const DEFAULTS = {
  windowMs: 15_000,
  overlapMs: 2_000,
  minWindowMs: 6_000,
  maxLagMs: 90_000,
} as const;

/** Normalized text used only for duplicate suppression across overlapping windows. */
function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

export class LiveMeetingTranscriber {
  private readonly options: Required<Pick<LiveMeetingOptions, "windowMs" | "overlapMs" | "minWindowMs" | "maxLagMs">> & LiveMeetingOptions;
  private readonly collected: MeetingTranscriptSegment[] = [];
  private readonly staging: string;
  private processedMs = 0;
  private skippedMs = 0;
  private windows = 0;
  private lastEndMs = 0;
  private lastFingerprint = "";
  private lastError: string | undefined;
  private running = false;
  private draining: Promise<void> | null = null;

  constructor(options: LiveMeetingOptions) {
    this.options = { ...DEFAULTS, ...options };
    this.staging = options.workDir ?? mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? ".", "neko-live-"));
  }

  snapshot(): LiveMeetingSnapshot {
    return {
      processedMs: this.processedMs,
      segments: this.collected.length,
      skippedMs: this.skippedMs,
      windows: this.windows,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Provisional segments so far, oldest first. */
  segments(): MeetingTranscriptSegment[] {
    return this.collected.slice();
  }

  start(): void { this.running = true; }

  /** Decode every window that is currently available. Serialized: a second call awaits the first. */
  drain(signal?: AbortSignal): Promise<void> {
    this.draining = (this.draining ?? Promise.resolve()).then(() => this.drainOnce(signal)).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    return this.draining;
  }

  async stop(): Promise<void> {
    this.running = false;
    try { await this.draining; } catch { /* recorded in lastError */ }
    rmSync(this.staging, { recursive: true, force: true });
  }

  private async drainOnce(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const availableMs = this.availableMs();
      // Under sustained load the decoder can fall behind the meeting. Dropping the middle keeps live
      // text near the present instead of drifting minutes late; the canonical pass still has the audio.
      const lag = availableMs - this.processedMs;
      if (lag > this.options.maxLagMs) {
        const target = availableMs - this.options.windowMs;
        this.skippedMs += target - this.processedMs;
        this.processedMs = target;
      }
      if (availableMs - this.processedMs < this.options.minWindowMs) return;

      const startMs = Math.max(0, this.processedMs - this.options.overlapMs);
      const endMs = Math.min(availableMs, startMs + this.options.windowMs);
      if (endMs - startMs < this.options.minWindowMs) return;

      const wavPath = this.writeWindow(startMs, endMs);
      let failed = false;
      try {
        const decoded = await this.options.transcribeWindow({ wavPath, offsetMs: startMs, durationMs: endMs - startMs }, signal);
        this.absorb(decoded, startMs);
      } catch (error) {
        // One unreadable window must not wedge the rest of the meeting: record it, step over that
        // audio, and stop this pass. The canonical transcription still covers the skipped range.
        failed = true;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.skippedMs += endMs - this.processedMs;
      } finally {
        rmSync(wavPath, { force: true });
      }
      this.windows++;
      this.processedMs = endMs;
      if (failed || !this.running) return;
    }
  }

  /** Shift window-relative segments to meeting time and drop what the overlap already produced. */
  private absorb(decoded: MeetingTranscriptSegment[], windowStartMs: number): void {
    const fresh: MeetingTranscriptSegment[] = [];
    for (const segment of decoded.slice().sort((a, b) => a.startMs - b.startMs)) {
      const startMs = windowStartMs + segment.startMs;
      const endMs = windowStartMs + segment.endMs;
      const print = fingerprint(segment.text);
      if (!print) continue;
      if (endMs <= this.lastEndMs) continue;                       // wholly inside already-emitted audio
      if (startMs < this.lastEndMs && print === this.lastFingerprint) continue; // same words re-decoded
      const shifted: MeetingTranscriptSegment = {
        ...segment,
        id: `live_${String(this.collected.length + fresh.length + 1).padStart(5, "0")}`,
        startMs,
        endMs,
      };
      fresh.push(shifted);
      this.lastEndMs = Math.max(this.lastEndMs, endMs);
      this.lastFingerprint = print;
    }
    if (!fresh.length) return;
    this.collected.push(...fresh);
    this.options.onSegments?.(fresh);
  }

  private availableMs(): number {
    let bytes = 0;
    try { bytes = statSync(this.options.rawPath).size; } catch { return 0; }
    const frameBytes = this.options.channels * 2;
    return Math.floor((bytes / frameBytes / this.options.sampleRate) * 1000);
  }

  /** Copy one byte range of the growing capture into a standalone WAV the engine can open. */
  private writeWindow(startMs: number, endMs: number): string {
    const frameBytes = this.options.channels * 2;
    const bytesPerMs = (this.options.sampleRate * frameBytes) / 1000;
    const start = Math.floor((startMs * bytesPerMs) / frameBytes) * frameBytes;
    const end = Math.floor((endMs * bytesPerMs) / frameBytes) * frameBytes;
    const length = Math.max(0, end - start);
    const pcm = Buffer.alloc(length);
    const fd = openSync(this.options.rawPath, "r");
    try { readSync(fd, pcm, 0, length, start); } finally { closeSync(fd); }
    const path = join(this.staging, `window-${this.windows}-${start}.wav`);
    writeFileSync(path, Buffer.concat([wavHeader(pcm.length, this.options.sampleRate, this.options.channels), pcm]), { mode: 0o600 });
    return path;
  }
}

/**
 * Window transcriber backed by the verified Meeting Support Pack. Deliberately quieter than the
 * canonical pass: no progress notifications, single-shot output, and a hard timeout so one slow window
 * can never wedge the live loop for the rest of the meeting.
 */
export function whisperWindowTranscriber(
  transcriber: MeetingTranscriber,
  options: { language?: string; stereo?: boolean; timeoutMs?: number } = {},
): LiveWindowTranscriber {
  const language = options.language ?? "vi";
  const timeoutMs = options.timeoutMs ?? 120_000;
  return async (window, signal) => {
    const outputPrefix = `${window.wavPath}.out`;
    const args = [
      "-m", transcriber.model,
      "-f", window.wavPath,
      "-l", language,
      "-t", String(Math.max(2, Math.min(8, availableParallelism()))),
      "-oj", "-of", outputPrefix,
      "-np", "-pp", "-sns",
      ...(options.stereo === false ? [] : ["-di"]),
    ];
    const engineDir = dirname(transcriber.executable);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(transcriber.executable, args, {
        cwd: engineDir,
        env: {
          ...process.env,
          PATH: `${engineDir}${delimiter}${process.env.PATH ?? ""}`,
          LD_LIBRARY_PATH: [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
        },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let tail = "";
      child.stderr?.on("data", (chunk: Buffer) => { tail = `${tail}${chunk.toString("utf8")}`.slice(-4_000); });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (code === 0) resolve();
        else reject(new Error(`live window decode failed (${code}): ${tail.trim().slice(-300)}`));
      });
    });
    const json = `${outputPrefix}.json`;
    try {
      if (!existsSync(json)) return [];
      return parseWhisperTranscript("live", readFileSync(json, "utf8"), {
        language,
        model: transcriber.model,
      }).segments;
    } finally {
      rmSync(json, { force: true });
    }
  };
}
