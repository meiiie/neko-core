/** Build the credential-safe host runner and evaluate it with Harbor/Terminal-Bench 2.1. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

import { discoverCodexSupport, type CodexSupportStatus } from "../src/adapters/codex-app-server.ts";
import { validChatGptCredentials, type ChatGptCredentials } from "../src/adapters/chatgpt-auth.ts";
import { trustedGitExecutable } from "../src/adapters/trusted-git.ts";
import { executableOnPath } from "../src/core/sandbox.ts";
import { minimalWindowsSystemEnv, resolveWindowsSystemExecutable } from "../src/shared/windows-system.ts";
import { isObjectValue } from "../src/shared/wire.ts";

export const HARBOR_VERSION = "0.20.0";
export const TERMINAL_BENCH_2_1_DATASET =
  "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a";
export const DEFAULT_REASONING_EFFORT = "max";
export const DEFAULT_MAX_STEPS = 40;
export const HARBOR_HOST_RUNNER_BASENAME = `neko-harbor-host${process.platform === "win32" ? ".exe" : ""}`;
export const HARBOR_RUNNER_HOME_ENV = "NEKO_HARBOR_RUNNER_HOME";
export const HARBOR_RUN_DEADLINE_MS = 30 * 60 * 1000;
export const HARBOR_LEASE_MARGIN_MS = 5 * 60 * 1000;

export interface HarborEvalOptions {
  profile?: string;
  model?: string;
  limit: number;
  reasoningEffort: string;
  maxSteps: number;
  adaptiveEffort: boolean;
  loop: boolean;
  passthrough: string[];
}

export interface HarborBuildIdentity {
  runnerPath: string;
  runnerSha256: string;
  runnerSourceSha256: string;
  launcherSourceSha256: string;
  hostAgentSha256: string;
  remoteToolsSha256: string;
  sourceRevision: string;
  sourceDirty: boolean;
  buildBunVersion: string;
  codexSha256?: string;
}

export interface HarborExecutables {
  git: string;
  docker: string;
  uvx: string;
}

export interface HarborHostGrant {
  runnerHome: string;
  bridgePath: string;
  expiresAt: number;
}

const EVAL_PROFILE_BINDINGS = {
  chatgpt: { provider: "chatgpt", modelPrefix: "openai", defaultModel: "openai/gpt-5.6-sol" },
  kimi: { provider: "kimi", modelPrefix: "kimi", defaultModel: "kimi/kimi-for-coding" },
} as const;

export type HarborEvalProfile = keyof typeof EVAL_PROFILE_BINDINGS;

export interface HarborEvalIdentity {
  profile: HarborEvalProfile;
  provider: (typeof EVAL_PROFILE_BINDINGS)[HarborEvalProfile]["provider"];
  model: string;
}

const PASSTHROUGH_VALUE_FLAGS: any = {
  "--include-task-name": { canonical: "--include-task-name", kind: "selection" },
  "-i": { canonical: "--include-task-name", kind: "selection" },
  "--exclude-task-name": { canonical: "--exclude-task-name", kind: "selection" },
  "-x": { canonical: "--exclude-task-name", kind: "selection" },
  "--n-attempts": { canonical: "--n-attempts", kind: "positive-integer" },
  "-k": { canonical: "--n-attempts", kind: "positive-integer" },
  "--n-concurrent": { canonical: "--n-concurrent", kind: "positive-integer" },
  "-n": { canonical: "--n-concurrent", kind: "positive-integer" },
  "--n-concurrent-agents": { canonical: "--n-concurrent-agents", kind: "positive-integer" },
};

const PASSTHROUGH_BOOLEAN_FLAGS: any = {
  "--yes": "--yes",
  "-y": "--yes",
};

const PASSTHROUGH_DESCRIPTION =
  "include/exclude task selection, --n-attempts, --n-concurrent, --n-concurrent-agents, and --yes";

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) throw new Error(`${flag} needs a value.`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function reasoningEffort(value: string): string {
  if (!/^[a-z0-9._-]+$/i.test(value)) throw new Error("--effort must be one provider effort tier name.");
  return value;
}

function selectionValue(value: string, flag: string): string {
  if (value.startsWith("-") || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${flag} needs one bounded task selector.`);
  }
  return value;
}

function normalizeTaskSelector(value: string): string {
  return value.includes("/") ? value : `terminal-bench/${value}`;
}

function parsePassthrough(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const booleanFlag = PASSTHROUGH_BOOLEAN_FLAGS[arg];
    if (booleanFlag) {
      out.push(booleanFlag);
      continue;
    }
    const valueFlag = PASSTHROUGH_VALUE_FLAGS[arg];
    if (!valueFlag) {
      throw new Error(`Harbor passthrough option ${arg} is not allowed; only ${PASSTHROUGH_DESCRIPTION} are accepted.`);
    }
    const rawValue = valueAfter(args, i++, arg);
    const value = valueFlag.kind === "positive-integer"
      ? String(positiveInteger(rawValue, arg))
      : normalizeTaskSelector(selectionValue(rawValue, arg));
    out.push(valueFlag.canonical, value);
  }
  return out;
}

export function parseHarborEvalArgs(argv: string[]): HarborEvalOptions {
  const options: HarborEvalOptions = {
    limit: 1,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    maxSteps: DEFAULT_MAX_STEPS,
    adaptiveEffort: false,
    loop: true,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.passthrough = parsePassthrough(argv.slice(i + 1));
      break;
    }
    if (arg === "--profile") options.profile = valueAfter(argv, i++, arg);
    else if (arg === "--model") options.model = valueAfter(argv, i++, arg);
    else if (arg === "--limit") options.limit = positiveInteger(valueAfter(argv, i++, arg), arg);
    else if (arg === "--effort") options.reasoningEffort = reasoningEffort(valueAfter(argv, i++, arg));
    else if (arg === "--max-steps") options.maxSteps = positiveInteger(valueAfter(argv, i++, arg), arg);
    else if (arg === "--adaptive-effort") options.adaptiveEffort = true;
    else if (arg === "--no-adaptive-effort") options.adaptiveEffort = false;
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--no-loop") options.loop = false;
    else throw new Error(`Unknown option ${arg}. Put allowlisted Harbor options after --.`);
  }
  return options;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function stableFileSha256(rawPath: string, label: string, requireSingleLink: boolean): any {
  const requested = resolve(rawPath);
  let canonical: string;
  try {
    canonical = realpathSync.native(requested);
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
  if (!samePath(requested, canonical)) throw new Error(`${label} path must be canonical.`);

  const beforePath = lstatSync(canonical);
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || (requireSingleLink && beforePath.nlink !== 1)) {
    throw new Error(`${label} must be a canonical regular${requireSingleLink ? " single-link" : ""} file.`);
  }

  const handle = openSync(canonical, "r");
  let beforeHandle: Stats;
  let afterHandle: Stats;
  let sha256: string;
  try {
    beforeHandle = fstatSync(handle);
    if (!sameFileIdentity(beforePath, beforeHandle)) throw new Error(`${label} identity changed before hashing.`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
    sha256 = digest.digest("hex");
    afterHandle = fstatSync(handle);
  } finally {
    closeSync(handle);
  }

  const afterPath = lstatSync(canonical);
  if (!sameFileIdentity(beforeHandle!, afterHandle!) || !sameFileIdentity(afterHandle!, afterPath)) {
    throw new Error(`${label} identity changed while hashing.`);
  }
  return { path: canonical, sha256: sha256! };
}

function runAclTool(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): any {
  const result = Bun.spawnSync([command, ...args], {
    env: { ...minimalWindowsSystemEnv(), ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

/** Restrict an empty staging directory before any credential bytes are written into it. */
export function hardenPrivateHarborRoot(root: string): string {
  const requested = resolve(root);
  const canonical = realpathSync.native(requested);
  const stat = lstatSync(canonical);
  if (!samePath(requested, canonical) || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Harbor private staging root must be a canonical directory.");
  }
  if (process.platform !== "win32") {
    chmodSync(canonical, 0o700);
    if ((lstatSync(canonical).mode & 0o077) !== 0) throw new Error("Could not restrict Harbor private staging.");
    return canonical;
  }

  const whoami = resolveWindowsSystemExecutable("whoami.exe");
  const icacls = resolveWindowsSystemExecutable("icacls.exe");
  const powershell = resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe");
  if (!whoami || !icacls || !powershell) throw new Error("Windows ACL tools are unavailable for Harbor private staging.");
  const identity = runAclTool(whoami, ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.stdout.trim().match(/,\s*"(S-\d+(?:-\d+)+)"\s*$/i)?.[1];
  if (identity.exitCode !== 0 || !sid) throw new Error("Could not identify the Windows account for Harbor private staging.");
  // A runner may create the empty temp directory with extra explicit ACEs. Reset it while it is still
  // credential-free, then remove inheritance and grant only the two principals verified below.
  const reset = runAclTool(icacls, [canonical, "/reset", "/Q"]);
  const restricted = runAclTool(icacls, [
    canonical,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)(F)`,
    "*S-1-5-18:(OI)(CI)(F)",
    "/Q",
  ]);
  const verified = runAclTool(icacls, [canonical, "/verify", "/Q"]);
  if (reset.exitCode !== 0 || restricted.exitCode !== 0 || verified.exitCode !== 0) {
    throw new Error("Could not restrict Harbor private staging.");
  }
  const aclScript = [
    "$ErrorActionPreference='Stop'",
    "$section=[System.Security.AccessControl.AccessControlSections]::Access",
    "$acl=[System.Security.AccessControl.DirectorySecurity]::new($env:NEKO_ACL_TARGET,$section)",
    "$rules=@($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))",
    "$expected=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
    "[void]$expected.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    "[void]$expected.Add('S-1-5-18')",
    "$valid=$rules.Count -eq 2",
    "foreach($rule in $rules){",
    "  $valid=$valid -and $rule.AccessControlType -eq 'Allow' -and -not $rule.IsInherited -and $rule.FileSystemRights -eq 'FullControl'",
    "  $valid=$valid -and $rule.InheritanceFlags.HasFlag([System.Security.AccessControl.InheritanceFlags]::ObjectInherit)",
    "  $valid=$valid -and $rule.InheritanceFlags.HasFlag([System.Security.AccessControl.InheritanceFlags]::ContainerInherit)",
    "  $valid=$valid -and $rule.PropagationFlags -eq 'None' -and $expected.Remove($rule.IdentityReference.Value)",
    "}",
    "$valid=$valid -and $expected.Count -eq 0",
    "[pscustomobject]@{ protected=$acl.AreAccessRulesProtected; valid=$valid; rules=$rules.Count } | ConvertTo-Json -Compress",
  ].join("\n");
  const inspected = runAclTool(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", aclScript],
    { NEKO_ACL_TARGET: canonical },
  );
  let acl: any;
  try { acl = JSON.parse(inspected.stdout.trim()); } catch { acl = null; }
  if (inspected.exitCode !== 0 || acl?.protected !== true || acl?.valid !== true || acl?.rules !== 2) {
    throw new Error(
      `Could not verify Harbor private staging ACL (inspect=${inspected.exitCode}, parsed=${Boolean(acl)}, protected=${String(acl?.protected)}, valid=${String(acl?.valid)}, rules=${String(acl?.rules ?? 0)}).`,
    );
  }
  return canonical;
}

function writePrivateJson(path: string, value: any): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

/** Copy the four digest-pinned bridge/control files and one access-token-only ChatGPT lease. */
export function stageHarborHostGrant(input: {
  privateRoot: string;
  sourceRoot: string;
  buildIdentity: HarborBuildIdentity;
  codexStatus: CodexSupportStatus;
  credentials: ChatGptCredentials;
  now?: number;
}): HarborHostGrant {
  const privateRoot = realpathSync.native(resolve(input.privateRoot));
  const sourceRoot = realpathSync.native(resolve(input.sourceRoot));
  const now = input.now ?? Date.now();
  const codex = input.codexStatus.executable;
  if (input.codexStatus.state !== "ready" || !codex || codex.kind !== "app-server") {
    throw new Error("Harbor ChatGPT evaluation requires a native Codex App Server executable.");
  }
  if (!input.buildIdentity.codexSha256 || !input.credentials.accessToken || !input.credentials.accountId
    || !Number.isSafeInteger(input.credentials.expiresAt)
    || input.credentials.expiresAt < now + HARBOR_RUN_DEADLINE_MS + HARBOR_LEASE_MARGIN_MS) {
    throw new Error("ChatGPT credentials cannot cover the bounded Harbor run; start a new evaluation run.");
  }

  const runnerHome = join(privateRoot, "runner-home");
  const bridgePath = join(privateRoot, "bridge");
  const nekoDir = join(runnerHome, ".neko-core");
  for (const directory of [runnerHome, nekoDir, join(runnerHome, "tmp"), join(runnerHome, "AppData", "Roaming"),
    join(runnerHome, "AppData", "Local"), join(bridgePath, "evals", "harbor"), join(bridgePath, "scripts")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(bridgePath, "evals", "__init__.py"), "", { encoding: "ascii", flag: "wx", mode: 0o600 });
  writeFileSync(join(bridgePath, "evals", "harbor", "__init__.py"), "", { encoding: "ascii", flag: "wx", mode: 0o600 });

  const controls = [
    ["evals/harbor/host_runner.ts", input.buildIdentity.runnerSourceSha256],
    ["scripts/harbor-eval.ts", input.buildIdentity.launcherSourceSha256],
    ["evals/harbor/neko_host_agent.py", input.buildIdentity.hostAgentSha256],
    ["evals/harbor/remote_tools.py", input.buildIdentity.remoteToolsSha256],
  ] as const;
  for (const [relative, expected] of controls) {
    const destination = join(bridgePath, ...relative.split("/"));
    copyFileSync(join(sourceRoot, ...relative.split("/")), destination, 0);
    if (stableFileSha256(destination, "staged Harbor bridge", true).sha256 !== expected) {
      throw new Error("Staged Harbor bridge identity does not match the evaluated source.");
    }
  }

  writePrivateJson(join(nekoDir, "chatgpt-auth.json"), {
    accessToken: input.credentials.accessToken,
    refreshToken: "",
    expiresAt: input.credentials.expiresAt,
    accountId: input.credentials.accountId,
  });
  const canonicalCodex = stableFileSha256(codex.path, "selected host Codex executable", false);
  if (canonicalCodex.sha256 !== input.buildIdentity.codexSha256) {
    throw new Error("Selected host Codex identity changed before Harbor launch.");
  }
  writePrivateJson(join(runnerHome, ".neko-harbor-host-grant.json"), {
    schema: "neko.harbor-host-grant.v1",
    profile: "chatgpt",
    codexPath: canonicalCodex.path,
    codexSha256: canonicalCodex.sha256,
    expiresAt: input.credentials.expiresAt,
  });
  return { runnerHome, bridgePath, expiresAt: input.credentials.expiresAt };
}

export function cleanupHarborStaging(
  privateRoot: string,
  buildRoot: string,
  remove: typeof rmSync = rmSync,
  sleep: (milliseconds: number) => void = Bun.sleepSync,
): void {
  const tempParent = realpathSync.native(resolve(tmpdir()));
  const attempts = 8;
  let failed = false;
  for (const [target, prefix] of [[privateRoot, "neko-harbor-private-"], [buildRoot, "neko-harbor-eval-"]] as const) {
    if (!target) continue;
    const absolute = resolve(target);
    if (!samePath(dirname(absolute), tempParent) || !basename(absolute).startsWith(prefix)
      || basename(absolute).length === prefix.length) {
      failed = true;
      continue;
    }
    let removed = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // Bun on Windows currently returns EBUSY immediately instead of honoring rmSync's maxRetries.
        // Keep the retry boundary here so short-lived process and scanner handles can quiesce.
        remove(absolute, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
        removed = true;
        break;
      } catch {
        if (attempt + 1 < attempts) sleep(Math.min(1_000, 250 * (attempt + 1)));
      }
    }
    if (!removed) failed = true;
  }
  if (failed) throw new Error("Harbor temporary staging cleanup failed.");
}

export function resolveHarborExecutables(
  root: string,
  pathValue = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): HarborExecutables {
  const workspace = realpathSync.native(resolve(root));
  const required = (name: string, executable: string | null): string => {
    if (!executable) throw new Error(`Trusted ${name} executable was not found outside the workspace.`);
    return executable;
  };
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    git: required("Git", trustedGitExecutable(workspace, pathValue, platform)),
    docker: required("Docker", executableOnPath(`docker${suffix}`, pathValue, workspace, platform)),
    uvx: required("uvx", executableOnPath(`uvx${suffix}`, pathValue, workspace, platform)),
  };
}

/** Resolve the Windows system plugin root used by `docker compose` without inheriting Docker config. */
export function resolveDockerComposeProgramFiles(
  root: string,
  dockerExecutable: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return undefined;
  const raw = Object.entries(source)
    .find(([key, entry]) => entry !== undefined && key.toUpperCase() === "PROGRAMFILES")?.[1];
  if (!raw || raw.includes("\0") || !win32.isAbsolute(raw)) {
    throw new Error("Docker Compose needs an absolute Windows ProgramFiles locator.");
  }

  let workspace: string;
  let programFiles: string;
  let docker: string;
  let compose: string;
  const composeRequested = win32.join(raw, "Docker", "cli-plugins", "docker-compose.exe");
  try {
    workspace = realpathSync.native(resolve(root));
    programFiles = realpathSync.native(win32.resolve(raw));
    docker = realpathSync.native(win32.resolve(dockerExecutable));
    compose = realpathSync.native(composeRequested);
  } catch {
    throw new Error("The canonical Windows Docker Compose system plugin is unavailable.");
  }

  const within = (base: string, candidate: string): boolean => {
    const relative = win32.relative(base, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${win32.sep}`)
      && !win32.isAbsolute(relative));
  };
  const programFilesStat = lstatSync(programFiles);
  const dockerStat = lstatSync(docker);
  const composeStat = lstatSync(compose);
  if (!programFilesStat.isDirectory() || programFilesStat.isSymbolicLink()
    || !dockerStat.isFile() || dockerStat.isSymbolicLink()
    || !composeStat.isFile() || composeStat.isSymbolicLink()
    || !samePath(composeRequested, compose)
    || !within(programFiles, docker)
    || within(workspace, programFiles) || within(workspace, docker) || within(workspace, compose)) {
    throw new Error("The Windows Docker Compose system plugin failed canonical path validation.");
  }
  return programFiles;
}

