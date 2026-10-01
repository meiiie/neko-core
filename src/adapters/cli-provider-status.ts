import type { ProviderAttemptEvent, ProviderFailureCode } from "../core/ports.ts";

const reasons = {
  transport_unavailable: "connection unavailable",
  rate_limited: "rate limited",
  server_error: "server error",
  stream_interrupted: "stream interrupted",
  stream_overloaded: "stream overloaded",
  stream_timeout: "stream timed out",
} satisfies Record<ProviderFailureCode, string>;

/** Render only allowlisted lifecycle metadata, never provider text, URLs or credentials. */
export function cliProviderRetryStatus(event: ProviderAttemptEvent): string | null {
  if (event.type !== "retry_scheduled") return null;
  const reason = event.reason && Object.hasOwn(reasons, event.reason) ? reasons[event.reason] : "request interrupted";
  const attempt = Number.isSafeInteger(event.attempt) && event.attempt > 0 ? ` after attempt ${event.attempt}` : "";
  const delay = event.delayMs !== undefined && Number.isFinite(event.delayMs) && event.delayMs >= 0
    ? ` in ${Math.ceil(event.delayMs / 1000)}s` : "";
  return `[provider: ${reason}${attempt}; retrying${delay}]`;
}
