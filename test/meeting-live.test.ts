import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LiveMeetingTranscriber, trimRepeatedPrefix, type LiveWindow } from "../src/adapters/meeting-live.ts";
import type { MeetingTranscriptSegment } from "../src/adapters/meeting.ts";

const SAMPLE_RATE = 16_000;
const CHANNELS = 2 as const;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;

let workspace = "";

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

function setup(): { raw: string; dir: string } {
  workspace = mkdtempSync(join(tmpdir(), "neko-live-test-"));
  const raw = join(workspace, "audio.pcm");
  writeFileSync(raw, Buffer.alloc(0));
  return { raw, dir: workspace };
}

/** Append `ms` of silence so the growing capture file advances in real units. */
function record(raw: string, ms: number): void {
  appendFileSync(raw, Buffer.alloc(Math.floor(ms * BYTES_PER_MS)));
}

function segment(startMs: number, endMs: number, text: string): MeetingTranscriptSegment {
  return { id: "x", startMs, endMs, speaker: "Meeting audio", source: "system", text };
}

test("live windows become meeting-relative segments and the overlap does not duplicate words", async () => {
  const { raw, dir } = setup();
  const seen: LiveWindow[] = [];
  const emitted: MeetingTranscriptSegment[][] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    windowMs: 10_000,
    overlapMs: 2_000,
    minWindowMs: 6_000,
    onSegments: (segments) => emitted.push(segments),
    transcribeWindow: async (window) => {
      seen.push(window);
      // Window 1 covers 0-10s. Window 2 starts at 8s (2s overlap) and re-hears "chốt thứ sáu".
      return seen.length === 1
        ? [segment(1_000, 3_000, "chào mọi người"), segment(8_200, 9_500, "chốt thứ sáu")]
        : [segment(200, 1_500, "chốt thứ sáu"), segment(4_000, 5_200, "ai làm phần backend")];
    },
  });

  record(raw, 12_000);
  live.start();
  await live.drain();

  expect(seen[0]).toMatchObject({ offsetMs: 0 });
  expect(seen.length).toBe(1);

  record(raw, 8_000); // 20s total
  await live.drain();

  // Second window re-decodes the tail, so it must start before what window 1 already consumed.
  expect(seen[1].offsetMs).toBe(8_000);

  const texts = live.segments().map((s) => s.text);
  expect(texts).toEqual(["chào mọi người", "chốt thứ sáu", "ai làm phần backend"]);

  // Timestamps are meeting-relative, not window-relative: the last line really is at ~12s.
  const last = live.segments().at(-1)!;
  expect(last.startMs).toBe(12_000);
  expect(last.endMs).toBe(13_200);

  // Callers are notified per window, and the duplicate never reaches them.
  expect(emitted.flat().map((s) => s.text)).toEqual(["chào mọi người", "chốt thứ sáu", "ai làm phần backend"]);
  await live.stop();
});

test("a window shorter than the minimum waits instead of decoding a fragment", async () => {
  const { raw, dir } = setup();
  let calls = 0;
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    minWindowMs: 6_000,
    transcribeWindow: async () => { calls++; return []; },
  });
  live.start();

  record(raw, 3_000);
  await live.drain();
  expect(calls).toBe(0); // not enough audio yet

  record(raw, 4_000); // 7s total, over the minimum
  await live.drain();
  expect(calls).toBe(1);
  await live.stop();
});

test("sustained lag skips forward and reports it rather than drifting behind the meeting", async () => {
  const { raw, dir } = setup();
  const offsets: number[] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    windowMs: 10_000,
    overlapMs: 0,
    minWindowMs: 6_000,
    maxLagMs: 30_000,
    transcribeWindow: async (window) => { offsets.push(window.offsetMs); return []; },
  });
  live.start();

  // Five minutes arrive at once (a laptop that could not keep up); the loop must land near the end.
  record(raw, 300_000);
  await live.drain();

  expect(offsets[0]).toBe(290_000); // jumped to availableMs - windowMs
  const snapshot = live.snapshot();
  expect(snapshot.skippedMs).toBe(290_000);
  expect(snapshot.processedMs).toBe(300_000);
  await live.stop();
});

test("one unreadable window is skipped and reported instead of wedging the meeting", async () => {
  const { raw, dir } = setup();
  const offsets: number[] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    windowMs: 10_000,
    overlapMs: 0,
    minWindowMs: 6_000,
    transcribeWindow: async (window) => {
      offsets.push(window.offsetMs);
      if (offsets.length === 1) throw new Error("engine exploded");
      return [segment(0, 1_000, "vẫn chạy")];
    },
  });
  live.start();

  record(raw, 8_000);
  await live.drain();
  expect(live.snapshot().lastError).toContain("engine exploded");
  expect(live.segments()).toEqual([]);
  expect(live.snapshot().skippedMs).toBe(8_000); // the bad audio is accounted for, not silently lost

  // The next pass moves on rather than retrying the poisoned window forever.
  record(raw, 10_000);
  await live.drain();
  expect(offsets[1]).toBe(8_000);
  expect(live.segments().map((s) => s.text)).toEqual(["vẫn chạy"]);
  await live.stop();
});