export function buildTrustedExecutablePath(
  root: string,
  executables: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  // The values are current-host filesystem paths. `platform` controls lookup/case behavior in
  // tests; it must not make a POSIX runner parse its real temp paths with win32.resolve.
  const paths = process.platform === "win32" ? win32 : posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const workspace = realpathSync.native(resolve(root));
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const executable of executables) {
    if (!paths.isAbsolute(executable)) throw new Error("Trusted executable paths must be absolute.");
    let canonical: string;
    try {
      canonical = realpathSync.native(executable);
    } catch {
      throw new Error("A trusted executable is unavailable.");
    }
    const requested = paths.resolve(executable);
    const pathKey = (value: string) => platform === "win32" ? value.toLowerCase() : value;
    if (pathKey(requested) !== pathKey(canonical) || !lstatSync(canonical).isFile()) {
      throw new Error("Trusted executable paths must name canonical regular files.");
    }
    const fromWorkspace = paths.relative(workspace, canonical);
    if (fromWorkspace === "" || (fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${paths.sep}`)
      && !paths.isAbsolute(fromWorkspace))) {
      throw new Error("Trusted executable paths must stay outside the workspace.");
    }
    const directory = realpathSync.native(paths.dirname(canonical));
    const key = pathKey(directory);
    if (!seen.has(key)) {
      seen.add(key);
      directories.push(directory);
    }
  }
  if (!directories.length) throw new Error("Trusted executable PATH cannot be empty.");
  return directories.join(pathDelimiter);
}

export function gitProvenanceEnv(
  source: NodeJS.ProcessEnv,
  trustedPath: string,
): any {
  if (!trustedPath) throw new Error("Trusted executable PATH cannot be empty.");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value !== undefined && upper !== "PATH" && !upper.startsWith("GIT_")) env[key] = value;
  }
  env.PATH = trustedPath;
  return env;
}

function gitOutput(
  root: string,
  launcherCwd: string,
  gitExecutable: string,
  env: Record<string, string>,
  args: string[],
  label: string,
): string {
  if (!isAbsolute(gitExecutable)) throw new Error("Trusted Git executable path must be absolute.");
  const result = Bun.spawnSync(
    [gitExecutable, "-C", root, ...args],
    { cwd: launcherCwd, env, stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) throw new Error(`Could not collect ${label}.`);
  return result.stdout.toString().trim();
}

export interface CollectBuildIdentityOptions {
  discoverCodex?: () => CodexSupportStatus;
  gitExecutable?: string;
  launcherCwd?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  trustedPath?: string;
}

export function collectBuildIdentity(
  root: string,
  runnerPath: string,
  profile: string,
  options: CollectBuildIdentityOptions = {},
): HarborBuildIdentity {
  const runner = stableFileSha256(runnerPath, "compiled host runner", true);
  if (basename(runner.path) !== HARBOR_HOST_RUNNER_BASENAME) {
    throw new Error(`Compiled host runner basename must be ${HARBOR_HOST_RUNNER_BASENAME}.`);
  }

  const canonicalRoot = realpathSync.native(resolve(root));
  const launcherCwd = realpathSync.native(resolve(options.launcherCwd ?? tmpdir()));
  const paths = process.platform === "win32" ? win32 : posix;
  const relativeCwd = paths.relative(canonicalRoot, launcherCwd);
  if (relativeCwd === "" || (relativeCwd !== ".." && !relativeCwd.startsWith(`..${paths.sep}`)
    && !paths.isAbsolute(relativeCwd))) {
    throw new Error("Git provenance must run from an isolated working directory outside the repository.");
  }
  const git = options.gitExecutable ?? trustedGitExecutable(canonicalRoot);
  if (!git) throw new Error("Trusted Git executable was not found outside the workspace.");
  const gitEnv = gitProvenanceEnv(options.sourceEnv ?? process.env, options.trustedPath ?? dirname(git));
  const topLevelRaw = gitOutput(canonicalRoot, launcherCwd, git, gitEnv, ["rev-parse", "--show-toplevel"], "Git top-level");
  let topLevel: string;
  try {
    topLevel = realpathSync.native(resolve(topLevelRaw));
  } catch {
    throw new Error("Git returned an invalid top-level path.");
  }
  if (!samePath(topLevel, canonicalRoot)) {
    throw new Error("Git top-level does not match the canonical evaluation repository.");
  }
  const sourceRevision = gitOutput(
    canonicalRoot,
    launcherCwd,
    git,
    gitEnv,
    ["rev-parse", "--verify", "HEAD"],
    "source revision",
  );
  if (!/^[a-f0-9]{40,64}$/i.test(sourceRevision)) throw new Error("Git returned an invalid source revision.");
  const sourceDirty = gitOutput(
    canonicalRoot,
    launcherCwd,
    git,
    gitEnv,
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    "source dirty state",
  ).length > 0;

  const control = (relativePath: string, label: string) => stableFileSha256(
    join(canonicalRoot, relativePath),
    label,
    true,
  ).sha256;
  const identity: HarborBuildIdentity = {
    runnerPath: runner.path,
    runnerSha256: runner.sha256,
    runnerSourceSha256: control("evals/harbor/host_runner.ts", "host runner source"),
    launcherSourceSha256: control("scripts/harbor-eval.ts", "Harbor launcher source"),
    hostAgentSha256: control("evals/harbor/neko_host_agent.py", "Harbor host agent bridge"),
    remoteToolsSha256: control("evals/harbor/remote_tools.py", "Harbor remote tools bridge"),
    sourceRevision,
    sourceDirty,
    buildBunVersion: Bun.version,
  };

  if (profile === "chatgpt") {
    const status = (options.discoverCodex ?? discoverCodexSupport)();
    if (status.state !== "ready" || !status.executable) {
      throw new Error(`ChatGPT evaluation needs a ready host Codex App Server (${status.detail}).`);
    }
    identity.codexSha256 = stableFileSha256(
      status.executable.path,
      "selected host Codex executable",
      false,
    ).sha256;
  }
  return identity;
}

function readUserConfig(): any {
  try {
    const value = JSON.parse(readFileSync(join(homedir(), ".neko-core", "config.json"), "utf8"));
    return isObjectValue(value) ? value : {};
  } catch {
    return {};
  }
}

function evalProfileBinding(profile: string): (typeof EVAL_PROFILE_BINDINGS)[HarborEvalProfile] | undefined {
  return Object.hasOwn(EVAL_PROFILE_BINDINGS, profile)
    ? EVAL_PROFILE_BINDINGS[/* SAFETY: hasOwn above proves the key exists in the typed binding map. */ profile as HarborEvalProfile]
    : undefined;
}

function assertEvalIdentity(identity: HarborEvalIdentity): void {
  const binding = evalProfileBinding(identity.profile);
  if (!binding || binding.provider !== identity.provider) {
    throw new Error(`Evaluation profile ${identity.profile} is not bound to provider ${identity.provider}.`);
  }
  if (!identity.model.startsWith(`${binding.modelPrefix}/`) || identity.model.length === binding.modelPrefix.length + 1) {
    throw new Error(`Evaluation profile ${identity.profile} requires a ${binding.modelPrefix}/ model.`);
  }
}

export function resolveEvalIdentity(
  options: HarborEvalOptions,
  config: any = readUserConfig(),
  env: NodeJS.ProcessEnv = process.env,
): HarborEvalIdentity {
  const profile = options.profile?.trim() || env.NEKO_PROFILE?.trim()
    || String(config.active_profile ?? "").trim();
  if (!profile) throw new Error("No active Neko profile. Pass --profile <name>.");
  const binding = evalProfileBinding(profile);
  if (!binding) throw new Error(`Evaluation profile ${profile} is not allowed; use chatgpt or kimi.`);
  const configuredProvider = String(config.profiles?.[profile]?.provider ?? "").trim();
  if (configuredProvider && configuredProvider !== binding.provider) {
    throw new Error(`Evaluation profile ${profile} must use provider ${binding.provider}.`);
  }
  const configuredModel = String(config.profiles?.[profile]?.model ?? "").trim();
  let model = options.model?.trim() || configuredModel || binding.defaultModel;
  if (!model.includes("/")) model = `${binding.modelPrefix}/${model}`;
  const identity: HarborEvalIdentity = {
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    profile: profile as HarborEvalProfile,
    provider: binding.provider,
    model,
  };
  assertEvalIdentity(identity);
  return identity;
}

export function buildHarborArgs(input: {
  options: HarborEvalOptions;
  profile: HarborEvalProfile;
  provider: HarborEvalIdentity["provider"];
  model: string;
  buildIdentity: HarborBuildIdentity;
  jobsDir: string;
}): string[] {
  assertEvalIdentity(input);
  if (!isAbsolute(input.jobsDir)) throw new Error("Harbor jobs directory must be absolute.");
  const args = [
    "--isolated", "--no-env-file", "--no-config",
    "--from", `harbor==${HARBOR_VERSION}`, "harbor", "run",
    "--jobs-dir", input.jobsDir,
    "-d", TERMINAL_BENCH_2_1_DATASET,
    "-a", "evals.harbor.neko_host_agent:NekoHostAgent",
    "-l", String(input.options.limit),
    "--agent-kwarg", `runner_path=${input.buildIdentity.runnerPath}`,
    "--agent-kwarg", `runner_sha256=${input.buildIdentity.runnerSha256}`,
    "--agent-kwarg", `runner_source_sha256=${input.buildIdentity.runnerSourceSha256}`,
    "--agent-kwarg", `launcher_source_sha256=${input.buildIdentity.launcherSourceSha256}`,
    "--agent-kwarg", `host_agent_sha256=${input.buildIdentity.hostAgentSha256}`,
    "--agent-kwarg", `remote_tools_sha256=${input.buildIdentity.remoteToolsSha256}`,
    "--agent-kwarg", `profile=${input.profile}`,
    "--agent-kwarg", `reasoning_effort=${input.options.reasoningEffort}`,
    "--agent-kwarg", `max_steps=${input.options.maxSteps}`,
    "--agent-kwarg", `adaptive_effort=${input.options.adaptiveEffort}`,
    "--agent-kwarg", `loop=${input.options.loop}`,
    "--agent-kwarg", `source_revision=${input.buildIdentity.sourceRevision}`,
    "--agent-kwarg", `source_dirty=${input.buildIdentity.sourceDirty}`,
    "--agent-kwarg", `build_bun_version=${input.buildIdentity.buildBunVersion}`,
    "--agent-kwarg", `harbor_version=${HARBOR_VERSION}`,
    "--agent-kwarg", `dataset_request=${TERMINAL_BENCH_2_1_DATASET}`,
    "-m", input.model,
  ];
  if (input.buildIdentity.codexSha256) {
    args.push("--agent-kwarg", `codex_sha256=${input.buildIdentity.codexSha256}`);
  }
  args.push(...input.options.passthrough);
  return args;
}

export function harborProcessEnv(
  source: NodeJS.ProcessEnv,
  trustedPath: string,
  runtimeRoot: string,
  grant?: HarborHostGrant,
  dockerProgramFiles?: string,
): any {
  if (!trustedPath) throw new Error("Trusted executable PATH cannot be empty.");
  const runtime = realpathSync.native(resolve(runtimeRoot));
  const value = (name: string): any => {
    const match = Object.entries(source).find(([key, entry]) => entry !== undefined && key.toUpperCase() === name);
    return match?.[1];
  };
  const env: any = {
    PATH: trustedPath,
    HOME: runtime,
    USERPROFILE: runtime,
    TEMP: join(runtime, "tmp"),
    TMP: join(runtime, "tmp"),
    APPDATA: join(runtime, "AppData", "Roaming"),
    LOCALAPPDATA: join(runtime, "AppData", "Local"),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    const allowed = value(name);
    if (allowed !== undefined) env[name === "SYSTEMROOT" ? "SystemRoot" : name] = allowed;
  }
  if (dockerProgramFiles !== undefined) {
    const requested = resolve(dockerProgramFiles);
    const canonical = realpathSync.native(requested);
    const stat = lstatSync(canonical);
    if (!samePath(requested, canonical) || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Docker ProgramFiles must be a canonical directory.");
    }
    env.ProgramFiles = canonical;
  }
  if (grant) {
    env.PYTHONPATH = grant.bridgePath;
    env[HARBOR_RUNNER_HOME_ENV] = grant.runnerHome;
  }
  return env;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  quiet: boolean,
  env: Record<string, string>,
): Promise<number> {
  if (!isAbsolute(command)) throw new Error("Harbor launcher refuses a non-absolute executable path.");
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return child.exited;
}

export async function preflightDockerCompose(
  command: string,
  cwd: string,
  env: Record<string, string>,
  execute: (
    command: string,
    args: string[],
    cwd: string,
    quiet: boolean,
    env: Record<string, string>,
  ) => Promise<number> = run,
): Promise<void> {
  if (await execute(command, ["compose", "version"], cwd, true, env) !== 0) {
    throw new Error("Docker Compose is unavailable under the credential-safe Harbor environment.");
  }
}

async function main(): Promise<number> {
  const root = realpathSync.native(resolve(import.meta.dir, ".."));
  const options = parseHarborEvalArgs(process.argv.slice(2));
  const executables = resolveHarborExecutables(root);
  const evalIdentity = resolveEvalIdentity(options);
  if (evalIdentity.profile !== "chatgpt") {
    throw new Error("The credential-safe Harbor pilot currently supports only the chatgpt OAuth profile.");
  }
  let codexStatus: CodexSupportStatus | undefined;
  codexStatus = discoverCodexSupport({ cwd: root });
  if (codexStatus.state !== "ready" || !codexStatus.executable || codexStatus.executable.kind !== "app-server") {
    throw new Error(`ChatGPT evaluation needs a ready native host Codex App Server (${codexStatus.detail}).`);
  }

  const optionalNode = executableOnPath(
    process.platform === "win32" ? "node.exe" : "node",
    process.env.PATH ?? "",
    root,
  );
  const optionalWindowsSystem = process.platform === "win32"
    ? resolveWindowsSystemExecutable("cmd.exe")
    : null;
  const trustedPath = buildTrustedExecutablePath(root, [
    ...(optionalNode ? [optionalNode] : []),
    realpathSync.native(process.execPath),
    executables.git,
    executables.docker,
    executables.uvx,
    ...(optionalWindowsSystem ? [optionalWindowsSystem] : []),
  ]);
  const dockerProgramFiles = resolveDockerComposeProgramFiles(root, executables.docker);
  const buildRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-eval-")));
  let privateRoot = "";
  try {
    privateRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-private-")));
    hardenPrivateHarborRoot(privateRoot);
    const runtimeRoot = join(buildRoot, "runtime");
    for (const directory of [runtimeRoot, join(runtimeRoot, "tmp"), join(runtimeRoot, "AppData", "Roaming"),
      join(runtimeRoot, "AppData", "Local")]) mkdirSync(directory, { recursive: true });
    const buildEnv = harborProcessEnv(process.env, trustedPath, runtimeRoot, undefined, dockerProgramFiles);
    if (await run(
      executables.docker,
      ["info", "--format", "{{.ServerVersion}}"],
      buildRoot,
      true,
      buildEnv,
    ) !== 0) {
      throw new Error("Docker Desktop is not running.");
    }
    await preflightDockerCompose(executables.docker, buildRoot, buildEnv);

    const runnerPath = join(buildRoot, HARBOR_HOST_RUNNER_BASENAME);
    console.log("Building the credential-safe Harbor host runner...");
    const built = await run(process.execPath, [
      "build",
      join(root, "evals", "harbor", "host_runner.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      `--outfile=${runnerPath}`,
    ], buildRoot, false, buildEnv);
    if (built !== 0) return built;

    const buildIdentity = collectBuildIdentity(
      root,
      runnerPath,
      evalIdentity.profile,
      {
        discoverCodex: codexStatus ? () => codexStatus! : undefined,
        gitExecutable: executables.git,
        launcherCwd: buildRoot,
        sourceEnv: buildEnv,
        trustedPath,
      },
    );
    // Refresh the durable credential before deriving the lease. The staged copy deliberately omits
    // the refresh token, so no process in the Harbor run can rotate the durable token afterward.
    const credentials = await validChatGptCredentials(fetch, undefined, true);
    const grant = stageHarborHostGrant({
      privateRoot,
      sourceRoot: root,
      buildIdentity,
      codexStatus,
      credentials,
    });
    const launcherEnv = harborProcessEnv(process.env, trustedPath, runtimeRoot, grant, dockerProgramFiles);
    console.log(
      `Running ${options.limit} public task(s): profile=${evalIdentity.profile}, model=${evalIdentity.model}, `
      + `effort=${options.reasoningEffort}, max_steps=${options.maxSteps}, adaptive=${options.adaptiveEffort}, `
      + `loop=${options.loop}, Harbor=${HARBOR_VERSION}`,
    );
    console.log(
      `Host runner sha256=${buildIdentity.runnerSha256}; source=${buildIdentity.sourceRevision}`
      + `${buildIdentity.sourceDirty ? " (dirty)" : ""}`,
    );
    if (buildIdentity.codexSha256) console.log(`Selected host Codex sha256=${buildIdentity.codexSha256}`);
    console.log("Provider credentials and Codex stay on the host; the task receives only framed native tool calls.");
    return await run(
      executables.uvx,
      buildHarborArgs({ options, buildIdentity, jobsDir: join(root, "jobs"), ...evalIdentity }),
      buildRoot,
      false,
      launcherEnv,
    );
  } finally {
    cleanupHarborStaging(privateRoot, buildRoot);
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`harbor-eval: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
