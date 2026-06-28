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
import { homeDir } from "../shared/home.ts";
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
  max_steps: 40,
  temperature: 0,
  max_tokens: 8192, // headroom so a large file write isn't truncated mid-tool-call (was 2048)
  timeout_seconds: 120,
  max_retries: 4,
  retry_base_delay_seconds: 1.5,
  retry_max_delay_seconds: 30,
  offline_retry_seconds: 1800, // keep retrying a dropped connection (laptop slept) for up to 30 min
  approval: "prompt", // prompt | auto (--yolo flips gated tools to auto)
  effort_ceiling: "high", // highest reasoning_effort the endpoint accepts (OpenAI standard caps at high); a profile can raise it
  auto_update_check: true, // notify on a newer release at startup (daily-cached; set false to silence)
  mcp_servers: {}, // name -> { command, args?, env? } for stdio MCP servers
  active_profile: null,
  profiles: {
    // A new model/endpoint is a data edit, not a code change. "Offline" = point a
    // profile at a local OpenAI-compatible server (llama-server :8080, Ollama :11434).
    nvidia: { provider: "openai_compat", base_url: "https://integrate.api.nvidia.com/v1", model: "" },
    openai: { provider: "openai_compat", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    // Most hosted providers are OpenAI-compatible -> a profile, not new code. Set your model with /model.
    groq: { provider: "openai_compat", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
    deepseek: { provider: "openai_compat", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    mistral: { provider: "openai_compat", base_url: "https://api.mistral.ai/v1", model: "mistral-large-latest" },
    together: { provider: "openai_compat", base_url: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    fireworks: { provider: "openai_compat", base_url: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
    xai: { provider: "openai_compat", base_url: "https://api.x.ai/v1", model: "grok-2-latest" },
    openrouter: { provider: "openai_compat", base_url: "https://openrouter.ai/api/v1", model: "" },
    // Mixture-of-Agents: diverse advisors analyze, a strong aggregator synthesizes + acts. `neko
    // --profile moa`. Opt-in quality mode (N+1 model calls/turn) — best where one model is weak.
    moa: {
      provider: "moa",
      base_url: "https://integrate.api.nvidia.com/v1",
      moa: { references: ["deepseek-ai/deepseek-v4-pro", "meta/llama-3.3-70b-instruct"], aggregator: "openai/gpt-oss-120b" },
    },
    // Local servers (no API key needed):
    ollama: { provider: "openai_compat", base_url: "http://localhost:11434/v1", model: "llama3.2" },
    lmstudio: { provider: "openai_compat", base_url: "http://localhost:1234/v1", model: "local-model" },
    local: { provider: "openai_compat", base_url: "http://127.0.0.1:8080/v1", model: "local-model" },
  },
};

export interface MoaRef { model: string; profile?: string }
export interface MoaConfig {
  references: MoaRef[];
  aggregator: MoaRef;
  referenceTemperature: number;
  aggregatorTemperature: number;
}

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
  /** A local model server (Ollama/llama.cpp/LM Studio/vLLM) — no API key required. */
  get isLocalEndpoint(): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:|\/|$)/i.test(this.baseUrl);
  }
  get maxSteps(): number { return Math.max(1, Number(this.data.max_steps ?? 40)); }
  get temperature(): number { return Number(this.data.temperature ?? 0); }
  get maxTokens(): number { return Number(this.data.max_tokens ?? 8192); }
  /** Context window for the ACTIVE model: per-model `model_context[<id>]` wins, else the global
   * `context_window`, else a safe default. Per-model so `/model` switching stays accurate. */
  get contextWindow(): number {
    const perModel = this.data.model_context;
    const m = this.model;
    if (perModel && typeof perModel === "object" && m && perModel[m] != null) return Number(perModel[m]);
    return Number(this.data.context_window ?? 131072);
  }
  /** Reasoning effort (low|medium|high, or higher tiers where supported) sent as `reasoning_effort`; "" = omit. */
  get effort(): string { return String(this.data.reasoning_effort ?? "").trim().toLowerCase(); }
  /** The highest effort tier the endpoint accepts; a configured effort above it is clamped down to it. "" = no clamp. */
  get effortCeiling(): string { return String(this.data.effort_ceiling ?? "").trim().toLowerCase(); }
  /** Check for a newer release at startup (daily-cached, non-blocking). */
  get autoUpdateCheck(): boolean { return this.data.auto_update_check !== false; }

  /** Mixture-of-Agents config (when provider == "moa"): reference models analyze (no tools), an
   * aggregator synthesizes their advice and does the actual tool calls. Each ref/agg is a model id on
   * the base endpoint, or {model, profile} to pull base_url/key from a named profile. null if unset. */
  get moa(): MoaConfig | null {
    const m = this.data.moa;
    if (!m || typeof m !== "object") return null;
    const norm = (x: any): MoaRef => (typeof x === "string" ? { model: x } : { model: String(x?.model ?? ""), profile: x?.profile ? String(x.profile) : undefined });
    const references = Array.isArray(m.references) ? m.references.map(norm).filter((r: MoaRef) => r.model) : [];
    const aggregator = norm(m.aggregator);
    if (!references.length || !aggregator.model) return null;
    return {
      references,
      aggregator,
      referenceTemperature: m.reference_temperature != null ? Number(m.reference_temperature) : 0.6,
      aggregatorTemperature: m.aggregator_temperature != null ? Number(m.aggregator_temperature) : this.temperature,
    };
  }
  /** When true, the catastrophic-bash seatbelt is disabled (default false). */
  get allowDangerousBash(): boolean { return Boolean(this.data.allow_dangerous_bash); }

  /** When true, run bash in an OS sandbox (fs read-only except cwd) where available. */
  get sandbox(): boolean { return Boolean(this.data.sandbox); }
  /** Allow network inside the sandbox (default false = block egress). */
  get sandboxNetwork(): boolean { return Boolean(this.data.sandbox_network); }

  /** Self-hosted SearXNG base URL for web_search metasearch ("" = off). */
  get searxngUrl(): string { return String(this.data.searxng_url ?? ""); }
  /** Force a web_search backend ("searxng" | "tavily" | "duckduckgo"); "" = auto-pick. */
  get searchBackend(): string { return String(this.data.search_backend ?? ""); }
  /** Address /remote-control binds to. Default 127.0.0.1 (loopback, safe). Set to a TRUSTED private
   * address (e.g. a Tailscale IP) to drive Neko from another device — never a public-facing one. */
  get remoteBind(): string { return String(this.data.remote_bind ?? "127.0.0.1"); }
  /** Default relay URL for /relay (your deployed cloudflare/relay Worker), so `/relay` needs no argument. */
  get relayUrl(): string { return String(this.data.relay_url ?? ""); }
  /** When true, read_file returns image files as vision content (needs a vision-capable model). Off by
   * default so text-only models never receive image content in a tool result (which some endpoints reject). */
  get vision(): boolean { return Boolean(this.data.vision); }
  /** Image wire format: "openai" (image_url content-part) | "img-tag" (<img> in the content string) |
   * "auto" (img-tag for an NVIDIA base_url, which ignores the OpenAI part; openai otherwise). */
  get imageFormat(): string { return String(this.data.image_format ?? "auto"); }
  /** Lazy MCP tool loading: true/false to force, or unset (undefined) to auto-enable when there are
   * many MCP tools — so a big MCP surface lists names only and loads schemas on demand. */
  get mcpLazy(): boolean | undefined { return this.data.mcp_lazy === undefined ? undefined : Boolean(this.data.mcp_lazy); }

  /** When true, auto-approved mutating tools get a model "is this safe?" review first. */
  get adversarialCheck(): boolean { return Boolean(this.data.adversarial_check); }

  /** Optional MCP tool filters: if mcp_allow is set, only those load; mcp_deny always excludes.
   * Patterns match a server name, a bare tool name, "server__tool", or "*". */
  get mcpAllow(): string[] { return Array.isArray(this.data.mcp_allow) ? this.data.mcp_allow.map(String) : []; }
  get mcpDeny(): string[] { return Array.isArray(this.data.mcp_deny) ? this.data.mcp_deny.map(String) : []; }

  /** Shell hooks run around tool calls (opt-in). `pre_tool_use` can block (non-zero exit). */
  get hooks(): { preToolUse?: string; postToolUse?: string } {
    const h = this.data.hooks;
    if (!h || typeof h !== "object") return {};
    return { preToolUse: h.pre_tool_use, postToolUse: h.post_tool_use };
  }
  get timeoutSeconds(): number { return Number(this.data.timeout_seconds ?? 120); }
  get maxRetries(): number { return Math.max(0, Number(this.data.max_retries ?? 4)); }
  get retryBaseDelaySeconds(): number { return Number(this.data.retry_base_delay_seconds ?? 1.5); }
  get retryMaxDelaySeconds(): number { return Number(this.data.retry_max_delay_seconds ?? 30); }
  /** How long to keep retrying a dropped connection (offline / laptop asleep) before giving up. */
  get offlineRetrySeconds(): number { return Math.max(0, Number(this.data.offline_retry_seconds ?? 1800)); }

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

  /** Declared MCP servers: name -> stdio {command,args?,env?} OR remote {url, type?:http|sse, headers?}. */
  get mcpServers(): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; type?: "stdio" | "http" | "sse"; url?: string; headers?: Record<string, string>; oauth?: boolean }> {
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
  // Config files, lowest precedence first. `./neko.json` (project root) is the easy, discoverable
  // settings file (claude.json / codex style); keep secrets out of it (api_key -> ~/.neko-core or env).
  const overlays: Record<string, any>[] = opts.path
    ? [readOverlay(opts.path)]
    : [
        readOverlay(join(homeDir(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME)),
        readOverlay(join(homeDir(), "neko.json")),
        readOverlay(join(process.cwd(), LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME)),
        readOverlay(join(process.cwd(), "neko.json")),
      ];
  const filesMerged = overlays.reduce((acc, o) => mergeDeep(acc, o), {} as Record<string, any>);

  // Built-in profiles are always available; files may add or override individual ones (merge, not replace).
  const profiles: Record<string, Profile> = mergeDeep(
    structuredClone(DEFAULTS.profiles),
    filesMerged.profiles && typeof filesMerged.profiles === "object" ? filesMerged.profiles : {},
  );

  // Profile selection: explicit arg > NEKO_PROFILE > files' active_profile > built-in default.
  const selected =
    (opts.profile || process.env.NEKO_PROFILE?.trim() || filesMerged.active_profile || DEFAULTS.active_profile || "").trim() || null;
  if (selected && !(selected in profiles)) {
    const available = Object.keys(profiles).sort().join(", ") || "none";
    throw new Error(`Unknown profile '${selected}'. Available: ${available}`);
  }

  // Precedence: built-in defaults -> profile PRESET -> config files -> NEKO_* env. So an explicit
  // file (e.g. ./neko.json with a local base_url) overrides the profile, not the other way round.
  let merged: Record<string, any> = structuredClone(DEFAULTS);
  if (selected) merged = mergeDeep(merged, profiles[selected]);
  for (const overlay of overlays) merged = mergeDeep(merged, overlay);

  // `.mcp.json` (Claude-style project MCP file): merge its `mcpServers` map. ./.mcp.json (project)
  // wins over ~/.mcp.json, both layered onto config's `mcp_servers`.
  if (!opts.path) {
    const fromMcpJson = { ...readMcpJson(join(homeDir(), ".mcp.json")), ...readMcpJson(join(process.cwd(), ".mcp.json")) };
    if (Object.keys(fromMcpJson).length) merged.mcp_servers = { ...(merged.mcp_servers ?? {}), ...fromMcpJson };
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

/** Read a Claude-style `.mcp.json` and return its `mcpServers` map ({} if absent/invalid). */
function readMcpJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const servers = data?.mcpServers ?? data?.mcp_servers;
    return servers && typeof servers === "object" ? servers : {};
  } catch {
    return {};
  }
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
