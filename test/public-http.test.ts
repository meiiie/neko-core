import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { classifyPlatformUrl, webPort } from "../src/adapters/web.ts";
import {
  PUBLIC_HTTP_MAX_BYTES,
  isPublicIp,
  publicHttpFetch,
  readBoundedBody,
  type PublicHttpDependencies,
} from "../src/adapters/public-http.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const publicAddress = { address: "93.184.216.34", family: 4 as const };
const ok = (text: string, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: new Headers(headers),
  body: Buffer.from(text),
});

test("web_fetch refuses a loopback target before making a request", async () => {
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      hits++;
      return new Response("local-only-secret");
    },
  });
  const registry = new ToolRegistry(mkdtempSync(tmpdir() + "/nk-public-http-"), "auto", () => true);
  registry.web = webPort;

  try {
    const output = await registry.execute("web_fetch", { url: server.url.toString() });
    expect(output).toContain("non-public");
    expect(output).not.toContain("local-only-secret");
    expect(hits).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("public IP classification rejects local and special-purpose ranges", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "168.63.129.16", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:1::1", "4000::1",
    "fc00::1", "fe80::1", "fec0::1", "ff02::1",
  ]) expect(isPublicIp(address)).toBe(false);
  expect(isPublicIp("8.8.8.8")).toBe(true);
  expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
});

test("publicHttpFetch rejects alternate loopback URL forms before transport", async () => {
  let requests = 0;
  const dependencies: PublicHttpDependencies = {
    request: async () => { requests++; return ok("must-not-run"); },
  };
  for (const url of [
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ]) await expect(publicHttpFetch(url, {}, dependencies)).rejects.toThrow("non-public");
  expect(requests).toBe(0);
});

test("publicHttpFetch rejects a DNS answer containing any private address", async () => {
  let requests = 0;
  const dependencies: PublicHttpDependencies = {
    lookup: async () => [publicAddress, { address: "10.0.0.7", family: 4 }],
    request: async () => { requests++; return ok("must-not-run"); },
  };
  await expect(publicHttpFetch("https://mixed.example/", {}, dependencies)).rejects.toThrow("non-public");
  expect(requests).toBe(0);
});

