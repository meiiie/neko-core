# SEO — be findable by search engines AND answer engines

**Priority note:** at most hackathons SEO is NOT scored — the judges are in the room. Spend time here
only if discoverability/growth is on the rubric, or when the deliverable is a real product/launch page
that must be found. When it does matter, these are the high-leverage basics; skip the 200-item audits.

## The 2026 shift: two audiences
You're optimizing for **search engines** (Google) *and* **answer engines** (ChatGPT, Perplexity,
Gemini, Google AI Overviews) that crawl and cite you. Both reward the same foundation: fast, crawlable,
well-structured, honestly-described pages. If a bot can't parse your content without executing heavy JS,
you're invisible in both.

## On-page essentials (do these first — minutes, big return)
- **One `<title>`** per page: the real product/value + brand, ~55 chars. **A `<meta name="description">`**
  ~150 chars that a human would click. These are your SERP + share preview.
- **Open Graph + Twitter cards** (`og:title`, `og:description`, `og:image`, `twitter:card`) — controls
  how the link looks when shared (which is how a hackathon project actually spreads). A real 1200×630 image.
- **One `<h1>`** stating what the thing is; a sane heading outline below it. Semantic HTML, real text —
  not text baked into images or rendered only by JS.
- **Descriptive, stable URLs** (`/pricing`, not `/p?id=3`). **Canonical tag** to avoid duplicate URLs.
- **Alt text** on meaningful images (accessibility + image search).

## Copy-paste: the complete `<head>` (then fill the REAL values)
A real page ships this whole block, not just `<title>` + description. Replace every placeholder; pick the
JSON-LD `@type` that fits (Organization / SoftwareApplication / Product / EducationalOrganization / Event…).
```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Primary value + Brand — ≤ 60 chars</title>
<meta name="description" content="~150 chars a human would click.">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#0a0b0d">
<link rel="canonical" href="https://example.com/">
<!-- Open Graph (og:image = a real 1200x630) -->
<meta property="og:type" content="website">
<meta property="og:locale" content="vi_VN">
<meta property="og:site_name" content="Brand">
<meta property="og:title" content="Primary value + Brand">
<meta property="og:description" content="Share-preview sentence.">
<meta property="og:url" content="https://example.com/">
<meta property="og:image" content="https://example.com/og-cover.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Primary value + Brand">
<meta name="twitter:description" content="Share-preview sentence.">
<meta name="twitter:image" content="https://example.com/og-cover.png">
<!-- Inline SVG favicon (no extra request) -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230a0b0d'/%3E%3C/svg%3E">
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "Organization",
  "name": "Brand", "url": "https://example.com/", "description": "One honest sentence." }
</script>
```
When you can't host a real `og:image`/domain yet (a local file), still emit the tags with a plausible
placeholder URL and say so — the tag STRUCTURE is the deliverable; the real asset is filled at deploy.

## Structured data (helps both search + AI parse you)
- Add JSON-LD `schema.org` for the page type: `SoftwareApplication`/`Product`, `Organization`,
  `FAQPage`, `BreadcrumbList` as relevant. This is the machine-readable feed answer-engines read.

## Crawlability & indexing
- A `robots.txt` that allows crawling + points to a `sitemap.xml`. Don't accidentally `noindex` prod.
- Server-render or pre-render the content that matters (SSR/SSG). A pure client-rendered SPA hides its
  text from weaker crawlers and answer-engines. Golden-stack Next.js gives this for free.

## Performance = ranking (Core Web Vitals)
- **INP** (interaction responsiveness), **LCP** (largest paint < ~2.5s), **CLS** (no layout shift) are
  ranking signals. The `design-engine` + `golden-stacks` discipline (lean assets, no layout jank,
  optimized images, minimal JS) already buys most of this — verify with Lighthouse.
- Optimize images (right size, modern format), lazy-load below the fold, ship minimal JS.

## Content honesty (ties to `clean-writing`)
Write specific, real page copy (see `clean-writing`) — answer-engines and users both reward clear,
truthful, concrete descriptions over keyword-stuffed marketing slop. Say what it does, for whom.

## Verify
Run Lighthouse/PageSpeed on the deployed URL; view-source to confirm title/description/OG/JSON-LD are
present in the HTML (not only injected by JS); test the share preview by pasting the link. Don't claim
"SEO-ready" without these witnessed.
