/** Local ASR adapter for meeting evidence. Core and the agent loop never depend on the engine. */
import { spawn } from "node:child_process";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { delimiter, dirname, join } from "node:path";

import {
  meetingDir,
  readMeeting,
  saveMeeting,
  wavHeader,
  writeMeetingTranscript,
  type MeetingTranscript,
  type MeetingTranscriptSegment,
} from "./meeting.ts";
import { verifyMeetingSupportIntegrity, type MeetingTranscriber } from "./meeting-support-pack.ts";
import { attributeSpeakers, diarizeMono, readDiarizationPack, speakerCount, type SpeakerSpan } from "./meeting-diarize.ts";
import { homeDir } from "../shared/home.ts";

export const MEETING_ENGINE_NAME = "parakeet.cpp";

export interface TranscribeMeetingOptions {
  home?: string;
  language?: string;
  signal?: AbortSignal;
  notify?: (message: string) => void;
  transcriber?: MeetingTranscriber;
  runEngine?: (request: MeetingEngineRequest) => Promise<string>;
  /** Split the meeting channel into numbered voices. Off unless asked for: see meeting-diarize.ts. */
  diarize?: boolean;
  /** Exact number of people, when the user knows it. Otherwise the voice count is found automatically. */
  speakers?: number;
  diarizeMono?: (audio: string) => Promise<SpeakerSpan[]>;
}

/** One decode of one MONO wav. Nemotron/parakeet has no channel diarization, so the caller splits
 * channels first and each request already knows whose audio it is carrying. */
export interface MeetingEngineRequest {
  executable: string;
  model: string;
  audio: string;
  language: string;
  source: MeetingTranscriptSegment["source"];
  signal?: AbortSignal;
  notify: (message: string) => void;
}

interface ParakeetWord {
  w?: string;
  start?: number;
  end?: number;
  conf?: number;
}

interface ParakeetJson {
  text?: string;
  frame_sec?: number;
  words?: ParakeetWord[];
}

/** Word grouping. The engine returns words, not lines, so the segment shape is ours to define -
 * the model extracts, this code computes. A break happens at the engine's own locale marker, at a
 * pause, after sentence-final punctuation, or when a line would grow past what a reader can scan. */
const SEGMENT_GAP_MS = 700;
/**
 * Below this posterior, a word is reported as uncertain rather than trusted.
 *
 * Measured on this machine, `q5_k`, 16 kHz speech. On 69 words of clean Vietnamese that the engine
 * transcribed with ZERO errors, the median posterior was 0.991 and only 2 words (2.9%) fell below 0.5.
 * On 42 words of Vietnamese/English code-switched engineering speech, 10 of the 11 words below 0.5 were
 * exactly the mangled English terms ("Deploi" 0.32, "Saging" 0.34, "migraine" 0.35, "thensi" 0.20).
 * So the threshold is high-precision (~91%) and moderate-recall (~50%): what it flags is almost always
 * wrong, but it does not catch every borrowed term. 0.6 was rejected - it starts flagging correct
 * Vietnamese, including the owner's name "Nam".
 */
const UNCERTAIN_BELOW = 0.5;
const SEGMENT_MAX_MS = 12_000;
const SEGMENT_MAX_WORDS = 40;
/** The engine mixes pseudo-tokens into its word list: `<vi-VN>` wherever it restarts a segment, and
 * `<unk>` where it could not decide. Neither is transcript text - real audio put a literal "<unk>"
 * in the middle of "Thu hai, Nam se phu trach" - so every angle-bracket token is dropped. Only the
 * locale tag also means "new segment starts here". */
const ENGINE_TAG = /<[^\s<>]*>/g;
const LOCALE_TAG = /^<[a-z]{2,3}(?:-[a-z0-9]{2,8})?>$/i;

export async function transcribeMeeting(id: string, options: TranscribeMeetingOptions = {}): Promise<MeetingTranscript> {
  const home = options.home ?? homeDir();
  const release = acquireTranscriptionLock(id, home);
  try {
    recoverInterruptedTranscription(id, home);
    return await transcribeMeetingLocked(id, { ...options, home });
  } finally {
    release();
  }
}

