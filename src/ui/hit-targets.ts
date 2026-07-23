/**
 * Frame-level registry of clickable anchors ("what glows is what works", generalized from the jump
 * pill). A component marks a click zone by prefixing its text with HIT_SENTINEL (frame-diff.ts);
 * the FrameDiffer strips the markers from each composed frame and records their screen cells here.
 * Pointer handlers then hit-test against the LAST PAINTED frame - exact regardless of layout,
 * because the coordinates come from what is actually on screen, not from re-derived geometry.
 *
 * Module-level on purpose: one UI process, one screen; threading this through props would couple
 * every clickable surface to the differ. Empty when no differ runs (inline mode / tests), so mouse
 * hit-testing simply no-ops there. Consumers must only render sentinels while they are the active
 * surface (approval box, overlay picker) - zones are indexed in reading order across the frame.
 */
export interface HitTarget {
  row: number; // 1-based screen row
  col: number; // 1-based display column of the zone start
}

let targets: HitTarget[] = [];

/** Replace the frame's hit targets (called by the FrameDiffer on every composed frame). */
export function setHitTargets(t: HitTarget[]): void {
  targets = t;
}

/** Index (in reading order) of the hit zone containing screen cell (x, y). A zone starts at its
 * sentinel and ends at the next sentinel on the same row, or at the end of that row. -1 = none. */
export function hitIndexAt(x: number, y: number): number {
  let best = -1;
  for (let i = 0; i < targets.length; i++) {
    if (targets[i].row === y && targets[i].col <= x) best = i;
  }
  return best;
}
