import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ToolRegistry } from "../src/core/tool-runtime.ts";

const root = mkdtempSync(tmpdir() + "/nk-web-");
const reg = () => new ToolRegistry(root, "auto", () => true);
const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  delete process.env.TAVILY_API_KEY;
});
const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("web_search uses SearXNG when searxng_url is set", async () => {
  globalThis.fetch = (async (url: any) => {
    expect(String(url)).toContain("/search?format=json");
    return json({ results: [{ title: "TS docs", url: "https://ts.org", content: "TypeScript <b>typing</b>" }] });
  }) as any;
  const r = reg();
  r.searxngUrl = "https://searx.local/";
  const out = await r.execute("web_search", { query: "typescript" });
  expect(out).toContain("TS docs");
  expect(out).toContain("https://ts.org");
  expect(out).toContain("TypeScript typing"); // html stripped from the snippet
});

test("web_search uses Tavily when TAVILY_API_KEY is set (and forced)", async () => {
  process.env.TAVILY_API_KEY = "tvly-x";
  globalThis.fetch = (async (url: any) => {
    expect(String(url)).toContain("api.tavily.com");
    return json({ results: [{ title: "Result", url: "https://r.com", content: "snippet" }] });
  }) as any;
  const r = reg();
  r.searchBackend = "tavily";
  const out = await r.execute("web_search", { query: "x" });
  expect(out).toContain("Result");
  expect(out).toContain("https://r.com");
});

test("web_search falls back to DuckDuckGo if the chosen backend errors", async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("searx")) throw new Error("down");
    // DDG HTML shape
    return new Response('<a class="result__a" href="https://d.com">DDG hit</a>', { status: 200, headers: { "content-type": "text/html" } });
  }) as any;
  const r = reg();
  r.searxngUrl = "https://searx.local/";
  const out = await r.execute("web_search", { query: "x" });
  expect(out).toContain("DuckDuckGo");
  expect(out).toContain("DDG hit");
});

test("web_fetch readability keeps the article, drops nav/footer", async () => {
  const body =
    "<html><head><script>junk()</script></head><body>" +
    "<nav>NAVNOISE</nav><article>" + "Real article content. ".repeat(20) + "</article><footer>FOOTNOISE</footer>" +
    "</body></html>";
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as any;
  const out = await reg().execute("web_fetch", { url: "https://x.com" });
  expect(out).toContain("Real article content");
  expect(out).not.toContain("NAVNOISE");
  expect(out).not.toContain("FOOTNOISE");
  expect(out).not.toContain("junk()");
});
