# Deploy neko.holilihu.online

The landing page for Neko Core, plus the two installer paths the README promises. Static files served
by a Cloudflare Worker; no build step, no framework, no external requests from the page.

```
cloudflare/site/
  public/index.html     markup, in English, with data-i18n keys
  public/styles.css     the brand system: ink/cream bands, amber accent, monospace headings
  public/app.js         Vietnamese dictionary, platform detection, install tabs, copy
  public/*.png|ico      brand assets, copied from /assets
  worker.js             /install.sh and /install.ps1 -> raw.githubusercontent; everything else -> assets
  wrangler.toml         the deploy config
```

## Before you start: there is already something on this hostname

`neko.holilihu.online` currently resolves to Cloudflare and serves **redirects**, not a site:

| Path | Today | After this deploy |
|---|---|---|
| `/install.sh` | 302 -> `raw.githubusercontent.com/meiiie/neko-core/main/install.sh` | unchanged (the Worker does the same 302) |
| `/install.ps1` | 302 -> `.../install.ps1` | unchanged |
| `/` | 302 -> `github.com/meiiie/bang_c` | the landing page |

That last row is a live bug: the root of the public install domain points at the **frozen predecessor
repo**. Deploying this fixes it — but only if the old rule is removed, because **Cloudflare Redirect
Rules run before Workers**. If a redirect rule still matches `/`, visitors keep landing on GitHub and the
Worker never runs.

So: find the existing rule first, in the dashboard under **holilihu.online -> Rules -> Redirect Rules**
(also check **Bulk Redirects** and **Page Rules**). Note exactly what it matches, then delete or narrow
it to leave `/` alone. Keep or delete the `/install.*` rules as you like — the Worker handles those two
paths either way, and a surviving rule simply wins first with the same result.

## Deploy

Wrangler needs an interactive browser login, so run these yourself:

```bash
cd cloudflare/site
npx wrangler login      # opens a browser; authorize the account that owns holilihu.online
npx wrangler deploy
```

It prints a `https://neko-site.<your-subdomain>.workers.dev` URL. Check that first — it bypasses every
redirect rule, so it tells you whether the deploy itself is good before DNS is involved:

```bash
curl -sI https://neko-site.<subdomain>.workers.dev/ | head -1          # HTTP/2 200
curl -sI https://neko-site.<subdomain>.workers.dev/install.sh | head -2 # 302 -> raw.githubusercontent
```

## Attach the domain

Dashboard -> **Workers & Pages** -> `neko-site` -> **Settings** -> **Domains & Routes** -> **Add** ->
**Custom domain** -> `neko.holilihu.online`. Cloudflare replaces the existing DNS record for that
hostname and issues the certificate itself; nothing to configure in DNS by hand.

## Verify (do all four)

```bash
curl -sI https://neko.holilihu.online/ | head -1                        # 200, not 302
curl -sIL https://neko.holilihu.online/install.sh | grep -i '^location' # raw.githubusercontent .../install.sh
curl -sIL https://neko.holilihu.online/install.ps1 | grep -i '^location'
curl -fsSL https://neko.holilihu.online/install.sh | head -3            # the real installer, not HTML
```

The last one is the one that matters. `curl … | sh` is printed in the README, inside both installer
scripts, and in every release note: if it ever returns HTML, every new user's first command fails.

## The scales are measured, not asserted

`audit.js` (next to this file) walks every rendered element and reports anything off the spacing or type
scale, every control under 44px on its short edge, and any text column past ~78ch. Run it after any
visual change:

```js
// copy audit.js into public/, then in the console:
const src = await (await fetch("/_audit.js")).text();
for (const w of [320, 390, 430, 768, 1024, 1440]) {
  const f = document.createElement("iframe");
  f.src = "/"; f.width = w; f.height = 900; document.body.appendChild(f);
  await new Promise(r => { f.onload = r; setTimeout(r, 2200); });
  f.contentWindow.eval(src);
  console.log(w, f.contentWindow.__audit(String(w)));
  f.remove();
}
```

Take the file back out of `public/` before deploying — it is a tool, not part of the site.

The current state: zero off-scale values and zero targets under 44px at all six widths, with four
documented exemptions listed at the top of `styles.css`. Things it caught that eyeballing had not:
button padding at 9/20 and 14/30, section rhythm at 72, the gutter at 40, five separate uses of 15px
type, a language control at 39×32, `sha256` links at 20×20, and a nav that needed 380px of content
inside 312px of usable width at 360px — where the wordmark and the CTA were overlapping.

