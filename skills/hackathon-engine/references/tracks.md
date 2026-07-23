# Tracks — competition archetypes (sub-branches)

Different competitions reward different things. Pick the archetype that matches the track, adopt its
"wow", scope lean, stack lean, design lean, and pitfalls. These are branches of the same engine — the
stages in `SKILL.md` don't change; the *emphasis* does. **Always let the official rubric override these
defaults** — this file is the prior, the rubric is the evidence.

## How to read a rubric (do this in Stage 0, every time)
1. List each criterion and its **weight**. If weights aren't published, infer from the prompt and treat
   "innovation", "impact", and "demo/presentation" as heavy by default.
2. For each criterion, write the single most efficient way to move it, and the hours it deserves.
3. Find the **judging format**: live demo? recorded? slide-only? judged by engineers or business people?
   Engineers reward "it actually works"; business/VC judges reward story, market, and the wow.
4. Note hard constraints (must use sponsor API, theme, team size) — violating them zeroes you.

## Archetype A — AI / GenAI product (e.g. VAIC-style)
- **Judges reward**: a genuinely useful AI capability working **live**, not a thin wrapper. Novelty of
  the *application*, and that the AI does something concrete and reliable in the demo.
- **The wow**: the model doing something surprising-yet-useful on the judge's own input, fast.
- **Scope lean**: nail ONE AI flow end-to-end (input → model → visible, useful output) before anything
  else. Reliability of that one flow > breadth. Handle latency with optimistic UI / streaming.
- **Stack lean**: a fast web front + a thin API to the model; or Streamlit/Gradio if the UI is secondary
  to the AI. Cache/precompute where a live call is risky on stage.
- **Design lean**: Technical or Bold direction; make the AI's output the hero of the screen.
- **Pitfalls**: "ChatGPT wrapper" feel; a demo that needs a perfect prompt to work; unbounded latency;
  hallucinated output shown as fact. Show guardrails / grounding — judges notice.

## Archetype B — Web / SaaS product
- **Judges reward**: a polished, coherent end-to-end product; UX and completeness of the core flow.
- **The wow**: a flow that feels like a real shipped product, not a prototype — smooth, designed, fast.
- **Scope lean**: one core user journey done to a high finish (landing → sign-in stub → the core action →
  a satisfying result). Cut everything not on that journey.
- **Stack lean**: Next.js + Tailwind + shadcn (tuned) — see golden-stacks.
- **Design lean**: design polish is heavily weighted here; invest in the landing + the core screen.
  Editorial or Bold direction. This archetype is where `design-engine.md` pays off most.
- **Pitfalls**: broad-but-shallow (many dead buttons); slop landing page; no empty/error states.

## Archetype C — Data / ML / analytics
- **Judges reward**: a real insight, methodological soundness, and a compelling narrative from data.
- **The wow**: a non-obvious finding shown in ONE clear, honest visualization.
- **Scope lean**: get to a correct result on real data early; then one strong viz + the story around it.
  Correctness and honest caveats matter — don't overclaim.
- **Stack lean**: Python (pandas/polars) + a notebook for analysis, then Streamlit/Gradio or a small web
  app for the viz. Read the `dataviz` skill for the chart itself.
- **Design lean**: restrained; let the data read. Warm or Editorial. One hero chart, not a dashboard of
  ten mediocre ones.
- **Pitfalls**: dashboard-of-everything with no insight; misleading charts; unverified numbers presented
  as fact. Every headline number needs a witnessed computation.

## Archetype D — Dev tool / infra / DX
- **Judges (usually engineers) reward**: it actually works, solves a real developer pain, clean DX.
- **The wow**: a live before/after where the tool removes real friction in seconds.
- **Scope lean**: the core command / extension / integration working on a real repo or flow. A crisp
  README/quickstart counts as product here.
- **Stack lean**: whatever the tool targets (CLI in TS/Python/Go, a VS Code extension, a GitHub Action).
- **Design lean**: Technical/minimal; terminal aesthetics are fine; the DX and docs are the "design".
- **Pitfalls**: a demo that only works on the author's machine; no error handling; over-scoping the UI
  instead of the core capability.

## Archetype E — Social impact / gov / education
- **Judges reward**: clarity of the problem, real user empathy, feasibility, and accessibility.
- **The wow**: a moment that makes the judges *feel* the problem, then see a credible, humane solution.
- **Scope lean**: the problem framing and one real user journey; realistic about constraints (offline,
  low-end devices, low literacy, languages).
- **Stack lean**: lightweight, robust, accessible; works on cheap phones and flaky networks.
- **Design lean**: Warm/human; high accessibility (contrast, font size, keyboard, labels); if Vietnamese
  users, fully localized copy with correct diacritics.
- **Pitfalls**: tech-for-tech's-sake; ignoring accessibility; a solution that ignores the real
  constraints of the population it claims to serve.

## Adding a new archetype
This list is a prior, not a limit. If a competition doesn't fit, create a new branch: identify what its
judges reward, the wow, the scope/stack/design lean, and the pitfalls — then run the same stages. Keep
this file updated as you learn each competition's real scoring behavior (that memory compounds).
