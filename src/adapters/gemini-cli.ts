/** Official Gemini CLI ACP discovery, authentication, and newline-delimited JSON-RPC transport. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, posix, win32 } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { atomicWriteFileSync } from "../shared/atomic.ts";
import { scrubChildEnv } from "../shared/child-env.ts";
import { homeDir } from "../shared/home.ts";
import { isJsonNumber, isJsonObject, isObjectValue, isText, type JsonValue } from "../shared/wire.ts";
import { VERSION } from "../shared/version.ts";

export const GEMINI_CLI_MIN_VERSION = "0.38.0";
const RPC_TIMEOUT_MS = 20_000;
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const CONSUMER_OAUTH_ENDED = /no longer supported for Gemini Code Assist for individuals|migrate to the Antigravity/i;

export function explainGeminiCliError(message: string): string {
  if (!CONSUMER_OAUTH_ENDED.test(message)) return message;
  return "Google ended Gemini CLI sign-in for Free/AI Pro/Ultra on 2026-06-18. "
    + "In Neko, use /login -> Google -> Gemini API key. Gemini Code Assist Standard/Enterprise "
    + "can still use the CLI route. Antigravity is a separate Google product; Neko does not reuse its credentials.";
}

export interface GeminiExecutable {
  path: string;
  runtime?: string;
  version?: string;
  source: "managed" | "environment" | "path";
}

export interface GeminiCliStatus {
  state: "ready" | "missing" | "outdated" | "invalid";
  executable?: GeminiExecutable;
  detail: string;
}

export interface GeminiModelInfo {
  id: string;
  name: string;
  description?: string;
}

export interface GeminiUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  models: Array<{ model: string; inputTokens: number; outputTokens: number }>;
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
  runVersion?: (executable: GeminiExecutable) => string | null;
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

interface ManagedManifest {
  geminiVersion?: string;
  entry?: string;
  runtime?: string;
}

export interface RpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface GeminiAcpHandlers {
  onNotification?: (method: string, params: any) => void;
  onRequest?: (method: string, params: any) => Promise<JsonValue>;
}

interface RpcTransport {
  input: Writable;
  output: Readable;
  close: () => void;
  stderrTail?: () => string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GeminiAcpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly reader: ReadlineInterface;
  private nextId = 1;
  private closed = false;

  constructor(private readonly transport: RpcTransport, private readonly handlers: GeminiAcpHandlers = {}) {
    this.reader = createInterface({ input: transport.output });
    this.reader.on("line", (line) => { void this.accept(line); });
    this.reader.on("close", () => this.failAll(new Error(`Gemini CLI ACP closed${this.stderr()}`)));
  }

  initialize(timeoutMs = 60_000): Promise<any> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "neko_core", title: "Neko Core", version: VERSION },
    }, timeoutMs);
  }

  authenticate(apiKey?: string, timeoutMs = 5 * 60_000): Promise<any> {
    return this.request("authenticate", apiKey
      ? { methodId: "gemini-api-key", _meta: { "api-key": apiKey } }
      : { methodId: "oauth-personal" }, timeoutMs);
  }

  request(method: string, params?: any, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Gemini CLI ACP is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gemini CLI ACP request timed out: ${method}`));
      }, timeoutMs);
      // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
      (timer as any).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: any): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(reason = new Error("Gemini CLI ACP stopped")): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.transport.close();
    this.failAll(reason);
  }

  private write(message: RpcMessage): void {
    this.transport.input.write(`${JSON.stringify(message)}\n`);
  }

  private async accept(line: string): Promise<void> {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
      return this.close(new Error("Gemini CLI ACP emitted an oversized message"));
    }
    let message: RpcMessage;
    // SAFETY: contract of the RpcMessage type is established by the surrounding validation/boundary.
    try {
      // SAFETY: raw ACP NDJSON line; RpcMessage fields are unvalidated wire data (any).
      message = JSON.parse(line) as RpcMessage;
    }
    catch { return this.close(new Error("Gemini CLI ACP emitted invalid JSON")); }

    if (message.id !== undefined && !message.method) {
      const id = isJsonNumber(message.id) ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = explainGeminiCliError(message.error.message ?? `error ${message.error.code ?? "unknown"}`);
        pending.reject(new Error(`Gemini CLI ACP: ${detail}`));
      }
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      try {
        if (!this.handlers.onRequest) throw new Error(`Unsupported Gemini CLI request: ${message.method}`);
        this.write({ jsonrpc: "2.0", id: message.id, result: await this.handlers.onRequest(message.method, message.params) });
      } catch (error) {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
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

export function compareGeminiVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(/[+-]/, 1)[0].split(".").map((part) => Number(part) || 0);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function systemCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Array<{ path: string; source: "environment" | "path" }> {
  const explicit = String(env.NEKO_GEMINI_PATH ?? "").trim();
  const paths = platform === "win32" ? win32 : posix;
  const out: Array<{ path: string; source: "environment" | "path" }> = [];
  // NEKO_GEMINI_PATH is an explicit user grant. It may point into the workspace, but it must still
  // name an absolute regular file. Ordinary PATH discovery never receives that exception.
  if (explicit && paths.isAbsolute(explicit)) out.push({ path: explicit, source: "environment" });
  const names = platform === "win32" ? ["gemini.cmd", "gemini.exe", "gemini.ps1", "gemini.bat"] : ["gemini"];
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
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
  executable: GeminiExecutable,
  args: string[],
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  checks?: ExecutableChecks,
): LaunchCommand | null {
  if (executable.runtime) return { command: executable.runtime, args: [executable.path, ...args] };
  const extension = extname(executable.path).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat" || extension === ".ps1")) {
    const activeChecks: ExecutableChecks = checks ?? {
      platform,
      cwd,
      realpath: realPath,
      isRegularFile,
    };
    const root = win32.dirname(executable.path);
    const rawBundle = win32.join(root, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    const bundle = canonicalExecutable(rawBundle, executable.source === "environment", activeChecks);
    const node = trustedNode(env, cwd, activeChecks);
    if (bundle && node) return { command: node, args: [bundle, ...args] };
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

export function __geminiLaunchForTest(
  executable: GeminiExecutable,
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

function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

const PROVIDER_CHILD_ENV_ALLOWLIST = new Set([
  "ALL_PROXY", "COLORTERM", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "FORCE_COLOR", "GEMINI_CLI_HOME",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_QUOTA_PROJECT",
  "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "NODE_EXTRA_CA_CERTS",
  "NO_COLOR", "NO_PROXY", "PATH", "PATHEXT", "REQUESTS_CA_BUNDLE", "SSL_CERT_DIR", "SSL_CERT_FILE",
  "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WAYLAND_DISPLAY", "WINDIR",
  "WSL_DISTRO_NAME", "WSL_INTEROP", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
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
export function __geminiChildEnvForTest(source: NodeJS.ProcessEnv, checks?: ExecutableChecks): NodeJS.ProcessEnv {
  return providerChildEnv(source, {}, checks);
}

function realVersion(
  executable: GeminiExecutable,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
  checks: ExecutableChecks,
): string | null {
  if (executable.source === "managed" && executable.version) return executable.version;
  const launch = commandFor(executable, ["--version"], platform, env, cwd, checks);
  if (!launch) return null;
  const result = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    env: providerChildEnv(env, {}, checks),
    cwd: (platform === "win32" ? win32 : posix).dirname(executable.path),
  });
  return result.status === 0 ? parseVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) : null;
}

let discoveryCache: { at: number; status: GeminiCliStatus } | null = null;

/** Discover a compatible official Gemini CLI without starting a model session or reading credentials. */
export function discoverGeminiCli(options: DiscoveryOptions = {}): GeminiCliStatus {
  const cacheable = Object.keys(options).length === 0;
  if (cacheable && discoveryCache && Date.now() - discoveryCache.at < 30_000) return discoveryCache.status;
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
  const readText = options.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const runVersion = options.runVersion ?? ((executable) => realVersion(executable, env, platform, cwd, checks));
  const managed = managedExecutable(home, platform, pathExists, readText);
  const candidates: GeminiExecutable[] = [];
  if (managed) {
    const path = canonicalExecutable(managed.path, true, checks);
    const runtime = managed.runtime ? canonicalExecutable(managed.runtime, true, checks) : null;
    if (path && runtime) candidates.push({ ...managed, path, runtime });
  }
  for (const candidate of systemCandidates(env, platform)) {
    const path = canonicalExecutable(candidate.path, candidate.source === "environment", checks);
    if (path) candidates.push({ path, source: candidate.source });
  }
  if (!candidates.length) return { state: "missing", detail: "optional Gemini Support Pack is not installed" };

  let outdated: GeminiExecutable | undefined;
  for (const candidate of candidates) {
    const version = runVersion(candidate) ?? undefined;
    const executable = { ...candidate, version };
    if (!version) continue;
    if (compareGeminiVersions(version, GEMINI_CLI_MIN_VERSION) >= 0) {
      const status: GeminiCliStatus = { state: "ready", executable, detail: `${candidate.source} ${version}` };
      if (cacheable) discoveryCache = { at: Date.now(), status };
      return status;
    }
    outdated ??= executable;
  }
  return outdated
    ? { state: "outdated", executable: outdated, detail: `Gemini CLI ${outdated.version} is older than required ${GEMINI_CLI_MIN_VERSION}` }
    : { state: "invalid", executable: candidates[0], detail: "Gemini CLI was found but its version could not be verified" };
}

