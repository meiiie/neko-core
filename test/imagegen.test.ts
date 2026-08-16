/** Image generation over the Codex app-server bridge - mocked client, no network, no credits. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateImage, type ImageClientFactory } from "../src/adapters/imagegen.ts";
import { saveChatGptCredentials } from "../src/adapters/chatgpt-auth.ts";
import type { CodexAppServerHandlers } from "../src/adapters/codex-app-server.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // a real PNG signature

const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
let tempHome = "";
function isolate(): void {
  tempHome = mkdtempSync(join(tmpdir(), "neko-imagegen-"));
  process.env.USERPROFILE = tempHome; process.env.HOME = tempHome;
  saveChatGptCredentials({ accessToken: "h.p.s", refreshToken: "r", expiresAt: Date.now() + 3_600_000, accountId: "acct-1" });
}
afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = "";
  if (saved.up === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.up;
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
});

function factory(overrides: { capability?: boolean; itemStatus?: string } = {}) {
  const requests: string[] = [];
  const threadStart: any = {};
  const make: ImageClientFactory = (handlers: CodexAppServerHandlers) => ({
    initialize: async () => ({}),
    close: () => {},
    request: async (method: string, params?: any) => {
      requests.push(method);
      if (method === "modelProvider/capabilities/read") {
        return { imageGeneration: overrides.capability ?? true, namespaceTools: true, webSearch: true };
      }
      if (method === "thread/start") {
        Object.assign(threadStart, params);
        return { thread: { id: "t-img" } };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          handlers.onNotification?.("item/completed", {
            threadId: "t-img", turnId: "turn-1",
            item: { type: "imageGeneration", id: "i1", status: overrides.itemStatus ?? "completed", result: PNG.toString("base64"), revisedPrompt: "a calm cat, studio light" },
          });
          handlers.onNotification?.("turn/completed", { threadId: "t-img", turn: { id: "turn-1", status: "completed" } });
        }, 0);
        return { turn: { id: "turn-1" } };
      }
      return {};
    },
  });
  return { factory: make, requests, threadStart };
}

test("generateImage: capability checked first, PNG lands at the requested project path", async () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "neko-img-root-"));
  try {
    const { factory: make, requests, threadStart } = factory();
    const result = await generateImage(root, "a calm cat", "art/cat.png", make);
    expect(result.path).toBe(join(root, "art", "cat.png"));
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path).subarray(0, 8).equals(PNG)).toBe(true);
    expect(result.revisedPrompt).toContain("studio light");
    // The capability read happens BEFORE any thread exists - fail closed before spending.
    expect(requests.indexOf("modelProvider/capabilities/read")).toBeLessThan(requests.indexOf("thread/start"));
    expect(threadStart.environments).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generateImage: capability=false fails closed with an honest message, no thread started", async () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "neko-img-nocap-"));
  try {
    const { factory: make, requests } = factory({ capability: false });
    await expect(generateImage(root, "anything", undefined, make)).rejects.toThrow(/does not advertise image generation/);
    expect(requests).not.toContain("thread/start"); // nothing was spent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generateImage: a path escaping the project root is refused", async () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "neko-img-escape-"));
  try {
    const { factory: make } = factory();
    await expect(generateImage(root, "x", "../outside.png", make)).rejects.toThrow(/inside the project only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
