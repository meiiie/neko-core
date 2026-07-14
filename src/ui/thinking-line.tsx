import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { fmtTok } from "./format.ts";

/** Playful "thinking" verbs (one picked per turn), Claude-style. */
export const VERBS = [
  "Thinking", "Pondering", "Cogitating", "Pouncing", "Prowling", "Noodling",
  "Brewing", "Crunching", "Whisking", "Scheming", "Mulling", "Computing",
];

const ORANGE = "#e6932e";
const SHIMMER = "#ffd9a0";
// Token direction glyphs: input (context fed in) / output (generated). Text arrows (U+2191/2193),
// not emoji - they render as text on Windows Terminal (like the other TUI glyphs), unlike keycaps.
export const UP = "↑";
export const DOWN = "↓";
// Pulse glyph: dot -> star -> sparkle and back. Plain "*" (not ✳, which renders as an emoji
// on Windows — same swap claude-code makes for non-darwin).
const FRAMES = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];

/** A tool call that is CURRENTLY executing: a gray dot that blinks (present -> absent) so it's
 * visibly "running". When the call finishes it commits to the transcript (transcript.tsx) with a
 * solid dot and no blink — so the presence/absence of the blink is the running-vs-done signal.
 * Self-animated (own ~0.5s clock; unmounts when the call finishes and this leaves the live region). */
/** Live elapsed for the spinner: raw seconds under a minute, then "Xm YYs" (zero-padded seconds) so a
 * long turn reads as 1m 00s, 1m 01s, ... 3m 14s instead of a bare, ever-growing "194s". */
export function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const RUN_BLUE = "#4d9fff";
export function RunningLine({ text }: { text: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <Text>
      <Text color={RUN_BLUE}>{on ? "● " : "  "}</Text>
      <Text color="gray">{text}</Text>
    </Text>
  );
}

// Compaction progress bar glyphs (filled/empty parallelograms, U+25B0/U+25B1) + rotating tips.
// Same block-bar look claude-code uses; both render as text (not emoji) on Windows Terminal.
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";
const COMPACT_TIPS = [
  "the original task is kept verbatim across a compaction - it never gets summarized away",
  "recent turns stay in full; only older ones are condensed into the summary",
  "run /compact anytime to free context on demand, before it fills up",
  "big tool outputs are trimmed on compaction - the model rarely re-reads them in full",
  "Plan Mode (shift+tab twice) helps prep a complex request before it grows the context",
];

/** The compaction progress indicator: a pulsing star + "Compacting conversation... (Ns)" and a block
 * bar that fills on a TIME estimate. A summary is one opaque model call, so real progress is unknowable
 * (claude-code's bar is time-based too); we ease toward ~95% and let the caller unmount this on
 * completion, so it never falsely claims "done". A slowly-rotating tip fills the wait. Own 120ms clock. */
export function CompactingLine({ start, expectedMs = 15000 }: { start: number; expectedMs?: number }) {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - start);
  const secs = Math.floor(elapsed / 1000);
  const star = FRAMES[Math.floor(elapsed / 160) % FRAMES.length];
  // Ease toward 95% (1 - e^-t/τ never reaches 100): alive-feeling without lying that it's finished.
  const pct = Math.min(95, Math.round(95 * (1 - Math.exp(-elapsed / expectedMs))));
  const WIDTH = 40;
  const fill = Math.round((pct / 100) * WIDTH);
  const tip = COMPACT_TIPS[Math.floor(elapsed / 4000) % COMPACT_TIPS.length];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={ORANGE}>{star} </Text>
        <Text color={RUN_BLUE}>Compacting conversation… </Text>
        <Text color="#9a9a9a">({secs}s)</Text>
      </Text>
      <Text>
        {"  "}
        <Text color={RUN_BLUE}>{BAR_FILLED.repeat(fill)}</Text>
        <Text color="#4a4a4a">{BAR_EMPTY.repeat(WIDTH - fill)}</Text>
        <Text color="#9a9a9a"> {pct}%</Text>
      </Text>
      <Text color="#9a9a9a">{"  └ tip: "}{tip}</Text>
    </Box>
  );
}

/** A pulsing star (fixed-width, no text shift) + a verb with a shimmer band sweeping across it,
 * then dim meta in parens. Self-animated (own 80ms clock; unmounts when idle). */
export function ThinkingLine(props: { verb: string; elapsed: number; step: number; queued: number; effort?: string; liveIn: () => number; liveOut: () => number }) {
  const { verb, elapsed, step, queued, effort } = props;
  const inTok = props.liveIn();   // input (context sent) this turn - re-read each 80ms frame, counts up live
  const outTok = props.liveOut(); // output (generated) this turn
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 100000), 80);
    return () => clearInterval(id);
  }, []);

  const chars = [...(verb + "…")];
  const cycle = chars.length + 12; // word width + a gap, so the shimmer pauses between sweeps
  const glimmer = chars.length + 6 - (frame % cycle); // bright band index, sweeps right -> left
  const star = FRAMES[Math.floor(frame / 2) % FRAMES.length];
  const meta =
    `${fmtElapsed(elapsed)}` +
    (effort ? ` · ${effort} effort` : "") +
    (step > 1 ? ` · step ${step}` : "") +
    ` · turn total ${UP}${fmtTok(inTok)} ${DOWN}${fmtTok(outTok)}` +
    (queued > 0 ? ` · ${queued} queued` : "") +
    " · esc to interrupt";

  return (
    <Box flexDirection="row">
      <Text color={ORANGE}>{star}</Text>
      <Text>
        {" "}
        {chars.map((c, i) => (
          <Text key={i} color={Math.abs(i - glimmer) <= 1 ? SHIMMER : ORANGE}>{c}</Text>
        ))}{" "}
        <Text color="#9a9a9a">({meta})</Text>
      </Text>
    </Box>
  );
}
