/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- This module validates untrusted JSON at the HTTP boundary; unknown inputs are narrowed before use. */
export const FEEDBACK_CATEGORIES = ["provider", "login", "model-picker", "terminal", "other"] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];
export const FEEDBACK_RECIPIENT = "meiiiekhp888@gmail.com";
export const FEEDBACK_MAX_LOG_BYTES = 512 * 1024;
export const FEEDBACK_MAX_REPORT_BYTES = 600 * 1024;
export const FEEDBACK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface FeedbackLogLine { kind: string; text: string }
export interface FeedbackReport {
  schemaVersion: "neko-feedback.v1";
  reportId: string;
  createdAt: string;
  category: FeedbackCategory;
  recipient: string;
  notes: string;
  diagnostics: { version: string; platform: string; arch: string; provider: string; model: string };
  sessionLog?: FeedbackLogLine[];
  omittedLines?: number;
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:/+-]{1,128}$/.test(value);

export function isFeedbackAcknowledgement(value: unknown): value is { state: string } {
  return plain(value) && keys(value, ["state"]) && safeText(value.state, 64);
}

export function isFeedbackReport(value: unknown): value is FeedbackReport {
  if (!plain(value) || !keys(value, ["schemaVersion", "reportId", "createdAt", "category", "recipient", "notes", "diagnostics", "sessionLog", "omittedLines"])) return false;
  if (value.schemaVersion !== "neko-feedback.v1" || typeof value.reportId !== "string" || !FEEDBACK_ID.test(value.reportId)
    || typeof value.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))
    || !FEEDBACK_CATEGORIES.some((category) => category === value.category) || value.recipient !== FEEDBACK_RECIPIENT || !safeText(value.notes, 4000)) return false;
  const diagnostics = value.diagnostics;
  const fields = ["version", "platform", "arch", "provider", "model"];
  if (!plain(diagnostics) || !keys(diagnostics, fields) || !fields.every((key) => identifier(diagnostics[key]))) return false;
  if (value.sessionLog !== undefined) {
    if (!Array.isArray(value.sessionLog) || value.sessionLog.length > 32768 || !Number.isSafeInteger(value.omittedLines) || Number(value.omittedLines) < 0) return false;
    let bytes = 0;
    for (const line of value.sessionLog) {
      if (!plain(line) || !keys(line, ["kind", "text"]) || !["user", "assistant", "tool_call", "tool_result", "tool_result_full", "info", "error"].includes(String(line.kind)) || !safeText(line.text, FEEDBACK_MAX_LOG_BYTES)) return false;
      bytes += new TextEncoder().encode(JSON.stringify(line)).byteLength;
      if (bytes > FEEDBACK_MAX_LOG_BYTES) return false;
    }
  } else if (value.omittedLines !== undefined) return false;
  return true;
}

export async function readBoundedFeedbackBody(body: ReadableStream<Uint8Array> | null, maxBytes = FEEDBACK_MAX_REPORT_BYTES): Promise<string> {
  if (!body) throw new Error("Missing body");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Body too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
