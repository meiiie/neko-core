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

/** A pulsing star (fixed-width, no text shift) + a verb with a shimmer band sweeping across it,
 * then dim meta in parens. Self-animated (own 80ms clock; unmounts when idle). */
export function ThinkingLine(props: { verb: string; elapsed: number; tokens: number; step: number; queued: number; effort?: string; liveTokens?: () => number }) {
  const { verb, elapsed, step, queued, effort } = props;
  const tokens = props.liveTokens ? props.liveTokens() : props.tokens; // re-read each 80ms frame -> counts up live
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
    ` · ${fmtTok(tokens)} tok` +
    (queued > 0 ? ` · ${queued} queued` : "") +
    " · esc to interrupt";

  return (
    <Box flexDirection="row">
      <Box width={2}>
        <Text color={ORANGE}>{star}</Text>
      </Box>
      <Text>
        {chars.map((c, i) => (
          <Text key={i} color={Math.abs(i - glimmer) <= 1 ? SHIMMER : ORANGE}>{c}</Text>
        ))}{" "}
        <Text color="#9a9a9a">({meta})</Text>
      </Text>
    </Box>
  );
}
