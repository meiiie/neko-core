# Design engine — how to make it beautiful, not slop

The reason AI UIs look bad is **not** a weak model and **not** missing talent. It is the absence of
**constraints**. A model with no design system samples the statistical median of the web: Inter font,
purple→blue gradient, centered hero, four rounded cards. Great UI is a **system** — constrained scales
applied consistently. This file turns "good taste" into rules you can apply mechanically. Follow them
literally; do not improvise off-scale values.

## The 7 laws (apply in this order)

### Law 1 — Design in grayscale first, add color last
Build the whole layout in black / white / grays. This forces hierarchy to come from **spacing, size,
and weight** instead of color. Add ONE brand color only after the gray layout already reads correctly.
Color is a highlighter, not a crutch.

### Law 2 — One spacing scale, nothing off it
Every margin, padding, and gap is a multiple of 4 on this scale (px):
`4, 8, 12, 16, 24, 32, 48, 64, 96, 128`.
No `13px`, no `18px` gaps. Related things: tight (4–8). Unrelated groups: far (48–96). **Section rhythm:
64–96px of vertical space between major sections** — cramped sections are the #1 amateur tell.
Rule of thumb: **start with too much whitespace, then remove.** Generous first.

### Law 3 — One type scale, readability-first
Font sizes come from this hand-picked scale (px): `12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72`.
- **Body text 16–18px.** Never ship 14px body on a landing page.
- Each step up in importance jumps ≥1 level; a headline vs body should be a clear leap (e.g. 48 vs 18).
- **Line-height is inverse to size**: body ~1.5–1.6; large headings ~1.05–1.2. Tighten big text.
- **Line length 60–75 characters** for reading (`max-width: ~65ch`). Full-width paragraphs read cheap.
- Weights: body 400, emphasis 500–600, headings 600–800. Use 2–3 weights of ONE family, not five.

### Law 4 — Hierarchy from weight + color, not size alone
To make something secondary, don't just shrink it — **lighten it** (a medium gray) or drop its weight.
To make something primary, **increase weight and contrast**, not only size. A page where everything is
the same weight in the same near-black reads flat no matter the sizes. Establish 3 text tiers:
primary (near-black / high contrast), secondary (mid-gray), tertiary (light gray / smaller).

### Law 5 — Color: one hue, a full gray ramp, sharp accents
- Pick **one brand hue**. Generate a ramp of ~9 steps (50→900) by holding the hue and moving
  lightness/saturation (HSL). Rotate hue slightly and add saturation as it darkens for richness.
- **You need MANY grays** (not 3): a 9-step neutral ramp for text, borders, backgrounds, dividers.
  Amateur UIs run out of grays and everything collapses to black-on-white.
- **Semantic tokens, not decorative names**: `--color-text-primary`, `--color-bg-surface`,
  `--color-action-primary`, `--color-border-subtle`, `--color-feedback-success`. Every color must serve
  a role. This is what prevents the framework's defaults creeping back on every new component.
- 1–2 accent colors max. Success/warn/error are functional, not brand.

### Law 6 — Component states are not optional
Every interactive element needs: **default, hover, focus (visible ring), active, disabled**, and where
relevant loading + empty + error. A button with no hover and no focus ring instantly reads as unfinished.
Empty states and error states are where slop demos fall apart on stage — design them.

### Law 7 — Depth and polish LAST, subtle always
Only after layout + hierarchy + color work: add depth. **Layered soft shadows** (a small tight one +
a larger diffuse one) beat one harsh `0 2px 4px`. Borders: `1px` of a subtle gray, not black. Radius:
pick ONE (e.g. 8px or 12px) and use it everywhere, or go fully sharp (0px) for a technical look — never
mix random radii. Motion: purposeful only — a 150–200ms transition on CTAs, inputs, and state changes;
NO gratuitous fade-in-on-scroll on everything.

## Component anatomy (the specs that make or break a landing page)

- **Primary button**: padding ~`12px 20px` (or 16/24 for hero), weight 600, one clear brand fill,
  visible focus ring, hover darken ~8%. **Exactly one primary button per view** — everything else is
  secondary (outline/ghost). Two competing primaries = no hierarchy.
- **Card**: padding 24–32, `1px` subtle border OR one soft shadow (not both loud), radius = your one
  value. Inside: title (weight 600), body (secondary gray), generous internal spacing. Don't over-round
  (24px radius on everything is a slop tell).