## Changing the page

Edit `public/index.html` and run `npx wrangler deploy` again. Two things to keep in mind:

- **English lives in the markup, Vietnamese lives in `app.js`.** Add a `data-i18n="some.key"` to the
  element with the English text inside it, then add `"some.key"` to the `VI` object. A key with no
  translation falls back to the English already in the page, so a half-finished translation degrades to
  English rather than to a blank element — and a crawler or a reader with JavaScript off still gets a
  real page. To check nothing was missed:

  ```js
  // paste in the browser console after switching to Vietnamese
  [...document.querySelectorAll("[data-i18n]")].filter(n => !n.innerHTML.trim())
  ```

- **Download links use GitHub's `releases/latest/download/` permalinks**, so a new release needs no site
  change. The file *sizes* printed next to them are hardcoded — update them when a build's size moves
  by more than a few MB, or drop them.
- **Claims on this page are checkable.** Everything it says about tools, gating, offline use and the
  oracle is true of the shipped binary. Keep it that way; a landing page that oversells is a support
  burden, not marketing.
- **Images are compressed with ffmpeg, not committed raw.** The generated art arrives at 1–1.5 MB; the
  whole `public/` directory is 276 KB because everything goes through this:

  ```bash
  # the hero character: 3:4, screened over the frame, so its pure-black ground must survive
  ffmpeg -i src.png -vf "scale=720:-1:flags=lanczos" -quality 90 public/neko-hero.webp
  # the hero frame backdrop and the OG backdrop
  ffmpeg -i bg.png  -vf "scale=1440:-1:flags=lanczos" -quality 82 public/hero-bg.webp
  ffmpeg -i bg.png  -vf "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630" -quality 85 public/og-bg.webp
  ```

- **The demo clip is a real recording, cut and compressed, never re-enacted.** A 116-second screen
  capture (57 MB) becomes a 30-second loop under 450 KB. The poster is a still of the *finished*
  dashboard, so the page shows the outcome before anyone presses play:

  ```bash
  ffmpeg -ss 42 -t 30 -i run.mp4 -an -vf "scale=1280:-2:flags=lanczos"          -c:v libx264 -crf 31 -preset slow -movflags +faststart -pix_fmt yuv420p public/demo-excel.mp4
  ffmpeg -ss 42 -t 30 -i run.mp4 -an -vf "scale=1280:-2:flags=lanczos"          -c:v libvpx-vp9 -crf 42 -b:v 0 -row-mt 1 public/demo-excel.webm
  ffmpeg -i run.mp4 -vf "select='gte(t,108)',scale=1280:-2" -frames:v 1 -vsync 0 public/demo-excel-poster.webp
  ```

  `preload="none"` means nobody pays for the video until they ask for it, and the caption says plainly
  that it is unedited. If the recording is ever re-shot, keep both of those true.

- **The social card is regenerated, not hand-edited.** `og-card.html` (next to this file) is the source:
  copy it into `public/`, open it, screenshot, and crop. The viewport screenshot is scaled by
  `screenshotWidth / window.innerWidth` — 1.0208 on the machine this was built on — so the crop is
  `1200 × 630` multiplied by that factor, then scaled back down:

  ```bash
  ffmpeg -i shot.jpg -vf "crop=1225:643:0:0,scale=1200:630:flags=lanczos" -q:v 3 public/og.jpg
  ```

  Set `?lang=vi` (or overwrite `#head` from the console) for `og-vi.jpg`. Do not ask an image model to
  render the words — Vietnamese diacritics come back as gibberish.

- **The cat is composited, never cut out.** It was generated on pure black and is drawn with
  `mix-blend-mode: screen` inside `.art-frame`, where black resolves to the backdrop exactly and the fur
  edges stay intact. Keying it out by hand leaves a chewed silhouette. If you regenerate the character,
  keep the background pure `#000` or this stops working.

- **Art briefs** for the OG card, the README banner and the mascot are in
  [`docs/marketing/IMAGE-BRIEFS.md`](../../docs/marketing/IMAGE-BRIEFS.md). The short version: generate
  art only, never text — then composite the words in HTML and screenshot, or the Vietnamese diacritics
  come out as gibberish.
