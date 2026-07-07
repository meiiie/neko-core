# CONSULT (Neko → Codex): redesign TextInput — multiline wrap + overlay caret

## Context (WHY — measured, not guessed)
Two real user complaints about src/ui/text-input.tsx (190 lines, Ink/React):

### Problem 1: input expands infinitely right instead of wrapping like Claude Code
Current render (text-input.tsx:185-206): single-line HORIZONTAL WINDOWING. When the typed text
exceeds `width` (= inputCols = terminal width - prompt), it does NOT wrap — it scrolls the text
horizontally inside the window (winStart/winEnd keep the cursor's ~charCols neighborhood visible).
The user sees text slide left past the right edge. Claude Code instead WRAPS the input: text flows
to the next visual line, the input area grows downward, you can see the whole thing.

This horizontal-windowing path is ALSO the current "multiline" bypass: text-input.tsx:174-184 says
"if value.includes('\n'), skip windowing, Ink renders \n as real breaks". But that only handles
pasted newlines, NOT a long single line that should wrap.

### Problem 2: caret looks like "xin chà| o" — a gap AFTER the caret
The caret is currently an INSERTED CELL: `before + <Text color=green>▏</Text> + after`. The ▏ glyph
(U+258F) sits in its OWN cell between before and after. On the user's Windows Terminal font, the
glyph's internal left-padding reads as a gap after the preceding char AND before the next char, so
it looks like "chà" + gap + "o" rather than "chào". Measured earlier: in a virtual terminal the
insertion is logically flush (hell▏o), but the real-font glyph is the problem.

User EXPLICITLY wants "hướng 2" = overlay caret, NOT a glyph swap (we already added caret_glyph
override and it didn't fully fix the perceived gap).

## Proposed design (both problems solved together)

### A. Overlay caret (replaces inserted-glyph caret)
Instead of a separate cell for the caret, render the character UNDER the cursor with INVERSE VIDEO
(bg green / fg black via Ink's `<Text backgroundColor="green">`) when caretOn, and the char's
normal style otherwise. When the cursor is at the END of the text (no char under it), render a
SPACE with inverse video (a block cursor at EOL). When caretOn is false (blink off), render the char
normally (no inverse) so the cursor disappears on blink-off.

This is how real terminal cursors work and is the ONLY cross-font-robust approach (Codex's earlier
recommendation). It removes the inserted cell entirely, so there's no glyph to gap.

### B. Multiline wrap (replaces horizontal windowing)
Render the value as multiple VISUAL lines, each at most `width` columns, wrapping at word/codepoint
boundaries. The caret (overlay) sits on whatever char the cursor index points to, on whichever
visual line + column it lands on. The Box that hosts TextInput must allow vertical growth
(flexDirection column or natural flow).

Key invariant to preserve: the cursor index `cur.current` is a CODEPOINT index into `value`. The
wrap math must map codepoint index -> (visual line, visual col) to know WHERE to draw the overlay.

### Concerns / questions for Codex
1. **IME (Vietnamese Telex)**: the live-value-in-ref + synchronous-mutate design (text-input.tsx
   header comment, the "mọi"→"moọi" bug) is load-bearing. Does changing the render path risk
   re-introducing the IME composition bug? My belief: NO, because render is downstream of the ref;
   but I want Codex to confirm the render refactor doesn't touch the input/key handler.
2. **Wide chars (CJK/emoji)**: codepoint index vs display-column. If we wrap by codepoint count we
   mis-wrap wide chars (a 2-cell char at the end of a line overflows by 1). Should we compute display
   width (e.g. a simple wcwidth) for wrapping? Or keep codepoint-count wrap and accept rare overflow?
3. **Ink `<Text>` + inverse video**: does Ink 7 support backgroundColor for the inverse-caret cell?
   Confirm the API. And does inverse video inside a `<Text>` that also wraps work (does the bg fill
   the cell, or just behind the glyph)?
4. **Mask mode** (secrets): currently renders bullets. With overlay caret + multiline, mask should
   stay single-line (no wrap — never reveal secret length structure) and the overlay covers a bullet.
5. **paste-collapse placeholders** (`[Pasted text #N +M lines]`): these are single-line placeholders
   that must NOT wrap weirdly. Confirm they render fine under the new wrap path.
6. **max height**: should the wrapped input be capped (e.g. last 5 lines visible, scroll within) or
   grow unbounded (could push the transcript off-screen on a long paste)? Claude Code caps. Recommend
   a cap with internal scroll, OR unbounded since big pastes already collapse to placeholders.

## What I want from you
Read src/ui/text-input.tsx (full), src/ui/chat.tsx lines 1583-1602 (the mount site + Box), and
src/shared/paste-collapse.ts. Reply PLAIN TEXT:
- Confirm or challenge the overlay-caret + multiline-wrap design.
- Answer the 6 concerns, especially IME safety and wide-char wrap.
- Flag any invariant I'd break.
- Give a concrete step-by-step implementation plan (what functions to add, what render branch to
  replace). Do NOT modify files.
