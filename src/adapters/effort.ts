/** A model may publish any effort vocabulary. These are only the common ordered tiers Neko knows
 * how to compare; unknown names still pass through unchanged and therefore need no core update. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const COMMON_EFFORTS = EFFORT_ORDER.filter((effort) => effort !== "none");

export interface EffortCapability {
  defaultEffort?: string;
  efforts?: ReadonlyArray<{ effort: string }>;
}

export function normalizeEffort(value: string): string {
  return value.trim().toLowerCase();
}

/** Clamp comparable built-in tiers to a configured endpoint ceiling. Arbitrary future/provider tiers
 * pass through so the endpoint (or its live catalog) remains authoritative. */
export function clampEffort(effort: string, ceiling: string): string {
  const requested = normalizeEffort(effort);
  const limit = normalizeEffort(ceiling);
  if (!requested || requested === "off") return "";
  if (!limit) return requested;
  const requestedIndex = EFFORT_ORDER.indexOf(requested);
  const limitIndex = EFFORT_ORDER.indexOf(limit);
  if (requestedIndex < 0 || limitIndex < 0) return requested;
  return requestedIndex > limitIndex ? limit : requested;
}

/** Per-request effort under a persistent user preference. An adaptive override may lower compute but
 * never raises it above a comparable saved tier; explicit `off` remains authoritative. */
export function requestEffort(configured: string, adaptiveOverride?: string): string {
  const preference = normalizeEffort(configured);
  if (preference === "off") return "";
  const override = normalizeEffort(adaptiveOverride ?? "");
  if (!override) return preference;
  return preference ? clampEffort(override, preference) : override;
}

/** Resolve a user preference against a model's advertised vocabulary. Exact arbitrary tiers work;
 * ordered common tiers fall back to the closest supported tier at or below the request. */
export function resolveEffort(requested: string, capability?: EffortCapability): string {
  const effort = normalizeEffort(requested);
  if (!effort || effort === "off") return effort;
  const supported = [...new Set((capability?.efforts ?? []).map((item) => normalizeEffort(item.effort)).filter(Boolean))];
  if (!supported.length || supported.includes(effort)) return effort;

  const wanted = EFFORT_ORDER.indexOf(effort);
  if (wanted >= 0) {
    const closest = supported
      .map((level) => ({ level, index: EFFORT_ORDER.indexOf(level) }))
      .filter(({ index }) => index >= 0 && index <= wanted)
      .sort((a, b) => b.index - a.index)[0]?.level;
    if (closest) return closest;
  }

  const modelDefault = normalizeEffort(capability?.defaultEffort ?? "");
  if (modelDefault && supported.includes(modelDefault)) return modelDefault;
  // Model catalogs conventionally list effort from least to most capable. With an unknown requested
  // tier and no declared default, preserve the user's quality intent by choosing the last entry.
  return supported.at(-1) ?? effort;
}

/** Picker suggestions for providers without a live model catalog. A current preference remains visible
 * even when this endpoint clamps it, so switching models never silently destroys user intent. */
export function effortSuggestions(ceiling = "", current = ""): string[] {
  const levels = COMMON_EFFORTS.filter((effort) => clampEffort(effort, ceiling) === effort);
  const selected = normalizeEffort(current);
  if (selected && selected !== "off" && !levels.includes(selected)) levels.push(selected);
  return levels;
}

/** `/effort` accepts provider-defined names while rejecting whitespace/control punctuation and typos
 * that could never be a protocol enum. */
export function isEffortName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(normalizeEffort(value));
}

/** Extract advertised enum values from a validation error such as "allowed values: 'low', 'high'".
 * Restrict extraction to the validation clause so unrelated JSON fields/model ids are not mistaken for
 * capabilities. */
export function effortLevelsFromError(body: string): string[] {
  const marker = /(?:allowed(?: values?| levels?)?|valid(?: values?| levels?)?|supported(?: values?| levels?)?|one of|should be|must be)/i;
  const clause = body.match(new RegExp(`\\b${marker.source}\\b[^\\n.]{0,400}`, "i"))?.[0] ?? "";
  if (!clause) return [];
  const quoted = [...clause.matchAll(/["']([a-z0-9][a-z0-9._-]{0,63})["']/gi)].map((match) => normalizeEffort(match[1]));
  if (quoted.length) return [...new Set(quoted.filter((level) => level !== "reasoning_effort" && level !== "effort"))];
  const tail = clause.replace(marker, "").replace(/^\s*(?:are|is|:|=)\s*/i, "");
  return [...new Set(tail.split(/\s*(?:,|\bor\b|\band\b)\s*/i)
    .map((part) => normalizeEffort(part.replace(/[^a-z0-9._-]/gi, "")))
    .filter(isEffortName))];
}
