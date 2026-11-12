import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupWeb } from "../src/adapters/setup.ts";

const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const homes: string[] = [];

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function config(home: string): any {
  return JSON.parse(readFileSync(join(home, ".neko-core", "config.json"), "utf8"));
}

test("browser setup makes durable auth the default and keeps attach/isolated explicit", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-browser-setup-")); homes.push(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  const logs: string[] = [];

  expect(await setupWeb("browser", (line) => logs.push(line), "persistent")).toBe(0);
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  let args = config(home).mcp_servers.browser.args as string[];
  expect(args).toContain("--user-data-dir");
  expect(args).toContain(join(home, ".neko-core", "browser", "default"));
  expect(args).not.toContain("--isolated");
  expect(existsSync(join(home, ".neko-core", "browser", "default"))).toBe(true);
  expect(logs.join("\n")).toContain("Sign in once; sessions survive Neko restarts");

  expect(await setupWeb("browser", () => {}, "attach")).toBe(0);
  args = config(home).mcp_servers.browser.args;
  expect(args).toContain("--extension");
  expect(args).not.toContain("--user-data-dir");

  expect(await setupWeb("browser", () => {}, "isolated")).toBe(0);
  args = config(home).mcp_servers.browser.args;
  expect(args).toContain("--isolated");
  expect(args).not.toContain("--user-data-dir");
});

test("browser setup rejects an unknown mode without touching the user config", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-browser-setup-")); homes.push(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  const logs: string[] = [];
  expect(await setupWeb("browser", (line) => logs.push(line), "mystery")).toBe(2);
  expect(Bun.file(join(home, ".neko-core", "config.json")).size).toBe(0);
  expect(logs.join("\n")).toContain("persistent | attach | isolated");
});

test("managed browser defaults to a pinned multi-tab backend and a separate persistent profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-managed-")); homes.push(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  const logs: string[] = [];
  expect(await setupWeb("browser", line => logs.push(line), "managed")).toBe(0);
  const server = config(home).mcp_servers.browser;
  expect(server.args).toContain("chrome-devtools-mcp@1.13.0");
  expect(server.args).toContain(`--user-data-dir=${join(home, ".neko-core", "browser", "managed")}`);
  expect(server.args).toContain("--page-id-routing");
  expect(server.args).toContain("--no-usage-statistics");
  expect(server.args).toContain("--no-performance-crux");
  expect(server.args).toContain("--no-javascript-evaluation");
  expect(server.args).toContain("--no-file-navigations");
  expect(server.args).not.toContain("--autoConnect");
  expect(server.env.CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY).toBe("1");
  expect(logs.join("\n")).toContain("configured, not connected");
  expect(await setupWeb("browser", () => {}, "managed")).toBe(0);
  expect(config(home).mcp_servers.browser).toEqual(server);
});

test("personal browser opts into Chrome consent without copying profile or enabling debugging", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-personal-")); homes.push(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  const logs: string[] = [];
  expect(await setupWeb("browser", line => logs.push(line), "personal")).toBe(0);
  const server = config(home).mcp_servers.browser;
  expect(server.args).toContain("chrome-devtools-mcp@1.13.0");
  expect(server.args).toContain("--autoConnect");
  expect(server.args.some((a: string) => a.includes("user-data-dir") || a.includes("remote-debugging-port"))).toBe(false);
  expect(existsSync(join(home, ".neko-core", "browser", "managed"))).toBe(false);
  expect(logs.join("\n")).toContain("Chrome 144+");
  expect(logs.join("\n")).toContain("all open tabs");
  expect(logs.join("\n")).toContain("No Chrome setting was changed");
});

test("empty browser mode selects managed while legacy aliases remain explicit", async () => {
  const { browserMode, browserBackend, CHROME_MCP_PACKAGE, PLAYWRIGHT_MCP_PACKAGE } = await import("../src/adapters/browser-backend.ts");
  expect(browserMode("")).toBe("managed");
  expect(browserMode("extension")).toBe("attach");
  expect(browserMode("sandbox")).toBe("isolated");
  expect(browserMode("PERSONAL")).toBe("personal");
  expect(browserMode("unknown")).toBeNull();
  expect(browserBackend("managed", "npx", "/tmp/config").args?.slice(0, 2)).toEqual(["-y", CHROME_MCP_PACKAGE]);
  expect(browserBackend("persistent", "bunx", "/tmp/config").args?.[0]).toBe(PLAYWRIGHT_MCP_PACKAGE);
});

test("browser status distinguishes configured MCP from a live extension connection", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-browser-mode-status-")); homes.push(home);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "bin", "neko.ts"), "browser", "managed"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  expect(result.exitCode).toBe(0);
  const status = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "bin", "neko.ts"), "browser", "status"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  expect(status.exitCode).toBe(0);
  expect(status.stdout.toString()).toContain("MCP configured: managed");
  expect(status.stdout.toString()).toContain("not a live browser probe");
  expect(status.stdout.toString()).not.toContain("browser: ready");
}, 20_000);

test("modern browser setup retains observation tools while disabling direct JS and network access", async () => {
  const { browserBackend } = await import("../src/adapters/browser-backend.ts");
  for (const mode of ["managed", "personal"] as const) {
    const args = browserBackend(mode, "bunx", "/tmp/config").args!;
    // Upstream categorizes take_snapshot/take_screenshot as debugging; disabling that category
    // leaves an agent able to click but unable to observe. Direct evaluate stays disabled.
    expect(args).not.toContain("--no-category-debugging");
    expect(args).toContain("--no-javascript-evaluation");
    expect(args).toContain("--no-category-network");
    expect(args).not.toContain("--allow-unrestricted-paths");
    expect(args).not.toContain("--accept-insecure-certs");
  }
});

test("generated SearXNG settings use a fresh random secret rather than a shared service credential", async () => {
  const module = await import("../src/adapters/setup.ts");
  expect("searxngSettings" in module).toBe(true);
  const settings = module.searxngSettings;
  const first = settings(), second = settings();
  const secret = /secret_key: "([a-f0-9]{64})"/;
  expect(first).toMatch(secret);
  expect(first.match(secret)?.[1]).not.toBe(second.match(secret)?.[1]);
});
