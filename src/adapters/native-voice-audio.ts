/** Low-latency PCM capture/playback for terminal-native GPT-Live sessions. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface RealtimePcmChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel?: number;
  itemId?: string;
}

export interface NativeVoiceAudio {
  start(): Promise<void>;
  play(chunk: RealtimePcmChunk): void;
  interruptOutput(): void;
  setMuted(muted: boolean): void;
  stop(): Promise<void>;
}

export interface NativeVoiceAudioOptions {
  inputDevice?: string;
  onInput: (chunk: RealtimePcmChunk) => Promise<void> | void;
  onError: (error: Error) => void;
  which?: (name: string) => string | null;
  spawnProcess?: typeof spawn;
}

export interface NativeVoiceAudioStatus {
  state: "ready" | "missing";
  detail: string;
  inputDevices: string[];
}

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const FRAME_MS = 50;
const FRAME_BYTES = SAMPLE_RATE * CHANNELS * 2 * FRAME_MS / 1_000;
const MAX_QUEUED_FRAMES = 8;
const MAX_OUTPUT_CHUNK_BYTES = 2 * 1024 * 1024;

export function parseDshowAudioDevices(output: string): string[] {
  const devices: string[] = [];
  for (const match of output.matchAll(/"([^"\r\n]+)"\s+\(audio\)/g)) {
    if (!devices.includes(match[1])) devices.push(match[1]);
  }
  return devices;
}

export function discoverNativeVoiceAudio(
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => string | null = (name) => Bun.which(name, { PATH: process.env.PATH }),
): NativeVoiceAudioStatus {
  const ffmpeg = which("ffmpeg");
  const ffplay = which("ffplay");
  if (!ffmpeg || !ffplay) {
    return {
      state: "missing",
      detail: "terminal voice needs ffmpeg and ffplay; use the browser compatibility mode instead",
      inputDevices: [],
    };
  }
  if (platform !== "win32") {
    return {
      state: "missing",
      detail: "terminal-native microphone capture is currently verified on Windows; use browser compatibility on this OS",
      inputDevices: [],
    };
  }
  const listed = spawnSync(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  const inputDevices = parseDshowAudioDevices(`${listed.stdout ?? ""}\n${listed.stderr ?? ""}`);
  return inputDevices.length
    ? { state: "ready", detail: `${inputDevices.length} microphone input(s) available`, inputDevices }
    : { state: "missing", detail: "ffmpeg found no Windows microphone input", inputDevices: [] };
}

export function createNativeVoiceAudio(options: NativeVoiceAudioOptions): NativeVoiceAudio {
  const which = options.which ?? ((name: string) => Bun.which(name, { PATH: process.env.PATH }));
  const status = discoverNativeVoiceAudio(process.platform, which);
  if (status.state !== "ready") throw new Error(status.detail);
  const inputDevice = options.inputDevice && status.inputDevices.includes(options.inputDevice)
    ? options.inputDevice
    : preferredInput(status.inputDevices);
  return new FfmpegNativeVoiceAudio(
    which("ffmpeg")!,
    which("ffplay")!,
    inputDevice,
    options,
  );
}

function preferredInput(devices: string[]): string {
  const physical = devices.find((name) => !/virtual|streaming|loopback|stereo mix|cable|obs/i.test(name));
  return physical ?? devices[0];
}

export class FfmpegNativeVoiceAudio implements NativeVoiceAudio {
  private capture: ChildProcess | null = null;
  private player: ChildProcess | null = null;
  private playerFormat = "";
  private pending = Buffer.alloc(0);
  private queuedFrames = 0;
  private muted = false;
  private stopping = false;
  private inputChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ffmpeg: string,
    private readonly ffplay: string,
    private readonly inputDevice: string,
    private readonly options: NativeVoiceAudioOptions,
  ) {}

  async start(): Promise<void> {
    if (this.capture) throw new Error("terminal microphone is already running");
    const launch = this.options.spawnProcess ?? spawn;
    const child = launch(this.ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${this.inputDevice}`,
      "-vn", "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.capture = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
    child.stdout?.on("data", (chunk: Buffer) => this.acceptInput(chunk));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code) => {
      if (this.capture === child) this.capture = null;
      if (!this.stopping) this.fail(new Error(stderr.trim() || `microphone capture stopped unexpectedly (${code ?? "unknown"})`));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  play(chunk: RealtimePcmChunk): void {
    if (this.stopping) return;
    const sampleRate = integerInRange(chunk.sampleRate, 8_000, 192_000);
    const channels = integerInRange(chunk.numChannels, 1, 8);
    if (!sampleRate || !channels || !/^[a-z0-9+/]+={0,2}$/i.test(chunk.data)) return;
    const audio = Buffer.from(chunk.data, "base64");
    if (!audio.length || audio.length > MAX_OUTPUT_CHUNK_BYTES || audio.length % (channels * 2) !== 0) return;
    const format = `${sampleRate}/${channels}`;
    if (!this.player || this.playerFormat !== format) this.startPlayer(sampleRate, channels);
    const stdin = this.player?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    stdin.write(audio);
  }

  interruptOutput(): void {
    const player = this.player;
    this.player = null;
    this.playerFormat = "";
    if (player && !player.killed) player.kill();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.pending = Buffer.alloc(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const capture = this.capture;
    this.capture = null;
    if (capture && !capture.killed) capture.kill();
    this.interruptOutput();
    this.pending = Buffer.alloc(0);
    await this.inputChain.catch(() => {});
  }

  private acceptInput(chunk: Buffer): void {
    if (this.muted || this.stopping || !chunk.length) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      if (this.queuedFrames >= MAX_QUEUED_FRAMES) continue;
      this.queuedFrames++;
      const payload: RealtimePcmChunk = {
        data: frame.toString("base64"),
        sampleRate: SAMPLE_RATE,
        numChannels: CHANNELS,
        samplesPerChannel: FRAME_BYTES / 2 / CHANNELS,
      };
      this.inputChain = this.inputChain
        .then(() => this.options.onInput(payload))
        .then(() => {})
        .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))))
        .finally(() => { this.queuedFrames--; });
    }
  }

  private startPlayer(sampleRate: number, channels: number): void {
    this.interruptOutput();
    const launch = this.options.spawnProcess ?? spawn;
    const child = launch(this.ffplay, [
      "-nodisp", "-autoexit", "-hide_banner", "-loglevel", "error",
      "-fflags", "nobuffer", "-flags", "low_delay",
      "-f", "s16le", "-ar", String(sampleRate), "-ac", String(channels), "-i", "pipe:0",
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.player = child;
    this.playerFormat = `${sampleRate}/${channels}`;
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => {
      if (this.player === child) {
        this.player = null;
        this.playerFormat = "";
      }
    });
  }

  private fail(error: Error): void {
    if (!this.stopping) this.options.onError(error);
  }
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
