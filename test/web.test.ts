import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { __resetHintForTest, __setSidecarForTest, webPort } from "../src/adapters/web.ts";
import { SearxngSidecar, type Exec } from "../src/adapters/sidecar.ts";

const root = mkdtempSync(tmpdir() + "/nk-web-");
const reg = () => { const r = new ToolRegistry(root, "auto", () => true); r.web = webPort; return r; };
const ORIG_FETCH = globalThis.fetch;
// An INERT sidecar (no docker on the test machine is ever touched) + a silent hint probe. Every test
// runs deterministic; the wake/hint paths inject their own doubles.
const inertExec: Exec = () => ({ status: 1, stdout: "", stderr: "no docker in tests" });
beforeEach(() => {
  __setSidecarForTest(new SearxngSidecar({ exec: inertExec }));
  __resetHintForTest(() => false);
});
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

test("web_search falls back to DuckDuckGo if the chosen backend errors (wake declined honestly)", async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("searx")) throw new Error("down");
    // DDG HTML shape
    return new Response('<a class="result__a" href="https://d.com">DDG hit</a>', { status: 200, headers: { "content-type": "text/html" } });
  }) as any;
  const r = reg();
  r.searxngUrl = "https://searx.local/";
  const out = await r.execute("web_search", { query: "x" });
  expect(out).toContain("searxng failed: down");
  expect(out).toContain("DuckDuckGo");
  expect(out).toContain("DDG hit");
});

test("web_search WAKES a stopped managed SearXNG container and retries once (Ollama keep_alive pattern)", async () => {
  let searxCalls = 0;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("searx")) {
      searxCalls++;
      if (searxCalls === 1) throw new Error("ECONNREFUSED"); // container asleep
      return new Response(JSON.stringify({ results: [{ title: "Fresh", url: "https://fresh.vn", content: "woke" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("no other fetch expected");
  }) as any;
  class WakeOk extends SearxngSidecar { override async ensureUp() { return { ok: true, reason: "started" }; } override touch() {} }
  __setSidecarForTest(new WakeOk({ exec: inertExec }));
  const r = reg();
  r.searxngUrl = "https://searx.local/";
  const out = await r.execute("web_search", { query: "x" });
  expect(out).toContain("container auto-started");
  expect(out).toContain("Fresh");
  expect(searxCalls).toBe(2); // failed once, woke, retried exactly once
});

test("zero-config search with Docker present shows the setup tip ONCE per process", async () => {
  globalThis.fetch = (async () =>
    new Response('<a class="result__a" href="https://d.com">DDG hit</a>', { status: 200, headers: { "content-type": "text/html" } })) as any;
  __resetHintForTest(() => true); // "Docker detected"
  const r = reg();
  const first = await r.execute("web_search", { query: "iphone 15" });
  expect(first).toContain("neko setup web");
  const second = await r.execute("web_search", { query: "iphone 15 pro" });
  expect(second).not.toContain("neko setup web"); // once only - no nagging
});

test("zero-config search WITHOUT Docker never hints (nothing actionable)", async () => {
  globalThis.fetch = (async () =>
    new Response('<a class="result__a" href="https://d.com">DDG hit</a>', { status: 200, headers: { "content-type": "text/html" } })) as any;
  __resetHintForTest(() => false);
  const out = await reg().execute("web_search", { query: "x" });
  expect(out).not.toContain("neko setup web");
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
