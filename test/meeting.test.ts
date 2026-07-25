import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeBrowserMeeting, BrowserMeetingSession, startBrowserMeeting } from "../src/adapters/browser-meeting.ts";
import { LiveMeetingTranscriber } from "../src/adapters/meeting-live.ts";
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
  wavHeader,
  writeMeetingTranscript,
} from "../src/adapters/meeting.ts";
import { discoverMeetingSupport, meetingSupportRoot, meetingSupportTarget, validateMeetingArchiveEntries, verifyMeetingSupportIntegrity } from "../src/adapters/meeting-support-pack.ts";
import { extractChannelWav, meetingChannels, normalizeLanguage, parseMeetingTranscript, transcribeMeeting } from "../src/adapters/meeting-transcription.ts";
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
    segments: [
      { id: "seg_00001", startMs: 1_234, endMs: 2_000, speaker: "You", source: "microphone", text: "  Xin   chao  " },
      { id: "seg_00002", startMs: 3_000, endMs: 4_000, speaker: "You", source: "microphone", text: "chay migraine truoc", uncertain: ["migraine"] },
    ],
  }, home);
  expect(readMeetingTranscript(meeting.id, home)?.segments[0].text).toContain("Xin");
  const rendered = readFileSync(join(meetingDir(meeting.id, home), "transcript.md"), "utf8");
  expect(rendered).toContain("[00:00:01.234] **You:** Xin chao");
  // A doubted word is marked where it was said, and the stored text is left untouched.
  expect(rendered).toContain("chay ?migraine? truoc");
  expect(rendered).toContain("Do not quote them as exact wording");
  expect(readMeetingTranscript(meeting.id, home)?.segments[1].text).toBe("chay migraine truoc");
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
  const pageHtml = await page.text();
  expect(pageHtml).toContain("video không được đọc, gửi hoặc ghi xuống đĩa");
  // The pet is one movable node: everything live sits inside #pet so moving it into the
  // Document Picture-in-Picture window carries its event handlers with it. Verified in a real
  // browser - see docs/process/MEETINGS.md, "Pet window".
  const pet = pageHtml.slice(pageHtml.indexOf('id="pet"'), pageHtml.indexOf('id="petBtn"'));
  for (const id of ["dot", "status", "timer", "micLevel", "sysLevel", "livePanel", "start", "stop"]) {
    expect(pet).toContain(`id="${id}"`);
  }
  // The pet button itself stays on the page, or closing the pet would take its own control with it.
  expect(pet).not.toContain('id="petBtn"');
  expect(pageHtml).toContain("documentPictureInPicture.requestWindow");
  // Live rows are looked up ONCE. A fresh document.getElementById returns null after the node moves,
  // which silently killed the live transcript the moment the pet opened.
  expect(pageHtml).toContain("const livePanel=document.getElementById('livePanel')");
  expect(pageHtml.match(/document\.getElementById\('livePanel'\)/g)?.length).toBe(1);
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

test("live transcript runs during capture and the agent can read it mid-meeting", async () => {
  const home = tempHome();
  const decoded: number[] = [];
  let opened = "";
  // Go through startBrowserMeeting so the session registers as the active one the tools inspect.
  const session = await startBrowserMeeting({
    home,
    title: "Live test",
    openUrl: (value) => { opened = value; },
    liveIntervalMs: 10,
    liveTranscriberFactory: (context) => new LiveMeetingTranscriber({
      ...context,
      windowMs: 4_000,
      minWindowMs: 1_000,
      transcribeWindow: async (window) => {
        decoded.push(window.offsetMs);
        return [{ id: "w", startMs: 0, endMs: 800, speaker: "Meeting audio", source: "system", text: "chốt thứ sáu" }];
      },
    }),
  });
  const url = new URL(opened);

  const recording = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://${url.host}/bridge`, { headers: { origin: url.origin } } as any);
    const timer = setTimeout(() => reject(new Error("meeting websocket timeout")), 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: url.hash.slice(1) }));
    socket.onerror = () => reject(new Error("meeting websocket failed"));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") socket.send(JSON.stringify({ type: "begin", consent: true, sampleRate: 16_000, sources: ["system"] }));
      if (message.type === "recording") {
        socket.send(Buffer.alloc(16_000 * 2 * 2 * 2)); // 2 seconds, enough for one window
        clearTimeout(timer);
        resolve();
      }
    };
  });
  await recording;

  // The loop is interval-driven; wait for it to pick the new audio up.
  for (let waited = 0; waited < 2_000 && !session.liveSegments().length; waited += 25) await Bun.sleep(25);
  expect(decoded.length).toBeGreaterThan(0);
  expect(session.liveSegments().map((s) => s.text)).toContain("chốt thứ sáu");

  // Mid-meeting the agent reads provisional text without stopping the recording.
  const tools = createMeetingTools(home);
  const live = JSON.parse(await tools.call("mcp__neko_meeting__inspect", { operation: "live" }));
  expect(live.state).toBe("recording");
  expect(live.segments.map((s: any) => s.text)).toContain("chốt thứ sáu");
  expect(live.live.note).toContain("Provisional");

  const result = await session.stop("test complete");
  expect(result?.state).toBe("recorded");
  // Live text is provisional; the finalized WAV is still the canonical evidence.
  expect(existsSync(join(meetingDir(result!.id, home), "audio.wav"))).toBe(true);
});

