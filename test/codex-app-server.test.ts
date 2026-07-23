import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  CodexAppServerClient,
  codexAppServerArguments,
  compareCodexVersions,
  discoverCodexSupport,
  startCodexAppServer,
  type RpcTransport,
} from "../src/adapters/codex-app-server.ts";

function fakeTransport(): { transport: RpcTransport; toServer: PassThrough; fromServer: PassThrough } {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  return {
    toServer,
    fromServer,
    transport: { input: toServer, output: fromServer, close: () => fromServer.end() },
  };
}

async function nextMessage(stream: PassThrough): Promise<any> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk.toString();
    const newline = text.indexOf("\n");
    if (newline >= 0) return JSON.parse(text.slice(0, newline));
  }
  throw new Error("stream closed");
}

test("Codex version comparison handles the 0.144 support boundary", () => {
  expect(compareCodexVersions("0.144.0", "0.144.0")).toBe(0);
  expect(compareCodexVersions("0.144.1", "0.144.0")).toBe(1);
  expect(compareCodexVersions("0.143.9", "0.144.0")).toBe(-1);
  expect(compareCodexVersions("0.144.0-beta.1", "0.144.0")).toBe(-1);
});

test("voice launches App Server with the gated realtime feature enabled", () => {
  expect(codexAppServerArguments(
    { path: "codex.cmd", kind: "cli", source: "path", version: "0.144.1" },
    { enableRealtimeConversation: true },
  )).toEqual(["app-server", "--enable", "realtime_conversation", "--listen", "stdio://"]);
  expect(codexAppServerArguments(
    { path: "codex-app-server.exe", kind: "app-server", source: "managed", version: "0.144.1" },
    {},
  )).toEqual(["--listen", "stdio://"]);
});

test("support discovery prefers a compatible managed pack without requiring Codex Desktop", () => {
  const home = "C:\\Users\\Neko";
  const manifest = `${home}\\.neko-core\\codex-support\\support-pack.json`;
  const executable = `${home}\\.neko-core\\codex-support\\codex-app-server.exe`;
  const status = discoverCodexSupport({
    home,
    platform: "win32",
    env: { PATH: "" },
    pathExists: (path) => path === manifest || path === executable,
    readText: () => JSON.stringify({ protocolVersion: "0.144.1", executable: "codex-app-server.exe" }),
  });
  expect(status.state).toBe("ready");
  expect(status.executable?.kind).toBe("app-server");
  expect(status.executable?.source).toBe("managed");
});

test("support discovery reports an installed but outdated CLI honestly", () => {
  const status = discoverCodexSupport({
    platform: "linux",
    home: "/home/neko",
    env: { PATH: "/usr/bin" },
    pathExists: (path) => path === "/usr/bin/codex",
    runVersion: () => "0.143.9",
  });
  expect(status.state).toBe("outdated");
  expect(status.detail).toContain("0.144.0");
});

test("JSON-RPC correlates responses and forwards notifications", async () => {
  const { transport, toServer, fromServer } = fakeTransport();
  const notifications: string[] = [];
  const client = new CodexAppServerClient(transport, { onNotification: (method) => notifications.push(method) });
  const pending = client.request("model/list", { limit: 20 });
  const request = await nextMessage(toServer);
  expect(request.method).toBe("model/list");
  fromServer.write(`${JSON.stringify({ id: request.id, result: { data: ["gpt-5.6-luna"] } })}\n`);
  fromServer.write(`${JSON.stringify({ method: "account/rateLimits/updated", params: {} })}\n`);
  expect(await pending).toEqual({ data: ["gpt-5.6-luna"] });
  await Bun.sleep(1);
  expect(notifications).toEqual(["account/rateLimits/updated"]);
  client.close();
});

test("JSON-RPC answers dynamic tool requests through the host callback", async () => {
  const { transport, toServer, fromServer } = fakeTransport();
  const client = new CodexAppServerClient(transport, {
    onRequest: async (method, params: any) => {
      expect(method).toBe("item/tool/call");
      return { contentItems: [{ type: "inputText", text: `echo:${params.arguments.value}` }], success: true };
    },
  });
  fromServer.write(`${JSON.stringify({ id: 91, method: "item/tool/call", params: { arguments: { value: "ok" } } })}\n`);
  const response = await nextMessage(toServer);
  expect(response).toEqual({ id: 91, result: { contentItems: [{ type: "inputText", text: "echo:ok" }], success: true } });
  client.close();
});

test("JSON-RPC surfaces protocol errors instead of hanging", async () => {
  const { transport, toServer, fromServer } = fakeTransport();
  const client = new CodexAppServerClient(transport);
  const pending = client.request("thread/start", {});
  const request = await nextMessage(toServer);
  fromServer.write(`${JSON.stringify({ id: request.id, error: { code: -32602, message: "bad params" } })}\n`);
  await expect(pending).rejects.toThrow("bad params");
  client.close();
});

test("closeAndWait does not resolve before the App Server transport exits", async () => {
  const { transport } = fakeTransport();
  let release!: () => void;
  transport.closed = new Promise<void>((resolve) => { release = resolve; });
  const client = new CodexAppServerClient(transport);
  let settled = false;
  const closing = client.closeAndWait().then(() => { settled = true; });
  await Bun.sleep(1);
  expect(settled).toBe(false);
  release();
  await closing;
  expect(settled).toBe(true);
});

test("a binary removed after discovery is a provider error, not a process crash", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-missing-codex-"));
  const client = startCodexAppServer(
    { path: join(home, "missing-codex-app-server"), kind: "app-server", source: "managed", version: "0.144.1" },
    {},
    { codexHome: join(home, "codex-home") },
  );
  try { await expect(client.initialize(2_000)).rejects.toThrow("Codex App Server closed"); }
  finally { client.close(); rmSync(home, { recursive: true, force: true }); }
});
