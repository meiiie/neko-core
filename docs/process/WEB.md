# Neko Core — web access

Two layers, simplest first.

## 1. Built-in (no setup, no API key)
- **`web_search`** — pluggable backend, auto-picked: **SearXNG** (if `searxng_url` set) → **Tavily**
  (if `TAVILY_API_KEY` env or `tavily_api_key` config set) → **DuckDuckGo** (default, zero-config).
  Failures walk DOWN the ladder — SearXNG down falls to Tavily (when a key is wired), then DuckDuckGo —
  never straight to the floor. `neko doctor` shows the active one.
- **`web_fetch`** — fetches a URL as clean **Markdown** (deterministic HTML→markdown: keeps headings,
  links, lists; drops nav/footer/scripts — a flat text-strip used to throw links away). A **small page
  comes back whole with NO model call** (fast + cheap — the markdown IS the answer); a **large page
  paginates in resumable 40k-character windows** (`page:N` in the footer), below the agent observation
  guard, instead of truncating and silently dropping the middle; results
  cache ~5 min so pagination doesn't re-download. With a `prompt`/`schema` on a *large* page, a single
  fast model pass still extracts just what you asked (now over clean markdown). *(Size policy + compact
  reads learned from Hermes Agent + lightweight scrapers; our own implementation.)*
  - **Deterministic platform routes** (CODE routes, not a skill the model can ignore, so it can't fumble
    a known URL): a **YouTube** video → its **transcript** via `yt-dlp`; a **GitHub** repo/issue/PR →
    `gh`; an **RSS/Atom** feed → a compact item list. Each falls back to a normal fetch if the tool is
    missing/unauthenticated.
  - **`scrape_backend: "jina"`** (opt-in) routes through Jina Reader (`r.jina.ai`) which renders public
    JS/SPAs server-side and returns markdown — free + keyless for light use, `JINA_API_KEY` lifts the
    rate limit. PUBLIC pages only (anonymous — no login).

Good for: docs, articles, plain pages, quick lookups, YouTube transcripts, GitHub, feeds. Limits: a
plain fetch renders no JavaScript (use `scrape_backend: "jina"` for public SPAs); **login-required feeds
(FB / X / IG / LinkedIn) need your session** — see §2 (browser MCP) and the `web-reach` skill, which also
warns about the ToS/account-ban risk of automating a logged-in social account. The `web-reading` skill
teaches efficient reads (a11y/markdown first, grab-once, no scroll-churn).

### Reliable extraction: the LLM extracts, code computes
A model is unreliable at exact number transcription and arithmetic — dogfooding caught gpt-oss
reading the VN price "31.990.000đ" as `31`, picking a pricier source when it had already seen a
cheaper one, and producing a wrong sum. The 2026 consensus on reliable extraction is to split the
job: the **LLM only extracts each value VERBATIM** (the price exactly as written), and
**deterministic code parses, sorts, and does min/max/sum/median** — never the model. Don't ask an
LLM to be a calculator; ask it to transcribe, then call one. (Refs: structured-output / agentic-
pattern guides and "why LLMs struggle at math", 2026.)

In practice this lives in `skills/procurement/scripts/price-table.ts` (`parseVnd` + sort + stats +
outlier flags), and the procurement skill tells the model to write prices as verbatim strings and
run it. Because it's deterministic, it's unit-tested (`test/price-table.test.ts`) — the model isn't.
The same principle is the right shape for any future numeric extraction (specs, dates, quantities):
extract verbatim, compute in code.

### One command: `neko setup web`
Stands up the whole SOTA web stack and wires it into config (idempotent, key-safe):
SearXNG in Docker (JSON API on) + the browser MCP (headed real-Chrome). Verifies the JSON
API, then `neko doctor` shows `web_search: searxng`. Sub-targets: `neko setup searxng` /
`neko setup browser`. Browser setup defaults to a dedicated persistent Chrome profile, so login
survives restarts. Use `neko setup browser attach` for an existing signed-in Chrome tab (official
Playwright Extension), or `neko setup browser isolated` for disposable testing. (No Docker? It says
so and you can use a Tavily key instead.) The
manual recipe below is what it automates.

