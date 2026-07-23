---
name: hackathon-engine
description: Win short hackathons: turn an idea + rubric into a polished, non-slop working product on deadline.
match: (hackathon|hack-?a-?thon|datathon|cuoc thi|competition|VAIC|48\s*(h|hours?|hrs|tieng|gio)|24\s*(h|hours?|tieng|gio)|landing page.*(thi|competition|hackathon))
---

# Hackathon engine

Turn a competition idea + its rubric into a **polished, idea-faithful, working product** inside a short
deadline (24-72h) - not generic "AI slop". This is a process spine, not a swarm. Follow the stages in
order; STOP at the three approval gates and wait for the user.

## Why teams lose (the thesis this engine is built on)

Strong models (Fable 5, GPT-class) still ship ugly, off-brief demos because **nothing forces them off
the statistical median.** The fix is three constraint layers most teams skip under time pressure:

1. **Rubric-first** - build what is *scored*, not every feature you can think of.
2. **Taste-constrained** - a concrete design system forces distinctive, on-brief UI (see `references/design-engine.md`).
3. **Externally-verified** - every "it works / it looks good" claim is grounded in a real check (run it,
   test it, screenshot + look), never in "I think it's fine."

Corollary you MUST internalize: **do not build a multi-agent swarm.** Evidence (2026) is clear - swarms
cost 4-220x the tokens and usually LOSE to one strong agent on build tasks (the "swarm tax"). Use a
**single build spine**. Parallelize only *research* (Stage 6), and even then in-session (no subagents).

## Operating principles

- **Constraints beat talent.** Good design is systems (scales, tokens, hierarchy rules), not a gifted
  model. When output looks bad, the cause is almost always a missing constraint, not a weak model.
- **Skepticism must be grounded.** "Check your work" alone is unreliable and can make things worse.
  Doubt is only useful when it resolves to an *external* signal: a passing test, a running app, a
  screenshot reviewed against the design brief, a rubric line ticked. Never trust an unverified claim -
  including your own.
- **Scope by rubric weight.** If "UX" is 25% of the score, an hour polishing the hero is not wasted; a
  fourth backend feature nobody demos is. Re-read the rubric before every major decision.
- **Idea fidelity over feature count.** One surprising thing that fully works and matches the idea beats
  five half-working ones. Protect the one "wow moment".
- **Vietnamese output** (e.g. VAIC): full diacritics, correct spelling/meaning, natural localized
  phrasing - never machine-translated copy on a Vietnamese product.

## The three approval gates (manual - the user asked for this)

Do NOT blow past these. Present the artifact, ask for a decision, wait:

- **GATE 1 - after Stage 0**: the scored 48h plan + the one "wow moment".
- **GATE 2 - after Stage 1**: `SPEC.md` (what you will build, acceptance criteria).
- **GATE 3 - after Stage 2**: the design brief + chosen aesthetic direction (this is where *taste* is
  set; it is cheap to steer here and expensive to fix later).

Everything after Gate 3 (build + verify) runs autonomously against the approved artifacts, reporting at
milestones - but any change to spec or design direction re-opens the relevant gate.

## Stages

### Stage 0 - Rubric & Idea Lock  ->  GATE 1
Ingest the track, the **official rubric/judging criteria**, the idea, and the deadline. Produce:
- A one-paragraph problem statement (specific, not "the future of X").
- The **scored plan**: list each rubric criterion, its weight, and the hours you will spend to move it.
  Time is allocated by *weight*, not by feature enthusiasm.
- The **ONE wow moment** the demo is built around.
- Pick the **track archetype** -> read `references/tracks.md` and adopt its rewards/pitfalls/lean.
Present. Wait for approval.

### Stage 1 - Spec (SDD, gated)  ->  GATE 2
Write `SPEC.md` using Specify -> Plan -> Tasks:
- **Specify**: what and why, the user story, and the *acceptance criteria* per feature (observable:
  "user can X and sees Y"). These are the truth the verify loop checks against.
- **Plan**: the golden stack (read `references/golden-stacks.md`), architecture, data shape, the demo path.
- **Tasks**: small, testable slices ordered so the demo path works end-to-end EARLY (vertical slice
  first, breadth later). Cut ruthlessly to fit the deadline; note what is explicitly out of scope.
Present `SPEC.md`. Wait for approval.

### Stage 2 - Design brief (taste)  ->  GATE 3
Read `references/design-engine.md` in full (and `references/motion.md` if the site's design is scored or
motion is part of the wow). Produce a short `DESIGN.md`:
- The chosen **aesthetic direction** (one of the named directions - NOT "clean and modern").
- The concrete tokens: font pairing by CONTRAST (NOT Inter/Roboto as the only font), a deep gray ramp +
  brand hue + semantic tokens, spacing + type scales, one radius.