function managedExecutable(
  home: string,
  platform: NodeJS.Platform,
  pathExists: (path: string) => boolean,
  readText: (path: string) => string,
): GeminiExecutable | null {
  const paths = platform === "win32" ? win32 : posix;
  const root = paths.join(home, ".neko-core", "gemini-support");
  const manifestPath = paths.join(root, "support-pack.json");
  if (!pathExists(manifestPath)) return null;
  try {
    // SAFETY: contract of the ManagedManifest type is established by the surrounding validation/boundary.
    const manifest = JSON.parse(readText(manifestPath)) as ManagedManifest;
    if (!manifest.entry || !manifest.runtime || paths.isAbsolute(manifest.entry) || paths.isAbsolute(manifest.runtime)
      || manifest.entry.split(/[\\/]/).includes("..") || manifest.runtime.split(/[\\/]/).includes("..")) return null;
    const path = paths.join(root, manifest.entry);
    const runtime = paths.join(root, manifest.runtime);
    if (!pathExists(path) || !pathExists(runtime)) return null;
    return { path, runtime, source: "managed", version: manifest.geminiVersion };
  } catch {
    return null;
  }
}

export function clearGeminiCliCache(): void { discoveryCache = null; }

function geminiStateRoot(): string {
  return String(process.env.NEKO_GEMINI_HOME ?? "").trim() || join(homeDir(), ".neko-core", "gemini-home");
}

