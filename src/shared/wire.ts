/**
 * The JSON wire domain. Provider payloads, MCP arguments, session files, and config overlays all
 * cross process/network boundaries as JSON; after parsing, their honest static type is `JsonValue`,
 * not `any`/`unknown`. Downstream code narrows with the guards below (raw `typeof` checks stay
 * inside this module's type predicates, the one place representation checks belong).
 *
 * Guards deliberately take `any`: a representation check is meaningful for whatever a caller holds,
 * and the type predicate - not the parameter - carries the contract on the narrow side.
 *
 * This module is dependency-free and imports nothing from core/adapters: every layer may use it.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
/** Pre-serialization wire values: JSON plus the `undefined` that optional fields carry until
 * JSON.stringify drops them. Use for constructing requests; use JsonValue for parsed results. */
export type WireValue = JsonValue | undefined;
export type WireObject = { [key: string]: WireValue };

export function isJsonObject(value: any): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: any): value is JsonArray {
  return Array.isArray(value);
}

export function isText(value: any): value is string {
  return typeof value === "string";
}

/** A finite JSON number (NaN/Infinity cannot appear in wire data and must not leak into arithmetic). */
export function isJsonNumber(value: any): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Any non-null object, arrays included — for walkers that legitimately treat arrays as containers. */
export function isObjectValue(value: any): value is object {
  return typeof value === "object" && value !== null;
}

export function isBool(value: any): value is boolean {
  return typeof value === "boolean";
}

/** Text content of a wire value, or null for structured values (never coerces objects to "[object Object]"). */
export function jsonText(value: any): string | null {
  return isText(value) ? value : null;
}

/** Coercing read for wire fields whose consumers treat everything as display text. */
export function wireString(value: any): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Finite number or null — guards NaN/Infinity that would poison arithmetic downstream. */
export function wireNumber(value: any): number | null {
  return isJsonNumber(value) ? value : null;
}

/** Narrow a wire record into a string map (drops non-string values rather than coercing them). */
export function toStringMap(value: any) {
  if (!isJsonObject(value)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const text = jsonText(value[key]);
    if (text !== null) out[key] = text;
  }
  return out;
}
