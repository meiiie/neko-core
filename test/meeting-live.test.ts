import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agreedPrefix, LiveMeetingTranscriber, toWords, type LiveWindow } from "../src/adapters/meeting-live.ts";
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

test("confirmed text is emitted with meeting-relative timestamps and never duplicated", async () => {
  const { raw, dir } = setup();
  const seen: LiveWindow[] = [];
  const emitted: MeetingTranscriptSegment[][] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["system"],
    workDir: dir,
    windowMs: 30_000,
    minWindowMs: 6_000,
    onSegments: (segments) => emitted.push(segments),
    transcribeWindow: async (window) => {
      seen.push(window);
      // Both passes hear the same opening; the second also hears what came after it.
      return seen.length === 1
        ? [segment(1_000, 3_000, "chào mọi người")]
        : [segment(1_000, 3_000, "chào mọi người"), segment(8_000, 9_500, "chốt thứ sáu")];
    },
  });

  record(raw, 8_000);
  live.start();
  await live.drain();
  expect(seen[0].offsetMs).toBe(0);
  expect(live.segments()).toEqual([]); // one hypothesis confirms nothing

  record(raw, 8_000);
  await live.drain();

  // The agreed opening is committed once, with meeting-relative timing preserved.
  const segments = live.segments();
  expect(segments.map((s) => s.text)).toEqual(["chào mọi người"]);
  expect(segments[0].startMs).toBe(1_000);
  // The buffer resumes at the confirmed end, so committed audio is not re-emitted.
  expect(seen[1].offsetMs).toBe(0);
  expect(live.snapshot().processedMs).toBe(3_000);
  expect(emitted.flat().map((s) => s.text)).toEqual(["chào mọi người"]);
  await live.stop();
});

test("a window shorter than the minimum waits instead of decoding a fragment", async () => {
  const { raw, dir } = setup();
  let calls = 0;
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["system"],
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
    sources: ["system"],
    workDir: dir,
    windowMs: 10_000,
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
  expect(snapshot.processedMs).toBe(290_000); // the buffer restarts at the skip point
  await live.stop();
});

test("one unreadable window is skipped and reported instead of wedging the meeting", async () => {
  const { raw, dir } = setup();
  const offsets: number[] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["system"],
    workDir: dir,
    windowMs: 10_000,
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
    sources: ["system"],
    workDir: dir,
    windowMs: 10_000,
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

test("re-decoded audio never produces a second copy or a backwards timestamp", async () => {
  // Found on real audio before LocalAgreement: re-decoding produced duplicated lines and timestamps
  // that went backwards (4.9s then 4.0s) because each window committed its own wording.
  const { raw, dir } = setup();
  // What was actually said, in meeting time. A real decoder only ever sees the audio still in the
  // buffer, so the stub returns the spoken lines that fall inside the requested window.
  const spoken = [
    { startMs: 1_000, endMs: 3_000, text: "câu một" },
    { startMs: 8_000, endMs: 9_500, text: "câu hai" },
    { startMs: 12_000, endMs: 13_000, text: "câu ba" },
  ];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["system"],
    workDir: dir,
    windowMs: 30_000,
    minWindowMs: 6_000,
    transcribeWindow: async (window) => {
      const end = window.offsetMs + window.durationMs;
      return spoken
        .filter((line) => line.startMs >= window.offsetMs && line.startMs < end)
        .map((line, index, all) => {
          // The last line in a window has no right-hand context, so the decoder mis-hears it.
          const unstable = index === all.length - 1 && line.endMs > end - 2_000;
          return segment(line.startMs - window.offsetMs, line.endMs - window.offsetMs, unstable ? `${line.text} sai` : line.text);
        });
    },
  });
  live.start();

  record(raw, 8_000);
  await live.drain();
  record(raw, 8_000);
  await live.drain();
  record(raw, 8_000);
  await live.drain();

  const texts = live.segments().map((s) => s.text).join(" ");
  expect(texts.split("câu một").length - 1).toBe(1); // committed exactly once
  expect(texts).not.toContain("sai");                // the unstable wording never shipped
  const starts = live.segments().map((s) => s.startMs);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  await live.stop();
});

test("LocalAgreement-2 commits only the prefix two hypotheses agree on", () => {
  const first = toWords([segment(0, 2_000, "chúng ta chốt thứ sáu và")]);
  const second = toWords([segment(0, 2_000, "chúng ta chốt thứ sáu nhé")]);
  // The shared opening is stable; the diverging tail is not committed yet.
  expect(agreedPrefix(first, second)).toBe(5);
  // Punctuation and case differences between passes are not disagreements.
  expect(agreedPrefix(toWords([segment(0, 1_000, "Chốt thứ sáu.")]), toWords([segment(0, 1_000, "chốt thứ sáu")]))).toBe(3);
  // No previous hypothesis means nothing is confirmed.
  expect(agreedPrefix([], first)).toBe(0);
});

