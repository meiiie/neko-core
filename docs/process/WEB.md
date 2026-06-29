# Neko Code — web access

Two layers, simplest first.

## 1. Built-in (no setup, no API key)
- **`web_search`** — pluggable backend, auto-picked: **SearXNG** (if `searxng_url` set) → **Tavily**
  (if `TAVILY_API_KEY` set) → **DuckDuckGo** (default, zero-config). Falls back to DuckDuckGo if the
  chosen backend errors. `neko doctor` shows the active one.
- **`web_fetch`** — fetches a URL, runs a light readability pass (keeps `<article>`/`<main>`, drops
  nav/footer/scripts) and strips to text. With a `prompt`, a single fast model pass extracts just
  what you asked (Claude-style) instead of dumping the whole page.

Good for: docs, articles, plain pages, quick lookups. Limits: no JavaScript rendering, and
bot-protected / logged-in sites will block a plain fetch (see §2 for those).

### One command: `neko setup web`
Stands up the whole SOTA web stack and wires it into config (idempotent, key-safe):
SearXNG in Docker (JSON API on) + the browser MCP (headed real-Chrome). Verifies the JSON
API, then `neko doctor` shows `web_search: searxng`. Sub-targets: `neko setup searxng` /
`neko setup browser`. (No Docker? It says so and you can use a Tavily key instead.) The
manual recipe below is what it automates.

