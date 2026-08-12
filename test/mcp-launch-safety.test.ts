import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { __resolveMcpStdioLaunchForTest, type McpServerConfig } from "../src/adapters/mcp.ts";
import { resolveWindowsSystemExecutable } from "../src/shared/windows-system.ts";

function fakeWindows(files: string[], directories: string[], aliases: Record<string, string> = {}) {
  const normalize = (path: string) => win32.normalize(path).toLowerCase();
  const fileSet = new Set(files.map(normalize));
  const directorySet = new Set(directories.map(normalize));
  const aliasMap = new Map(Object.entries(aliases).map(([from, to]) => [normalize(from), win32.normalize(to)]));
  const realpath = (path: string): string => {
    const key = normalize(path);
    const alias = aliasMap.get(key);
    if (alias) return alias;
    if (fileSet.has(key) || directorySet.has(key)) return win32.normalize(path);
    throw new Error(`ENOENT: ${path}`);
  };
  return {
    platform: "win32" as const,
    workspace: "C:\\repo",
    home: "C:\\Users\\Alice",
    processExecPath: "C:\\Trusted\\bun.exe",
    env: {} as NodeJS.ProcessEnv,
    realpath,
    kind(path: string) {
      const key = normalize(path);
      return fileSet.has(key) ? "file" as const : directorySet.has(key) ? "directory" as const : null;
    },
    isExecutable: () => true,
    ensureDirectory(path: string) { directorySet.add(normalize(path)); },
    windowsSystemExecutable: (name: string) => /powershell\.exe$/i.test(name)
      ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      : "C:\\Windows\\System32\\cmd.exe",
  };
}

const WINDOWS_FILES = [
  "C:\\repo\\node.exe",
  "C:\\repo\\bin\\node.exe",
  "C:\\repo\\explicit.exe",
  "C:\\repo\\server.ps1",
  "C:\\Trusted\\bun.exe",
  "C:\\Trusted\\node.exe",
  "C:\\Trusted\\npx.cmd",
  "C:\\Windows\\System32\\cmd.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
];
const WINDOWS_DIRS = [
  "C:\\repo",
  "C:\\repo\\bin",
  "C:\\repo\\server-work",
  "C:\\Trusted",
  "C:\\Links",
  "C:\\Windows\\System32",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
];

