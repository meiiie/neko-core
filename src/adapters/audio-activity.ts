/**
 * Which application is in a call right now.
 *
 * The user asked Neko to work out "which web or app needs listening to". Neko cannot pick the capture
 * source for them - `getDisplayMedia` deliberately puts that choice in the browser's own picker, and
 * that consent boundary is the point. What Neko can honestly do is name the applications that are
 * *currently holding the microphone*, so the user knows which window to choose and does not share the
 * wrong one or forget "Share audio", which is the most common way a meeting recording comes out silent.
 *
 * The microphone, not the speaker, is the signal: playing audio means a video is running, while holding
 * the microphone open means somebody is in a conversation.
 *
 * Every backend is a plain read of a facility the OS already exposes to the user - no polling of process
 * memory, no injection, no elevation. An unsupported platform says so rather than guessing.
 */
import { spawnSync } from "node:child_process";

export interface AudioActivity {
  /** What the OS reports, as the OS names it. */
  id: string;
  /** A readable name, and `meetingApp` when the identifier is a well-known conferencing client. */
  name: string;
  meetingApp: boolean;
}

export interface AudioActivityReport {
  supported: boolean;
  detail: string;
  active: AudioActivity[];
}

/**
 * Identifiers of well-known conferencing clients. This list only LABELS what the OS already reported -
 * an unknown application is still listed, just without the label - so a stale entry degrades the hint
 * rather than hiding a real meeting.
 */
const MEETING_APPS: Array<[RegExp, string]> = [
  [/\bzoom\b/i, "Zoom"],
  [/msteams|teams/i, "Microsoft Teams"],
  [/webex/i, "Webex"],
  [/discord/i, "Discord"],
  [/slack/i, "Slack"],
  [/skype/i, "Skype"],
  [/zalo/i, "Zalo"],
  [/whatsapp/i, "WhatsApp"],
  [/telegram/i, "Telegram"],
  [/\bchrome\b|chromium|msedge|firefox|brave|\bopera\b/i, "a browser tab (Meet, Teams web, Zoom web...)"],
];

export function describeAudioActivity(id: string): AudioActivity {
  const raw = id.replace(/#/g, "\\");
  // These ids are WINDOWS registry paths whatever OS this code runs on, so the last segment is cut by
  // hand: POSIX basename() does not treat `\` as a separator and returned the whole path on Linux/macOS
  // (the Unix-only CI failure of 2026-07-27 - tests pass on Windows, where basename knows both slashes).
  const label = raw.split(/[\\/]/).pop() || raw;
  const known = MEETING_APPS.find(([pattern]) => pattern.test(raw));
  return {
    id,
    name: known ? `${label} - ${known[1]}` : label,
    meetingApp: Boolean(known),
  };
}

export function detectMicrophoneUsers(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => { status: number | null; stdout: string } = defaultRun,
): AudioActivityReport {
  if (platform === "win32") return fromWindows(run);
  if (platform === "linux") return fromPulse(run);
  return {
    supported: false,
    detail: "Neko cannot tell which app is using the microphone on this platform; pick the meeting window yourself in the browser's share dialog.",
    active: [],
  };
}

/**
 * Windows records microphone usage in the Capability Access Manager consent store - the same data the
 * Settings app shows under "recent activity". `LastUsedTimeStop == 0` means the app has the microphone
 * open right now. Read-only, per-user, no elevation.
 */
function fromWindows(run: (command: string, args: string[]) => { status: number | null; stdout: string }): AudioActivityReport {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone')",
    "foreach($r in $roots){ if(Test-Path $r){ Get-ChildItem -Path $r -Recurse | ForEach-Object {",
    "  $stop=(Get-ItemProperty -Path $_.PSPath -Name LastUsedTimeStop).LastUsedTimeStop",
    "  if($stop -eq 0){ $_.PSChildName } } } }",
  ].join("; ");
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.status !== 0) {
    return { supported: false, detail: "Could not read the Windows microphone activity list.", active: [] };
  }
  return report(parseLines(result.stdout));
}

/** PulseAudio/PipeWire already lists every stream recording from a source, with its application name. */
function fromPulse(run: (command: string, args: string[]) => { status: number | null; stdout: string }): AudioActivityReport {
  const result = run("pactl", ["list", "source-outputs"]);
  if (result.status !== 0) {
    return { supported: false, detail: "Could not read microphone activity; `pactl` is not available.", active: [] };
  }
  const names = [...result.stdout.matchAll(/application\.name = "([^"]+)"/g)].map((match) => match[1]);
  return report(names);
}

function report(ids: string[]): AudioActivityReport {
  const active = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].map(describeAudioActivity);
  const meetings = active.filter((entry) => entry.meetingApp);
  if (!active.length) {
    return { supported: true, detail: "No application is using the microphone right now.", active };
  }
  return {
    supported: true,
    detail: meetings.length
      ? `Using the microphone right now: ${meetings.map((entry) => entry.name).join(", ")}. That is probably the window to share - and remember to enable Share audio.`
      : `Using the microphone right now: ${active.map((entry) => entry.name).join(", ")}. None is a known conferencing app, so choose the meeting window yourself.`,
    active,
  };
}

function parseLines(stdout: string) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40);
}

function defaultRun(command: string, args: string[]) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
    return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
}
