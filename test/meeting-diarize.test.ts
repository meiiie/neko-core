import { expect, test } from "bun:test";

import {
  attributeSpeakers,
  diarizationTarget,
  parseSpeakerSpans,
  speakerCount,
  DIARIZATION_CAVEAT,
} from "../src/adapters/meeting-diarize.ts";
import type { MeetingTranscriptSegment } from "../src/adapters/meeting.ts";

const seg = (startMs: number, endMs: number, text: string): MeetingTranscriptSegment =>
  ({ id: "x", startMs, endMs, speaker: "Meeting audio", source: "system", text });

test("speaker spans are read out of the engine's noisy output and sorted", () => {
  const spans = parseSpeakerSpans([
    "progress 50.00%",
    "Duration : 38.544 s",
    "  4.334 -- 7.760 speaker_01",
    "0.284 -- 3.389 speaker_00",
    "8.000 -- 8.000 speaker_00", // zero length: not a span
    "9.000 -- 8.000 speaker_00", // backwards: not a span
    "Real time factor (RTF): 8.320 / 38.544 = 0.216",
  ].join("\n"));
  expect(spans).toEqual([
    { cluster: "speaker_00", startMs: 284, endMs: 3_389 },
    { cluster: "speaker_01", startMs: 4_334, endMs: 7_760 },
  ]);
  expect(speakerCount(spans)).toBe(2);
  expect(parseSpeakerSpans("nothing here")).toEqual([]);
});

test("each line takes the voice that overlaps it most, numbered by who spoke first", () => {
  const spans = parseSpeakerSpans([
    "0.2 -- 3.4 speaker_07",
    "4.3 -- 7.8 speaker_02",
    "8.8 -- 13.1 speaker_07",
  ].join("\n"));
  const labelled = attributeSpeakers([
    seg(280, 3_390, "chào mọi người"),
    seg(4_500, 7_700, "vâng anh"),
    seg(9_000, 13_000, "chốt thứ sáu"),
  ], spans);
  // Cluster ids are arbitrary; the labels read in the order people actually spoke.
  expect(labelled.map((s) => s.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
  // Only the label changes - timings, text and channel are untouched evidence.
  expect(labelled.map((s) => s.source)).toEqual(["system", "system", "system"]);
  expect(labelled[0].text).toBe("chào mọi người");
});

test("a line no voice covers keeps its channel label rather than being guessed at", () => {
  const spans = parseSpeakerSpans("0.0 -- 2.0 speaker_00");
  const labelled = attributeSpeakers([seg(0, 1_900, "có tiếng"), seg(30_000, 31_000, "không ai trùng")], spans);
  expect(labelled[0].speaker).toBe("Speaker 1");
  expect(labelled[1].speaker).toBe("Meeting audio");
});

test("with no spans at all nothing is relabelled", () => {
  const segments = [seg(0, 1_000, "a"), seg(2_000, 3_000, "b")];
  expect(attributeSpeakers(segments, [])).toEqual(segments);
});

test("the split is offered only where a verified binary exists", () => {
  expect(diarizationTarget("win32", "x64")?.executableName).toBe("sherpa-onnx-offline-speaker-diarization.exe");
  expect(diarizationTarget("win32", "x64")?.assetName).toContain("win-x64");
  expect(diarizationTarget("linux", "x64")?.assetName).toContain("linux-x64");
  expect(diarizationTarget("darwin", "arm64")?.assetName).toContain("osx-arm64");
  expect(diarizationTarget("linux", "arm64")).toBeNull();
  expect(diarizationTarget("win32", "ia32" as NodeJS.Architecture)).toBeNull();
});

test("the caveat states the measured limit instead of a vague warning", () => {
  // The numbers are the point: a warning nobody can act on is decoration.
  expect(DIARIZATION_CAVEAT).toContain("not names");
  expect(DIARIZATION_CAVEAT).toContain("8 of 11");
  expect(DIARIZATION_CAVEAT).toContain("Confirm who said something");
});
