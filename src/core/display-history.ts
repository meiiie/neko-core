/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Validate the persisted reference at the storage boundary. */
/** User-visible history is evidence for clients, never provider context or execution authority. */
export type DisplayKind = "user" | "assistant" | "tool_call" | "tool_result" | "info";
export interface DisplayEntrySeed {
  kind: DisplayKind;
  text: string;
  summary?: string;
  failed?: boolean;
}
export interface DisplayEntry extends DisplayEntrySeed { id: string }
export interface DisplayHistoryRef {
  version: 1;
  scope: string;
  head: string | null;
  /** Exact working checkpoint represented by this archive, independent of client type. */
  checkpoint?: { count: number; digest: string };
}
export interface DisplayHistoryCursor {
  chunk: string;
  /** Exclusive entry index; omitted means the end of the chunk. */
  before?: number;
}
export interface DisplayHistoryPage {
  entries: DisplayEntry[];
  older: DisplayHistoryCursor | null;
}
export function validDisplayHistoryRef(value: unknown): value is DisplayHistoryRef {
  if (!value || typeof value !== "object") return false;
  // SAFETY: value is an object; every reference field is checked below.
  const ref = value as DisplayHistoryRef;
  return ref.version === 1 && typeof ref.scope === "string" && /^[a-f0-9]{64}$/.test(ref.scope)
    && (ref.head === null || (typeof ref.head === "string" && /^[a-f0-9]{64}$/.test(ref.head)))
    && (ref.checkpoint === undefined || (ref.checkpoint !== null && typeof ref.checkpoint === "object"
      && Number.isSafeInteger(ref.checkpoint.count) && ref.checkpoint.count >= 0
      && typeof ref.checkpoint.digest === "string" && /^[a-f0-9]{64}$/.test(ref.checkpoint.digest)));
}

export function validDisplayPending(value: unknown): value is DisplayEntrySeed[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  return value.every((entry) => entry && typeof entry === "object"
    && ["user", "assistant", "tool_call", "tool_result", "info"].includes(entry.kind)
    && typeof entry.text === "string" && entry.text.length <= 64 * 1024 * 1024
    && (entry.summary === undefined || typeof entry.summary === "string")
    && (entry.failed === undefined || typeof entry.failed === "boolean"));
}