test("Windows MCP bare command ignores cwd/workspace PATH shims and launches from a trusted cwd", () => {
  const checks = fakeWindows(WINDOWS_FILES, WINDOWS_DIRS);
  checks.env = {
    PATH: ".;C:\\repo;C:\\repo\\bin;C:\\Trusted",
    NODE_OPTIONS: "--require C:\\repo\\inject.js",
    NEKO_API_KEY: "ambient-secret",
    ORDINARY_VALUE: "kept",
    COMSPEC: "C:\\repo\\cmd.exe",
  };
  const launch = __resolveMcpStdioLaunchForTest(
    { command: "node", args: ["server.js"], env: { userprofile: "C:\\Explicit", EXPLICIT_VALUE: "granted" } },
    { ...checks, childSecretEnvNames: ["NEKO_API_KEY"] },
  );

  expect(launch.command.toLowerCase()).toBe("c:\\trusted\\node.exe");
  expect(launch.command.toLowerCase()).not.toContain("c:\\repo\\");
  expect(launch.cwd.toLowerCase()).toBe("c:\\users\\alice\\.neko-core\\mcp-runtime");
  expect(launch.env.PATH.toLowerCase()).toBe("c:\\trusted");
  expect(launch.env.NODE_OPTIONS).toBeUndefined();
  expect(launch.env.NEKO_API_KEY).toBeUndefined();
  expect(launch.env.ORDINARY_VALUE).toBeUndefined();
  expect(launch.env.EXPLICIT_VALUE).toBe("granted");
  expect(launch.env.USERPROFILE).toBe("C:\\Explicit");
  expect(launch.env.userprofile).toBeUndefined();
  expect(launch.env.COMSPEC.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
});

test("Windows MCP rejects a PATH candidate whose canonical target points back into the workspace", () => {
  const checks = fakeWindows(
    WINDOWS_FILES,
    WINDOWS_DIRS,
    { "C:\\Links\\node.exe": "C:\\repo\\node.exe" },
  );
  checks.env = { PATH: "C:\\Links;C:\\Trusted" };
  const launch = __resolveMcpStdioLaunchForTest({ command: "node" }, checks);
  expect(launch.command.toLowerCase()).toBe("c:\\trusted\\node.exe");
});

test("Windows MCP resolves npx.cmd and delegates through canonical Windows PowerShell", () => {
  const checks = fakeWindows(WINDOWS_FILES, WINDOWS_DIRS);
  checks.env = { PATH: "C:\\repo;C:\\Trusted" };
  const launch = __resolveMcpStdioLaunchForTest(
    { command: "npx", args: ["-y", "@example/mcp-server"] },
    checks,
  );
  expect(launch.command.toLowerCase()).toBe("c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe");
  expect(launch.args).toContain("-Command");
  expect(launch.args.at(-1)).not.toContain("C:\\Trusted\\npx.cmd");
  expect(launch.env.NEKO_MCP_WRAPPER_COMMAND.toLowerCase()).toBe("c:\\trusted\\npx.cmd");
  expect(JSON.parse(launch.env.NEKO_MCP_WRAPPER_ARGS_JSON)).toEqual(["-y", "@example/mcp-server"]);
});

test("MCP absolute command is explicit authority but remains canonical and regular", () => {
  const checks = fakeWindows(WINDOWS_FILES, WINDOWS_DIRS);
  checks.env = { PATH: "C:\\Trusted" };
  const launch = __resolveMcpStdioLaunchForTest(
    { command: "C:\\repo\\explicit.exe" },
    checks,
  );
  expect(launch.command.toLowerCase()).toBe("c:\\repo\\explicit.exe");
  expect(launch.cwd.toLowerCase()).not.toContain("c:\\repo");

  expect(() => __resolveMcpStdioLaunchForTest(
    { command: "C:\\repo" },
    checks,
  )).toThrow("canonical regular file");
  expect(() => __resolveMcpStdioLaunchForTest(
    { command: "C:\\repo\\server.ps1" },
    checks,
  )).toThrow("absolute interpreter");
});

test("MCP accepts only a canonical absolute explicit cwd", () => {
  const checks = fakeWindows(WINDOWS_FILES, WINDOWS_DIRS);
  checks.env = { PATH: "C:\\Trusted" };
  const launch = __resolveMcpStdioLaunchForTest(
    { command: "node", cwd: "C:\\repo\\server-work" },
    checks,
  );
  expect(launch.cwd.toLowerCase()).toBe("c:\\repo\\server-work");

  for (const cwd of ["server-work", "C:\\missing"]) {
    expect(() => __resolveMcpStdioLaunchForTest(
      { command: "node", cwd },
      checks,
    )).toThrow("absolute existing directory");
  }
});

test("MCP fails before spawn when PATH contains only workspace and UNC candidates", () => {
  const checks = fakeWindows(WINDOWS_FILES, WINDOWS_DIRS);
  checks.env = { PATH: ".;C:\\repo;C:\\repo\\bin;\\\\server\\share" };
  expect(() => __resolveMcpStdioLaunchForTest({ command: "node" }, checks))
    .toThrow("not found as a trusted executable outside the workspace");
});

test("MCP default runtime cwd rejects a junction back into the workspace and uses a trusted fallback", () => {
  const checks = fakeWindows(
    WINDOWS_FILES,
    WINDOWS_DIRS,
    { "C:\\Users\\Alice\\.neko-core\\mcp-runtime": "C:\\repo" },
  );
  checks.env = { PATH: "C:\\Trusted" };
  const launch = __resolveMcpStdioLaunchForTest({ command: "node", args: ["."] }, checks);
  expect(launch.cwd.toLowerCase()).toBe("c:\\trusted");
  expect(launch.args).toEqual(["."]);
});

test("MCP rejects malformed or oversized explicit args and env", () => {
  const checks = fakeWindows(WINDOWS_FILES, WINDOWS_DIRS);
  checks.env = { PATH: "C:\\Trusted" };
  expect(() => __resolveMcpStdioLaunchForTest({ command: "node", args: [1 as any] }, checks))
    .toThrow("bounded strings");
  expect(() => __resolveMcpStdioLaunchForTest({ command: "node", env: { BAD: "x".repeat(24 * 1024) } }, checks))
    .toThrow(/invalid key or value|aggregate safety limit/);
});

test.skipIf(process.platform !== "win32" || (process.env.CI === "true"
  && process.env.NEKO_REQUIRE_WINDOWS_MCP_LAUNCH_TEST !== "1"))(
  "Windows MCP PowerShell wrapper launches a real spaced-path cmd with argv intact",
  () => {
  const root = mkdtempSync(join(tmpdir(), "neko mcp wrapper "));
  const workspace = join(root, "workspace");
  const home = join(root, "home with spaces");
  const tools = join(root, "tools with spaces");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(tools, { recursive: true });
  const script = join(tools, "probe.cmd");
  writeFileSync(script, [
    "@echo off",
    'if not "%~1"=="hello world" exit /b 41',
    'if not "%~2"=="C:\\trail\\" exit /b 42',
    "if defined NEKO_MCP_WRAPPER_COMMAND exit /b 43",
    "if defined NEKO_MCP_WRAPPER_ARGS_JSON exit /b 44",
    "echo MCP_WRAPPER_OK",
  ].join("\r\n"));
  try {
    const launch = __resolveMcpStdioLaunchForTest(
      { command: "probe", args: ["hello world", "C:\\trail\\"] },
      {
        platform: "win32",
        workspace,
        home,
        processExecPath: process.execPath,
        env: { ...process.env, PATH: `${tools};${process.env.PATH ?? ""}` },
        realpath: (path) => realpathSync.native(path),
        kind: (path) => {
          try {
            const stat = statSync(path);
            return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
          } catch { return null; }
        },
        isExecutable: () => true,
        ensureDirectory: (path) => { mkdirSync(path, { recursive: true }); },
        windowsSystemExecutable: (name) => resolveWindowsSystemExecutable(name),
      },
    );
    const result = spawnSync(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...getDefaultEnvironment(), ...launch.env },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MCP_WRAPPER_OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  }, { timeout: 60_000 });