- The **one signature motion moment** (see `motion.md`) - purposeful, not decoration everywhere.
- The brand-vs-product split (landing page vs app get opposite treatments).
When design is heavily weighted, aim for the ELITE tier in `design-engine.md` (reference-grade tokens +
craft typography + purposeful scroll motion + restraint), not just "not slop".
Present `DESIGN.md` (ideally 2-3 direction options for the user to pick). Wait for approval.

### Stage 3 - Scaffold the golden stack + ship a skeleton
From `references/golden-stacks.md`, scaffold the approved stack. IMMEDIATELY apply the anti-slop
defaults (swap the default font, install the color tokens, set the type + spacing scale) BEFORE writing
any page - otherwise the framework's defaults reintroduce slop on every new file. **Deploy the empty
skeleton to a real URL now** (see `references/devops.md`) - discovering a build/deploy failure at hour 45
is the classic loss.

### Stage 4 - Build the spine (single agent, vertical-slice first)
Implement the demo path end-to-end first (even stubbed), then widen. One strong agent, slice by slice.
Real artifacts on disk, `edit` over rewrite, commit at milestones. No swarm.
- **Server logic** (an API, auth, data): read `references/backend.md` - contract-first, the security +
  error + idempotency essentials, and demo-proofing (seed data, timeouts, `/health`).
- **Shipping**: `references/devops.md` - a small build->test->deploy path, re-deploy at milestones, keep
  a rollback + a recorded fallback.
- **All human-facing copy**: run the `clean-writing` skill so headings, buttons, and page text read
  like a person, not a chatbot (the verbal half of anti-slop; `design-engine.md` is the visual half).

### Stage 5 - Grounded verify loop (the skeptical engine)
After EACH slice, run the loop - do not advance on assumption:
1. **Run it** (start the app / run the script) and read the actual output/errors.
2. **Test the acceptance criteria** from `SPEC.md` - the observable behavior, not a happy-path self-check.
3. **Look at it** - screenshot and review through the vision bridge against the design review checklist
   in `references/design-engine.md` (hierarchy, spacing on-scale, one primary CTA, contrast, slop tells,
   copy voice, states). For a Chromium/Electron target use the `computer-use` skill's OCR/Set-of-Marks.
4. If a criterion or the taste bar fails: fix, then RE-verify. Loop until it passes. Log what you cut.
Never report "done" or "looks good" without the evidence from this loop.

### Stage 6 - Breadth research (the one place to parallelize)
When you need open-ended exploration (competitor scan, API/library options, sharpening the idea, data
sourcing), fan out **parallel `web_search`/`web_fetch` in this session** (no subagents). Feed findings
back into the spec/design. This is the only stage where breadth-first parallelism pays off.

### Stage 7 - Demo & narrative
Assemble the pitch the judges actually score: **~30% problem / ~70% solution**, opening on the wow
moment, each talking point mapped to a rubric criterion, and a rehearsed **working-demo script** (exact
click path, with a fallback recording if live is risky). Polish the first screen the judges see. Write
the pitch + slides with the `clean-writing` skill - no hollow superlatives, no "revolutionary".

## Reference index (load what the task needs)
- `references/design-engine.md` - visual system, elite tier, component anatomy, anti-slop.
- `references/motion.md` - animation + the micro-interaction catalog.
- `references/tracks.md` - competition archetypes (sub-branches).
- `references/golden-stacks.md` - pinned, anti-slop-ready stacks.
- `references/backend.md` - API/data/auth, right-sized + demo-proof.
- `references/devops.md` - ship early, stay shippable, rollback + recording.
- `references/seo.md` - findability basics (only if scored, or a real launch).
- `clean-writing` skill (separate) - kill AI-slop tells in all copy.

## The skeptic's checklist (run before claiming the product is ready)
- Does every acceptance criterion have a *witnessed* pass (run/test/screenshot), not an assumed one?
- Does the UI survive the design review checklist - no slop tells, hierarchy reads in 3 seconds?
- Is every rubric criterion moved in proportion to its weight?
- Does the demo path work end-to-end from a cold start, right now?
- Is the copy specific and (if Vietnamese) fully accented and natural?
- What did you cut, and is any cut load-bearing for the wow moment?

If you cannot answer YES with evidence, you are not done - keep iterating. Bounded by the rubric,
grounded by real checks: that is how this engine beats the median.
