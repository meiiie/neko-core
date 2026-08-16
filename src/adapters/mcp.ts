/**
 * MCP (Model Context Protocol) client — the extensibility surface. Connects to MCP servers
 * declared in config (`mcp_servers`), lists their tools, and exposes them to the agent loop
 * as `mcp__<server>__<tool>`. Safe by default: with no servers configured, this is a no-op
 * and spawns nothing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { scrubChildEnv } from "../shared/child-env.ts";
import { homeDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";
import { resolveWindowsSystemExecutable } from "../shared/windows-system.ts";
import { connectWithOAuth } from "./mcp-oauth.ts";

import { isJsonObject, isText } from "../shared/wire.ts";

/** A local (stdio: command+args) or remote (url: http/sse) MCP server. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Explicit execution authority for a stdio server. Must be an absolute existing directory. */
  cwd?: string;
  type?: "stdio" | "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean; // interactive OAuth login for a protected remote server
}

type McpLaunch = { command: string; args: string[]; cwd: string; env: Record<string, string> };
type McpPathKind = "file" | "directory" | null;
type McpLaunchChecks = {
  platform: NodeJS.Platform;
  workspace: string;
  home: string;
  processExecPath: string;
  env: NodeJS.ProcessEnv;
  realpath: (path: string) => string;
  kind: (path: string) => McpPathKind;
  isExecutable: (path: string) => boolean;
  ensureDirectory: (path: string) => void;
  windowsSystemExecutable: (name: string) => string | null;
};

const AMBIENT_EXECUTION_ENV = new Set([
  "BASH_ENV", "BUN_CONFIG", "BUN_OPTIONS", "CDPATH", "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH", "ENV", "LD_LIBRARY_PATH", "LD_PRELOAD", "NODE_OPTIONS",
  "NODE_PATH", "PERL5OPT", "PYTHONHOME", "PYTHONPATH", "RUBYOPT",
]);

function nativeLaunchChecks(): McpLaunchChecks {
  return {
    platform: process.platform,
    workspace: process.cwd(),
    home: homeDir(),
    processExecPath: process.execPath,
    env: process.env,
    realpath: (path) => realpathSync.native(path),
    kind: (path) => {
      try {
        const stat = statSync(path);
        return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : null;
      } catch { return null; }
    },
    isExecutable: (path) => {
      if (process.platform === "win32") return true;
      try { return (statSync(path).mode & 0o111) !== 0; } catch { return false; }
    },
    ensureDirectory: (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
    windowsSystemExecutable: (name) => resolveWindowsSystemExecutable(name),
  };
}

function withinPath(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const normalizedRoot = platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = paths.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

function canonicalPath(path: string, kind: Exclude<McpPathKind, null>, checks: McpLaunchChecks): string | null {
  const paths = checks.platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(path) || path.includes("\0")) return null;
  try {
    const canonical = checks.realpath(path);
    if (!paths.isAbsolute(canonical) || checks.kind(canonical) !== kind) return null;
    return canonical;
  } catch { return null; }
}

function envValue(env: Record<string, string>, name: string): string {
  let value = "";
  for (const [key, candidate] of Object.entries(env)) if (key.toUpperCase() === name) value = candidate;
  return value;
}

function deleteEnv(env: Record<string, string>, name: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
}

function trustedPathDirectories(pathValue: string, workspace: string, checks: McpLaunchChecks): string[] {
  const paths = checks.platform === "win32" ? win32 : posix;
  const separator = checks.platform === "win32" ? ";" : ":";
  const out: string[] = [], seen = new Set<string>();
  for (const entry of pathValue.split(separator)) {
    const raw = entry.trim().replace(/^"(.*)"$/, "$1");
    // Empty and relative PATH entries ask the OS to search cwd. Never let a stdio MCP launch inherit
    // that ambient authority from the project it is inspecting.
    if (!raw || !paths.isAbsolute(raw) || (checks.platform === "win32" && raw.startsWith("\\\\"))) continue;
    const canonical = canonicalPath(raw, "directory", checks);
    if (!canonical || withinPath(workspace, canonical, checks.platform)) continue;
    const key = checks.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) { seen.add(key); out.push(canonical); }
  }
  return out;
}

function commandCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [command];
  if (/\.[^\\/.]+$/.test(command)) return [command];
  // Fixed executable/script extensions avoid a project-controlled PATHEXT adding an interpreter.
  return [command + ".com", command + ".exe", command + ".cmd", command + ".bat"];
}

function resolveMcpCommand(
  command: string,
  trustedPath: string[],
  workspace: string,
  checks: McpLaunchChecks,
): string {
  const paths = checks.platform === "win32" ? win32 : posix;
  const raw = command.trim();
  if (!raw || raw.includes("\0") || /[\r\n]/.test(raw)) throw new Error("MCP stdio server needs a command");
  if (paths.isAbsolute(raw)) {
    const canonical = canonicalPath(raw, "file", checks);
    if (!canonical) throw new Error("MCP stdio command must be an absolute canonical regular file");
    if (!checks.isExecutable(canonical)) {
      throw new Error("MCP stdio command is not executable");
    }
    // An absolute config value is explicit user execution authority and may intentionally point at
    // a workspace build. It still cannot bypass canonical regular-file validation.
    return canonical;
  }
  if (paths.basename(raw) !== raw || raw.includes("/") || raw.includes("\\")) {
    throw new Error("MCP stdio command must be a bare name or an absolute path");
  }
  for (const directory of trustedPath) {
    for (const name of commandCandidates(raw, checks.platform)) {
      const canonical = canonicalPath(paths.join(directory, name), "file", checks);
      if (!canonical || withinPath(workspace, canonical, checks.platform)) continue;
      if (!checks.isExecutable(canonical)) continue;
      return canonical;
    }
  }
  throw new Error(`MCP stdio command '${raw.slice(0, 100)}' was not found as a trusted executable outside the workspace`);
}

function trustedMcpCwd(configured: string | undefined, workspace: string, checks: McpLaunchChecks): string {
  const paths = checks.platform === "win32" ? win32 : posix;
  if (configured !== undefined) {
    if (!isText(configured) || !configured || !paths.isAbsolute(configured) || configured.includes("\0")) {
      throw new Error("MCP stdio cwd must be an absolute existing directory");
    }
    const explicit = canonicalPath(configured, "directory", checks);
    if (!explicit) throw new Error("MCP stdio cwd must be an absolute existing directory");
    return explicit;
  }

  // Default away from the checkout so package runners cannot discover project package.json files,
  // dotenv files, or cwd-local command shims. If HOME itself was redirected into the workspace,
  // fall back to the already-running Neko/Bun executable's canonical directory.
  const runtime = paths.resolve(checks.home, ".neko-core", "mcp-runtime");
  if (!withinPath(workspace, runtime, checks.platform)) {
    try { checks.ensureDirectory(runtime); } catch { /* try the executable directory below */ }
    const canonical = canonicalPath(runtime, "directory", checks);
    if (canonical && !withinPath(workspace, canonical, checks.platform)) return canonical;
  }
  const executable = canonicalPath(checks.processExecPath, "file", checks);
  const fallback = executable ? canonicalPath(paths.dirname(executable), "directory", checks) : null;
  if (fallback && !withinPath(workspace, fallback, checks.platform)) return fallback;
  throw new Error("MCP stdio server has no trusted cwd outside the workspace; configure an absolute cwd explicitly");
}

const MCP_WINDOWS_COMMAND_ENV = "NEKO_MCP_WRAPPER_COMMAND";
const MCP_WINDOWS_ARGS_ENV = "NEKO_MCP_WRAPPER_ARGS_JSON";
const MCP_WINDOWS_WRAPPER = [
  `$p = $env:${MCP_WINDOWS_COMMAND_ENV}`,
  `$a = @(ConvertFrom-Json -InputObject $env:${MCP_WINDOWS_ARGS_ENV})`,
  `Remove-Item Env:${MCP_WINDOWS_COMMAND_ENV} -ErrorAction SilentlyContinue`,
  `Remove-Item Env:${MCP_WINDOWS_ARGS_ENV} -ErrorAction SilentlyContinue`,
  "& $p @a",
  "if ($null -eq $LASTEXITCODE) { exit 0 }",
  "exit $LASTEXITCODE",
].join("; ");

