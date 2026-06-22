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
