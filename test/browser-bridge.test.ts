import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserBridgeStage, startBrowserBridge, startManagedBrowserBridge, type BrowserCapability } from "../src/adapters/browser-bridge.ts";
import { browserExtensionSetupMessage, browserStoreUrl, prepareBrowserExtension } from "../src/adapters/browser-extension-install.ts";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("browser onboarding distinguishes files, connection, and an attached tab", () => {
  const capability: BrowserCapability = { version: 1, host: "127.0.0.1", port: 8766, session: "session-test", token: "token-test" };
  expect(browserBridgeStage(null, undefined)).toBe("not_configured");
  expect(browserBridgeStage(capability, { online: false })).toBe("offline");
  expect(browserBridgeStage(capability, { online: true, extensionConnected: false, attached: null })).toBe("bridge_online");
  expect(browserBridgeStage(capability, { online: true, extensionConnected: true, attached: null })).toBe("extension_connected");
  expect(browserBridgeStage(capability, { online: true, extensionConnected: true, attached: { tabId: 7 } })).toBe("tab_attached");

  const unpacked = browserExtensionSetupMessage({ mode: "unpacked", opened: true, path: "C:\\Neko\\browser-extension" });
  expect(unpacked).toContain("Chrome does not let any app install"); // sets the expectation: manual
  expect(unpacked).toContain("Developer mode");
  expect(unpacked).toContain("Load unpacked");
  expect(unpacked).toContain("C:\\Neko\\browser-extension");
  expect(unpacked).not.toContain("Who's using Chrome?"); // no picker note unless asked
  expect(unpacked).not.toContain("clipboard");

  // Multi-profile + clipboard: warn about the picker and point at the pasted path.
  const guided = browserExtensionSetupMessage(
    { mode: "unpacked", opened: true, path: "C:\\Neko\\x" },
    { pathOnClipboard: true, profilePicker: true },
  );
  expect(guided).toContain("Who's using Chrome?");
  expect(guided).toContain("IN THAT profile");
  expect(guided).toContain("already on your clipboard");
});

test("browser CLI status never mistakes a local folder for an installed extension", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-browser-status-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const command = [process.execPath, join(import.meta.dir, "..", "bin", "neko.ts"), "browser", "status"];
  try {
    const initial = Bun.spawnSync(command, { cwd: join(import.meta.dir, ".."), env });
    expect(initial.exitCode).toBe(0);
    expect(initial.stdout.toString()).toContain("not configured");

    const dir = join(home, ".neko-core");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "browser-bridge.json"), JSON.stringify({
      version: 1, host: "127.0.0.1", port: 8766, session: "session-test", token: "token-test",
    }));
    writeFileSync(join(dir, "browser-bridge-status.json"), JSON.stringify({
      online: true, extensionConnected: false, attached: null, updatedAt: Date.now(),
    }));
    const waiting = Bun.spawnSync(command, { cwd: join(import.meta.dir, ".."), env });
    expect(waiting.exitCode).toBe(0);
    expect(waiting.stdout.toString()).toContain("extension is not connected");
    expect(waiting.stdout.toString()).not.toContain("ready -");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => ws.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }));
}

test("browser bridge pairs one extension origin and routes a capability-scoped command", async () => {
  const capability: BrowserCapability = { version: 1, host: "127.0.0.1", port: 0, session: "session-test", token: "token-test" };
  const bridge = startBrowserBridge({ capability, extensionOrigin: origin, pairingMs: 10_000, persistStatus: false });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { headers: { origin } } as any);
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", reject, { once: true }); });

  ws.send(JSON.stringify({ type: "pair" }));
  expect(await nextMessage(ws)).toEqual({ type: "paired", session: "session-test", token: "token-test" });
  // A fresh pair signals autoAttach:true so the extension attaches the first http/s tab on its own.
  expect(await nextMessage(ws)).toEqual({ type: "ready", session: "session-test", autoAttach: true });
  ws.send(JSON.stringify({ type: "attached", tab: { id: 7, url: "https://example.com/private?q=not-audited" }, grants: { click: false, type: false } }));
  await Bun.sleep(10);
  expect(bridge.status().attached).toEqual({ tabId: 7, host: "example.com", grants: { click: false, type: false } });

  const request = bridge.command("snapshot", { maxItems: 10 });
  const command = await nextMessage(ws);
  expect(command.action).toBe("snapshot");
  ws.send(JSON.stringify({ type: "result", id: command.id, action: "snapshot", ok: true, result: { items: 2 } }));
  expect(await request).toEqual({ items: 2 });
  expect(JSON.stringify(bridge.status())).not.toContain("private?q");

  ws.close();
  bridge.close();
});

test("a RESUMED session (hello with a saved token) does NOT auto-attach", async () => {
  const capability: BrowserCapability = { version: 1, host: "127.0.0.1", port: 0, session: "session-test", token: "token-test" };
  const bridge = startBrowserBridge({ capability, extensionOrigin: origin, pairingMs: 10_000, persistStatus: false });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { headers: { origin } } as any);
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.send(JSON.stringify({ type: "hello", session: "session-test", token: "token-test" }));
  // Later sessions require the explicit Attach gesture - autoAttach is false, not present as true.
  expect(await nextMessage(ws)).toEqual({ type: "ready", session: "session-test", autoAttach: false });
  ws.close();
  bridge.close();
});

