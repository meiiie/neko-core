/**
 * Deterministic contract test for the stream pump throttle. The wall-clock sim
 * (scroll-under-stream.test.tsx) cannot pin the 40ms/300ms cadence: under CPU load the OBSERVED
 * pinned cadence varies 3-6x (40-433ms measured). The gate itself is a pure function of (now,
 * lastPump, scrolledAway), so we verify it directly with an injected clock - no timers, no flake.
 *
 * Contract: live tail visible -> re-render at most every STREAM_PUMP_MS (~25fps); scrolled away
 * (reading mode) -> at most every STREAM_PUMP_SCROLLED_MS (~3fps); re-pinning lets the very next
 * pump through immediately (snap current).
 */
import { expect, test } from "bun:test";
import { STREAM_PUMP_MS, STREAM_PUMP_SCROLLED_MS, shouldStreamPump } from "../src/ui/chat.tsx";

test("stream pump cadence constants match the documented contract", () => {
  expect(STREAM_PUMP_MS).toBe(40);
  expect(STREAM_PUMP_SCROLLED_MS).toBe(300);
  expect(STREAM_PUMP_SCROLLED_MS).toBeGreaterThan(STREAM_PUMP_MS); // reading mode is materially slower
});

test("shouldStreamPump: pinned (live tail visible) throttles to STREAM_PUMP_MS", () => {
  const t0 = 1_000_000;
  // at least the cadence elapsed -> allow (leading edge)
  expect(shouldStreamPump(t0 + STREAM_PUMP_MS, t0, false)).toBe(true);
  // one tick short of the cadence -> block (no timer: deltas pile into refs until the gate opens)
  expect(shouldStreamPump(t0 + STREAM_PUMP_MS - 1, t0, false)).toBe(false);
  // well past -> allow
  expect(shouldStreamPump(t0 + 1_000, t0, false)).toBe(true);
});

test("shouldStreamPump: scrolled away (reading mode) throttles to STREAM_PUMP_SCROLLED_MS", () => {
  const t0 = 1_000_000;
  expect(shouldStreamPump(t0 + STREAM_PUMP_SCROLLED_MS, t0, true)).toBe(true);
  expect(shouldStreamPump(t0 + STREAM_PUMP_SCROLLED_MS - 1, t0, true)).toBe(false);
  // the pinned cadence must NOT be enough while scrolled away - this is the whole point of reading mode
  expect(shouldStreamPump(t0 + STREAM_PUMP_MS, t0, true)).toBe(false);
});

test("shouldStreamPump: re-pinning (scrolled->false) releases the next pump immediately", () => {
  const t0 = 1_000_000;
  // last pump 50ms ago: blocked while scrolled (<300), allowed the instant we pin (>=40)
  expect(shouldStreamPump(t0 + 50, t0, true)).toBe(false);
  expect(shouldStreamPump(t0 + 50, t0, false)).toBe(true);
});