- **Hero**: headline 48–72px weight 700–800, tight line-height, **specific** message (a real outcome,
  not "Build the future of work"); one subhead (secondary gray, 18–20px, ≤2 lines); **one** primary CTA
  + optional ghost secondary; a real proof element (logo row, metric, screenshot) — not a stock photo.
  Avoid the dead-center-everything hero unless the aesthetic direction calls for it.
- **Nav**: logo left, links with clear hover, one primary action right. Keep it sparse.
- **Section**: a short eyebrow/label, a heading, supporting text capped at ~65ch, then the content.
  64–96px of air above and below. This rhythm is what makes a page feel designed.
- **Form input**: label above (not just placeholder), clear focus ring, visible error text, comfortable
  height (~40–44px), 16px text (prevents mobile zoom).

## Anti-slop constraints (explicit DON'T → DO)

| Slop tell | Do instead |
|---|---|
| Inter/Roboto as the only font | A distinctive display font + a clean body font (see directions below) |
| Purple→blue default gradient | One committed brand hue; use atmospheric/subtle backgrounds, not the default gradient |
| Four identical rounded cards in a row | Vary card sizes/emphasis, or use a different layout (bento, list, split) |
| Stock "diverse team at laptops" / 3D blobs | Real product screenshots, real UI, custom simple illustration, or honest empty space |
| "Build the future of X" vague copy | Concrete outcome in the founder's voice — test: "would our founder actually say this?" |
| Everything centered | Use a real layout grid; left-align text blocks for readability |
| One 16px radius + 24px padding everywhere | Intentional scale + one radius; vary padding by role |
| 14px gray body text everywhere | 16–18px body, proper 3-tier hierarchy |

## Aesthetic directions (pick ONE at Gate 3 — this is the taste decision)

Each direction is a concrete package so the model cannot fall back to the median. Choose by the brand +
audience, then apply its tokens verbatim.

1. **Editorial / authoritative** — serif display (e.g. a Playfair/Fraunces-style face) + clean sans body;
   generous whitespace; muted near-neutral palette with one deep accent; minimal motion. Reads premium,
   trustworthy. Good for fintech, health, gov, research.
2. **Technical / developer** — sans or mono headings, **monospace accents**, dark theme option, dense but
   ordered, sharp (0–6px) radius, high contrast, subtle grid lines. Good for dev tools, infra, AI infra.
3. **Bold / brand-forward** — oversized sans headings (700–900), one saturated brand color used
   confidently, high contrast, big spacing, a strong signature element. Good for consumer, launches.
4. **Warm / human** — humanist sans, rounded (12–16px) radius, warm neutral palette, real photography,
   softer shadows. Good for community, education, social-impact.
5. **Minimal / brutalist** — one family (often mono), near-zero radius, black/white + one accent, raw
   borders, no shadows, type does all the work. Good for design-savvy audiences; high-risk/high-reward.

For each chosen direction, write the actual values into `DESIGN.md`: the two font names, the 9-step gray
ramp + brand hue, the spacing scale, radius, and the one signature interaction.

## Brand vs product (they follow opposite rules)
- **Landing page / marketing**: persuasion. Big type, lots of air, a narrative down the page, emotional
  proof, one conversion action. Distinctiveness matters most here — this is what judges see first.
- **App / dashboard**: efficiency. Dense, information-first, muted, consistent components, fast scanning,
  minimal decoration. Applying marketing flourish to a dashboard (or vice-versa) is a classic mistake.

## Design review checklist (run this in the Stage 5 vision loop, every screen)
- Does the visual hierarchy read in **3 seconds** — is it obvious what's most important?
- Is every spacing value on the scale? Is there 64–96px between sections?
- Body ≥16px? Line length ≤~75ch? 3 clear text tiers?
- Exactly **one** primary CTA per view?
- Enough grays, or has everything collapsed to black-on-white?
- Do interactive elements have hover + a visible focus ring? Do empty/error states exist?
- Any slop tells from the table above? Kill them.
- Is the copy specific and in the right voice (fully accented if Vietnamese)?
- One radius, subtle layered shadows, purposeful motion only?

If a screen fails any line, it is not done — fix and re-review. Ship screens that pass, not screens that
"basically look fine".

## Go deeper (sources worth reading if time allows)
- *Refactoring UI* (Wathan & Schoger) — the canonical systems approach this file distills.
- A modular type-scale tool (e.g. type-scale.com) for generating the scale.
- Real references to imitate structurally (not copy): Linear, Vercel, Stripe, Raycast — study their
  spacing rhythm, type hierarchy, and restraint, then apply YOUR direction's tokens.
