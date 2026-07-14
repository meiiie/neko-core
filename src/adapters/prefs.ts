/**
 * Tiny persistent user preferences (~/.neko-core/prefs.json). Separate from config, which is a LAYERED,
 * read-at-startup overlay (built-in -> profile preset -> ~/.neko-core -> ./.neko-core -> env); this is the small
 * WRITABLE "remember my choice" store the REPL updates at runtime - e.g. the resume-from-summary opt-out.
 * Best-effort: a missing/corrupt file reads as empty defaults, and a failed write is swallowed (a lost
 * preference is a minor annoyance, never a crash or data loss).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";

export interface Prefs {
  /** "Don't ask again" on the resume-from-summary prompt: resume large sessions in full without asking. */
  resumeAlwaysFull?: boolean;
  /** /fps choice: a fixed rate, or "auto" (follow the detected display refresh rate). Unset = auto. */
  uiFps?: number | "auto";
  /** One-time progressive-disclosure hint for optional signed-in-tab browser control. */
  browserHintSeen?: boolean;
}

function prefsPath(): string {
  return join(homeDir(), ".neko-core", "prefs.json");
}

export function loadPrefs(): Prefs {
  try {
    if (!existsSync(prefsPath())) return {};
    const p = JSON.parse(readFileSync(prefsPath(), "utf-8"));
    return p && typeof p === "object" ? (p as Prefs) : {};
  } catch {
    return {};
  }
}

/** Merge a patch into the stored prefs (read-modify-write, atomic). Silently no-ops on any failure. */
export function savePrefs(patch: Partial<Prefs>): void {
  try {
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true });
    atomicWriteFileSync(prefsPath(), JSON.stringify({ ...loadPrefs(), ...patch }, null, 2));
  } catch {
    /* best-effort: a lost preference is not worth surfacing */
  }
}