function explicitMcpEnv(value: unknown, platform: NodeJS.Platform): Record<string, string> {
  if (value === undefined) return {};
  if (!isJsonObject(value)) throw new Error("MCP stdio env must be an object of string values");
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error("MCP stdio env has too many entries");
  const out: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, item] of entries) {
    if (!key || key.length > 256 || /[\0=]/.test(key) || !isText(item) || item.includes("\0") || Buffer.byteLength(item, "utf8") > 16 * 1024) {
      throw new Error("MCP stdio env contains an invalid key or value");
    }
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    totalBytes += Buffer.byteLength(normalizedKey, "utf8") + Buffer.byteLength(item, "utf8") + 2;
    if (totalBytes > 24 * 1024) throw new Error("MCP stdio env exceeds the aggregate safety limit");
    out[normalizedKey] = item;
  }
  return out;
}

function explicitMcpArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error("MCP stdio args must be an array of at most 256 strings");
  if (value.some((arg) => !isText(arg) || arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 64 * 1024)) {
    throw new Error("MCP stdio args must contain only bounded strings without NUL bytes");
  }
  return [...value];
}

function resolveMcpStdioLaunch(
  cfg: McpServerConfig,
  childSecretEnvNames: Iterable<string>,
  checks: McpLaunchChecks,
): McpLaunch {
  const paths = checks.platform === "win32" ? win32 : posix;
  const workspace = canonicalPath(checks.workspace, "directory", checks);
  if (!workspace) throw new Error("MCP stdio launch cannot verify the workspace directory");

  const ambient = scrubChildEnv(checks.env, childSecretEnvNames);
  for (const name of AMBIENT_EXECUTION_ENV) deleteEnv(ambient, name);
  const explicitEnv = explicitMcpEnv(cfg.env, checks.platform);
  const resolutionEnv = { ...ambient, ...explicitEnv };
  const trustedPath = trustedPathDirectories(envValue(resolutionEnv, "PATH"), workspace, checks);
  // MCP receives the SDK's small OS bootstrap plus only env explicitly granted in global config.
  // Arbitrary ambient AWS/GitHub/cloud/npm/SSH credentials never enter the transport environment.
  const env = { ...explicitEnv };
  deleteEnv(env, "PATH");
  env.PATH = trustedPath.join(checks.platform === "win32" ? ";" : ":");
  if (!isText(cfg.command)) throw new Error("MCP stdio server needs a command");
  const resolved = resolveMcpCommand(cfg.command, trustedPath, workspace, checks);
  const cwd = trustedMcpCwd(cfg.cwd, workspace, checks);
  let command = resolved;
  let args = explicitMcpArgs(cfg.args);

  if (checks.platform === "win32") {
    if (!/\.(?:com|exe|cmd|bat)$/i.test(command)) {
      throw new Error("MCP stdio command must be a Windows executable or cmd/bat script; configure an absolute interpreter for other files");
    }
    deleteEnv(env, "PATHEXT");
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    const systemCmdRaw = checks.windowsSystemExecutable("cmd.exe");
    const systemCmd = systemCmdRaw ? canonicalPath(systemCmdRaw, "file", checks) : null;
    deleteEnv(env, "COMSPEC");
    if (systemCmd) env.COMSPEC = systemCmd;
    if (/\.(?:cmd|bat)$/i.test(command)) {
      if (!systemCmd || withinPath(workspace, systemCmd, checks.platform)) {
        throw new Error("MCP stdio command script needs a trusted absolute System32 cmd.exe");
      }
      const powershellRaw = checks.windowsSystemExecutable(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"));
      const powershell = powershellRaw ? canonicalPath(powershellRaw, "file", checks) : null;
      if (!powershell || withinPath(workspace, powershell, checks.platform)) {
        throw new Error("MCP stdio command script needs trusted absolute Windows PowerShell");
      }
      const argsJson = JSON.stringify(args);
      if (Buffer.byteLength(command, "utf8") + Buffer.byteLength(argsJson, "utf8") > 8 * 1024) {
        throw new Error("MCP stdio command script arguments exceed the Windows wrapper safety limit");
      }
      // StdioClientTransport/cross-spawn re-escapes an embedded cmd `/c` string and breaks paths
      // containing spaces. Launch the canonical inbox PowerShell executable instead; its command is
      // fixed, while bounded command/argv JSON is read from env and removed before the MCP child starts.
      // No configured value is interpolated into PowerShell source or reparsed as shell syntax.
      env[MCP_WINDOWS_COMMAND_ENV] = command;
      env[MCP_WINDOWS_ARGS_ENV] = argsJson;
      command = powershell;
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", MCP_WINDOWS_WRAPPER];
    }
  }
  return { command, args, cwd, env };
}

/** Test seam for PATH/cwd hijack regressions. Production always uses native filesystem checks. */
export function __resolveMcpStdioLaunchForTest(
  cfg: McpServerConfig,
  options: Omit<McpLaunchChecks, "isExecutable" | "ensureDirectory" | "windowsSystemExecutable"> & {
    isExecutable?: (path: string) => boolean;
    ensureDirectory?: (path: string) => void;
    windowsSystemExecutable?: (name: string) => string | null;
    childSecretEnvNames?: Iterable<string>;
  },
): McpLaunch {
  return resolveMcpStdioLaunch(cfg, options.childSecretEnvNames ?? [], {
    ...options,
    isExecutable: options.isExecutable ?? (() => true),
    ensureDirectory: options.ensureDirectory ?? (() => {}),
    windowsSystemExecutable: options.windowsSystemExecutable ?? (() => null),
  });
}

function makeTransport(cfg: McpServerConfig, childSecretEnvNames: Iterable<string>): { transport: any; type: string } {
  if (cfg.url) {
    const url = new URL(cfg.url);
    const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return cfg.type === "sse"
      ? { transport: new SSEClientTransport(url, init), type: "sse" }
      : { transport: new StreamableHTTPClientTransport(url, init), type: "http" };
  }
  const launch = resolveMcpStdioLaunch(cfg, childSecretEnvNames, nativeLaunchChecks());
  return {
    transport: new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      // Ambient provider keys and loader injection settings are not implicit MCP capabilities.
      // An explicit per-server cfg.env entry remains a deliberate global user grant.
      env: launch.env,
      stderr: "ignore", // keep MCP servers' banners/logs (e.g. RiveMCP trial notice) off the TUI
    }),
    type: "stdio",
  };
}

