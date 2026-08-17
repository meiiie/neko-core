/** Consent-first meeting capture through the browser's native display/system-audio picker. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { finished } from "node:stream/promises";
import { join } from "node:path";

import {
  createMeeting,
  deleteIncompleteMeeting,
  finalizeMeetingWav,
  meetingDir,
  readMeeting,
  saveMeeting,
  type MeetingManifest,
  type MeetingTranscriptSegment,
} from "./meeting.ts";
import type { LiveMeetingTranscriber } from "./meeting-live.ts";
import { detectMicrophoneUsers } from "./audio-activity.ts";
import { homeDir } from "../shared/home.ts";

export type BrowserMeetingState = "starting" | "waiting" | "recording" | "finalizing" | "stopped" | "failed";

export interface BrowserMeetingEvent {
  type: "state" | "audio" | "notice";
  state?: BrowserMeetingState;
  meetingId: string;
  message?: string;
  audioBytes?: number;
  durationMs?: number;
}

export interface BrowserMeetingOptions {
  title?: string;
  home?: string;
  openUrl?: (url: string) => void;
  onEvent?: (event: BrowserMeetingEvent) => void;
  now?: () => number;
  /** Builds the provisional live-transcript loop once consent starts the capture. Absent (the default
   * when the Meeting Support Pack is not installed) simply means no live text; recording is unaffected. */
  liveTranscriberFactory?: (context: {
    rawPath: string;
    sampleRate: number;
    channels: 2;
    sources: Array<"microphone" | "system">;
    onSegments: (segments: MeetingTranscriptSegment[]) => void;
  }) => LiveMeetingTranscriber | null;
  /** How often the live loop looks for new audio. */
  liveIntervalMs?: number;
  /** Quiet time before Neko suggests the meeting ended. It never stops the recording itself. */
  quietProposalMs?: number;
  /** Which apps hold the microphone, for the share-picker hint. Injected so tests stay hermetic. */
  microphoneUsers?: () => { active: Array<{ name: string; meetingApp: boolean }> };
}

interface MeetingSocketData { authenticated: boolean }

const MAX_PACKET_BYTES = 256 * 1024;
const MAX_AUDIO_BYTES = 1_500_000_000;
/** Below this RMS the room is treated as quiet. Room tone and fan noise sit far under it. */
const SPEECH_RMS = 0.01;
/** How long the room stays quiet before Neko SUGGESTS the meeting is over. Minutes, not seconds:
 * sub-second thresholds belong to turn-taking, and a meeting legitimately goes quiet while people
 * read, mute, or wait. Neko never stops on this signal - it only says what it observed. */
const QUIET_PROPOSAL_MS = 5 * 60_000;

