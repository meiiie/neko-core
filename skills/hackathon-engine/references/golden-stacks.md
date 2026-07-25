# Golden stacks — pinned, anti-slop, fast to a working demo

A hackathon is greenfield under a clock: pick a **known** stack and start with its defaults already
neutralized against slop. Never cold-start on an unfamiliar framework. Pick the stack in Stage 1 (Plan)
to match the track archetype, scaffold it in Stage 3, and **apply the anti-slop setup BEFORE writing any
page** — the framework's defaults reintroduce slop on every new file otherwise.

The rule that makes any stack not-slop: **before the first page, install the design tokens from
`DESIGN.md`** (fonts, gray ramp + brand hue, spacing scale, radius) so every component inherits the
chosen direction instead of the framework default.

## Stack A — Next.js + Tailwind + shadcn/ui (TUNED)  — default for Web/SaaS and AI-product
Best for: Archetypes B (web/SaaS) and A (AI product with a real UI). Fast, component-rich, deployable.

Anti-slop setup (do immediately after scaffold):
1. **Replace the font.** Do NOT ship default Inter alone. Load the direction's display + body fonts
   (e.g. via `next/font/google` or self-hosted) and set them as the Tailwind font families.
2. **Install semantic tokens.** In `globals.css`/Tailwind config, define the 9-step gray ramp, brand
   hue ramp, and semantic vars (`--color-text-primary`, `--color-bg-surface`, `--color-action-primary`,
   `--color-border-subtle`). shadcn reads CSS vars — override its defaults with yours, don't accept them.
3. **Set the scales.** Spacing = the 4/8/12/16/24/32/48/64/96 scale; one radius; type scale from
   `design-engine.md`. Remove the default 16px-radius-everywhere look.
4. Keep shadcn components but **restyle tokens**, so they stop looking like every other shadcn demo.

Deploy: Vercel (or a static export). Verify: `next build` + run + screenshot each screen through the
vision loop.

## Stack B — Vite + React + Tailwind (lightweight)
Best for: a fast single-purpose demo, or Archetype A where the UI is a thin shell around the AI. Lower
overhead and faster cold start than Next when you don't need SSR/routing.
Anti-slop setup: same token discipline as Stack A (fonts, gray ramp, scales) before the first component.
Deploy: any static host / Netlify / Vercel.

## Stack C — Python + Streamlit or Gradio (ML/data demos)
Best for: Archetypes C (data/ML) and A when the AI/model is the star and UI is secondary. Gets to a
working AI/data demo fastest.
Anti-slop setup: Streamlit/Gradio look samey — push what you can: set the theme (primary color, font,
base), use a clean layout with real spacing, put ONE strong chart (use the `dataviz` skill) as the hero,
and hide the boilerplate. If design is heavily scored, wrap the model in Stack A/B instead and call a
Python API.
Verify: run it, feed real inputs, confirm the numbers with a witnessed computation (Stage 5).

## Stack D — Static HTML + Tailwind (CDN) + a little JS (ultra-fast landing)
Best for: when the deliverable is mostly a landing page + a light interaction, or you need something
bulletproof for the live demo with zero build risk.
Anti-slop setup: hand-set the fonts, color vars, and spacing in one `<style>`/config; you have full
control, so apply `design-engine.md` directly. Cheapest path to a genuinely polished first screen.

## Choosing (quick map)
| Track archetype | Default stack |
|---|---|
| A — AI/GenAI product (UI matters) | A (Next tuned) |
| A — AI/GenAI (model is the star) | C (Gradio/Streamlit) or B + Python API |
| B — Web/SaaS | A (Next tuned) |
| C — Data/ML | C (Python) + `dataviz` |
| D — Dev tool | native to the target (CLI/extension) |
| E — Social impact | B or D (lightweight, robust, accessible) |

## Non-negotiables for any stack
- **Demo-path-first**: wire the one flow the judges will see end-to-end before widening.
- **Deployable early**: get a URL / runnable build in the first hours; don't discover a build failure at
  hour 45. Re-deploy at each milestone.
- **A cold-start test**: before the demo, clone/checkout fresh, install, run — prove it works off the
  author's machine. This single check saves the most demos.
- **A fallback**: record a 60–90s demo video once the flow works, in case live fails on stage.
- Keep dependencies lean (ponytail): reach for the framework's built-ins before adding a library.

## Keep this file learning
When a stack + setup wins (or loses), note why here so the next competition starts faster. The golden
stacks should get sharper every event — that compounding is part of the engine.
