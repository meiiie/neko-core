import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeBrowserMeeting, BrowserMeetingSession, startBrowserMeeting } from "../src/adapters/browser-meeting.ts";
import { createMeetingTools } from "../src/adapters/meeting-tools.ts";
import {
  createMeeting,
  deleteMeeting,
  finalizeMeetingWav,
  formatMeetingTime,
  listMeetings,
  meetingDir,
  readMeeting,
  readMeetingTranscript,
  saveMeeting,
  writeMeetingTranscript,
} from "../src/adapters/meeting.ts";
import { discoverMeetingSupport, meetingSupportRoot, meetingSupportTarget, validateMeetingArchiveEntries, verifyMeetingSupportIntegrity } from "../src/adapters/meeting-support-pack.ts";
import { parseWhisperTranscript, transcribeMeeting } from "../src/adapters/meeting-transcription.ts";
import { evaluateMeetingAsr, renderMeetingEval } from "../src/adapters/meeting-eval.ts";

const homes: string[] = [];
const tempHome = () => { const home = mkdtempSync(join(tmpdir(), "neko-meeting-test-")); homes.push(home); return home; };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("meeting evidence store finalizes PCM as stereo WAV and writes timestamp-cited transcript", async () => {
  const home = tempHome();
  const meeting = createMeeting("  Weekly   sync  ", home, new Date("2026-07-15T08:00:00.000Z"));
  const raw = join(meetingDir(meeting.id, home), ".capture.pcm");
  writeFileSync(raw, Buffer.alloc(16_000 * 2 * 2)); // one second, stereo PCM16
  const audio = await finalizeMeetingWav(meeting.id, raw, 16_000, 2, home);
  expect(audio.durationMs).toBe(1000);
  const wav = readFileSync(audio.path);
  expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(existsSync(raw)).toBe(false);

  writeMeetingTranscript({
    schemaVersion: 1,
    meetingId: meeting.id,
    language: "vi",
    generatedAt: "2026-07-15T08:01:00.000Z",
    engine: { name: "test", model: "fixture" },
    segments: [{ id: "seg_00001", startMs: 1_234, endMs: 2_000, speaker: "You", source: "microphone", text: "  Xin   chao  " }],
  }, home);
  expect(readMeetingTranscript(meeting.id, home)?.segments[0].text).toContain("Xin");
  expect(readFileSync(join(meetingDir(meeting.id, home), "transcript.md"), "utf8")).toContain("[00:00:01.234] **You:** Xin chao");
  expect(formatMeetingTime(3_723_004)).toBe("01:02:03.004");
  expect(listMeetings(home)[0].title).toBe("Weekly sync");
  expect(deleteMeeting(meeting.id, home)).toBe(true);
  expect(readMeeting(meeting.id, home)).toBeNull();
});

test("browser capture requires consent, accepts bounded stereo PCM, and never stores video", async () => {
  const home = tempHome();
  let opened = "";
  const session = new BrowserMeetingSession({ home, title: "Browser test", openUrl: (url) => { opened = url; } });
  const started = await session.start();
  expect(opened).toBe(started.url);
  const url = new URL(started.url);
  const page = await fetch(url.origin);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await page.text()).toContain("video không được đọc, gửi hoặc ghi xuống đĩa");
  expect(await (await fetch(`${url.origin}/meeting-worklet.js`)).text()).toContain("AudioWorkletProcessor");

  const stopped = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://${url.host}/bridge`, { headers: { origin: url.origin } } as any);
    const timer = setTimeout(() => reject(new Error("meeting websocket timeout")), 5_000);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: url.hash.slice(1) }));
    socket.onerror = () => reject(new Error("meeting websocket failed"));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") socket.send(JSON.stringify({ type: "begin", consent: true, sampleRate: 16_000, sources: ["microphone", "system"] }));
      if (message.type === "recording") {
        socket.send(Buffer.alloc(16_000 * 2 * 2 / 10)); // 100 ms
        socket.send(JSON.stringify({ type: "stop" }));
      }
      if (message.type === "stop") { clearTimeout(timer); resolve(); }
    };
  });
  const result = await session.waitUntilStopped();
  await stopped;
  expect(result?.state).toBe("recorded");
  expect(result?.consent?.confirmedAt).toBeTruthy();
  expect(result?.capture?.sources).toEqual(["microphone", "system"]);
  expect(result?.capture?.videoStored).toBe(false);
  expect(result?.capture?.durationMs).toBe(100);
  const wav = readFileSync(join(meetingDir(result!.id, home), "audio.wav"));
  expect(wav.readUInt16LE(22)).toBe(2);
});

