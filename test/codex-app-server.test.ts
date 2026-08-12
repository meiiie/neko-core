import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  __codexChildEnvForTest,
  __codexLaunchForTest,
  CodexAppServerClient,
  codexAppServerArguments,
  codexIsolationHome,
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

test("Codex transport home ignores relative and workspace overrides", () => {
  const home = "C:\\Users\\Neko";
  const workspace = "C:\\work\\project";
  const fallback = "C:\\Users\\Neko\\.neko-core\\codex-home";
  expect(codexIsolationHome(home, { NEKO_CODEX_HOME: ".\\codex-home" }, "win32", workspace)).toBe(fallback);
  expect(codexIsolationHome(home, { NEKO_CODEX_HOME: `${workspace}\\.codex-home` }, "win32", workspace)).toBe(fallback);
  expect(codexIsolationHome(home, { NEKO_CODEX_HOME: "C:\\transport\\codex-home" }, "win32", workspace))
    .toBe("C:\\transport\\codex-home");
  expect(codexIsolationHome(home, { NEKO_CODEX_HOME: "C:\\work\\project-sibling" }, "win32", workspace))
    .toBe("C:\\work\\project-sibling");
  expect(() => codexIsolationHome(workspace, {}, "win32", workspace)).toThrow(/outside the workspace/);
  expect(codexIsolationHome(workspace, { NEKO_CODEX_HOME: "C:\\transport\\codex-home" }, "win32", workspace))
    .toBe("C:\\transport\\codex-home");
});