export function geminiCredentialsPath(): string {
  return join(geminiStateRoot(), "oauth_creds.json");
}

export function hasGeminiCredentials(): boolean {
  return existsSync(geminiCredentialsPath());
}

/** Remove only Gemini CLI OAuth state; API keys and other provider sessions are untouched. */
export function clearGeminiCredentials(): string {
  const credentials = geminiCredentialsPath();
  const accounts = join(geminiStateRoot(), "google_accounts.json");
  const hadCredentials = existsSync(credentials);
  rmSync(credentials, { force: true });
  if (existsSync(accounts)) {
    try {
      const data = JSON.parse(readFileSync(accounts, "utf8"));
      if (isJsonObject(data)) {
        if (isText(data.active) && data.active && Array.isArray(data.old) && !data.old.includes(data.active)) data.old.push(data.active);
        data.active = null;
        atomicWriteFileSync(accounts, JSON.stringify(data, null, 2) + "\n");
      }
    } catch { /* credential removal remains authoritative even if the non-secret account cache is malformed */ }
  }
  return hadCredentials ? "Gemini CLI signed out" : "Gemini CLI was already signed out";
}

function managedSystemSettingsPath(): string {
  const path = join(homeDir(), ".neko-core", "gemini", "system-settings.json");
  const content = JSON.stringify({
    tools: { core: [] },
    mcp: { allowed: ["neko"] },
    hooksConfig: { enabled: false },
    useWriteTodos: false,
  }, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) atomicWriteFileSync(path, content);
  return path;
}