test("a consent-page launch failure tears down the loopback owner and incomplete manifest", async () => {
  const home = tempHome();
  await expect(startBrowserMeeting({ home, openUrl: () => { throw new Error("fixture browser failure"); } })).rejects.toThrow("fixture browser failure");
  expect(activeBrowserMeeting()).toBeNull();
  expect(listMeetings(home)).toEqual([]);
});

test("whisper JSON maps stereo channels without inventing remote participant identities", () => {
  const transcript = parseWhisperTranscript("mtg_20260715T120000_abcdef", JSON.stringify({
    result: { language: "vi" },
    transcription: [
      { offsets: { from: 0, to: 900 }, speaker: "0", text: "Toi dong y" },
      { offsets: { from: 1_000, to: 2_000 }, speaker: "1", text: "Chot ngay thu Sau" },
      { offsets: { from: 2_100, to: 2_500 }, text: "Khong ro" },
    ],
  }), { language: "vi", model: "fixture" });
  expect(transcript.segments.map((segment) => [segment.source, segment.speaker])).toEqual([
    ["microphone", "You"],
    ["system", "Meeting audio"],
    ["unknown", "Speaker"],
  ]);
});

test("transcription is retryable and records local provenance", async () => {
  const home = tempHome();
  const meeting = createMeeting("Retry test", home);
  const raw = join(meetingDir(meeting.id, home), ".capture.pcm");
  writeFileSync(raw, Buffer.alloc(6_400));
  const audio = await finalizeMeetingWav(meeting.id, raw, 16_000, 2, home);
  meeting.state = "recorded";
  meeting.capture = {
    kind: "browser-display-media", startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(),
    sampleRate: 16_000, channels: 2, sources: ["system"], videoStored: false,
    audioFile: "audio.wav", audioBytes: audio.audioBytes, durationMs: audio.durationMs,
  };
  saveMeeting(meeting, home);
  const transcriber = { executable: "fixture", executableSource: "managed" as const, engineVersion: "1.9.1", model: "model.bin", modelId: "fixture-model", modelTier: "quick" as const, modelSha256: "a".repeat(64) };
  await expect(transcribeMeeting(meeting.id, { home, transcriber, runEngine: async () => { throw new Error("fixture failure"); } })).rejects.toThrow("fixture failure");
  expect(readMeeting(meeting.id, home)?.state).toBe("recorded");
  expect(readMeeting(meeting.id, home)?.failure?.stage).toBe("transcription");

  const interrupted = readMeeting(meeting.id, home)!;
  interrupted.state = "transcribing"; // simulate a process that exited after updating the manifest
  saveMeeting(interrupted, home);

  const transcript = await transcribeMeeting(meeting.id, {
    home,
    transcriber,
    runEngine: async ({ outputPrefix }) => writeFileSync(`${outputPrefix}.json`, JSON.stringify({ result: { language: "vi" }, transcription: [{ offsets: { from: 0, to: 100 }, speaker: "1", text: "Xin chao" }] })),
  });
  expect(transcript.engine.version).toBe("1.9.1");
  expect(readMeeting(meeting.id, home)?.state).toBe("ready");
  expect(readMeeting(meeting.id, home)?.failure).toBeUndefined();

  let engineStarted!: () => void;
  let continueEngine!: () => void;
  const started = new Promise<void>((resolve) => { engineStarted = resolve; });
  const continueRun = new Promise<void>((resolve) => { continueEngine = resolve; });
  const first = transcribeMeeting(meeting.id, {
    home,
    transcriber,
    runEngine: async ({ outputPrefix }) => {
      engineStarted();
      await continueRun;
      writeFileSync(`${outputPrefix}.json`, JSON.stringify({ result: { language: "vi" }, transcription: [] }));
    },
  });
  await started;
  await expect(transcribeMeeting(meeting.id, { home, transcriber, runEngine: async () => {} })).rejects.toThrow("already being transcribed");
  continueEngine();
  await first;
});

