# Deploy neko.holilihu.online

The landing page for Neko Core, plus the two installer paths the README promises. Static files served
by a Cloudflare Worker; no build step, no framework, no external requests from the page.

```
cloudflare/site/
  public/index.html     the whole page (styles + script inline)
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

## Changing the page

Edit `public/index.html` and run `npx wrangler deploy` again. Two things to keep in mind:

- **Both languages live in the markup.** Every user-visible string appears twice, as
  `<span class="vi">` and `<span class="en">`; CSS shows one and the toggle swaps them. If you add copy,
  add both — a missing half renders as an empty gap, not as a fallback.
- **Claims on this page are checkable.** Everything it says about tools, gating, offline use and the
  oracle is true of the shipped binary. Keep it that way; a landing page that oversells is a support
  burden, not marketing.