async function transcribeMeetingLocked(id: string, options: TranscribeMeetingOptions): Promise<MeetingTranscript> {
  const home = options.home!;
  const notify = options.notify ?? (() => {});
  const meeting = readMeeting(id, home);
  if (!meeting) throw new Error(`meeting ${id} was not found`);
  if (meeting.capture?.audioFile !== "audio.wav" || !new Set(["recorded", "ready"]).has(meeting.state)) {
    throw new Error("meeting audio is not finalized yet");
  }
  const audio = join(meetingDir(id, home), meeting.capture.audioFile);
  if (!existsSync(audio) || !statSync(audio).isFile()) throw new Error("meeting audio file is missing");
  const transcriber = options.transcriber ?? await verifyMeetingSupportIntegrity(home);
  const language = normalizeLanguage(options.language ?? "vi");
  const staging = mkdtempSync(join(meetingDir(id, home), ".transcribe-"));

  meeting.state = "transcribing";
  meeting.failure = undefined;
  meeting.transcription = {
    startedAt: new Date().toISOString(),
    language,
    engine: MEETING_ENGINE_NAME,
    engineVersion: transcriber.engineVersion,
    model: transcriber.modelId,
    modelSha256: transcriber.modelSha256,
  };
  saveMeeting(meeting, home);

  try {
    notify(`Transcribing locally with ${transcriber.modelId} (${language}); audio never leaves this computer...`);
    const runEngine = options.runEngine ?? runParakeet;
    // Each capture channel is decoded on its own so "You" and "Meeting audio" stay separable. The
    // manifest records which channels actually carry audio, so a system-only meeting costs one pass.
    const channels = meetingChannels(meeting.capture.channels, meeting.capture.sources);
    const segments: MeetingTranscriptSegment[] = [];
    let voices = 0;
    for (const channel of channels) {
      const mono = join(staging, `${channel.source}.wav`);
      await extractChannelWav(audio, mono, meeting.capture.channels, channel.index);
      if (channels.length > 1) notify(`Decoding the ${channel.source === "microphone" ? "microphone" : "meeting audio"} channel...`);
      const json = await runEngine({
        executable: transcriber.executable,
        model: transcriber.model,
        audio: mono,
        language,
        source: channel.source,
        signal: options.signal,
        notify,
      });
      let decoded = parseMeetingTranscript(id, json, {
        language,
        engineVersion: transcriber.engineVersion,
        model: transcriber.modelId,
        modelSha256: transcriber.modelSha256,
        source: channel.source,
      }).segments;
      // Only the system channel. The microphone is already known to be the user, and a clustering guess
      // must never overwrite something Neko actually knows.
      if (options.diarize && channel.source === "system") {
        const run = options.diarizeMono ?? defaultDiarizer(home, options.speakers, options.signal);
        if (run) {
          try {
            const spans = await run(mono);
            decoded = attributeSpeakers(decoded, spans);
            voices = Math.max(voices, speakerCount(spans));
          } catch (error) {
            // A failed split must never cost the transcript: keep the channel label and say so.
            notify(`Speaker separation failed, keeping the channel label: ${boundedError(error)}`);
          }
        } else {
          notify("Speaker separation was requested but is not installed; keeping the channel label.");
        }
      }
      segments.push(...decoded);
      rmSync(mono, { force: true });
    }
    const transcript: MeetingTranscript = {
      schemaVersion: 1,
      meetingId: id,
      language,
      generatedAt: new Date().toISOString(),
      engine: {
        name: MEETING_ENGINE_NAME,
        version: transcriber.engineVersion,
        model: transcriber.modelId,
        modelSha256: transcriber.modelSha256,
      },
      segments: renumber(segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)),
      ...(voices > 0 ? { voices } : {}),
    };
    writeMeetingTranscript(transcript, home);
    meeting.state = "ready";
    meeting.transcription = {
      ...meeting.transcription,
      completedAt: new Date().toISOString(),
      language: transcript.language,
      transcriptJson: "transcript.json",
      transcriptMarkdown: "transcript.md",
      segmentCount: transcript.segments.length,
    };
    saveMeeting(meeting, home);
    notify(`Transcript ready: ${transcript.segments.length} timestamped segment${transcript.segments.length === 1 ? "" : "s"}.`);
    return transcript;
  } catch (error) {
    meeting.state = "recorded";
    meeting.failure = {
      at: new Date().toISOString(),
      stage: "transcription",
      message: boundedError(error),
    };
    saveMeeting(meeting, home);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Which channels to decode, in capture order. The mic is always channel 0 and system audio
 * channel 1 (see the consent page's ChannelMerger wiring); a mono capture is a single unknown. */
export function meetingChannels(
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

export function speakerFor(source: MeetingTranscriptSegment["source"]): string {
  return source === "microphone" ? "You" : source === "system" ? "Meeting audio" : "Speaker";
}

function acquireTranscriptionLock(id: string, home: string): () => void {
  const path = join(meetingDir(id, home), ".transcribe.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      fd = undefined;
      return () => rmSync(path, { force: true });
    } catch (error: any) {
      if (fd != null) { try { closeSync(fd); } catch {} }
      if (fd != null) rmSync(path, { force: true });
      if (error?.code !== "EEXIST") throw error;
      if (transcriptionOwnerIsAlive(path)) throw new Error(`meeting ${id} is already being transcribed`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not acquire the transcription lock for meeting ${id}`);
}

function transcriptionOwnerIsAlive(path: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; startedAt?: string };
    const age = Date.now() - Date.parse(String(lock.startedAt ?? ""));
    if (!Number.isInteger(lock.pid) || lock.pid! <= 0 || !Number.isFinite(age) || age > 24 * 60 * 60_000) return false;
    try { process.kill(lock.pid!, 0); return true; }
    catch (error: any) { return error?.code === "EPERM"; }
  } catch {
    return false;
  }
}

function recoverInterruptedTranscription(id: string, home: string): void {
  const meeting = readMeeting(id, home);
  if (!meeting || meeting.state !== "transcribing") return;
  meeting.state = "recorded";
  meeting.failure = {
    at: new Date().toISOString(),
    stage: "transcription",
    message: "previous transcription was interrupted; the local audio was kept for retry",
  };
  saveMeeting(meeting, home);
}

/** Turn one channel's word-level JSON into timestamped segments attributed to that channel. */
export function parseMeetingTranscript(
  meetingId: string,
  json: string,
  provenance: {
    language: string;
    engineVersion?: string;
    model: string;
    modelSha256?: string;
    source?: MeetingTranscriptSegment["source"];
  },
): MeetingTranscript {
  let parsed: ParakeetJson;
  try { parsed = JSON.parse(json) as ParakeetJson; }
  catch { throw new Error("transcription engine returned malformed JSON"); }
  if (!Array.isArray(parsed.words)) throw new Error("transcription engine JSON is missing words");
  const source = provenance.source ?? "unknown";
  const speaker = speakerFor(source);
  const segments: MeetingTranscriptSegment[] = [];
  let words: Array<{ text: string; startMs: number; endMs: number; conf?: number }> = [];

  const emit = () => {
    if (!words.length) return;
    const confidences = words.map((word) => word.conf).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const uncertain = words.filter((word) => typeof word.conf === "number" && word.conf < UNCERTAIN_BELOW).map((word) => word.text);
    segments.push({
      id: `seg_${String(segments.length + 1).padStart(5, "0")}`,
      startMs: words[0].startMs,
      endMs: words.at(-1)!.endMs,
      speaker,
      source,
      text: words.map((word) => word.text).join(" "),
      ...(confidences.length ? { confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length } : {}),
      ...(uncertain.length ? { uncertain } : {}),
    });
    words = [];
  };

  for (const raw of parsed.words) {
    const token = String(raw.w ?? "").replace(/\s+/g, " ").trim();
    if (!token) continue;
    if (LOCALE_TAG.test(token)) { emit(); continue; }
    // Real audio glued the tag ONTO a word ("hai<unk>"), so a whole-token check is not enough.
    const text = token.replace(ENGINE_TAG, "").trim();
    if (!text) continue;
    const startMs = seconds(raw.start);
    const endMs = seconds(raw.end);
    if (startMs == null || endMs == null || endMs < startMs) continue;
    const previous = words.at(-1);
    if (previous && (
      startMs - previous.endMs >= SEGMENT_GAP_MS ||
      endMs - words[0].startMs >= SEGMENT_MAX_MS ||
      words.length >= SEGMENT_MAX_WORDS ||
      /[.!?…]$/.test(previous.text)
    )) emit();
    words.push({ text, startMs, endMs, conf: raw.conf });
  }
  emit();

  return {
    schemaVersion: 1,
    meetingId,
    language: provenance.language,
    generatedAt: new Date().toISOString(),
    engine: {
      name: MEETING_ENGINE_NAME,
      version: provenance.engineVersion,
      model: provenance.model,
      modelSha256: provenance.modelSha256,
    },
    segments,
  };
}

/** parakeet-cli writes its JSON to stdout, so the transcript never touches a temporary file. */
export async function runParakeet(request: MeetingEngineRequest): Promise<string> {
  const args = [
    "transcribe",
    "--model", request.model,
    "--input", request.audio,
    "--lang", request.language,
    "--timestamps",
    "--threads", String(Math.max(2, Math.min(12, availableParallelism()))),
    "--json",
  ];
  const engineDir = dirname(request.executable);
  const env = {
    ...process.env,
    PATH: `${engineDir}${delimiter}${process.env.PATH ?? ""}`,
    LD_LIBRARY_PATH: [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
  };
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(request.executable, args, {
      cwd: engineDir,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) { child.kill(); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = `${tail}${text}`.slice(-32_000);
      for (const match of text.matchAll(/(\d{1,3})\s*%/g)) {
        const progress = Number(match[1]);
        if (progress > 0 && progress <= 100) request.notify(`Transcription ${progress}%...`);
      }
    });
    const onAbort = () => child.kill();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      request.signal?.removeEventListener("abort", onAbort);
      if (request.signal?.aborted) reject(new DOMException("Meeting transcription aborted", "AbortError"));
      else if (bytes > 64 * 1024 * 1024) reject(new Error("transcription engine returned an invalid JSON size"));
      else if (code !== 0) reject(new Error(`${MEETING_ENGINE_NAME} exited with ${code}: ${cleanEngineError(tail)}`));
      else if (!bytes) reject(new Error("transcription engine produced no JSON output"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Copy one channel out of an interleaved PCM16 WAV into a standalone mono WAV, streaming so an
 * hour-long meeting never has to fit in memory. */
export async function extractChannelWav(source: string, destination: string, channels: number, channel: number): Promise<void> {
  const format = readWavFormat(source);
  if (channel >= format.channels) throw new Error("meeting audio has fewer channels than the capture claims");
  if (format.channels !== channels) throw new Error("meeting audio channel count does not match the capture manifest");
  const frameBytes = format.channels * 2;
  const frames = Math.floor(format.dataBytes / frameBytes);
  const stream = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  stream.write(wavHeader(frames * 2, format.sampleRate, 1));
  let carry: Buffer = Buffer.alloc(0);
  const select = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = Math.floor(buffer.length / frameBytes) * frameBytes;
      carry = Buffer.from(buffer.subarray(usable));
      const out = Buffer.alloc((usable / frameBytes) * 2);
      for (let frame = 0, at = 0; frame < usable; frame += frameBytes, at += 2) {
        out.writeInt16LE(buffer.readInt16LE(frame + channel * 2), at);
      }
      done(null, out);
    },
  });
  await pipeline(createReadStream(source, { start: format.dataOffset, end: format.dataOffset + frames * frameBytes - 1 }), select, stream);
}


/** Minimal RIFF/WAVE reader: enough to find the PCM16 payload written by the capture bridge. */
export function readWavFormat(path: string): { sampleRate: number; channels: number; dataOffset: number; dataBytes: number } {
  const head = Buffer.alloc(4_096);
  const fd = openSync(path, "r");
  let read = 0;
  try { read = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  if (read < 44 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("meeting audio is not a RIFF/WAVE file");
  }
  let sampleRate = 0;
  let channels = 0;
  for (let at = 12; at + 8 <= read;) {
    const id = head.toString("ascii", at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === "fmt " && at + 8 + 16 <= read) {
      channels = head.readUInt16LE(at + 10);
      sampleRate = head.readUInt32LE(at + 12);
    }
    if (id === "data") {
      if (!sampleRate || !channels) throw new Error("meeting audio is missing its format header");
      const available = statSync(path).size - (at + 8);
      return { sampleRate, channels, dataOffset: at + 8, dataBytes: Math.min(size, Math.max(0, available)) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("meeting audio has no PCM data chunk");
}

function defaultDiarizer(home: string, speakers: number | undefined, signal: AbortSignal | undefined): ((audio: string) => Promise<SpeakerSpan[]>) | null {
  const pack = readDiarizationPack(home);
  return pack ? (audio: string) => diarizeMono(pack, audio, { speakers, signal }) : null;
}

function renumber(segments: MeetingTranscriptSegment[]): MeetingTranscriptSegment[] {
  return segments.map((segment, index) => ({ ...segment, id: `seg_${String(index + 1).padStart(5, "0")}` }));
}

/** parakeet-cli wants a full locale (`vi-VN`); people type `vi`. Accept both, reject anything else. */
export function normalizeLanguage(value: string): string {
  const language = String(value ?? "").trim();
  if (/^auto$/i.test(language)) return "auto";
  const match = language.match(/^([a-z]{2,3})(?:[-_]([a-z0-9]{2,8}))?$/i);
  if (!match) throw new Error("invalid transcription language; use vi, en, a full locale such as vi-VN, or auto");
  const base = match[1].toLowerCase();
  if (match[2]) return `${base}-${match[2].toUpperCase()}`;
  const DEFAULT_REGION: Record<string, string> = {
    vi: "VN", en: "US", ja: "JP", ko: "KR", zh: "CN", th: "TH", id: "ID", ms: "MY",
    fr: "FR", de: "DE", es: "ES", pt: "PT", it: "IT", ru: "RU", hi: "IN", ar: "SA", nl: "NL", pl: "PL",
  };
  return DEFAULT_REGION[base] ? `${base}-${DEFAULT_REGION[base]}` : base;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null;
}

function cleanEngineError(value: string): string {
  return value.replace(/[ --]/g, " ").replace(/\s+/g, " ").trim().slice(-1_000) || "no diagnostic output";
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 1_000);
}
