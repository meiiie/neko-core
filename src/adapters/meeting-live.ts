/**
 * Live meeting transcription: provisional text WHILE the meeting runs.
 *
 * The capture path already streams interleaved PCM16 to a growing raw file and only wraps it in a WAV
 * header at stop, so this reads windows out of that same file and decodes them with the Meeting Support
 * Pack binary that is already downloaded, digest-verified, and version-probed. No second engine, no
 * second supply chain, and no cloud upload.
 *
 * Why windows rather than the engine's own streaming mode: Nemotron 3.5 IS cache-aware streaming, but
 * parakeet-cli v0.4.0 exposes `--stream` as a whole-file convenience - it prints one cumulative line at
 * the end and drops timestamps. Until the CLI emits incremental hypotheses, windowed decoding stabilized
 * by LocalAgreement-2 is what gives live Vietnamese notes with usable timings.
 *
 * Why one decode PER CHANNEL: the engine takes mono, so the "You" / "Meeting audio" split that whisper.cpp
 * got from `-di` is preserved here by deinterleaving the capture and giving each channel its own
 * LocalAgreement state. See docs/process/MEETINGS-RESEARCH-2026-07.md.
 *
 * Live output is PROVISIONAL by construction: a window can cut a word, and a late window can be skipped
 * under load. The finalized WAV plus the existing single-pass transcription stays the canonical record.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { wavHeader, type MeetingTranscriptSegment } from "./meeting.ts";
import { normalizeLanguage, parseMeetingTranscript } from "./meeting-transcription.ts";
import type { MeetingTranscriber } from "./meeting-support-pack.ts";

/** One decoded window of ONE capture channel. `offsetMs` is where it starts inside the meeting. */
export interface LiveWindow {
  wavPath: string;
  offsetMs: number;
  durationMs: number;
  source: MeetingTranscriptSegment["source"];
}

/** Decodes one window into meeting-relative segments. Injected so the loop is testable without an engine. */
export type LiveWindowTranscriber = (window: LiveWindow, signal?: AbortSignal) => Promise<MeetingTranscriptSegment[]>;

export interface LiveMeetingOptions {
  /** The growing interleaved PCM16 file written by the capture bridge. */
  rawPath: string;
  sampleRate: number;
  channels: 2;
  transcribeWindow: LiveWindowTranscriber;
  /** Which capture channels carry audio. Each is decoded and stabilized independently. */
  sources?: Array<"microphone" | "system">;
  onSegments?: (segments: MeetingTranscriptSegment[]) => void;
  /** Audio decoded per pass. Longer gives the decoder more context; shorter lowers latency. */
  windowMs?: number;
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
  minWindowMs: 6_000,
  maxLagMs: 90_000,
} as const;

