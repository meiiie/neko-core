/** Local ASR adapter for meeting evidence. Core and the agent loop never depend on whisper.cpp. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join } from "node:path";

import {
  meetingDir,
  readMeeting,
  saveMeeting,
  writeMeetingTranscript,
  type MeetingTranscript,
  type MeetingTranscriptSegment,
} from "./meeting.ts";
import { verifyMeetingSupportIntegrity, type MeetingTranscriber } from "./meeting-support-pack.ts";
import { homeDir } from "../shared/home.ts";

export interface TranscribeMeetingOptions {
  home?: string;
  language?: string;
  signal?: AbortSignal;
  notify?: (message: string) => void;
  transcriber?: MeetingTranscriber;
  runEngine?: (request: WhisperRunRequest) => Promise<void>;
}

export interface WhisperRunRequest {
  executable: string;
  model: string;
  audio: string;
  outputPrefix: string;
  language: string;
  stereo: boolean;
  signal?: AbortSignal;
  notify: (message: string) => void;
}

interface WhisperJsonSegment {
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  text?: string;
  speaker?: string | number;
  tokens?: Array<{ p?: number; text?: string }>;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperJsonSegment[];
}

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
  const outputPrefix = join(staging, "whisper-output");

  meeting.state = "transcribing";
  meeting.failure = undefined;
  meeting.transcription = {
    startedAt: new Date().toISOString(),
    language,
    engine: "whisper.cpp",
    engineVersion: transcriber.engineVersion,
    model: transcriber.modelId,
    modelSha256: transcriber.modelSha256,
  };
  saveMeeting(meeting, home);

  try {
    notify(`Transcribing locally with ${transcriber.modelId} (${language}); audio never leaves this computer...`);
    await (options.runEngine ?? runWhisper)({
      executable: transcriber.executable,
      model: transcriber.model,
      audio,
      outputPrefix,
      language,
      stereo: meeting.capture.channels === 2,
      signal: options.signal,
      notify,
    });
    const output = `${outputPrefix}.json`;
    if (!existsSync(output)) throw new Error("transcription engine did not produce JSON output");
    const size = statSync(output).size;
    if (size <= 0 || size > 64 * 1024 * 1024) throw new Error("transcription engine returned an invalid JSON size");
    const transcript = parseWhisperTranscript(id, readFileSync(output, "utf8"), {
      language,
      engineVersion: transcriber.engineVersion,
      model: transcriber.modelId,
      modelSha256: transcriber.modelSha256,
    });
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

export function parseWhisperTranscript(
  meetingId: string,
  json: string,
  provenance: { language: string; engineVersion?: string; model: string; modelSha256?: string },
): MeetingTranscript {
  let parsed: WhisperJson;
  try { parsed = JSON.parse(json) as WhisperJson; }
  catch { throw new Error("transcription engine returned malformed JSON"); }
  if (!Array.isArray(parsed.transcription)) throw new Error("transcription engine JSON is missing segments");
  const segments: MeetingTranscriptSegment[] = [];
  for (const raw of parsed.transcription) {
    const text = String(raw.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const startMs = validOffset(raw.offsets?.from) ?? parseWhisperTime(raw.timestamps?.from);
    const endMs = validOffset(raw.offsets?.to) ?? parseWhisperTime(raw.timestamps?.to);
    if (startMs == null || endMs == null || endMs < startMs) continue;
    const speakerId = String(raw.speaker ?? "");
    const source = speakerId === "0" ? "microphone" : speakerId === "1" ? "system" : "unknown";
    const probabilities = raw.tokens?.map((token) => token.p).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    segments.push({
      id: `seg_${String(segments.length + 1).padStart(5, "0")}`,
      startMs,
      endMs,
      speaker: source === "microphone" ? "You" : source === "system" ? "Meeting audio" : "Speaker",
      source,
      text,
      ...(probabilities?.length ? { confidence: probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length } : {}),
    });
  }
  return {
    schemaVersion: 1,
    meetingId,
    language: String(parsed.result?.language || provenance.language),
    generatedAt: new Date().toISOString(),
    engine: {
      name: "whisper.cpp",
      version: provenance.engineVersion,
      model: provenance.model,
      modelSha256: provenance.modelSha256,
    },
    segments,
  };
}

async function runWhisper(request: WhisperRunRequest): Promise<void> {
  const args = [
    "-m", request.model,
    "-f", request.audio,
    "-l", request.language,
    "-t", String(Math.max(2, Math.min(12, availableParallelism()))),
    "-oj",
    "-of", request.outputPrefix,
    "-np",
    "-pp",
    "-sns",
    ...(request.stereo ? ["-di"] : []),
  ];
  const engineDir = dirname(request.executable);
  const env = {
    ...process.env,
    PATH: `${engineDir}${delimiter}${process.env.PATH ?? ""}`,
    LD_LIBRARY_PATH: [engineDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter),
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(request.executable, args, {
      cwd: engineDir,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    let lastProgress = -1;
    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = `${tail}${text}`.slice(-32_000);
      for (const match of text.matchAll(/(?:progress\s*=\s*|\b)(\d{1,3})%/gi)) {
        const progress = Number(match[1]);
        if (progress >= lastProgress + 10 && progress <= 100) { lastProgress = progress; request.notify(`Transcription ${progress}%...`); }
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const onAbort = () => child.kill();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      request.signal?.removeEventListener("abort", onAbort);
      if (request.signal?.aborted) reject(new DOMException("Meeting transcription aborted", "AbortError"));
      else if (code === 0) resolve();
      else reject(new Error(`whisper.cpp exited with ${code}: ${cleanEngineError(tail)}`));
    });
  });
}

function normalizeLanguage(value: string): string {
  const language = String(value ?? "").trim().toLowerCase();
  if (!/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/.test(language)) throw new Error("invalid transcription language; use vi, en, or auto");
  return language;
}

function validOffset(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function parseWhisperTime(value: unknown): number | null {
  const match = String(value ?? "").match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function cleanEngineError(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(-1_000) || "no diagnostic output";
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 1_000);
}
