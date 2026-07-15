import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrowserBridge, startManagedBrowserBridge, type BrowserCapability } from "../src/adapters/browser-bridge.ts";
import { browserStoreUrl, prepareBrowserExtension } from "../src/adapters/browser-extension-install.ts";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
  expect(await nextMessage(ws)).toEqual({ type: "ready", session: "session-test" });
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

test("browser extension stays active-tab scoped", () => {
  const manifest = JSON.parse(readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  expect(manifest.permissions).toContain("activeTab");
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
