/** Consent-first meeting tools. Capture/transcription live at the adapter edge, never in core. */
import type { McpTools } from "../core/ports.ts";
import { homeDir } from "../shared/home.ts";
import { activeBrowserMeeting, startBrowserMeeting, stopBrowserMeeting } from "./browser-meeting.ts";
import { composeMcpTools } from "./mcp-compose.ts";
import {
  deleteMeeting,
  latestMeeting,
  listMeetings,
  readMeeting,
  readMeetingTranscript,
  type MeetingManifest,
} from "./meeting.ts";
import { discoverMeetingSupport } from "./meeting-support-pack.ts";
import { transcribeMeeting } from "./meeting-transcription.ts";

const PREFIX = "mcp__neko_meeting__";
const SCHEMAS = [
  {
    name: "inspect",
    description: "Inspect local meeting capture/support status, list recent meetings, or read a bounded page of timestamped transcript segments. Read-only.",
    properties: {
      operation: { type: "string", enum: ["status", "list", "read"] },
      meeting_id: { type: "string", description: "Meeting id; omit or use 'latest' for the newest meeting." },
      offset: { type: "integer", minimum: 0, description: "First transcript segment for read." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "At most 200 segments; defaults to 50." },
    },
    required: ["operation"],
  },
  {
    name: "start",
    description: "Open Neko's local consent page and the browser's native screen/tab audio picker. Recording starts only after the user confirms consent and Share audio. Video is never stored. Gated.",
    properties: { title: { type: "string", description: "Optional meeting title." } },
    required: [],
  },
  {
    name: "stop",
    description: "Emergency-stop the active local meeting capture and finalize its WAV evidence. Always safe because it reduces access.",
    properties: {},
    required: [],
  },
  {
    name: "transcribe",
    description: "Transcribe a finalized meeting locally with the verified Meeting Support Pack. No audio is uploaded. Gated.",
    properties: {
      meeting_id: { type: "string", description: "Meeting id; omit or use 'latest'." },
      language: { type: "string", description: "Language code such as vi, en, or auto; defaults to vi." },
    },
    required: [],
  },
  {
    name: "delete",
    description: "Permanently delete one stopped meeting's local audio, transcript, and metadata. Gated and irreversible.",
    properties: { meeting_id: { type: "string", description: "Exact meeting id from a prior inspection. Aliases such as 'latest' are refused." } },
    required: ["meeting_id"],
  },
].map((tool) => ({
  type: "function",
  function: {
    name: `${PREFIX}${tool.name}`,
    description: tool.description,
    parameters: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false },
  },
}));

class MeetingTools implements McpTools {
  constructor(private readonly home = homeDir()) {}

  toolSchemas(): any[] { return SCHEMAS; }
  has(name: string): boolean { return SCHEMAS.some((schema) => schema.function.name === name); }
  permission(name: string): "safe" | "gated" {
    return name === `${PREFIX}inspect` || name === `${PREFIX}stop` ? "safe" : "gated";
  }
  temporal(name: string): boolean { return name === `${PREFIX}inspect`; }
  indexBlock(): string {
    return "Neko Meeting tools capture only after explicit user/browser consent and keep audio/transcripts local. Load the meeting-notes skill before meeting work. Start/transcribe/delete are gated; emergency stop and bounded inspection are safe. System audio is a channel, not verified person-level diarization.";
  }

