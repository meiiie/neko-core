/** Local meeting evidence store: bounded ids, atomic metadata, WAV audio, and timestamped transcripts. */
import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";

export type MeetingState = "waiting" | "recording" | "recorded" | "transcribing" | "ready" | "failed";

export interface MeetingManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  state: MeetingState;
  createdAt: string;
  updatedAt: string;
  consent?: {
    confirmedAt: string;
    noticeVersion: 1;
  };
  capture?: {
    kind: "browser-display-media";
    startedAt: string;
    stoppedAt?: string;
    sampleRate: number;
    channels: 2;
    sources: Array<"microphone" | "system">;
    videoStored: false;
    audioFile?: "audio.wav";
    audioBytes?: number;
    durationMs?: number;
  };
  transcription?: {
    startedAt: string;
    completedAt?: string;
    language: string;
    engine: string;
    engineVersion?: string;
    model: string;
    modelSha256?: string;
    transcriptJson?: "transcript.json";
    transcriptMarkdown?: "transcript.md";
    segmentCount?: number;
  };
  failure?: { at: string; stage: "capture" | "transcription"; message: string };
}

export interface MeetingTranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  source: "microphone" | "system" | "unknown";
  text: string;
  confidence?: number;
}

export interface MeetingTranscript {
  schemaVersion: 1;
  meetingId: string;
  language: string;
  generatedAt: string;
  engine: { name: string; version?: string; model: string; modelSha256?: string };
  segments: MeetingTranscriptSegment[];
}

const ID_RE = /^mtg_\d{8}T\d{6}_[a-z0-9]{6}$/;

export function meetingsRoot(home = homeDir()): string {
  return join(home, ".neko-core", "meetings");
}

export function newMeetingId(now = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}T${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `mtg_${stamp}_${randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(6, "0").slice(0, 6)}`;
}

export function meetingDir(id: string, home = homeDir()): string {
  if (!ID_RE.test(id)) throw new Error("invalid meeting id");
  return join(meetingsRoot(home), id);
}

export function createMeeting(title: string, home = homeDir(), now = new Date()): MeetingManifest {
  const root = meetingsRoot(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let id = newMeetingId(now);
  while (existsSync(join(root, id))) id = newMeetingId(new Date(now.getTime() + 1));
  mkdirSync(join(root, id), { recursive: false, mode: 0o700 });
  const at = now.toISOString();
  const manifest: MeetingManifest = {
    schemaVersion: 1,
    id,
    title: normalizeMeetingTitle(title, now),
    state: "waiting",
    createdAt: at,
    updatedAt: at,
  };
  saveMeeting(manifest, home);
  return manifest;
}

export function readMeeting(id: string, home = homeDir()): MeetingManifest | null {
  try {
    const value = JSON.parse(readFileSync(join(meetingDir(id, home), "meeting.json"), "utf8")) as MeetingManifest;
    return value.schemaVersion === 1 && value.id === id && ID_RE.test(value.id) ? value : null;
  } catch {
    return null;
  }
}

export function saveMeeting(manifest: MeetingManifest, home = homeDir()): void {
  if (!ID_RE.test(manifest.id) || manifest.schemaVersion !== 1) throw new Error("invalid meeting manifest");
  manifest.updatedAt = new Date().toISOString();
  atomicWriteFileSync(join(meetingDir(manifest.id, home), "meeting.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
}

export function listMeetings(home = homeDir()): MeetingManifest[] {
  const root = meetingsRoot(home);
  if (!existsSync(root)) return [];
  const meetings: MeetingManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const meeting = readMeeting(entry.name, home);
    if (meeting) meetings.push(meeting);
  }
  return meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function latestMeeting(home = homeDir()): MeetingManifest | null {
  return listMeetings(home)[0] ?? null;
}

export function deleteIncompleteMeeting(id: string, home = homeDir()): boolean {
  const meeting = readMeeting(id, home);
  if (!meeting || !["waiting", "failed"].includes(meeting.state)) return false;
  rmSync(meetingDir(id, home), { recursive: true, force: true });
  return true;
}

/** Explicit privacy control. Active recordings must be stopped before their evidence can be removed. */
export function deleteMeeting(id: string, home = homeDir()): boolean {
  const meeting = readMeeting(id, home);
  if (!meeting) return false;
  if (meeting.state === "recording" || meeting.state === "transcribing") {
    throw new Error(`meeting ${id} is ${meeting.state}; stop or wait for it before deleting its evidence`);
  }
  rmSync(meetingDir(id, home), { recursive: true, force: true });
  return true;
}

export function readMeetingTranscript(id: string, home = homeDir()): MeetingTranscript | null {
  try {
    const value = JSON.parse(readFileSync(join(meetingDir(id, home), "transcript.json"), "utf8")) as MeetingTranscript;
    return value.schemaVersion === 1 && value.meetingId === id ? value : null;
  } catch {
    return null;
  }
}

export function writeMeetingTranscript(transcript: MeetingTranscript, home = homeDir()): void {
  if (!ID_RE.test(transcript.meetingId) || transcript.schemaVersion !== 1) throw new Error("invalid meeting transcript");
  const dir = meetingDir(transcript.meetingId, home);
  atomicWriteFileSync(join(dir, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`, 0o600);
  const markdown = [
    `# ${readMeeting(transcript.meetingId, home)?.title ?? "Meeting transcript"}`,
    "",
    `- Meeting: \`${transcript.meetingId}\``,
    `- Language: \`${transcript.language}\``,
    `- Engine: \`${transcript.engine.name}\` / \`${transcript.engine.model}\``,
    "",
    "## Transcript",
    "",
    ...transcript.segments.map((segment) =>
      `- [${formatMeetingTime(segment.startMs)}] **${segment.speaker}:** ${segment.text.replace(/\s+/g, " ").trim()}`),
    "",
  ].join("\n");
  atomicWriteFileSync(join(dir, "transcript.md"), markdown, 0o600);
}

/** Convert streamed interleaved PCM16 into a standard RIFF/WAVE evidence file without buffering it. */
export async function finalizeMeetingWav(
  id: string,
  rawPath: string,
  sampleRate: number,
  channels: 2,
  home = homeDir(),
): Promise<{ path: string; audioBytes: number; durationMs: number }> {
  const dataBytes = statSync(rawPath).size;
  if (dataBytes > 0xffff_ffff - 36) throw new Error("meeting audio exceeds the WAV size limit");
  const output = join(meetingDir(id, home), "audio.wav");
  const stream = createWriteStream(output, { flags: "wx", mode: 0o600 });
  stream.write(wavHeader(dataBytes, sampleRate, channels));
  await pipeline(createReadStream(rawPath), stream);
  rmSync(rawPath, { force: true });
  const frameBytes = channels * 2;
  const durationMs = Math.round((dataBytes / frameBytes / sampleRate) * 1000);
  return { path: output, audioBytes: dataBytes + 44, durationMs };
}

export function formatMeetingTime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds));
  const ms = String(total % 1000).padStart(3, "0");
  const seconds = Math.floor(total / 1000);
  const s = String(seconds % 60).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  const m = String(minutes % 60).padStart(2, "0");
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function normalizeMeetingTitle(value: string, now: Date): string {
  const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || `Meeting ${now.toISOString().slice(0, 16).replace("T", " ")}`;
}

function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) throw new Error("invalid audio sample rate");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
