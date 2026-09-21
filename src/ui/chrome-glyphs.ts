/**
 * Chrome-only glyph table for ApprovalBox / footer / tree / error prefixes.
 *
 * Body text (reasons, paths, Vietnamese) must never pass through this — REF
 * `REF-FONTS-ENCODING-LINUX-CSR-2026-09-21.md`. Tab OSC titles keep 🐱 alone.
 *
 * Gate: NEKO_ASCII_CHROME=1|true forces ASCII; =0|false forces Unicode.
 * Auto: non-UTF-8 locale → ASCII. Default UTF-8 locales keep Unicode. (TERM=dumb alone does not force ASCII — set NEKO_ASCII_CHROME=1.)
 * Optional config: ui_ascii_chrome (via Config.asciiChrome); env wins when set.
 * No Symbola / Nerd Font dependency.
 */
export type ChromeKind = "warn" | "ok" | "deny" | "mode" | "tree";

const UNICODE = {
  warn: "⚠",
  ok: "✓",
  deny: "✗",
  mode: ">>", // was U+23F5 ⏵⏵ — missing on thin Linux CSR fonts → literal ??
  tree: "└",
} satisfies Record<ChromeKind, string>;

const ASCII = {
  warn: "!",
  ok: "+",
  deny: "X",
  mode: ">>",
  tree: "|-",
} satisfies Record<ChromeKind, string>;

/** True when chrome should use the ASCII map. Pure env/locale — no Config import (UI leaf). */
export function useAsciiChrome(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NEKO_ASCII_CHROME;
  if (raw != null && String(raw).trim() !== "") {
    const v = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  // Do not key off TERM=dumb alone: bun test / CI set TERM=dumb under UTF-8 locales and would
  // otherwise force ASCII chrome in every unit render. Operators on true dumb terminals can set
  // NEKO_ASCII_CHROME=1.
  return !localeLooksUtf8(env);
}

function localeLooksUtf8(env: NodeJS.ProcessEnv): boolean {
  for (const key of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    const v = env[key];
    if (!v) continue;
    if (/utf-?8/i.test(v)) return true;
    // Explicit C / POSIX without UTF-8 → treat as legacy (tofu risk for symbols).
    if (v === "C" || v === "POSIX" || /^C(\.|$)/i.test(v) && !/utf-?8/i.test(v)) return false;
    // Some other charset named (e.g. ISO-8859-1) → ASCII chrome.
    return false;
  }
  // Unset locale: modern Node/Bun strings are Unicode; prefer glyphs.
  return true;
}

/** One chrome glyph (no trailing space). Callers add spacing to match existing layout. */
export function chromeGlyph(kind: ChromeKind, ascii = useAsciiChrome()): string {
  return (ascii ? ASCII : UNICODE)[kind];
}

/** Prefix helpers matching previous hardcoded `"⚠ "` / `"✗ "` / `"  └ "` shapes. */
export function chromeWarnPrefix(ascii = useAsciiChrome()): string {
  return `${chromeGlyph("warn", ascii)} `;
}
export function chromeOkPrefix(ascii = useAsciiChrome()): string {
  return `${chromeGlyph("ok", ascii)} `;
}
export function chromeDenyPrefix(ascii = useAsciiChrome()): string {
  return `${chromeGlyph("deny", ascii)} `;
}
export function chromeModeChip(ascii = useAsciiChrome()): string {
  return ` ${chromeGlyph("mode", ascii)} `;
}
export function chromeTreePrefix(ascii = useAsciiChrome()): string {
  // Unicode path keeps the historical two-space + └ + space indent.
  return ascii ? `  ${chromeGlyph("tree", ascii)} ` : `  ${chromeGlyph("tree", ascii)} `;
}
