# Image briefs — Neko Core

Ready-to-paste prompts for generating the visual assets the site, README and social cards need.
Companion to `assets/video-kit/README.md` (video) and `05-brand-board.png` (the system itself).

---

## Read this before generating anything

**1. The mark is not up for redesign.** `assets/neko-icon.png` — the amber pixel `/\_ _/\` — is the
logo. Every asset below either uses those exact pixels or does not show a mark at all. This is the
existing hard rule from the video kit: *do not replace the mark with a generic cat, robot, sparkle,
brain, or purple AI orb.*

**2. Never ask an image model for text.** Image models still render typography as convincing gibberish,
and half of these assets are bilingual. Generate **art only** — character, texture, background — and
composite the words afterwards in HTML/CSS, then screenshot at the exact pixel size. That is how
`social-preview.png` was made, it is why it is crisp, and it is the only way the Vietnamese diacritics
come out right. Every prompt below therefore ends with *no text, no letters, no numbers, no watermark*.

**3. The palette is fixed.** Paste the hex values into the prompt; models drift to purple AI-glow
otherwise.

```
ink       #0E0E12   background, always
panel     #16161C   raised surfaces
amber     #F0A030   THE accent - one signal, nothing competes with it
cream     #F4F1EA   light bands
ok green  #3ECF6E   only for "passed"
cyan      #2ED9D9   only for keys/labels in code
```

---

## Should Neko be anime-styled?

Short answer: **a character, yes. The identity, no.** Three reasons, then the scope.

- The reference you liked, `cindy.cn`, contains **zero illustration**. Its whole force is typography,
  numbered section markers, one red accent and a rotated ticker. We already match that structurally. So
  anime is not what would close the gap with it — nothing is; we are there.
- Neko's own brand board commits to "quiet dark-tech, one amber signal, pixel mark plus monospace
  product type". A soft-shaded anime hero contradicts that in one screen, and a landing page that
  contradicts its product's own visual language reads as a template.
- But a **character is not a mark.** Cursor, Ollama, Bun, Hugging Face all run a character alongside a
  strict wordmark. For a Vietnamese-first tool that wants non-engineers to try it, a friendly Neko is a
  real asset — it just belongs where a character helps and typography cannot.

**Scope it to:** the social/OG card, a 404 page, README section breaks, stickers and community posts,
and the Vietnamese-language social posts. **Keep it out of:** the logo, the favicon, the app icon, the
hero, and anything inside the product.

---

## A1 — Character sheet (the one anime asset)

Generate once, reuse forever. Ask for a sheet, not a single pose, so later assets stay consistent.

> A character reference sheet for a mascot named Neko, drawn in a clean modern anime style with crisp
> flat cel shading and confident dark linework — closer to a studio production sheet than to soft
> pastel fan art. The character is a small black cat with a slightly angular, technical silhouette and
> two glowing amber eyes (#F0A030), sitting or standing upright like a companion, calm and attentive
> rather than cute-aggressive. Its only marking is a thin amber underline motif on the chest, echoing a
> terminal cursor. Background is flat near-black #0E0E12. Palette strictly limited to #0E0E12,
> #16161C, #F0A030 and #F4F1EA. Show four views arranged in a row: front sitting, three-quarter
> standing, side profile walking, and a close-up of the face. Even studio lighting, no gradients on the
> background, no glow effects, no neon, no purple, no lens flare, no cyberpunk city.
> No text, no letters, no numbers, no logo, no watermark. 16:9.

Save as `assets/character/neko-sheet.png`.

## A2 — Character cut-out for compositing

Run after A1, attaching A1 so the model matches it.

> The same cat character from the attached reference sheet, single figure, three-quarter view, sitting
> upright and looking slightly toward the viewer's right, as if watching a screen just out of frame.
> Same flat cel shading, same dark linework, same amber eyes #F0A030. Fully isolated on a plain solid
> background for cut-out, with a clean silhouette and no cast shadow.
> No text, no letters, no numbers, no logo, no watermark. Square.

Save as `assets/character/neko-cut.png`, then remove the background and keep a transparent PNG.

## A3 — Sticker set (optional, community)

> Six small chibi expressions of the attached cat character in the same flat anime style, arranged in a
> 3x2 grid, each fully isolated with a thick cream #F4F1EA outline like a die-cut sticker: thinking,
> approving with a raised paw, sleeping, surprised, focused at work, and waving. Flat colours only,
> palette limited to #0E0E12, #F0A030 and #F4F1EA, no gradients, no glow.
> No text, no letters, no numbers, no watermark. 3:2.

---

## B1 — Social / Open Graph card (highest value — do this first)

The site currently serves `assets/social-preview.png`, which is correct but says nothing about the
product. Replace it with a card that carries the promise.

**Do not generate this whole card.** Generate only the backdrop, then composite.

Backdrop prompt:

> An abstract technical backdrop for a developer tool, near-black #0E0E12, extremely restrained. A
> faint large-scale grid of thin lines at about 6 percent opacity, a few small amber #F0A030 crosshair
> plus-marks scattered sparsely as registration marks, and one soft amber glow bleeding in from the
> lower right corner at low intensity. Flat, editorial, print-like — like the endpaper of a technical
> manual. Nothing centred; leave the left two thirds visually empty for text. No devices, no screens,
> no people, no circuits, no neon, no purple, no 3D render.
> No text, no letters, no numbers, no logo, no watermark. 1200x630.

Then composite in HTML at exactly **1200x630** and screenshot:

- `assets/neko-icon.png` at 64px, top left, plus `NEKO CORE` in the monospace face
- headline, one line, EN: **It works on your machine. It asks before it acts.**
- headline, VI (separate card `og-vi.png`): **Nó chạy trên máy bạn. Và hỏi trước khi ra tay.**
- footer strip: `neko.holilihu.online` · `MIT` · `Windows · macOS · Linux`
- optional: A2's cut-out character at the right edge, bottom-aligned, about 38% of the height

Save as `cloudflare/site/public/og.png` (and `og-vi.png`), then point `og:image` at it in
`index.html` — it currently falls back to `social-preview.png`.

## B2 — README banner

Replaces `assets/neko-core-banner.png`, which is only 1.9 KB and shows at low quality on GitHub.
Same rule: generate the backdrop, composite the words.

> A wide, very restrained technical banner backdrop, near-black #0E0E12, aspect ratio 4:1. A single
> thin amber #F0A030 horizontal rule running across the lower third, a sparse scatter of small amber
> plus-marks, and a barely visible large grid. Flat and print-like, deep empty space in the middle for
> a wordmark. No devices, no glow orbs, no circuits, no neon, no purple, no 3D.
> No text, no letters, no numbers, no logo, no watermark. 1280x320.

## B3 — 404 page

The one place the character earns its keep unaccompanied.

> The attached cat character sitting alone in a large empty near-black #0E0E12 space, small in frame,
> looking up and to the right at nothing, one amber #F0A030 cursor-like dash floating far away from it.
> Melancholy but not sad, lots of negative space, flat anime cel shading, no gradients, no glow.
> No text, no letters, no numbers, no watermark. 16:9.

---

## C — Assets you should NOT generate

| Asset | Why not | Do this instead |
|---|---|---|
| Product screenshots | A generated "terminal" always contains fake code and gibberish text | Capture a real session. `assets/video-kit/04-terminal-real.png` is one; the site uses hand-marked-up HTML so the text is real and translatable |
| Architecture diagrams | Image models cannot draw an accurate box-and-arrow diagram, and a wrong one is worse than none | Hand-author SVG, or Mermaid in the docs |
| The logo / favicon / app icon | Already exists and is deliberately pixel-exact | `assets/neko-icon.png`, `assets/neko.ico`, `assets/avatar-512.png` |
| Anything with a UI in it | Generated UI has invented affordances we do not ship | Screenshot the real thing |

---

## Workflow

1. Generate **A1** first. Everything else that shows the character attaches A1 as a reference — that is
   what keeps the design from drifting between assets.
2. Generate the **B1 backdrop**, composite the card, and ship it. That is the single asset most people
   will actually see, because it is what appears when the link is pasted anywhere.
3. Put source art in `assets/character/`, and only the final web-sized files in
   `cloudflare/site/public/`. The site directory is served to the public byte for byte; nothing large
   or unfinished belongs in it.
4. Re-run `bun run build` only if you changed anything under `assets/` that the binary bundles
   (`neko-icon.png` and the computer-use helpers are bundled; marketing art is not).