test("a quiet room is proposed as ended, never stopped, and speech resets it", async () => {
  const home = tempHome();
  let clock = 1_000_000;
  const notices: string[] = [];
  let opened = "";
  const session = await startBrowserMeeting({
    home,
    openUrl: (value) => { opened = value; },
    now: () => clock,
    quietProposalMs: 60_000,
    onEvent: (event) => { if (event.type === "notice" && event.message) notices.push(event.message); },
  });
  const url = new URL(opened);
  const socket = new WebSocket(`ws://${url.host}/bridge`, { headers: { origin: url.origin } } as any);
  const recording = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("meeting websocket timeout")), 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: url.hash.slice(1) }));
    socket.onerror = () => reject(new Error("meeting websocket failed"));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") socket.send(JSON.stringify({ type: "begin", consent: true, sampleRate: 16_000, sources: ["system"] }));
      if (message.type === "recording") { clearTimeout(timer); resolve(); }
    };
  });
  await recording;

  // Real speech: a loud frame keeps the meeting alive.
  const loud = Buffer.alloc(3_200);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(12_000, i);
  socket.send(loud);
  await Bun.sleep(60);
  expect(session.quietMs()).toBe(0);

  // Silence past the threshold: Neko says so exactly once and keeps recording.
  const quiet = Buffer.alloc(3_200);
  clock += 61_000;
  socket.send(quiet);
  await Bun.sleep(60);
  socket.send(quiet);
  await Bun.sleep(60);
  expect(notices.filter((n) => n.includes("may have ended")).length).toBe(1);
  expect(session.snapshot().state).toBe("recording"); // proposed, not acted on

  // Someone speaks again: the proposal re-arms rather than latching.
  socket.send(loud);
  await Bun.sleep(60);
  expect(session.quietMs()).toBe(0);
  clock += 61_000;
  socket.send(quiet);
  await Bun.sleep(60);
  expect(notices.filter((n) => n.includes("may have ended")).length).toBe(2);

  socket.close();
  await session.stop("test complete");
});

