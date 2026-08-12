/**
 * Thin, local JSON-RPC transport for Codex App Server.
 *
 * This module deliberately knows nothing about Neko's Agent or tools. It only owns process
 * discovery/lifecycle and the newline-delimited request/response protocol. Keeping that boundary
 * small lets the GPT-5.6 bridge reuse an installed Codex CLI today and a Neko-managed, standalone
 * app-server support pack later without changing the core agent loop.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, posix, win32 } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { homeDir } from "../shared/home.ts";
import { scrubChildEnv } from "../shared/child-env.ts";
import { VERSION } from "../shared/version.ts";

export const CODEX_APP_SERVER_MIN_VERSION = "0.144.0";
const RPC_TIMEOUT_MS = 20_000;
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;

export type CodexSource = "managed" | "environment" | "path";

export interface CodexExecutable {
  path: string;
  kind: "cli" | "app-server";
  source: CodexSource;
  version?: string;
}

export interface CodexSupportStatus {
  state: "ready" | "missing" | "outdated" | "invalid";
  executable?: CodexExecutable;
  detail: string;
}

export interface CodexDynamicTools {
  tools: any[];
  /** Wire name -> Neko's original tool name. */
  originalNames: Map<string, string>;
}

/**
 * Convert Neko tool schemas to App Server dynamic tools.
 *
 * App Server owns the `mcp__` namespace and rejects dynamic tools using it. Neko already uses
 * that prefix for MCP tools, so send a stable opaque alias and reverse it before execution.
 */
export function encodeCodexDynamicTools(toolSchemas: any[]): CodexDynamicTools {
  const source = toolSchemas.map((schema) => ({
    name: String(schema?.function?.name ?? ""),
    description: String(schema?.function?.description ?? ""),
    inputSchema: schema?.function?.parameters ?? { type: "object", properties: {} },
  })).filter((tool) => tool.name);
  const originalNames = new Map<string, string>();
  const originalNameSet = new Set(source.map((tool) => tool.name));
  const used = new Set<string>();
  const tools = source.map((tool) => {
    let name = tool.name;
    if (/^mcp__/i.test(name)) {
      const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
      name = `neko_mcp_${digest}`;
      let suffix = 1;
      while (used.has(name) || originalNameSet.has(name)) name = `neko_mcp_${digest}_${suffix++}`;
    }
    used.add(name);
    originalNames.set(name, tool.name);
    return { type: "function", name, description: tool.description, inputSchema: tool.inputSchema };
  });
  return { tools, originalNames };
}

interface ManagedManifest {
  protocolVersion?: string;
  executable?: string;
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  pathExists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  isRegularFile?: (path: string) => boolean;
  readText?: (path: string) => string;
  runVersion?: (executable: CodexExecutable) => string | null;
}

interface ExecutableChecks {
  platform: NodeJS.Platform;
  cwd: string;
  realpath: (path: string) => string;
  isRegularFile: (path: string) => boolean;
  readPrefix?: (path: string) => string;
}

interface LaunchCommand {
  command: string;
  args: string[];
}

function realPath(path: string): string {
  return realpathSync.native(path);
}

/** Canonicalize the nearest existing ancestor, then reattach the missing tail. This catches a
 * not-yet-created transport directory whose parent is a symlink/junction into the workspace. */
function canonicalNearestPath(path: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? win32 : posix;
  let probe = paths.resolve(path);
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = paths.dirname(probe);
    if (parent === probe) throw new Error(`no existing ancestor for ${path}`);
    tail.unshift(paths.basename(probe));
    probe = parent;
  }
  return paths.join(realPath(probe), ...tail);
}

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function readPrefix(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(256);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytes);
  } finally { closeSync(fd); }
}