/** Normalized text used only for duplicate suppression across overlapping windows. */
function fingerprint(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** One word of a hypothesis, carrying the timing of the segment it came from. */
export interface HypothesisWord {
  text: string;
  startMs: number;
  endMs: number;
  speaker: string;
  source: MeetingTranscriptSegment["source"];
}

/** Split decoded segments into comparable words, keeping each word's segment timing and channel. */
export function toWords(segments: MeetingTranscriptSegment[], offsetMs = 0): HypothesisWord[] {
  const words: HypothesisWord[] = [];
  for (const segment of segments.slice().sort((a, b) => a.startMs - b.startMs)) {
    for (const text of segment.text.trim().split(/\s+/).filter(Boolean)) {
      words.push({
        text,
        startMs: offsetMs + segment.startMs,
        endMs: offsetMs + segment.endMs,
        speaker: segment.speaker,
        source: segment.source,
      });
    }
  }
  return words;
}

/**
 * LocalAgreement-2: the longest prefix on which two consecutive hypotheses agree.
 *
 * This is the published stabilization policy for turning Whisper into a streaming system
 * (ufal/whisper_streaming, arXiv:2307.14743) and it exists because the END of a decoded window is the
 * least reliable part - the model has no right-hand context there, so it guesses, and those guesses
 * change on the next pass. Committing only what two passes agree on means Neko never shows a line it is
 * about to contradict. An earlier hand-rolled heuristic here committed every window immediately and
 * permanently recorded exactly such a guess ("and thank you") on real audio.
 */
export function agreedPrefix(previous: HypothesisWord[], current: HypothesisWord[]): number {
  const limit = Math.min(previous.length, current.length);
  let agreed = 0;
  while (agreed < limit && fingerprint(previous[agreed].text) === fingerprint(current[agreed].text)) agreed++;
  return agreed;
}

/** Largest cut at or below `agreed` that does not split a segment, so timings stay consistent. */
export function segmentBoundary(words: HypothesisWord[], agreed: number): number {
  let cut = Math.min(agreed, words.length);
  while (cut > 0 && cut < words.length && words[cut].startMs === words[cut - 1].startMs) cut--;
  return cut;
}

/** Regroup committed words back into segments, splitting whenever the channel or timing changes. */
export function wordsToSegments(words: HypothesisWord[], startIndex: number): MeetingTranscriptSegment[] {
  const segments: MeetingTranscriptSegment[] = [];
  for (const word of words) {
    const last = segments.at(-1);
    if (last && last.startMs === word.startMs && last.source === word.source) {
      last.text = `${last.text} ${word.text}`;
      continue;
    }
    segments.push({
      id: `live_${String(startIndex + segments.length + 1).padStart(5, "0")}`,
      startMs: word.startMs,
      endMs: word.endMs,
      speaker: word.speaker,
      source: word.source,
      text: word.text,
    });
  }
  return segments;
}

/** One capture channel and everything LocalAgreement-2 needs to keep for it. */
interface LiveTrack {
  index: number;
  source: MeetingTranscriptSegment["source"];
  processedMs: number;
  /** Hypothesis from the previous pass over this channel's uncommitted buffer. */
  previous: HypothesisWord[];
}

export class LiveMeetingTranscriber {
  private readonly options: Required<Pick<LiveMeetingOptions, "windowMs" | "minWindowMs" | "maxLagMs">> & LiveMeetingOptions;
  private readonly collected: MeetingTranscriptSegment[] = [];
  /** Committed on one channel but not yet safe to show: a slower channel may still produce audio
   * from an EARLIER moment, and a live log that jumps backwards in time is unreadable. */
  private readonly pending: MeetingTranscriptSegment[] = [];
  private readonly staging: string;
  private readonly tracks: LiveTrack[];
  private skippedMs = 0;
  private windows = 0;
  private lastError: string | undefined;
  private running = false;
  private draining: Promise<void> | null = null;

  constructor(options: LiveMeetingOptions) {
    this.options = { ...DEFAULTS, ...options };
    this.staging = options.workDir ?? mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? ".", "neko-live-"));
    this.tracks = liveTracks(options.channels, options.sources).map((track) => ({ ...track, processedMs: 0, previous: [] }));
  }

  snapshot(): LiveMeetingSnapshot {
    return {
      // The meeting is only transcribed as far as its SLOWEST channel: reporting the fastest would
      // claim coverage of audio nobody has decoded yet.
      processedMs: Math.min(...this.tracks.map((track) => track.processedMs)),
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
    this.draining = (this.draining ?? Promise.resolve()).then(() => this.drainOnce(signal, false)).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    return this.draining;
  }

  /** Decode the remaining tail even though it is shorter than a normal window. Without this the last
   * few seconds of a meeting - often the decisions and goodbyes - are never transcribed live. */
  flush(signal?: AbortSignal): Promise<void> {
    this.draining = (this.draining ?? Promise.resolve()).then(() => this.drainOnce(signal, true)).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    return this.draining;
  }

  async stop(): Promise<void> {
    this.running = false;
    try { await this.flush(); } catch { /* recorded in lastError */ }
    this.release(true); // no more audio is coming, so nothing is still waiting on a slower channel
    rmSync(this.staging, { recursive: true, force: true });
  }

  private async drainOnce(signal: AbortSignal | undefined, flushTail: boolean): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      let advanced = false;
      for (const track of this.tracks) {
        if (signal?.aborted) return;
        if (await this.drainTrack(track, signal, flushTail)) advanced = true;
      }
      // Every channel is either caught up or waiting for the audio that gives it a second opinion.
      if (!advanced || !this.running) { this.release(flushTail); return; }
      this.release(false);
    }
  }

  /**
   * Release committed segments in time order, up to the point every channel has decoded.
   *
   * Channels advance independently, so the microphone can confirm 00:12 while the room audio is still
   * at 00:05. Emitting on commit order alone produced exactly that on real audio - "You" at 0:06, then
   * "Meeting audio" at 0:05. Below the slowest channel's position no earlier segment can still appear,
   * so everything under that watermark is safe to sort and show; the rest waits one pass.
   */
  private release(final: boolean): void {
    if (!this.pending.length) return;
    const watermark = final ? Number.POSITIVE_INFINITY : Math.min(...this.tracks.map((track) => track.processedMs));
    const ready = this.pending.filter((segment) => segment.startMs <= watermark)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    if (!ready.length) return;
    for (const segment of ready) this.pending.splice(this.pending.indexOf(segment), 1);
    const fresh = ready.map((segment, index) => ({
      ...segment,
      id: `live_${String(this.collected.length + index + 1).padStart(5, "0")}`,
    }));
    this.collected.push(...fresh);
    this.options.onSegments?.(fresh);
  }

  /** One pass over one channel. Returns whether it committed anything, so the outer loop knows if
   * another round is worth running. */
  private async drainTrack(track: LiveTrack, signal: AbortSignal | undefined, flushTail: boolean): Promise<boolean> {
    const availableMs = this.availableMs();
    // Under sustained load the decoder can fall behind the meeting. Dropping the middle keeps live
    // text near the present instead of drifting minutes late; the canonical pass still has the audio.
    const lag = availableMs - track.processedMs;
    if (lag > this.options.maxLagMs) {
      const target = availableMs - this.options.windowMs;
      this.skippedMs += target - track.processedMs;
      track.processedMs = target;
      track.previous = [];
    }
    // The buffer runs from the last COMMITTED point, not the last decoded point: LocalAgreement
    // re-decodes what is not yet confirmed so a second opinion can confirm or correct it.
    const startMs = track.processedMs;
    const endMs = Math.min(availableMs, startMs + this.options.windowMs);
    const bufferMs = endMs - startMs;
    if (bufferMs <= 0) return false;
    if (bufferMs < this.options.minWindowMs && !flushTail) return false;

    const wavPath = this.writeWindow(track, startMs, endMs);
    const before = track.processedMs;
    let failed = false;
    try {
      const decoded = await this.options.transcribeWindow({ wavPath, offsetMs: startMs, durationMs: bufferMs, source: track.source }, signal);
      this.absorb(track, toWords(decoded, startMs), endMs, flushTail || bufferMs >= this.options.windowMs);
    } catch (error) {
      // One unreadable window must not wedge the rest of the meeting: record it, step over that
      // audio, and stop this pass. The canonical transcription still covers the skipped range.
      failed = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.skippedMs += endMs - track.processedMs;
      track.processedMs = endMs;
      track.previous = [];
    } finally {
      rmSync(wavPath, { force: true });
    }
    this.windows++;
    // Nothing was confirmed, so the same audio would be re-decoded identically. Wait for more of the
    // meeting instead of spinning: the next arriving audio is what gives the second opinion.
    return !failed && track.processedMs !== before;
  }

  /**
   * Commit only what two consecutive hypotheses agree on (LocalAgreement-2), then advance the buffer.
   *
   * `forceAll` commits everything without a second opinion. That is correct in exactly two places: the
   * final flush, where no further audio is coming, and a full buffer, where waiting for agreement would
   * grow the re-decoded region without bound.
   */
  private absorb(track: LiveTrack, current: HypothesisWord[], bufferEndMs: number, forceAll: boolean): void {
    const agreed = forceAll ? current.length : agreedPrefix(track.previous, current);
    if (agreed <= 0) {
      track.previous = current;
      return; // nothing is confirmed yet; the same audio is re-decoded next pass
    }
    // Word timings come from the decoder's SEGMENT, so committing half a segment would advance the
    // buffer past words that were never emitted - real audio lost "Nam will own the database
    // migration" exactly that way. Commit whole segments only; a half-agreed one waits for the next
    // pass, which is what LocalAgreement is for anyway.
    const wholeSegments = forceAll ? agreed : segmentBoundary(current, agreed);
    if (wholeSegments <= 0) {
      track.previous = current;
      return;
    }
    const committed = current.slice(0, wholeSegments);
    track.processedMs = forceAll ? bufferEndMs : Math.max(track.processedMs, committed.at(-1)!.endMs);
    track.previous = forceAll ? [] : current.slice(wholeSegments);

    // Held, not shown: `release` decides when this is safe to display in time order.
    this.pending.push(...wordsToSegments(committed, 0));
  }

  private availableMs(): number {
    let bytes = 0;
    try { bytes = statSync(this.options.rawPath).size; } catch { return 0; }
    const frameBytes = this.options.channels * 2;
    return Math.floor((bytes / frameBytes / this.options.sampleRate) * 1000);
  }

  /** Copy one channel of one byte range of the growing capture into a standalone MONO WAV. The engine
   * has no channel diarization, so deinterleaving here is what keeps "You" separable from the room. */
  private writeWindow(track: LiveTrack, startMs: number, endMs: number): string {
    const frameBytes = this.options.channels * 2;
    const bytesPerMs = (this.options.sampleRate * frameBytes) / 1000;
    const start = Math.floor((startMs * bytesPerMs) / frameBytes) * frameBytes;
    const end = Math.floor((endMs * bytesPerMs) / frameBytes) * frameBytes;
    const length = Math.max(0, end - start);
    const pcm = Buffer.alloc(length);
    const fd = openSync(this.options.rawPath, "r");
    try { readSync(fd, pcm, 0, length, start); } finally { closeSync(fd); }
    const mono = Buffer.alloc((length / frameBytes) * 2);
    for (let frame = 0, at = 0; frame < length; frame += frameBytes, at += 2) {
      mono.writeInt16LE(pcm.readInt16LE(frame + track.index * 2), at);
    }
    const path = join(this.staging, `window-${this.windows}-${track.index}-${start}.wav`);
    writeFileSync(path, Buffer.concat([wavHeader(mono.length, this.options.sampleRate, 1), mono]), { mode: 0o600 });
    return path;
  }
}