test("browser bridge rejects HTTP commands without the capability", async () => {
  const capability: BrowserCapability = { version: 1, host: "127.0.0.1", port: 0, session: "session-test", token: "token-test" };
  const bridge = startBrowserBridge({ capability, extensionOrigin: origin, persistStatus: false });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/command`, { method: "POST", body: "{}" });
  expect(response.status).toBe(401);
  bridge.close();
});

test("browser bridge accepts only explicitly configured extension origins", async () => {
  const capability: BrowserCapability = { version: 1, host: "127.0.0.1", port: 0, session: "session-test", token: "token-test" };
  const second = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const bridge = startBrowserBridge({ capability, extensionOrigins: [origin, second], persistStatus: false });
  const denied = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, {
    headers: { origin: "chrome-extension://cccccccccccccccccccccccccccccccc" },
  } as any);
  const closeCode = await new Promise<number>((resolve) => denied.addEventListener("close", (event) => resolve(event.code), { once: true }));
  expect(closeCode).not.toBe(1000);
  const accepted = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { headers: { origin: second } } as any);
  await new Promise<void>((resolve, reject) => { accepted.addEventListener("open", () => resolve(), { once: true }); accepted.addEventListener("error", reject, { once: true }); });
  accepted.close();
  bridge.close();
});

test("managed browser bridge starts once and shares an existing loopback owner", () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port!;
  reservation.stop(true);
  const capability: BrowserCapability = { version: 1, host: "127.0.0.1", port, session: "managed-test", token: "managed-token" };
  const owned = startManagedBrowserBridge({ capability, extensionIds: [origin.slice("chrome-extension://".length)], persistStatus: false });
  expect(owned).not.toBeNull();
  expect(startManagedBrowserBridge({ capability, extensionIds: [origin.slice("chrome-extension://".length)], persistStatus: false })).toBeNull();
  owned?.close();
});

test("browser install chooses Store when configured and prepares a pinned local fallback", async () => {
  expect(browserStoreUrl("")).toBeNull();
  expect(browserStoreUrl("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
    .toBe("https://chromewebstore.google.com/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const temp = mkdtempSync(join(tmpdir(), "neko-browser-install-"));
  const destination = join(temp, "installed");
  let requests = 0;
  try {
    const path = await prepareBrowserExtension({
      sourceRoot: temp,
      destination,
      version: "0.11.5",
      fetchImpl: (async (input: string | URL | Request) => {
        requests++;
        const asset = String(input).split("/browser-extension/")[1];
        return new Response(readFileSync(new URL(`../browser-extension/${asset}`, import.meta.url)));
      }) as typeof fetch,
    });
    expect(path).toBe(destination);
    expect(requests).toBe(10);
    expect(JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).manifest_version).toBe(3);
    expect(readFileSync(join(path, ".neko-version"), "utf8").trim()).toBe("0.11.5");
    await prepareBrowserExtension({ sourceRoot: temp, destination, version: "0.11.5", fetchImpl: (() => { throw new Error("cache missed"); }) as unknown as typeof fetch });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("browser extension is http/https-scoped for auto-attach, and never broader", () => {
  const manifest = JSON.parse(readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  // Zero-click auto-attach (Claude/Codex-style) needs to script the chosen tab without a per-tab
  // user gesture, which Chrome only allows with host access. Kept as NARROW as possible: http/https
  // pages only - NOT <all_urls> (so no file://, ftp://, chrome://), and NEVER the debugger permission
  // Claude's extension uses. The service worker still CONTROLS only the one attached tab (state.tabId).
  expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
  expect(manifest.permissions).toContain("tabGroups");
  expect(manifest.permissions).toContain("alarms");
  expect(manifest.permissions).not.toContain("debugger");
  expect(manifest.permissions).not.toContain("tabs");
  expect(manifest.host_permissions ?? []).not.toContain("<all_urls>");
  const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
  expect(id).toBe("koalaflndbcddboachbdfmppdeblldje");
  const worker = readFileSync(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");
  expect(() => new Function(worker)).not.toThrow();
  expect(worker).toContain("sensitiveRefs.has");
  expect(worker).toContain("MutationObserver");
  expect(worker).toContain("waitForVisibleChange");
  expect(worker).toContain("visibleText");
  expect(worker).toContain("editableRoot");
  expect(worker).toContain("detectedMs");
  expect(worker).toContain("state: stateId(last)");
  expect(worker).toContain("typing verification failed");
  expect(worker).toContain("Neko - AI active");
  expect(worker).toContain("control-indicator.js");
  expect(worker).toContain("chrome.alarms.onAlarm");
  expect(worker).toContain("authentication failed");
  expect(worker).toContain('detach("switch-tab")');
  expect(worker).not.toContain("document.cookie");
  const popup = readFileSync(new URL("../browser-extension/popup.js", import.meta.url), "utf8");
  expect(() => new Function(popup)).not.toThrow();
  expect(popup).not.toContain("innerHTML");
  const indicator = readFileSync(new URL("../browser-extension/control-indicator.js", import.meta.url), "utf8");
  expect(() => new Function(indicator)).not.toThrow();
  expect(indicator).toContain("Neko is using this tab");
  expect(indicator).toContain('type: "stop"');
});