/** Start one hidden Gemini CLI ACP sidecar. Its built-in tools/extensions/hooks are disabled. */
export function startGeminiAcp(
  executable: GeminiExecutable,
  handlers: GeminiAcpHandlers = {},
  options: { geminiHome?: string } = {},
): GeminiAcpClient {
  const checks: ExecutableChecks = {
    platform: process.platform,
    cwd: process.cwd(),
    realpath: realPath,
    isRegularFile,
  };
  const path = canonicalExecutable(executable.path, executable.source !== "path", checks);
  const runtime = executable.runtime ? canonicalExecutable(executable.runtime, executable.source !== "path", checks) : undefined;
  if (!path || (executable.runtime && !runtime)) throw new Error("Gemini executable is not a trusted absolute regular file");
  const verifiedExecutable: GeminiExecutable = { ...executable, path, runtime: runtime ?? undefined };
  const launch = commandFor(verifiedExecutable, ["--acp", "-e", "none"], process.platform, process.env, process.cwd(), checks);
  if (!launch) throw new Error("Gemini executable needs a trusted absolute Windows runtime");
  const geminiHome = options.geminiHome ?? geminiStateRoot();
  mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
  const env = providerChildEnv(process.env, {
    GEMINI_CLI_HOME: geminiHome,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: managedSystemSettingsPath(),
    HOME: geminiHome,
    USERPROFILE: geminiHome,
  }, checks);
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env,
    cwd: geminiHome,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  let client: GeminiAcpClient | null = null;
  child.on("error", (error) => client?.close(new Error(`Gemini CLI failed to start: ${error.message}`)));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child.killed) return;
    child.kill();
  };
  const exitCleanup = () => stop();
  process.once("exit", exitCleanup);
  client = new GeminiAcpClient({
    input: child.stdin,
    output: child.stdout,
    close: () => { process.removeListener("exit", exitCleanup); stop(); },
    stderrTail: () => stderr,
  }, handlers);
  return client;
}

function requireGeminiExecutable(): GeminiExecutable {
  const status = discoverGeminiCli();
  if (status.state !== "ready" || !status.executable) throw new Error(status.detail);
  return status.executable;
}

/** Enterprise/Google Cloud OAuth owned by Gemini CLI. Consumer OAuth ended on 2026-06-18. */
export async function loginGemini(notify: (message: string) => void = () => {}): Promise<void> {
  const client = startGeminiAcp(requireGeminiExecutable());
  try {
    await client.initialize();
    notify("Opening Google sign-in in your browser...");
    await client.authenticate();
  } finally {
    client.close();
  }
}

let modelCache: { key: string; at: number; models: GeminiModelInfo[] } | null = null;

/** Account-aware model catalog from ACP session setup; no model prompt or quota-consuming turn. */
export async function listGeminiModels(apiKey?: string): Promise<GeminiModelInfo[]> {
  const key = apiKey ? "api" : "oauth";
  if (modelCache?.key === key && Date.now() - modelCache.at < 5 * 60_000) return modelCache.models;
  const client = startGeminiAcp(requireGeminiExecutable());
  try {
    await client.initialize();
    await client.authenticate(apiKey);
    const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] }, 60_000);
    const raw = Array.isArray(session?.models?.availableModels) ? session.models.availableModels : [];
    const models = raw.map((model: any) => ({
      id: String(model?.modelId ?? "").trim(),
      name: String(model?.name ?? model?.modelId ?? "").trim(),
      description: isText(model?.description) ? model.description.trim() : undefined,
    })).filter((model: GeminiModelInfo) => model.id);
    if (models.length) modelCache = { key, at: Date.now(), models };
    return models;
  } finally {
    client.close();
  }
}

export function geminiUsageFromPrompt(result: any): GeminiUsageSnapshot | undefined {
  const standard = result?.usage;
  if (standard && Number.isFinite(Number(standard.inputTokens)) && Number.isFinite(Number(standard.outputTokens))) {
    return { inputTokens: Number(standard.inputTokens), outputTokens: Number(standard.outputTokens), models: [] };
  }
  const quota = result?._meta?.quota;
  const tokens = quota?.token_count;
  if (!tokens) return undefined;
  return {
    inputTokens: Number(tokens.input_tokens ?? 0),
    outputTokens: Number(tokens.output_tokens ?? 0),
    models: (Array.isArray(quota.model_usage) ? quota.model_usage : []).map((item: any) => ({
      model: String(item?.model ?? "unknown"),
      inputTokens: Number(item?.token_count?.input_tokens ?? 0),
      outputTokens: Number(item?.token_count?.output_tokens ?? 0),
    })),
  };
}
