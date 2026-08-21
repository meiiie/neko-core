/**
 * Config-first runtime for Neko Core (TypeScript).
 *
 * Behaviour is data, not code. Config resolves by overlaying, lowest precedence first:
 *   1. built-in defaults (DEFAULTS, below)
 *   2. the active profile preset        (pick with --profile / NEKO_PROFILE)
 *   3. ~/.neko-core/config.json        (user-global, claude.json-style home file)
 *   4. ./.neko-core/config.json        (project-local, wins over user/profile)
 *   5. NEKO_* environment variables     (win last)
 *
 * Secrets never live in tracked config: the API key is read on demand from the
 * environment (NEKO_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY) or the gitignored
 * ~/.neko-core/config.json "api_key" field — never stored in the printable `data`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { delimiter, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { isMode, type PermissionMode } from "../core/permissions.ts";
import { isJsonArray, isJsonObject, isObjectValue, isText, type JsonValue } from "../shared/wire.ts";
import type { McpServerConfig } from "./mcp.ts";
import { inspectProjectTrust, type ProjectTrustSummary } from "./project-trust.ts";

export const LOCAL_CONFIG_DIR = ".neko-core";
export const LOCAL_CONFIG_NAME = "config.json";

export interface Profile {
  provider?: string;
  base_url?: string;
  model?: string;
  /** UI grouping: several auth routes can belong to one provider brand (OpenAI API + ChatGPT OAuth). */
  family?: string;
  label?: string;
  auth?: "api_key" | "chatgpt_oauth" | "gemini_oauth" | "kimi_oauth" | "opencode_oauth" | "none";
  /** Models known to the auth route when it has no model-list endpoint. `/model <id>` still accepts newer ids. */
  models?: string[];
  model_context?: Record<string, number>;
  context_window?: number;
  max_tokens?: number;
  effort_ceiling?: string;
  adaptive_effort?: boolean;
  vision?: boolean;
  image_long_edge?: number;
  image_max_bytes?: number;
  /** Some OpenAI-compatible reasoning endpoints also require a top-level `thinking` object. */
  thinking_wire?: "toggle" | "effort";
  /** Override the completion-budget field for compatibility endpoints that renamed `max_tokens`. */
  completion_tokens_field?: "max_tokens" | "max_completion_tokens";
  /** Env var holding this provider's API key (e.g. "ZAI_API_KEY"), so multi-provider works with no config
   * editing: pick the profile, set its env var. It's a FALLBACK — an explicit config api_key wins over it
   * (a stale/foreign env var can't override a key you wrote into config). NEKO_API_KEY still overrides all. */
  key_env?: string;
  /** Previous/alternate official env names, tried after key_env for compatibility. */
  key_env_fallbacks?: string[];
}

