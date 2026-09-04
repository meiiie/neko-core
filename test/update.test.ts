import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { acquireUpdateLockWithin, activateStagedBinary, assetName, cleanupStaleUpdate, downloadReleaseFile, expandGzip, isNewer, latestVersion, parseSha256Sidecar, refreshUpdateLock, selfUpdateSucceeded } from "../src/adapters/update.ts";

function fetchStub(run: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>): typeof fetch {
  return Object.assign(run, { preconnect(_url: string | URL): void { } });
}

test("cleanupStaleUpdate removes the leftover <exe>.old; no-op when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-upd-"));
  const exe = join(dir, "neko.exe");
  try {
    writeFileSync(`${exe}.old`, "stale");
    cleanupStaleUpdate(exe);
    expect(existsSync(`${exe}.old`)).toBe(false); // swept
    cleanupStaleUpdate(exe); // absent -> silent no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateStagedBinary restores the original if activation fails after the backup rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-activate-"));
  const exe = join(dir, "neko");
  try {
    writeFileSync(exe, "known-good");
    expect(() => activateStagedBinary(exe, join(dir, "missing-stage"))).toThrow();
    expect(readFileSync(exe, "utf8")).toBe("known-good");
    expect(existsSync(`${exe}.old`)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isNewer compares versions numerically, ignoring a leading v", () => {
  expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
  expect(isNewer("0.2.1", "0.2.0")).toBe(true);
  expect(isNewer("v1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("0.2.10", "0.2.9")).toBe(true); // numeric, not lexical
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  expect(isNewer("v0.2.0", "v0.2.0")).toBe(false);
});

test("an idempotent update is command success, while a real failure is not", () => {
  expect(selfUpdateSucceeded("updated")).toBe(true);
  expect(selfUpdateSucceeded("up-to-date")).toBe(true);
  expect(selfUpdateSucceeded("failed")).toBe(false);
});

test("assetName picks the right release asset per platform/arch (matches release.yml)", () => {
  expect(assetName("win32", "x64")).toBe("neko-windows-x64.exe");
  expect(assetName("darwin", "arm64")).toBe("neko-macos-arm64");
  expect(assetName("darwin", "x64")).toBe("neko-macos-x64");
  expect(assetName("linux", "x64")).toBe("neko-linux-x64");
  expect(assetName("linux", "arm64")).toBe("neko-linux-arm64");
});

test("normalizeTag: bare or v-prefixed x.y.z -> vX.Y.Z; junk -> null", () => {
  const { normalizeTag } = require("../src/adapters/update.ts");
  expect(normalizeTag("0.7.7")).toBe("v0.7.7");
  expect(normalizeTag("v0.7.7")).toBe("v0.7.7");
  expect(normalizeTag("  0.8.0 ")).toBe("v0.8.0");
  expect(normalizeTag("latest")).toBe(null);
  expect(normalizeTag("0.7")).toBe(null);       // must be full x.y.z
  expect(normalizeTag("v0.7.7-rc1")).toBe(null); // no pre-release suffix
});

test("latestVersion falls back to GitHub's official redirect when the public API is rate-limited", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    // SAFETY: partial runtime-API stub; only the members used by the code under test are provided.
    if (url.includes("api.github.com")) {
      // SAFETY: partial Response stub; only `ok` and `status` are read by the code under test.
      return { ok: false, status: 403 } as Response;
    }
    // SAFETY: partial runtime-API stub; only the members used by the code under test are provided.
    return { ok: true, url: "https://github.com/meiiie/neko-core/releases/tag/v0.11.3" } as Response;
  }) as typeof fetch;
  try {
    expect(await latestVersion()).toBe("v0.11.3");
    expect(calls).toHaveLength(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("an 'up to date' check is re-asked the same day, so a release minutes later is not missed", async () => {
  // The field failure: the cache recorded v0.16.0 as latest at 18:10, v0.16.1 shipped at 18:16, and
  // every session for the next 24h skipped the check entirely - auto_update installed nothing.
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME, fetch: globalThis.fetch };
  const home = mkdtempSync(join(tmpdir(), "neko-update-cache-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  require("node:fs").mkdirSync(join(home, ".neko-core"), { recursive: true });
  const cache = join(home, ".neko-core", ".update-check.json");
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const current = require("../src/shared/version.ts").VERSION as string;
  const [major, minor] = current.split(".").map(Number);
  const shipped = `v${major}.${minor + 1}.0`;
  let apiCalls = 0;
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  globalThis.fetch = (async (input: any) => {
    apiCalls++;
    // SAFETY: partial Response stubs; only `ok`, `json`, and `url` are read by the update checker under test.
    return String(input).includes("api.github.com")
      ? { ok: true, json: async () => ({ tag_name: shipped, draft: false, prerelease: false }) } as Response
      : { ok: true, url: `https://github.com/meiiie/neko-core/releases/tag/${shipped}` } as Response;
  }) as typeof fetch;
  try {
    const { checkForUpdate, UPDATE_RECHECK_MS } = require("../src/adapters/update.ts");
    const wroteAt = Date.now();
    writeFileSync(cache, JSON.stringify({ at: wroteAt, latest: `v${current}` })); // "you are on the latest"

    // Minutes later: still cached, no network call - the check stays cheap on rapid restarts.
    expect(await checkForUpdate(wroteAt + 6 * 60_000)).toBe(null);
    expect(apiCalls).toBe(0);

    // A few hours later it asks again and finds the release that shipped after the cache was written.
    expect(await checkForUpdate(wroteAt + UPDATE_RECHECK_MS.upToDate + 1_000)).toBe(shipped);
    expect(apiCalls).toBeGreaterThan(0);

    // Once an update IS known, re-asking adds nothing: it stays cached for the full day.
    const seen = apiCalls;
    expect(await checkForUpdate(wroteAt + UPDATE_RECHECK_MS.upToDate + 2 * 3600_000)).toBe(shipped);
    expect(apiCalls).toBe(seen);
    expect(JSON.parse(readFileSync(cache, "utf-8")).latest).toBe(shipped);
  } finally {
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    globalThis.fetch = saved.fetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("release checksum sidecars are parsed strictly", () => {
  const sha = "a".repeat(64);
  expect(parseSha256Sidecar(`${sha} *neko-windows-x64.exe\n`)).toBe(sha);
  expect(parseSha256Sidecar("abc *neko")).toBe(null);
});

test("release downloads use an idle-progress watchdog instead of one total deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-download-idle-"));
  const part = join(dir, "neko.part");
  const chunks = ["slow-", "but-", "moving"];
  const moving = async () => new Response(new ReadableStream({
    async start(controller) {
      for (const text of chunks) {
        await Bun.sleep(35);
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  }));
  const progress: number[] = [];
  try {
    await downloadReleaseFile("https://release.invalid/neko", part, (n: number) => progress.push(n), {
      fetcher: fetchStub(moving),
      idleMs: 80,
    });
    expect(readFileSync(part, "utf8")).toBe(chunks.join(""));
    expect(progress).toEqual([0, 5, 9, 15]);

    rmSync(part, { force: true });
    const stalled = async () => new Response(new ReadableStream({ start() { } }));
    await expect(downloadReleaseFile("https://release.invalid/neko", part, undefined, {
      fetcher: fetchStub(stalled),
      idleMs: 40,
      attempts: 1,
    })).rejects.toThrow(/no download progress/i);

    const oversized = async () => new Response("123456", { headers: { "content-length": "6" } });
    await expect(downloadReleaseFile("https://release.invalid/neko", part, undefined, {
      fetcher: fetchStub(oversized),
      idleMs: 40,
      maxBytes: 5,
    })).rejects.toThrow(/250 MB safety limit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release downloads resume a persistent partial file with a validated byte range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-download-resume-"));
  const part = join(dir, "neko.part");
  writeFileSync(part, "abc");
  let range = "";
  try {
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      range = new Headers(init?.headers).get("range") ?? "";
      return new Response("def", {
        status: 206,
        headers: { "content-range": "bytes 3-5/6", "content-length": "3" },
      });
    };
    const result = await downloadReleaseFile("https://release.invalid/neko", part, undefined, { fetcher: fetchStub(fetcher) });
    expect(range).toBe("bytes=3-");
    expect(result).toEqual({ received: 6, total: 6 });
    expect(readFileSync(part, "utf8")).toBe("abcdef");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release downloads recover from an early EOF without discarding received bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-download-eof-"));
  const part = join(dir, "neko.part");
  const ranges: string[] = [];
  let call = 0;
  try {
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      ranges.push(new Headers(init?.headers).get("range") ?? "");
      call++;
      return call === 1
        ? new Response("abc", { headers: { "content-length": "6" } })
        : new Response("def", { status: 206, headers: { "content-range": "bytes 3-5/6" } });
    };
    await downloadReleaseFile("https://release.invalid/neko", part, undefined, {
      fetcher: fetchStub(fetcher),
      sleep: async () => {},
    });
    expect(ranges).toEqual(["", "bytes=3-"]);
    expect(readFileSync(part, "utf8")).toBe("abcdef");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that ignores Range safely restarts instead of appending duplicate bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-download-restart-"));
  const part = join(dir, "neko.part");
  writeFileSync(part, "stale");
  try {
    const fetcher = async () => new Response("fresh", { headers: { "content-length": "5" } });
    await downloadReleaseFile("https://release.invalid/neko", part, undefined, { fetcher: fetchStub(fetcher) });
    expect(readFileSync(part, "utf8")).toBe("fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compressed releases expand with a strict output-size ceiling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-gzip-"));
  const archive = join(dir, "neko.gz");
  const binary = join(dir, "neko");
  writeFileSync(archive, gzipSync("small verified binary"));
  try {
    expect(await expandGzip(archive, binary, 64)).toBe(21);
    expect(readFileSync(binary, "utf8")).toBe("small verified binary");
    await expect(expandGzip(archive, binary, 8)).rejects.toThrow(/safety limit/i);
    expect(existsSync(binary)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setAutoUpdate writes the hold flag to the user config (rollback sticks)", () => {
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-pin-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    const { setAutoUpdate } = require("../src/adapters/project.ts");
    setAutoUpdate(false); // pin/hold
    const cfgPath = join(home, ".neko-core", "config.json");
    expect(JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")).auto_update).toBe(false);
    setAutoUpdate(true);  // resume
    expect(JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8")).auto_update).toBe(true);
  } finally {
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("plain update resumes auto-updates even when no binary replacement can run", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-resume-update-"));
  const configDir = join(home, ".neko-core");
  require("node:fs").mkdirSync(configDir, { recursive: true });
  // Windows PowerShell 5's `Set-Content -Encoding utf8` writes this BOM. The CLI writer must preserve
  // the user's settings and still clear the installer pin, not merely print a success message.
  writeFileSync(join(configDir, "config.json"), `\uFEFF${JSON.stringify({ auto_update: false })}`);
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "neko.ts"), "update"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    expect(output).toContain("Auto-updates resumed.");
    expect(JSON.parse(require("node:fs").readFileSync(join(configDir, "config.json"), "utf8")).auto_update).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000); // A cold Bun CLI process can cross the 5s default on hosted Windows under shard load.

test("the machine-wide update lock reclaims dead owners without deleting successor locks", () => {
  // The field failure: two `neko --yolo` startups (background auto-update) plus a manual `neko update`
  // raced over ONE staging file and the same rename - garbled output and an apparent hang.
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-update-lock-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    const { acquireUpdateLock, releaseUpdateLock } = require("../src/adapters/update.ts");
    const lock = join(home, ".neko-core", ".update.lock");
    const t0 = Date.now();
    expect(acquireUpdateLock(t0)).toBe(true);      // first caller holds it
    expect(acquireUpdateLock(t0 + 60_000)).toBe(false); // a live lock is respected
    expect(refreshUpdateLock(t0 + 9 * 60_000)).toBe(true);
    expect(acquireUpdateLock(t0 + 11 * 60_000, () => true)).toBe(false); // heartbeat keeps a slow live download owned
    releaseUpdateLock();
    expect(acquireUpdateLock(t0 + 61_000)).toBe(true);  // released -> free again
    releaseUpdateLock();

    // A killed background updater must not brick a manual update for ten minutes.
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, at: t0 + 62_000 }));
    expect(acquireUpdateLock(t0 + 62_001, () => false)).toBe(true);

    // If a stale owner eventually runs its finally, it must not remove a successor's lock.
    writeFileSync(lock, JSON.stringify({ pid: 42, at: t0 + 62_002, token: "successor" }));
    releaseUpdateLock();
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("successor");
    rmSync(lock, { force: true });

    // Age remains a bounded fallback when a pid is live, reused, or cannot be inspected.
    writeFileSync(lock, JSON.stringify({ pid: 42, at: t0 }));
    expect(acquireUpdateLock(t0 + 11 * 60_000, () => true)).toBe(true);
    releaseUpdateLock();
  } finally {
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a manual updater waits for an active auto-updater instead of failing immediately", async () => {
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-update-wait-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    const { acquireUpdateLock, releaseUpdateLock } = require("../src/adapters/update.ts");
    expect(acquireUpdateLock()).toBe(true);
    expect(await acquireUpdateLockWithin(20, 5)).toBe(false);
    setTimeout(releaseUpdateLock, 25);
    expect(await acquireUpdateLockWithin(250, 5)).toBe(true);
    releaseUpdateLock();
  } finally {
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanupStaleUpdate sweeps orphaned staging files but never a fresh one", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-staging-"));
  const exe = join(dir, "neko.exe");
  try {
    const fs = require("node:fs");
    fs.writeFileSync(exe, "x");
    fs.writeFileSync(`${exe}.old`, "old");
    fs.writeFileSync(`${exe}.new-111.exe`, "orphan");   // a killed updater's debris
    fs.writeFileSync(`${exe}.new-222.exe`, "active");   // another process, mid-write
    fs.writeFileSync(`${exe}.download-v1.5.1.gz.part`, "old partial");
    fs.writeFileSync(`${exe}.download-v1.5.2.gz.part`, "recent partial");
    const past = (Date.now() - 45 * 60_000) / 1000;
    fs.utimesSync(`${exe}.new-111.exe`, past, past);    // 45 min old -> orphan
    const lastWeek = (Date.now() - 8 * 24 * 3600_000) / 1000;
    fs.utimesSync(`${exe}.download-v1.5.1.gz.part`, lastWeek, lastWeek);
    const { cleanupStaleUpdate } = require("../src/adapters/update.ts");
    cleanupStaleUpdate(exe);
    expect(fs.existsSync(`${exe}.old`)).toBe(false);        // the classic backup sweep still works
    expect(fs.existsSync(`${exe}.new-111.exe`)).toBe(false); // orphan removed
    expect(fs.existsSync(`${exe}.new-222.exe`)).toBe(true);  // fresh staging is someone's live download
    expect(fs.existsSync(`${exe}.download-v1.5.1.gz.part`)).toBe(false);
    expect(fs.existsSync(`${exe}.download-v1.5.2.gz.part`)).toBe(true);
    expect(fs.existsSync(exe)).toBe(true);                   // the binary itself is untouchable
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
