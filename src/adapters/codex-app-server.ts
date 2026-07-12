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
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, posix, win32 } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { homeDir } from "../shared/home.ts";
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
  pathExists?: (path: string) => boolean;
  readText?: (path: string) => string;
  runVersion?: (executable: CodexExecutable) => string | null;
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

function systemCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const explicit = String(env.NEKO_CODEX_PATH ?? "").trim();
  const out = explicit ? [explicit] : [];
  const names = platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1"]
    : ["codex"];
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const paths = platform === "win32" ? win32 : posix;
  for (const directory of String(env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const name of names) out.push(paths.join(directory.replace(/^"|"$/g, ""), name));
  }
  return [...new Set(out)];
}

function executableKind(path: string): CodexExecutable["kind"] {
  return /codex-app-server(?:\.exe)?$/i.test(path) ? "app-server" : "cli";
}

function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

function commandFor(
  executable: CodexExecutable,
  args: string[],
  platform = process.platform,
): { command: string; args: string[]; shell?: boolean } {
  const extension = extname(executable.path).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const npmEntry = win32.join(dirname(executable.path), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(npmEntry)) return { command: "node.exe", args: [npmEntry, ...args] };
    // Node/Bun cannot CreateProcess a batch file directly. shell=true delegates the fixed, locally
    // discovered path and fixed App Server flags to cmd.exe; no user prompt/model text enters it.
    return { command: executable.path, args, shell: true };
  }
  if (platform === "win32" && extension === ".ps1") {
    return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable.path, ...args] };
  }
  return { command: executable.path, args };
}

function realVersion(executable: CodexExecutable): string | null {
  if (executable.source === "managed" && executable.version) return executable.version;
  const command = commandFor(executable, ["--version"]);
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    shell: command.shell,
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
  const pathExists = options.pathExists ?? existsSync;
  const readText = options.readText ?? ((path) => readFileSync(path, "utf8"));
  const runVersion = options.runVersion ?? realVersion;

  const managed = managedExecutable(home, platform, pathExists, readText);
  const candidates: CodexExecutable[] = managed ? [managed] : [];
  for (const path of systemCandidates(env, platform)) {
    if (!pathExists(path)) continue;
    candidates.push({
      path,
      kind: executableKind(path),
      source: String(env.NEKO_CODEX_PATH ?? "").trim() === path ? "environment" : "path",
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
  /** Subscription-only callers remove API credentials so no upstream fallback can create API charges. */
  forbidApiBilling?: boolean;
  /** Voice is an App Server feature flag in Codex 0.144; experimentalApi alone does not enable it. */
  enableRealtimeConversation?: boolean;
}

export function codexAppServerArguments(
  executable: CodexExecutable,
  options: StartCodexAppServerOptions,
): string[] {
  const args = executable.kind === "cli" ? ["app-server"] : [];
  if (options.enableRealtimeConversation) args.push("--enable", "realtime_conversation");
  args.push("--listen", "stdio://");
  return args;
}

export function startCodexAppServer(
  executable: CodexExecutable,
  handlers: CodexAppServerHandlers = {},
  options: StartCodexAppServerOptions = {},
): CodexAppServerClient {
  const appArgs = codexAppServerArguments(executable, options);
  const launch = commandFor(executable, appArgs);
  // Neko supplies auth and tools over stdio. An isolated home prevents the user's Codex MCP/plugins
  // from slowing startup or gaining an unexpected second execution path beside Neko's approval gate.
  const codexHome = options.codexHome ?? (process.env.NEKO_CODEX_HOME || joinForPlatform(homeDir(), process.platform, ".neko-core", "codex-home"));
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  try { chmodSync(codexHome, 0o700); } catch { /* Windows ACLs do not implement POSIX modes. */ }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome, RUST_LOG: process.env.RUST_LOG ?? "warn" };
  if (options.forbidApiBilling) {
    delete env.OPENAI_API_KEY;
    delete env.NEKO_API_KEY;
  }
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: launch.shell,
    env,
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
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else child.kill();
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
    stderrTail: () => stderr,
  };
  client = new CodexAppServerClient(transport, handlers);
  return client;
}

function joinForPlatform(home: string, platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === "win32" ? win32 : posix).join(home, ...parts);
}
