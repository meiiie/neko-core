/**
 * A small clean-room markdown renderer for the terminal (Ink). Handles code fences,
 * headings, bullet/numbered lists, tables, blockquotes, and inline **bold** / *italic* / `code`
 * / [links]. Decodes HTML entities and <br> (LLM table cells often carry them). Kept ASCII-safe
 * (no fancy glyphs) so it renders on any Windows console codepage.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";

import { highlightLine } from "./highlight.tsx";

/** Decode HTML entities + <br> so they don't show up literally (common in scraped/LLM tables). Also
 * normalize the terminal-hostile emoji that misalign columns: keycaps (1\uFE0F\u20E3) -> "1.", and drop the
 * emoji variation selector that forces an otherwise-plain glyph to render double-width. */
function decodeEntities(s: string): string {
  return s
    .replace(/([#*0-9])\uFE0F?\u20E3/g, "$1.") // keycap 1-in-a-box -> "1." (else a box+digit, misaligned)
    .replace(/\uFE0F/g, "") // variation selector 16: stop forcing wide emoji presentation
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => safeCp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCp(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function safeCp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

// LaTeX -> Unicode for terminal math. A terminal can't render MathML/LaTeX, so `$...$` shows raw. We map
// the common constructs to readable Unicode instead. Tables are the extension point — add a symbol and it
// works everywhere (inline + display) with no other change.
const MATH_GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const MATH_OP: Record<string, string> = {
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", propto: "∝",
  ll: "≪", gg: "≫", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", in: "∈", notin: "∉", cup: "∪", cap: "∩",
  sum: "∑", prod: "∏", int: "∫", oint: "∮", partial: "∂", nabla: "∇", infty: "∞", forall: "∀", exists: "∃",
  rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔", mapsto: "↦",
  cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", angle: "∠", perp: "⊥", parallel: "∥", pm2: "±",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", vec: "→",
};
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", T: "ᵀ", a: "ᵃ", b: "ᵇ", c: "ᶜ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", i: "ᵢ", j: "ⱼ", n: "ₙ", a: "ₐ", x: "ₓ" };
const toScript = (s: string, map: Record<string, string>) => [...s].map((c) => map[c] ?? c).join("");

/** Convert a LaTeX math snippet to readable Unicode (bounded, extend via the tables above). */
export function mathToUnicode(src: string): string {
  let t = src;
  t = t.replace(/\\(text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$2"); // \text{x} -> x
  // Superscripts / subscripts / sqrt FIRST — they carry braces; resolving them lets \frac (below) see a
  // brace-free numerator/denominator even when it contained e.g. \sqrt{...} or ^{...}.
  t = t.replace(/\^\{([^{}]+)\}/g, (_, x) => toScript(x, SUP)).replace(/\^(\S)/g, (_, x) => SUP[x] ?? "^" + x);
  t = t.replace(/_\{([^{}]+)\}/g, (_, x) => toScript(x, SUB)).replace(/_(\S)/g, (_, x) => SUB[x] ?? "_" + x);
  for (let k = 0; k < 3; k++) t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  for (let k = 0; k < 4; k++) t = t.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)"); // now nesting-safe
  t = t.replace(/\\(det|dim|log|ln|exp|sin|cos|tan|min|max|arg|gcd|lim|mod)\b/g, "$1"); // named operators stay as words
  t = t.replace(/\\([A-Za-z]+)/g, (m, name) => MATH_GREEK[name] ?? MATH_OP[name] ?? m.slice(1)); // greek/ops, else drop backslash
  t = t.replace(/\\[,;:!> ]/g, " ").replace(/\\\\/g, "  ").replace(/[{}]/g, ""); // spacing macros, line breaks, stray braces
  return t.replace(/\s+/g, " ").trim();
}

/** Visible text of a cell (markers stripped, entities decoded) — for column-width math. */
function plain(s: string): string {
  return decodeEntities(s)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}
// Terminal display width (emoji/CJK = 2 cells), not code-point count — so table columns line up even
// when a cell contains an emoji or wide character.
const plainLen = (s: string) => stringWidth(plain(s));

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/** Truncate visible text to `w` columns, marking the cut with an ellipsis (single-line cells keep
 * the box borders aligned; wrapping would shatter them). */
export function truncCell(s: string, w: number): string {
  const chars = [...s];
  if (chars.length <= w) return s;
  if (w <= 1) return chars.slice(0, Math.max(0, w)).join("");
  return chars.slice(0, w - 1).join("") + "…";
}

/** Fit natural column widths into `maxWidth` terminal columns (accounting for the │ borders + a
 * space of padding each side) by shrinking the widest columns first — so a wide table is truncated
 * to fit instead of overflowing and wrap-shattering across lines. */
export function fitColumns(natural: number[], maxWidth: number): number[] {
  const n = natural.length;
  if (!n) return [];
  const overhead = n + 1 + n * 2; // │ separators + one space of padding on each side of every cell
  const budget = Math.max(n * 3, maxWidth - overhead);
  const w = natural.map((x) => Math.max(1, x));
  let total = w.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let wi = 0;
    for (let c = 1; c < n; c++) if (w[c] > w[wi]) wi = c;
    if (w[wi] <= 3) break; // don't crush a column below a legible width
    w[wi]--;
    total--;
  }
  return w;
}

function renderTable(header: string[], rows: string[][], key: number, maxWidth: number): ReactNode {
  const natural = header.map((h, c) => Math.max(plainLen(h), ...rows.map((r) => plainLen(r[c] ?? "")), 1));
  const w = fitColumns(natural, maxWidth);
  const rule = (l: string, mid: string, r: string) => (
    <Text color="gray">{l}{w.map((x) => "─".repeat(x + 2)).join(mid)}{r}</Text>
  );
  const renderRow = (cells: string[], rk: string, bold: boolean) => (
    <Text key={rk} bold={bold}>
      <Text color="gray">│</Text>
      {w.map((width, c) => {
        const raw = cells[c] ?? "";
        const fits = plainLen(raw) <= width;
        const shown = fits ? raw : truncCell(plain(raw), width);
        const len = fits ? plainLen(raw) : [...shown].length;
        return (
          <Text key={c}> {fits ? inline(raw) : shown}{" ".repeat(Math.max(0, width - len))} <Text color="gray">│</Text></Text>
        );
      })}
    </Text>
  );
  return (
    <Box key={key} flexDirection="column" marginTop={1} marginBottom={1}>
      {rule("┌", "┬", "┐")}
      {renderRow(header, "h", true)}
      {rule("├", "┼", "┤")}
      {rows.map((r, ri) => renderRow(r, `r${ri}`, false))}
      {rule("└", "┴", "┘")}
    </Box>
  );
}

function inline(raw: string): ReactNode[] {
  const s = decodeEntities(raw);
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|\$([^$\n]+)\$)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[2] !== undefined) out.push(<Text key={key++} bold>{m[2]}</Text>);
    else if (m[3] !== undefined) out.push(<Text key={key++} color="yellow">{m[3]}</Text>);
    else if (m[4] !== undefined) out.push(<Text key={key++} italic>{m[4]}</Text>);
    else if (m[5] !== undefined) out.push(<Text key={key++} color="cyan" underline>{m[5]}</Text>); // [text](url) -> text
    // Inline math $...$ -> Unicode, but ONLY when it actually looks like LaTeX (a backslash/^/_/brace),
    // so a price like "$5 to $10" is left untouched.
    else if (m[7] !== undefined) out.push(/[\\^_{}]/.test(m[7]) ? <Text key={key++} color="cyan">{mathToUnicode(m[7])}</Text> : m[0]);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}

export function Markdown({ text, width, compact, minWidth = 24 }: { text: string; width?: number; compact?: boolean; minWidth?: number }): ReactNode {
  const maxWidth = Math.max(minWidth, width ?? 80);
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let prevBlank = true; // start "blank" so there is no leading empty row
  let inList = false; // a run of list items is ONE block: no blank BETWEEN items, but a blank around the run

  // Ink collapses an empty <Text> to height 0, so a blank markdown line rendered as <Text>{""}</Text>
  // just disappears — which is why paragraphs looked cramped. A single space is what actually renders
  // as a blank row. spacer() emits one, but collapses runs of blanks (and a leading blank) so the
  // vertical rhythm stays even: exactly one blank line between blocks.
  const spacer = () => {
    if (!prevBlank) { blocks.push(<Text key={key++}> </Text>); prevBlank = true; }
  };
  // `rhythm` is the *added* inter-block spacing (above headings, around lists/tables). It is skipped in
  // `compact` mode — used for the live streaming preview, where the rendered height must stay predictable
  // so the dynamic region can be clamped to the terminal (source blank lines still render via spacer()).
  const rhythm = compact ? () => {} : spacer;
  // push a non-list block: if we were in a list, close it with a blank so the list doesn't glue to the
  // following paragraph/heading (this is what kept "**Label**" stuck to its bullets).
  const push = (node: ReactNode) => { if (inList) rhythm(); blocks.push(node); prevBlank = false; inList = false; };
  // push a list item: open the list with a blank the first time (separates it from the prior paragraph),
  // but keep consecutive items tight.
  const pushItem = (node: ReactNode) => { if (!inList) rhythm(); blocks.push(node); prevBlank = false; inList = true; };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      rhythm();
      push(
        <Box key={key++} flexDirection="column" paddingLeft={2}>
          {code.map((c, j) => (
            <Text key={j}>{c.length ? highlightLine(c) : " "}</Text>
          ))}
        </Box>,
      );
      continue;
    }

    // Display math on its own line: $$ ... $$ or \[ ... \] -> Unicode, indented + dim (a terminal can't
    // render LaTeX, so this makes the formula readable instead of showing raw markup).
    const dm = line.match(/^\s*(?:\$\$(.+?)\$\$|\\\[(.+?)\\\])\s*$/);
    if (dm) {
      rhythm();
      push(<Text key={key++} color="cyan">{"  " + mathToUnicode(dm[1] ?? dm[2] ?? "")}</Text>);
      i++;
      continue;
    }

    // Table: a "| ... |" header row followed by a "|---|---|" separator.
    const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l: string) => l.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      rhythm();
      push(renderTable(header, rows, key++, maxWidth));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      rhythm(); // breathing room above a heading even if the source left no blank line
      push(<Text key={key++} bold color="cyan">{inline(heading[2])}</Text>);
      i++;
      continue;
    }

    // Horizontal rule (---, ***, ___): render as spacing only. A full-width line reads as clutter in a
    // terminal (feedback), and the model is told not to draw rules — so a rule just means "new section".
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      rhythm(); // just a section break -> blank spacing, no visible line
      i++;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      push(<Text key={key++} color="gray" italic>{"│ "}{inline(quote[1])}</Text>);
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      pushItem(<Text key={key++}>{bullet[1]}- {inline(bullet[2])}</Text>);
      i++;
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      pushItem(<Text key={key++}>{numbered[1]}{numbered[2]}. {inline(numbered[3])}</Text>);
      i++;
      continue;
    }

    if (!line.trim()) { spacer(); i++; continue; } // a real blank row (Ink would otherwise eat it)

    push(<Text key={key++}>{inline(line)}</Text>);
    i++;
  }

  // Constrain the column to `maxWidth` so paragraph <Text> wraps at OUR width, not the ambient terminal
  // width. Inside <Static> (+ the left gutter) an unconstrained Text wraps at the full width, then the
  // gutter shifts it right past the terminal edge — the terminal then hard-wraps mid-word and dumps the
  // overflow at column 0 (broken Vietnamese: "tương ứ" / "ng"). An explicit width fixes the wrap point.
  return <Box flexDirection="column" width={maxWidth}>{blocks}</Box>;
}