### Managed lifecycle - the Ollama pattern applied to search (2026-07-10)
After setup, the user never touches Docker again. The container has NO restart policy on
purpose: `web_search` **wakes it on demand** (a connection failure triggers one
`docker start` + health poll, then the search retries - first search after idle pays ~5-10s)
and **auto-stops it after `searxng_keepalive` idle minutes** (default 15; `0` = keep running)
- including a process-exit cleanup so a short `neko run` can't leak a running container.
A container Neko did NOT start is never stopped, and Docker Desktop itself is never launched
or killed. Honest boundary: this frees the CONTAINER's RAM between uses; Docker Desktop's own
baseline is the user's call. Daemon down -> the search falls through the ladder fast (~100ms)
instead of blocking. `neko doctor` reports the truth ("container stopped - starts on demand").
Zero-config users with Docker installed get a ONE-TIME tip in web_search results: ask Neko to
run `neko setup web` (the normal bash approval gate applies) and the private backend is theirs.
Why not "SearXNG without Docker"? Measured 2026-07-10: SearXNG has no native-Windows support
(WSL/Docker are the official paths), and a native in-binary multi-engine aggregator is a dead
end today - live probes from a VN residential IP: Bing serves 0 organic results to non-browser
clients, Mojeek walls with a captcha, Brave 429s, Ecosia 403s; only DuckDuckGo's html endpoint
still parses. The anti-bot arms race is exactly what the SearXNG community maintains full-time
- so Neko manages the sidecar instead of reimplementing it.

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

Or use **Tavily** (search built for agents) with a free key — the no-Docker rung. One command
verifies the key live and wires it into the gitignored user config (redacted by `neko config`):
`neko setup tavily <key>` (get one at https://app.tavily.com), or keep it env-only with
`export TAVILY_API_KEY=tvly-...` (env wins over config). Force a backend with
`"search_backend": "searxng" | "tavily" | "duckduckgo"`.

The rest of browser-search (Camofox / CloakBrowser for anti-bot, JS-heavy pages) is **browser
automation** — that's §2's job. browser-search ships as a `SKILL.md`, so you can drop it straight
into `~/.neko-core/skills/` (Neko loads `.md` skills) and run its Docker tools yourself; Neko needs
no code for that.

## 2. Real browser (JS pages, bot-protected, logged-in) — via MCP
For "real-world" web like ds4-agent (a real, non-headless Chrome that looks human and runs JS),
use a **browser MCP server** — the same way Goose does browser (an MCP/extension, not core). Neko
already speaks MCP, so this needs **no Neko code**, no core bloat, and stays a single binary.

The normal path is one command:

```text
neko setup browser                 # persistent Neko profile; sign in once
neko setup browser attach          # reuse existing Chrome tabs/login through the extension
neko setup browser isolated        # disposable state for tests/untrusted pages
```

The persistent form written to `~/.neko-core/config.json` is:

```json
{
  "mcp_servers": {
    "browser": { "command": "bunx", "args": ["@playwright/mcp@latest", "--browser", "chrome", "--user-data-dir", "~/.neko-core/browser/default"] }
  }
}
```

Then the agent gets the server's browser tools (navigate, click, read, screenshot…) automatically
(`neko mcp` lists them). Attach mode uses Microsoft's Playwright Extension and asks which real tab
to share; it reuses the browser's cookies without copying them into Neko. Do not copy Chrome's
default profile or cookie database. Chrome 136+ intentionally rejects remote debugging against the
default data directory; use the extension or Neko's dedicated profile. A persistent profile has one
browser-process owner; use attach mode when concurrent Neko sessions must share the already-running Chrome.
The dedicated profile persists Chrome's normal cookies, local storage, and related site state for every origin,
not only Facebook. A user still signs in once per service (X, Gmail, GitHub, and so on), and each service remains
free to expire or revoke its own server-side session, request 2FA/checkpoints, or block automation. Persistence
therefore removes Neko's artificial re-login cycle; it cannot promise that a third-party login never expires.

**Why not bake Playwright into Neko's core?** It's a heavy dependency + a ~150MB browser, can't be
verified headlessly, and would break the standalone single binary. MCP is the clean seam (Goose,
Claude Code, and others all do browser this way). Built-in `web_*` covers the simple 90%.

### Neko-owned explicit-tab bridge (developer preview)

For a Claude/Codex-style one-click attachment with Neko's own permissions and audit surface:

```text
/browser                  # preferred: guided setup/status without leaving the interactive Neko session
neko browser install      # non-TUI fallback + foreground live bridge (never requires Bun/source checkout)
neko browser bridge       # foreground diagnostic; normal Neko sessions auto-start it after setup
neko browser path         # folder to Load unpacked in chrome://extensions
neko browser rotate       # revoke pairing for the next bridge start
```

The extension uses `activeTab`, separate click/type grants, sensitive-field blocking, cross-origin detach,
a visible `Neko is using this tab` marker, conservative tab grouping, and emergency stop. Public Store and
unpacked extension ids are exact config values under `browser_extension_ids`; the bridge never accepts a
wildcard extension Origin. Its redacted attached/offline status may travel inside `/relay`'s E2E-encrypted presence;
cookies, page content and the bridge capability never do. Full design: `BROWSER-BRIDGE.md`.

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