function defaultOpenUrl(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export class BrowserMeetingSession {
  readonly meeting: MeetingManifest;
  private server: Bun.Server<MeetingSocketData> | null = null;
  private socket: Bun.ServerWebSocket<MeetingSocketData> | null = null;
  private state: BrowserMeetingState = "starting";
  private token = "";
  private origin = "";
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private stopping: Promise<MeetingManifest | null> | null = null;
  private rawStream: ReturnType<typeof createWriteStream> | null = null;
  private rawPath = "";
  private audioBytes = 0;
  private startedAtMs = 0;
  private live: LiveMeetingTranscriber | null = null;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private lastLoudAtMs = 0;
  /** End of the last segment the transcriber committed, in meeting time. */
  private lastSpeechEndMs = 0;
  private quietNoticeSent = false;
  private readonly home: string;
  private resolveStopped!: (meeting: MeetingManifest | null) => void;
  private readonly stoppedPromise: Promise<MeetingManifest | null>;

  constructor(private readonly options: BrowserMeetingOptions = {}) {
    this.home = options.home ?? homeDir();
    this.meeting = createMeeting(options.title ?? "", this.home);
    this.stoppedPromise = new Promise((resolve) => { this.resolveStopped = resolve; });
  }

  snapshot() {
    return {
      state: this.state,
      meeting: readMeeting(this.meeting.id, this.home) ?? this.meeting,
      audioBytes: this.audioBytes,
      durationMs: this.startedAtMs ? Math.max(0, this.now() - this.startedAtMs) : 0,
    };
  }

  async start(): Promise<{ url: string; meeting: MeetingManifest }> {
    if (this.server) throw new Error("meeting capture is already started");
    this.emitState("starting");
    this.token = randomBytes(32).toString("base64url");
    this.lastHeartbeat = this.now();
    this.server = Bun.serve<MeetingSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => this.handleHttp(request, server),
      websocket: {
        message: (socket, data) => this.onSocketMessage(socket, data),
        close: (socket) => {
          if (this.socket !== socket) return;
          this.socket = null;
          if (!this.stopping) void this.stop("browser closed");
        },
      },
    });
    this.origin = `http://127.0.0.1:${this.server.port}`;
    this.heartbeat = setInterval(() => {
      if (!this.socket) return;
      if (this.now() - this.lastHeartbeat > 20_000) { void this.stop("browser heartbeat lost"); return; }
      this.socket.send(JSON.stringify({ type: "ping" }));
    }, 5_000);
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (this.heartbeat as any).unref?.();
    const url = `${this.origin}/#${this.token}`;
    this.emitState("waiting");
    try { (this.options.openUrl ?? defaultOpenUrl)(url); }
    catch (error) { await this.stop("could not open consent page"); throw error; }
    return { url, meeting: this.meeting };
  }

  waitUntilStopped(): Promise<MeetingManifest | null> {
    return this.stoppedPromise;
  }

  stop(reason = "user"): Promise<MeetingManifest | null> {
    if (this.stopping) return this.stopping;
    this.stopping = this.finish(reason);
    return this.stopping;
  }

  private async finish(reason: string): Promise<MeetingManifest | null> {
    this.emitState("finalizing", reason);
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try { this.socket?.send(JSON.stringify({ type: "stop", reason })); } catch { /* already closed */ }
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, reason); } catch { /* already closed */ }

    let result: MeetingManifest | null = null;
    try {
      if (this.rawStream) {
        this.rawStream.end();
        await finished(this.rawStream);
        this.rawStream = null;
      }
      // After the flush so the closing words are decoded, before finalizeMeetingWav removes the raw file.
      await this.stopLive();
      const meeting = readMeeting(this.meeting.id, this.home);
      if (!meeting || !meeting.capture || !this.rawPath || !existsSync(this.rawPath) || this.audioBytes === 0) {
        if (meeting && meeting.state !== "failed") {
          meeting.state = "failed";
          meeting.failure = { at: new Date().toISOString(), stage: "capture", message: "capture stopped before audio arrived" };
          saveMeeting(meeting, this.home);
        }
        deleteIncompleteMeeting(this.meeting.id, this.home);
      } else {
        const audio = await finalizeMeetingWav(this.meeting.id, this.rawPath, meeting.capture.sampleRate, 2, this.home);
        meeting.state = "recorded";
        meeting.capture.stoppedAt = new Date().toISOString();
        meeting.capture.audioFile = "audio.wav";
        meeting.capture.audioBytes = audio.audioBytes;
        meeting.capture.durationMs = audio.durationMs;
        saveMeeting(meeting, this.home);
        result = meeting;
        this.options.onEvent?.({ type: "audio", meetingId: meeting.id, audioBytes: audio.audioBytes, durationMs: audio.durationMs });
      }
      this.emitState("stopped", reason);
    } catch (error) {
      const meeting = readMeeting(this.meeting.id, this.home);
      if (meeting) {
        meeting.state = "failed";
        meeting.failure = { at: new Date().toISOString(), stage: "capture", message: boundedMessage(error) };
        saveMeeting(meeting, this.home);
        result = meeting;
      }
      this.emitState("failed", boundedMessage(error));
    } finally {
      this.server?.stop(true);
      this.server = null;
      this.resolveStopped(result);
    }
    return result;
  }

  private handleHttp(request: Request, server: Bun.Server<MeetingSocketData>): Response | undefined {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      // The share picker is where the user chooses wrong most often, so the hint about which app is
      // actually in a call belongs on this page, next to the button - not in a log somewhere.
      return new Response(meetingPage(this.meeting.title, this.options.microphoneUsers ?? detectMicrophoneUsers), { headers: PAGE_HEADERS });
    }
    if (request.method === "GET" && url.pathname === "/meeting-worklet.js") {
      return new Response(MEETING_WORKLET, { headers: { ...PAGE_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/bridge") {
      if (request.headers.get("origin") !== this.origin) return new Response("forbidden origin", { status: 403 });
      return server.upgrade(request, { data: { authenticated: false } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }

  private onSocketMessage(socket: Bun.ServerWebSocket<MeetingSocketData>, raw: string | Buffer): void {
    if (Buffer.isBuffer(raw)) {
      if (!socket.data.authenticated || this.socket !== socket || this.state !== "recording" || !this.rawStream) return;
      if (raw.length === 0 || raw.length > MAX_PACKET_BYTES || raw.length % 4 !== 0) { socket.close(1009, "invalid audio packet"); return; }
      if (this.audioBytes + raw.length > MAX_AUDIO_BYTES) { void this.stop("recording size limit reached"); return; }
      this.rawStream.write(raw);
      this.audioBytes += raw.length;
      this.observeLoudness(raw);
      return;
    }
    if (raw.length > 32_768) { socket.close(1009, "message too large"); return; }
    let message: any;
    try { message = JSON.parse(raw); } catch { socket.close(1003, "invalid JSON"); return; }
    if (!socket.data.authenticated) {
      if (message?.type !== "hello" || !safeEqual(String(message.token ?? ""), this.token)) { socket.close(1008, "authentication failed"); return; }
      socket.data.authenticated = true;
      this.socket?.close(1000, "replaced");
      this.socket = socket;
      this.lastHeartbeat = this.now();
      socket.send(JSON.stringify({ type: "ready", meetingId: this.meeting.id }));
      return;
    }
    if (this.socket !== socket) return;
    if (message?.type === "heartbeat" || message?.type === "pong") {
      this.lastHeartbeat = this.now();
      return;
    }
    if (message?.type === "begin") {
      try { this.beginCapture(message); socket.send(JSON.stringify({ type: "recording", meetingId: this.meeting.id })); }
      catch (error) { socket.send(JSON.stringify({ type: "capture-error", message: boundedMessage(error) })); }
      return;
    }
    if (message?.type === "stop") void this.stop("browser stop");
  }

  /**
   * Track how long the room has been quiet.
   *
   * This deliberately does NOT stop anything. Turn-level endpointing runs on sub-second silence, but a
   * meeting is not a turn: people mute themselves, read a document, or wait for a latecomer. Guessing
   * "the meeting ended" and stopping would throw away evidence the user cannot get back, while guessing
   * the other way keeps recording a room that already emptied. So Neko reports the silence and lets the
   * user decide - the one direction that is safe to be wrong in.
   *
   * Two detectors, and the better one wins. When the live transcriber is attached, quiet time comes from
   * the TRANSCRIPT: how much decoded audio has passed since the last thing anybody actually said. That is
   * an ASR model deciding what speech is, which is strictly better than an energy threshold - a fan, a
   * keyboard, or a muted video keeps a room "loud" while nobody is talking. Energy remains the fallback
   * when the Meeting Support Pack is not installed, and `quietSource` says which one answered so the
   * agent never overstates its evidence.
   */
  private observeLoudness(raw: Buffer): void {
    const samples = Math.floor(raw.length / 2);
    if (samples <= 0) return;
    let sum = 0;
    // Sparse sampling: loudness only needs an order of magnitude, not every frame of a long meeting.
    const step = Math.max(1, Math.floor(samples / 256));
    let counted = 0;
    for (let i = 0; i < samples; i += step) {
      const value = raw.readInt16LE(i * 2) / 32_768;
      sum += value * value;
      counted++;
    }
    const rms = counted ? Math.sqrt(sum / counted) : 0;
    const now = this.now();
    if (rms >= SPEECH_RMS) this.lastLoudAtMs = now;
    else if (!this.lastLoudAtMs) this.lastLoudAtMs = this.startedAtMs || now;
    // Always evaluate, including after a loud frame: that is what re-arms the proposal so a meeting
    // which goes quiet, resumes, then ends is reported again instead of latching after the first time.
    this.proposeEndIfQuiet();
  }

  private proposeEndIfQuiet(): void {
    const quiet = this.quietMs();
    if (quiet == null) return;
    if (quiet < (this.options.quietProposalMs ?? QUIET_PROPOSAL_MS)) { this.quietNoticeSent = false; return; }
    if (this.quietNoticeSent) return;
    this.quietNoticeSent = true;
    this.options.onEvent?.({
      type: "notice",
      meetingId: this.meeting.id,
      message: `no speech for ${Math.round(quiet / 60_000)} min - the meeting may have ended; recording continues until you stop it`,
    });
  }

  /** Which evidence answered `quietMs`: the ASR transcript, or raw signal energy. */
  quietSource(): "transcript" | "energy" | null {
    if (!this.live) return this.lastLoudAtMs ? "energy" : null;
    return this.live.snapshot().decodedMs > 0 ? "transcript" : null;
  }

  /** Milliseconds of silence since anybody last spoke, or null before there is evidence either way. */
  quietMs(): number | null {
    if (this.live) {
      // Measured in MEETING time over the audio the decoder has actually finished, so the decoder's own
      // lag never reads as silence: a transcriber running 20 s behind would otherwise report 20 s of
      // quiet while people are still talking.
      // `decodedMs`, not `processedMs`: silence commits nothing, so the committed point stops advancing
      // at the exact moment the room goes quiet. During a long silence this trails by at most the live
      // loop's own lag budget, so a 5-minute proposal can fire a little late - never early.
      const decidedMs = this.live.snapshot().decodedMs;
      if (decidedMs <= 0) return null;
      return Math.max(0, decidedMs - this.lastSpeechEndMs);
    }
    if (!this.lastLoudAtMs) return null;
    return Math.max(0, this.now() - this.lastLoudAtMs);
  }

  /** Provisional live transcript so the agent can answer "what has been said so far" mid-meeting. It is
   * strictly additive: a missing engine, or any live failure, never touches the recording. */
  private startLive(sampleRate: number, sources: Array<"microphone" | "system">): void {
    const factory = this.options.liveTranscriberFactory;
    if (!factory) return;
    try {
      this.live = factory({
        rawPath: this.rawPath,
        sampleRate,
        channels: 2,
        sources,
        // Mirror provisional text back to the consent page so the user can SEE that Neko is listening
        // and what it is hearing, on the same surface that carries the browser's sharing indicator.
        onSegments: (segments) => {
          // The transcript is the speech detector: a committed segment is an ASR model saying words
          // were spoken, and where in the meeting they ended.
          for (const segment of segments) this.lastSpeechEndMs = Math.max(this.lastSpeechEndMs, segment.endMs);
          this.proposeEndIfQuiet();
          try {
            this.socket?.send(JSON.stringify({
              type: "live",
              segments: segments.map((s) => ({ startMs: s.startMs, speaker: s.speaker, text: s.text })),
            }));
          } catch { /* the page may have closed; the transcript is still kept on disk */ }
        },
      });
    } catch {
      this.live = null; // an unavailable engine is not a capture failure
      return;
    }
    if (!this.live) return;
    this.live.start();
    this.liveTimer = setInterval(() => { void this.live?.drain(); }, this.options.liveIntervalMs ?? 5_000);
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (this.liveTimer as any).unref?.();
  }

  /** Provisional segments heard so far. Empty when no live engine is attached. */
  liveSegments(): MeetingTranscriptSegment[] { return this.live?.segments() ?? []; }

  liveSnapshot(): ReturnType<LiveMeetingTranscriber["snapshot"]> | null { return this.live?.snapshot() ?? null; }

  private async stopLive(): Promise<void> {
    if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = null; }
    const live = this.live;
    this.live = null;
    if (!live) return;
    try { await live.drain(); } catch { /* provisional text only */ }
    try { await live.stop(); } catch { /* best effort */ }
  }

  private beginCapture(message: any): void {
    if (this.state !== "waiting") throw new Error("capture is not waiting to start");
    if (message?.consent !== true) throw new Error("recording consent was not confirmed");
    const sampleRate = Number(message.sampleRate);
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) throw new Error("browser returned an unsupported sample rate");
    const sources = Array.isArray(message.sources) ? message.sources.filter((value: any) => value === "microphone" || value === "system") : [];
    if (!sources.includes("system")) throw new Error("share a source with audio enabled before recording");
    this.rawPath = join(meetingDir(this.meeting.id, this.home), ".capture.pcm");
    this.rawStream = createWriteStream(this.rawPath, { flags: "wx", mode: 0o600 });
    this.rawStream.once("error", (error) => { void this.stop(`audio write failed: ${boundedMessage(error)}`); });
    this.startedAtMs = this.now();
    const meeting = readMeeting(this.meeting.id, this.home)!;
    meeting.state = "recording";
    meeting.consent = { confirmedAt: new Date().toISOString(), noticeVersion: 1 };
    meeting.capture = {
      kind: "browser-display-media",
      startedAt: new Date().toISOString(),
      sampleRate,
      channels: 2,
      // SAFETY: sources come from the fixed capture-source union of the consent page.
      sources: [...new Set(sources)] as Array<"microphone" | "system">,
      videoStored: false,
    };
    saveMeeting(meeting, this.home);
    this.startLive(sampleRate, meeting.capture.sources);
    this.emitState("recording", `capturing ${meeting.capture.sources.join(" + ")}`);
  }

  private emitState(state: BrowserMeetingState, message?: string): void {
    this.state = state;
    this.options.onEvent?.({ type: "state", state, meetingId: this.meeting.id, message });
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
}

let activeSession: BrowserMeetingSession | null = null;

export async function startBrowserMeeting(options: BrowserMeetingOptions = {}): Promise<BrowserMeetingSession> {
  if (activeSession && !["stopped", "failed"].includes(activeSession.snapshot().state)) throw new Error(`meeting ${activeSession.meeting.id} is already active`);
  const session = new BrowserMeetingSession(options);
  activeSession = session;
  try { await session.start(); }
  catch (error) {
    await session.stop("capture startup failed").catch(() => null);
    if (activeSession === session) activeSession = null;
    throw error;
  }
  void session.waitUntilStopped().finally(() => { if (activeSession === session) activeSession = null; });
  return session;
}

export function activeBrowserMeeting(): BrowserMeetingSession | null { return activeSession; }

export async function stopBrowserMeeting(reason = "user"): Promise<MeetingManifest | null> {
  if (!activeSession) return null;
  return activeSession.stop(reason);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function boundedMessage(value: any): string {
  return (value instanceof Error ? value.message : String(value ?? "error")).replace(/\s+/g, " ").slice(0, 1_000);
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
};

function meetingPage(title: string, microphoneUsers: () => { active: Array<{ name: string; meetingApp: boolean }> }): string {
  const listening = microphoneUsers().active.filter((entry) => entry.meetingApp);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neko Meeting - ${html(title)}</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#0b0d0f;color:#e7e7e7}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 0,#17211f 0,transparent 35%),#0b0d0f}.shell{width:min(760px,100%);border:1px solid #30363b;background:#101315;border-radius:18px;overflow:hidden;box-shadow:0 28px 90px #000a}.top{padding:18px 22px;border-bottom:1px solid #252b2f;display:flex;justify-content:space-between;gap:16px;align-items:center}.brand{color:#34d6c3;font-weight:800;letter-spacing:.08em}.pill{font-size:12px;color:#a7b0b5;border:1px solid #394147;border-radius:999px;padding:6px 10px}.body{padding:24px}h1{font-size:24px;margin:0 0 8px}.sub{color:#9aa4aa;line-height:1.6;margin:0 0 22px}.privacy{border:1px solid #5b4622;background:#211b11;color:#efd18e;border-radius:12px;padding:14px;line-height:1.55}.consent{display:flex;gap:12px;align-items:flex-start;margin:18px 0;padding:14px;border:1px solid #2e353a;border-radius:12px}.consent input{margin-top:4px;accent-color:#34d6c3}.option{display:flex;gap:10px;align-items:center;color:#c7ced2;margin:14px 0}.status{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;border-top:1px solid #252b2f;border-bottom:1px solid #252b2f;padding:16px 0;margin:18px 0}.dot{width:11px;height:11px;border-radius:50%;background:#687177}.dot.live{background:#ff5d68;box-shadow:0 0 0 7px #ff5d6820}.timer{font-variant-numeric:tabular-nums;color:#9aa4aa}.meters{display:grid;grid-template-columns:78px 1fr;gap:8px 12px;align-items:center;margin:16px 0;color:#9aa4aa;font-size:13px}
.live{margin:16px 0 4px;border:1px solid #24292e;border-radius:12px;background:#0f1215;overflow:hidden}
.liveHead{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border-bottom:1px solid #24292e;color:#7fd1c1;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
.liveCount{color:#6b7780;text-transform:none;letter-spacing:0}
.liveLog{max-height:230px;overflow-y:auto;padding:6px 12px;font-size:13px;line-height:1.55}
.liveRow{display:grid;grid-template-columns:46px 92px 1fr;gap:8px;padding:3px 0;color:#dfe5e8}
.liveAt{color:#5f6b73}
.liveWho{color:#8fb7c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.liveNote{padding:8px 12px;border-top:1px solid #24292e;color:#8a939a;font-size:11.5px}
.listening{border:1px solid #24503f;background:#12211b;color:#8fe0be;border-radius:12px;padding:12px 14px;margin:18px 0 0;line-height:1.55}
.petTop{display:none}
#pet.floating .petTop{display:flex;gap:10px;align-items:center;padding:2px 0 12px;color:#34d6c3;font-weight:800;letter-spacing:.06em;font-size:13px}
#pet.floating .petTitle{color:#9aa4aa;font-weight:600;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pet.floating{padding:14px;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#pet.floating .status{margin:0 0 10px;padding:10px 0;flex:none}
#pet.floating .meters{margin:0;flex:none}
#pet.floating .live{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;margin:12px 0}
#pet.floating .liveHead{flex:none}
#pet.floating .liveLog{flex:1 1 auto;min-height:0;max-height:none}
#pet.floating .liveNote{flex:none}
#pet.floating .actions{flex:none}
#pet.floating .actions button{width:100%;margin:0}
#pet.floating .actions button+button{margin-top:8px}
body.petBody{margin:0;padding:0;display:block;min-height:0;height:100vh;overflow:hidden;background:#101315}.bar{height:7px;background:#252b2f;border-radius:99px;overflow:hidden}.fill{width:0;height:100%;background:#34d6c3;transition:width .12s linear}.fill.sys{background:#d58b27}button{border:0;border-radius:10px;padding:12px 17px;font:inherit;font-weight:750;cursor:pointer;background:#34d6c3;color:#06110f;margin-right:8px}button.secondary{background:#2a3035;color:#e7e7e7}button.danger{background:#5e242a;color:#ffd9dc}button:disabled{opacity:.4;cursor:not-allowed}.error{color:#ff858f;white-space:pre-wrap;line-height:1.5}.hint{color:#778187;font-size:13px;line-height:1.55}.hidden{display:none}@media(max-width:560px){body{padding:0;display:block}.shell{border-radius:0;min-height:100vh;border-left:0;border-right:0}.top,.body{padding:18px}h1{font-size:21px}.status{grid-template-columns:auto 1fr}.timer{grid-column:2}.actions{display:grid;gap:8px}.actions button{width:100%;margin:0}}
</style></head><body><main class="shell"><header class="top"><div class="brand">/\\ · · ▽ &nbsp; NEKO CORE</div><div class="pill">LOCAL MEETING</div></header><section class="body"><h1>${html(title)}</h1><p class="sub">Neko ghi lại âm thanh cuộc họp đang phát trên máy và micro của bạn. Không cần bot tham gia Zoom, Meet, Teams hay Zalo.</p>
<div class="privacy"><strong>Ranh giới riêng tư:</strong> browser sẽ cho bạn chọn chính xác màn hình/tab và có chỉ báo chia sẻ riêng. Neko chỉ lưu audio; video không được đọc, gửi hoặc ghi xuống đĩa. Audio và transcript ở trên máy này.</div>
${listening.length ? `<div class="listening"><strong>Đang trong cuộc gọi:</strong> ${html(listening.map((entry) => entry.name).join(", "))}. Rất có thể đây là cửa sổ cần chia sẻ.</div>` : ""}
<label class="consent"><input id="consent" type="checkbox"><span>Tôi đã thông báo và có quyền ghi âm cuộc họp này theo quy định áp dụng cho mình.</span></label>
<label class="option"><input id="mic" type="checkbox" checked> Ghi thêm micro của tôi ở kênh riêng</label>
<div id="petHost"><div id="pet"><div class="petTop"><span class="brand">/\ &middot; &middot; &#9661;</span><span class="petTitle">${html(title)}</span></div>
<div class="status"><span id="dot" class="dot"></span><strong id="status">Đang kết nối với Neko...</strong><span id="timer" class="timer">00:00:00</span></div>
<div class="meters"><span>Micro</span><div class="bar"><div id="micLevel" class="fill"></div></div><span>Cuộc họp</span><div class="bar"><div id="sysLevel" class="fill sys"></div></div></div>
<div id="livePanel" class="live hidden"><div class="liveHead">Neko đang nghe <span id="liveCount" class="liveCount"></span></div><div id="liveLog" class="liveLog"></div><div class="liveNote">Bản nghe tạm thời - có thể sót hoặc sai chữ. Bản chép chính thức được tạo sau khi dừng.</div></div>
<div class="actions"><button id="start" disabled>Bắt đầu ghi</button><button id="stop" class="danger hidden">Dừng và lưu</button></div></div></div>
<div class="actions"><button id="petBtn" class="secondary hidden">Thu nhỏ thành pet</button></div><p id="error" class="error"></p>
<p class="hint">Khi hộp thoại chia sẻ xuất hiện, hãy bật <strong>Share audio / Chia sẻ âm thanh</strong>. Nút Stop của browser, nút trên trang này, hoặc <code>/meeting stop</code> đều dừng ngay.</p></section></main>
<script>
const token=location.hash.slice(1),startBtn=document.getElementById('start'),stopBtn=document.getElementById('stop'),consent=document.getElementById('consent'),micBox=document.getElementById('mic'),statusEl=document.getElementById('status'),timerEl=document.getElementById('timer'),dot=document.getElementById('dot'),errorEl=document.getElementById('error'),micLevel=document.getElementById('micLevel'),sysLevel=document.getElementById('sysLevel');history.replaceState(null,'',location.pathname);let ws,displayStream,micStream,ctx,processor,active=false,ended=false,recordingReady=false,startedAt=0,timer,heartbeatTimer;
const send=m=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(m))};const state=(text,live=false)=>{statusEl.textContent=text;dot.classList.toggle('live',live)};
function connect(){ws=new WebSocket('ws://'+location.host+'/bridge');ws.binaryType='arraybuffer';ws.onopen=()=>send({type:'hello',token});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='ready'){startBtn.disabled=false;state('Sẵn sàng - chưa ghi âm')}else if(m.type==='ping')send({type:'pong'});else if(m.type==='recording'){recordingReady=true;active=true;startedAt=Date.now();state('ĐANG GHI - audio lưu cục bộ',true);startBtn.classList.add('hidden');stopBtn.classList.remove('hidden');timer=setInterval(updateTimer,250)}else if(m.type==='live')showLive(m.segments);else if(m.type==='capture-error'){errorEl.textContent=m.message;cleanup(false)}else if(m.type==='stop')cleanup(false)};ws.onclose=()=>{if(!ended)cleanup(false)}}connect();heartbeatTimer=setInterval(()=>send({type:'heartbeat'}),5000);
function updateTimer(){const s=Math.floor((Date.now()-startedAt)/1000);timerEl.textContent=[Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(v=>String(v).padStart(2,'0')).join(':')}
function stopTracks(stream){if(stream)for(const track of stream.getTracks())track.stop()}
async function begin(){if(pipWindow){pipWindow.close();window.focus();state('Bấm Bắt đầu lại ở cửa sổ Neko - hộp thoại chia sẻ thuộc về cửa sổ đó.');return}if(!consent.checked){errorEl.textContent='Hãy xác nhận quyền ghi âm trước khi bắt đầu.';return}startBtn.disabled=true;errorEl.textContent='';state('Chọn màn hình hoặc tab và bật chia sẻ âm thanh...');try{displayStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',surfaceSwitching:'include'});if(!displayStream.getAudioTracks().length)throw new Error('Nguồn đã chọn không có audio. Hãy thử lại và bật Share audio / Chia sẻ âm thanh.');displayStream.getTracks().forEach(t=>t.addEventListener('ended',()=>{if(active)finish()}));if(micBox.checked)micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:true,autoGainControl:true},video:false});ctx=new AudioContext({sampleRate:16000,latencyHint:'interactive'});await ctx.audioWorklet.addModule('/meeting-worklet.js');const merger=ctx.createChannelMerger(2),sys=ctx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()));sys.connect(merger,0,1);if(micStream){const mic=ctx.createMediaStreamSource(micStream);mic.connect(merger,0,0)}processor=new AudioWorkletNode(ctx,'neko-pcm16',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:2,channelCountMode:'explicit'});merger.connect(processor);const silent=ctx.createGain();silent.gain.value=0;processor.connect(silent);silent.connect(ctx.destination);processor.port.onmessage=e=>{const d=e.data;micLevel.style.width=d.mic+'%';sysLevel.style.width=d.system+'%';if(recordingReady&&ws&&ws.readyState===1)ws.send(d.buffer)};send({type:'begin',consent:true,sampleRate:ctx.sampleRate,sources:micStream?['microphone','system']:['system']})}catch(e){errorEl.textContent=e&&e.message?e.message:String(e);state('Chưa ghi âm');stopTracks(displayStream);stopTracks(micStream);try{ctx&&ctx.close()}catch{}startBtn.disabled=false}}
let liveTotal=0;
function clock(ms){const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
const livePanel=document.getElementById('livePanel'),liveLog=document.getElementById('liveLog'),liveCount=document.getElementById('liveCount');
function showLive(segments){if(!segments||!segments.length)return;const panel=livePanel,log=liveLog,count=liveCount;panel.classList.remove('hidden');for(const s of segments){const row=document.createElement('div');row.className='liveRow';const at=document.createElement('span');at.className='liveAt';at.textContent=clock(s.startMs);const who=document.createElement('span');who.className='liveWho';who.textContent=s.speaker;const text=document.createElement('span');text.textContent=s.text;row.append(at,who,text);log.appendChild(row);liveTotal++}
while(log.childElementCount>200)log.removeChild(log.firstChild);count.textContent=liveTotal+' đoạn';log.scrollTop=log.scrollHeight}
function finish(){if(ended)return;send({type:'stop'});cleanup(true)}function cleanup(local){if(ended)return;ended=true;if(pipWindow)try{pipWindow.close()}catch(e){}active=false;recordingReady=false;clearInterval(timer);clearInterval(heartbeatTimer);stopTracks(displayStream);stopTracks(micStream);try{processor&&processor.disconnect()}catch{}try{ctx&&ctx.close()}catch{}dot.classList.remove('live');state(local?'Đã dừng - Neko đang hoàn tất file':'Đã dừng');stopBtn.disabled=true;micLevel.style.width=sysLevel.style.width='0%'}
const petBtn=document.getElementById('petBtn'),petHost=document.getElementById('petHost'),pet=document.getElementById('pet');
let pipWindow=null;
if(window.documentPictureInPicture)petBtn.classList.remove('hidden');
function petLabel(){petBtn.textContent=pipWindow?'Đóng pet':'Thu nhỏ thành pet'}
function dockPet(){pet.classList.remove('floating');petHost.append(pet);pipWindow=null;petLabel()}
async function togglePet(){
if(pipWindow){pipWindow.close();return}
try{pipWindow=await documentPictureInPicture.requestWindow({width:360,height:460})}
catch(e){errorEl.textContent=e&&e.message?e.message:String(e);return}
for(const sheet of document.styleSheets){try{const css=[...sheet.cssRules].map(r=>r.cssText).join('');const style=pipWindow.document.createElement('style');style.textContent=css;pipWindow.document.head.appendChild(style)}catch(e){}}
pipWindow.document.title='Neko';pipWindow.document.body.classList.add('petBody');
pet.classList.add('floating');pipWindow.document.body.append(pet);
pipWindow.addEventListener('pagehide',dockPet);
petLabel()}
petBtn.onclick=togglePet;
startBtn.onclick=begin;stopBtn.onclick=finish;addEventListener('pagehide',()=>{if(active)send({type:'stop'});stopTracks(displayStream);stopTracks(micStream)});
</script></body></html>`;
}

const MEETING_WORKLET = `class NekoPcm16Processor extends AudioWorkletProcessor {
  constructor(){super();this.out=new Int16Array(4096);this.at=0;this.micSq=0;this.sysSq=0;this.levelCount=0}
  process(inputs,outputs){const input=inputs[0]||[],left=input[0],right=input[1];if(!left)return true;const silent=new Float32Array(left.length);const r=right||silent;for(let i=0;i<left.length;i++){const l=Math.max(-1,Math.min(1,left[i]||0)),s=Math.max(-1,Math.min(1,r[i]||0));this.out[this.at++]=l*32767;this.out[this.at++]=s*32767;this.micSq+=l*l;this.sysSq+=s*s;this.levelCount++;if(this.at===this.out.length){const buffer=this.out.buffer;const mic=Math.min(100,Math.sqrt(this.micSq/this.levelCount)*260),system=Math.min(100,Math.sqrt(this.sysSq/this.levelCount)*260);this.port.postMessage({buffer,mic,system},[buffer]);this.out=new Int16Array(4096);this.at=0;this.micSq=0;this.sysSq=0;this.levelCount=0}}const output=outputs[0]?.[0];if(output)output.fill(0);return true}
}
registerProcessor('neko-pcm16',NekoPcm16Processor);`;