function withinPath(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const relative = paths.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

function transportHomeInsideWorkspace(candidate: string, cwd: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  if (withinPath(paths.resolve(cwd), paths.resolve(candidate), platform)) return true;
  if (platform !== process.platform) return false;
  try {
    return withinPath(canonicalNearestPath(cwd, platform), canonicalNearestPath(candidate, platform), platform);
  } catch {
    return true; // an isolation boundary that cannot be proved stays outside fails closed
  }
}

function canonicalExecutable(path: string, allowWorkspace: boolean, checks: ExecutableChecks): string | null {
  const paths = checks.platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(path) || path.includes("\0")) return null;
  let canonical: string;
  let workspace: string;
  try {
    canonical = checks.realpath(path);
    workspace = checks.realpath(checks.cwd);
  } catch {
    return null;
  }
  if (!paths.isAbsolute(canonical) || !checks.isRegularFile(canonical)) return null;
  if (!allowWorkspace && withinPath(workspace, canonical, checks.platform)) return null;
  return canonical;
}

function safeChildPath(value: string | undefined, checks: ExecutableChecks): string {
  const paths = checks.platform === "win32" ? win32 : posix;
  const delimiter = checks.platform === "win32" ? ";" : ":";
  let workspace: string;
  try { workspace = checks.realpath(checks.cwd); }
  catch { return ""; }
  const seen = new Set<string>();
  const safe: string[] = [];
  for (const directory of String(value ?? "").split(delimiter).filter(Boolean)) {
    const unquoted = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!unquoted || !paths.isAbsolute(unquoted)) continue;
    let canonical: string;
    try { canonical = checks.realpath(unquoted); }
    catch { continue; }
    if (!paths.isAbsolute(canonical) || withinPath(workspace, canonical, checks.platform)) continue;
    const key = checks.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) { seen.add(key); safe.push(canonical); }
  }
  return safe.join(delimiter);
}

/** Numeric semver comparison for the stable x.y.z part. Prerelease labels do not grant a newer API. */
export function compareCodexVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(/[+-]/, 1)[0].split(".").map((part) => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  const leftPre = left.includes("-");
  const rightPre = right.includes("-");
  if (leftPre !== rightPre) return leftPre ? -1 : 1;
  return 0;
}

function managedExecutable(
  home: string,
  platform: NodeJS.Platform,
  pathExists: (path: string) => boolean,
  readText: (path: string) => string,
): CodexExecutable | null {
  const paths = platform === "win32" ? win32 : posix;
  const root = paths.join(home, ".neko-core", "codex-support");
  const manifestPath = paths.join(root, "support-pack.json");
  if (!pathExists(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readText(manifestPath)) as ManagedManifest;
    const file = manifest.executable || (platform === "win32" ? "codex-app-server.exe" : "codex-app-server");
    if (paths.isAbsolute(file) || paths.basename(file) !== file) return null;
    const path = paths.join(root, file);
    if (!pathExists(path)) return null;
    return { path, kind: "app-server", source: "managed", version: manifest.protocolVersion };
  } catch {
    return null;
  }
}

function systemCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Array<{ path: string; source: "environment" | "path" }> {
  const explicit = String(env.NEKO_CODEX_PATH ?? "").trim();
  const paths = platform === "win32" ? win32 : posix;
  const out: Array<{ path: string; source: "environment" | "path" }> = [];
  // NEKO_CODEX_PATH is an explicit user grant. It may point into the workspace, but it must still
  // name an absolute regular file. Ordinary PATH discovery never receives that exception.
  if (explicit && paths.isAbsolute(explicit)) out.push({ path: explicit, source: "environment" });
  const names = platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1"]
    : ["codex"];
  const pathDelimiter = platform === "win32" ? ";" : ":";
  for (const directory of String(env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    const unquoted = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!unquoted || !paths.isAbsolute(unquoted)) continue;
    const root = unquoted;
    for (const name of names) out.push({ path: paths.join(root, name), source: "path" });
  }
  const seen = new Set<string>();
  return out.filter((candidate) => {
    const key = platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function executableKind(path: string): CodexExecutable["kind"] {
  return /codex-app-server(?:\.exe)?$/i.test(path) ? "app-server" : "cli";
}

function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

function trustedNode(env: NodeJS.ProcessEnv, cwd: string, checks?: ExecutableChecks): string | null {
  const activeChecks: ExecutableChecks = checks ?? {
    platform: process.platform,
    cwd,
    realpath: realPath,
    isRegularFile,
  };
  const paths = activeChecks.platform === "win32" ? win32 : posix;
  const delimiter = activeChecks.platform === "win32" ? ";" : ":";
  const name = activeChecks.platform === "win32" ? "node.exe" : "node";
  for (const directory of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const unquoted = directory.trim().replace(/^"(.*)"$/, "$1");
    if (!unquoted || !paths.isAbsolute(unquoted)) continue;
    const root = unquoted;
    const nodePath = paths.join(root, name);
    const canonical = canonicalExecutable(nodePath, false, activeChecks);
    if (canonical) return canonical;
  }
  return null;
}

function commandFor(
  executable: CodexExecutable,
  args: string[],
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  checks?: ExecutableChecks,
): LaunchCommand | null {
  const extension = extname(executable.path).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat" || extension === ".ps1")) {
    const activeChecks: ExecutableChecks = checks ?? {
      platform,
      cwd,
      realpath: realPath,
      isRegularFile,
    };
    const rawEntry = win32.join(win32.dirname(executable.path), "node_modules", "@openai", "codex", "bin", "codex.js");
    const npmEntry = canonicalExecutable(rawEntry, executable.source === "environment", activeChecks);
    const node = trustedNode(env, cwd, activeChecks);
    if (npmEntry && node) return { command: node, args: [npmEntry, ...args] };
    return null;
  }
  if (platform !== "win32" && (extension === ".js" || extension === ".mjs" || extension === ".cjs")) {
    const activeChecks: ExecutableChecks = checks ?? { platform, cwd, realpath: realPath, isRegularFile };
    const node = trustedNode(env, cwd, activeChecks);
    return node ? { command: node, args: [executable.path, ...args] } : null;
  }
  if (platform !== "win32" && !extension) {
    const activeChecks: ExecutableChecks = checks ?? { platform, cwd, realpath: realPath, isRegularFile, readPrefix };
    let prefix = "";
    try { prefix = (activeChecks.readPrefix ?? readPrefix)(executable.path); }
    catch { return null; }
    if (/^#![^\r\n]*\bnode(?:\s|$)/.test(prefix)) {
      const node = trustedNode(env, cwd, activeChecks);
      return node ? { command: node, args: [executable.path, ...args] } : null;
    }
  }
  return { command: executable.path, args };
}

export function __codexLaunchForTest(
  executable: CodexExecutable,
  args: string[],
  options: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    cwd: string;
    realpath: (path: string) => string;
    isRegularFile: (path: string) => boolean;
    readPrefix?: (path: string) => string;
  },
): { command: string; args: string[] } | null {
  return commandFor(executable, args, options.platform, options.env, options.cwd, {
    platform: options.platform,
    cwd: options.cwd,
    realpath: options.realpath,
    isRegularFile: options.isRegularFile,
    readPrefix: options.readPrefix,
  });
}

const PROVIDER_CHILD_ENV_ALLOWLIST = new Set([
  "ALL_PROXY", "CODEX_HOME", "COLORTERM", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY",
  "FORCE_COLOR", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS", "NO_COLOR", "NO_PROXY", "PATH", "PATHEXT", "REQUESTS_CA_BUNDLE", "RUST_LOG",
  "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USERPROFILE",
  "WAYLAND_DISPLAY", "WINDIR", "WSL_DISTRO_NAME", "WSL_INTEROP", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
]);

function providerChildEnv(source: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}, checks?: ExecutableChecks): NodeJS.ProcessEnv {
  const allowed = Object.fromEntries(Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && PROVIDER_CHILD_ENV_ALLOWLIST.has(entry[0].toUpperCase()),
  ));
  if (checks) {
    const pathKey = Object.keys(allowed).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const path = safeChildPath(source[pathKey] ?? source.PATH, checks);
    for (const name of Object.keys(allowed)) if (name.toUpperCase() === "PATH") delete allowed[name];
    if (path) allowed[pathKey] = path;
  }
  return { ...scrubChildEnv(allowed), ...overrides };
}

