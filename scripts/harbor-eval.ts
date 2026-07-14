/** Build the real Linux Neko binary and evaluate it with Harbor/Terminal-Bench 2. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface HarborEvalOptions {
  profile?: string;
  model?: string;
  authPath?: string;
  dataset: string;
  limit: number;
  noBuild: boolean;
  passthrough: string[];
}

const DEFAULT_MODELS: Record<string, string> = {
  chatgpt: "openai/gpt-5.5",
  kimi: "kimi/kimi-for-coding",
};

const MODEL_PROVIDERS: Record<string, string> = {
  chatgpt: "openai",
  kimi: "kimi",
};

const AUTH_FILES: Record<string, string> = {
  chatgpt: "chatgpt-auth.json",
  kimi: "kimi-auth.json",
};

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) throw new Error(`${flag} needs a value.`);
  return value;
}

function normalizePassthrough(args: string[], dataset: string): string[] {
  const out = [...args];
  if (dataset !== "terminal-bench/terminal-bench-2") return out;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== "--include-task-name") continue;
    const name = valueAfter(out, i, out[i]);
    if (!name.includes("/")) out[i + 1] = `terminal-bench/${name}`;
    i++;
  }
  return out;
}

export function parseHarborEvalArgs(argv: string[]): HarborEvalOptions {
  const options: HarborEvalOptions = {
    dataset: "terminal-bench/terminal-bench-2",
    limit: 1,
    noBuild: false,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.passthrough = normalizePassthrough(argv.slice(i + 1), options.dataset);
      break;
    }
    if (arg === "--profile") options.profile = valueAfter(argv, i++, arg);
    else if (arg === "--model") options.model = valueAfter(argv, i++, arg);
    else if (arg === "--auth-path") options.authPath = valueAfter(argv, i++, arg);
    else if (arg === "--dataset") options.dataset = valueAfter(argv, i++, arg);
    else if (arg === "--limit") {
      options.limit = Number(valueAfter(argv, i++, arg));
      if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("--limit must be a positive integer.");
    } else if (arg === "--no-build") options.noBuild = true;
    else throw new Error(`Unknown option ${arg}. Put raw Harbor options after --.`);
  }
  return options;
}

function readUserConfig(): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(join(homedir(), ".neko-core", "config.json"), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function resolveEvalIdentity(options: HarborEvalOptions): { profile: string; model?: string; authPath?: string } {
  const config = readUserConfig();
  const profile = options.profile ?? process.env.NEKO_PROFILE?.trim() ?? String(config.active_profile ?? "").trim();
  if (!profile) throw new Error("No active Neko profile. Pass --profile <name>.");
  const configuredModel = String(config.profiles?.[profile]?.model ?? "").trim();
  let model = options.model ?? (configuredModel || DEFAULT_MODELS[profile]);
  if (model && !model.includes("/") && MODEL_PROVIDERS[profile]) model = `${MODEL_PROVIDERS[profile]}/${model}`;

  let authPath = options.authPath;
  const authFile = AUTH_FILES[profile];
  if (!authPath && authFile) authPath = join(homedir(), ".neko-core", authFile);
  if (authFile && (!authPath || !existsSync(authPath))) {
    throw new Error(`Profile ${profile} is not signed in. Run \`neko login ${profile}\` first.`);
  }
  return { profile, model, authPath: authPath ? resolve(authPath) : undefined };
}

export function buildHarborArgs(input: {
  options: HarborEvalOptions;
  binaryPath: string;
  profile: string;
  model?: string;
}): string[] {
  const args = [
    "harbor", "run",
    "-d", input.options.dataset,
    "-a", "evals.harbor.neko_agent:NekoAgent",
    "-l", String(input.options.limit),
    "--agent-kwarg", `binary_path=${input.binaryPath}`,
    "--agent-kwarg", `profile=${input.profile}`,
  ];
  if (input.model) args.push("-m", input.model);
  args.push(...input.options.passthrough);
  return args;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  quiet = false,
  env?: Record<string, string | undefined>,
): Promise<number> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdin: "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  return child.exited;
}

async function main(): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  const options = parseHarborEvalArgs(process.argv.slice(2));
  const identity = resolveEvalIdentity(options);
  const binaryPath = join(root, "tmp", "harbor-eval", "neko-linux-x64");

  if (!options.noBuild) {
    if (await run("docker", ["info", "--format", "{{.ServerVersion}}"], root, true) !== 0) {
      throw new Error("Docker Desktop is not running.");
    }
    mkdirSync(join(root, "tmp", "harbor-eval"), { recursive: true });
    console.log("Building the Neko working tree for Linux...");
    const built = await run("docker", [
      "run", "--rm", "-v", `${root}:/work`, "-w", "/work",
      `oven/bun:${Bun.version}`, "bun", "scripts/build.ts",
      "--outfile=tmp/harbor-eval/neko-linux-x64",
    ], root);
    if (built !== 0) return built;
  }
  if (!existsSync(binaryPath)) throw new Error(`Missing Linux binary: ${binaryPath}`);

  console.log(`Running ${options.limit} public task(s): profile=${identity.profile}, model=${identity.model ?? "profile default"}`);
  console.log("OAuth credentials, when used, are copied only into each ephemeral task container.");
  return run("uvx", buildHarborArgs({ options, binaryPath, ...identity }), root, false, {
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    NEKO_HARBOR_AUTH_PATH: identity.authPath,
  });
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`harbor-eval: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