test("a loud but wordless room is reported as quiet, because the transcript decides, not energy", async () => {
  // The failure an energy threshold cannot see: a fan, a keyboard, or a muted video keeps the signal
  // loud while nobody is speaking. With the transcriber attached, an ASR model decides what speech is.
  const home = tempHome();
  const notices: string[] = [];
  let clock = Date.parse("2026-07-26T09:00:00.000Z");
  let live!: LiveMeetingTranscriber;
  let opened!: string;
  const session = await startBrowserMeeting({
    home,
    openUrl: (value) => { opened = value; },
    now: () => clock,
    liveIntervalMs: 10,
    quietProposalMs: 60_000,
    onEvent: (event) => { if (event.type === "notice" && event.message) notices.push(event.message); },
    liveTranscriberFactory: (context) => (live = new LiveMeetingTranscriber({
      ...context,
      windowMs: 4_000,
      minWindowMs: 1_000,
      // Loud audio, but the decoder finds words only in the first window: after that the room is noisy
      // and wordless, which is exactly what an energy threshold calls "still going".
      transcribeWindow: async (window) => (window.offsetMs === 0
        ? [{ id: "w", startMs: 0, endMs: 900, speaker: "Meeting audio", source: "system", text: "chốt thứ sáu" }]
        : []),
    })),
  });
  const url = new URL(opened);

  const socket = new WebSocket(`ws://${url.host}/bridge`, { headers: { origin: url.origin } } as any);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("meeting websocket timeout")), 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: url.hash.slice(1) }));
    socket.onerror = () => reject(new Error("meeting websocket failed"));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") socket.send(JSON.stringify({ type: "begin", consent: true, sampleRate: 16_000, sources: ["system"] }));
      if (message.type === "recording") { clearTimeout(timer); resolve(); }
    };
  });

  // 8 s of continuously LOUD audio - energy would never call this quiet. Sent one second at a time,
  // as the capture bridge does, because a single frame that large is over the packet cap.
  const second = Buffer.alloc(16_000 * 2 * 2);
  for (let i = 0; i < second.length; i += 2) second.writeInt16LE(12_000, i);
  for (let n = 0; n < 8; n++) { socket.send(second); await Bun.sleep(10); }
  for (let waited = 0; waited < 3_000 && !session.liveSegments().length; waited += 25) await Bun.sleep(25);
  await live.drain();

  expect(session.quietSource()).toBe("transcript");
  // Speech ended at 900 ms; the decoder has since worked through several more seconds of noise.
  const quiet = session.quietMs()!;
  expect(quiet).toBeGreaterThan(2_000);
  expect(quiet).toBe(live.snapshot().decodedMs - 900);
  // The committed point only moves when a whole window turns out empty, so it lags and jumps - which is
  // why silence is timed against what the decoder examined, not against what it committed.
  expect(live.snapshot().processedMs).toBeLessThanOrEqual(live.snapshot().decodedMs);
  // A few seconds of quiet is not a finished meeting: nothing is proposed below the threshold.
  expect(notices.filter((n) => n.includes("may have ended"))).toEqual([]);
  socket.close();
  await session.stop("test complete");
});

test("capture still records when no live engine is available", async () => {
  const home = tempHome();
  const session = new BrowserMeetingSession({
    home,
    openUrl: () => {},
    liveTranscriberFactory: () => null, // pack not installed
  });
  const started = await session.start();
  const url = new URL(started.url);
  const done = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://${url.host}/bridge`, { headers: { origin: url.origin } } as any);
    const timer = setTimeout(() => reject(new Error("meeting websocket timeout")), 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: url.hash.slice(1) }));
    socket.onerror = () => reject(new Error("meeting websocket failed"));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") socket.send(JSON.stringify({ type: "begin", consent: true, sampleRate: 16_000, sources: ["system"] }));
      if (message.type === "recording") {
        socket.send(Buffer.alloc(16_000 * 2 * 2 / 10));
        socket.send(JSON.stringify({ type: "stop" }));
      }
      if (message.type === "stop") { clearTimeout(timer); resolve(); }
    };
  });
  const result = await session.waitUntilStopped();
  await done;
  expect(result?.state).toBe("recorded");
  expect(session.liveSegments()).toEqual([]);
  expect(session.liveSnapshot()).toBe(null);
});

test("a consent-page launch failure tears down the loopback owner and incomplete manifest", async () => {
  const home = tempHome();
  await expect(startBrowserMeeting({ home, openUrl: () => { throw new Error("fixture browser failure"); } })).rejects.toThrow("fixture browser failure");
  expect(activeBrowserMeeting()).toBeNull();
  expect(listMeetings(home)).toEqual([]);
});

