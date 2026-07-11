/**
 * Scaffold the local config files (config-first). `neko init-user` writes the
 * claude.json-style ~/.neko-core/config.json; `neko init` writes a project-local
 * ./.neko-core/config.json. Neither is committed (both gitignored). Env vars override.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { dirname, join } from "node:path";

import { LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME } from "./config.ts";

const userConfigPath = () => join(homeDir(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME);

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
  // Atomic: this file holds the API key — a crash mid-write must never truncate it into invalid JSON
  // (readUserConfig would then throw on every subsequent settings change). temp + rename = all-or-nothing.
  atomicWriteFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** Save the API key to ~/.neko-core/config.json (used by /login). The key belongs to a PROVIDER, so it's
 * saved to the ACTIVE profile's api_key (that profile's endpoint) — never the top-level field, which would
 * override every profile's key and get sent to the wrong endpoint (the classic "pasted a Z.ai key while on
 * the NVIDIA profile -> 401" trap). Falls back to top-level only when no profile is active. */
export function setApiKey(key: string): string {
  try {
    let target = "the top-level key";
    updateUserConfig((d: any) => {
      const active = typeof d.active_profile === "string" ? d.active_profile : "";
      if (active) {
        if (!d.profiles || typeof d.profiles !== "object") d.profiles = {};
        if (!d.profiles[active] || typeof d.profiles[active] !== "object") d.profiles[active] = {};
        d.profiles[active].api_key = key.trim();
        target = `profile "${active}"`;
      } else {
        d.api_key = key.trim();
      }
    });
    return `API key saved to ${target} in ~/.neko-core/config.json`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Persist the chosen model so the NEXT session (and new folders) start with it too. With an active
 * profile the model belongs to THAT profile - a top-level `model` would shadow EVERY profile's preset
 * (the /model footgun doctor warns about), so writing here also clears any legacy top-level value. */
export function setModel(model: string, profile?: string | null, contextWindow?: number, vision?: boolean): void {
  updateUserConfig((d) => {
    if (profile) {
      d.profiles ??= {};
      d.profiles[profile] ??= {};
      d.profiles[profile].model = model.trim();
      if (Number.isFinite(contextWindow) && contextWindow! > 0) {
        d.profiles[profile].model_context ??= {};
        d.profiles[profile].model_context[model.trim()] = contextWindow;
      }
      if (typeof vision === "boolean") d.profiles[profile].vision = vision;
      delete d.model; // a stale top-level model would keep shadowing every profile
    } else {
      d.model = model.trim();
      if (Number.isFinite(contextWindow) && contextWindow! > 0) {
        d.model_context ??= {};
        d.model_context[model.trim()] = contextWindow;
      }
      if (typeof vision === "boolean") d.vision = vision;
    }
  });
}

/** Hold (or resume) auto-install of newer releases. Rolling BACK to an older version writes
 * `auto_update: false` so the daily updater can't drag the user forward again - and that flag is
 * honored by every release since 0.7.4 (the version they roll back TO), so the pin actually STICKS.
 * `neko update` (to latest) sets it true again. Never throws on a missing config (writes a fresh one). */
export function setAutoUpdate(on: boolean): void {
  try { updateUserConfig((d: any) => { d.auto_update = on; }); } catch { /* malformed config - leave it for the user to fix */ }
}

/** Persist the active provider profile so `neko` uses it by default — no --profile flag, no config editing.
 * Also drops any stray top-level model/api_key so the profile's own endpoint+key+model take effect cleanly. */
export function setActiveProfile(name: string): void {
  updateUserConfig((d: any) => {
    const previous = typeof d.active_profile === "string" ? d.active_profile : "";
    if (previous && d.api_key) {
      if (!d.profiles || typeof d.profiles !== "object") d.profiles = {};
      if (!d.profiles[previous] || typeof d.profiles[previous] !== "object") d.profiles[previous] = {};
      if (!d.profiles[previous].api_key) d.profiles[previous].api_key = d.api_key;
    }
    d.active_profile = name;
    delete d.model;
    delete d.api_key;
  });
}

/** Persist the chosen reasoning effort across sessions ("" / off clears it). */
export function setEffort(effort: string): void {
  updateUserConfig((d) => {
    if (effort && effort !== "off") d.reasoning_effort = effort;
    else delete d.reasoning_effort;
  });
}

/** Remove the saved API key (used by /logout). Env keys are cleared by the caller. Removes the ACTIVE
 * profile's key AND any stray top-level key (so an old top-level key can't keep shadowing the profile). */
export function clearApiKey(profile?: string): string {
  try {
    const data = readUserConfig() as any;
    const active = profile ?? (typeof data.active_profile === "string" ? data.active_profile : "");
    let removed = "";
    if (active && data.profiles && data.profiles[active] && data.profiles[active].api_key) {
      delete data.profiles[active].api_key;
      removed = `profile "${active}"`;
    }
    if (data.api_key) { delete data.api_key; removed = removed ? `${removed} + top-level` : "top-level key"; }
    if (!removed) return "no saved API key in ~/.neko-core/config.json";
    writeUserConfig(data);
    return `API key removed from ${removed} in ~/.neko-core/config.json`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Merge top-level keys into the user config (preserves api_key / mcp_servers / etc.). Key-safe. */
export function patchUserConfig(patch: Record<string, any>): void {
  updateUserConfig((d) => { for (const [k, v] of Object.entries(patch)) d[k] = v; });
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
  profiles: { nvidia: { api_key: "" } },
  model: "",
  _hint: "Paste your key in profiles.nvidia.api_key (or use /login / set NEKO_API_KEY). List profiles with `neko profiles`.",
};

const PROJECT_TEMPLATE = {
  _comment:
    "Neko Core project-local config. Overrides ~/.neko-core for this repo. Gitignored. " +
    "Keep secrets out of it; prefer env vars for keys.",
  active_profile: "nvidia",
};

export function initUser(force = false): string {
  return write(join(homeDir(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME), USER_TEMPLATE, force);
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
