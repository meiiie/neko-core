import { createHash } from "node:crypto";
import { test, expect } from "bun:test";
import { buildNekoCompletionWav, prepareCompletionAlert } from "../src/adapters/completion-sound.ts";

test("Neko Bubble v6 is a deterministic bounded stereo WAV", () => {
  const wav = buildNekoCompletionWav();
  expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  expect(wav.subarray(8, 12).toString()).toBe("WAVE");
  expect(wav.readUInt16LE(20)).toBe(1);
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt32LE(24)).toBe(48_000);
  expect(wav.readUInt16LE(34)).toBe(16);
  expect(wav.length).toBe(44_204);
  expect(createHash("sha256").update(wav).digest("hex")).toBe("9cc4c872ab0e55f883755a6d1b73b230ac2a94f987108c7f5018fff75c104787");
});

test("Windows completion playback is prepared once and reuses the in-memory score", async () => {
  let loaded = 0;
  const played: Uint8Array[] = [];
  const alert = await prepareCompletionAlert({
    platform: "win32",
    loadWindowsSound: async () => {
      loaded++;
      return { play: (wav) => { played.push(wav); return true; } };
    },
  });
  expect(loaded).toBe(1);
  expect(alert?.()).toBe(true);
  expect(alert?.()).toBe(true);
  expect(played).toHaveLength(2);
  expect(played[0]).toBe(played[1]);
});

test("unsupported or unavailable native sound falls back without changing turn outcome", async () => {
  let loaded = false;
  expect(await prepareCompletionAlert({
    platform: "linux",
    loadWindowsSound: async () => { loaded = true; throw new Error("must not load"); },
  })).toBeUndefined();
  expect(loaded).toBe(false);
  expect(await prepareCompletionAlert({
    platform: "win32",
    loadWindowsSound: async () => { throw new Error("winmm unavailable"); },
  })).toBeUndefined();
});
