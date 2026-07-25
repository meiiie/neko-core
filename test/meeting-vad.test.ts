import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeRegions, parseSpeechRegions, sliceWav, speechCoverage } from "../src/adapters/meeting-vad.ts";
import { wavHeader } from "../src/adapters/meeting.ts";

test("speech regions are read from the engine's output, which is on stderr", () => {
  // The first version of this parsed stdout and always got nothing: sherpa-onnx-vad prints its region
  // list to stderr, next to the config dump. Measured against the real binary.
  const regions = parseSpeechRegions([
    'VadModelConfig(silero_vad=SileroVadModelConfig(model="./silero_vad.onnx", threshold=0.5))',
    "0.582 -- 1.484",
    "3.974 -- 4.588",
    "2.000 -- 2.000",
    "Saved to ./out.wav",
  ].join("\n"));
  expect(regions).toEqual([{ startMs: 582, endMs: 1_484 }, { startMs: 3_974, endMs: 4_588 }]);
  expect(parseSpeechRegions("no regions here")).toEqual([]);
});

test("regions are padded, joined when nearly touching, and capped in length", () => {
  const merged = mergeRegions([
    { startMs: 1_000, endMs: 2_000 },
    { startMs: 2_600, endMs: 3_000 }, // 600 ms later: same breath, decoded together
    { startMs: 20_000, endMs: 21_000 }, // a real pause: its own region
  ], 60_000);
  expect(merged).toEqual([{ startMs: 750, endMs: 3_250 }, { startMs: 19_750, endMs: 21_250 }]);
  // Padding never runs past the file or before its start.
  expect(mergeRegions([{ startMs: 100, endMs: 900 }], 1_000)).toEqual([{ startMs: 0, endMs: 1_000 }]);
  // One long stretch is still decoded in bounded pieces.
  const long = mergeRegions([{ startMs: 0, endMs: 150_000 }], 150_000);
  expect(long.length).toBe(3);
  expect(long.at(-1)!.endMs).toBe(150_000);
  expect(mergeRegions([])).toEqual([]);
});

test("coverage reports how much of the file was called speech", () => {
  expect(speechCoverage([{ startMs: 0, endMs: 6_000 }], 10_000)).toBeCloseTo(0.6);
  expect(speechCoverage([], 10_000)).toBe(0);
  expect(speechCoverage([{ startMs: 0, endMs: 1_000 }], 0)).toBe(0);
});

test("a region is cut out of the mono wav exactly, so its words can be shifted back", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-vad-test-"));
  try {
    const frames = 16_000; // one second
    const pcm = Buffer.alloc(frames * 2);
    for (let f = 0; f < frames; f++) pcm.writeInt16LE(f % 1_000, f * 2);
    const source = join(dir, "mono.wav");
    writeFileSync(source, Buffer.concat([wavHeader(pcm.length, 16_000, 1), pcm]));
    const slice = join(dir, "slice.wav");
    sliceWav(source, slice, 250, 500);
    const written = readFileSync(slice);
    expect(written.readUInt16LE(22)).toBe(1);
    expect(written.length - 44).toBe(250 * 16 * 2); // 250 ms of PCM16 at 16 kHz
    expect(written.readInt16LE(44)).toBe(4_000 % 1_000); // starts exactly at 250 ms
    // Asking past the end clamps instead of reading rubbish.
    sliceWav(source, join(dir, "tail.wav"), 900, 5_000);
    expect(readFileSync(join(dir, "tail.wav")).length - 44).toBe(100 * 16 * 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
