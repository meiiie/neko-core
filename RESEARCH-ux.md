# RESEARCH: Neko Core UX/UI & Micro-interactions — deep analysis (2026-07-07)

Multi-angle synthesis: (A) objective TUI benchmark data, (B) expert micro-interaction principles,
(C) gap analysis against neko's current implementation. Goal: identify the highest-leverage, lowest-risk
UX/perf improvements, grounded in measurement + expert consensus, not taste.

---

## A. Objective benchmark: where neko's perf model stands

Source: nathan-cannon/tui-benchmarks (M4 Max, 120x40, median of 100 iter, frame detected via DEC 2026
end marker). Compares Raw (hand-rolled escape codes = ceiling) vs CellState (cell-level diff + frame
loop) vs **Ink** (what neko uses — "clears and rewrites every line every frame").

### Single-cell update (the keypress-responsiveness test)
| Content | Raw | CellState | **Ink** | Ink bytes/frame |
|---|---|---|---|---|
| 10 msg / 1.4KB | 0.31ms | 5.30ms | 21.65ms | 2,003 |
| 100 msg / 13KB | 1.10ms | 5.38ms | 26.53ms | 16,855 |
| 500 msg / 66KB | 4.81ms | 9.92ms | **63.05ms** | **83,795** |

**Key finding:** Ink writes **83,795 bytes for a 1-character change** at 500 messages. CellState writes
**34 bytes** (same change, any tree size). The gap is the OUTPUT PIPELINE, not React reconciliation
(CellState pipeline stays within 1.0–1.6x of Raw — React adds only ~0.1–0.5ms).

### What this means for neko
- neko ALREADY mitigates this with **FrameDiffer** (line-level diff → only changed rows written). This
  is the right instinct and roughly corresponds to "CellState e2e" in spirit.
- But FrameDiffer is **line-level, not cell-level**, and it RESETS on geometry change (see scroll lag
  research: 17 big ~1200B writes per 15-hop scroll burst on Windows). CellState's 34-byte constant is
  the ceiling neko could asymptotically approach.
- **Verdict:** neko's render model is sound but still ~35x the theoretical floor on a hot path (34B vs
  ~1200B per scroll hop). The win is in reducing BYTES WRITTEN per frame, exactly as the benchmark proves.

---

## B. Expert micro-interaction principles (theuxshop, designstudiouiux, uxpin 2026)

### Timing thresholds (hard numbers)
| Threshold | ms | Meaning |
|---|---|---|
| Instantaneous | <100ms | Feels instant; fine for binary toggles, misses causality cue |
| **Optimal** | **100–300ms** | Most micro-interactions should land here |
| Sluggish | >400ms | Feels laggy |
| Responsiveness rule | <100ms to first feedback | Every action needs visible feedback within 100ms |

neko's measured gaps: scroll burst **412ms max gap** (sluggish), long-input was **4986ms/20keys ≈ 249ms/key**
(borderline, now fixed to ~38ms/key via windowing).

### Trigger / Rule / Feedback / Loop model (Saffer)
Every micro-interaction = Trigger (user/system) → Rule (logic) → Feedback (visible response) → Loop
(how it repeats/ends). **A silent Rule with no Feedback is a missing micro-interaction** — the #1 sin
in CLI tools.

### Easing physics
- `ease-out` for ENTERING elements (fast start, gentle stop)
- `ease-in` for EXITING (gentle start, fast stop)
- Avoid linear (feels robotic). neko's scroll glide already uses exponential ease-out (half-distance
  per frame) — this is correct and expert-aligned.
- `prefers-reduced-motion`: replace slides→instant, bounces→fades, NEVER animate away focus indicators.

### Input-field specifics
- Validate on **blur**, never every keystroke (neko has no validation surface, so N/A — but the
  principle "don't do expensive work per key" is exactly what the windowing fix delivered).
- Caret feedback: neko's `▏` bar flush-before-char + blink-while-idle is **best-in-class** (matches
  Claude Code's editor caret). This is a strength, keep it.

---

## C. Gap analysis: neko vs expert/benchmark ideals

| Area | neko now | Ideal (benchmark/expert) | Gap | Priority |
|---|---|---|---|---|
| Input render | ✅ FIXED (windowing O(1)) | O(1) per keystroke | closed | done |
| Output bytes/frame | line-level FrameDiffer | cell-level (34B constant) | ~35x on scroll | high but risky |
| Scroll smoothness | glide ease-out ✅, but React re-render on 2/3 hops | 1 write/hop imperative | gesture-edge renders | medium |
| Keypress→feedback | caret solid on key ✅ | <100ms feedback | met | — |
| Approval box | static text `[y]es [a]lways` | highlight on hover/key, brief confirm | no key echo | low-med |
| Select list | arrow move, no animation | brief highlight transition on move | none | low |
| Exit confirm | ephemeral hint ✅ | 2-press Ctrl+C w/ countdown | met (2s window) | — |
| Streaming feedback | thinking-line + live md ✅ | skeleton/shimmer for long | good | — |
| Reduced-motion | not respected | suppress decorative motion | missing | low (few dec. animations exist) |

---

## D. Highest-leverage opportunities (ranked by impact:risk)

### 1. [PERF, medium-risk] Reduce scroll gesture-edge React renders
**Finding:** scroll profile showed 15 hops → 17 big (~1200B) React full-frame writes + only 9 small
imperative band writes + 412ms max gap. The `useEffect[rowScroll.dist]` dependency forces React
re-render on most hops; the imperative `repaintBand` fast path only fires ~1/3 of the time.
**Approach:** move `dist` into a ref for the duration of an active scroll gesture, call `repaintBand`
directly per hop, and only `force` a React render at gesture edges (pill mount/unmount, settle).
**Risk:** touches the most delicate code in the repo (FrameDiffer geometry / ConPTY ghost fences).
Must NOT enable hwscroll on Windows. Chesterton's Fence: the `useEffect` dependency may exist precisely
to keep the band model in sync — verify before changing.

### 2. [UX, low-risk] Approval-box key echo (micro-feedback)
**Finding:** pressing `y`/`n`/`a` on an ApprovalBox resolves instantly with no transient feedback. At
high latency (slow agent follow-up) the user can't tell the key registered.
**Approach:** brief (~150ms) state flash on the box ("✓ approved" / "✗ denied") before unmount. Fits
the 100–300ms optimal band. Pure additive, no invariant risk.

### 3. [UX, low-risk] Select-list active-item transition
**Finding:** arrow-key move in SelectList jumps highlight with no transition. A 1-frame (16ms) "trailing
dim" on the previously-active row would communicate motion direction (expert: state feedback patterns).
**Approach:** track prevIndex, render it dimly for one render cycle. Cosmetic, isolated to SelectList.

### 4. [PERF, high-risk] Cell-level diffing
**Finding:** FrameDiffer is line-level. CellState proves cell-level holds 34B/frame regardless of tree
size. But this is a FROM-SCRATCH rewrite of the render core (essentially adopting CellState/OpenTUI).
**Verdict:** too big/risky for incremental improvement; document as a future major-version direction.

---

## E. Recommendation for this session
Pursue **#2 (approval key echo) and #3 (select transition)** first — both are low-risk, isolated,
measurably improve the "feels professional" quality, and give Codex well-bounded tasks. Defer **#1**
(scroll) until a dedicated profiling session on a REAL Windows terminal (VirtualTerminal can't catch
ConPTY displacement). **#4** is a v-next research item.
