import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  discoverNativeVoiceAudio,
  FfmpegNativeVoiceAudio,
  parseDshowAudioDevices,
} from "../src/adapters/native-voice-audio.ts";

test("DirectShow discovery returns only bounded audio device names", () => {
  const output = [
    '[dshow] "USB Camera" (video)',
    '[dshow] "Microphone Array (Realtek(R) Audio)" (audio)',
    '[dshow]   Alternative name "@device_cm_long"',
    '[dshow] "Microphone (Virtual Cable)" (audio)',
    '[dshow] "Microphone Array (Realtek(R) Audio)" (audio)',
  ].join("\n");
  expect(parseDshowAudioDevices(output)).toEqual([
    "Microphone Array (Realtek(R) Audio)",
    "Microphone (Virtual Cable)",
  ]);
});

test("native voice reports missing dependencies without touching an audio device", () => {
  expect(discoverNativeVoiceAudio("win32", () => null)).toEqual({
    state: "missing",
    detail: "terminal voice needs ffmpeg and ffplay; use the browser compatibility mode instead",
    inputDevices: [],
  });
});

test("ffmpeg audio streams bounded PCM frames, supports mute, playback, interruption, and stop", async () => {
  const children: any[] = [];
  const launches: Array<{ command: string; args: string[] }> = [];
  const fakeSpawn = ((command: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("exit", 0); return true; };
    children.push(child);
    launches.push({ command, args });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as any;
  const input: any[] = [];
  const errors: Error[] = [];
  const audio = new FfmpegNativeVoiceAudio("ffmpeg", "ffplay", "Mic", {
    spawnProcess: fakeSpawn,
    onInput: async (chunk) => { input.push(chunk); },
    onError: (error) => errors.push(error),
  });

  await audio.start();
  children[0].stdout.write(Buffer.alloc(2_400, 1));
  await Bun.sleep(5);
  expect(input).toHaveLength(1);
  expect(input[0]).toMatchObject({ sampleRate: 24_000, numChannels: 1, samplesPerChannel: 1_200 });
  expect(Buffer.from(input[0].data, "base64")).toHaveLength(2_400);

  audio.setMuted(true);
  children[0].stdout.write(Buffer.alloc(2_400, 2));
  await Bun.sleep(5);
  expect(input).toHaveLength(1);
  audio.setMuted(false);

  audio.play({ data: Buffer.alloc(960, 3).toString("base64"), sampleRate: 24_000, numChannels: 1 });
  expect(launches[1]).toMatchObject({ command: "ffplay" });
  expect(launches[1].args).toContain("pipe:0");
  expect(children[1].stdin.read(960)).toEqual(Buffer.alloc(960, 3));
  audio.interruptOutput();
  expect(children[1].killed).toBe(true);

  await audio.stop();
  expect(children[0].killed).toBe(true);
  expect(errors).toEqual([]);
});