/** A hung MCP server (stdio command that never speaks, unresponsive URL) must not block Neko's startup
 *  forever. Bound each connect; on timeout the server is skipped with an error instead of hanging the loop. */
const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 60_000;
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function resolveWindowsTaskkill(systemRoot: string | undefined, isFile: (path: string) => boolean): string | null {
  return resolveWindowsSystemExecutable("taskkill.exe", systemRoot, isFile);
}

/** Test seam for the Windows no-PATH process-tree cleanup invariant. */
export function __resolveWindowsTaskkillForTest(
  systemRoot: string | undefined,
  isFile: (path: string) => boolean = () => true,
): string | null {
  return resolveWindowsTaskkill(systemRoot, isFile);
}

const WINDOWS_TASKKILL = process.platform === "win32" ? resolveWindowsSystemExecutable("taskkill.exe") : null;

/** Spec cache: tool schemas/resources/prompts per server-config, so a hub can register a server's
 * tools WITHOUT spawning it (lazy-CONNECT — measured 2026-07-03: the browser MCP costs ~277MB RAM +
 * spawn latency on EVERY run even when no browser tool is ever called). Keyed by name+config hash, so
 * any config change is a clean miss; entries refresh on every real connect. */
const SPEC_CACHE_FILE = () => join(homeDir(), ".neko-core", "mcp-specs.json");
type SpecCacheEntry = { specs: any[]; resourceSpecs: any[]; prompts: string[]; meta: { type: string; tools: number; resources: number; prompts: number } };
function specCacheKey(name: string, cfg: McpServerConfig): string {
  return `${name}:${createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 16)}`;
}
function readSpecCache(): Record<string, SpecCacheEntry> {
  try {
    const data = JSON.parse(readFileSync(SPEC_CACHE_FILE(), "utf-8"));
    return data.v === 1 ? (data.servers ?? {}) : {};
  } catch { return {}; }
}
function writeSpecCacheEntry(key: string, entry: SpecCacheEntry): void {
  try {
    const servers = readSpecCache();
    servers[key] = entry;
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true });
    atomicWriteFileSync(SPEC_CACHE_FILE(), JSON.stringify({ v: 1, servers }));
  } catch { /* a cache write failure must never break MCP */ }
}