test("engine words become segments at the model's own boundaries, and the locale tag never leaks", () => {
  const transcript = parseMeetingTranscript("mtg_20260715T120000_abcdef", JSON.stringify({
    text: "ignored",
    frame_sec: 0.08,
    words: [
      { w: "Chot", start: 0.0, end: 0.4, conf: 0.9 },
      { w: "ngay", start: 0.4, end: 0.8, conf: 0.8 },
      { w: "<vi-VN>", start: 1.0, end: 1.08, conf: 0.99 },
      { w: "thu", start: 1.2, end: 1.4, conf: 1 },
      { w: "Sau.", start: 1.4, end: 1.6, conf: 1 },
      { w: "Nam", start: 4.0, end: 4.3, conf: 1 },
      // Real audio glued the unknown-token marker onto a word: "Thu hai<unk> Nam se phu trach".
      { w: "hai<unk>", start: 4.3, end: 4.5, conf: 0.4 },
    ],
  }), { language: "vi-VN", model: "fixture", source: "system" });
  expect(transcript.segments.map((segment) => segment.text)).toEqual(["Chot ngay", "thu Sau.", "Nam hai"]);
  expect(transcript.segments.every((segment) => segment.speaker === "Meeting audio" && segment.source === "system")).toBe(true);
  expect(transcript.segments[0].confidence).toBeCloseTo(0.85);
  expect(transcript.segments[2].startMs).toBe(4_000);
  // The engine's own posterior marks what it doubted; in Vietnamese meetings that is almost always a
  // borrowed English term. Nothing is rewritten - the doubt is recorded next to the word.
  expect(transcript.segments[0].uncertain).toBeUndefined();
  expect(transcript.segments[2].uncertain).toEqual(["hai"]);
  expect(JSON.stringify(transcript)).not.toContain("vi-VN>");
  expect(() => parseMeetingTranscript("m", "{}", { language: "vi-VN", model: "f" })).toThrow("missing words");
});

test("a Vietnamese meeting does not get CJK hallucinations, but a confident foreign name survives", () => {
  // From a real recording: over the near-silent opening the model emitted CJK characters at confidence
  // 0.14 and 0.20. The --lang flag is inert, so requested-script is the only handle we have - and it is
  // a fact we hold, not a guess.
  const transcript = parseMeetingTranscript("m", JSON.stringify({
    words: [
      { w: "啊,", start: 5.8, end: 6.0, conf: 0.141 },
      { w: "ग", start: 8.3, end: 8.5, conf: 0.204 },   // Devanagari, from the same recording
      { w: "hôm", start: 15.4, end: 15.6, conf: 0.798 },
      { w: "nay", start: 15.6, end: 15.8, conf: 1 },
      { w: "小米", start: 16.0, end: 16.4, conf: 0.97 }, // said clearly: kept
      { w: "2026,", start: 16.6, end: 16.9, conf: 0.3 }, // digits are not a script: kept
    ],
  }), { language: "vi-VN", model: "fixture", source: "microphone" });
  expect(transcript.segments.map((s) => s.text)).toEqual(["hôm nay 小米 2026,"]);
  expect(transcript.droppedOutOfScript).toEqual(["啊,", "ग"]);

  // Ask for a CJK language and nothing is dropped: the check is about the language requested.
  const japanese = parseMeetingTranscript("m", JSON.stringify({
    words: [{ w: "啊,", start: 0, end: 0.2, conf: 0.141 }],
  }), { language: "ja-JP", model: "fixture", source: "microphone" });
  expect(japanese.segments.map((s) => s.text)).toEqual(["啊,"]);
  expect(japanese.droppedOutOfScript).toBeUndefined();
});