test("an unstable window tail is withheld until a second pass confirms it", async () => {
  // The failure this policy exists for: the end of a window has no right-hand context, so the decoder
  // guesses. The earlier heuristic committed such a guess permanently ("and thank you" on real audio).
  const { raw, dir } = setup();
  const emitted: string[] = [];
  let pass = 0;
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["system"],
    workDir: dir,
    windowMs: 30_000,
    minWindowMs: 6_000,
    onSegments: (segments) => emitted.push(...segments.map((s) => s.text)),
    transcribeWindow: async () => {
      pass++;
      // Both passes agree on the opening line. The trailing line has no right-hand context in pass 1,
      // so the decoder mis-hears it and corrects itself in pass 2.
      return pass === 1
        ? [segment(0, 3_000, "chốt thứ sáu"), segment(4_000, 5_000, "cảm ơn")]
        : [segment(0, 3_000, "chốt thứ sáu"), segment(4_000, 6_500, "Nam làm phần backend")];
    },
  });
  live.start();

  record(raw, 8_000);
  await live.drain();
  expect(emitted).toEqual([]); // a single hypothesis confirms nothing

  record(raw, 8_000);
  await live.drain();
  // The stable opening ships; the mis-heard tail never reaches the user.
  expect(emitted).toEqual(["chốt thứ sáu"]);
  expect(emitted.join(" ")).not.toContain("cảm ơn");
  await live.stop();
});

test("window WAVs are valid PCM16 and are cleaned up after decoding", async () => {
  const { raw, dir } = setup();
  let header: Buffer | null = null;
  let windowPath = "";
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["system"],
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
  expect(header!.readUInt16LE(22)).toBe(1); // the engine takes mono, so each channel is decoded alone
  expect(header!.readUInt32LE(24)).toBe(SAMPLE_RATE);
  expect(header!.readUInt16LE(34)).toBe(16); // PCM16
  expect(existsSync(windowPath)).toBe(false); // temporary audio does not linger
  await live.stop();
});

test("each capture channel is deinterleaved, decoded, and stabilized on its own", async () => {
  // The engine has no channel diarization, so "You" vs "Meeting audio" only survives if the mic and the
  // system channel are decoded separately - and each then needs its OWN LocalAgreement state, or one
  // channel's confirmation would advance the other channel past audio nobody decoded.
  const { raw, dir } = setup();
  workspace = dir;
  const seen: LiveWindow[] = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["microphone", "system"],
    workDir: dir,
    windowMs: 30_000,
    minWindowMs: 6_000,
    transcribeWindow: async (window) => {
      seen.push(window);
      const text = window.source === "microphone" ? "mình đồng ý" : "chốt thứ sáu";
      const speaker = window.source === "microphone" ? "You" : "Meeting audio";
      return [{ id: "x", startMs: 1_000, endMs: 3_000, speaker, source: window.source, text }];
    },
  });
  live.start();

  record(raw, 8_000);
  await live.drain();
  expect(seen.map((w) => w.source)).toEqual(["microphone", "system"]);
  expect(live.segments()).toEqual([]); // neither channel has a second opinion yet

  record(raw, 8_000);
  await live.drain();
  const segments = live.segments();
  expect(segments.map((s) => [s.source, s.text])).toEqual([
    ["microphone", "mình đồng ý"],
    ["system", "chốt thứ sáu"],
  ]);
  expect(segments.map((s) => s.speaker)).toEqual(["You", "Meeting audio"]);
  await live.stop();
});

test("channel audio is separated, not mixed, when a window is written", async () => {
  const { raw, dir } = setup();
  const frames = SAMPLE_RATE * 8;
  const pcm = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    pcm.writeInt16LE(1_000, frame * 4);   // microphone tone
    pcm.writeInt16LE(-2_000, frame * 4 + 2); // system tone
  }
  writeFileSync(raw, pcm);
  const samples = new Map<string, number>();
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["microphone", "system"],
    workDir: dir,
    windowMs: 10_000,
    minWindowMs: 6_000,
    transcribeWindow: async (window) => {
      samples.set(window.source, readFileSync(window.wavPath).readInt16LE(44));
      return [];
    },
  });
  live.start();
  await live.drain();
  expect(samples.get("microphone")).toBe(1_000);
  expect(samples.get("system")).toBe(-2_000);
  await live.stop();
});

test("a live log never jumps backwards in time when one channel runs ahead", async () => {
  // Real audio produced this: the microphone confirmed 0:06 while the room audio was still at 0:05, so
  // commit order alone showed "You 0:06" above "Meeting audio 0:05". Nothing is shown until every
  // channel has decoded past it.
  const { raw, dir } = setup();
  const emitted: Array<[string, number]> = [];
  const live = new LiveMeetingTranscriber({
    rawPath: raw,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    sources: ["microphone", "system"],
    workDir: dir,
    windowMs: 30_000,
    minWindowMs: 6_000,
    onSegments: (segments) => emitted.push(...segments.map((s) => [s.source, s.startMs] as [string, number])),
    transcribeWindow: async (window) => {
      // The mic speaks a second later than the room, so commit order and time order disagree.
      const startMs = window.source === "microphone" ? 6_000 : 5_000;
      const endMs = startMs + 1_000;
      // A decoder only hears what is inside the window it was handed.
      if (window.offsetMs > startMs || window.offsetMs + window.durationMs < endMs) return [];
      return [{ id: "x", startMs, endMs, speaker: window.source === "microphone" ? "You" : "Meeting audio", source: window.source, text: "x" }];
    },
  });
  live.start();
  record(raw, 8_000);
  await live.drain();
  record(raw, 8_000);
  await live.drain();
  await live.stop();

  expect(emitted.map(([source]) => source)).toEqual(["system", "microphone"]);
  expect(emitted.map(([, startMs]) => startMs)).toEqual([5_000, 6_000]);
  expect(live.segments().map((s) => s.id)).toEqual(["live_00001", "live_00002"]);
});
