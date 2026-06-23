/**
 * Scaffold the local config files (config-first). `neko init-user` writes the
 * claude.json-style ~/.neko-core/config.json; `neko init` writes a project-local
 * ./.neko-core/config.json. Neither is committed (both gitignored). Env vars override.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME } from "./config.ts";

const userConfigPath = () => join(homedir(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME);

function readUserConfig(): Record<string, any> {
  const path = userConfigPath();
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    /* start fresh */
  }
  return {};
}

function writeUserConfig(data: Record<string, any>): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Save the API key to ~/.neko-core/config.json (used by /login). */
export function setApiKey(key: string): string {
  const data = readUserConfig();
  data.api_key = key.trim();
  writeUserConfig(data);
  return "API key saved to ~/.neko-core/config.json";
}

/** Remove the saved API key (used by /logout). Env keys are cleared by the caller. */
export function clearApiKey(): string {
  const data = readUserConfig();
  if (!data.api_key) return "no saved API key in ~/.neko-core/config.json";
  delete data.api_key;
  writeUserConfig(data);
  return "API key removed from ~/.neko-core/config.json";
}

/** Add/replace an MCP server in the user config (~/.neko-core/config.json). */
export function addMcpServer(name: string, server: Record<string, any>): string {
  const path = userConfigPath();
  let data: Record<string, any> = {};
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    /* start fresh */
  }
  data.mcp_servers = data.mcp_servers ?? {};
  data.mcp_servers[name] = server;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return `Added MCP server '${name}' to ${path}. Run \`neko mcp\` to verify.`;
}

/** Remove an MCP server from the user config. */
export function removeMcpServer(name: string): string {
  const path = userConfigPath();
  if (!existsSync(path)) return "no user config (~/.neko-core/config.json)";
  let data: Record<string, any>;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return "could not read user config";
  }
  if (!data.mcp_servers?.[name]) return `no MCP server '${name}'`;
  delete data.mcp_servers[name];
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return `Removed MCP server '${name}'`;
}

const USER_TEMPLATE = {
  _comment:
    "Neko Core user config (like ~/.claude.json). Put your API key + chosen profile here. " +
    "NEVER commit this file. Env vars NEKO_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY override api_key.",
  active_profile: "nvidia",
  api_key: "",
  model: "",
  _hint: "Paste your key in api_key (or set NEKO_API_KEY). Set model to your endpoint's model id. List profiles with `neko profiles`.",
};

const PROJECT_TEMPLATE = {
  _comment:
    "Neko Core project-local config. Overrides ~/.neko-core for this repo. Gitignored. " +
    "Keep secrets out of it; prefer env vars for keys.",
  active_profile: "nvidia",
};

export function initUser(force = false): string {
  return write(join(homedir(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME), USER_TEMPLATE, force);
}

function nekoMdTemplate(name: string): string {
  return `# ${name} — notes for Neko

What this project is, how to run it, and the conventions Neko should follow. Neko loads this
file (and any NEKO.md up to the repo root, plus ~/.neko-core/NEKO.md) into its context.

## Commands
- build:
- test:

## Conventions
-

## Memory
`;
}

export function initProject(force = false): string {
  const cfgMsg = write(join(process.cwd(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME), PROJECT_TEMPLATE, force);
  const nekoMd = join(process.cwd(), "NEKO.md");
  let mdMsg: string;
  if (existsSync(nekoMd) && !force) {
    mdMsg = `NEKO.md kept: ${nekoMd}`;
  } else {
    const name = process.cwd().replace(/\\/g, "/").split("/").pop() || "project";
    writeFileSync(nekoMd, nekoMdTemplate(name), "utf-8");
    mdMsg = `NEKO.md ready: ${nekoMd}`;
  }
  return `${cfgMsg}\n${mdMsg}`;
}

function write(target: string, template: unknown, force: boolean): string {
  if (existsSync(target) && !force) {
    return `Existing config kept: ${target} (use --force to overwrite)`;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(template, null, 2) + "\n", "utf-8");
  return `Config ready: ${target}`;
}