test("only the speech is decoded, and its words land back in meeting time", async () => {
  const home = tempHome();
  const meeting = createMeeting("VAD test", home);
  const raw = join(meetingDir(meeting.id, home), ".capture.pcm");
  writeFileSync(raw, Buffer.alloc(16_000 * 4 * 30)); // 30 s, stereo
  const audio = await finalizeMeetingWav(meeting.id, raw, 16_000, 2, home);
  meeting.state = "recorded";
  meeting.capture = {
    kind: "browser-display-media", startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(),
    sampleRate: 16_000, channels: 2, sources: ["system"], videoStored: false,
    audioFile: "audio.wav", audioBytes: audio.audioBytes, durationMs: audio.durationMs,
  };
  saveMeeting(meeting, home);
  const transcriber = { executable: "fixture", executableSource: "managed" as const, engineVersion: "0.4.0", model: "m", modelId: "fixture", modelTier: "balanced" as const, modelSha256: "a".repeat(64) };

  const decoded: string[] = [];
  const transcript = await transcribeMeeting(meeting.id, {
    home, transcriber,
    speechRegions: [{ startMs: 5_000, endMs: 8_000 }, { startMs: 20_000, endMs: 23_000 }],
    runEngine: async (request) => {
      decoded.push(request.audio);
      // Each region is handed to the engine on its OWN timeline, starting at zero.
      return JSON.stringify({ words: [{ w: decoded.length === 1 ? "một" : "hai", start: 0.5, end: 0.9, conf: 1 }] });
    },
  });
  expect(decoded.length).toBe(2); // one decode per speech region, not one for the whole file
  expect(transcript.speechGated).toBe(true);
  // 0.5 s inside each region, shifted back to where it really happened in the meeting.
  expect(transcript.segments.map((s) => [s.text, s.startMs])).toEqual([["một", 5_500], ["hai", 20_500]]);

  // Turning the gate off decodes the whole channel once, and nothing is marked as gated.
  const again = readMeeting(meeting.id, home)!;
  again.state = "recorded";
  saveMeeting(again, home);
  decoded.length = 0;
  const ungated = await transcribeMeeting(meeting.id, {
    home, transcriber, noVad: true,
    runEngine: async () => JSON.stringify({ words: [{ w: "cả", start: 1, end: 1.4, conf: 1 }] }),
  });
  expect(decoded.length).toBe(0);
  expect(ungated.speechGated).toBeUndefined();
  expect(ungated.segments.map((s) => s.startMs)).toEqual([1_000]);
});

test("channel plan and language normalization match what the engine actually accepts", () => {
  expect(meetingChannels(2, ["microphone", "system"])).toEqual([
    { index: 0, source: "microphone" },
    { index: 1, source: "system" },
  ]);
  expect(meetingChannels(2, ["system"])).toEqual([{ index: 1, source: "system" }]);
  expect(meetingChannels(1, ["system"])).toEqual([{ index: 0, source: "system" }]);
  expect(normalizeLanguage("vi")).toBe("vi-VN");
  expect(normalizeLanguage("en")).toBe("en-US");
  expect(normalizeLanguage("vi-VN")).toBe("vi-VN");
  expect(normalizeLanguage("pt_br")).toBe("pt-BR");
  expect(normalizeLanguage("auto")).toBe("auto");
  expect(() => normalizeLanguage("vietnamese!")).toThrow("invalid transcription language");
});

test("a capture channel is deinterleaved into a mono wav the engine can open", async () => {
  const home = tempHome();
  const stereo = join(home, "stereo.wav");
  const frames = 4;
  const pcm = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    pcm.writeInt16LE(100 + frame, frame * 4);      // microphone
    pcm.writeInt16LE(-(100 + frame), frame * 4 + 2); // system
  }
  writeFileSync(stereo, Buffer.concat([wavHeader(pcm.length, 16_000, 2), pcm]));
  const mono = join(home, "mic.wav");
  await extractChannelWav(stereo, mono, 2, 0);
  const written = readFileSync(mono);
  expect(written.length).toBe(44 + frames * 2);
  expect(written.readUInt16LE(22)).toBe(1);
  expect([0, 1, 2, 3].map((frame) => written.readInt16LE(44 + frame * 2))).toEqual([100, 101, 102, 103]);
  await extractChannelWav(stereo, join(home, "sys.wav"), 2, 1);
  expect(readFileSync(join(home, "sys.wav")).readInt16LE(44)).toBe(-100);
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
    runEngine: async () => JSON.stringify({ words: [{ w: "Xin", start: 0, end: 0.05, conf: 1 }, { w: "chao", start: 0.05, end: 0.1, conf: 1 }] }),
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
    runEngine: async () => {
      engineStarted();
      await continueRun;
      return JSON.stringify({ words: [] });
    },
  });
  await started;
  await expect(transcribeMeeting(meeting.id, { home, transcriber, runEngine: async () => "{}" })).rejects.toThrow("already being transcribed");
  continueEngine();
  await first;
});

