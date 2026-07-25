import { expect, test } from "bun:test";

import { describeAudioActivity, detectMicrophoneUsers } from "../src/adapters/audio-activity.ts";

const ok = (stdout: string) => () => ({ status: 0, stdout });

test("Windows consent-store entries become readable names, and only known clients are labelled", () => {
  const report = detectMicrophoneUsers("win32", ok([
    "C:#Program Files#Google#Chrome#Application#chrome.exe",
    "MSTeams_8wekyb3d8bbwe",
    "E:#Steam#steamapps#common#Liar's Bar#Liar's Bar.exe",
    "",
  ].join("\r\n")));
  expect(report.supported).toBe(true);
  expect(report.active.map((entry) => entry.name)).toEqual([
    "chrome.exe - a browser tab (Meet, Teams web, Zoom web...)",
    "MSTeams_8wekyb3d8bbwe - Microsoft Teams",
    "Liar's Bar.exe",
  ]);
  // A game holding the microphone is reported but never called a meeting.
  expect(report.active.map((entry) => entry.meetingApp)).toEqual([true, true, false]);
  expect(report.detail).toContain("Microsoft Teams");
  expect(report.detail).not.toContain("Liar's Bar");
});

test("an unlabelled application is still reported, with the choice left to the user", () => {
  const report = detectMicrophoneUsers("win32", ok("C:#Apps#SomeInternalTool.exe"));
  expect(report.active).toEqual([{ id: "C:#Apps#SomeInternalTool.exe", name: "SomeInternalTool.exe", meetingApp: false }]);
  expect(report.detail).toContain("choose the meeting window yourself");
});

test("Linux reads the streams PulseAudio already lists, and duplicates collapse", () => {
  const report = detectMicrophoneUsers("linux", ok(`
Source Output #12
	application.name = "Chromium"
Source Output #13
	application.name = "Chromium"
Source Output #14
	application.name = "ZOOM VoiceEngine"
`));
  expect(report.active.map((entry) => entry.id)).toEqual(["Chromium", "ZOOM VoiceEngine"]);
  expect(report.active.map((entry) => entry.name)).toEqual([
    "Chromium - a browser tab (Meet, Teams web, Zoom web...)",
    "ZOOM VoiceEngine - Zoom",
  ]);
  expect(report.active.every((entry) => entry.meetingApp)).toBe(true);
});

test("nothing is claimed when the platform or the command cannot answer", () => {
  expect(detectMicrophoneUsers("darwin").supported).toBe(false);
  expect(detectMicrophoneUsers("darwin").active).toEqual([]);
  const failed = detectMicrophoneUsers("win32", () => ({ status: 1, stdout: "" }));
  expect(failed.supported).toBe(false);
  expect(failed.active).toEqual([]);
  const idle = detectMicrophoneUsers("win32", ok(""));
  expect(idle.supported).toBe(true);
  expect(idle.detail).toContain("No application is using the microphone");
});

test("a path separator survives the registry's escaping", () => {
  expect(describeAudioActivity("C:#Program Files#Zoom#bin#Zoom.exe")).toEqual({
    id: "C:#Program Files#Zoom#bin#Zoom.exe",
    name: "Zoom.exe - Zoom",
    meetingApp: true,
  });
});