describe("meeting support and tools", () => {
  test("target matrix is explicit and unsupported platforms never receive a guessed binary", () => {
    expect(meetingSupportTarget("win32", "x64")).toEqual({ assetName: "whisper-bin-x64.zip", executableName: "whisper-cli.exe" });
    expect(meetingSupportTarget("linux", "arm64")?.assetName).toContain("arm64");
    expect(meetingSupportTarget("darwin", "arm64")).toBeNull();
    expect(meetingSupportTarget("win32", "arm64")).toBeNull();
    expect(() => validateMeetingArchiveEntries(["engine/whisper-cli"], ["-rwxr-xr-x engine/whisper-cli"])).not.toThrow();
    expect(() => validateMeetingArchiveEntries(["engine/lib.so"], ["lrwxrwxrwx engine/lib.so -> lib.so.1"])).not.toThrow();
    expect(() => validateMeetingArchiveEntries(["../escape"], ["-rw-r--r-- ../escape"])).toThrow("Unsafe");
    expect(() => validateMeetingArchiveEntries(["engine/link"], ["lrwxrwxrwx engine/link -> ../../escape"])).toThrow("unsafe link");
  });

  test("a verified local model plus PATH engine is discovered and integrity-checked", async () => {
    const home = tempHome();
    const root = meetingSupportRoot(home);
    mkdirSync(join(root, "models"), { recursive: true });
    mkdirSync(join(root, "engine"), { recursive: true });
    const model = Buffer.from("verified model fixture");
    const digest = createHash("sha256").update(model).digest("hex");
    const engine = Buffer.from("verified engine fixture");
    const engineDigest = createHash("sha256").update(engine).digest("hex");
    writeFileSync(join(root, "models", "fixture.bin"), model);
    writeFileSync(join(root, "engine", "whisper-cli.exe"), engine);
    writeFileSync(join(root, "support-pack.json"), JSON.stringify({
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      engine: {
        version: "1.9.1", releaseTag: "v1.9.1", assetName: "fixture.zip",
        assetDigest: `sha256:${engineDigest}`, archiveBytes: engine.length,
        executable: "engine/whisper-cli.exe", executableBytes: engine.length,
        executableSha256: engineDigest, sourceUrl: "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1", license: "MIT",
      },
      model: { tier: "quick", id: "fixture", file: "models/fixture.bin", bytes: model.length, sha256: digest, sourceUrl: "https://huggingface.co/ggerganov/whisper.cpp" },
    }));
    const status = discoverMeetingSupport(home, () => null);
    expect(status.state).toBe("ready");
    const verified = await verifyMeetingSupportIntegrity(home);
    expect(verified.modelSha256).toBe(digest);
    writeFileSync(join(root, "models", "fixture.bin"), Buffer.alloc(model.length));
    const future = new Date(Date.now() + 2_000);
    utimesSync(join(root, "models", "fixture.bin"), future, future);
    await expect(verifyMeetingSupportIntegrity(home)).rejects.toThrow("checksum mismatch");
  });

  test("meeting tool permissions keep emergency stop/read safe and mutation gated", async () => {
    const home = tempHome();
    const tools = createMeetingTools(home);
    expect(tools.permission?.("mcp__neko_meeting__inspect")).toBe("safe");
    expect(tools.permission?.("mcp__neko_meeting__stop")).toBe("safe");
    expect(tools.permission?.("mcp__neko_meeting__start")).toBe("gated");
    expect(tools.permission?.("mcp__neko_meeting__delete")).toBe("gated");
    const status = JSON.parse(await tools.call("mcp__neko_meeting__inspect", { operation: "status" }));
    expect(status.capture.state).toBe("idle");
    expect(status.install.cli).toContain("support meeting install");
    await expect(tools.call("mcp__neko_meeting__delete", { meeting_id: "latest" })).rejects.toThrow("exact id");
  });
});

test("meeting ASR eval reports reproducible weighted WER/CER/RTF and channel accuracy", () => {
  const report = evaluateMeetingAsr([
    { id: "vi-1", reference: "Xin chào cả nhà", hypothesis: "xin chào nhà", audioDurationMs: 1000, processingMs: 250, referenceSources: ["microphone", "system"], hypothesisSources: ["microphone", "unknown"] },
    { id: "vi-2", reference: "Chốt thứ Sáu", hypothesis: "chốt thứ sáu", audioDurationMs: 2000, processingMs: 500 },
  ]);
  expect(report.totals.words).toBe(7);
  expect(report.totals.wordErrors).toBe(1);
  expect(report.totals.wer).toBeCloseTo(1 / 7);
  expect(report.totals.rtf).toBe(0.25);
  expect(report.totals.sourceAccuracy).toBe(0.5);
  const extraLabel = evaluateMeetingAsr([{ id: "extra", reference: "mot", hypothesis: "mot", referenceSources: ["system"], hypothesisSources: ["system", "unknown"] }]);
  expect(extraLabel.totals.sourceAccuracy).toBe(0.5);
  expect(renderMeetingEval(report)).toContain("do not prove");
});