test("speaker separation labels only the meeting channel, and a failure never costs the transcript", async () => {
  const home = tempHome();
  const meeting = createMeeting("Diarize test", home);
  const raw = join(meetingDir(meeting.id, home), ".capture.pcm");
  writeFileSync(raw, Buffer.alloc(16_000 * 4 * 10)); // 10 s, stereo
  const audio = await finalizeMeetingWav(meeting.id, raw, 16_000, 2, home);
  meeting.state = "recorded";
  meeting.capture = {
    kind: "browser-display-media", startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(),
    sampleRate: 16_000, channels: 2, sources: ["microphone", "system"], videoStored: false,
    audioFile: "audio.wav", audioBytes: audio.audioBytes, durationMs: audio.durationMs,
  };
  saveMeeting(meeting, home);
  const transcriber = { executable: "fixture", executableSource: "managed" as const, engineVersion: "0.4.0", model: "m", modelId: "fixture", modelTier: "balanced" as const, modelSha256: "a".repeat(64) };
  const words = (source: string) => JSON.stringify({ words: [
    { w: source === "microphone" ? "mình" : "chốt", start: 1, end: 1.4, conf: 1 },
    { w: source === "microphone" ? "đồng-ý" : "thứ-sáu", start: 5, end: 5.4, conf: 1 },
  ] });

  const transcript = await transcribeMeeting(meeting.id, {
    home, transcriber, diarize: true,
    runEngine: async (request) => words(request.source),
    diarizeMono: async () => [
      { cluster: "speaker_01", startMs: 900, endMs: 2_000 },
      { cluster: "speaker_00", startMs: 4_800, endMs: 6_000 },
    ],
  });
  const mic = transcript.segments.filter((s) => s.source === "microphone");
  const system = transcript.segments.filter((s) => s.source === "system");
  // The microphone is KNOWN to be the user, so a clustering guess never touches it.
  expect(mic.every((s) => s.speaker === "You")).toBe(true);
  // The meeting channel is numbered by who spoke first, never named.
  expect(system.map((s) => s.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
  expect(transcript.voices).toBe(2);

  // A diarizer that explodes must cost the labels, not the meeting.
  const notes: string[] = [];
  const readMeetingAgain = readMeeting(meeting.id, home)!;
  readMeetingAgain.state = "recorded";
  saveMeeting(readMeetingAgain, home);
  const fallback = await transcribeMeeting(meeting.id, {
    home, transcriber, diarize: true,
    notify: (m) => notes.push(m),
    runEngine: async (request) => words(request.source),
    diarizeMono: async () => { throw new Error("onnx exploded"); },
  });
  expect(fallback.segments.length).toBe(4);
  expect(fallback.segments.filter((s) => s.source === "system").every((s) => s.speaker === "Meeting audio")).toBe(true);
  expect(fallback.voices).toBeUndefined();
  expect(notes.some((n) => n.includes("Speaker separation failed"))).toBe(true);
});

describe("meeting support and tools", () => {
  test("target matrix is explicit and unsupported platforms never receive a guessed binary", () => {
    expect(meetingSupportTarget("win32", "x64")).toEqual({ assetSuffix: "bin-win-cpu-x64.zip", executableName: "parakeet-cli.exe" });
    expect(meetingSupportTarget("linux", "arm64")?.assetSuffix).toContain("arm64");
    expect(meetingSupportTarget("darwin", "arm64")?.assetSuffix).toContain("metal");
    expect(meetingSupportTarget("win32", "arm64")).toBeNull();
    expect(meetingSupportTarget("freebsd" as NodeJS.Platform, "x64")).toBeNull();
    expect(() => validateMeetingArchiveEntries(["engine/parakeet-cli"], ["-rwxr-xr-x engine/parakeet-cli"])).not.toThrow();
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
    writeFileSync(join(root, "engine", "parakeet-cli.exe"), engine);
    writeFileSync(join(root, "support-pack.json"), JSON.stringify({
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      engine: {
        version: "0.4.0", releaseTag: "v0.4.0", assetName: "fixture.zip",
        assetDigest: `sha256:${engineDigest}`, archiveBytes: engine.length,
        executable: "engine/parakeet-cli.exe", executableBytes: engine.length,
        executableSha256: engineDigest, sourceUrl: "https://github.com/mudler/parakeet.cpp/releases/tag/v0.4.0", license: "MIT",
      },
      model: { tier: "quick", id: "fixture", file: "models/fixture.bin", bytes: model.length, sha256: digest, sourceUrl: "https://huggingface.co/mudler/parakeet-cpp-gguf" },
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