/** The synthetic meta-tool exposed in lazy mode so the model can pull tool schemas on demand. */
const MCP_LOAD_SPEC = {
  type: "function",
  function: {
    name: "mcp_load",
    description: "Load MCP tools by name so you can call them. The available MCP tools (names + one-line descriptions) are listed in your context under 'MCP tools'. Pass the exact names you need; their schemas are returned and the tools become callable.",
    parameters: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "MCP tool names to load, e.g. mcp__server__tool." } },
      required: ["names"],
    },
  },
};

export class McpHub {
  /** Lazy mode: don't put every MCP tool schema in context — list names only, load on demand. */
  lazy = false;
  private loaded = new Set<string>();
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, { server: string; tool: string }>();
  private specs: any[] = [];
  private meta = new Map<string, { type: string; tools: number; resources: number; prompts: number }>();
  private resourceTools = new Map<string, string>(); // synthetic mcp__<server>__read_resource -> server
  private prompts = new Map<string, string[]>(); // server -> prompt names
  private configs = new Map<string, McpServerConfig>(); // kept so a dead server can be reconnected
  private transports = new Map<string, any>(); // stdio transports kept for pid -> tree-kill on close
  private pendingClients = new Map<string, Promise<Client>>(); // one lazy connect per server
  private closing = false;
  constructor(
    private filter: { allow?: string[]; deny?: string[] } = {},
    private childSecretEnvNames: readonly string[] = [],
  ) {}

  /** Tool passes the allow/deny filters (patterns match server / tool / "server__tool" / "*"). */
  private allowed(server: string, tool: string): boolean {
    const m = (p: string) => p === "*" || p === server || p === tool || p === `${server}__${tool}` || p === `mcp__${server}__${tool}`;
    const allow = this.filter.allow ?? [];
    const deny = this.filter.deny ?? [];
    if (allow.length && !allow.some(m)) return false;
    return !deny.some(m);
  }