export const DEFAULTS: any = {
  provider: "openai_compat",
  model: "",
  base_url: "https://integrate.api.nvidia.com/v1",
  max_steps: 40,
  temperature: 0,
  // 0 = AUTO (the correct default). On OpenAI-compat + responses APIs the field is then OMITTED, so the
  // model uses its FULL native output budget -> a large single-shot file write is never truncated mid-tool-call.
  // The anthropic provider (where max_tokens is REQUIRED) substitutes ANTHROPIC_DEFAULT_MAX_TOKENS and self-heals
  // downward if a model's real cap is smaller. A hardcoded default (was 8192) silently capped EVERY provider and
  // defeated the intended "omit -> full budget" path; set a positive value in a profile/config to cap output.
  max_tokens: 0,
  // IDLE timeout (resets on every streamed byte), NOT a total request cap. It only fires on genuine silence,
  // so it must tolerate a provider that BUFFERS a large tool_use argument (e.g. z.ai/GLM composes a big
  // write_file JSON server-side, streaming nothing for a while) — 120s killed those legitimate large writes.
  // A real network drop is caught separately (fetch error -> offline retry), so a generous idle window is safe.
  timeout_seconds: 300,
  bash_timeout_cap_ms: 600_000, // per-command ceiling; eval/sandbox profiles may fail fast with a lower cap
  max_retries: 4,
  retry_base_delay_seconds: 1.5,
  retry_max_delay_seconds: 30,
  offline_retry_seconds: 1800, // keep retrying a dropped connection (laptop slept) for up to 30 min
  codex_keepalive: 15, // GPT-5.6 App Server idle minutes; 0 keeps it alive until logout/exit
  // NOTE: `approval` is intentionally NOT in DEFAULTS. It is the legacy alias for `mode`, and a
  // baked default here would make a FRESH install indistinguishable from a user who explicitly
  // chose prompt-first. The mode getter resolves: explicit mode > approval=auto > approval=prompt
  // > AUTO (the 2026 product default - bounded autonomy, consequence-gated).
  // Bash OS sandbox ON by default (owner decision, 2026-07-22): machines with a primitive
  // (bwrap / Seatbelt / srt) confine bash out of the box; "none" machines fall back to the
  // seatbelt + gate unchanged. Opt out: "sandbox": false or NEKO_SANDBOX=0.
  sandbox: true,
  sandbox_network: false, // egress blocked inside the sandbox by default
  sandbox_domains: [], // srt (Windows) allowlist used when sandbox_network is true (no allow-all in srt)
  // Sandboxes confine writes/egress but intentionally retain broad host reads. Keep bash approval
  // on by default until read-deny/redaction coverage is a verified confidentiality boundary.
  sandbox_auto_approve: false,
  effort_ceiling: "high", // highest reasoning_effort the endpoint accepts (OpenAI standard caps at high); a profile can raise it
  adaptive_effort: false, // experimental lagged proxy; keep full effort unless a workload-specific eval proves it safe
  image_long_edge: 1568, // conservative cross-provider vision input; high-resolution profiles may raise it
  image_max_bytes: 450_000, // protects strict OpenAI-compatible endpoints from oversized inline data URLs
  auto_update_check: true, // check for a newer release at startup (daily-cached; set false to silence)
  auto_update: true, // AUTO-INSTALL that newer release in the background (claude-code style); false = notify only
  completion_sound: true, // branded native sound (terminal-bell fallback) after a durable turn
  // READS may leave the project directory; writes and edits never may. The root confinement exists to
  // bound what a mistake can DAMAGE, and reading a doc, a skill, or a sibling repo damages nothing -
  // while refusing it made ordinary work impossible. Credential paths stay refused either way
  // (core/tool-runtime.ts OUTSIDE_DENIED). Set false for a hard wall around the project.
  read_outside_root: true,
  // Structured writes and sandboxed bash may also modify these explicit directory capabilities.
  // Neko's own research ledger is a built-in user-global writable surface; broader paths remain
  // opt-in through additional_write_roots (or NEKO_ADDITIONAL_WRITE_ROOTS, PATH-delimited).
  additional_write_roots: [],
  mcp_servers: {}, // name -> { command, args?, env? } for stdio MCP servers
  // The oracle: a second opinion from a STRONGER model, consulted with a curated bundle of files and
  // no tools. `profile` names any profile below - which model is "the strong one" is your decision, not
  // ours, so there is no default. Empty = the feature reports how to turn it on instead of guessing.
  // `effort` is the oracle's own reasoning tier. The whole point of the feature is ONE expensive
  // question, so it is worth spending more there than on an ordinary turn. Empty = whatever the
  // profile already resolves to.
  oracle: { profile: "", model: "", effort: "", max_bytes: 400_000, max_file_bytes: 128_000, max_files: 80 },
  // Exact Chrome extension ids allowed to pair with the loopback Browser Bridge. The bundled
  // developer id is deterministic; add the Chrome Web Store item id here after its first upload.
  browser_extension_ids: ["koalaflndbcddboachbdfmppdeblldje"],
  browser_extension_store_id: "", // owner fills this after Web Store item issuance; install then opens the listing
  active_profile: null,
  profiles: {
    // A new model/endpoint is a data edit, not a code change. "Offline" = point a
    // profile at a local OpenAI-compatible server (llama-server :8080, Ollama :11434).
    nvidia: { provider: "openai_compat", base_url: "https://integrate.api.nvidia.com/v1", model: "z-ai/glm-5.2", key_env: "NVIDIA_API_KEY" },
    openai: { provider: "openai_compat", family: "openai", label: "API key (pay-as-you-go)", auth: "api_key", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", key_env: "OPENAI_API_KEY" },
    // ChatGPT Plus/Pro subscription via OAuth and the Codex Responses backend (not API billing).
    chatgpt: {
      provider: "chatgpt",
      family: "openai",
      label: "ChatGPT Plus/Pro",
      auth: "chatgpt_oauth",
      base_url: "https://chatgpt.com/backend-api/codex",
      model: "gpt-5.5",
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
      model_context: { "gpt-5.5": 272_000, "gpt-5.4": 272_000, "gpt-5.4-mini": 272_000, "gpt-5.3-codex-spark": 128_000 },
      // The live account catalog advertises low/medium/high/xhigh/max/ultra for gpt-5.6; this said xhigh
      // and silently clamped every request for the two tiers above it. The catalog is account-aware and
      // authoritative (see chatgpt-provider.ts), and the provider heals downward from a rejection, so a
      // ceiling ABOVE what an account offers costs nothing while a ceiling below it hides what it paid for.
      effort_ceiling: "ultra",
      vision: true,
    },
    // Gemini Code Assist Standard/Enterprise through official Gemini CLI ACP. Consumer OAuth ended 2026-06-18.
    gemini: {
      provider: "gemini_cli",
      family: "google",
      label: "Gemini Code Assist Standard/Enterprise",
      auth: "gemini_oauth",
      model: "auto",
      models: ["auto"],
      context_window: 1_000_000,
      vision: true,
    },
    "gemini-api": {
      provider: "openai_compat",
      family: "google",
      label: "Gemini API key (free tier / optional paid)",
      auth: "api_key",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.5-flash",
      models: ["gemini-3.5-flash"],
      context_window: 1_048_576,
      effort_ceiling: "high",
      vision: true,
      key_env: "GEMINI_API_KEY",
    },
    // Official Anthropic Messages API. Native Claude keeps signed thinking blocks across tool turns.
    claude: {
      provider: "anthropic",
      family: "anthropic",
      label: "Claude Sonnet 5 API",
      auth: "api_key",
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"],
      model_context: { "claude-sonnet-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-fable-5": 1_000_000 },
      context_window: 1_000_000,
      max_tokens: 32_768,
      effort_ceiling: "max",
      vision: true,
      key_env: "ANTHROPIC_API_KEY",
    },
    fable: {
      provider: "anthropic",
      family: "anthropic",
      label: "Claude Fable 5 API",
      auth: "api_key",
      base_url: "https://api.anthropic.com",
      model: "claude-fable-5",
      models: ["claude-fable-5"],
      context_window: 1_000_000,
      max_tokens: 32_768,
      effort_ceiling: "max",
      key_env: "ANTHROPIC_API_KEY",
      vision: true,
      image_long_edge: 2576,
      image_max_bytes: 4_500_000,
    },
    // NOTE: vision is intentionally OFF. The z.ai GLM Coding Plan endpoint is TEXT-ONLY — sending image
    // content returns HTTP 400 ("messages.content.type ... allowed values: ['text']"). vision:true here would
    // make read_file hand images to a model that rejects them. For document/image OCR with GLM, neko must fall
    // back to on-screen OCR; for true image understanding, use a vision endpoint (claude/gemini/kimi profiles).
    zai: {
      provider: "anthropic",
      family: "zai",
      label: "GLM Coding Plan",
      auth: "api_key",
      base_url: "https://api.z.ai/api/anthropic",
      model: "glm-5.3",
      models: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5"],
      model_context: { "glm-5.3": 1_000_000, "glm-5.2": 1_000_000 },
      context_window: 1_000_000,
      effort_ceiling: "max",
      key_env: "ZAI_API_KEY",
    },
    "zai-openai": {
      provider: "openai_compat",
      family: "zai",
      label: "Z.AI API (pay-as-you-go)",
      auth: "api_key",
      base_url: "https://api.z.ai/api/paas/v4",
      model: "glm-5.2",
      models: ["glm-5.2", "glm-5.1", "glm-5"],
      model_context: { "glm-5.2": 1_000_000 },
      context_window: 1_000_000,
      effort_ceiling: "max",
      key_env: "ZAI_API_KEY",
    },
    // Most hosted providers are OpenAI-compatible -> a profile, not new code. Set your model with /model.
    groq: { provider: "openai_compat", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key_env: "GROQ_API_KEY" },
    deepseek: {
      provider: "openai_compat",
      family: "deepseek",
      label: "DeepSeek API key",
      auth: "api_key",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      model_context: { "deepseek-v4-pro": 1_000_000, "deepseek-v4-flash": 1_000_000 },
      context_window: 1_000_000,
      max_tokens: 65_536,
      effort_ceiling: "max",
      thinking_wire: "toggle",
      key_env: "DEEPSEEK_API_KEY",
    },
    mistral: { provider: "openai_compat", base_url: "https://api.mistral.ai/v1", model: "mistral-large-latest", key_env: "MISTRAL_API_KEY" },
    together: { provider: "openai_compat", base_url: "https://api.together.xyz/v1", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", key_env: "TOGETHER_API_KEY" },
    fireworks: { provider: "openai_compat", base_url: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/llama-v3p3-70b-instruct", key_env: "FIREWORKS_API_KEY" },
    xai: {
      provider: "responses",
      family: "xai",
      label: "Grok 4.5 API",
      auth: "api_key",
      base_url: "https://api.x.ai/v1",
      model: "grok-4.5",
      models: ["grok-4.5", "grok-4.3"],
      model_context: { "grok-4.5": 1_000_000, "grok-4.3": 1_000_000 },
      context_window: 1_000_000,
      effort_ceiling: "high",
      vision: true,
      key_env: "XAI_API_KEY",
    },
    "grok-build": {
      provider: "responses",
      family: "xai",
      label: "Grok Build 0.1 (coding)",
      auth: "api_key",
      base_url: "https://api.x.ai/v1",
      model: "grok-build-0.1",
      models: ["grok-build-0.1"],
      context_window: 256_000,
      effort_ceiling: "high",
      vision: true,
      key_env: "XAI_API_KEY",
    },
    // Kimi Code account OAuth is an official RFC 8628 public-client flow. Neko owns its token file;
    // it never imports Kimi CLI or CLIProxyAPI credentials.
    kimi: {
      provider: "kimi",
      family: "kimi",
      label: "Kimi Code account",
      auth: "kimi_oauth",
      base_url: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
      models: ["kimi-for-coding"],
      model_context: { "kimi-for-coding": 262_144 },
      context_window: 262_144,
      max_tokens: 32_000,
      effort_ceiling: "high",
      thinking_wire: "toggle",
      vision: true,
      image_max_bytes: 4_500_000,
    },
    moonshot: {
      provider: "kimi",
      family: "kimi",
      label: "Kimi Platform API key",
      auth: "api_key",
      base_url: "https://api.moonshot.ai/v1",
      model: "kimi-k2.5",
      models: ["kimi-k2.5"],
      model_context: { "kimi-k2.5": 262_144 },
      context_window: 262_144,
      max_tokens: 32_000,
      effort_ceiling: "high",
      thinking_wire: "toggle",
      vision: true,
      image_max_bytes: 4_500_000,
      key_env: "KIMI_API_KEY",
      key_env_fallbacks: ["MOONSHOT_API_KEY"],
    },
    // OpenRouter exposes an OpenAI-compatible transport plus a live, heterogeneous model catalog.
    // Leave model empty on purpose: /model discovers the current tool-capable catalog instead of
    // pinning a vendor/model choice that can age or disappear behind the router.
    openrouter: {
      provider: "openai_compat",
      family: "openrouter",
      label: "OpenRouter API key",
      auth: "api_key",
      base_url: "https://openrouter.ai/api/v1",
      model: "",
      key_env: "OPENROUTER_API_KEY",
    },
    // OpenCode Console account via the official opencode-cli public-client device OAuth flow. The
    // account-managed /api/config catalog decides the endpoint and protocol for each provider/model.
    "opencode-account": {
      provider: "opencode_account",
      family: "opencode",
      label: "OpenCode Console account",
      auth: "opencode_oauth",
      base_url: "https://opencode.ai/console",
      model: "",
      effort_ceiling: "max",
    },
    // OpenCode Zen service-account/API key remains a separate, backwards-compatible billing route.
    // The edge adapter selects Responses, Anthropic Messages, or Chat Completions per model.
    opencode: {
      provider: "opencode",
      family: "opencode",
      label: "OpenCode Zen API key",
      auth: "api_key",
      base_url: "https://opencode.ai/zen/v1",
      model: "gpt-5.6-terra",
      models: ["gpt-5.6-terra", "claude-sonnet-5", "deepseek-v4-pro", "kimi-k3", "glm-5.2"],
      model_context: { "gpt-5.6-terra": 272_000 },
      context_window: 131_072,
      key_env: "OPENCODE_API_KEY",
    },
    // Mixture-of-Agents: diverse advisors analyze, a strong aggregator synthesizes + acts. `neko
    // --profile moa`. Opt-in quality mode (N+1 model calls/turn) — best where one model is weak.
    moa: {
      provider: "moa",
      base_url: "https://integrate.api.nvidia.com/v1",
      moa: { references: ["deepseek-ai/deepseek-v4-pro", "meta/llama-3.3-70b-instruct"], aggregator: "openai/gpt-oss-120b" },
    },
    // Local servers (no API key needed):
    ollama: { provider: "openai_compat", auth: "none", base_url: "http://localhost:11434/v1", model: "llama3.2" },
    lmstudio: { provider: "openai_compat", auth: "none", base_url: "http://localhost:1234/v1", model: "local-model" },
    local: { provider: "openai_compat", auth: "none", base_url: "http://127.0.0.1:8080/v1", model: "local-model" },
  },
};

const BOOLEAN_ENV_KEYS = new Set([
  "adaptive_effort",
  "adversarial_check",
  "allow_dangerous_bash",
  "auto_loop",
  "auto_update",
  "auto_update_check",
  "computer_use_overlay",
  "computer_use_resident",
  "completion_sound",
  "fullscreen",
  "mcp_lazy",
  "prompt_cache",
  "read_outside_root",
  "sandbox",
  "sandbox_auto_approve",
  "sandbox_network",
  "verify_before_exit",
  "vision",
]);

function parseBooleanEnv(envName: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${envName} must be a boolean (1/0, true/false, yes/no, on/off)`);
}

const SECRET_KEY = /(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|cookie|credential|private[_-]?key)/i;
const SECRET_CONTAINER = /^(headers|env)$/i;

/** Return a printable clone with credentials removed, including arbitrary MCP header/env values.
 * Accepts any plain config graph (typed profile interfaces included); the walk only follows JSON-shaped members. */
export function redactSecrets(value: any, key = "", hideValue = false): JsonValue {
  if (hideValue || (key && SECRET_KEY.test(key))) return "<redacted>";
  if (isJsonArray(value)) return value.map((item) => redactSecrets(item));
  if (!isJsonObject(value)) return value;
  const hideChildren = SECRET_CONTAINER.test(key);
  return Object.fromEntries(
    Object.keys(value).map((childKey) => [
      childKey,
      redactSecrets(value[childKey], childKey, hideChildren),
    ]),
  );
}

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
    public readonly data: any,
    public profile: string | null,
    public readonly profiles: Record<string, Profile>,
    private apiKeyFromFile: string,
    /** Set when a top-level `model` (config file or NEKO_MODEL) overrides the selected profile's preset
     * model — the #1 config trap: `--profile x` silently keeps the file's model. Doctor names the source. */
    public modelShadow: { source: string; profileModel: string } | null = null,
    /** Top-level key_env names leave printable data but still need protecting from child processes. */
    private childKeyEnvsFromConfig: string[] = [],
    public projectTrust: ProjectTrustSummary = { state: "none", files: [] },
    /** Resolved user-home boundary used by trust-aware runtime loaders; never printed or sent. */
    public resolvedHome: string = homeDir(),
  ) {}

  /** Adopt another config's provider profile IN PLACE — data, profile name, and resolved key — so the
   * existing cfg reference (held by the REPL + agent wiring) stays valid while `/provider` switches the
   * endpoint + model + key live, without a restart. */
  adopt(other: NekoConfig): void {
    for (const k of Object.keys(this.data)) delete this.data[k];
    Object.assign(this.data, other.data);
    this.profile = other.profile;
    this.apiKeyFromFile = other.apiKeyFromFile;
    this.modelShadow = other.modelShadow;
    this.childKeyEnvsFromConfig = [...other.childKeyEnvsFromConfig];
    this.projectTrust = { ...other.projectTrust, files: [...other.projectTrust.files] };
    this.resolvedHome = other.resolvedHome;
  }

  get provider(): string { return String(this.data.provider ?? "openai_compat"); }
  get usesChatGptAuth(): boolean { return this.provider === "chatgpt"; }
  get usesGeminiCli(): boolean { return this.provider === "gemini_cli"; }
  get usesGeminiAuth(): boolean { return this.usesGeminiCli && this.profile != null && this.profiles[this.profile]?.auth === "gemini_oauth"; }
  get usesKimiAuth(): boolean { return this.provider === "kimi" && this.profile != null && this.profiles[this.profile]?.auth === "kimi_oauth"; }
  get usesOpenCodeAuth(): boolean { return this.provider === "opencode_account" && this.profile != null && this.profiles[this.profile]?.auth === "opencode_oauth"; }
  get model(): string { return String(this.data.model ?? "").trim(); }
  /** Model for a VISION pre-pass (reading an image into text the main agent can use): `vision_model`
   * config, else a verified-good default on an NVIDIA endpoint, else "" (no auto vision). */
  get visionModel(): string {
    const set = String(this.data.vision_model ?? "").trim();
    if (set) return set;
    return /nvidia/i.test(this.baseUrl) ? "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" : "";
  }
  /** Clipboard-image normalization is profile data because model/provider limits differ. */
  get imageLongEdge(): number {
    const n = Number(this.data.image_long_edge ?? 1568);
    return Math.min(4096, Math.max(512, Number.isFinite(n) ? Math.round(n) : 1568));
  }
  get imageMaxBytes(): number {
    const n = Number(this.data.image_max_bytes ?? 450_000);
    return Math.min(5_000_000, Math.max(64_000, Number.isFinite(n) ? Math.round(n) : 450_000));
  }
  /** A clone of this config pointing at a different model (same endpoint + key) — e.g. the vision pre-pass. */
  withModel(model: string): NekoConfig {
    return new NekoConfig({ ...this.data, model }, this.profile, this.profiles, this.apiKey, this.modelShadow, this.childKeyEnvsFromConfig, this.projectTrust, this.resolvedHome);
  }
  /** A clone at a different reasoning tier (same endpoint, key and model) — the oracle spends more than
   * an ordinary turn does, and that is the only difference between them. */
  withEffort(effort: string): NekoConfig {
    return new NekoConfig({ ...this.data, reasoning_effort: effort }, this.profile, this.profiles, this.apiKey, this.modelShadow, this.childKeyEnvsFromConfig, this.projectTrust, this.resolvedHome);
  }
  get baseUrl(): string { return String(this.data.base_url ?? "").replace(/\/+$/, ""); }
  /** A local model server (Ollama/llama.cpp/LM Studio/vLLM) — no API key required. */
  get isLocalEndpoint(): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:|\/|$)/i.test(this.baseUrl);
  }
  get maxSteps(): number { return Math.max(1, Number(this.data.max_steps ?? 40)); }
  get temperature(): number { return Number(this.data.temperature ?? 0); }
  get maxTokens(): number { return Number(this.data.max_tokens ?? 0); } // 0 = auto: omit where allowed, see DEFAULTS.max_tokens
  /** Context window for the ACTIVE model: per-model `model_context[<id>]` wins, else the global
   * `context_window`, else a safe default. Per-model so `/model` switching stays accurate. */
  get contextWindow(): number {
    const perModel = this.data.model_context;
    const m = this.model;
    const perModelMap = isJsonObject(perModel) ? perModel : null;
    if (perModelMap && m && perModelMap[m] != null) return Number(perModelMap[m]);
    return Number(this.data.context_window ?? 131072);
  }
  /** User reasoning preference. Common and provider-defined tiers are negotiated per model; "" = model default. */
  get effort(): string { return String(this.data.reasoning_effort ?? "").trim().toLowerCase(); }
  /** The highest effort tier the endpoint accepts; a configured effort above it is clamped down to it. "" = no clamp. */
  get effortCeiling(): string { return String(this.data.effort_ceiling ?? "").trim().toLowerCase(); }
  get thinkingWire(): "toggle" | "effort" | "" {
    const value = String(this.data.thinking_wire ?? "");
    return value === "toggle" || value === "effort" ? value : "";
  }
  get completionTokensField(): "max_tokens" | "max_completion_tokens" {
    return this.data.completion_tokens_field === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
  }
  /** Check for a newer release at startup (daily-cached, non-blocking). */
  get autoUpdateCheck(): boolean { return this.data.auto_update_check !== false; }
  /** Audible completion alert after a successful durable turn. Disable with config or NEKO_COMPLETION_SOUND=0. */
  get completionSound(): boolean { return this.data.completion_sound !== false; }
  /** Auto-INSTALL a newer release found by the startup check (claude-code style: on by default; the
   * update stages in the background and takes effect on the next launch). Opt out with config
   * `auto_update: false` or NEKO_AUTO_UPDATE=0 - then the check only notifies. */
  get autoUpdate(): boolean {
    const env = process.env.NEKO_AUTO_UPDATE;
    if (env === "0" || env === "false") return false;
    return this.data.auto_update !== false;
  }
  /** UI frame rate cap (Ink renders + scroll-glide hops). Default 60 - matches most displays and the
   * conpty/WT floor. High-refresh monitors (120/144Hz) can raise it via `ui_fps` (or NEKO_FPS); the
   * render pipeline is cheap enough (sub-ms hops, ~250-byte repaints) that 120 costs nothing. Above
   * the display's refresh the extra frames are simply never shown. Clamped 30..240. */
  get uiFps(): number {
    const env = Number(process.env.NEKO_FPS);
    const v = Number.isFinite(env) && env > 0 ? env : Number(this.data.ui_fps ?? 60);
    return Math.min(240, Math.max(30, Math.round(v)));
  }
  /** The config file's EXPLICIT ui_fps, or null when unset - the display resolver (adapters/display.ts)
   * layers env > this > the /fps pref > the detected display Hz > 60. */
    get uiFpsConfig(): number | null { return this.data.ui_fps != null ? Number(this.data.ui_fps) : null; }
    /** Caret glyph style for the text-input cursor. Some terminal fonts render the default thin block
     * (▏) with a gap; switching to "bar" (│), "block" (█), or "underline" (▁) is the lowest-risk fix.
     * Precedence: NEKO_CARET env > `caret_glyph` config > "thin-block". */
    get caretGlyph(): "thin-block" | "bar" | "block" | "underline" {
      const env = process.env.NEKO_CARET;
      if (env === "bar" || env === "block" || env === "underline") return env;
      // SAFETY: optional wire field; undefined preserves the omitted-key behavior.
      const v = this.data.caret_glyph as string | undefined;
      if (v === "bar" || v === "block" || v === "underline") return v;
      return "thin-block";
    }
  /** Fullscreen (alt-screen, scrollable viewport) is the sole interactive mode - there is no runtime
   * toggle; it is the main experience (real scrolling, glide, hover, flicker-free), and /copy serves the
   * copy that fullscreen's mouse-capture keeps native selection from reaching. Terminals that can't host
   * it (non-TTY / too small) fall back to inline automatically (canFullscreen). This flag stays as an
   * internal escape hatch for that fallback + tests (NEKO_FULLSCREEN=0 / `fullscreen: false`), not a
   * user-facing option. */
  get fullscreen(): boolean {
    const env = process.env.NEKO_FULLSCREEN;
    if (env === "1" || env === "true") return true;
    if (env === "0" || env === "false") return false;
    return this.data.fullscreen !== false;
  }

  /** Mixture-of-Agents config (when provider == "moa"): reference models analyze (no tools), an
   * aggregator synthesizes their advice and does the actual tool calls. Each ref/agg is a model id on
   * the base endpoint, or {model, profile} to pull base_url/key from a named profile. null if unset. */
  get moa(): MoaConfig | null {
    const m = this.data.moa;
    if (!isJsonObject(m)) return null;
    const norm = (x: any): MoaRef => (isText(x) ? { model: x } : { model: String(x?.model ?? ""), profile: x?.profile ? String(x.profile) : undefined });
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
  /** Reads may resolve outside the project root (default true). */
  get readOutsideRoot(): boolean { return this.data.read_outside_root !== false; }

  get researchWriteRoot(): string { return resolve(this.resolvedHome, ".neko-core", "research"); }

  /** Extra directories that may be modified by structured tools and sandboxed bash. Keep this
   * path-scoped: auto mode removes approval prompts, not filesystem containment. */
  get additionalWriteRoots(): string[] {
    const raw = this.data.additional_write_roots;
    const configured = Array.isArray(raw)
      ? raw.map(String)
      : isText(raw)
        ? raw.split(delimiter)
        : [];
    const research = this.researchWriteRoot;
    const sensitiveRoots = [".codex", ".agents", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config"]
      .map((name) => resolve(this.resolvedHome, name));
    const nekoState = resolve(this.resolvedHome, ".neko-core");
    const home = resolve(this.resolvedHome);
    const folded = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const within = (base: string, value: string) => {
      const rel = relative(base, value);
      return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
    };
    const out: string[] = [];
    for (const value of [research, ...configured]) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) continue;
      const expanded = trimmed === "~"
        ? home
        : /^~[\\/]/.test(trimmed)
          ? resolve(home, trimmed.slice(2))
          : trimmed;
      if (!isAbsolute(expanded)) throw new Error(`additional_write_roots entries must be absolute (or start with ~/): ${trimmed}`);
      const candidate = resolve(expanded);
      if (candidate === parse(candidate).root || within(candidate, home) || folded(candidate) === folded(home)) {
        throw new Error(`additional_write_roots refuses a filesystem or home-directory root: ${trimmed}`);
      }
      const isResearch = within(research, candidate);
      if (!isResearch && (within(nekoState, candidate) || sensitiveRoots.some((root) => within(root, candidate)))) {
        throw new Error(`additional_write_roots refuses a credential or agent-control directory: ${trimmed}`);
      }
      if (!out.some((item) => folded(item) === folded(candidate))) out.push(candidate);
    }
    return out;
  }

  /** When true, the catastrophic-bash seatbelt is disabled (default false). */
  get allowDangerousBash(): boolean { return Boolean(this.data.allow_dangerous_bash); }

  /** When true, run bash in an OS sandbox (fs read-only except cwd) where available. */
  get sandbox(): boolean { return Boolean(this.data.sandbox); }
  /** Allow network inside the sandbox (default false = block egress). */
  get sandboxNetwork(): boolean { return Boolean(this.data.sandbox_network); }
  /** Domain allowlist for the srt (Windows) sandbox when sandbox_network is true - srt has no
   * allow-all: egress is always an allowlist (e.g. ["github.com", "*.npmjs.org"]). Ignored by
   * the bwrap/Seatbelt rungs, which allow all egress when sandbox_network is true. */
  get sandboxDomains(): string[] {
    const v = this.data.sandbox_domains;
    return Array.isArray(v) ? v.map(String) : [];
  }
  /** When explicitly true AND the sandbox is live, bash skips the approval prompt in
   * default/accept-edits mode - the OS sandbox is the containment. `neko policy` surfaces it. */
  get sandboxAutoApprove(): boolean { return this.data.sandbox_auto_approve === true; }

  /** Self-hosted SearXNG base URL for web_search metasearch ("" = off). */
  get searxngUrl(): string { return String(this.data.searxng_url ?? ""); }
  /** Idle minutes before a Neko-STARTED SearXNG container auto-stops (Ollama-style keep_alive;
   * 0 = keep running). Only containers Neko itself woke are ever stopped. */
  get searxngKeepalive(): number {
    const n = Number(this.data.searxng_keepalive);
    return Number.isFinite(n) && n >= 0 ? n : 15;
  }
  /** Force a web_search backend ("searxng" | "tavily" | "duckduckgo"); "" = auto-pick. */
  get searchBackend(): string { return String(this.data.search_backend ?? ""); }
  /** Tavily search key from config (`tavily_api_key`, wired by `neko setup tavily`; redacted when
   * printed). TAVILY_API_KEY env still wins at search time. */
  get tavilyApiKey(): string { return String(this.data.tavily_api_key ?? "").trim(); }
  /** Optional hosted scrape backend for web_fetch: "" = direct fetch (our HTML->markdown, no JS render);
   * "jina" = r.jina.ai (renders JS/SPAs, returns markdown; free + keyless for light use, PUBLIC pages only). */
  get scrapeBackend(): string { return String(this.data.scrape_backend ?? "").trim().toLowerCase(); }
  /** Address /remote-control binds to. Default 127.0.0.1 (loopback, safe). Set to a TRUSTED private
   * address (e.g. a Tailscale IP) to drive Neko from another device — never a public-facing one. */
  get remoteBind(): string { return String(this.data.remote_bind ?? "127.0.0.1"); }
  /** Default relay URL for /relay (your deployed cloudflare/relay Worker), so `/relay` needs no argument. */
  get relayUrl(): string { return String(this.data.relay_url ?? ""); }
  /** Exact Chrome extension ids accepted by the loopback Browser Bridge. A list (or a comma-separated
   * NEKO_BROWSER_EXTENSION_IDS value) keeps public-store and unpacked builds explicit and auditable. */
  get browserExtensionIds(): string[] {
    const raw = this.data.browser_extension_ids;
    const values = Array.isArray(raw) ? [...raw] : String(raw ?? "").split(",");
    values.push(this.data.browser_extension_store_id ?? "");
    return [...new Set(values.map((value) => String(value).trim().toLowerCase()))]
      .filter((value) => /^[a-p]{32}$/.test(value))
      .slice(0, 8);
  }
  /** Public Chrome Web Store item id. Kept separate because other allowed ids may be unpacked test builds. */
  get browserExtensionStoreId(): string {
    const value = String(this.data.browser_extension_store_id ?? "").trim().toLowerCase();
    return /^[a-p]{32}$/.test(value) ? value : "";
  }
  /** Opt-in pre-completion gate: when no fresh inspection/test evidence exists, intercept the first
   * tool-less final once and force a re-inspection (quality over speed; +1 turn only when needed). */
  get verifyBeforeExit(): boolean { return Boolean(this.data.verify_before_exit); }
  /** Prompt caching (anthropic provider): send cache_control breakpoints so the stable prefix
   * (tools + system) and the growing conversation are cached across steps/turns. ON by default —
   * an endpoint that rejects cache_control is self-healed with one retry; `prompt_cache: false` opts out. */
  get promptCache(): boolean { return this.data.prompt_cache !== false; }
  /** Opt-in per-step compute routing: mechanical read-only follow-ups request low effort, while
   * planning, mutations, failures, and final verification retain the configured effort ceiling. */
  get adaptiveEffort(): boolean { return Boolean(this.data.adaptive_effort); }
  /** When true, read_file returns image files as vision content (needs a vision-capable model). Off by
   * default so text-only models never receive image content in a tool result (which some endpoints reject). */
  get vision(): boolean { return Boolean(this.data.vision); }
  /** Image wire format: "openai" (image_url content-part) | "img-tag" (<img> in the content string) |
   * "auto" (img-tag for an NVIDIA base_url, which ignores the OpenAI part; openai otherwise). */
  get imageFormat(): string { return String(this.data.image_format ?? "auto"); }
  /** Show the independent agent-cursor overlay during desktop computer-use (clicky-style presence): a blue
   * cursor that flies to where the agent acts + click-to-takeover. Off by default. */
  get computerUseOverlay(): boolean { return Boolean(this.data.computer_use_overlay); }
  /** Keep one local PowerShell UIA/input/capture process warm. On by default; false preserves the one-shot adapter. */
  get computerUseResident(): boolean { return this.data.computer_use_resident !== false; }
  /** Desktop input backend: "inject" = touch injection (the agent acts WITHOUT moving the user's mouse --
   * its own pointer channel); "sendinput" = legacy SendInput (moves the one system cursor). "auto"/unset
   * leaves each helper's default. A new backend is a config value, not a code change. */
  get computerUseInput(): string { return String(this.data.computer_use_input ?? "auto"); }
  /** Persist toward the GOAL by default: `neko run` uses the closed loop (runUntilDone) so a task isn't
   * abandoned the moment the model stops calling tools. Off = single-shot. `--loop`/`--once` override. */
  get autoLoop(): boolean { return Boolean(this.data.auto_loop); }
  /** Lazy MCP tool loading: true/false to force, or unset (undefined) to auto-enable when there are
   * many MCP tools — so a big MCP surface lists names only and loads schemas on demand. */
  get mcpLazy(): boolean | undefined { return this.data.mcp_lazy === undefined ? undefined : Boolean(this.data.mcp_lazy); }

  /** When true, auto-approved mutating tools get a model "is this safe?" review first. */
  get adversarialCheck(): boolean { return Boolean(this.data.adversarial_check); }

  /** Optional MCP tool filters: if mcp_allow is set, only those load; mcp_deny always excludes.
   * Patterns match a server name, a bare tool name, "server__tool", or "*". */
  get mcpAllow(): string[] { return Array.isArray(this.data.mcp_allow) ? this.data.mcp_allow.map(String) : []; }
  get mcpDeny(): string[] { return Array.isArray(this.data.mcp_deny) ? this.data.mcp_deny.map(String) : []; }

  /** Which profile answers `neko oracle`, and how much of the project it may be sent. An unset profile
   * is not an error here - the oracle surface reports it and names the candidates. */
  get oracle(): any {
    const o = isJsonObject(this.data.oracle) ? this.data.oracle : {};
    const bounded = (value: any, fallback: number, min: number, max: number) => {
      const number = Number(value ?? fallback);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
    };
    return {
      profile: String(o.profile ?? "").trim(),
      model: String(o.model ?? "").trim(),
      effort: String(o.effort ?? "").trim().toLowerCase(),
      maxBytes: bounded(o.max_bytes, 400_000, 4_000, 8_000_000),
      maxFileBytes: bounded(o.max_file_bytes, 128_000, 1_000, 4_000_000),
      maxFiles: bounded(o.max_files, 80, 1, 1_000),
    };
  }

  /** Shell hooks run around tool calls (opt-in). `pre_tool_use` can block (non-zero exit). */
  get hooks(): any {
    const h = this.data.hooks;
    if (!isJsonObject(h)) return {};
    return { preToolUse: isText(h.pre_tool_use) ? h.pre_tool_use : undefined, postToolUse: isText(h.post_tool_use) ? h.post_tool_use : undefined };
  }
  get timeoutSeconds(): number { return Number(this.data.timeout_seconds ?? 300); } // idle window; see DEFAULTS.timeout_seconds
  get bashTimeoutCapMs(): number {
    const value = Number(this.data.bash_timeout_cap_ms ?? 600_000);
    return Number.isFinite(value) ? Math.min(600_000, Math.max(1_000, value)) : 600_000;
  }
  get maxRetries(): number { return Math.max(0, Number(this.data.max_retries ?? 4)); }
  get retryBaseDelaySeconds(): number { return Number(this.data.retry_base_delay_seconds ?? 1.5); }
  get retryMaxDelaySeconds(): number { return Number(this.data.retry_max_delay_seconds ?? 30); }
  /** How long to keep retrying a dropped connection (offline / laptop asleep) before giving up. */
  get offlineRetrySeconds(): number { return Math.max(0, Number(this.data.offline_retry_seconds ?? 1800)); }
  get codexKeepalive(): number { return Math.max(0, Number(this.data.codex_keepalive ?? 15)); }

  get approval(): "prompt" | "auto" {
    const v = String(this.data.approval ?? "prompt").trim().toLowerCase();
    return v === "auto" ? "auto" : "prompt";
  }

  /** Permission mode: explicit `mode` in config, else derived from legacy `approval`.
   * The product default is now AUTO (owner decision, 2026-08-17, matching the 2026 industry
   * shift Claude Code pioneered): bounded autonomy out of the box, and only genuinely
   * consequential surfaces still ask — host computer control, the policy file itself,
   * catastrophic shell (seatbelt), credential paths, and anything outside the workspace. */
  get mode(): PermissionMode {
    const raw = String(this.data.mode ?? "").trim().toLowerCase();
    if (isMode(raw)) return raw;
    if (this.data.approval === "auto") return "auto";
    if (this.data.approval === "prompt") return "default";
    return "auto";
  }

  /** Declared MCP servers: name -> stdio {command,args?,env?} OR remote {url, type?:http|sse, headers?}. */
  get mcpServers(): Record<string, McpServerConfig> {
    const raw = this.data.mcp_servers;
    // SAFETY: config-declared server entries; McpHub validates each entry's fields before launch.
    return isJsonObject(raw) ? (raw as Record<string, McpServerConfig>) : {};
  }

  /** Read on demand; NEVER stored in `data` (so it can't leak via `neko config`). */
  get apiKey(): string {
    // NEKO_API_KEY is the explicit override; then this profile's key (its key_env or config api_key, resolved
    // in loadConfig). Broad OPENAI/NVIDIA fallbacks exist only for an unscoped legacy configuration: a
    // profile declaring key_env must never send another provider's credential to its endpoint.
    const hasScopedKeyEnv = Boolean(this.profile && this.profiles[this.profile]?.key_env);
    return (
      process.env.NEKO_API_KEY ||
      this.apiKeyFromFile ||
      (!hasScopedKeyEnv ? (process.env.OPENAI_API_KEY || process.env.NVIDIA_API_KEY) : "") ||
      ""
    ).trim();
  }

  /** Environment names that can supply or retain this profile's key, primary first. */
  get profileKeyEnvs(): string[] {
    if (!this.profile) return [];
    const profile = this.profiles[this.profile];
    return [profile?.key_env, ...(profile?.key_env_fallbacks ?? [])].filter((name): name is string => Boolean(name));
  }

  /** Every configured provider credential env name, not only the selected profile. */
  get childSecretEnvNames(): string[] {
    const names = new Set(this.childKeyEnvsFromConfig);
    for (const profile of Object.values(this.profiles)) {
      if (profile.key_env) names.add(profile.key_env);
      for (const fallback of profile.key_env_fallbacks ?? []) names.add(fallback);
    }
    return [...names].filter(Boolean);
  }
}

export function loadConfig(opts: { path?: string; profile?: string; cwd?: string; home?: string } = {}): NekoConfig {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homeDir();
  const projectTrust = opts.path ? null : inspectProjectTrust(cwd, home);
  // Config files, lowest precedence first. `./neko.json` (project root) is the easy, discoverable
  // settings file (claude.json / codex style); keep secrets out of it (api_key -> ~/.neko-core or env).
  const overlayEntries: { path: string; data: any }[] = opts.path
    ? [{ path: opts.path, data: readOverlay(opts.path) }]
    : [
        { path: join(home, LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME), data: readOverlay(join(home, LOCAL_CONFIG_DIR, LOCAL_CONFIG_NAME)) },
        { path: join(home, "neko.json"), data: readOverlay(join(home, "neko.json")) },
        ...(projectTrust?.state === "trusted" ? projectTrust.configEntries : []),
      ];
  const overlayPaths = overlayEntries.map((entry) => entry.path);
  const overlays = overlayEntries.map((entry) => entry.data);
  // SAFETY: wire/config payload shape; keys are produced by the boundary that owns this data.
  const filesMerged = overlays.reduce((acc, o) => mergeDeep(acc, o), {} as any);

  // Built-in profiles are always available; files may add or override individual ones (merge, not replace).
  const profiles: Record<string, Profile> = mergeDeep(
    structuredClone(DEFAULTS.profiles),
    isObjectValue(filesMerged.profiles) ? filesMerged.profiles : {},
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
  let merged: any = structuredClone(DEFAULTS);
  if (selected) merged = mergeDeep(merged, profiles[selected]);
  for (const overlay of overlays) merged = mergeDeep(merged, overlay);

  // `.mcp.json` (Claude-style project MCP file): merge its `mcpServers` map. ./.mcp.json (project)
  // wins over ~/.mcp.json, both layered onto config's `mcp_servers`.
  if (!opts.path) {
    const fromMcpJson = {
      ...readMcpJson(join(home, ".mcp.json")),
      ...(projectTrust?.state === "trusted" ? projectTrust.mcpServers : undefined),
    };
    if (Object.keys(fromMcpJson).length) merged.mcp_servers = { ...(merged.mcp_servers ?? {}), ...fromMcpJson };
  }

  // Pull the file-provided key out before building the printable dict (never printed).
  // Resolve the key. Explicit config > profile env.
  const keyEnv = merged.key_env ? String(merged.key_env) : "";
  const fallbackKeyEnvs = Array.isArray(merged.key_env_fallbacks) ? merged.key_env_fallbacks.map(String) : [];
  const envKey = [keyEnv, ...fallbackKeyEnvs]
    .filter(Boolean)
    .map((name) => (process.env[name] ?? "").trim())
    .find(Boolean) ?? "";
  const apiKeyFromFile = String(merged.api_key ?? "") || envKey;
  delete merged.api_key;
  delete merged.key_env;
  delete merged.key_env_fallbacks;
  delete merged.profiles;
  delete merged.active_profile;

  // NEKO_* env overrides win last (except the secret/profile keys handled above).
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("NEKO_")) continue;
    const suffix = key.slice("NEKO_".length);
    if (suffix === "API_KEY" || suffix === "PROFILE") continue;
    const configKey = suffix.toLowerCase();
    merged[configKey] = BOOLEAN_ENV_KEYS.has(configKey) ? parseBooleanEnv(key, value ?? "") : value;
  }

  // The #1 config trap: a top-level `model` in a file (or NEKO_MODEL) legitimately wins over the profile
  // PRESET — but it wins over EVERY profile, so `--profile x` silently keeps sending the file's model.
  // Behaviour is unchanged here; we just record the fact + its source so doctor can name it.
  const profileModel = selected ? String(profiles[selected].model ?? "").trim() : "";
  const effectiveModel = String(merged.model ?? "").trim();
  let modelShadow: { source: string; profileModel: string } | null = null;
  if (profileModel && effectiveModel && effectiveModel !== profileModel) {
    let source = (process.env.NEKO_MODEL ?? "").trim() ? "NEKO_MODEL (env)" : "";
    if (!source) {
      for (let i = overlays.length - 1; i >= 0; i--) {
        if (String(overlays[i].model ?? "").trim()) { source = overlayPaths[i]; break; }
      }
    }
    if (source) modelShadow = { source, profileModel };
  }

  const trustSummary: ProjectTrustSummary = projectTrust
    ? {
        state: projectTrust.state, root: projectTrust.root, projectId: projectTrust.projectId,
        fingerprint: projectTrust.fingerprint, files: [...projectTrust.files], reason: projectTrust.reason,
      }
    : { state: "none", files: [] };
  return new NekoConfig(merged, selected, profiles, apiKeyFromFile, modelShadow, [keyEnv, ...fallbackKeyEnvs].filter(Boolean), trustSummary, home);
}

function readOverlay(path: string): any {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    // Windows PowerShell 5 writes UTF-8 text with a BOM by default. Installer/config tooling may
    // therefore produce valid JSON prefixed by U+FEFF; JSON.parse itself does not accept it.
    text = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // SAFETY: caught value comes from the typed API calls in this try block; a non-Error throw would surface as undefined message text.
    throw new Error(`Invalid JSON in config ${path}: ${(error as Error).message}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Config ${path} must be a JSON object`);
  }
  // SAFETY: wire/config payload shape; keys are produced by the boundary that owns this data.
  return parsed as any;
}

/** Read a Claude-style `.mcp.json` and return its `mcpServers` map ({} if absent/invalid). */
function readMcpJson(path: string): any {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const servers = data?.mcpServers ?? data?.mcp_servers;
    return isObjectValue(servers) ? servers : {};
  } catch {
    return {};
  }
}

function mergeDeep(base: any, overlay: any) {
  const out = { ...base };
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

function isPlainObject(value: any): value is any {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