  async call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const action = name.slice(PREFIX.length);
    if (action === "inspect") return this.inspect(args);
    if (action === "start") {
      if (signal?.aborted) throw new DOMException("Meeting start aborted", "AbortError");
      const session = await startBrowserMeeting({ home: this.home, title: String(args.title ?? "") });
      return JSON.stringify({
        success: true,
        meeting: summarize(session.meeting),
        state: "waiting_for_consent",
        next: "In the local page, confirm recording rights, choose a screen/tab, enable Share audio, then press Start. Use the safe stop tool at any time.",
        privacy: "Audio stays on this computer; video is neither sent to Neko nor stored.",
      }, null, 2);
    }
    if (action === "stop") {
      const meeting = await stopBrowserMeeting("agent or user stop");
      return JSON.stringify(meeting
        ? { success: true, meeting: summarize(meeting), next: "Transcribe locally when ready." }
        : { success: true, state: "idle", detail: "No meeting capture was active." }, null, 2);
    }
    if (action === "transcribe") {
      const meeting = this.resolveMeeting(args.meeting_id);
      const transcript = await transcribeMeeting(meeting.id, {
        home: this.home,
        language: String(args.language ?? "vi"),
        signal,
      });
      return JSON.stringify({
        success: true,
        meetingId: meeting.id,
        language: transcript.language,
        segments: transcript.segments.length,
        next: "Read transcript segments in bounded pages, then ground every summary/action item in timestamp citations.",
      }, null, 2);
    }
    if (action === "delete") {
      const id = String(args.meeting_id ?? "").trim();
      if (!id || id === "latest") throw new Error("meeting deletion requires an exact id from a prior inspection");
      const meeting = readMeeting(id, this.home);
      if (!meeting) throw new Error(`meeting ${id} was not found`);
      const deleted = deleteMeeting(meeting.id, this.home);
      return JSON.stringify({ success: deleted, meetingId: meeting.id, deleted: deleted ? ["audio", "transcript", "metadata"] : [] }, null, 2);
    }
    throw new Error(`unknown meeting tool ${name}`);
  }

  private inspect(args: Record<string, any>): string {
    const operation = String(args.operation ?? "");
    if (operation === "status") {
      const active = activeBrowserMeeting()?.snapshot();
      const support = discoverMeetingSupport(this.home);
      const latest = latestMeeting(this.home);
      return JSON.stringify({
        capture: active ? { state: active.state, meeting: summarize(active.meeting), audioBytes: active.audioBytes, durationMs: active.durationMs } : { state: "idle" },
        transcription: { state: support.state, detail: support.detail },
        latest: latest ? summarize(latest) : null,
        install: { tui: "/support meeting", cli: "neko support meeting install" },
      }, null, 2);
    }
    if (operation === "list") {
      const offset = boundedInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = boundedInt(args.limit, 1, 200, 50);
      const all = listMeetings(this.home);
      return JSON.stringify({ total: all.length, offset, limit, meetings: all.slice(offset, offset + limit).map(summarize), hasMore: offset + limit < all.length }, null, 2);
    }
    if (operation === "read") {
      const meeting = this.resolveMeeting(args.meeting_id);
      const transcript = readMeetingTranscript(meeting.id, this.home);
      if (!transcript) return JSON.stringify({ meeting: summarize(meeting), transcript: null, detail: "No transcript is ready." }, null, 2);
      const offset = boundedInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = boundedInt(args.limit, 1, 200, 50);
      return JSON.stringify({
        meeting: summarize(meeting),
        language: transcript.language,
        engine: transcript.engine,
        totalSegments: transcript.segments.length,
        offset,
        limit,
        segments: transcript.segments.slice(offset, offset + limit),
        hasMore: offset + limit < transcript.segments.length,
      }, null, 2);
    }
    throw new Error("meeting inspect operation must be status, list, or read");
  }

  private resolveMeeting(value: unknown): MeetingManifest {
    const id = String(value ?? "latest").trim();
    const meeting = !id || id === "latest" ? latestMeeting(this.home) : readMeeting(id, this.home);
    if (!meeting) throw new Error(id === "latest" || !id ? "no local meeting was found" : `meeting ${id} was not found`);
    return meeting;
  }
}

export function createMeetingTools(home = homeDir()): McpTools { return new MeetingTools(home); }
export function withMeetingTools(source?: McpTools, home = homeDir()): McpTools {
  return composeMcpTools(source, createMeetingTools(home))!;
}

function summarize(meeting: MeetingManifest): Record<string, unknown> {
  return {
    id: meeting.id,
    title: meeting.title,
    state: meeting.state,
    createdAt: meeting.createdAt,
    durationMs: meeting.capture?.durationMs,
    sources: meeting.capture?.sources,
    videoStored: meeting.capture?.videoStored,
    segments: meeting.transcription?.segmentCount,
    failure: meeting.failure,
  };
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`expected an integer from ${min} to ${max}`);
  return number;
}
