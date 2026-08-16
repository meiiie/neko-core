/**
 * `neko bench` — a tiny built-in agentic-coding benchmark. Runs a handful of self-contained tasks
 * against the configured model (in-process, auto-approve, in a temp dir) and verifies each with a
 * deterministic check (no LLM judge). Reports pass@1 + tokens — so you can measure / compare models.
 * Model choice is the biggest quality lever; this makes that measurable instead of vibes.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { homeDir } from "../shared/home.ts";
import { isJsonArray, isJsonObject, isText, type JsonValue } from "../shared/wire.ts";

import { Agent, classifyToolObservation, DEFAULT_SYSTEM_PROMPT } from "../core/agent.ts";
import type { Provider } from "../core/ports.ts";
import { terminateProcessTree, ToolRegistry, type ToolTurnLease } from "../core/tool-runtime.ts";
import { detectSandbox, executableOnPath, findWindowsBash, resolveSrtBunBridge, sandboxActive, wrapBash } from "../core/sandbox.ts";
import { redactSecrets, type NekoConfig } from "./config.ts";
import { createFrontierTasks, type HiddenBenchProgram } from "./frontier-bench.ts";
import { getProvider } from "./providers.ts";
import { configureToolRegistry } from "./tool-registry.ts";
import { matchedTurnContext, productionTurnContext } from "./turn-context.ts";
import { planTurnCapabilities } from "./turn-capabilities.ts";
import {
  analyzeTask,
  aggregate,
  redundantCallMask,
  renderScorecard,
  type DimReport,
  type TaskSpec,
  type TraceEntry,
  type TrialOutcome,
  type TrialRecord,
} from "./bench-metrics.ts";

export interface BenchTask {
  id: string;
  files: Record<string, string>;
  prompt: string;
  verify: (dir: string) => boolean | Promise<boolean>;
  /** Stable version/digest for verifier fixtures captured outside Function#toString (for example a
   * private task-pack manifest). Optional for existing built-ins; frontier packs should always set it. */
  manifestIdentity?: string;
  /** Estimated minimum tool-calls an efficient agent needs (Execution-efficiency / step-efficiency). */
  optimalSteps?: number;
  /** Hard end-state invariants the agent must honor. They also feed the Assurance dimension.
   * `keep` = a file that must stay byte-identical to its seed; `check` = an arbitrary predicate. */
  constraints?: { id: string; keep?: string; check?: (dir: string) => boolean }[];
}

const read = (d: string, f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
const lines = (s: string | null) => (s ?? "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean);

function keepFiles(...names: string[]): NonNullable<BenchTask["constraints"]> {
  return names.map((keep) => ({ id: `keep-${keep}`, keep }));
}

export class BenchInfrastructureError extends Error {
  override name = "BenchInfrastructureError";
}

const ORACLE_CHILD_ENV_ALLOWLIST = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
]);

/** A benchmark verifier is less trusted than an ordinary agent shell: retain only OS/launcher state.
 * SRT needs LOCALAPPDATA to open its coordination database; the protected launch then replaces PATH
 * and temp variables with its own exact Bun bridge and unique writable scratch directory. */
function oracleChildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && ORACLE_CHILD_ENV_ALLOWLIST.has(entry[0].toUpperCase()),
  ));
  return { ...base, ...overrides };
}

function pathInside(root: string, path: string): boolean {
  const foldedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const foldedPath = process.platform === "win32" ? path.toLowerCase() : path;
  return foldedPath === foldedRoot || foldedPath.startsWith(foldedRoot + sep);
}

function benchmarkHostCodeFiles(root: string): string[] {
  const candidates = [
    resolve(import.meta.dir, "bench.ts"),
    resolve(import.meta.dir, "frontier-bench.ts"),
    resolve(import.meta.dir, "..", "..", "test", "frontier-bench.test.ts"),
    resolve(import.meta.dir, "..", "..", "dist", "neko.exe"),
    resolve(import.meta.dir, "..", "..", "dist", "neko"),
  ];
  try {
    const runtime = realpathSync(process.execPath);
    if (!/^(?:bun|node)(?:\.exe)?$/i.test(basename(runtime))) candidates.push(runtime);
  } catch { /* source files remain the source-run boundary */ }
  const files = new Set<string>();
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      if (!lstatSync(canonical).isFile()) continue;
      if (pathInside(root, canonical)) throw new BenchInfrastructureError("benchmark trial contains a hidden-oracle implementation file");
      files.add(canonical);
    } catch (error) {
      if (error instanceof BenchInfrastructureError) throw error;
    }
  }
  if (!files.size) {
    throw new BenchInfrastructureError("benchmark verifier infrastructure unavailable: hidden-oracle implementation path is not maskable");
  }
  return [...files];
}

function benchmarkSourceDigest(): string {
  const hash = createHash("sha256");
  const runtime = realpathSync(process.execPath);
  const compiled = !/^(?:bun|node)(?:\.exe)?$/i.test(basename(runtime));
  let files = 0;
  let bytes = 0;
  const addFile = (path: string, label: string) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BenchInfrastructureError(`benchmark fingerprint source is not a regular file: ${label}`);
    const content = readFileSync(path);
    files++;
    bytes += content.byteLength;
    if (files > 4_096 || bytes > 256 * 1024 * 1024) throw new BenchInfrastructureError("benchmark fingerprint source exceeded its bound");
    hash.update(`${label.length}:${label}:${content.byteLength}:`);
    hash.update(content);
  };
  const addTree = (root: string, rel = "") => {
    const dir = join(root, rel);
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name));
    if (entries.length > 4_096) throw new BenchInfrastructureError("benchmark fingerprint directory exceeded its bound");
    for (const entry of entries) {
      const childRel = join(rel, entry.name);
      if (entry.isSymbolicLink()) throw new BenchInfrastructureError(`benchmark fingerprint source contains a symlink: ${childRel}`);
      if (entry.isDirectory()) addTree(root, childRel);
      else if (entry.isFile()) addFile(join(root, childRel), childRel.split(sep).join("/"));
      else throw new BenchInfrastructureError(`benchmark fingerprint source has an unsupported entry: ${childRel}`);
    }
  };
  hash.update(`runtime:${process.versions.bun ?? process.version}\n`);
  if (compiled) {
    addFile(runtime, `runtime/${basename(runtime)}`);
  } else {
    const packageRoot = resolve(import.meta.dir, "..", "..");
    addTree(join(packageRoot, "src"), "");
    for (const name of ["bin/neko.ts", "bin/neko-source.cjs", "package.json", "bun.lock", "bunfig.neko.toml"]) {
      const path = join(packageRoot, name);
      if (existsSync(path)) addFile(path, name);
    }
  }
  return hash.digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface BenchmarkEnvironmentIdentity {
  sourceDigest: string;
  platform: NodeJS.Platform;
  arch: string;
  sandboxKind: ReturnType<typeof detectSandbox>;
  sandboxLive: boolean;
  runtimeKind: "bun" | "node";
  runtimeVersion: string;
}

function benchmarkEnvironmentIdentity(): BenchmarkEnvironmentIdentity {
  return {
    sourceDigest: benchmarkSourceDigest(),
    platform: process.platform,
    arch: process.arch,
    sandboxKind: detectSandbox(),
    sandboxLive: sandboxActive(),
    runtimeKind: process.versions.bun ? "bun" : "node",
    runtimeVersion: process.versions.bun ?? process.versions.node ?? process.version,
  };
}

/** Accepts any plain config/task graph (typed interfaces included); the walk only follows JSON-shaped members. */
function canonicalFingerprintValue(value: any): JsonValue {
  if (isJsonArray(value)) return value.map(canonicalFingerprintValue);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, canonicalFingerprintValue(value[key])]),
  );
}

function benchmarkResolvedConfigIdentity(cfg: NekoConfig): JsonValue {
  const redacted = redactSecrets(cfg.data);
  if (!isJsonObject(redacted)) return redacted;
  return canonicalFingerprintValue({ ...redacted, base_url: cfg.baseUrl });
}

function benchmarkSelectedProfileIdentity(cfg: NekoConfig): JsonValue {
  const selected = redactSecrets(cfg.profile ? cfg.profiles[cfg.profile] ?? null : null);
  if (!isJsonObject(selected)) return selected;
  const profile = { ...selected };
  const baseUrl = profile.base_url;
  if (isText(baseUrl)) profile.base_url = baseUrl.replace(/\/+$/, "");
  return canonicalFingerprintValue(profile);
}

function benchmarkRunFingerprint(
  cfg: NekoConfig,
  tasks: readonly BenchTask[],
  maxSteps: number,
  environment = benchmarkEnvironmentIdentity(),
  scorecard: { slaMs?: number } = {},
): string {
  const taskIdentity = tasks.map((task) => ({
    id: task.id,
    prompt: task.prompt,
    files: Object.fromEntries(Object.entries(task.files).sort(([a], [b]) => compareCodeUnits(a, b))),
    manifestIdentity: task.manifestIdentity ?? null,
    optimalSteps: task.optimalSteps ?? null,
    constraints: (task.constraints ?? []).map((constraint) => ({
      id: constraint.id,
      keep: constraint.keep ?? null,
      check: constraint.check ? String(constraint.check) : null,
    })),
    verify: String(task.verify),
  }));
  const hash = createHash("sha256");
  hash.update(JSON.stringify(canonicalFingerprintValue({
    environment,
    tasks: taskIdentity,
    maxSteps,
    resolvedConfig: benchmarkResolvedConfigIdentity(cfg),
    provider: cfg.provider,
    endpoint: cfg.baseUrl,
    profile: cfg.profile ?? null,
    selectedProfile: benchmarkSelectedProfileIdentity(cfg),
    model: cfg.model,
    effort: cfg.effort || "off",
    adaptiveEffort: cfg.adaptiveEffort,
    verifyBeforeExit: cfg.data.verify_before_exit !== false,
    scorecard,
  })));
  return `sha256:${hash.digest("hex")}`;
}

/** Internal pure-ish test seam: reads the current source snapshot but performs no model/tool work. */
export const __benchmarkRunFingerprintForTest = benchmarkRunFingerprint;

function oracleBunCommand(root: string): string {
  if (process.platform === "win32") {
    if (!resolveSrtBunBridge(root)) throw new BenchInfrastructureError("benchmark verifier infrastructure unavailable: no trusted Bun bridge");
    const bash = findWindowsBash();
    if (!bash || pathInside(root, bash)) throw new BenchInfrastructureError("benchmark verifier infrastructure unavailable: the protected Git-Bash launcher is missing");
    return "bun"; // protected Git-Bash function + launch-local bun.cmd, both point to the frozen bridge
  }
  const runtime = (() => { try { return realpathSync(process.execPath); } catch { return ""; } })();
  const candidate = runtime && /^bun(?:\.exe)?$/i.test(basename(runtime)) && !pathInside(root, runtime)
    ? runtime
    : executableOnPath("bun", process.env.PATH ?? "", root);
  if (!candidate) throw new BenchInfrastructureError("benchmark verifier infrastructure unavailable: no trusted Bun executable outside the trial workspace");
  return `'${candidate.replace(/'/g, "'\\''")}'`;
}

function quoteBashArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface BoundedSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  treeCleanupConfirmed: boolean;
}

/** Spawn a sandbox target with a byte cap and a process-tree postcondition. `spawnSync({timeout})`
 * kills only the immediate launcher on some platforms, so detached verifier grandchildren could
 * otherwise survive after a trial was scored and its sandbox material was removed. */
async function runBoundedSandboxTarget(
  target: ReturnType<typeof wrapBash>,
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  terminate: typeof terminateProcessTree = terminateProcessTree,
  stdinSource?: string,
): Promise<BoundedSpawnResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(target.file, target.args, {
      shell: target.shell,
      cwd: root,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    return {
      status: null, signal: null, error: error instanceof Error ? error : new Error(String(error)),
      stdout: "", stderr: "", timedOut: false, outputExceeded: false, treeCleanupConfirmed: true,
    };
  }

  return await new Promise((resolveResult) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let totalBytes = 0;
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Omit<BoundedSpawnResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult({ ...result, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    };
    const stop = async (reason: "timeout" | "output") => {
      if (stopping || settled) return;
      stopping = true;
      let confirmed = false;
      try { confirmed = await terminate(child); } catch { /* reported through postcondition */ }
      finish({
        status: child.exitCode,
        signal: child.signalCode,
        timedOut: reason === "timeout",
        outputExceeded: reason === "output",
        treeCleanupConfirmed: confirmed,
      });
    };
    const capture = (stream: "stdout" | "stderr", chunk: unknown) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, maxOutputBytes - totalBytes);
      if (remaining > 0) {
        const kept = bytes.subarray(0, remaining);
        if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
        else stderr = Buffer.concat([stderr, kept]);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > maxOutputBytes) void stop("output");
    };

    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));
    if (stdinSource !== undefined) {
      // Early candidate exit legitimately closes the pipe before the harness finishes writing.
      // Completion is decided by the private attestation suffix, not by an EPIPE on stdin.
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdinSource);
    }
    child.once("error", (error) => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        let confirmed = !child.pid;
        if (child.pid) {
          try { confirmed = await terminate(child); } catch { /* reported below */ }
        }
        finish({
          status: child.exitCode, signal: child.signalCode, error,
          timedOut: false, outputExceeded: false, treeCleanupConfirmed: confirmed,
        });
      })();
    });
    child.once("close", (status, signal) => {
      if (stopping) return;
      // A candidate can detach a descendant and then exit 0. The oracle builders use either a PID
      // namespace, a no-fork Seatbelt profile, or SRT's kill-on-close Job Object. Other targets still
      // need an explicit group/tree sweep before ordinary completion can be accepted.
      stopping = true;
      void (async () => {
        let confirmed = target.treeContainedOnClose === true && status !== null && signal === null;
        if (!confirmed) {
          try { confirmed = await terminate(child); } catch { /* reported through postcondition */ }
        }
        finish({
          status, signal, timedOut: false, outputExceeded: false, treeCleanupConfirmed: confirmed,
        });
      })();
    });
    timer = setTimeout(() => { void stop("timeout"); }, timeoutMs);
  });
}

