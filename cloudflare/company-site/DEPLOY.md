# Deploy holilihu.online

Company site for HoLiLiHu. Static files in `public/`, no build step, no trackers.
This Worker is `holilihu-site`. Leave `cloudflare/site/` (`neko-site`) alone.

```
cloudflare/company-site/
  public/           pages, CSS, favicon, robots.txt, sitemap.xml, og.png
  worker.js         www → apex redirect, security headers, asset pass-through
  wrangler.toml     name holilihu-site, zone routes
  og-card.html      source artwork for public/og.png (not a deployed page)
```

## Dry run

Wrangler 4 is pinned by `cloudflare/feedback` (`wrangler` 4.129.0):

```bash
cd cloudflare/feedback && bun install --frozen-lockfile
cd ../company-site
node ../feedback/node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

`npx wrangler deploy --dry-run` from this directory is the same check.
A dry run bundles the Worker. It does not publish.

## Deploy

Use an already authenticated Wrangler session for the account that owns the
`holilihu.online` zone. Run `wrangler login` only when that session is missing.

```bash
cd cloudflare/company-site
node ../feedback/node_modules/wrangler/bin/wrangler.js deploy
```

Routes are zone routes, not custom domains:

- `holilihu.online/*`
- `www.holilihu.online/*`

DNS for both names already exists and is proxied. Do not switch this Worker to
`custom_domain`; that binding replaces DNS records.

`www.holilihu.online` responds with 301 to the same path on `https://holilihu.online`.
`workers_dev` stays on so the deploy also prints a `*.workers.dev` URL that skips DNS.

## Verify

```bash
curl -sI https://holilihu.online/ | head -1
curl -sI https://www.holilihu.online/ | head -8
curl -sI https://holilihu.online/missing-page | head -1
curl -s https://holilihu.online/robots.txt
```

Expect 200 on `/`, 301 from `www` to the apex, and 404 (the company 404 page) on an unknown path.

## Social image

`public/og.png` is a screenshot of `og-card.html` at 1200×630. Regenerate it
with headless Chrome if the card copy changes; do not typeset the words in an
image model (Vietnamese diacritics come back wrong).
