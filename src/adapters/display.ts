/**
 * Display refresh-rate detection + UI-fps resolution. Terminals can't report the monitor's Hz over VT,
 * but every OS can be asked: Windows via WMI (Win32_VideoController.CurrentRefreshRate), macOS via
 * system_profiler, Linux via xrandr (X11; Wayland best-effort fails closed). Detection is ASYNC (a
 * subprocess, up to ~1s) so it never blocks startup: the result is cached for a week in ~/.neko-core
 * and the CURRENT session adapts live (scroll glide), while Ink's render cap picks it up next launch.
 *
 * Resolution order for the effective fps (comfort-first: zero config just works):
 *   NEKO_FPS env  >  config `ui_fps`  >  /fps choice (prefs)  >  detected display Hz (cached)  >  60
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { loadPrefs } from "./prefs.ts";

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // monitors rarely change; re-probe weekly
const cachePath = () => join(homeDir(), ".neko-core", ".display.json");

export const clampFps = (n: number): number => Math.min(240, Math.max(30, Math.round(n)));

// Marketing refresh rates whose real timing is fractional (NTSC-style 59.94, 119.88, 143.86...):
// Windows WMI and macOS report the FLOOR as an integer, so a 60Hz panel reads "59Hz" - technically
// true, guaranteed to confuse ("my monitor is 60Hz!"). Snap n -> n+1 only when n+1 is a known rate.
const COMMON_RATES = new Set([60, 75, 90, 100, 120, 144, 165, 240]);

/** Normalize a floor-reported fractional rate (59 -> 60, 119 -> 120, 143 -> 144); exact reads pass through. */
export function normalizeHz(hz: number): number {
  return COMMON_RATES.has(hz + 1) ? hz + 1 : hz;
}

/** The cached detected refresh rate, or null (never detected / stale / unparseable). Sync + cheap. */
export function cachedRefreshRate(now = Date.now()): number | null {
  try {
    if (!existsSync(cachePath())) return null;
    const c = JSON.parse(readFileSync(cachePath(), "utf-8"));
    if (typeof c.hz !== "number" || typeof c.at !== "number") return null;
    if (now - c.at > CACHE_TTL_MS) return null;
    return c.hz >= 30 && c.hz <= 360 ? c.hz : null;
  } catch {
    return null;
  }
}

function saveCache(hz: number): void {
  try {
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true });
    atomicWriteFileSync(cachePath(), JSON.stringify({ hz, at: Date.now() }));
  } catch { /* best-effort */ }
}

/** Run a probe command, resolve its stdout (or null on any failure/timeout). Never throws. */
function probe(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // windowsHide: a console child (powershell) attaching to OUR console can clobber the shared console
      // title, which ConPTY syncs to the tab - wiping the branded title. Hidden = no console = no clobber.
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(null); }, timeoutMs);
      child.stdout.on("data", (d) => { out += String(d); });
      child.on("close", () => { clearTimeout(timer); resolve(out); });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

/** Detect the display's refresh rate (async, subprocess, cached on success). Null when undetectable. */
export async function detectRefreshRate(): Promise<number | null> {
  let hz: number | null = null;
  if (process.platform === "win32") {
    const out = await probe("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_VideoController | Where-Object {$_.CurrentRefreshRate -gt 0} | Select-Object -First 1 -ExpandProperty CurrentRefreshRate)"]);
    const n = out ? parseInt(out.trim(), 10) : NaN;
    if (Number.isFinite(n)) hz = n;
  } else if (process.platform === "darwin") {
    const out = await probe("system_profiler", ["SPDisplaysDataType"]);
    const m = out && /(\d+)\s*Hz/.exec(out);
    if (m) hz = parseInt(m[1], 10);
  } else {
    const out = await probe("xrandr", ["--current"]);
    // The active mode line carries a '*' on the current rate, e.g. "1920x1080 144.00*+ 60.00".
    const m = out && /(\d+(?:\.\d+)?)\s*\*/.exec(out);
    if (m) hz = Math.round(parseFloat(m[1]));
  }
  if (hz == null || hz < 30 || hz > 360) return null;
  hz = normalizeHz(hz);
  saveCache(hz);
  return hz;
}

export interface UiFpsResolution { fps: number; mode: "fixed" | "auto"; detected: number | null; source: string }

/** Resolve the effective UI fps. `configFps` = the config file's explicit ui_fps (null when unset). */
export function resolveUiFps(configFps: number | null): UiFpsResolution {
  const detected = cachedRefreshRate();
  const env = Number(process.env.NEKO_FPS);
  if (Number.isFinite(env) && env > 0) return { fps: clampFps(env), mode: "fixed", detected, source: "NEKO_FPS" };
  if (configFps != null) return { fps: clampFps(configFps), mode: "fixed", detected, source: "config ui_fps" };
  const pref = loadPrefs().uiFps;
  if (typeof pref === "number") return { fps: clampFps(pref), mode: "fixed", detected, source: "/fps" };
  return { fps: clampFps(detected ?? 60), mode: "auto", detected, source: detected ? "display (auto)" : "default" };
}