async function runBoundedBenchCandidate(
  target: ReturnType<typeof wrapBash>,
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  terminate: typeof terminateProcessTree = terminateProcessTree,
  stdinSource?: string,
): Promise<BoundedSpawnResult> {
  const launched = await runBoundedSandboxTarget(target, root, env, timeoutMs, maxOutputBytes, terminate, stdinSource);
  if (!launched.treeCleanupConfirmed) {
    throw new BenchInfrastructureError("benchmark verifier infrastructure unavailable: target process-tree cleanup was not confirmed");
  }
  return launched;
}

/** Internal test seam for the bounded candidate supervisor and its fail-closed postcondition. */
export const __runBoundedBenchProcessForTest = runBoundedBenchCandidate;

function verifierModuleSpecifier(root: string, sourcePath: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;
  const lexical = resolve(dirname(sourcePath), specifier);
  if (!pathInside(root, lexical)) {
    throw new BenchInfrastructureError("benchmark verifier source contains an escaping relative import");
  }
  return pathToFileURL(lexical).href;
}

const SAFE_ASSERT_MODULE_SOURCE = [
  'import assertModule from "node:assert/strict";',
  'const bind = (name) => assertModule[name].bind(assertModule);',
  'export default Object.freeze({',
  '  deepEqual: bind("deepEqual"), deepStrictEqual: bind("deepStrictEqual"),',
  '  equal: bind("equal"), notStrictEqual: bind("notStrictEqual"), ok: bind("ok"),',
  '  rejects: bind("rejects"), strictEqual: bind("strictEqual"), throws: bind("throws"),',
  '});',
].join("\n");

function dataModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function prepareVerifierModuleSource(source: string, root: string, sourcePath: string, safeAssertUrl: string): string {
  let prepared = source.replace(
    /\bimport\s+assert\s+from\s+(["'])node:assert(?:\/strict)?\1\s*;?/g,
    `import assert from ${JSON.stringify(safeAssertUrl)};`,
  );
  prepared = prepared.replace(
    /(\b(?:import|export)\s+(?:[^"'`\n;]*?\s+from\s+)?)(["'])(\.{1,2}\/[^"']+)\2/g,
    (_match, prefix: string, _quote: string, specifier: string) => `${prefix}${JSON.stringify(
      verifierModuleSpecifier(root, sourcePath, specifier),
    )}`,
  );
  return prepared.replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(sourcePath).href));
}

/** Build a stdin supervisor whose output/assertion primitives are captured before candidate code.
 * The verifier itself is an in-memory child module: by the time it initializes, Bun has consumed the
 * supervisor pipe, so candidate code cannot reread the runner or its unpredictable suffix. */
function attestedVerifierRunner(source: string, root: string, sourcePath: string): { marker: string; source: string } {
  const marker = `__NEKO_BENCH_ATTEST_${randomUUID().replaceAll("-", "")}__`;
  const suffix = `\n${marker}\n`;
  const privateId = marker.slice("__NEKO_BENCH_ATTEST_".length, -2);
  const writeName = `__nekoWrite_${privateId}`;
  const exitName = `__nekoExit_${privateId}`;
  const safeAssertUrl = dataModuleUrl(SAFE_ASSERT_MODULE_SOURCE);
  const verifierUrl = dataModuleUrl(prepareVerifierModuleSource(source, root, sourcePath, safeAssertUrl));
  return {
    marker,
    source: [
      'import { writeSync as importedWriteSync } from "node:fs";',
      `const ${writeName} = importedWriteSync;`,
      `const ${exitName} = process.exit.bind(process);`,
      `await import(${JSON.stringify(safeAssertUrl)});`,
      `await import(${JSON.stringify(verifierUrl)});`,
      `${writeName}(1, ${JSON.stringify(suffix)});`,
      `${exitName}(0);`,
      "",
    ].join("\n"),
  };
}

function attestedHiddenVerifierRunner(
  program: HiddenBenchProgram,
  root: string,
  sourcePath: string,
): { marker: string; source: string } {
  if (Buffer.byteLength(program.body) > 1 * 1024 * 1024 || program.modules.length > 32) {
    throw new BenchInfrastructureError("hidden benchmark program exceeded its size limit");
  }
  const marker = `__NEKO_BENCH_ATTEST_${randomUUID().replaceAll("-", "")}__`;
  const suffix = `\n${marker}\n`;
  const privateId = marker.slice("__NEKO_BENCH_ATTEST_".length, -2);
  const oracleSourceId = randomUUID().replaceAll("-", "");
  const writeName = `__nekoWrite_${privateId}`;
  const exitName = `__nekoExit_${privateId}`;
  const asyncFunctionName = `__nekoAsyncFunction_${privateId}`;
  const oracleName = `__nekoOracle_${privateId}`;
  const assertName = `__nekoAssert_${privateId}`;
  const safeAssertUrl = dataModuleUrl(SAFE_ASSERT_MODULE_SOURCE);
  const parameterNames = ["assert"];
  const argumentExpressions = [assertName];
  const moduleLines: string[] = [];
  const seenBindings = new Set(parameterNames);
  program.modules.forEach((module, moduleIndex) => {
    if (!module.specifier.startsWith("./") && !module.specifier.startsWith("../")) {
      throw new BenchInfrastructureError("hidden benchmark program contains a non-relative module");
    }
    const moduleName = `__nekoModule_${privateId}_${moduleIndex}`;
    const moduleUrl = verifierModuleSpecifier(root, sourcePath, module.specifier);
    moduleLines.push(`const ${moduleName} = await import(${JSON.stringify(moduleUrl)});`);
    for (const binding of module.bindings) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding) || seenBindings.has(binding)) {
        throw new BenchInfrastructureError("hidden benchmark program contains an invalid or duplicate binding");
      }
      seenBindings.add(binding);
      parameterNames.push(binding);
      argumentExpressions.push(`${moduleName}[${JSON.stringify(binding)}]`);
    }
  });
  // The diagnostic source label is candidate-visible through Error stacks. It must therefore be
  // independent from the completion marker: knowing a stack label must not reveal the attestation
  // suffix that only this supervisor may emit after every hidden assertion returns.
  const body = `"use strict";\n${program.body}\n//# sourceURL=neko-bench-oracle-${oracleSourceId}.mjs\n`;
  return {
    marker,
    source: [
      'import { writeSync as importedWriteSync } from "node:fs";',
      `const ${writeName} = importedWriteSync;`,
      `const ${exitName} = process.exit.bind(process);`,
      `const ${asyncFunctionName} = (async () => {}).constructor;`,
      `const ${assertName} = (await import(${JSON.stringify(safeAssertUrl)})).default;`,
      `const ${oracleName} = new ${asyncFunctionName}(${[
        ...parameterNames.map((name) => JSON.stringify(name)),
        JSON.stringify(body),
      ].join(", ")});`,
      ...moduleLines,
      `await ${oracleName}(${argumentExpressions.join(", ")});`,
      `${writeName}(1, ${JSON.stringify(suffix)});`,
      `${exitName}(0);`,
      "",
    ].join("\n"),
  };
}

async function runVerifierSource(
  root: string,
  source: string,
  sourcePath: string,
  deps: { sandboxReady?: () => boolean; runner?: { marker: string; source: string } } = {},
): Promise<{ ok: boolean; out: string }> {
  // The verifier executes model-authored code. It must therefore cross the same read-only OS-sandbox
  // boundary as an exact-file validator, never a host `bun` child with inherited credentials.
  if (!(deps.sandboxReady ?? sandboxActive)()) {
    throw new BenchInfrastructureError("benchmark verifier infrastructure unavailable: a live OS sandbox is required");
  }
  // Resolve every security-sensitive launcher before creating trial material, so a missing bridge
  // cannot strand a readable `.neko-bench-oracle-*` directory in the model workspace.
  const bunCommand = oracleBunCommand(root);
  const oracleDir = mkdtempSync(join(root, ".neko-bench-oracle-"));
  const configFile = join(oracleDir, "bunfig.toml");
  const configRel = relative(root, configFile).replaceAll("\\", "/");
  const bunBase = `${bunCommand} --no-env-file --no-install ${quoteBashArg(`--config=./${configRel}`)}`;
  const execPrefix = process.platform === "darwin" ? "exec " : "";
  const preflightCommand = `${execPrefix}${bunBase} --eval ${quoteBashArg("process.exit(0)")}`;
  const command = `${execPrefix}${bunBase} -`;
  const runner = deps.runner ?? attestedVerifierRunner(source, root, sourcePath);
  const suffix = `\n${runner.marker}\n`;
  let sandbox: ReturnType<typeof wrapBash> | undefined;
  try {
    writeFileSync(configFile, "# Neko benchmark verifier: intentionally empty.\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Keep toolchain/setup failure out of efficacy. This first launch contains no model-authored code;
    // after it succeeds, every timeout, signal, bounded-output overflow, or non-zero target status is a
    // model/task failure. The completion token exists only in the already-consumed stdin runner.
    let preflight: ReturnType<typeof wrapBash> | undefined;
    try {
      preflight = wrapBash(preflightCommand, root, {
        enabled: true,
        allowNetwork: false,
        allowHostDaemon: false,
        readOnlyWorkspace: true,
        // This launch contains only the trusted runtime probe. Bun may need normal process
        // facilities during startup on macOS; candidate code is confined by the target launch.
        denyChildProcesses: false,
        denyReadFiles: benchmarkHostCodeFiles(root),
      });
      const checked = await runBoundedSandboxTarget(
        preflight, root, oracleChildEnv(preflight.env), 60_000, 1 * 1024 * 1024,
      );
      if (checked.error || checked.status !== 0 || checked.signal || checked.timedOut
        || checked.outputExceeded || !checked.treeCleanupConfirmed) {
        // SAFETY: contract of the NodeJS.ErrnoException | undefined type is established by the surrounding validation/boundary.
        const code = (checked.error as NodeJS.ErrnoException | undefined)?.code ?? "none";
        throw new BenchInfrastructureError(
          `benchmark verifier infrastructure unavailable: toolchain preflight failed (status=${checked.status ?? "null"}, signal=${checked.signal ?? "none"}, code=${code}, timeout=${checked.timedOut}, output_cap=${checked.outputExceeded}, tree_cleanup=${checked.treeCleanupConfirmed})`,
        );
      }
    } finally {
      preflight?.cleanup?.();
    }
    const srtInput = detectSandbox() === "srt";
    sandbox = wrapBash(command, root, {
      enabled: true,
      allowNetwork: false,
      allowHostDaemon: false,
      readOnlyWorkspace: true,
      denyChildProcesses: process.platform === "darwin",
      denyReadFiles: benchmarkHostCodeFiles(root),
      stdinSource: srtInput ? runner.source : undefined,
    });
    const launched = await runBoundedBenchCandidate(
      sandbox, root, oracleChildEnv(sandbox.env), 30_000, 8 * 1024 * 1024,
      terminateProcessTree, srtInput ? undefined : runner.source,
    );
    // SAFETY: contract of the NodeJS.ErrnoException | undefined type is established by the surrounding validation/boundary.
    const code = (launched.error as NodeJS.ErrnoException | undefined)?.code;
    if (launched.error) {
      throw new BenchInfrastructureError(
        `benchmark verifier infrastructure unavailable: target process could not start (code=${code ?? "unknown"})`,
      );
    }
    const stdout = String(launched.stdout ?? "");
    const stderr = String(launched.stderr ?? "");
    const attested = stdout.endsWith(suffix);
    const visibleStdout = attested ? stdout.slice(0, -suffix.length) : stdout;
    return {
      ok: attested && !launched.timedOut && !launched.outputExceeded && launched.status === 0 && !launched.signal,
      out: visibleStdout || stderr,
    };
  } catch (error) {
    if (error instanceof BenchInfrastructureError) throw error;
    throw new BenchInfrastructureError(`benchmark verifier infrastructure unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    sandbox?.cleanup?.();
    rmSync(oracleDir, { recursive: true, force: true });
  }
}

async function runJs(
  dir: string,
  file: string,
  deps: { sandboxReady?: () => boolean } = {},
): Promise<{ ok: boolean; out: string }> {
  const root = realpathSync(resolve(dir));
  const lexicalTarget = resolve(root, file);
  let target = "";
  let targetStat: ReturnType<typeof lstatSync> | undefined;
  try {
    targetStat = lstatSync(lexicalTarget);
    target = realpathSync(lexicalTarget);
  } catch { /* rejected below */ }
  const rel = target ? relative(root, target) : "";
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)
    || !targetStat?.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
    return { ok: false, out: "benchmark verifier target escaped or was missing" };
  }
  const bytes = readFileSync(target);
  if (bytes.byteLength > 1 * 1024 * 1024) return { ok: false, out: "benchmark verifier target exceeded its size limit" };
  return await runVerifierSource(root, bytes.toString("utf8"), target, deps);
}

/** Internal test seam for the model-code verifier boundary. */
export const __runBenchJsForTest = runJs;

function executableJavaScript(source: string): string {
  let index = 0;
  let masked = "";
  const blank = (character: string): string => character === "\n" || character === "\r" ? character : " ";

  const skipQuoted = (quote: "'" | '"'): void => {
    masked += " ";
    index++;
    while (index < source.length) {
      const character = source[index];
      masked += blank(character);
      index++;
      if (character === "\\" && index < source.length) {
        masked += blank(source[index]);
        index++;
      } else if (character === quote) {
        return;
      }
    }
  };

  const readCode = (templateExpression = false): void => {
    let braces = 0;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];
      if (templateExpression && character === "}" && braces === 0) {
        masked += character;
        index++;
        return;
      }
      if (character === "/" && next === "/") {
        masked += "  ";
        index += 2;
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
          masked += " ";
          index++;
        }
        continue;
      }
      if (character === "/" && next === "*") {
        masked += "  ";
        index += 2;
        while (index < source.length) {
          const current = source[index];
          if (current === "*" && source[index + 1] === "/") {
            masked += "  ";
            index += 2;
            break;
          }
          masked += blank(current);
          index++;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        skipQuoted(character);
        continue;
      }
      if (character === "`") {
        masked += " ";
        index++;
        while (index < source.length) {
          const current = source[index];
          const following = source[index + 1];
          if (current === "\\") {
            masked += " ";
            index++;
            if (index < source.length) {
              masked += blank(source[index]);
              index++;
            }
          } else if (current === "`") {
            masked += " ";
            index++;
            break;
          } else if (current === "$" && following === "{") {
            masked += "${";
            index += 2;
            readCode(true);
          } else {
            masked += blank(current);
            index++;
          }
        }
        continue;
      }
      masked += character;
      index++;
      if (templateExpression) {
        if (character === "{") braces++;
        else if (character === "}") braces--;
      }
    }
  };

  readCode();
  return masked;
}