test("publicHttpFetch aborts while a DNS resolver is hung", async () => {
  let requests = 0;
  const signal = AbortSignal.timeout(20);
  const outcome = await Promise.race([
    publicHttpFetch("https://hung.example/", { signal }, {
      lookup: async () => new Promise(() => {}),
      request: async () => { requests++; return ok("must-not-run"); },
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    }).then(() => "resolved", (error) => {
      // SAFETY: the rejection under test is always an Error thrown by the bounded fetch path.
      return (error as Error).name + ": " + (error as Error).message;
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);
  expect(outcome).not.toBe("still-pending");
  expect(outcome.toLowerCase()).toMatch(/abort|timeout|timed out/);
  expect(requests).toBe(0);
});

test("publicHttpFetch re-checks cancellation after DNS resolves", async () => {
  const controller = new AbortController();
  let requests = 0;
  await expect(publicHttpFetch("https://cancelled.example/", { signal: controller.signal }, {
    lookup: async () => {
      controller.abort(new Error("cancelled during DNS"));
      return [publicAddress];
    },
    request: async () => { requests++; return ok("must-not-run"); },
  })).rejects.toThrow("cancelled during DNS");
  expect(requests).toBe(0);
});

test("publicHttpFetch checks cancellation before starting DNS", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  let lookups = 0;
  await expect(publicHttpFetch("https://cancelled.example/", { signal: controller.signal }, {
    lookup: async () => { lookups++; return [publicAddress]; },
  })).rejects.toThrow("already cancelled");
  expect(lookups).toBe(0);
});

test("publicHttpFetch applies the same deadline to redirect DNS", async () => {
  let requests = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("redirect DNS deadline")), 20);
  const outcome = await Promise.race([
    publicHttpFetch("https://first.example/", { signal: controller.signal }, {
      lookup: async (hostname) => hostname === "first.example" ? [publicAddress] : new Promise(() => {}),
      request: async () => {
        requests++;
        return { status: 302, headers: new Headers({ location: "https://hung.example/" }), body: Buffer.alloc(0) };
      },
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    }).then(() => "resolved", (error) => {
      // SAFETY: the rejection under test is always an Error thrown by the bounded fetch path.
      return (error as Error).name + ": " + (error as Error).message;
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);
  expect(outcome).not.toBe("still-pending");
  expect(outcome).toContain("redirect DNS deadline");
  expect(requests).toBe(1);
  clearTimeout(timer);
});

test("publicHttpFetch passes the validated address to the pinned transport", async () => {
  let pinned = "";
  const response = await publicHttpFetch("https://public.example/article", {}, {
    lookup: async () => [publicAddress],
    request: async (_url, address) => { pinned = address.address; return ok("public article", { "content-type": "text/plain" }); },
  });
  expect(pinned).toBe(publicAddress.address);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain");
  expect(response.text).toBe("public article");
});

test("publicHttpFetch falls back to another validated public address on connect failure", async () => {
  const attempted: string[] = [];
  const response = await publicHttpFetch("https://dual-stack.example/", {}, {
    lookup: async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      publicAddress,
    ],
    request: async (_url, address) => {
      attempted.push(address.address);
      if (address.family === 6) throw new Error("IPv6 route unavailable");
      return ok("IPv4 fallback");
    },
  });
  expect(attempted).toEqual(["2606:4700:4700::1111", publicAddress.address]);
  expect(response.text).toBe("IPv4 fallback");
});

test("publicHttpFetch validates every redirect before a second request", async () => {
  let requests = 0;
  const dependencies: PublicHttpDependencies = {
    lookup: async (hostname) => hostname === "internal.example"
      ? [{ address: "192.168.1.20", family: 4 }]
      : [publicAddress],
    request: async () => {
      requests++;
      return { status: 302, headers: new Headers({ location: "http://internal.example/admin" }), body: Buffer.alloc(0) };
    },
  };
  await expect(publicHttpFetch("https://public.example/", {}, dependencies)).rejects.toThrow("non-public");
  expect(requests).toBe(1);
});

test("publicHttpFetch preserves public redirects but drops credentials across origins", async () => {
  const seen: Array<{ host: string; authorization?: string }> = [];
  const response = await publicHttpFetch("https://first.example/", { headers: { Authorization: "Bearer test-only" } }, {
    lookup: async () => [publicAddress],
    request: async (url, _address, init) => {
      seen.push({ host: url.hostname, authorization: init.headers.Authorization });
      return url.hostname === "first.example"
        ? { status: 302, headers: new Headers({ location: "https://second.example/page" }), body: Buffer.alloc(0) }
        : ok("redirected");
    },
  });
  expect(response.text).toBe("redirected");
  expect(seen).toEqual([
    { host: "first.example", authorization: "Bearer test-only" },
    { host: "second.example", authorization: undefined },
  ]);
});

test("readBoundedBody refuses an oversized stream instead of truncating it", async () => {
  let closed = false;
  async function* chunks() {
    try {
      yield new Uint8Array(PUBLIC_HTTP_MAX_BYTES);
      yield new Uint8Array(1);
    } finally {
      closed = true;
    }
  }
  await expect(readBoundedBody(chunks())).rejects.toThrow(`${PUBLIC_HTTP_MAX_BYTES} bytes`);
  expect(closed).toBe(true);
});

test("readBoundedBody preserves a response exactly at the limit", async () => {
  async function* chunks() { yield new Uint8Array(PUBLIC_HTTP_MAX_BYTES); }
  expect((await readBoundedBody(chunks())).byteLength).toBe(PUBLIC_HTTP_MAX_BYTES);
});

test("platform routing recognizes exact hosts, never URL substrings", () => {
  expect(classifyPlatformUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ kind: "youtube" });
  expect(classifyPlatformUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({ kind: "youtube" });
  expect(classifyPlatformUrl("https://github.com/oven-sh/bun/issues/1")).toEqual({
    kind: "github", owner: "oven-sh", repo: "bun", section: "issues", number: "1",
  });
  for (const url of [
    "https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ",
    "https://attacker.example/?next=https://youtu.be/dQw4w9WgXcQ",
    "https://github.com.attacker.example/oven-sh/bun",
    "https://attacker.example/github.com/oven-sh/bun",
  ]) expect(classifyPlatformUrl(url)).toBeNull();
});
