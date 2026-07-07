/**
 * Paste-collapse utilities (Claude Code-style). Shared between TextInput (insert path) and
 * ChatApp (expand path, used by submit + Ctrl+G external editor). Pure functions + constants —
 * the pastedContents Map itself lives in ChatApp so both submit and the external editor can see
 * the full content behind a placeholder.
 *
 * A big/multiline paste becomes a compact `[Pasted text #N +M lines]` placeholder in the input
 * box; the full content is held in a map and expanded back before the prompt leaves the input layer
 * (on submit, or when opening the external editor). The id is internal; the placeholder is matched
 * STRICTLY (id must exist in the map) so a user hand-typing the same shape is never mis-expanded.
 */

/** Collapse if a paste is longer than this (chars). */
export const PASTE_COLLAPSE_CHARS = 200;
/** Collapse if a paste has at least this many newlines (lines = newlines). */
export const PASTE_COLLAPSE_LINES = 2;

/** Matches `[Pasted text #N]` or `[Pasted text #N +M lines]` (also `Image #N`, harmless). Global. */
export const PLACEHOLDER_RE = /\[(?:Pasted text|Image) #(\d+)(?: \+\d+ lines)?\]/g;

/** Format the compact placeholder shown in the input box for a staged paste. */
export function formatPlaceholder(id: number, text: string): string {
  const lines = (text.match(/\r\n|\r|\n/g) || []).length;
  return lines === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${lines} lines]`;
}

/** Whether a paste should collapse (vs. be inserted raw). */
export function shouldCollapsePaste(text: string): boolean {
  const lines = (text.match(/\n/g) || []).length;
  return text.length > PASTE_COLLAPSE_CHARS || lines >= PASTE_COLLAPSE_LINES;
}

/**
 * Expand all `[Pasted text #N ...]` placeholders in `text` using `pasted` (id -> full content).
 * Placeholders whose id is NOT in the map (a user-typed lookalike) are left as-is, never dropped.
 * Returns text unchanged when the map is empty (fast path).
 */
export function expandPlaceholders(text: string, pasted: Map<number, string>): string {
  if (!pasted.size) return text;
  PLACEHOLDER_RE.lastIndex = 0;
  return text.replace(PLACEHOLDER_RE, (m, idStr) => {
    const id = Number(idStr);
    const full = pasted.get(id);
    return full !== undefined ? full : m;
  });
}

/**
 * Garbage-collect staged pastes whose placeholder is no longer in `text` (the user backspaced it).
 * Mutates `pasted` in place. Returns nothing.
 */
export function gcPastes(text: string, pasted: Map<number, string>): void {
  if (!pasted.size) return;
  const live = new Set<number>();
  PLACEHOLDER_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = PLACEHOLDER_RE.exec(text))) live.add(Number(mm[1]));
  for (const id of [...pasted.keys()]) if (!live.has(id)) pasted.delete(id);
}

/**
 * Re-collapse pasted content after an external editor edit: find exact-match substrings of staged
 * pastes in `edited` and replace them back with placeholders (so the input box stays compact).
 * A paste the user edited inline stays expanded (no exact match -> not re-collapsed). Mirrors
 * claude-code's recollapsePastedContent.
 */
export function recollapsePastedContent(
  edited: string,
  pasted: Map<number, string>,
): string {
  let out = edited;
  for (const [id, content] of pasted) {
    const idx = out.indexOf(content);
    if (idx !== -1) {
      out = out.slice(0, idx) + formatPlaceholder(id, content) + out.slice(idx + content.length);
    }
  }
  return out;
}
