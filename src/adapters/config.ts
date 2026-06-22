/**
 * Config-first runtime for Neko Core (TypeScript).
 *
 * Behaviour is data, not code. Config resolves by overlaying, lowest precedence first:
 *   1. built-in defaults (DEFAULTS, below)
 *   2. ~/.neko-core/config.json        (user-global, claude.json-style home file)
 *   3. ./.neko-core/config.json        (project-local, wins over user)
 *   4. the active profile's keys        (pick with --profile / NEKO_PROFILE)
 *   5. NEKO_* environment variables     (win last)
 *
 * Secrets never live in tracked config: the API key is read on demand from the
 * environment (NEKO_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY) or the gitignored
 * ~/.neko-core/config.json "api_key" field — never stored in the printable `data`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isMode, type PermissionMode } from "../core/permissions.ts";

export const LOCAL_CONFIG_DIR = ".neko-core";
export const LOCAL_CONFIG_NAME = "config.json";

export interface Profile {
  provider?: string;
  base_url?: string;
  model?: string;
}

export const DEFAULTS: Record<string, any> = {
  provider: "openai_compat",
  model: "",
  base_url: "https://integrate.api.nvidia.com/v1",
  max_steps: 20,
  temperature: 0,
  max_tokens: 2048,
  timeout_seconds: 120,
  max_retries: 4,
  retry_base_delay_seconds: 1.5,
  retry_max_delay_seconds: 30,
  approval: "prompt", // prompt | auto (--yolo flips gated tools to auto)
  mcp_servers: {}, // name -> { command, args?, env? } for stdio MCP servers
  active_profile: null,
  profiles: {
    // A new model/endpoint is a data edit, not a code change. "Offline" = point a
    // profile at a local OpenAI-compatible server (llama-server :8080, Ollama :11434).
    nvidia: { provider: "openai_compat", base_url: "https://integrate.api.nvidia.com/v1", model: "" },
    openai: { provider: "openai_compat", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    local: { provider: "openai_compat", base_url: "http://127.0.0.1:8080/v1", model: "local-model" },
  },
};

export class NekoConfig {
  constructor(
    /** printable, profile-merged, env-overridden settings (no secrets) */
    public readonly data: Record<string, any>,
    public readonly profile: string | null,
    public readonly profiles: Record<string, Profile>,
    private readonly apiKeyFromFile: string,
  ) {}

  get provider(): string { return String(this.data.provider ?? "openai_compat"); }
  get model(): string { return String(this.data.model ?? "").trim(); }
  get baseUrl(): string { return String(this.data.base_url ?? "").replace(/\/+$/, ""); }
  get maxSteps(): number { return Math.max(1, Number(this.data.max_steps ?? 20)); }
  get temperature(): number { return Number(this.data.temperature ?? 0); }
  get maxTokens(): number { return Number(this.data.max_tokens ?? 2048); }
  get contextWindow(): number { return Number(this.data.context_window ?? 131072); }
  /** Reasoning effort (low|medium|high) sent as `reasoning_effort`; "" = omit (default). */
  get effort(): string { return String(this.data.reasoning_effort ?? "").trim().toLowerCase(); }
  get timeoutSeconds(): number { return Number(this.data.timeout_seconds ?? 120); }
  get maxRetries(): number { return Math.max(0, Number(this.data.max_retries ?? 4)); }
  get retryBaseDelaySeconds(): number { return Number(this.data.retry_base_delay_seconds ?? 1.5); }
  get retryMaxDelaySeconds(): number { return Number(this.data.retry_max_delay_seconds ?? 30); }

  get approval(): "prompt" | "auto" {
    const v = String(this.data.approval ?? "prompt").trim().toLowerCase();
    return v === "auto" ? "auto" : "prompt";
  }

  /** Permission mode: explicit `mode` in config, else derived from legacy `approval`. */
  get mode(): PermissionMode {
    const raw = String(this.data.mode ?? "").trim().toLowerCase();
    if (isMode(raw)) return raw;
    return this.approval === "auto" ? "auto" : "default";
  }

  /** Declared MCP servers (stdio): name -> { command, args?, env? }. */
  get mcpServers(): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
    const raw = this.data.mcp_servers;
    return raw && typeof raw === "object" ? raw : {};
  }

  /** Read on demand; NEVER stored in `data` (so it can't leak via `neko config`). */
  get apiKey(): string {
    return (
      process.env.NEKO_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.NVIDIA_API_KEY ||
      this.apiKeyFromFile
    ).trim();
  }
}

export function loadConfig(opts: { path?: string; profile?: string } = {}): NekoConfig {
  let merged: Record<string, any> = structuredClone(DEFAULTS);
  if (opts.path) {
    merged = mergeDeep(merged, readOverlay(opts.path));
  } else {
    merged = mergeDeep(merged, readOverlay(join(homedir(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME)));
    merged = mergeDeep(merged, readOverlay(join(process.cwd(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME)));
  }

  const profiles: Record<string, Profile> =
    merged.profiles && typeof merged.profiles === "object" ? structuredClone(merged.profiles) : {};

  // Profile selection precedence: explicit arg > NEKO_PROFILE > config active_profile.
  const selected =
    (opts.profile || process.env.NEKO_PROFILE?.trim() || merged.active_profile || "").trim() || null;
  if (selected) {
    if (!(selected in profiles)) {
      const available = Object.keys(profiles).sort().join(", ") || "none";
      throw new Error(`Unknown profile '${selected}'. Available: ${available}`);
    }
    merged = mergeDeep(merged, profiles[selected]);
  }

  // Pull the file-provided key out before building the printable dict (never printed).
  const apiKeyFromFile = String(merged.api_key ?? "");
  delete merged.api_key;
  delete merged.profiles;
  delete merged.active_profile;

  // NEKO_* env overrides win last (except the secret/profile keys handled above).
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("NEKO_")) continue;
    const suffix = key.slice("NEKO_".length);
    if (suffix === "API_KEY" || suffix === "PROFILE") continue;
    merged[suffix.toLowerCase()] = value;
  }

  return new NekoConfig(merged, selected, profiles, apiKeyFromFile);
}

function readOverlay(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in config ${path}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config ${path} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

function mergeDeep(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeDeep(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
