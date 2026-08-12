import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { __resetHintForTest, __setPublicHttpForTest, __setSidecarForTest, webPort } from "../src/adapters/web.ts";
import { PUBLIC_HTTP_MAX_BYTES } from "../src/adapters/public-http.ts";
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
  __setPublicHttpForTest();
  delete process.env.TAVILY_API_KEY;
  delete process.env.JINA_API_KEY;
});
const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const TOO_LARGE = PUBLIC_HTTP_MAX_BYTES + 1;
const chunked = (body: string, contentType: string) => new Response(new ReadableStream({
  start(controller) {
    const bytes = new TextEncoder().encode(body);
    controller.enqueue(bytes.subarray(0, 1024 * 1024));
    controller.enqueue(bytes.subarray(1024 * 1024));
    controller.close();
  },
}), { status: 200, headers: { "content-type": contentType } });

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

test("web_search uses a CONFIG-wired Tavily key (neko setup tavily) with no env var set", async () => {
  globalThis.fetch = (async (url: any) => {
    expect(String(url)).toContain("api.tavily.com");
    return json({ results: [{ title: "Cfg", url: "https://c.io", content: "from config key" }] });
  }) as any;
  const r = reg();
  r.tavilyKey = "tvly-from-config";
  const out = await r.execute("web_search", { query: "x" });
  expect(out).toContain("Cfg");
});

test("web_search refuses an oversized SearXNG response from Content-Length", async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("searx")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(TOO_LARGE) } });
    }
    return new Response('<a class="result__a" href="https://d.com">DDG fallback</a>', { status: 200 });
  }) as any;
  const r = reg();
  r.searxngUrl = "https://searx.local/";
  const out = await r.execute("web_search", { query: "bounded" });
  expect(out).toContain(`response body exceeds ${PUBLIC_HTTP_MAX_BYTES} bytes`);
  expect(out).toContain("DDG fallback");
});

test("web_search refuses an oversized chunked Tavily JSON response", async () => {
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("api.tavily.com")) {
      return chunked(JSON.stringify({ results: [], padding: "x".repeat(TOO_LARGE) }), "application/json");
    }
    return new Response('<a class="result__a" href="https://d.com">DDG fallback</a>', { status: 200 });
  }) as any;
  const r = reg();
  r.searchBackend = "tavily";
  r.tavilyKey = "tvly-test-only";
  const out = await r.execute("web_search", { query: "bounded" });
  expect(out).toContain(`response body exceeds ${PUBLIC_HTTP_MAX_BYTES} bytes`);
  expect(out).toContain("DDG fallback");
});

test("web_search refuses an oversized chunked DuckDuckGo HTML response", async () => {
  globalThis.fetch = (async () => chunked("x".repeat(TOO_LARGE), "text/html")) as any;
  const out = await reg().execute("web_search", { query: "bounded" });
  expect(out).toContain(`response body exceeds ${PUBLIC_HTTP_MAX_BYTES} bytes`);
});

test("the ladder, not the cliff: searxng fails -> Tavily (key wired) -> never touches DuckDuckGo", async () => {
  let ddgCalled = false;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("searx")) throw new Error("down");
    if (u.includes("api.tavily.com")) return json({ results: [{ title: "Rung2", url: "https://t.io", content: "tavily caught it" }] });
    ddgCalled = true;
    throw new Error("no DDG expected");
  }) as any;
  const r = reg();
  r.searxngUrl = "https://searx.local/";
  r.tavilyKey = "tvly-x";
  const out = await r.execute("web_search", { query: "x" });
  expect(out).toContain("searxng failed: down");
  expect(out).toContain("falling back to Tavily");
  expect(out).toContain("Rung2");
  expect(ddgCalled).toBe(false);
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
  __setPublicHttpForTest(async (url) => ({
    url,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    text: body,
  }));
  const out = await reg().execute("web_fetch", { url: "https://x.com" });
  expect(out).toContain("Real article content");
  expect(out).not.toContain("NAVNOISE");
  expect(out).not.toContain("FOOTNOISE");
  expect(out).not.toContain("junk()");
});

test("web_fetch sends GitHub and YouTube URLs through bounded public HTTP", async () => {
  const seen: string[] = [];
  __setPublicHttpForTest(async (url) => {
    seen.push(url);
    return {
      url,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: `public response for ${url}`,
    };
  });

  const r = reg();
  const github = "https://github.com/oven-sh/bun/issues/1?neko-public-http=1";
  const youtube = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&neko-public-http=1";
  expect(await r.execute("web_fetch", { url: github })).toContain("public response");
  expect(await r.execute("web_fetch", { url: youtube })).toContain("public response");
  expect(seen).toEqual([github, youtube]);
});

test("web_fetch preserves the opt-in Jina reader route for a public target", async () => {
  process.env.JINA_API_KEY = "jina-test-only";
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  __setPublicHttpForTest(async (url, init) => {
    seenUrl = url;
    seenHeaders = init?.headers ?? {};
    return { url, status: 200, headers: new Headers({ "content-type": "text/markdown" }), text: "# Jina result" };
  });
  const r = reg();
  r.scrapeBackend = "jina";
  const out = await r.execute("web_fetch", { url: "https://8.8.8.8/public-page" });
  expect(out).toBe("# Jina result");
  expect(seenUrl).toBe("https://r.jina.ai/https://8.8.8.8/public-page");
  expect(seenHeaders.Authorization).toBe("Bearer jina-test-only");
  expect(seenHeaders["X-Return-Format"]).toBe("markdown");
});

test("web_fetch bounds the content passed to its optional summarizer", async () => {
  const body = "A".repeat(60_000) + "B".repeat(60_000);
  __setPublicHttpForTest(async (url) => ({
    url,
    status: 200,
    headers: new Headers({ "content-type": "text/plain" }),
    text: body,
  }));
  const r = reg();
  let seen = "";
  r.summarize = async (_instruction, content) => { seen = content; return "bounded"; };

  expect(await r.execute("web_fetch", { url: "https://8.8.4.4/large", prompt: "extract", page: 2 })).toBe("bounded");
  expect(seen.length).toBeLessThan(60_000);
  expect(seen).toContain("page 2/");
});