/** Test seam for proving provider credentials are not ambient sidecar capabilities. */
export function __codexChildEnvForTest(source: NodeJS.ProcessEnv, checks?: ExecutableChecks): NodeJS.ProcessEnv {
  return providerChildEnv(source, {}, checks);
}

function realVersion(
  executable: CodexExecutable,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
  checks: ExecutableChecks,
): string | null {
  if (executable.source === "managed" && executable.version) return executable.version;
  const command = commandFor(executable, ["--version"], platform, env, cwd, checks);
  if (!command) return null;
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env: providerChildEnv(env, {}, checks),
    cwd: (platform === "win32" ? win32 : posix).dirname(executable.path),
  });
  if (result.status !== 0) return null;
  return parseVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

let discoveryCache: { at: number; status: CodexSupportStatus } | null = null;

/** Discover a compatible App Server without starting it. No network and no auth access. */
export function discoverCodexSupport(options: DiscoveryOptions = {}): CodexSupportStatus {
  const cacheable = Object.keys(options).length === 0;
  if (cacheable && discoveryCache && Date.now() - discoveryCache.at < 30_000) return discoveryCache.status;
  const status = discoverCodexSupportUncached(options);
  // Cache only a working installation. A user who installs/upgrades after an actionable error must
  // be able to press Retry immediately without restarting Neko or waiting for a negative TTL.
  if (cacheable && status.state === "ready") discoveryCache = { at: Date.now(), status };
  return status;
}

export function clearCodexSupportCache(): void {
  discoveryCache = null;
}

