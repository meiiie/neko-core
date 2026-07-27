# Image briefs — Neko Core

Ready-to-paste prompts for the visual assets the site, README and social cards need.
Companion to `assets/video-kit/README.md` (video) and `05-brand-board.png` (the system itself).

---

## Read this before generating anything

**1. The mark is not up for redesign.** `assets/neko-icon.png` — the amber pixel `/\_ _/\` — is the
logo. Every asset here either uses those exact pixels or shows no mark at all. The video kit's rule
stands: *do not replace the mark with a generic cat, robot, sparkle, brain, or purple AI orb.*

**2. Never ask an image model for text.** Image models still render typography as convincing gibberish,
and half of these assets are bilingual. Generate **art only** — character, texture, background — and
composite the words afterwards in HTML/CSS, then screenshot at the exact pixel size. That is how
`social-preview.png` was made, it is why it is crisp, and it is the only way Vietnamese diacritics come
out right. Every prompt below therefore ends with *no text, no letters, no numbers, no watermark*.

**3. The palette is fixed.** Paste the hex values into the prompt; models drift to purple AI-glow
otherwise. These are the site's live tokens.

```
ink        #0A0B0D   the page ground, always
surface    #0F1013   raised panels
line       #1C1F24   hairline borders
amber      #F0A030   THE accent — one signal, nothing competes with it
cream      #F4F5F7   primary text
```

---

## Should Neko be anime-styled?

**Yes, as a character in the hero — and never as the mark.**

An earlier version of this file said to keep the character out of the hero, on the grounds that
cindy.cn uses no illustration. That was wrong. cindy.cn loads its art lazily; its hero does carry a
painted anime character with a black cat, set opposite the wordmark. Recorded here so nobody plans
around the mistake.

What survives the correction is the boundary between two different objects:

- The **mark** is `assets/neko-icon.png`. It stays exactly as drawn, in the nav, the favicon and the app
  icon.
- The **character** appears beside the mark and never instead of it: the hero, the social card, a 404
  page, stickers, community posts.

The site is already built for this. `.hero-grid` becomes two columns only when `/neko-hero.png` exists,
so the page is correct today and gains the character the moment that file lands — no code change.

One constraint the design direction imposes: the page is deliberately austere, so **the character is its
single loud element**. It has to carry the amber signal on the near-black ground, or it reads as a
sticker pasted onto someone else's website.

---

> **Status: A1, B1, B2 and the 404 have shipped.** Only the optional consistency set (A2 — cut-out,
> sticker sheet) is still unmade, and it needs a fresh generation rather than anything derivable from
> what exists.
>
> **A2's transparent cut-out was deliberately NOT produced.** Keying the black out of the delivered
> character leaves a chewed edge on fur, which is the exact failure this file warns about — and the
> compositing the cut-out was for (`mix-blend-mode: screen`) does the job better with no cut at all.
> A worse asset that ticks a box is not progress.
>
> **Status: A1 and B1 have shipped.** The hero character and the backdrop are live at
> `cloudflare/site/public/neko-hero.webp` and `hero-bg.webp`, and the social card is built from them at
> `og.jpg` / `og-vi.jpg`. The prompts below produced them and are kept so the set can be extended in the
> same hand. Two things learned in the process, which now apply to every character asset:
>
> - **Generate on pure black and composite with `mix-blend-mode: screen`.** Black resolves to the
>   backdrop exactly, so fur and rim light survive with no cut-out step and no chewed silhouette.
> - **The model returned a white cat where the prompt asked for a black one.** That is fine — it reads
>   better against the dark frame — but it means the character is now defined by the delivered image, not
>   by the prompt. Attach `neko-hero.webp` to every later generation.

## A1 — The hero character *(generate this first)*

Target: `cloudflare/site/public/neko-hero.png`, portrait 3:4, displayed at 360×480. Generate on the
site's own background colour so it composites with no cut-out step.

> A portrait illustration of a mascot character named Neko, in a clean modern anime style with crisp cel
> shading, confident dark linework and painterly rim light — studio production quality, not soft pastel
> fan art. The character is a black cat with a slightly angular, technical silhouette, sitting upright
> and alert like a companion beside a workstation, head turned three-quarters toward the viewer, calm
> and attentive rather than cute. Its eyes glow warm amber (#F0A030) and are the brightest point in the
> frame. A single thin amber rim light traces its back and one ear; everything else falls into near
> black. One small amber underscore glyph floats near it like a terminal cursor. Background is flat
> near-black #0A0B0D with no scenery, no room, no desk and no devices — the character sits in empty
> space. Palette strictly limited to #0A0B0D, #1C1F24, #F0A030 and #F4F5F7. Vertical portrait
> composition, full body, centred, with generous empty space above the head and below the paws.
> No text, no letters, no numbers, no logo, no watermark, no glow bloom, no neon, no purple, no
> cyberpunk city, no lens flare. Aspect ratio 3:4.

**If you want the cindy.cn read instead** — a human character holding the cat — swap the first two
sentences for: *"A portrait illustration of a calm young engineer in a plain dark jacket, holding a small
black cat with glowing amber eyes against their shoulder, both looking toward the viewer."* Keep every
other sentence, especially the palette and the empty background. Pick one and stay with it; two
characters in one brand is how a visual identity comes apart.

**After generating:** save at 720×960 (2× the display size, for retina), keep it under about 300 KB, and
drop it at `cloudflare/site/public/neko-hero.png`. Nothing else needs changing — reload and the hero
becomes two columns.

## A2 — Consistency pass (only once A1 is chosen)

Attach A1 to every later generation and ask for the same character. Assets worth having, in order of
value: a transparent cut-out for compositing into the OG card, a 404 pose (same character alone in a
large empty frame, looking up and away, one amber dash far from it), and a 3×2 sticker sheet of chibi
expressions with a thick cream die-cut outline.

---

## B1 — Social / Open Graph card *(generate this second)*

The site currently serves `assets/social-preview.png`, which is on-brand but says nothing about the
product. This is the asset most people will actually see, because it is what renders when the link is
pasted anywhere.

**Do not generate the whole card.** Generate the backdrop, then composite the words.

> An abstract technical backdrop for a developer tool, near-black #0A0B0D, extremely restrained. A faint
> large-scale grid of thin straight lines at roughly 6 percent opacity, a few small amber #F0A030
> crosshair plus-marks scattered sparsely like registration marks, and one soft amber glow bleeding in
> from the lower right corner at low intensity. Flat, editorial, print-like — the endpaper of a technical
> manual. Nothing in the centre; leave the left two thirds visually empty for text. No devices, no
> screens, no people, no circuits, no neon, no purple, no 3D render, no perspective.
> No text, no letters, no numbers, no logo, no watermark. Aspect ratio 1200x630.

Then composite at exactly **1200×630** and screenshot:

- `assets/neko-icon.png` at 64 px, top left, with `NEKO CORE` beside it in the monospace face
- headline, one line — EN: **It runs on your computer. It asks before it acts.**
- the same card in Vietnamese as `og-vi.png` — **Nó chạy trên máy bạn. Và hỏi trước khi ra tay.**
- footer strip: `neko.holilihu.online` · `MIT` · `Windows · macOS · Linux`
- optional: the A2 cut-out at the right edge, bottom-aligned, about 38% of the height

Save to `cloudflare/site/public/og.png`, then point `og:image` at it in `index.html` — it currently
falls back to `social-preview.png`.

## B2 — README banner *(done — kept for regeneration)*

`assets/neko-core-banner.png` was 1.9 KB of black-on-white pixel art; it is now the delivered backdrop
with the mark, the wordmark and the character composited over it. The source is
`cloudflare/site/banner-card.html` — render it at 1280x320 and crop, the same way the social card is
made. Generate a new backdrop only if the look should change:

> A wide, restrained technical banner backdrop, near-black #0A0B0D, aspect ratio 4:1. One thin amber
> #F0A030 horizontal rule across the lower third, a sparse scatter of small amber plus-marks, and a
> barely visible large grid. Flat and print-like, with deep empty space through the middle for a
> wordmark. No devices, no glow orbs, no circuits, no neon, no purple, no 3D.
> No text, no letters, no numbers, no logo, no watermark. 1280x320.

---

## Assets you should NOT generate

| Asset | Why not | Do this instead |
|---|---|---|
| Product screenshots | A generated "terminal" always contains fake code and gibberish text | Capture a real session. The site marks its terminal up in HTML so the text is real and translatable |
| Architecture diagrams | Image models cannot draw an accurate box-and-arrow diagram, and a wrong one is worse than none | Hand-author SVG, or Mermaid in the docs |
| The logo, favicon, app icon | Already exist and are deliberately pixel-exact | `assets/neko-icon.png`, `assets/neko.ico`, `assets/avatar-512.png` |
| Anything containing a UI | Generated UI shows affordances we do not ship | Screenshot the real thing |

---

## Workflow

1. Generate **A1**, pick one of the two readings, and drop the file in. The hero changes on reload.
2. Generate the **B1** backdrop, composite the card, ship it, and update `og:image`.
3. Keep source art in `assets/character/`; put only final web-sized files in
   `cloudflare/site/public/`. That directory is served to the public byte for byte.
4. Attach A1 to every later character generation. That is what keeps the design from drifting between
   assets.
