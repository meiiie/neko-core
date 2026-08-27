/** `neko doctor` terminal/input diagnostics - the "renders but won't take keys" triage surface. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, NekoConfig } from "../src/adapters/config.ts";
import { collectChecks, collectTerminalChecks, srtToolchainCheck, terminalName } from "../src/adapters/doctor.ts";
import { saveKimiCredentials } from "../src/adapters/kimi-auth.ts";
import { saveClineCredentials } from "../src/adapters/cline-auth.ts";

test("terminalName identifies the host from the env, most-specific first", () => {
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(terminalName({ TERM_PROGRAM: "WezTerm", WT_SESSION: "x" } as any)).toBe("WezTerm");
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(terminalName({ WT_SESSION: "guid" } as any)).toBe("Windows Terminal");
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(terminalName({ ConEmuANSI: "ON" } as any)).toBe("ConEmu/Cmder");
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  expect(terminalName({ TERM: "xterm-256color" } as any)).toBe("xterm-256color");
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  const bare = terminalName({} as any);
  expect(bare === "legacy console (conhost)" || bare === "unknown").toBe(true); // platform-dependent
});

test("doctor explains when a persisted GPT-5.6 model needs the optional bridge", () => {
  const cfg = new NekoConfig({ provider: "chatgpt", model: "gpt-5.6-luna" }, "chatgpt", {}, "");
  const model = collectChecks(cfg, { state: "missing", detail: "not installed" }).find((check) => check.name === "model")!;
  expect(model.status).toBe("warn");
  expect(model.detail).toContain("Support Pack");
});

test("doctor accepts GPT-5.6 when the Codex bridge is ready", () => {
  const cfg = new NekoConfig({ provider: "chatgpt", model: "gpt-5.6-luna" }, "chatgpt", {}, "");
  const model = collectChecks(cfg, { state: "ready", detail: "path 0.144.1" }).find((check) => check.name === "model")!;
  expect(model.status).toBe("ok");
  expect(model.detail).toContain("Codex bridge");
});

test("doctor names the optional Gemini CLI dependency without treating it as an API endpoint", () => {
  const cfg = new NekoConfig({ provider: "gemini_cli", model: "auto" }, "gemini", { gemini: { auth: "gemini_oauth" } }, "");
  const checks = collectChecks(cfg, undefined, { state: "missing", detail: "not installed" });
  expect(checks.find((check) => check.name === "model")).toMatchObject({ status: "warn", detail: expect.stringContaining("official Gemini CLI") });
  expect(checks.find((check) => check.name === "base_url")).toMatchObject({ status: "ok", detail: expect.stringContaining("ACP stdio") });
});

test("doctor requires a client key when a loopback profile declares API-key auth", () => {
  const cfg = new NekoConfig(
    { provider: "openai_compat", model: "test", base_url: "http://127.0.0.1:9999/v1" },
    "gateway",
    { gateway: { auth: "api_key" } },
    "",
  );
  expect(collectChecks(cfg).find((check) => check.name === "api_key")).toMatchObject({ status: "warn", detail: expect.stringContaining("missing") });
});

test("doctor names the active provider's key environment variable", () => {
  const cfg = new NekoConfig(
    { provider: "responses", model: "grok-4.5", base_url: "https://api.x.ai/v1" },
    "xai",
    { xai: { auth: "api_key", key_env: "XAI_API_KEY" } },
    "",
  );
  expect(collectChecks(cfg).find((check) => check.name === "api_key")?.detail).toContain("XAI_API_KEY");
});

test("doctor does not claim Kimi account access before the first request verifies it", () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "neko-doctor-kimi-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    saveKimiCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600 });
    const config = new NekoConfig({ provider: "kimi" }, "kimi", { kimi: { auth: "kimi_oauth" } }, "");
    const check = collectChecks(config).find((item) => item.name === "kimi_auth")!;
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("access is checked on the first request");
    expect(check.detail.includes("signed in")).toBe(false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports Cline Account OAuth separately from API-key billing", () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "neko-doctor-cline-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const config = new NekoConfig({ provider: "cline_account" }, "cline-account", { "cline-account": { auth: "cline_oauth" } }, "");
    expect(collectChecks(config).find((item) => item.name === "cline_auth"))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("neko login cline account") });
    saveClineCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, tokenType: "Bearer" });
    expect(collectChecks(config).find((item) => item.name === "cline_auth"))
      .toMatchObject({ status: "ok", detail: expect.stringContaining("WorkOS device OAuth") });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor distinguishes durable, attached, and ephemeral browser sessions", () => {
  const check = (args?: string[]) => collectChecks(new NekoConfig({
    provider: "openai_compat", model: "test", base_url: "http://localhost",
    ...(args ? { mcp_servers: { browser: { command: "bunx", args } } } : undefined),
  }, null, {}, "")).find((item) => item.name === "browser")!;
  expect(check(["@playwright/mcp", "--user-data-dir", "C:/neko-browser"])).toMatchObject({ status: "ok", detail: expect.stringContaining("persistent") });
  expect(check(["@playwright/mcp", "--extension"])).toMatchObject({ status: "ok", detail: expect.stringContaining("existing Chrome") });
  expect(check(["@playwright/mcp", "--isolated"])).toMatchObject({ status: "warn", detail: expect.stringContaining("logins are discarded") });
  expect(check()).toMatchObject({ status: "warn", detail: expect.stringContaining("not configured") });
});

test("doctor does not call the browser bridge ready before the extension connects", () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "neko-doctor-browser-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".neko-core");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "browser-bridge.json"), JSON.stringify({
      version: 1, host: "127.0.0.1", port: 8766, session: "session-test", token: "token-test",
    }));
    writeFileSync(join(dir, "browser-bridge-status.json"), JSON.stringify({
      online: true, extensionConnected: false, attached: null, updatedAt: Date.now(),
    }));
    const config = new NekoConfig({}, null, {}, "");
    expect(collectChecks(config).find((check) => check.name === "browser_bridge"))
      .toMatchObject({ status: "warn", detail: expect.stringContaining("extension is not connected") });

    writeFileSync(join(dir, "browser-bridge-status.json"), JSON.stringify({
      online: true, extensionConnected: true, attached: null, updatedAt: Date.now(),
    }));
    expect(collectChecks(config).find((check) => check.name === "browser_bridge"))
      .toMatchObject({ status: "ok", detail: expect.stringContaining("extension connected") });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor surfaces the resident UIA fast path and rollback state", () => {
  const on = collectChecks(new NekoConfig({}, null, {}, "")).find((check) => check.name === "computer_use");
  const off = collectChecks(new NekoConfig({ computer_use_resident: false }, null, {}, "")).find((check) => check.name === "computer_use");
  expect(on?.detail).toContain("resident UIA/input/capture on");
  expect(off?.detail).toContain("fallback");
});

test("doctor labels auto mode without a live sandbox as unconfined", () => {
  const checks = collectChecks(new NekoConfig({ mode: "auto", sandbox: false }, null, {}, ""));
  expect(checks.find((check) => check.name === "mode"))
    .toMatchObject({ status: "warn", detail: expect.stringContaining("UNCONFINED AUTO") });
  expect(checks.find((check) => check.name === "bash_sandbox"))
    .toMatchObject({ status: "warn", detail: expect.stringContaining("UNCONFINED AUTO") });
});

test("doctor reports present-but-unhealthy SRT as fail-closed rather than unconfined", () => {
  const checks = collectChecks(
    new NekoConfig({ mode: "auto", sandbox: true }, null, {}, ""),
    undefined,
    undefined,
    { kind: "srt", live: false, provisioned: true, detail: "state database unavailable" },
  );
  const mode = checks.find((check) => check.name === "mode")!;
  const sandbox = checks.find((check) => check.name === "bash_sandbox")!;

  expect(mode).toMatchObject({ status: "warn", detail: expect.stringContaining("FAILS CLOSED") });
  expect(sandbox).toMatchObject({ status: "warn", detail: expect.stringContaining("FAILS CLOSED") });
  expect(`${mode.detail}\n${sandbox.detail}`).not.toContain("UNCONFINED AUTO");
});

test("doctor calls configured-but-unavailable sandbox unconfined in auto mode", () => {
  const checks = collectChecks(
    new NekoConfig({ mode: "auto", sandbox: true }, null, {}, ""),
    undefined,
    undefined,
    { kind: "none", live: false },
  );
  expect(checks.find((check) => check.name === "mode")?.detail).toContain("UNCONFINED AUTO");
  expect(checks.find((check) => check.name === "bash_sandbox")?.detail).toContain("UNCONFINED AUTO");
});

test("doctor distinguishes a source-run SRT Bun bridge from compiled Neko without an external toolchain", () => {
  expect(srtToolchainCheck(true, "srt", Object.freeze({ path: "C:\\tools\\bun.exe", source: "runtime" })))
    .toMatchObject({ status: "ok", detail: expect.stringContaining("source-run Bun") });
  expect(srtToolchainCheck(true, "srt", null))
    .toMatchObject({ status: "warn", detail: expect.stringContaining("no bun.exe found for the SRT bridge") });
  expect(srtToolchainCheck(false, "srt", null)).toBeNull();
  expect(srtToolchainCheck(true, "bwrap", null)).toBeNull();
});

test("collectTerminalChecks reports terminal, tty state, ui_fps, and the keys-probe pointer", () => {
  const checks = collectTerminalChecks();
  const names = checks.map((c) => c.name);
  expect(names).toEqual(["terminal", "tty", "ui_fps", "input_probe"]);
  // Under the test runner stdin/stdout are pipes, not TTYs - the check must SAY so, as a warn.
  const tty = checks.find((c) => c.name === "tty")!;
  if (!process.stdin.isTTY) expect(tty.status).toBe("warn");
  expect(checks.find((c) => c.name === "input_probe")!.detail).toContain("neko doctor keys");
  expect(checks.find((c) => c.name === "ui_fps")!.detail).toMatch(/\d+fps via /);
});

test("doctor WARNS when a top-level config model shadows the selected profile's preset (names the file)", () => {
  delete process.env.NEKO_MODEL; // other test FILES set it and env leaks across files (bun shares the process)
  const dir = mkdtempSync(join(tmpdir(), "neko-doc-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ model: "z-ai/glm-4.6" }));
  const model = collectChecks(loadConfig({ path, profile: "openai" })).find((c) => c.name === "model")!;
  expect(model.status).toBe("warn");
  expect(model.detail).toContain(path); // the EXACT file to fix
  expect(model.detail).toContain("gpt-4o-mini"); // what the profile would have used
  expect(model.detail).toContain("profiles.openai.model"); // the fix
  // ...and a clean profile pick stays ok
  writeFileSync(path, JSON.stringify({}));
  expect(collectChecks(loadConfig({ path, profile: "openai" })).find((c) => c.name === "model")!.status).toBe("ok");
});
