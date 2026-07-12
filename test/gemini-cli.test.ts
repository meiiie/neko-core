import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  clearGeminiCredentials,
  discoverGeminiCli,
  explainGeminiCliError,
  geminiCredentialsPath,
  geminiUsageFromPrompt,
  GeminiAcpClient,
  hasGeminiCredentials,
} from "../src/adapters/gemini-cli.ts";

test("Gemini consumer OAuth deprecation becomes an actionable supported-route error", () => {
  const raw = "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products";
  const message = explainGeminiCliError(raw);
  expect(message).toContain("ended Gemini CLI sign-in for Free/AI Pro/Ultra on 2026-06-18");
  expect(message).toContain("Gemini API key");
  expect(message).toContain("Standard/Enterprise");
  expect(message).toContain("does not reuse its credentials");
});

test("Gemini CLI discovery verifies ACP-capable versions and reports old installs", () => {
  const env = { PATH: "C:\\bin", NEKO_GEMINI_PATH: "" } as NodeJS.ProcessEnv;
  const ready = discoverGeminiCli({
    env,
    platform: "win32",
    pathExists: (path) => path.endsWith("gemini.cmd"),
    runVersion: () => "0.50.0",
  });
  expect(ready.state).toBe("ready");
  expect(ready.executable?.path).toBe("C:\\bin\\gemini.cmd");
  const old = discoverGeminiCli({
    env,
    platform: "win32",
    pathExists: (path) => path.endsWith("gemini.cmd"),
    runVersion: () => "0.20.0",
  });
  expect(old.state).toBe("outdated");
});

test("Gemini discovery prefers the Neko-managed bundle and private runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-gemini-managed-"));
  try {
    const root = join(home, ".neko-core", "gemini-support");
    const runtimeName = process.platform === "win32" ? "node.exe" : "node";
    mkdirSync(join(root, "gemini"), { recursive: true });
    mkdirSync(join(root, "node"), { recursive: true });
    writeFileSync(join(root, "gemini", "gemini.js"), "bundle");
    writeFileSync(join(root, "node", runtimeName), "runtime");
    writeFileSync(join(root, "support-pack.json"), JSON.stringify({
      geminiVersion: "0.50.0",
      entry: "gemini/gemini.js",
      runtime: `node/${runtimeName}`,
    }));
    const status = discoverGeminiCli({ home, env: { PATH: "" }, platform: process.platform, runVersion: (executable) => executable.version ?? null });
    expect(status.state).toBe("ready");
    expect(status.executable?.source).toBe("managed");
    expect(status.executable?.runtime).toBe(join(root, "node", runtimeName));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gemini ACP transport correlates responses and fails closed on unsupported requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: any[] = [];
  input.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) if (line) written.push(JSON.parse(line));
  });
  const client = new GeminiAcpClient({ input, output, close: () => {} }, {
    onRequest: async (method) => method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : null,
  });
  const pending = client.initialize();
  await Bun.sleep(5);
  expect(written[0].method).toBe("initialize");
  expect(written[0].params.protocolVersion).toBe(1);
  output.write(JSON.stringify({ jsonrpc: "2.0", id: written[0].id, result: { protocolVersion: 1 } }) + "\n");
  expect(await pending).toEqual({ protocolVersion: 1 });

  output.write(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {} }) + "\n");
  await Bun.sleep(5);
  expect(written.find((message) => message.id === 77)?.result).toEqual({ outcome: { outcome: "cancelled" } });

  const auth = client.authenticate();
  await Bun.sleep(5);
  const authRequest = written.findLast((message) => message.method === "authenticate");
  output.write(JSON.stringify({ jsonrpc: "2.0", id: authRequest.id, error: {
    code: -32000,
    message: "This client is no longer supported for Gemini Code Assist for individuals. Migrate to the Antigravity suite.",
  } }) + "\n");
  await expect(auth).rejects.toThrow("use /login -> Google -> Gemini API key");
  client.close();
});

test("Gemini logout removes only OAuth state and clears the active account cache", () => {
  const old = process.env.NEKO_GEMINI_HOME;
  const home = mkdtempSync(join(tmpdir(), "neko-gemini-auth-"));
  const standalone = join(home, "standalone", ".gemini", "oauth_creds.json");
  process.env.NEKO_GEMINI_HOME = home;
  try {
    const dir = home;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oauth_creds.json"), JSON.stringify({ access_token: "secret" }));
    writeFileSync(join(dir, "google_accounts.json"), JSON.stringify({ active: "student@example.com", old: [] }));
    mkdirSync(join(home, "standalone", ".gemini"), { recursive: true });
    writeFileSync(standalone, JSON.stringify({ access_token: "standalone-secret" }));
    expect(geminiCredentialsPath()).toBe(join(dir, "oauth_creds.json"));
    expect(hasGeminiCredentials()).toBe(true);
    expect(clearGeminiCredentials()).toContain("signed out");
    expect(hasGeminiCredentials()).toBe(false);
    expect(existsSync(standalone)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "google_accounts.json"), "utf8"))).toEqual({ active: null, old: ["student@example.com"] });
  } finally {
    if (old === undefined) delete process.env.NEKO_GEMINI_HOME; else process.env.NEKO_GEMINI_HOME = old;
  }
});

test("Gemini ACP quota metadata maps to stable token usage", () => {
  expect(geminiUsageFromPrompt({ _meta: { quota: {
    token_count: { input_tokens: 120, output_tokens: 30 },
    model_usage: [{ model: "gemini-3.1-pro-preview", token_count: { input_tokens: 120, output_tokens: 30 } }],
  } } })).toEqual({
    inputTokens: 120,
    outputTokens: 30,
    models: [{ model: "gemini-3.1-pro-preview", inputTokens: 120, outputTokens: 30 }],
  });
});
