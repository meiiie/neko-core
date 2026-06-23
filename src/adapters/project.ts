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
  if (!existsSync(path)) return {};
  // A parse failure must NOT silently become {} here: every caller writes this back, so that would
  // overwrite a (recoverable) malformed config and destroy the user's api_key / mcp_servers. Throw
  // instead, so the writer aborts and the file is left intact for the user to fix.
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`~/.neko-core/config.json has invalid JSON - fix it before changing settings (${(e as Error).message})`);
  }
}

/** Read-modify-write that aborts (never overwrites) if the existing config is malformed. */
function updateUserConfig(mutate: (data: Record<string, any>) => void): void {
  const data = readUserConfig();
  mutate(data);
  writeUserConfig(data);
}

function writeUserConfig(data: Record<string, any>): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Save the API key to ~/.neko-core/config.json (used by /login). */
export function setApiKey(key: string): string {
  try {
    updateUserConfig((d) => { d.api_key = key.trim(); });
    return "API key saved to ~/.neko-core/config.json";
  } catch (e) {
    return (e as Error).message;
  }
}

/** Persist the chosen model so the NEXT session (and new folders) start with it too. */
export function setModel(model: string): void {
  updateUserConfig((d) => { d.model = model.trim(); });
}

/** Persist the chosen reasoning effort across sessions ("" / off clears it). */
export function setEffort(effort: string): void {
  updateUserConfig((d) => {
    if (effort && effort !== "off") d.reasoning_effort = effort;
    else delete d.reasoning_effort;
  });
}

/** Remove the saved API key (used by /logout). Env keys are cleared by the caller. */
export function clearApiKey(): string {
  try {
    const data = readUserConfig();
    if (!data.api_key) return "no saved API key in ~/.neko-core/config.json";
    delete data.api_key;
    writeUserConfig(data);
    return "API key removed from ~/.neko-core/config.json";
  } catch (e) {
    return (e as Error).message;
  }
}

/** Add/replace an MCP server in the user config (~/.neko-core/config.json). */
export function addMcpServer(name: string, server: Record<string, any>): string {
  try {
    updateUserConfig((d) => {
      d.mcp_servers = d.mcp_servers ?? {};
      d.mcp_servers[name] = server;
    });
    return `Added MCP server '${name}' to ${userConfigPath()}. Run \`neko mcp\` to verify.`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Remove an MCP server from the user config. */
export function removeMcpServer(name: string): string {
  if (!existsSync(userConfigPath())) return "no user config (~/.neko-core/config.json)";
  let data: Record<string, any>;
  try {
    data = readUserConfig();
  } catch (e) {
    return (e as Error).message;
  }
  if (!data.mcp_servers?.[name]) return `no MCP server '${name}'`;
  delete data.mcp_servers[name];
  writeUserConfig(data);
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
