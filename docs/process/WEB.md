# Neko Code — web access

Two layers, simplest first.

## 1. Built-in (no setup, no API key)
- **`web_search`** — DuckDuckGo HTML; returns top results (title · url · snippet).
- **`web_fetch`** — fetches a URL, strips HTML to text. With a `prompt`, a single fast model pass
  extracts just what you asked (Claude-style) instead of dumping the whole page.

Good for: docs, articles, plain pages, quick lookups. Limits: no JavaScript rendering, and
bot-protected / logged-in sites will block a plain fetch.

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