### Upgrading web_search to SOTA — free, self-hosted (SearXNG)
[browser-search](https://github.com/Johell1NS/browser-search)'s core idea is **SearXNG** — a
metasearch engine that aggregates Google/Bing/DDG/… into one JSON API, free and unlimited. Run one
(Docker) and point Neko at it — no key, no per-source rate limits:

```json
// ~/.neko-core/config.json
{ "searxng_url": "http://localhost:8888", "search_backend": "searxng" }
```

**Working recipe (verified).** The catch: SearXNG **disables the JSON API by default** (and public instances
keep it off), but Neko's backend needs JSON. Enable it in a mounted `settings.yml`:

```yaml
# ~/neko-searxng/settings.yml
use_default_settings: true
server: { secret_key: "change-me", limiter: false }
search: { formats: [html, json] }
```
```bash
docker run -d --name neko-searxng --restart unless-stopped -p 8888:8080 \
  -v "$HOME/neko-searxng:/etc/searxng" searxng/searxng:latest
# verify the JSON API:  curl "http://localhost:8888/search?format=json&q=test"
```
Measured impact (gpt-oss-120b, "iPhone 14 Pro rẻ nhất VN"): DuckDuckGo found a lowest of ~18.3M and missed
the used market; **SearXNG surfaced Chợ Tốt / 24hStore / ClickBuy and found 7.99M** — same model, better
harness. If SearXNG is down, `web_search` falls back to DuckDuckGo automatically.

Or use **Tavily** (search built for agents) with a free key, env-only (never stored):
`export TAVILY_API_KEY=tvly-...`. Force a backend with `"search_backend": "searxng" | "tavily" |
"duckduckgo"`.

The rest of browser-search (Camofox / CloakBrowser for anti-bot, JS-heavy pages) is **browser
automation** — that's §2's job. browser-search ships as a `SKILL.md`, so you can drop it straight
into `~/.neko-core/skills/` (Neko loads `.md` skills) and run its Docker tools yourself; Neko needs
no code for that.

## 2. Real browser (JS pages, bot-protected, logged-in) — via MCP
For "real-world" web like ds4-agent (a real, non-headless Chrome that looks human and runs JS),
use a **browser MCP server** — the same way Goose does browser (an MCP/extension, not core). Neko
already speaks MCP, so this needs **no Neko code**, no core bloat, and stays a single binary.

Add to `~/.neko-core/config.json`:

```json
{
  "mcp_servers": {
    "browser": { "command": "bunx", "args": ["@playwright/mcp@latest"] }
  }
}
```

Then the agent gets the server's browser tools (navigate, click, read, screenshot…) automatically
(`neko mcp` lists them). For the "use your real logged-in Chrome" trick, point the MCP server at
your Chrome channel/profile per its docs (e.g. Playwright-MCP `--channel chrome`, or a CDP server
you started with `--remote-debugging-port`).

**Why not bake Playwright into Neko's core?** It's a heavy dependency + a ~150MB browser, can't be
verified headlessly, and would break the standalone single binary. MCP is the clean seam (Goose,
Claude Code, and others all do browser this way). Built-in `web_*` covers the simple 90%.

## Authenticated MCP servers
- **Static token / API key** (works today): add `headers`:
  ```json
  "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ghp_..." } }
  ```
- **Browser login (OAuth 2.1)** for servers that require it: set `"oauth": true`:
  ```json
  "linear": { "url": "https://mcp.linear.app/mcp", "oauth": true }
  ```
  On first connect Neko opens your browser, captures the redirect on `http://localhost:41789/callback`,
  and stores tokens (with refresh) under `~/.neko-core/mcp-auth/<server>/` — dynamic client
  registration + PKCE via the MCP SDK. The browser-login step runs on your machine.

## Connecting services (Google Drive, GitHub, Slack, …)
Any such integration is an MCP server, and Neko speaks every MCP transport (stdio · http · sse) plus
both auth styles above — so it connects to all of them.

**Google Drive** — two shapes, both supported:
```json
// (a) a local stdio Drive server with Google creds via env:
"gdrive": { "command": "bunx", "args": ["@isaacphi/mcp-gdrive"],
            "env": { "GOOGLE_OAUTH_CREDENTIALS": "C:/path/gcp-oauth.keys.json" } }

// (b) a hosted Drive MCP that uses browser login:
"gdrive": { "url": "https://<hosted-drive-mcp>/mcp", "oauth": true }
```
Then `neko mcp` lists its tools (search/read/list files) and the agent can use them. (Drive needs
your Google credentials — that setup is the server's, not Neko's; the connection itself is verified
the same way as the deepwiki/server-everything servers Neko already talks to.)

## Facebook / Meta (Pages, Messenger, Ads, Instagram)
**Yes — Neko connects to Facebook via MCP, no Neko code.** Mature community servers cover it; pick by
scope:
- [HagaiHen/facebook-mcp-server](https://github.com/HagaiHen/facebook-mcp-server) — Pages: post,
  comment moderation, insights, messaging (30+ tools, stdio).
- [oliverames/meta-mcp-server](https://github.com/oliverames/meta-mcp-server) — 200+ tools (Pages,
  Instagram, Threads, Ads, Commerce, Insights).
- [pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp) — Meta/Facebook Ads.

Get a `FACEBOOK_ACCESS_TOKEN` (+ `FACEBOOK_PAGE_ID`) from
[developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer), then add to
`~/.neko-core/config.json` — stdio command + env (Neko passes `env` through to the server):

```json
{
  "mcp_servers": {
    "facebook": {
      "command": "uv",
      "args": ["run", "--with", "mcp[cli]", "--with", "requests", "mcp", "run", "/path/to/facebook-mcp-server/server.py"],
      "env": { "FACEBOOK_ACCESS_TOKEN": "EAAB...", "FACEBOOK_PAGE_ID": "1234567890" }
    }
  }
}
```

`neko mcp` then lists `mcp__facebook__post_to_facebook`, `…__get_post_impressions`,
`…__filter_negative_comments`, etc., and the agent calls them like any other tool. The token is the
server's secret (kept in the gitignored user config / env), never Neko's — same trust model as the
Drive/GitHub servers above. The MCP wiring itself is the exact path verified against
`server-everything` (connect → list → call). Designing a custom server is unnecessary; if you ever
need one, it's just a stdio MCP exposing Graph-API tools — drop it in the same `mcp_servers` block.