  /** Create + connect one client (oauth or transport). Shared by connectAll and reconnect. */
  private async makeClient(name: string, cfg: McpServerConfig): Promise<{ client: Client; type: string }> {
    const client = new Client({ name: "neko-code", version: VERSION }, { capabilities: {} });
    if (cfg.oauth && cfg.url) {
      await connectWithOAuth(client, name, cfg.url);
      return { client, type: "http+oauth" };
    }
    const made = makeTransport(cfg, this.childSecretEnvNames);
    // Track before connect so a timeout can close/kill a transport that never finishes initialize.
    this.transports.set(name, made.transport);
    try {
      await withTimeout(
        client.connect(made.transport, { timeout: MCP_CONNECT_TIMEOUT_MS, maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS }),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP '${name}' connect`,
      );
      return { client, type: made.type };
    } catch (error) {
      await this.discardConnection(name, client, made.transport);
      throw error;
    }
  }

  /** Register a server's tool surface WITHOUT spawning it (specs from the cache). The first actual
   * tool call / resource read / prompt get connects on demand via ensureClient(). */
  private registerFromCache(name: string, entry: SpecCacheEntry): void {
    for (const spec of entry.specs) {
      const prefixed = String(spec.function?.name ?? "");
      const bare = prefixed.replace(`mcp__${name}__`, "");
      if (!this.allowed(name, bare)) continue;
      this.toolMap.set(prefixed, { server: name, tool: bare });
      this.specs.push(spec);
    }
    for (const spec of entry.resourceSpecs) {
      this.resourceTools.set(String(spec.function?.name ?? ""), name);
      this.specs.push(spec);
    }
    if (entry.prompts.length) this.prompts.set(name, entry.prompts);
    this.meta.set(name, { ...entry.meta, type: `${entry.meta.type} (cached, connects on first use)` });
  }

  /** Connect ONE server and (re)build its registered surface from the LIVE server; refresh the cache. */
  private async connectOne(name: string): Promise<Client> {
    if (this.closing) throw new Error("MCP hub is closing");
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`no MCP server '${name}' configured`);
    // OAuth is user-paced (browser authorize) so only the non-OAuth makeClient path is bounded.
    const { client, type } = await this.makeClient(name, cfg);
    try {
      const requestDeadline = { timeout: MCP_CONNECT_TIMEOUT_MS, maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS };
      const res: any = await client.listTools(undefined, requestDeadline);
      const cachedSpecs: any[] = [];
      const liveSpecs: any[] = [];
      const liveTools = new Map<string, { server: string; tool: string }>();
      const liveResources = new Map<string, string>();
      let tools = 0;
      for (const tool of res.tools ?? []) {
        const prefixed = `mcp__${name}__${tool.name}`;
        const spec = {
          type: "function",
          function: {
            name: prefixed,
            description: tool.description ?? "",
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        };
        cachedSpecs.push(spec); // cache the FULL surface; allow/deny filters apply per-hub below
        if (!this.allowed(name, tool.name)) continue; // mcp_allow/mcp_deny filter
        liveTools.set(prefixed, { server: name, tool: tool.name });
        liveSpecs.push(spec);
        tools++;
      }
      // Resources are part of full MCP: expose a synthetic read_resource tool the agent can use.
      let resourceList: any[] = [];
      // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
      try {
        // SAFETY: MCP SDK result shape; missing resources degrade to an empty list.
        resourceList = ((await client.listResources(undefined, requestDeadline)) as any).resources ?? [];
      } catch { /* unsupported */ }
      const resourceSpecs: any[] = [];
      if (resourceList.length) {
        const rt = `mcp__${name}__read_resource`;
        const spec = {
          type: "function",
          function: {
            name: rt,
            description: `Read a resource from MCP server '${name}'. Available URIs: ${resourceList.slice(0, 25).map((r: any) => r.uri).join(", ")}`,
            parameters: { type: "object", properties: { uri: { type: "string", description: "The resource URI to read." } }, required: ["uri"] },
          },
        };
        resourceSpecs.push(spec);
        liveResources.set(rt, name);
        liveSpecs.push(spec);
      }
      let promptNames: string[] = [];
      // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
      try {
        // SAFETY: MCP SDK result shape; missing prompts degrade to an empty list.
        promptNames = (((await client.listPrompts(undefined, requestDeadline)) as any).prompts ?? []).map((p: any) => p.name);
      } catch { /* unsupported */ }
      const meta = { type, tools, resources: resourceList.length, prompts: promptNames.length };
      if (this.closing) throw new Error("MCP hub is closing");

      // Commit the live surface only after connect + mandatory listTools succeeded. Until this
      // synchronous swap, cached mappings stay callable so a failed reconnect can be retried later.
      this.specs = this.specs.filter((s) => !String(s.function?.name ?? "").startsWith(`mcp__${name}__`));
      for (const key of [...this.toolMap.keys()]) if (this.toolMap.get(key)!.server === name) this.toolMap.delete(key);
      for (const key of [...this.resourceTools.keys()]) if (this.resourceTools.get(key) === name) this.resourceTools.delete(key);
      this.specs.push(...liveSpecs);
      for (const [key, value] of liveTools) this.toolMap.set(key, value);
      for (const [key, value] of liveResources) this.resourceTools.set(key, value);
      if (promptNames.length) this.prompts.set(name, promptNames);
      else this.prompts.delete(name);
      this.meta.set(name, meta);
      this.clients.set(name, client);
      writeSpecCacheEntry(specCacheKey(name, cfg), { specs: cachedSpecs, resourceSpecs, prompts: promptNames, meta });
      return client;
    } catch (error) {
      await this.discardConnection(name, client, this.transports.get(name));
      throw error;
    }
  }

  /** The connected client for a server, connecting ON DEMAND if it was registered from the cache. */
  private async ensureClient(name: string): Promise<Client> {
    if (this.closing) throw new Error("MCP hub is closing");
    const ready = this.clients.get(name);
    if (ready) return ready;
    const existing = this.pendingClients.get(name);
    if (existing) return existing;

    const pending = this.connectOne(name);
    this.pendingClients.set(name, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingClients.get(name) === pending) this.pendingClients.delete(name);
    }
  }

  private async discardConnection(name: string, client?: Client, transport?: any): Promise<void> {
    if (client && this.clients.get(name) === client) this.clients.delete(name);
    if (transport && this.transports.get(name) === transport) this.transports.delete(name);
    // Capture/kill the stdio tree before SDK close clears its pid. Remote transports have no pid
    // and are aborted by client.close().
    const pid = transport?.pid;
    if (pid) {
      try {
        if (process.platform === "win32") {
          if (WINDOWS_TASKKILL) spawnSync(WINDOWS_TASKKILL, ["/PID", String(pid), "/T", "/F"], { timeout: 5000 });
        }
        else process.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    try {
      if (client) await client.close();
      else await transport?.close?.();
    } catch { /* best-effort teardown */ }
  }

  /** Forget a client after an outcome-unknown transport/protocol failure. This never replays the
   * failed operation; it only lets a later, explicit call establish a fresh connection. */
  private async discardClient(name: string): Promise<void> {
    await this.discardConnection(name, this.clients.get(name), this.transports.get(name));
  }

  /** Connect every still-pending (cache-registered) server — for diagnostics (`neko mcp`, doctor)
   * that must report the REAL live surface, not the cached one. */
  async connectPending(): Promise<void> {
    for (const name of this.configs.keys()) {
      if (this.clients.has(name)) continue;
      try { await this.ensureClient(name); } catch (error) {
        // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
        console.error(`neko: MCP server '${name}' failed to connect: ${(error as Error).message}`);
      }
    }
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const cache = readSpecCache();
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      try {
        this.configs.set(name, cfg);
        const hit = cache[specCacheKey(name, cfg)];
        // Cache hit -> register the tool surface WITHOUT spawning the server (lazy-CONNECT: no
        // process, no RAM, no startup latency until a tool is actually called). Miss (first run
        // with this config) -> connect eagerly, which also writes the cache for next time.
        if (hit) this.registerFromCache(name, hit);
        else await this.connectOne(name);
      } catch (error) {
        // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
        console.error(`neko: MCP server '${name}' failed to connect: ${(error as Error).message}`);
      }
    }
  }

  get serverNames(): string[] {
    return [...this.clients.keys()];
  }

  serverInfo(name: string): { type: string; tools: number; resources: number; prompts: number } | undefined {
    return this.meta.get(name);
  }

  toolSchemas(): any[] {
    if (!this.lazy) return this.specs;
    // Lazy: expose only the loader meta-tool + whatever's been loaded this session.
    return [MCP_LOAD_SPEC, ...this.specs.filter((s) => this.loaded.has(s.function.name))];
  }

  /** Lazy-mode context block: list all MCP tool names + one-line descriptions (cheap), so the model
   * knows what it can `mcp_load`. "" when not lazy (full schemas are already in the tool list). */
  indexBlock(): string {
    if (!this.lazy || !this.specs.length) return "";
    const lines = this.specs.map((s) => `  ${s.function.name} - ${String(s.function.description ?? "").split("\n")[0].slice(0, 100)}`);
    return `MCP tools (lazy: call mcp_load with the names you need, then call them):\n${lines.join("\n")}`;
  }

  /** Load tool schemas on demand (lazy mode). Returns their schemas so the model learns the args. */
  loadTools(names: string[]): string {
    const loaded: any[] = [];
    for (const n of names) {
      const spec = this.specs.find((s) => s.function.name === n);
      if (spec) { this.loaded.add(n); loaded.push(spec); }
    }
    if (!loaded.length) return `No matching MCP tools for: ${names.join(", ") || "(none)"}. Check the names in the 'MCP tools' list in your context.`;
    return `Loaded ${loaded.length} MCP tool(s) - now callable:\n` +
      loaded.map((s) => `${s.function.name}: ${JSON.stringify(s.function.parameters)}`).join("\n");
  }

  toolNames(): string[] {
    return [...this.toolMap.keys(), ...this.resourceTools.keys()];
  }

  has(name: string): boolean {
    return this.toolMap.has(name) || this.resourceTools.has(name);
  }

  async call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    // Synthetic resource reader (mcp__<server>__read_resource).
    const resourceServer = this.resourceTools.get(name);
    if (resourceServer) {
      try {
        const client = await this.ensureClient(resourceServer);
        const res: any = await client.readResource(
          { uri: String(args.uri ?? "") },
          { signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS },
        );
        const parts = (res.contents ?? []).map((c: any) => (c?.text != null ? c.text : c?.uri ?? JSON.stringify(c)));
        return parts.join("\n") || "(empty resource)";
      } catch (error) {
        await this.discardClient(resourceServer);
        // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
        return `Error reading resource: ${(error as Error).message}`;
      }
    }
    const ref = this.toolMap.get(name);
    if (!ref) return `Error: unknown MCP tool ${name}`;
    try {
      return await this.invoke(ref.server, ref.tool, args, signal);
    } catch (error) {
      // A transport failure can happen after the remote tool performed its side effect but
      // before its response arrived. Never replay automatically: the next attempt must be an
      // explicit, evidence-backed decision by the agent or user.
      await this.discardClient(ref.server);
      // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
      return `Error: MCP call outcome unknown; not retried: ${(error as Error).message}`;
    }
  }

  private async invoke(server: string, tool: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const client = await this.ensureClient(server); // connects on demand when registered from cache
    const res: any = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      { signal, timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS },
    );
    const parts = (res.content ?? []).map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)));
    const text = parts.join("\n") || "(no content)";
    if (!res.isError || /^Error(?:\s|:|$)/i.test(text.trimStart())) return text;
    return `Error: ${text}`;
  }

  promptList(): { server: string; name: string }[] {
    const out: { server: string; name: string }[] = [];
    for (const [server, names] of this.prompts) for (const name of names) out.push({ server, name });
    return out;
  }

  async getPrompt(server: string, name: string, args: Record<string, any>): Promise<string> {
    if (!this.configs.has(server)) return `Error: no MCP server '${server}'`;
    try {
      const client = await this.ensureClient(server);
      const res: any = await client.getPrompt(
        { name, arguments: args },
        { timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS },
      );
      return (res.messages ?? [])
        .map((m: any) => (isText(m.content) ? m.content : m.content?.text ?? JSON.stringify(m.content)))
        .join("\n\n");
    } catch (error) {
      await this.discardClient(server);
      // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
      return `Error getting prompt: ${(error as Error).message}`;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    // Kill a stdio launcher tree before SDK close clears its pid; remote/pending transports are
    // closed through the same path. The executable is absolute on Windows, never cwd/PATH-resolved.
    const names = new Set([...this.clients.keys(), ...this.transports.keys()]);
    for (const name of names) await this.discardClient(name);
    this.pendingClients.clear();
  }
}

/** Above this many connected MCP tools, default to lazy loading so the context isn't flooded. */
const LAZY_TOOL_THRESHOLD = 30;

export async function buildMcpHub(
  servers: Record<string, McpServerConfig>,
  filter: { allow?: string[]; deny?: string[] } = {},
  lazy?: boolean,
  childSecretEnvNames: Iterable<string> = [],
): Promise<McpHub> {
  const hub = new McpHub(filter, [...childSecretEnvNames]);
  await hub.connectAll(servers);
  // Lazy when explicitly enabled in config, else auto when many tools would otherwise bloat context.
  hub.lazy = lazy ?? hub.toolNames().length > LAZY_TOOL_THRESHOLD;
  return hub;
}

export function renderMcp(hub: McpHub): string {
  if (!hub.serverNames.length) {
    return "No MCP servers connected.";
  }
  const lines = [`Neko Core MCP — ${hub.serverNames.length} server(s):`];
  for (const name of hub.serverNames) {
    const m = hub.serverInfo(name);
    lines.push(`  ${name} [${m?.type ?? "?"}] — ${m?.tools ?? 0} tools, ${m?.resources ?? 0} resources, ${m?.prompts ?? 0} prompts`);
  }
  lines.push("Tools:");
  for (const name of hub.toolNames()) lines.push(`  ${name}`);
  const prompts = hub.promptList();
  if (prompts.length) {
    lines.push("Prompts:");
    for (const p of prompts) lines.push(`  ${p.server}:${p.name}`);
  }
  return lines.join("\n");
}