test("flush decodes the closing tail that is shorter than a full window", async () => {
  // Found on real audio: the last sentence of a meeting was never transcribed live because the
  // remaining seconds never reached minWindowMs.
  const { raw, dir } = setup();
  const offsets: number[] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    windowMs: 10_000,
    overlapMs: 0,
    minWindowMs: 6_000,
    transcribeWindow: async (window) => {
      offsets.push(window.offsetMs);
      return [segment(0, 500, offsets.length === 1 ? "phần đầu" : "câu cuối cùng")];
    },
  });
  live.start();

  record(raw, 10_000);
  await live.drain();
  expect(offsets).toEqual([0]);

  record(raw, 3_000); // only 3s left: below the minimum, so a normal pass ignores it
  await live.drain();
  expect(offsets).toEqual([0]);

  await live.flush(); // the meeting ended - take the tail anyway
  expect(offsets).toEqual([0, 10_000]);
  expect(live.segments().map((s) => s.text)).toEqual(["phần đầu", "câu cuối cùng"]);
  await live.stop();
});

test("the overlap is decoder context, not output: timestamps stay monotonic", async () => {
  // Found on real audio: re-decoded overlap produced duplicated lines and timestamps that went
  // backwards (4.9s then 4.0s), because a window re-worded audio the previous window already emitted.
  const { raw, dir } = setup();
  let call = 0;
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    windowMs: 10_000,
    overlapMs: 3_000,
    minWindowMs: 6_000,
    transcribeWindow: async () => {
      call++;
      // Window 2 starts at 7s and re-hears 7-10s, wording it differently the second time.
      return call === 1
        ? [segment(1_000, 3_000, "câu một"), segment(8_000, 9_500, "câu hai")]
        : [segment(1_200, 2_600, "câu hai nghe lại"), segment(4_000, 5_000, "câu ba")];
    },
  });
  live.start();

  record(raw, 10_000);
  await live.drain();
  record(raw, 8_000);
  await live.drain();

  const segments = live.segments();
  expect(segments.map((s) => s.text)).toEqual(["câu một", "câu hai", "câu ba"]);
  const starts = segments.map((s) => s.startMs);
  expect(starts).toEqual([...starts].sort((a, b) => a - b)); // never moves backwards
  await live.stop();
});

test("a restated prefix is trimmed even when a spurious line landed in between", () => {
  // Real transcript: "...NAM will own the database migration" / "and thank you" /
  // "will own the database migration and finish it by Wednesday".
  const recent = "we will ship the release on friday nam will own the database migration and thank you";
  // The longest already-seen prefix wins, so the trailing "and" goes too - this is exactly what the
  // real engine produced: the line becomes "finish it by Wednesday."
  expect(trimRepeatedPrefix(recent, "will own the database migration and finish it by Wednesday"))
    .toBe("finish it by Wednesday");
  // A short coincidence is left alone.
  expect(trimRepeatedPrefix("chúng ta chốt thứ sáu", "thứ sáu nhé")).toBe("thứ sáu nhé");
  // Nothing to compare against yet.
  expect(trimRepeatedPrefix("", "câu đầu tiên")).toBe("câu đầu tiên");
});

test("window WAVs are valid PCM16 and are cleaned up after decoding", async () => {
  const { raw, dir } = setup();
  let header: Buffer | null = null;
  let windowPath = "";
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    workDir: dir,
    windowMs: 10_000,
    minWindowMs: 6_000,
    transcribeWindow: async (window) => {
      windowPath = window.wavPath;
      header = readFileSync(window.wavPath).subarray(0, 44);
      return [];
    },
  });
  live.start();
  record(raw, 8_000);
  await live.drain();

  expect(header).not.toBeNull();
  expect(header!.toString("ascii", 0, 4)).toBe("RIFF");
  expect(header!.toString("ascii", 8, 12)).toBe("WAVE");
  expect(header!.readUInt16LE(22)).toBe(CHANNELS);
  expect(header!.readUInt32LE(24)).toBe(SAMPLE_RATE);
  expect(header!.readUInt16LE(34)).toBe(16); // PCM16
  expect(existsSync(windowPath)).toBe(false); // temporary audio does not linger
  await live.stop();
});