test("Codex transport home rejects a missing path through a junction into the workspace", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-codex-home-boundary-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  const home = join(outside, "home");
  const alias = join(outside, "workspace-alias");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const candidate = join(alias, "future", "codex-home");
    expect(codexIsolationHome(home, { NEKO_CODEX_HOME: candidate }, process.platform, workspace))
      .toBe(join(home, ".neko-core", "codex-home"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("App Server disables native surfaces and only enables realtime when requested", () => {
  const disabled = [
    "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
    "goals", "hooks", "image_generation", "in_app_browser", "multi_agent", "plugins",
    "plugin_sharing", "remote_plugin", "shell_tool", "skill_mcp_dependency_install", "tool_suggest",
    "workspace_dependencies",
  ].flatMap((name) => ["--disable", name]);
  const disabledConfig = [
    "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
    "goals", "hooks", "image_generation", "in_app_browser", "multi_agent", "plugins",
    "plugin_sharing", "remote_plugin", "shell_tool", "skill_mcp_dependency_install", "tool_suggest",
    "workspace_dependencies",
  ].flatMap((name) => ["-c", `features.${name}=false`]);
  const noNativeSkillCatalog = ["-c", "skills.include_instructions=false"];
  const noProjectInstructions = ["-c", "project_doc_max_bytes=0", "-c", "project_root_markers=[]"];
  expect(codexAppServerArguments(
    { path: "codex.cmd", kind: "cli", source: "path", version: "0.144.1" },
    { enableRealtimeConversation: true },
  )).toEqual(["app-server", ...disabled, ...noNativeSkillCatalog, ...noProjectInstructions, "--enable", "realtime_conversation", "--listen", "stdio://"]);
  expect(codexAppServerArguments(
    { path: "codex-app-server.exe", kind: "app-server", source: "managed", version: "0.144.1" },
    { enableRealtimeConversation: true },
  )).toEqual([...disabledConfig, ...noNativeSkillCatalog, ...noProjectInstructions, "-c", "features.realtime_conversation=true", "--listen", "stdio://"]);
  expect(codexAppServerArguments(
    { path: "codex-app-server.exe", kind: "app-server", source: "managed", version: "0.144.1" },
    {},
  )).toEqual([...disabledConfig, ...noNativeSkillCatalog, ...noProjectInstructions, "--listen", "stdio://"]);

  const imageArgs = codexAppServerArguments(
    { path: "codex.cmd", kind: "cli", source: "path", version: "0.144.1" },
    { allowImageGeneration: true },
  );
  expect(imageArgs).not.toEqual(expect.arrayContaining(["--disable", "image_generation"]));
  expect(imageArgs).toEqual(expect.arrayContaining(["--disable", "computer_use"]));
  expect(imageArgs).toEqual(expect.arrayContaining(noNativeSkillCatalog));
  expect(imageArgs).toEqual(expect.arrayContaining(noProjectInstructions));
});

test("support discovery prefers a compatible managed pack without requiring Codex Desktop", () => {
  const home = "C:\\Users\\Neko";
  const manifest = `${home}\\.neko-core\\codex-support\\support-pack.json`;
  const executable = `${home}\\.neko-core\\codex-support\\codex-app-server.exe`;
  const status = discoverCodexSupport({
    home,
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "" },
    pathExists: (path) => path === manifest || path === executable,
    realpath: (path) => path,
    isRegularFile: (path) => path === executable,
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
    cwd: "/workspace",
    env: { PATH: "/usr/bin" },
    pathExists: (path) => path === "/usr/bin/codex",
    realpath: (path) => path,
    isRegularFile: (path) => path === "/usr/bin/codex",
    runVersion: () => "0.143.9",
  });
  expect(status.state).toBe("outdated");
  expect(status.detail).toContain("0.144.0");
});

test("Codex PATH discovery rejects canonical workspace targets and non-files", () => {
  const workspace = "C:\\work";
  const outside = "C:\\tools\\codex.exe";
  const redirected = discoverCodexSupport({
    platform: "win32",
    home: "C:\\home",
    cwd: workspace,
    env: { PATH: "C:\\tools" },
    pathExists: () => true,
    realpath: (path) => path === outside ? `${workspace}\\codex.exe` : path,
    isRegularFile: (path) => path === `${workspace}\\codex.exe`,
    runVersion: () => "0.150.0",
  });
  expect(redirected.state).toBe("missing");

  const directory = discoverCodexSupport({
    platform: "win32",
    home: "C:\\home",
    cwd: workspace,
    env: { PATH: "C:\\tools" },
    pathExists: () => true,
    realpath: (path) => path,
    isRegularFile: () => false,
    runVersion: () => "0.150.0",
  });
  expect(directory.state).toBe("missing");

  const relativePath = discoverCodexSupport({
    platform: "win32",
    home: "C:\\home",
    cwd: workspace,
    env: { PATH: "..\\tools" },
    pathExists: () => true,
    realpath: (path) => path,
    isRegularFile: () => true,
    runVersion: () => "0.150.0",
  });
  expect(relativePath.state).toBe("missing");
});

test("absolute NEKO_CODEX_PATH is explicit workspace authority but a relative override is ignored", () => {
  const workspace = "C:\\work";
  const explicit = `${workspace}\\codex.exe`;
  const ready = discoverCodexSupport({
    platform: "win32",
    home: "C:\\home",
    cwd: workspace,
    env: { PATH: "", NEKO_CODEX_PATH: explicit },
    pathExists: () => true,
    realpath: (path) => path,
    isRegularFile: (path) => path === explicit,
    runVersion: () => "0.150.0",
  });
  expect(ready.state).toBe("ready");
  expect(ready.executable?.source).toBe("environment");

  const relative = discoverCodexSupport({
    platform: "win32",
    home: "C:\\home",
    cwd: workspace,
    env: { PATH: "", NEKO_CODEX_PATH: ".\\codex.exe" },
    pathExists: () => true,
    realpath: (path) => path,
    isRegularFile: () => true,
    runVersion: () => "0.150.0",
  });
  expect(relative.state).toBe("missing");
});

test("Codex Windows shim uses only an absolute Node outside the workspace", () => {
  const bundle = "C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js";
  const trustedNode = "C:\\Program Files\\nodejs\\node.exe";
  const launch = __codexLaunchForTest(
    { path: "C:\\tools\\codex.cmd", kind: "cli", source: "path" },
    ["--version"],
    {
      platform: "win32",
      env: { PATH: "C:\\work\\bin;C:\\Program Files\\nodejs" },
      cwd: "C:\\work",
      realpath: (path) => path,
      isRegularFile: (path) => [bundle, "C:\\work\\bin\\node.exe", trustedNode].includes(path),
    },
  );
  expect(launch).toEqual({ command: trustedNode, args: [bundle, "--version"] });
});

test("Codex POSIX JS shim bypasses env-node and standalone PowerShell is rejected", () => {
  const posix = __codexLaunchForTest(
    { path: "/opt/codex/codex.js", kind: "cli", source: "path" },
    ["--version"],
    {
      platform: "linux",
      env: { PATH: "/work/bin:/usr/bin" },
      cwd: "/work",
      realpath: (path) => path,
      isRegularFile: (path) => ["/work/bin/node", "/usr/bin/node"].includes(path),
    },
  );
  expect(posix).toEqual({ command: "/usr/bin/node", args: ["/opt/codex/codex.js", "--version"] });
  const extensionless = __codexLaunchForTest(
    { path: "/opt/codex/codex", kind: "cli", source: "path" },
    ["--version"],
    {
      platform: "linux",
      env: { PATH: "/work/bin:/usr/bin" },
      cwd: "/work",
      realpath: (path) => path,
      isRegularFile: (path) => ["/work/bin/node", "/usr/bin/node"].includes(path),
      readPrefix: () => "#!/usr/bin/env node\n",
    },
  );
  expect(extensionless).toEqual({ command: "/usr/bin/node", args: ["/opt/codex/codex", "--version"] });

  const launch = __codexLaunchForTest(
    { path: "C:\\authorized\\codex.ps1", kind: "cli", source: "environment" },
    ["--version"],
    {
      platform: "win32",
      env: { PATH: "" },
      cwd: "C:\\work",
      realpath: (path) => path,
      isRegularFile: () => false,
    },
  );
  expect(launch).toBeNull();
});

test("Codex sidecar child env strips ambient provider and cloud credentials", () => {
  expect(__codexChildEnvForTest({
    Path: "C:\\work\\bin;C:\\trusted-bin;..\\relative-bin;C:\\linked-bin",
    BROWSER: "C:\\work\\browser.exe",
    CODEX_HOME: "C:\\required-auth-home",
    OPENAI_API_KEY: "secret",
    CUSTOM_PROVIDER_API_KEY: "secret",
    AWS_ACCESS_KEY_ID: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    GOOGLE_APPLICATION_CREDENTIALS: "C:\\secret.json",
    GITHUB_PAT: "secret",
    PGPASSWORD: "secret",
    MYSQL_PWD: "secret",
    DOCKER_AUTH_CONFIG: "secret",
    NODE_OPTIONS: "--require=.\\workspace-preload.js",
    ARBITRARY_CONFIGURED_KEY_ENV: "secret",
    ORDINARY_VALUE: "kept",
  }, {
    platform: "win32",
    cwd: "C:\\work",
    realpath: (path) => path === "C:\\linked-bin" ? "C:\\work\\linked-bin" : path,
    isRegularFile: () => true,
  })).toEqual({ Path: "C:\\trusted-bin", CODEX_HOME: "C:\\required-auth-home" });
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

test("a binary removed after discovery fails closed before spawn", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-missing-codex-"));
  try {
    expect(() => startCodexAppServer(
      { path: join(home, "missing-codex-app-server"), kind: "app-server", source: "managed", version: "0.144.1" },
      {},
      { codexHome: join(home, "codex-home") },
    )).toThrow("trusted absolute regular file");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
