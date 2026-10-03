import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { terminalSafeText } from "../shared/terminal-text.ts";
import { fmtTok } from "./format.ts";

import { isJsonNumber } from "../shared/wire.ts";
import { chromeTreePrefix } from "./chrome-glyphs.ts";

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
      <Text color="gray">{terminalSafeText(text, { maxChars: 512 })}</Text>
    </Text>
  );
}

const COMPACT_TIPS = [
  "summaries can omit details; inspect original history when exact evidence matters",
  "recent turns are retained, but large tool outputs may be shortened",
  "compact only when useful: a shorter context is not always faster or cheaper",
  "big tool outputs are trimmed on compaction - the model rarely re-reads them in full",
  "Plan Mode (shift+tab twice) helps prep a complex request before it grows the context",
];

/** The provider does not report compaction progress. Show elapsed time, never a fabricated percent. */
export function CompactingLine({ start }: { start: number }) {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - start);
  const secs = Math.floor(elapsed / 1000);
  const star = FRAMES[Math.floor(elapsed / 160) % FRAMES.length];
  const tip = COMPACT_TIPS[Math.floor(elapsed / 4000) % COMPACT_TIPS.length];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={ORANGE}>{star} </Text>
        <Text color={RUN_BLUE}>Compacting conversation… </Text>
        <Text color="#9a9a9a">({secs}s)</Text>
      </Text>
      <Text color="#9a9a9a">  Waiting for the summary; completion time is unknown. Esc cancels.</Text>
      <Text color="#9a9a9a">{chromeTreePrefix()}tip: {tip}</Text>
    </Box>
  );
}

/** A pulsing star (fixed-width, no text shift) + a verb with a shimmer band sweeping across it,
 * then dim meta in parens. Self-animated (own 80ms clock; unmounts when idle). */
export interface LiveTokenCount { value: number; approximate?: boolean }
const tokenCount = (value: number | LiveTokenCount): LiveTokenCount =>
  isJsonNumber(value) ? { value, approximate: false } : value;

export function ThinkingLine(props: { verb: string; elapsed: number; step: number; queued: number; effort?: string; liveIn: () => number | LiveTokenCount; liveOut: () => number | LiveTokenCount }) {
  const { verb, elapsed, step, queued, effort } = props;
  const inTok = tokenCount(props.liveIn());   // re-read each 80ms frame: estimated until provider usage arrives
  const outTok = tokenCount(props.liveOut());
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
    ` · turn total ${UP}${inTok.approximate ? "~" : ""}${fmtTok(inTok.value)} ${DOWN}${outTok.approximate ? "~" : ""}${fmtTok(outTok.value)}` +
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
