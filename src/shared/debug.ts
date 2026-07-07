/**
 * Env-gated debug logging — a single sink for the many `catch { /* skip *\/ }` blocks across the
 * codebase. Most swallowed errors are genuinely benign (a probe that failed, a file that couldn be
 * read, a hook that didn't run), but when something DOES go wrong, debugging "why did Neko silently
 * skip this?" is near-impossible without stderr visibility. `NEKO_DEBUG=1` (or `NEKO_DEBUG=tool`,
 * `NEKO_DEBUG=mcp`...) turns the relevant channel on; default is silent (today's behavior).
 *
 * Keep this dependency-free and allocation-light: in the common (silent) path, the only cost is one
 * env read at import + one Set lookup. The message arg is a function so string-building is skipped
 * entirely when the channel is off (no dead allocation).
 */
const RAW = String(process.env.NEKO_DEBUG ?? "").toLowerCase();
/** On when NEKO_DEBUG is any truthy value (1, true, yes, all, *). */
export const DEBUG_ON = /^(1|true|yes|on|all|\*)$/.test(RAW) || RAW === "";
/** A channel is on when debug is globally on, or when the channel name is listed. */
const CHANNELS = new Set(RAW.split(",").map((s) => s.trim()).filter(Boolean));
export function debug(channel: string, msg: () => string): void {
  if (!RAW) return; // not set at all -> fully silent (default)
  if (!DEBUG_ON && !CHANNELS.has(channel)) return;
  try {
    process.stderr.write(`[neko:${channel}] ${msg()}\n`);
  } catch {
    /* stderr itself unavailable (embedded?) - never let logging throw */
  }
}
/** True when a specific channel is on (for callers that build a richer log line). */
export function debugChannel(channel: string): boolean {
  if (!RAW) return false;
  return DEBUG_ON || CHANNELS.has(channel);
}

/** Safe string of any thrown value (Error -> message, else String(v)); never throws. Shared so each
 * module does not redefine its own. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "(unstringifiable)";
  }
}
