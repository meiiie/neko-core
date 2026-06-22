/**
 * Scaffold the local config files (config-first). `neko init-user` writes the
 * claude.json-style ~/.neko-core/config.json; `neko init` writes a project-local
 * ./.neko-core/config.json. Neither is committed (both gitignored). Env vars override.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME } from "./config.ts";

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

export function initProject(force = false): string {
  return write(join(process.cwd(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME), PROJECT_TEMPLATE, force);
}

function write(target: string, template: unknown, force: boolean): string {
  if (existsSync(target) && !force) {
    return `Existing config kept: ${target} (use --force to overwrite)`;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(template, null, 2) + "\n", "utf-8");
  return `Config ready: ${target}`;
}