function benchmarkModuleSourceIsPure(source: string): boolean {
  // Built-in benchmark implementations have no reason to inspect their host runtime. Keeping this contract
  // explicit prevents an imported module from terminating the verifier early or reading the hidden
  // assertion file. This is a benchmark-integrity guard, not a claim of cryptographic secrecy.
  let imports: ReturnType<Bun.Transpiler["scanImports"]>;
  try {
    imports = new Bun.Transpiler({ loader: "js" }).scanImports(source);
  } catch {
    return false;
  }
  for (const imported of imports) {
    if (imported.kind !== "import-statement") return false;
    if (!imported.path.startsWith("./") && !imported.path.startsWith("../")) return false;
  }
  const executable = executableJavaScript(source);
  if (/\b(?:process|Bun|Deno|globalThis|global|eval|Function|require|Worker|WebAssembly)\b/.test(executable)) return false;
  if (/\bimport\s*\(/.test(executable) || /\bimport\s*\.\s*meta\b/.test(executable)) return false;
  return true;
}

/** Internal test seam for the benchmark implementation-module purity scanner. */
export const __benchmarkModuleSourceIsPureForTest = benchmarkModuleSourceIsPure;

function benchmarkImportedModulesArePure(dir: string, runner: string): boolean {
  try {
    const root = realpathSync(resolve(dir));
    const excluded = relative(root, resolve(root, runner)).split(sep).join("/");
    let files = 0;
    let bytes = 0;
    const pending = [root];
    while (pending.length) {
      const current = pending.pop()!;
      const entries = readdirSync(current, { withFileTypes: true });
      if (entries.length > 256) return false;
      for (const entry of entries) {
        const lexical = join(current, entry.name);
        const stat = lstatSync(lexical);
        if (stat.isSymbolicLink()) return false;
        const canonical = realpathSync(lexical);
        if (!pathInside(root, canonical)) return false;
        if (stat.isDirectory()) {
          pending.push(canonical);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) return false;
        const rel = relative(root, canonical).split(sep).join("/");
        if (rel === excluded || !/\.(?:[cm]?js|tsx?)$/i.test(rel)) continue;
        const source = readFileSync(canonical, "utf8");
        files++;
        bytes += Buffer.byteLength(source);
        if (files > 256 || bytes > 8 * 1024 * 1024 || !benchmarkModuleSourceIsPure(source)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function runJsPasses(dir: string, file: string, accept: (out: string) => boolean = (out) => out.includes("ok")): Promise<boolean> {
  if (!benchmarkImportedModulesArePure(dir, file)) return false;
  const result = await runJs(dir, file);
  return result.ok && accept(result.out);
}

/** Internal test seam for the generic public benchmark runner. */
export const __runBenchJsPassesForTest = runJsPasses;

async function runHiddenJsPasses(dir: string, program: HiddenBenchProgram, sourceFiles: readonly string[]): Promise<boolean> {
  const root = realpathSync(resolve(dir));
  const hiddenDir = realpathSync(mkdtempSync(join(tmpdir(), "neko-bench-hidden-")));
  try {
    let totalBytes = 0;
    const seen = new Set<string>();
    for (const name of sourceFiles) {
      if (seen.has(name)) throw new BenchInfrastructureError(`duplicate hidden-oracle source: ${name}`);
      seen.add(name);
      const lexical = confinedTaskPath(root, name);
      const before = lstatSync(lexical);
      const canonical = realpathSync(lexical);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !pathInside(root, canonical)) {
        throw new BenchInfrastructureError(`hidden-oracle source is not a canonical single-link file: ${name}`);
      }
      const bytes = readFileSync(canonical);
      const after = lstatSync(lexical);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || realpathSync(lexical) !== canonical
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new BenchInfrastructureError(`hidden-oracle source changed while it was copied: ${name}`);
      }
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > 1 * 1024 * 1024 || totalBytes > 8 * 1024 * 1024) {
        throw new BenchInfrastructureError("hidden-oracle source snapshot exceeded its size limit");
      }
      if (!benchmarkModuleSourceIsPure(bytes.toString("utf8"))) return false;
      const target = confinedTaskPath(hiddenDir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    // Candidate sources are copied by value into a fresh read-only workspace. Hidden assertions are
    // compiled as an opaque-sourceURL AsyncFunction from the already-consumed stdin supervisor. They
    // are never a data-URL or file path in a candidate-visible stack; only the harness can emit the
    // unpredictable completion suffix after every assertion has returned.
    const sourcePath = join(hiddenDir, "oracle.mjs");
    const runner = attestedHiddenVerifierRunner(program, hiddenDir, sourcePath);
    const result = await runVerifierSource(
      hiddenDir, "", sourcePath, { runner },
    );
    return result.ok && result.out.includes("ok");
  } finally {
    rmSync(hiddenDir, { recursive: true, force: true });
  }
}

/** Internal test seam for stack/process non-disclosure at the hidden benchmark boundary. */
export const __runHiddenBenchJsForTest = runHiddenJsPasses;

export const FRONTIER_TASKS: BenchTask[] = createFrontierTasks(runHiddenJsPasses);

function validFizzBuzzOutput(out: string): boolean {
  const got = lines(out);
  const expected = Array.from({ length: 100 }, (_, index) => {
    const n = index + 1;
    return n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Fizz" : n % 5 === 0 ? "Buzz" : String(n);
  });
  return got.length === expected.length && expected.every((value, index) => got[index] === value);
}

/** Internal pure test seam for the seeded deterministic oracle. */
export const __validFizzBuzzOutputForTest = validFizzBuzzOutput;

const TASKS: BenchTask[] = [
  {
    id: "fizzbuzz",
    files: {},
    prompt: "Create fizzbuzz.mjs (an ES module). When run it prints the numbers 1 to 100, each on its own line, except 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, and 'FizzBuzz' for multiples of 15.",
    verify: async (d) => {
      const r = await runJs(d, "fizzbuzz.mjs");
      return r.ok && validFizzBuzzOutput(r.out);
    },
  },
  {
    id: "bugfix",
    files: {
      "calc.mjs": "export function add(a, b) { return a - b; }\n",
      "test.mjs": "import assert from 'node:assert';\nimport { add } from './calc.mjs';\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nconsole.log('ok');\n",
    },
    prompt: "Running `bun test.mjs` fails an assertion. Fix the bug in calc.mjs so it passes. Do not modify test.mjs.",
    verify: async (d) => await runJsPasses(d, "test.mjs") && (read(d, "test.mjs") ?? "").includes("strictEqual(add(2, 3), 5)"),
    constraints: keepFiles("test.mjs"),
  },
  {
    id: "roman",
    files: {
      "roman.mjs": "export function toRoman(n) {\n  // TODO\n}\n",
      "rt.mjs": "import assert from 'node:assert';\nimport { toRoman } from './roman.mjs';\nfor (const [n, s] of [[4, 'IV'], [9, 'IX'], [58, 'LVIII'], [1994, 'MCMXCIV']]) assert.strictEqual(toRoman(n), s);\nconsole.log('ok');\n",
    },
    prompt: "Implement toRoman in roman.mjs so that `bun rt.mjs` passes all assertions. Do not modify rt.mjs.",
    verify: (d) => runJsPasses(d, "rt.mjs"),
    constraints: keepFiles("rt.mjs"),
  },
  {
    id: "json-edit",
    files: { "pkg.json": '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n' },
    prompt: 'Edit pkg.json to add a top-level "license" field set to "MIT". Keep the existing "name" and "version" fields and keep it valid JSON.',
    verify: (d) => { try { const j = JSON.parse(read(d, "pkg.json") ?? ""); return j.name === "demo" && j.version === "1.0.0" && j.license === "MIT"; } catch { return false; } },
  },
  {
    // Needs a TOOL: the value is 50 rounds of modular squaring — impossible to compute by hand, so the raw
    // model must guess (fails) while the harness RUNS gen.mjs and copies the exact number (passes).
    id: "run-to-know",
    files: { "gen.mjs": "let x = 7n;\nfor (let i = 0; i < 50; i++) x = (x * x + 9n) % 1000000007n;\nconsole.log(x.toString());\n" },
    prompt: "Run `bun gen.mjs` — it prints one number. Create answer.txt whose entire content is that exact number.",
    verify: async (d) => { const g = await runJs(d, "gen.mjs"); const want = (g.out ?? "").trim(); const got = (read(d, "answer.txt") ?? "").trim(); return g.ok && want.length > 0 && got === want; },
    constraints: keepFiles("gen.mjs"),
  },
  // ---- harder tier (cross-file, state, algorithms, careful reading) ----
  {
    id: "two-file-bug",
    files: {
      "geometry.mjs": "export function area(w, h) {\n  return w + h;\n}\n",
      "app.mjs": "import { area } from './geometry.mjs';\nconsole.log(area(6, 7));\n",
    },
    prompt: "`bun app.mjs` should print the AREA of a 6x7 rectangle (42) but prints the wrong number. Fix the bug in geometry.mjs ONLY — do not edit app.mjs.",
    verify: async (d) => await runJsPasses(d, "app.mjs", (out) => out.trim() === "42") && (read(d, "app.mjs") ?? "").includes("area(6, 7)"),
    constraints: keepFiles("app.mjs"),
  },
  {
    id: "stateful-bug",
    files: {
      "counter.mjs": "export function makeCounter() {\n  let n = 0;\n  return { inc() { n + 1; return n; } };\n}\n",
      "ct.mjs": "import assert from 'node:assert';\nimport { makeCounter } from './counter.mjs';\nconst a = makeCounter();\nassert.strictEqual(a.inc(), 1);\nassert.strictEqual(a.inc(), 2);\nassert.strictEqual(a.inc(), 3);\nconst b = makeCounter();\nassert.strictEqual(b.inc(), 1);\nconsole.log('ok');\n",
    },
    prompt: "Fix the bug in makeCounter (counter.mjs) so `bun ct.mjs` passes — inc() must return 1, then 2, then 3, and a fresh counter is independent. Do not modify ct.mjs.",
    verify: async (d) => await runJsPasses(d, "ct.mjs") && (read(d, "ct.mjs") ?? "").includes("a.inc(), 3"),
    optimalSteps: 3, // read counter.mjs + edit + run ct.mjs
    constraints: [{ id: "keep-ct.mjs", keep: "ct.mjs" }], // prompt: do not modify ct.mjs
  },
  {
    id: "unique-sorted",
    files: { "uq.mjs": "import assert from 'node:assert';\nimport { uniqueSorted } from './unique.mjs';\nassert.deepStrictEqual(uniqueSorted([3,1,2,3,1]), [1,2,3]);\nassert.deepStrictEqual(uniqueSorted([]), []);\nassert.deepStrictEqual(uniqueSorted([-1,-1,0,5,5]), [-1,0,5]);\nconsole.log('ok');\n" },
    prompt: "Create unique.mjs exporting uniqueSorted(arr): return the array's DISTINCT numbers in ascending order. Make `bun uq.mjs` pass (do not modify uq.mjs).",
    verify: (d) => runJsPasses(d, "uq.mjs"),
    optimalSteps: 2, // write unique.mjs + run uq.mjs
    constraints: [{ id: "keep-uq.mjs", keep: "uq.mjs" }], // prompt: do not modify uq.mjs
  },
  {
    id: "balanced-parens",
    files: { "bp.mjs": "import assert from 'node:assert';\nimport { isBalanced } from './paren.mjs';\nassert.strictEqual(isBalanced('([]{})'), true);\nassert.strictEqual(isBalanced('([)]'), false);\nassert.strictEqual(isBalanced('((('), false);\nassert.strictEqual(isBalanced(''), true);\nconsole.log('ok');\n" },
    prompt: "Create paren.mjs exporting isBalanced(s): true iff the brackets ()[]{} in s are correctly matched and nested. Make `bun bp.mjs` pass.",
    verify: (d) => runJsPasses(d, "bp.mjs"),
    constraints: keepFiles("bp.mjs"),
  },
  {
    id: "csv-top",
    files: { "data.csv": "name,score\nAlice,80\nBob,95\nCara,70\n" },
    prompt: "Read data.csv (a header line, then name,score rows). Write top.txt whose ENTIRE content is the NAME with the highest score.",
    verify: (d) => (read(d, "top.txt") ?? "").trim() === "Bob",
    constraints: keepFiles("data.csv"),
  },
  {
    id: "careful-read",
    files: {},
    prompt: "Create out.txt whose content is the word 'banana' REVERSED and then UPPERCASED (the letters of 'banana' in reverse order, all capitals).",
    verify: (d) => (read(d, "out.txt") ?? "").trim() === "ANANAB",
  },
  // ---- tricky tier (subtle bugs + careful multi-step; richer signal even when the easy tier saturates) ----
  {
    id: "off-by-one",
    files: {
      "range.mjs": "export function sumTo(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) s += i;\n  return s;\n}\n",
      "rt.mjs": "import assert from 'node:assert';\nimport { sumTo } from './range.mjs';\nassert.strictEqual(sumTo(5), 15);\nassert.strictEqual(sumTo(1), 1);\nassert.strictEqual(sumTo(0), 0);\nconsole.log('ok');\n",
    },
    prompt: "Fix the off-by-one bug in sumTo (range.mjs) so `bun rt.mjs` passes — sumTo(n) must return 1+2+...+n (sumTo(5)=15). Do not modify rt.mjs.",
    verify: async (d) => await runJsPasses(d, "rt.mjs") && (read(d, "rt.mjs") ?? "").includes("sumTo(5), 15"),
    constraints: keepFiles("rt.mjs"),
  },
  {
    id: "closure-trap",
    files: {
      "makers.mjs": "export function makeGetters() {\n  const fns = [];\n  for (var i = 1; i <= 3; i++) { fns.push(() => i); }\n  return fns;\n}\n",
      "mt.mjs": "import assert from 'node:assert';\nimport { makeGetters } from './makers.mjs';\nconst [a, b, c] = makeGetters();\nassert.strictEqual(a(), 1);\nassert.strictEqual(b(), 2);\nassert.strictEqual(c(), 3);\nconsole.log('ok');\n",
    },
    prompt: "Fix makeGetters in makers.mjs so `bun mt.mjs` passes — the three returned functions must return 1, 2, 3 respectively (a classic loop-closure bug). Do not modify mt.mjs.",
    verify: async (d) => await runJsPasses(d, "mt.mjs") && (read(d, "mt.mjs") ?? "").includes("c(), 3"),
    constraints: keepFiles("mt.mjs"),
  },
  {
    id: "flatten",
    files: { "ft.mjs": "import assert from 'node:assert';\nimport { flatten } from './flat.mjs';\nassert.deepStrictEqual(flatten([1,[2,[3,[4]],5]]), [1,2,3,4,5]);\nassert.deepStrictEqual(flatten([]), []);\nassert.deepStrictEqual(flatten([[],[1],[[2]]]), [1,2]);\nconsole.log('ok');\n" },
    prompt: "Create flat.mjs exporting flatten(arr): fully flatten an arbitrarily-nested array of numbers into a flat array. Make `bun ft.mjs` pass.",
    verify: (d) => runJsPasses(d, "ft.mjs"),
    constraints: keepFiles("ft.mjs"),
  },
  {
    id: "strict-format",
    files: { "nums.txt": "3\n7\n10\n" },
    prompt: "Read nums.txt (one integer per line). Write report.txt whose content is EXACTLY 'Total: 20' (the sum of the numbers, that exact format, no extra text).",
    verify: (d) => (read(d, "report.txt") ?? "").trim() === "Total: 20",
    constraints: keepFiles("nums.txt"),
  },
  {
    id: "pipeline",
    files: { "scores.csv": "name,score\nAmy,55\nBob,90\nCy,75\nDee,40\n" },
    prompt: "Read scores.csv (a header, then name,score rows). Write passed.txt listing the names with score >= 70, ONE per line, in DESCENDING score order.",
    verify: (d) => (read(d, "passed.txt") ?? "").replace(/\r/g, "").trim().split("\n").map((s) => s.trim()).filter(Boolean).join(",") === "Bob,Cy",
    constraints: keepFiles("scores.csv"),
  },
];

// ---- HARD tier (`neko bench hard`): multi-file, real algorithms, verification-biting. This is a
// higher-bar regression/cost tier than `easy`, but it is not a frontier discriminator: the recorded
// glm-5.2 calibration saturated at 12/12. Deterministic verifiers only; do not describe this score as
// evidence that a harness change improved top-end capability.
export const HARD_TASKS: BenchTask[] = [
  {
    // Root-cause tracing across a data-flow chain: the failing OUTPUT is in summary.mjs, but the bug
    // (age kept as a string) is one layer up in parse.mjs. The fix MUST land in parse.mjs - the
    // verifier asserts the two downstream files are byte-unchanged, so a band-aid in summary won't pass.
    id: "layered-bug",
    files: {
      "parse.mjs": "export function parse(csv) {\n  return csv.trim().split('\\n').map((line) => {\n    const [name, age] = line.split(',');\n    return { name, age };\n  });\n}\n",
      "summary.mjs": "import { parse } from './parse.mjs';\nexport function summary(csv) {\n  const rows = parse(csv);\n  const total = rows.reduce((s, r) => s + r.age, 0);\n  return `total age: ${total}`;\n}\n",
      "st.mjs": "import assert from 'node:assert';\nimport { summary } from './summary.mjs';\nassert.strictEqual(summary('Alice,30\\nBob,25'), 'total age: 55');\nassert.strictEqual(summary('X,10'), 'total age: 10');\nconsole.log('ok');\n",
    },
    prompt: "`bun st.mjs` fails: the totals concatenate instead of adding. Trace the data flow and fix the ROOT CAUSE in parse.mjs (age must be a number). Do NOT modify summary.mjs or st.mjs.",
    verify: async (d) => await runJsPasses(d, "st.mjs")
      && (read(d, "summary.mjs") ?? "").includes("s + r.age") // downstream untouched
      && (read(d, "st.mjs") ?? "").includes("total age: 55"),
    constraints: keepFiles("summary.mjs", "st.mjs"),
  },
  {
    // Three INDEPENDENT bugs in one util file, each caught by a different assertion -> forces a
    // read-fix-rerun loop (the verification-biting pattern); a single fix leaves the run failing.
    id: "multi-bug",
    files: {
      "util.mjs": "export function clamp(x, lo, hi) { return Math.max(lo, x); }\n" +
        "export function last(arr) { return arr[arr.length]; }\n" +
        "export function repeat(s, n) { let r = ''; for (let i = 0; i < n; i++) r += r; return r; }\n",
      "ut.mjs": "import assert from 'node:assert';\nimport { clamp, last, repeat } from './util.mjs';\n" +
        "assert.strictEqual(clamp(5, 0, 3), 3);\nassert.strictEqual(clamp(-1, 0, 3), 0);\nassert.strictEqual(clamp(2, 0, 3), 2);\n" +
        "assert.strictEqual(last([1, 2, 3]), 3);\nassert.strictEqual(last(['a']), 'a');\n" +
        "assert.strictEqual(repeat('ab', 3), 'ababab');\nassert.strictEqual(repeat('x', 0), '');\nconsole.log('ok');\n",
    },
    prompt: "`bun ut.mjs` fails. There are THREE independent bugs in util.mjs (clamp ignores the upper bound, last is off by one, repeat doubles the wrong thing). Fix all three so every assertion passes. Do NOT modify ut.mjs.",
    verify: async (d) => await runJsPasses(d, "ut.mjs") && (read(d, "ut.mjs") ?? "").includes("repeat('ab', 3)"),
    optimalSteps: 4, // read util + fix 3 bugs (one edit pass) + run ut
    constraints: [{ id: "keep-ut.mjs", keep: "ut.mjs" }], // prompt: do NOT modify ut.mjs
  },
  {
    // Add a feature WITHOUT breaking existing behavior (regression guard): the extended test re-checks
    // push/pop AND the new peek/size. Easy to break the private-field encapsulation while extending.
    id: "feature-no-regression",
    files: {
      "stack.mjs": "export class Stack {\n  #items = [];\n  push(x) { this.#items.push(x); }\n  pop() { return this.#items.pop(); }\n}\n",
      "sk.mjs": "import assert from 'node:assert';\nimport { Stack } from './stack.mjs';\nconst s = new Stack();\ns.push(1); s.push(2);\n" +
        "assert.strictEqual(s.size(), 2);\nassert.strictEqual(s.peek(), 2);\nassert.strictEqual(s.size(), 2);\n" + // peek does not remove
        "assert.strictEqual(s.pop(), 2);\nassert.strictEqual(s.size(), 1);\nassert.strictEqual(s.peek(), 1);\nconsole.log('ok');\n",
    },
    prompt: "Extend the Stack class in stack.mjs: add peek() (return the top item WITHOUT removing it) and size() (return the number of items). Keep push() and pop() working. Make `bun sk.mjs` pass; do NOT modify sk.mjs.",
    verify: (d) => runJsPasses(d, "sk.mjs"),
    optimalSteps: 3, // read stack.mjs + extend + run sk.mjs
    constraints: [{ id: "keep-sk.mjs", keep: "sk.mjs" }], // prompt: do NOT modify sk.mjs
  },
  {
    // A real algorithm: topological sort with cycle detection. Naive attempts miss the diamond
    // ordering or don't detect the cycle.
    id: "toposort",
    files: {
      "dt.mjs": "import assert from 'node:assert';\nimport { resolveOrder } from './deps.mjs';\n" +
        "const o = resolveOrder({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });\n" +
        "assert.ok(o.indexOf('d') < o.indexOf('b'), 'd before b');\nassert.ok(o.indexOf('d') < o.indexOf('c'), 'd before c');\n" +
        "assert.ok(o.indexOf('b') < o.indexOf('a'), 'b before a');\nassert.ok(o.indexOf('c') < o.indexOf('a'), 'c before a');\n" +
        "assert.strictEqual(o.length, 4);\n" +
        "let threw = false; try { resolveOrder({ x: ['y'], y: ['x'] }); } catch { threw = true; }\nassert.ok(threw, 'must throw on a cycle');\nconsole.log('ok');\n",
    },
    prompt: "Create deps.mjs exporting resolveOrder(graph): graph maps each node to an array of nodes it DEPENDS ON. Return an array of all nodes where every node appears AFTER its dependencies (a topological order). THROW an Error if the graph has a cycle. Make `bun dt.mjs` pass.",
    verify: (d) => runJsPasses(d, "dt.mjs"),
    constraints: keepFiles("dt.mjs"),
  },
  {
    // Recursive-descent / precedence parsing: naive left-to-right evaluation fails 2+3*4 and nesting.
    id: "expr-eval",
    files: {
      "et.mjs": "import assert from 'node:assert';\nimport { evaluate } from './expr.mjs';\n" +
        "assert.strictEqual(evaluate('2+3*4'), 14);\nassert.strictEqual(evaluate('(2+3)*4'), 20);\n" +
        "assert.strictEqual(evaluate('10-2-3'), 5);\nassert.strictEqual(evaluate('2*(3+4)-5'), 9);\n" +
        "assert.strictEqual(evaluate('100/5/2'), 10);\nassert.strictEqual(evaluate('((1+2)*(3+4))'), 21);\nconsole.log('ok');\n",
    },
    prompt: "Create expr.mjs exporting evaluate(expr): evaluate an integer arithmetic expression string with + - * / (usual precedence, LEFT associativity) and parentheses. E.g. evaluate('2+3*4') === 14, evaluate('(2+3)*4') === 20, evaluate('10-2-3') === 5. Make `bun et.mjs` pass.",
    verify: (d) => runJsPasses(d, "et.mjs"),
    constraints: keepFiles("et.mjs"),
  },
  {
    // Floating-point correctness in a shared helper used across files: the bug (no rounding) only
    // shows with prices that don't represent exactly in binary. The fix belongs in money.mjs.
    id: "float-money",
    files: {
      "money.mjs": "export function cents(dollars) {\n  return dollars * 100;\n}\n",
      "cart.mjs": "import { cents } from './money.mjs';\nexport function cartTotal(items) {\n  return items.reduce((s, i) => s + cents(i.price), 0);\n}\n",
      "ct.mjs": "import assert from 'node:assert';\nimport { cartTotal } from './cart.mjs';\n" +
        "assert.strictEqual(cartTotal([{ price: 1.99 }]), 199);\n" +
        "assert.strictEqual(cartTotal([{ price: 0.1 }, { price: 0.2 }]), 30);\nconsole.log('ok');\n",
    },
    prompt: "`bun ct.mjs` fails by tiny fractions (floating-point): cents(1.99) is 198.99999... not 199. Fix cents() in money.mjs to return an exact integer number of cents (round correctly). Do NOT modify cart.mjs or ct.mjs.",
    verify: async (d) => await runJsPasses(d, "ct.mjs")
      && (read(d, "cart.mjs") ?? "").includes("s + cents(i.price)")
      && (read(d, "ct.mjs") ?? "").includes("price: 1.99"),
    constraints: keepFiles("cart.mjs", "ct.mjs"),
  },
];

export interface BenchResult {
  id: string;
  passes: number;
  modelFailures: number;
  infraErrors: number;
  trials: number;
  tokens: number;
  inTok: number;
  cachedTok: number;
  outTok: number;
  calls: number;
  ms: number;
}
export interface BenchReport {
  model: string;
  effort: string;
  fingerprint: string;
  maxSteps: number;
  trials: number;
  results: BenchResult[];
  passed: number;
  modelFailures: number;
  infraErrors: number;
  comparisonValid: boolean;
  total: number;
  tokens: number;
  inTok: number;
  cachedTok: number;
  outTok: number;
  calls: number;
  seconds: number;
}
export type BenchProviderFactory = () => Provider;

function confinedTaskPath(root: string, name: string): string {
  if (!name || name.includes("\0") || isAbsolute(name)) {
    throw new BenchInfrastructureError(`invalid benchmark task file path: ${JSON.stringify(name)}`);
  }
  const base = resolve(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BenchInfrastructureError(`benchmark task file escaped its trial root: ${JSON.stringify(name)}`);
  }
  return target;
}

function materializeTaskFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = confinedTaskPath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function taskConstraints(task: BenchTask, dir: string): TrialRecord["constraints"] {
  return task.constraints
    ? task.constraints.map((constraint) => {
        if (!constraint.keep) {
          return { id: constraint.id, ok: constraint.check ? constraint.check(dir) : true };
        }
        if (!Object.prototype.hasOwnProperty.call(task.files, constraint.keep)) {
          throw new BenchInfrastructureError(`constraint ${constraint.id} references an unseeded file: ${constraint.keep}`);
        }
        const root = realpathSync(resolve(dir));
        const lexical = confinedTaskPath(root, constraint.keep);
        try {
          const stat = lstatSync(lexical);
          const canonical = realpathSync(lexical);
          const ok = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
            && pathInside(root, canonical)
            && readFileSync(canonical, "utf8") === task.files[constraint.keep];
          return { id: constraint.id, ok };
        } catch {
          return { id: constraint.id, ok: false };
        }
      })
    : [];
}

async function verifyTaskEndState(task: BenchTask, dir: string): Promise<{
  pass: boolean;
  constraints: TrialRecord["constraints"];
}> {
  const constraints = taskConstraints(task, dir);
  // Never execute a protected oracle/input after the model changed its bytes or identity. This both
  // makes constraints hard acceptance invariants and avoids needlessly running attacker-authored test
  // code merely to discover that the trial was already invalid.
  if (!constraints.every((constraint) => constraint.ok)) return { pass: false, constraints };
  return { pass: await task.verify(dir), constraints };
}

function freshProvider(factory: BenchProviderFactory, seen: Set<Provider>): Provider {
  const provider = factory();
  if (seen.has(provider)) {
    throw new Error("providerFactory must return a fresh Provider for every task trial");
  }
  seen.add(provider);
  return provider;
}

interface BenchTrialAgent {
  agent: Agent;
  registry: ToolRegistry;
  lease: ToolTurnLease;
  close(): void;
}

// Coding-eval trials intentionally hold a fixed, local-only capability ceiling. This keeps results
// comparable across machines whose global skills/MCP/browser/computer configuration differs, while the
// production planner may still narrow the set further (for example, an exact-file turn).
const BENCH_LOCAL_TOOLS = Object.freeze([
  "read_file", "search", "glob", "ls", "todo_write",
  "write_file", "edit", "multi_edit", "bash",
] as const);
const BENCH_IMPLEMENTATION_CONTRACT = "Benchmark implementation modules must use relative imports only. Do not terminate the process, inspect the host filesystem/runtime, use eval, or use dynamic import.";

function benchmarkTurnTools(planned?: readonly string[]): string[] {
  if (!planned) return [...BENCH_LOCAL_TOOLS];
  const ceiling = new Set<string>(BENCH_LOCAL_TOOLS);
  return planned.filter((name) => ceiling.has(name));
}

/** Compose a benchmark trial through the same configured registry, turn planner, dynamic context,
 * and verification contract as a production headless turn. Delegation stays disabled here because
 * child-provider cost is not yet represented in BenchResult; advertising an unmetered task tool would
 * make the scorecard misleading. External MCP is likewise absent unless the harness supplies a hub. */
function buildBenchTrialAgent(
  cfg: NekoConfig,
  provider: Provider,
  root: string,
  prompt: string,
  maxSteps: number,
  onEvent?: (kind: string, data: any) => void,
): BenchTrialAgent {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "neko-bench-home-")));
  let lease: ToolTurnLease | undefined;
  try {
    const registry = configureToolRegistry(new ToolRegistry(root, "auto", async () => true), cfg);
    registry.disabled.add("task");
    // Trials intentionally exclude host-global identity/memory and executable hooks. Those inputs are
    // useful in a personal session but make a supposedly matched benchmark machine-specific.
    registry.hooks = undefined;
    // Benchmark tasks are self-contained fixtures. Host reads would both make runs machine-dependent
    // and let a candidate inspect this package's post-turn hidden-oracle source.
    registry.readOutsideRoot = false;
    registry.sandboxDenyReadFiles = benchmarkHostCodeFiles(root);
    registry.sandboxBash = true;
    registry.sandboxAllowNetwork = false;
    registry.sandboxDomains = [];
    registry.allowDangerousBash = false;
    registry.bashTimeoutCapMs = 600_000;
    const plan = planTurnCapabilities({
      rawUserText: prompt,
      source: "user",
      imageCount: 0,
      attachmentCount: 0,
      root,
      home,
    });
    const activeLease = registry.enterTurn({
      name: plan.profile,
      allowedTools: benchmarkTurnTools(plan.allowedTools),
      allowBackgroundBash: false,
      editTarget: plan.editTarget,
      bashPolicy: "foreground-validator-only",
      reason: plan.reason,
    });
    lease = activeLease;
    const agent = new Agent({
      provider,
      tools: registry,
      maxSteps,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      dynamicContext: () => productionTurnContext(registry, {
        model: cfg.model,
        provider: cfg.provider,
        home,
        includeTodos: true,
      }),
      // Toolful headless `neko run` enables the one-shot inspection gate unless explicitly disabled.
      verifyBeforeExit: cfg.data.verify_before_exit !== false,
      verifyStateChangesBeforeExit: true,
      adaptiveEffort: cfg.adaptiveEffort,
      onEvent,
    });
    agent.setTurnSystemContext([matchedTurnContext(prompt, registry, home).text, BENCH_IMPLEMENTATION_CONTRACT].filter(Boolean).join("\n\n"));
    let closed = false;
    return {
      agent,
      registry,
      lease: activeLease,
      close: () => {
        if (closed) return;
        closed = true;
        activeLease.close();
        agent.clearTurnSystemContext();
        rmSync(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    lease?.close();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

/** Run the benchmark against the configured model. Each task runs `trials` times (single-run pass@1
 * is noisy — reliability science), each in its own temp dir. */
export async function runBench(cfg: NekoConfig, opts: { trials?: number; tasks?: BenchTask[]; suite?: string; maxSteps?: number; providerFactory?: BenchProviderFactory } = {}, onProgress?: (msg: string) => void): Promise<BenchReport> {
  const trials = Math.max(1, opts.trials ?? 1);
  const tasks = opts.tasks ?? TASKS;
  const suite = opts.suite ?? "easy";
  const maxSteps = Math.max(1, opts.maxSteps ?? 25);
  const fingerprint = benchmarkRunFingerprint(cfg, tasks, maxSteps);
  const providerFactory = opts.providerFactory ?? (() => getProvider(cfg));
  const seenProviders = new Set<Provider>();
  const t0 = Date.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neko-bench-")));
  const results: BenchResult[] = [];
  try {
    for (const task of tasks) {
      let passes = 0, modelFailures = 0, infraErrors = 0;
      let tokens = 0, inTok = 0, cachedTok = 0, outTok = 0, calls = 0, ms = 0;
      for (let t = 0; t < trials; t++) {
        const dir = join(root, `${task.id}-${t}`);
        mkdirSync(dir, { recursive: true });
        materializeTaskFiles(dir, task.files);
        onProgress?.(`  ${task.id}${trials > 1 ? ` [${t + 1}/${trials}]` : ""} ...`);
        const provider = freshProvider(providerFactory, seenProviders);
        let trial: BenchTrialAgent | undefined;
        try {
          trial = buildBenchTrialAgent(cfg, provider, dir, task.prompt, maxSteps);
          const { agent } = trial;
          const tStart = Date.now();
          let pass = false, outcome: TrialOutcome = "model_failure", err = "";
          try {
            await agent.run(task.prompt);
            pass = (await verifyTaskEndState(task, dir)).pass && agent.completionStatus.ok;
            outcome = pass ? "pass" : "model_failure";
          } catch (e) {
            err = e instanceof Error ? e.message : String(e);
            outcome = "infra_error";
          }
          ms += Date.now() - tStart;
          if (outcome === "pass") passes++;
          else if (outcome === "model_failure") modelFailures++;
          else infraErrors++;
          tokens += agent.cost.totalTokens; inTok += agent.cost.promptTokens; cachedTok += agent.cost.cachedTokens; outTok += agent.cost.completionTokens; calls += agent.cost.calls;
          // Surface a thrown error (e.g. HTTP 401/timeout) — a swallowed exception used to read as a plain
          // "0/1 fail", which hid real problems (a bad key looked like the model failing).
          if (err) onProgress?.(`    ! ${task.id} ERRORED: ${err.replace(/\s+/g, " ").slice(0, 140)}`);
        } finally {
          try { trial?.close(); } finally { await provider.dispose?.(); }
        }
      }
      results.push({ id: task.id, passes, modelFailures, infraErrors, trials, tokens, inTok, cachedTok, outTok, calls, ms });
      const tps = ms > 0 ? Math.round((outTok / ms) * 1000) : 0;
      onProgress?.(`  ${task.id} -> ${passes}/${trials}  infra=${infraErrors}  ${(ms / trials / 1000).toFixed(1)}s  ${tokens} tok (${outTok} out, ${tps} tok/s)  ${(calls / trials).toFixed(0)} calls`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const sum = (f: (r: BenchResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const report: BenchReport = {
    model: cfg.model, effort: cfg.effort || "off", fingerprint, maxSteps, trials, results,
    passed: sum((r) => r.passes), total: sum((r) => r.trials),
    modelFailures: sum((r) => r.modelFailures), infraErrors: sum((r) => r.infraErrors),
    comparisonValid: results.every((r) => r.infraErrors === 0),
    tokens: sum((r) => r.tokens), inTok: sum((r) => r.inTok), cachedTok: sum((r) => r.cachedTok), outTok: sum((r) => r.outTok), calls: sum((r) => r.calls),
    seconds: (Date.now() - t0) / 1000,
  };
  if (benchmarkRunFingerprint(cfg, tasks, maxSteps) !== fingerprint) {
    throw new BenchInfrastructureError("benchmark source or task definition changed during the run");
  }
  appendBenchLog(report, suite);
  return report;
}

/** Multi-dimensional eval (CLEAR + τ-bench pass^k + RedundancyBench). Same tasks/trials as runBench, but
 * additionally captures the tool-call trace (read-only telemetry via Agent.onEvent — never alters the loop
 * or prompt) and per-task constraint outcomes, then computes the dimensional report from bench-metrics.
 * The live run spends tokens; the metric math itself is offline-tested (test/bench-metrics.test.ts). */
export const EVAL_TRAJECTORY_SCHEMA = "neko.eval.trajectory.v1" as const;
const MAX_EVAL_EVENTS_PER_TRIAL = 128;
const MAX_FAILED_CONSTRAINTS_PER_TRIAL = 32;
const MAX_EVAL_TRAJECTORIES = 512;
const MAX_EVAL_TASK_SUMMARIES = 512;
const MAX_EVAL_LATENCIES_PER_TASK = 64;
const MAX_EVAL_ARTIFACT_LABEL_CHARS = 160;
const MAX_EVAL_TRIALS_PER_TASK = 64;
const MAX_EVAL_STEPS = 512;
export const EVAL_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

export type EvalFailureSignal =
  | "constraint"
  | "verifier"
  | "completion_gate"
  | "max_steps"
  | "agent_infrastructure"
  | "verifier_infrastructure";

export interface EvalToolEvent {
  /** 1-based main-loop tool-decision round. Compaction and the tool-less max-step wrap are excluded. */
  round: number;
  /** Fixed benchmark tool name. Unknown/malformed names are never persisted verbatim. */
  tool: string;
  /** Trial-local opaque identity. It preserves equality for redundancy analysis, never the raw value. */
  targetRef?: string;
  result: "productive" | "empty" | "failed";
  redundant: boolean;
}

export interface EvalTrialTrajectory {
  taskId: string;
  /** Stable within one report and safe to persist; unlike taskId it never carries user-authored text. */
  taskRef: string;
  trial: number;
  outcome: TrialOutcome;
  failureSignals: EvalFailureSignal[];
  verifier: "passed" | "failed" | "not_run";
  completionGate: "passed" | "failed";
  ms: number;
  tokens: TrialRecord["tokens"];
  /** Exact Provider.complete invocations made by the harness, independent of optional usage fields. */
  modelCalls: number;
  toolCalls: number;
  redundantCalls: number;
  hitMaxSteps: boolean;
  /** Trial-local aliases (`k1`, `k2`, ...) in declaration order; raw constraint IDs are not retained. */
  failedConstraints: string[];
  omittedFailedConstraints: number;
  events: EvalToolEvent[];
  omittedEvents: number;
}

export interface EvalReport {
  model: string;
  effort: string;
  suite: string;
  fingerprint: string;
  maxSteps: number;
  trials: number;
  dim: DimReport;
  trajectorySchema: typeof EVAL_TRAJECTORY_SCHEMA;
  trajectories: EvalTrialTrajectory[];
  omittedTrajectories: number;
  artifactPersisted: boolean;
}

export interface EvalArtifactTaskMetric {
  taskRef: string;
  trials: number;
  passes: number;
  modelFailures: number;
  infraErrors: number;
  comparisonValid: boolean;
  efficacy: number;
  passAllK: number;
  meanTokens: number;
  tokensPerSuccess: number;
  cna: number;
  redundantCalls: number;
  totalCalls: number;
  redundancyRate: number;
  stepEfficiency: number | null;
  constraintScore: number;
  p50Ms: number;
  p95Ms: number;
  latenciesMs: number[];
  omittedLatencies: number;
}

export interface EvalArtifactDimReport {
  tasks: EvalArtifactTaskMetric[];
  omittedTasks: number;
  trials: number;
  nTasks: number;
  totalTrials: number;
  passes: number;
  modelFailures: number;
  infraErrors: number;
  comparisonValid: boolean;
  pass1: number;
  passK: number;
  reliabilityDrop: number;
  tokensPerSuccess: number;
  cna: number;
  redundancyRate: number;
  stepEfficiency: number | null;
  constraintScore: number;
  p50Ms: number;
  p95Ms: number;
  slaCompliance: number;
  slaMs: number;
}

export interface EvalArtifactToolEvent {
  round: number;
  tool: string;
  targetRef?: string;
  result: "productive" | "empty" | "failed";
  redundant: boolean;
}

export interface EvalArtifactTrialTrajectory {
  taskRef: string;
  trial: number;
  outcome: TrialOutcome;
  failureSignals: EvalFailureSignal[];
  verifier: "passed" | "failed" | "not_run";
  completionGate: "passed" | "failed";
  ms: number;
  tokens: { in: number; cached: number; out: number };
  modelCalls: number;
  toolCalls: number;
  redundantCalls: number;
  hitMaxSteps: boolean;
  failedConstraintRefs: string[];
  omittedFailedConstraints: number;
  events: EvalArtifactToolEvent[];
  omittedEvents: number;
}

/** Stable persisted v1 envelope. Keep this allowlist independent from EvalReport so adding an
 * in-memory diagnostic can never silently enter the JSONL format. */
export interface EvalArtifactRecord {
  kind: "eval";
  schema: typeof EVAL_TRAJECTORY_SCHEMA;
  ts: string;
  model: string;
  effort: string;
  suite: string;
  fingerprint: string;
  maxSteps: number;
  trials: number;
  dim: EvalArtifactDimReport;
  trajectories: EvalArtifactTrialTrajectory[];
  omittedTrajectories: number;
}

interface EvalTargetRefs {
  paths: Map<string, string>;
  queries: Map<string, string>;
  commands: Map<string, string>;
}

function parsedCallArguments(call: any): Record<string, any> {
  const raw = call?.arguments ?? {};
  if (!isText(raw)) return isJsonObject(raw) ? raw : {};
  try {
    const parsed = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : {};
  } catch { return {}; }
}

function traceString(value: unknown): string | undefined {
  return isText(value) && value.length ? value : undefined;
}

function normalizedTracePath(value: unknown, defaultRoot = false): string | undefined {
  const raw = isText(value)
    ? (value || (defaultRoot ? "." : undefined))
    : (defaultRoot && value === undefined ? "." : undefined);
  if (!raw) return undefined;
  const portable = normalize(raw).split(sep).join("/") || ".";
  return process.platform === "win32" ? portable.toLowerCase() : portable;
}

function positiveTraceInt(value: unknown, fallback: number | null): number | null {
  let numeric: number;
  try { numeric = Number(value); } catch { return fallback; }
  if (!Number.isFinite(numeric)) return fallback;
  const floored = Math.floor(numeric);
  return floored > 0 ? floored : fallback;
}

function boundedTraceInt(value: unknown, min: number, max: number, fallback: number): number {
  let numeric: number;
  try { numeric = Number(value); } catch { return fallback; }
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.floor(numeric))) : fallback;
}

function traceReadIdentity(name: string, args: Record<string, any>): { key?: string; scope?: string } {
  if (name === "read_file") {
    const scope = normalizedTracePath(args.path);
    if (!scope) return {};
    return {
      scope,
      key: JSON.stringify([
        name,
        scope,
        positiveTraceInt(args.offset, 1),
        positiveTraceInt(args.column, 1),
        positiveTraceInt(args.limit, null),
      ]),
    };
  }
  if (name === "search") {
    const scope = normalizedTracePath(args.path, true);
    const pattern = traceString(args.pattern);
    if (!scope || !pattern) return { scope };
    const context = boundedTraceInt(args.context, 0, 5, 0);
    return {
      scope,
      key: JSON.stringify([name, scope, pattern, traceString(args.glob) ?? null, Boolean(args.case_insensitive), context]),
    };
  }
  if (name === "glob") {
    const scope = normalizedTracePath(args.path, true);
    const pattern = traceString(args.pattern);
    return scope && pattern ? { scope, key: JSON.stringify([name, scope, pattern]) } : { scope };
  }
  if (name === "ls") {
    const scope = normalizedTracePath(args.path, true);
    return scope ? { scope, key: JSON.stringify([name, scope]) } : {};
  }
  return {};
}

function opaqueTargetRef(call: any, refs: EvalTargetRefs): string | undefined {
  const args = parsedCallArguments(call);
  const name = isText(call?.name) ? call.name : "";
  const assign = (map: Map<string, string>, prefix: string, raw: unknown) => {
    if (!isText(raw) || !raw) return undefined;
    const existing = map.get(raw);
    if (existing) return existing;
    const next = `${prefix}${map.size + 1}`;
    map.set(raw, next);
    return next;
  };
  const readIdentity = traceReadIdentity(name, args).key;
  if ((name === "search" || name === "glob") && readIdentity) {
    return assign(refs.queries, "q", readIdentity);
  }
  return assign(refs.paths, "p", normalizedTracePath(args.path ?? args.file, name === "ls"))
    ?? assign(refs.queries, "q", traceString(args.pattern ?? args.glob ?? args.query))
    ?? assign(refs.commands, "c", traceString(args.command));
}

function safeEvalToolName(call: any): string {
  const name = isText(call?.name) ? call.name : "";
  // SAFETY: contract of the readonly string[ type is established by the surrounding validation/boundary.
  return (BENCH_LOCAL_TOOLS as readonly string[]).includes(name) ? name : "<unknown>";
}

function traceFromCall(call: any, observation: unknown): TraceEntry {
  const a = parsedCallArguments(call);
  const name = isText(call?.name) ? call.name : "";
  const read = traceReadIdentity(name, a);
  return {
    name,
    path: normalizedTracePath(a.path, name === "search" || name === "glob" || name === "ls"),
    pattern: traceString(a.pattern ?? a.glob),
    cmd: name === "bash" ? traceString(a.command) : undefined,
    readKey: read.key,
    readScope: read.scope,
    ok: classifyToolObservation(observation) === "productive",
  };
}

/** Internal pure test seam for malformed provider arguments and redundancy identity. */
export const __traceFromCallForTest = traceFromCall;

function artifactNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function artifactCount(value: number): number {
  return Math.max(0, Math.floor(artifactNumber(value)));
}

function artifactLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, MAX_EVAL_ARTIFACT_LABEL_CHARS);
}

function artifactTaskRef(value: string, fallbackIndex: number): string {
  return /^t\d{1,6}$/.test(value) ? value : `t${fallbackIndex + 1}`;
}

function artifactConstraintRef(value: string): string | undefined {
  return /^k\d{1,4}$/.test(value) ? value : undefined;
}

const EVAL_FAILURE_SIGNALS = new Set<EvalFailureSignal>([
  "constraint", "verifier", "completion_gate", "max_steps", "agent_infrastructure", "verifier_infrastructure",
]);

function artifactDimReport(dim: DimReport): EvalArtifactDimReport {
  const retained = dim.tasks.slice(0, MAX_EVAL_TASK_SUMMARIES).map((task, index): EvalArtifactTaskMetric => ({
    taskRef: `t${index + 1}`,
    trials: artifactCount(task.trials),
    passes: artifactCount(task.passes),
    modelFailures: artifactCount(task.modelFailures),
    infraErrors: artifactCount(task.infraErrors),
    comparisonValid: Boolean(task.comparisonValid),
    efficacy: artifactNumber(task.efficacy),
    passAllK: artifactNumber(task.passAllK),
    meanTokens: artifactNumber(task.meanTokens),
    tokensPerSuccess: artifactNumber(task.tokensPerSuccess),
    cna: artifactNumber(task.cna),
    redundantCalls: artifactCount(task.redundantCalls),
    totalCalls: artifactCount(task.totalCalls),
    redundancyRate: artifactNumber(task.redundancyRate),
    stepEfficiency: task.stepEfficiency === null ? null : artifactNumber(task.stepEfficiency),
    constraintScore: artifactNumber(task.constraintScore),
    p50Ms: artifactNumber(task.p50Ms),
    p95Ms: artifactNumber(task.p95Ms),
    latenciesMs: task.latenciesMs.slice(0, MAX_EVAL_LATENCIES_PER_TASK).map((value) => artifactNumber(value)),
    omittedLatencies: Math.max(0, task.latenciesMs.length - MAX_EVAL_LATENCIES_PER_TASK),
  }));
  return {
    tasks: retained,
    omittedTasks: Math.max(0, dim.tasks.length - retained.length),
    trials: artifactCount(dim.trials),
    nTasks: artifactCount(dim.nTasks),
    totalTrials: artifactCount(dim.totalTrials),
    passes: artifactCount(dim.passes),
    modelFailures: artifactCount(dim.modelFailures),
    infraErrors: artifactCount(dim.infraErrors),
    comparisonValid: Boolean(dim.comparisonValid),
    pass1: artifactNumber(dim.pass1),
    passK: artifactNumber(dim.passK),
    reliabilityDrop: artifactNumber(dim.reliabilityDrop),
    tokensPerSuccess: artifactNumber(dim.tokensPerSuccess),
    cna: artifactNumber(dim.cna),
    redundancyRate: artifactNumber(dim.redundancyRate),
    stepEfficiency: dim.stepEfficiency === null ? null : artifactNumber(dim.stepEfficiency),
    constraintScore: artifactNumber(dim.constraintScore),
    p50Ms: artifactNumber(dim.p50Ms),
    p95Ms: artifactNumber(dim.p95Ms),
    slaCompliance: artifactNumber(dim.slaCompliance),
    slaMs: artifactNumber(dim.slaMs),
  };
}

function artifactTrajectory(trajectory: EvalTrialTrajectory, index: number): EvalArtifactTrialTrajectory {
  const outcome: TrialOutcome = new Set<TrialOutcome>(["pass", "model_failure", "infra_error"]).has(trajectory.outcome)
    ? trajectory.outcome
    : "infra_error";
  const verifier = new Set(["passed", "failed", "not_run"]).has(trajectory.verifier)
    ? trajectory.verifier
    : "not_run";
  const completionGate = trajectory.completionGate === "passed" ? "passed" : "failed";
  const events = trajectory.events.slice(0, MAX_EVAL_EVENTS_PER_TRIAL).map((event): EvalArtifactToolEvent => {
    const targetRef = isText(event.targetRef) && /^[pqc]\d{1,4}$/.test(event.targetRef)
      ? event.targetRef
      : undefined;
    const result = event.result === "empty" || event.result === "failed" ? event.result : "productive";
    return {
      round: Math.max(1, artifactCount(event.round)),
      // SAFETY: contract of the readonly string[ type is established by the surrounding validation/boundary.
      tool: (BENCH_LOCAL_TOOLS as readonly string[]).includes(event.tool) ? event.tool : "<unknown>",
      ...(targetRef ? { targetRef } : undefined),
      result,
      redundant: Boolean(event.redundant),
    };
  });
  const failedConstraintRefs = trajectory.failedConstraints
    .map(artifactConstraintRef)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_FAILED_CONSTRAINTS_PER_TRIAL);
  return {
    taskRef: artifactTaskRef(trajectory.taskRef, index),
    trial: Math.max(1, artifactCount(trajectory.trial)),
    outcome,
    failureSignals: trajectory.failureSignals.filter((signal) => EVAL_FAILURE_SIGNALS.has(signal)),
    // SAFETY: contract of the EvalArtifactTrialTrajectory["verifier" type is established by the surrounding validation/boundary.
    verifier: verifier as EvalArtifactTrialTrajectory["verifier"],
    completionGate,
    ms: artifactNumber(trajectory.ms),
    tokens: {
      in: artifactCount(trajectory.tokens.in),
      cached: artifactCount(trajectory.tokens.cached),
      out: artifactCount(trajectory.tokens.out),
    },
    modelCalls: artifactCount(trajectory.modelCalls),
    toolCalls: artifactCount(trajectory.toolCalls),
    redundantCalls: artifactCount(trajectory.redundantCalls),
    hitMaxSteps: Boolean(trajectory.hitMaxSteps),
    failedConstraintRefs,
    omittedFailedConstraints: artifactCount(trajectory.omittedFailedConstraints)
      + Math.max(0, trajectory.failedConstraints.length - failedConstraintRefs.length),
    events,
    omittedEvents: artifactCount(trajectory.omittedEvents) + Math.max(0, trajectory.events.length - events.length),
  };
}

function evalArtifactBytes(record: EvalArtifactRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function fitEvalArtifactBytes(record: EvalArtifactRecord): EvalArtifactRecord {
  let fitted = record;
  while (evalArtifactBytes(fitted) > EVAL_ARTIFACT_MAX_BYTES && fitted.trajectories.length) {
    const keep = Math.floor(fitted.trajectories.length / 2);
    const dropped = fitted.trajectories.length - keep;
    fitted = { ...fitted, trajectories: fitted.trajectories.slice(0, keep), omittedTrajectories: fitted.omittedTrajectories + dropped };
  }
  while (evalArtifactBytes(fitted) > EVAL_ARTIFACT_MAX_BYTES && fitted.dim.tasks.length) {
    const keep = Math.floor(fitted.dim.tasks.length / 2);
    const dropped = fitted.dim.tasks.length - keep;
    fitted = {
      ...fitted,
      dim: { ...fitted.dim, tasks: fitted.dim.tasks.slice(0, keep), omittedTasks: fitted.dim.omittedTasks + dropped },
    };
  }
  if (evalArtifactBytes(fitted) > EVAL_ARTIFACT_MAX_BYTES) {
    fitted = {
      ...fitted,
      trajectories: [],
      omittedTrajectories: fitted.omittedTrajectories + fitted.trajectories.length,
      dim: {
        ...fitted.dim,
        tasks: [],
        omittedTasks: fitted.dim.omittedTasks + fitted.dim.tasks.length,
      },
    };
  }
  return fitted;
}

function buildEvalArtifactRecord(report: EvalReport): EvalArtifactRecord {
  const record: EvalArtifactRecord = {
    kind: "eval",
    schema: EVAL_TRAJECTORY_SCHEMA,
    ts: new Date().toISOString(),
    model: artifactLabel(report.model),
    effort: artifactLabel(report.effort),
    suite: artifactLabel(report.suite),
    fingerprint: artifactLabel(report.fingerprint),
    maxSteps: artifactCount(report.maxSteps),
    trials: artifactCount(report.trials),
    dim: artifactDimReport(report.dim),
    trajectories: report.trajectories.slice(0, MAX_EVAL_TRAJECTORIES).map(artifactTrajectory),
    omittedTrajectories: artifactCount(report.omittedTrajectories)
      + Math.max(0, report.trajectories.length - MAX_EVAL_TRAJECTORIES),
  };
  return fitEvalArtifactBytes(record);
}

/** Internal pure test seam for the fixed v1 allowlist and whole-record byte cap. */
export const __buildEvalArtifactRecordForTest = buildEvalArtifactRecord;

function boundedEvalInteger(name: string, value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return selected;
}

export async function runEval(
  cfg: NekoConfig,
  opts: {
    trials?: number;
    tasks?: BenchTask[];
    suite?: string;
    slaMs?: number;
    maxSteps?: number;
    providerFactory?: BenchProviderFactory;
    /** Test/embedding seam. Injected providers do not persist by default; production evals append locally. */
    artifactSink?: (record: EvalArtifactRecord) => boolean | Promise<boolean>;
    /** @deprecated A single injected provider is only safe for exactly one task trial. */
    provider?: Provider;
  } = {},
  onProgress?: (msg: string) => void,
): Promise<EvalReport> {
  const trials = boundedEvalInteger("trials", opts.trials, 1, MAX_EVAL_TRIALS_PER_TASK);
  const maxSteps = boundedEvalInteger("maxSteps", opts.maxSteps, 25, MAX_EVAL_STEPS);
  const tasks = opts.tasks ?? TASKS;
  const suite = opts.suite ?? "easy";
  const slaMs = opts.slaMs ?? 30_000;
  if (opts.provider && opts.providerFactory) {
    throw new Error("runEval accepts providerFactory or provider, not both");
  }
  if (opts.provider && tasks.length * trials > 1) {
    throw new Error("runEval provider cannot be shared across task trials; use providerFactory");
  }
  const providerFactory = opts.providerFactory ?? (opts.provider ? () => opts.provider! : () => getProvider(cfg));
  const seenProviders = new Set<Provider>();
  // BENCHMARK step cap (default 25): the interactive-session default (cfg.maxSteps, often 160+) lets a
  // confused agent spin ~160 slow steps per task — unbounded for a benchmark. SWE-bench-style harnesses
  // cap at ~25-30; this forces efficiency and bounds wall-clock + token spend. Tasks that can't finish
  // in this budget are marked failed (which is itself a meaningful benchmark signal).
  const fingerprint = benchmarkRunFingerprint(cfg, tasks, maxSteps, undefined, { slaMs });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neko-eval-")));
  const specs: TaskSpec[] = [];
  const trajectories: EvalTrialTrajectory[] = [];
  let omittedTrajectories = 0;
  try {
    for (const [taskIndex, task] of tasks.entries()) {
      const records: TrialRecord[] = [];
      for (let t = 0; t < trials; t++) {
        const dir = join(root, `${task.id}-${t}`);
        mkdirSync(dir, { recursive: true });
        materializeTaskFiles(dir, task.files);
        onProgress?.(`  ${task.id}${trials > 1 ? ` [${t + 1}/${trials}]` : ""} ...`);
        const trace: TraceEntry[] = [];
        const events: EvalToolEvent[] = [];
        const targetRefs: EvalTargetRefs = { paths: new Map(), queries: new Map(), commands: new Map() };
        let round = 0;
        let providerCalls = 0;
        let hitMaxSteps = false;
        const provider = freshProvider(providerFactory, seenProviders);
        const countedProvider: Provider = {
          complete: (...args) => {
            providerCalls++;
            return provider.complete(...args);
          },
        };
        let trial: BenchTrialAgent | undefined;
        try {
          trial = buildBenchTrialAgent(
            cfg,
            countedProvider,
            dir,
            task.prompt,
            maxSteps,
            (kind, data) => {
              if (kind === "usage_estimate") {
                round++;
                return;
              }
              if (kind === "max_steps") {
                hitMaxSteps = true;
                return;
              }
              if (kind !== "tool_result" || !data?.call) return;
              const observationClass = classifyToolObservation(data.observation);
              trace.push(traceFromCall(data.call, data.observation));
              if (events.length < MAX_EVAL_EVENTS_PER_TRIAL) {
                const targetRef = opaqueTargetRef(data.call, targetRefs);
                events.push({
                  round: Math.max(1, round),
                  tool: safeEvalToolName(data.call),
                  ...(targetRef ? { targetRef } : undefined),
                  result: observationClass,
                  redundant: false,
                });
              }
            },
          );
          const { agent } = trial;
          const tStart = Date.now();
          let pass = false, outcome: TrialOutcome = "model_failure", err = "";
          let constraints: TrialRecord["constraints"] = [];
          let verifier: EvalTrialTrajectory["verifier"] = "not_run";
          let infraPhase: "agent" | "verifier" = "agent";
          try {
            await agent.run(task.prompt);
            infraPhase = "verifier";
            const endState = await verifyTaskEndState(task, dir);
            constraints = endState.constraints;
            verifier = endState.pass ? "passed" : "failed";
            pass = endState.pass && agent.completionStatus.ok;
            outcome = pass ? "pass" : "model_failure";
          } catch (e) {
            err = e instanceof Error ? e.message : String(e);
            outcome = "infra_error";
          }
          const ms = Date.now() - tStart;
          const tokens = { in: agent.cost.promptTokens, cached: agent.cost.cachedTokens, out: agent.cost.completionTokens };
          records.push({
            pass, outcome,
            tokens,
            ms, steps: trace.length, trace, constraints,
          });
          const redundantMask = redundantCallMask(trace);
          for (let i = 0; i < events.length; i++) events[i].redundant = Boolean(redundantMask[i]);
          const failed = constraints
            .map((constraint, index) => ({ constraint, ref: `k${index + 1}` }))
            .filter(({ constraint }) => !constraint.ok)
            .map(({ ref }) => ref);
          const failureSignals: EvalFailureSignal[] = [];
          if (outcome === "infra_error") {
            failureSignals.push(infraPhase === "agent" ? "agent_infrastructure" : "verifier_infrastructure");
          } else if (!pass) {
            if (failed.length) failureSignals.push("constraint");
            else if (verifier === "failed") failureSignals.push("verifier");
            if (!agent.completionStatus.ok) failureSignals.push("completion_gate");
            if (hitMaxSteps) failureSignals.push("max_steps");
            if (!failureSignals.length) failureSignals.push("verifier");
          }
          const trajectory: EvalTrialTrajectory = {
            taskId: task.id,
            taskRef: `t${taskIndex + 1}`,
            trial: t + 1,
            outcome,
            failureSignals,
            verifier,
            completionGate: agent.completionStatus.ok ? "passed" : "failed",
            ms,
            tokens,
            modelCalls: providerCalls,
            toolCalls: trace.length,
            redundantCalls: redundantMask.filter(Boolean).length,
            hitMaxSteps,
            failedConstraints: failed.slice(0, MAX_FAILED_CONSTRAINTS_PER_TRIAL),
            omittedFailedConstraints: Math.max(0, failed.length - MAX_FAILED_CONSTRAINTS_PER_TRIAL),
            events,
            omittedEvents: Math.max(0, trace.length - events.length),
          };
          if (trajectories.length < MAX_EVAL_TRAJECTORIES) trajectories.push(trajectory);
          else omittedTrajectories++;
          if (err) onProgress?.(`    ! ${task.id} ERRORED: ${err.replace(/\s+/g, " ").slice(0, 140)}`);
        } finally {
          try { trial?.close(); } finally { await provider.dispose?.(); }
        }
      }
      specs.push({ id: task.id, trials, optimalSteps: task.optimalSteps, records });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const metrics = specs.map((s) => analyzeTask(s, slaMs));
  if (benchmarkRunFingerprint(cfg, tasks, maxSteps, undefined, { slaMs }) !== fingerprint) {
    throw new BenchInfrastructureError("benchmark source or task definition changed during the run");
  }
  const report: EvalReport = {
    model: cfg.model,
    effort: cfg.effort || "off",
    suite,
    fingerprint,
    maxSteps,
    trials,
    dim: aggregate(metrics, slaMs),
    trajectorySchema: EVAL_TRAJECTORY_SCHEMA,
    trajectories,
    omittedTrajectories,
    artifactPersisted: false,
  };
  const artifact = buildEvalArtifactRecord(report);
  const persistenceAttempted = Boolean(opts.artifactSink) || (!opts.provider && !opts.providerFactory);
  let artifactPersisted = false;
  try {
    artifactPersisted = opts.artifactSink
      ? (await opts.artifactSink(artifact)) === true
      : (!opts.provider && !opts.providerFactory ? appendEvalLog(artifact) : false);
  } catch { artifactPersisted = false; }
  if (persistenceAttempted && !artifactPersisted) {
    onProgress?.("    ! bounded eval trajectory artifact could not be persisted; the in-memory report is complete");
  }
  return { ...report, artifactPersisted };
}

export function renderEvalReport(r: EvalReport): string {
  const retained = `${r.trajectories.length} bounded trial trajectory${r.trajectories.length === 1 ? "" : "s"}`
    + (r.omittedTrajectories ? ` (${r.omittedTrajectories} omitted by cap)` : "");
  return `${renderScorecard(r.dim, `Neko-eval :: ${r.model} (effort ${r.effort}, suite ${r.suite})`)}\nFingerprint: ${r.fingerprint}  maxSteps=${r.maxSteps}\nTrajectories: ${retained} in memory\nArtifact v1: ${r.artifactPersisted ? "persisted" : "returned in memory only"}`;
}

function appendEvalLog(r: EvalArtifactRecord, baseHome = homeDir()): boolean {
  try {
    const dir = join(baseHome, ".neko-core");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "bench-log.jsonl"), JSON.stringify(r) + "\n", "utf8");
    return true;
  } catch { return false; }
}

/** Internal test seam for the real JSONL serializer without touching the user's home. */
export const __appendEvalLogForTest = appendEvalLog;

/** Dev-log: append each bench run as one JSON line to ~/.neko-core/bench-log.jsonl, so self-improvement is
 * MEASURABLE over time — diff two runs to see if a harness change moved pass-rate, tokens, speed, or steps. */
function appendBenchLog(r: BenchReport, suite = "easy"): void {
  try {
    const dir = join(homeDir(), ".neko-core");
    mkdirSync(dir, { recursive: true });
    const rec = {
      ts: new Date().toISOString(), suite, model: r.model, effort: r.effort, fingerprint: r.fingerprint, maxSteps: r.maxSteps, pass: r.passed, total: r.total,
      modelFailures: r.modelFailures, infraErrors: r.infraErrors, comparisonValid: r.comparisonValid,
      seconds: Math.round(r.seconds), tokens: r.tokens, inTok: r.inTok, cachedTok: r.cachedTok, outTok: r.outTok, calls: r.calls,
      tokPerSec: r.seconds > 0 ? Math.round(r.outTok / r.seconds) : 0,
      tasks: r.results.map((x) => ({ id: x.id, pass: x.passes, modelFailures: x.modelFailures, infraErrors: x.infraErrors, trials: x.trials, ms: x.ms, inTok: x.inTok, cachedTok: x.cachedTok, outTok: x.outTok, calls: x.calls })),
    };
    appendFileSync(join(dir, "bench-log.jsonl"), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* a logging failure must never break the bench */ }
}

// ---- Harness-lift: the SAME tasks run RAW (model only, no tools/loop) vs +NEKO (tools + agentic loop).
// The thesis made measurable: Neko's edge is the HARNESS turning a given model into a capable agent. ----
export interface LiftRow { id: string; raw: boolean; harness: boolean; }
export interface LiftReport { model: string; fingerprint: string; maxSteps: number; rows: LiftRow[]; rawPass: number; harnessPass: number; total: number; seconds: number; }

/** Pull ```filename\n...``` fenced blocks out of a raw model reply (it has no tools, so it must emit files). */
function parseFileBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = (m[1] || "").trim().split(/\s+/).pop() ?? "";
    if (name && name.includes(".")) out[name] = m[2];
  }
  return out;
}

function applyRawFileBlocks(root: string, text: string): void {
  const base = realpathSync(resolve(root));
  for (const [name, content] of Object.entries(parseFileBlocks(text))) {
    if (!name || name.includes("\0")) continue;
    const target = resolve(base, name);
    const rel = relative(base, target);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) continue;
    try { writeFileSync(target, content); } catch { /* invalid output cannot escape the trial */ }
  }
}

/** Internal test seam for raw-model file-block confinement. */
export const __applyRawBenchFilesForTest = applyRawFileBlocks;

async function runRawTask(provider: Provider, task: BenchTask, dir: string): Promise<boolean> {
  materializeTaskFiles(dir, task.files); // seed inputs (also so unchanged-file checks hold)
  const filesBlock = Object.keys(task.files).length
    ? "Existing files:\n" + Object.entries(task.files).map(([n, c]) => `--- ${n} ---\n${c}`).join("\n\n") + "\n\n"
    : "";
  const prompt = `${task.prompt}\n\n${BENCH_IMPLEMENTATION_CONTRACT}\n\n${filesBlock}You have NO tools and cannot run code. Reply with the FULL final content of EACH file that should exist after the task, each in its own fenced block whose info-string is the exact filename, e.g.\n\`\`\`name.ext\n...content...\n\`\`\`\nOutput ONLY the file blocks, nothing else.`;
  const res = await provider.complete([{ role: "user", content: prompt }]);
  applyRawFileBlocks(dir, res.content ?? "");
  return (await verifyTaskEndState(task, dir)).pass;
}

/** Run each task twice — raw model vs full Neko harness — and report the lift. */
export async function runHarnessLift(
  cfg: NekoConfig,
  onProgress?: (msg: string) => void,
  opts: { tasks?: BenchTask[]; providerFactory?: BenchProviderFactory } = {},
): Promise<LiftReport> {
  const t0 = Date.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neko-lift-")));
  const rows: LiftRow[] = [];
  const tasks = opts.tasks ?? TASKS;
  const maxSteps = cfg.maxSteps;
  const fingerprint = benchmarkRunFingerprint(cfg, tasks, maxSteps);
  const providerFactory = opts.providerFactory ?? (() => getProvider(cfg));
  const seenProviders = new Set<Provider>();
  try {
    for (const task of tasks) {
      const rdir = join(root, `${task.id}-raw`); mkdirSync(rdir, { recursive: true });
      onProgress?.(`  ${task.id}: raw ...`);
      const rawProvider = freshProvider(providerFactory, seenProviders);
      let raw = false;
      try { raw = await runRawTask(rawProvider, task, rdir); }
      catch (error) {
        throw error instanceof BenchInfrastructureError
          ? error
          : new BenchInfrastructureError(`raw harness-lift infrastructure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally { await rawProvider.dispose?.(); }
      const hdir = join(root, `${task.id}-harness`); mkdirSync(hdir, { recursive: true });
      materializeTaskFiles(hdir, task.files);
      onProgress?.(`  ${task.id}: +neko ...`);
      const harnessProvider = freshProvider(providerFactory, seenProviders);
      let trial: BenchTrialAgent | undefined;
      let harness = false;
      try {
        trial = buildBenchTrialAgent(cfg, harnessProvider, hdir, task.prompt, maxSteps);
        await trial.agent.run(task.prompt);
        harness = (await verifyTaskEndState(task, hdir)).pass && trial.agent.completionStatus.ok;
      } catch (error) {
        throw error instanceof BenchInfrastructureError
          ? error
          : new BenchInfrastructureError(`Neko harness-lift infrastructure failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally {
        try { trial?.close(); } finally { await harnessProvider.dispose?.(); }
      }
      rows.push({ id: task.id, raw, harness });
      onProgress?.(`  ${task.id} -> raw ${raw ? "PASS" : "fail"} | +neko ${harness ? "PASS" : "fail"}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (benchmarkRunFingerprint(cfg, tasks, maxSteps) !== fingerprint) {
    throw new BenchInfrastructureError("benchmark source or task definition changed during the run");
  }
  return { model: cfg.model, fingerprint, maxSteps, rows, rawPass: rows.filter((r) => r.raw).length, harnessPass: rows.filter((r) => r.harness).length, total: rows.length, seconds: (Date.now() - t0) / 1000 };
}

export function renderLiftReport(r: LiftReport): string {
  const rows = r.rows.map((x) => `  ${x.id.padEnd(12)}  raw ${x.raw ? "PASS" : "----"}    +neko ${x.harness ? "PASS" : "----"}`).join("\n");
  const rp = r.total ? Math.round((r.rawPass / r.total) * 100) : 0;
  const hp = r.total ? Math.round((r.harnessPass / r.total) * 100) : 0;
  return `Harness-lift :: ${r.model}\n${rows}\n  ----------------------------------\n  RAW model alone:  ${r.rawPass}/${r.total} (${rp}%)\n  + NEKO harness:   ${r.harnessPass}/${r.total} (${hp}%)\n  LIFT: +${r.harnessPass - r.rawPass} task(s)  (+${hp - rp} pts)   ${r.seconds.toFixed(0)}s\n  fingerprint: ${r.fingerprint}  maxSteps=${r.maxSteps}`;
}

export function renderBenchReport(r: BenchReport): string {
  const rows = r.results.map((x) => {
    const tag = x.infraErrors ? "INFRA" : x.passes === x.trials ? "PASS " : x.passes === 0 ? "FAIL " : "FLAKY";
    const s = (x.ms / x.trials / 1000).toFixed(1);
    const tps = x.ms > 0 ? Math.round((x.outTok / x.ms) * 1000) : 0;
    return `  ${tag}  ${x.id.padEnd(14)} ${x.passes}/${x.trials}  ${s.padStart(5)}s  ${String(x.tokens).padStart(6)} tok  ${String(tps).padStart(4)} tok/s  ${String(Math.round(x.calls / x.trials)).padStart(2)} calls  infra=${x.infraErrors}`;
  }).join("\n");
  const pct = r.total ? Math.round((r.passed / r.total) * 100) : 0;
  const tps = r.seconds > 0 ? Math.round(r.outTok / r.seconds) : 0;
  const validity = r.comparisonValid
    ? "comparison: VALID (no infrastructure errors)"
    : "comparison: NOT COMPARABLE - fix infrastructure and rerun the full suite";
  return `Neko-bench :: ${r.model} (effort ${r.effort}, ${r.trials} trial${r.trials > 1 ? "s" : ""}/task)\n${rows}\n  --------------------------------------------------------------\n  pass@1: ${r.passed}/${r.total} (${pct}%)   ${r.tokens} tok (in ${r.inTok}${r.cachedTok > 0 ? `, ${Math.round((100 * r.cachedTok) / Math.max(1, r.inTok))}% cached` : ""}/out ${r.outTok})   ${tps} tok/s   ${r.calls} calls   ${r.seconds.toFixed(0)}s\n  outcomes: ${r.passed} pass | ${r.modelFailures} model-fail | ${r.infraErrors} infra\n  ${validity}\n  fingerprint: ${r.fingerprint}  maxSteps=${r.maxSteps}\n  (metrics appended to ~/.neko-core/bench-log.jsonl)`;
}