function discoverCodexSupportUncached(options: DiscoveryOptions): CodexSupportStatus {
  const env = options.env ?? process.env;
  const home = options.home ?? homeDir();
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const pathExists = options.pathExists ?? existsSync;
  const checks: ExecutableChecks = {
    platform,
    cwd,
    realpath: options.realpath ?? realPath,
    isRegularFile: options.isRegularFile ?? isRegularFile,
  };
  const readText = options.readText ?? ((path) => readFileSync(path, "utf8"));
  const runVersion = options.runVersion ?? ((executable) => realVersion(executable, env, platform, cwd, checks));

  const managed = managedExecutable(home, platform, pathExists, readText);
  const candidates: CodexExecutable[] = [];
  if (managed) {
    const path = canonicalExecutable(managed.path, true, checks);
    if (path) candidates.push({ ...managed, path });
  }
  for (const candidate of systemCandidates(env, platform)) {
    const path = canonicalExecutable(candidate.path, candidate.source === "environment", checks);
    if (!path) continue;
    candidates.push({
      path,
      kind: executableKind(path),
      source: candidate.source,
    });
  }
  if (!candidates.length) {
    return { state: "missing", detail: "GPT-5.6 Support Pack or Codex CLI was not found" };
  }

  let oldest: CodexExecutable | undefined;
  for (const candidate of candidates) {
    const version = candidate.version ?? runVersion(candidate) ?? undefined;
    const executable = { ...candidate, version };
    if (!version) continue;
    if (compareCodexVersions(version, CODEX_APP_SERVER_MIN_VERSION) >= 0) {
      return { state: "ready", executable, detail: `${candidate.source} ${version}` };
    }
    oldest ??= executable;
  }
  if (oldest) {
    return {
      state: "outdated",
      executable: oldest,
      detail: `Codex ${oldest.version} is older than required ${CODEX_APP_SERVER_MIN_VERSION}`,
    };
  }
  return { state: "invalid", executable: candidates[0], detail: "Codex was found but its version could not be verified" };
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface RpcTransport {
  input: Writable;
  output: Readable;
  close: () => void;
  closed?: Promise<void>;
  stderrTail?: () => string;
}

export interface CodexAppServerHandlers {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reader: ReadlineInterface;
  private nextId = 1;
  private closed = false;

  constructor(private readonly transport: RpcTransport, private readonly handlers: CodexAppServerHandlers = {}) {
    this.reader = createInterface({ input: transport.output });
    this.reader.on("line", (line) => { void this.accept(line); });
    this.reader.on("close", () => this.failAll(new Error(`Codex App Server closed${this.stderr()}`)));
  }

  async initialize(timeoutMs = 60_000): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: { name: "neko_core", title: "Neko Core", version: VERSION },
      capabilities: { experimentalApi: true },
    }, timeoutMs);
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex App Server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      (timer as any).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  close(reason = new Error("Codex App Server stopped")): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.transport.close();
    this.failAll(reason);
  }

  async closeAndWait(reason = new Error("Codex App Server stopped"), timeoutMs = 5_000): Promise<void> {
    this.close(reason);
    if (!this.transport.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.transport.closed!.then(
        () => { clearTimeout(timer); resolve(); },
        () => { clearTimeout(timer); resolve(); },
      );
    });
  }

  private write(message: RpcMessage): void {
    this.transport.input.write(`${JSON.stringify(message)}\n`);
  }

  private async accept(line: string): Promise<void> {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
      this.failAll(new Error("Codex App Server emitted an oversized message"));
      return this.close();
    }
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; }
    catch {
      this.failAll(new Error("Codex App Server emitted invalid JSON"));
      this.close();
      return;
    }

    if (message.id !== undefined && !message.method) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex App Server: ${message.error.message ?? `error ${message.error.code ?? "unknown"}`}`));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      try {
        if (!this.handlers.onRequest) throw new Error(`Unsupported server request: ${message.method}`);
        const result = await this.handlers.onRequest(message.method, message.params);
        this.write({ id: message.id, result });
      } catch (error) {
        this.write({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (message.method) this.handlers.onNotification?.(message.method, message.params);
  }

  private stderr(): string {
    const tail = this.transport.stderrTail?.().trim();
    return tail ? `: ${tail.slice(-500)}` : "";
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Spawn one hidden, persistent stdio App Server. Call client.close() when the provider is disposed. */
export interface StartCodexAppServerOptions {
  codexHome?: string;
  /** Retained for compatibility. Ambient API credentials are always scrubbed before the sidecar starts. */
  forbidApiBilling?: boolean;
  /** Voice is an App Server feature flag; experimentalApi alone does not enable it. */
  enableRealtimeConversation?: boolean;
  /** The dedicated image adapter needs Codex's native image tool; text/voice agents do not. */
  allowImageGeneration?: boolean;
}

/** Native Codex is a transport process, not a second project agent. Keep its home/cwd outside the
 * repository so it cannot independently load project instructions, skills, hooks, or executables
 * around Neko's project-trust and permission boundaries. */
export function codexIsolationHome(
  home: string = homeDir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string {
  const paths = platform === "win32" ? win32 : posix;
  const explicit = String(env.NEKO_CODEX_HOME ?? "").trim();
  if (explicit && paths.isAbsolute(explicit)) {
    const candidate = paths.normalize(explicit);
    if (!transportHomeInsideWorkspace(candidate, cwd, platform)) return candidate;
  }
  const fallback = joinForPlatform(home, platform, ".neko-core", "codex-home");
  if (!transportHomeInsideWorkspace(fallback, cwd, platform)) return fallback;
  throw new Error("Codex transport home must stay outside the workspace; set NEKO_CODEX_HOME to an absolute outside path");
}

/** Capabilities owned by Codex itself would create a second, ungoverned execution/catalog surface.
 * Neko supplies the real tools dynamically, so keep only the App Server transport and code-mode host
 * needed to dispatch those dynamic calls. Every key exists at the supported 0.144.0 boundary. */
const DISABLED_NATIVE_FEATURES = [
  "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "goals", "hooks", "image_generation", "in_app_browser", "multi_agent", "plugins",
  "plugin_sharing", "remote_plugin", "shell_tool", "skill_mcp_dependency_install", "tool_suggest",
  "workspace_dependencies",
] as const;

export function codexAppServerArguments(
  executable: CodexExecutable,
  options: StartCodexAppServerOptions,
): string[] {
  const args = executable.kind === "cli" ? ["app-server"] : [];
  for (const feature of DISABLED_NATIVE_FEATURES) {
    if (feature === "image_generation" && options.allowImageGeneration) continue;
    if (executable.kind === "cli") args.push("--disable", feature);
    else args.push("-c", `features.${feature}=false`);
  }
  // Neko exposes its own progressive skill catalog through developer context and the dynamic
  // `skill` tool. Do not also inject Codex's ambient ~/.codex or ~/.agents catalog: it duplicates
  // instructions and gives the model host paths that bypass Neko's catalog boundary when a skill
  // is missing. This config key exists at the supported Codex 0.144.0 boundary.
  args.push("-c", "skills.include_instructions=false");
  // Project instructions are supplied only by Neko after its exact-snapshot trust check. Codex's
  // own AGENTS.md walk would be a second, unsnapshotted control plane; these keys are supported at
  // the same 0.144.0 boundary (`0` returns no project doc, `[]` disables ancestor traversal).
  args.push("-c", "project_doc_max_bytes=0", "-c", "project_root_markers=[]");
  if (options.enableRealtimeConversation) {
    if (executable.kind === "cli") args.push("--enable", "realtime_conversation");
    else args.push("-c", "features.realtime_conversation=true");
  }
  args.push("--listen", "stdio://");
  return args;
}

export function startCodexAppServer(
  executable: CodexExecutable,
  handlers: CodexAppServerHandlers = {},
  options: StartCodexAppServerOptions = {},
): CodexAppServerClient {
  const checks: ExecutableChecks = {
    platform: process.platform,
    cwd: process.cwd(),
    realpath: realPath,
    isRegularFile,
  };
  const path = canonicalExecutable(executable.path, executable.source !== "path", checks);
  if (!path) throw new Error("Codex executable is not a trusted absolute regular file");
  const verifiedExecutable = { ...executable, path };
  const appArgs = codexAppServerArguments(verifiedExecutable, options);
  const launch = commandFor(verifiedExecutable, appArgs, process.platform, process.env, process.cwd(), checks);
  if (!launch) throw new Error("Codex executable needs a trusted absolute Windows runtime");
  // Neko supplies auth and tools over stdio. An isolated home prevents the user's Codex MCP/plugins
  // from slowing startup or gaining an unexpected second execution path beside Neko's approval gate.
  const codexHome = options.codexHome ?? codexIsolationHome();
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  try { chmodSync(codexHome, 0o700); } catch { /* Windows ACLs do not implement POSIX modes. */ }
  const env = providerChildEnv(process.env, {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    USERPROFILE: codexHome,
    RUST_LOG: process.env.RUST_LOG ?? "warn",
  }, checks);
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env,
    cwd: codexHome,
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  let client: CodexAppServerClient | null = null;
  child.on("error", (error) => {
    // A binary removed between discovery and spawn must become a normal provider error, not an
    // unhandled ChildProcess "error" event that crashes the whole interactive session.
    stderr = `${stderr}\n${error.message}`.slice(-4000);
    client?.close(new Error(`Codex App Server failed to start: ${error.message}`));
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child.killed) return;
    child.kill();
  };
  const exitCleanup = () => stop();
  process.once("exit", exitCleanup);
  const transport: RpcTransport = {
    input: child.stdin,
    output: child.stdout,
    close: () => {
      process.removeListener("exit", exitCleanup);
      stop();
    },
    closed,
    stderrTail: () => stderr,
  };
  client = new CodexAppServerClient(transport, handlers);
  return client;
}

function joinForPlatform(home: string, platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === "win32" ? win32 : posix).join(home, ...parts);
}