/** Channel plan for the live loop: mic on 0, system on 1, matching the consent page's ChannelMerger. */
export function liveTracks(
  channels: number,
  sources: Array<"microphone" | "system"> = [],
): Array<{ index: number; source: MeetingTranscriptSegment["source"] }> {
  if (channels !== 2) return [{ index: 0, source: sources.length === 1 ? sources[0] : "unknown" }];
  const wanted = sources.length ? sources : (["microphone", "system"] as const);
  const plan: Array<{ index: number; source: MeetingTranscriptSegment["source"] }> = [];
  if (wanted.includes("microphone")) plan.push({ index: 0, source: "microphone" });
  if (wanted.includes("system")) plan.push({ index: 1, source: "system" });
  return plan.length ? plan : [{ index: 1, source: "system" }];
}

/**
 * Window transcriber backed by the verified Meeting Support Pack. Deliberately quieter than the
 * canonical pass: no progress notifications, single-shot output, and a hard timeout so one slow window
 * can never wedge the live loop for the rest of the meeting.
 */
export function parakeetWindowTranscriber(
  transcriber: MeetingTranscriber,
  options: { language?: string; timeoutMs?: number } = {},
): LiveWindowTranscriber {
  const language = normalizeLanguage(options.language ?? "vi");
  const timeoutMs = options.timeoutMs ?? 120_000;
  return async (window, signal) => {
    const args = [
      "transcribe",
      "--model", transcriber.model,
      "--input", window.wavPath,
      "--lang", language,
      "--timestamps",
      "--threads", String(Math.max(2, Math.min(8, availableParallelism()))),
      "--json",
    ];
    const engineDir = dirname(transcriber.executable);
    const json = await new Promise<string>((resolve, reject) => {
      const child = spawn(transcriber.executable, args, {
        cwd: engineDir,
        env: {
          ...process.env,
          PATH: `${engineDir}${delimiter}${process.env.PATH ?? ""}`,
          LD_LIBRARY_PATH: [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let tail = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { child.kill(); return; }
        chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => { tail = `${tail}${chunk.toString("utf8")}`.slice(-4_000); });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(`live window decode failed (${code}): ${tail.trim().slice(-300)}`));
      });
    });
    if (!json.trim()) return [];
    return parseMeetingTranscript("live", json, {
      language,
      model: transcriber.model,
      source: window.source,
    }).segments;
  };
}
