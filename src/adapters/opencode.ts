/**
 * OpenCode Zen API-key adapter.
 *
 * Zen exposes one credential and catalog, but its models use three different public wires. Keep that
 * routing at the adapter edge so the core still sees one Provider and users only sign in once.
 */
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse } from "../core/ports.ts";
import { isJsonObject, isText } from "../shared/wire.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { NekoConfig } from "./config.ts";
import { OpenAICompatProvider, type ModelOption } from "./providers.ts";
import { ResponsesProvider } from "./responses-provider.ts";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";

export type OpenCodeZenTransport = "responses" | "anthropic" | "openai_compat" | "unsupported";

/** Public routing documented at https://opencode.ai/docs/zen. Unknown families fail closed instead of
 * being guessed onto a compatible-looking wire and returning a misleading provider error. */
export function openCodeZenTransport(model: string): OpenCodeZenTransport {
  const id = model.trim().toLowerCase();
  if (/^(gpt-|grok-|muse-)/.test(id)) return "responses";
  if (/^(claude-|qwen)/.test(id)) return "anthropic";
  if (/^gemini-/.test(id)) return "unsupported";
  if (/^(deepseek-|glm-|minimax-|kimi-|big-pickle$|x-preview-|mimo-|hy3-|nemotron-|laguna-)/.test(id)) {
    return "openai_compat";
  }
  return "unsupported";
}

function delegatedConfig(config: NekoConfig, transport: Exclude<OpenCodeZenTransport, "unsupported">): NekoConfig {
  const copy = config.withModel(config.model);
  copy.data.provider = transport;
  copy.data.base_url = transport === "anthropic" ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_BASE_URL;
  return copy;
}

/** One durable provider instance per model/wire preserves retry healing and cache affinity within a session. */
export class OpenCodeZenProvider implements Provider {
  private readonly delegates = new Map<string, Provider>();

  constructor(private readonly config: NekoConfig) {}

  async complete(
    messages: any[],
    tools?: any[],
    onDelta?: DeltaHook,
    signal?: AbortSignal,
    opts?: CompleteOptions,
  ): Promise<ProviderResponse> {
    const model = this.config.model;
    if (!model) throw new Error("OpenCode Zen needs a model. Use /model to choose one.");
    const transport = openCodeZenTransport(model);
    if (transport === "unsupported") {
      const detail = model.toLowerCase().startsWith("gemini-")
        ? "Gemini on Zen uses the Google-native API, which this Neko route does not support yet"
        : "the model's public Zen wire is not known";
      throw new Error(`OpenCode Zen cannot safely route model '${model}': ${detail}. Choose another model with /model.`);
    }
    const key = `${transport}:${model}`;
    let delegate = this.delegates.get(key);
    if (!delegate) {
      const config = delegatedConfig(this.config, transport);
      delegate = transport === "responses"
        ? new ResponsesProvider(config)
        : transport === "anthropic"
          ? new AnthropicProvider(config)
          : new OpenAICompatProvider(config);
      this.delegates.set(key, delegate);
    }
    return delegate.complete(messages, tools, onDelta, signal, opts);
  }

  async dispose(): Promise<void> {
    const delegates = [...this.delegates.values()];
    this.delegates.clear();
    const settled = await Promise.allSettled(delegates.map((provider) => provider.dispose?.()));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}

function option(config: NekoConfig, id: string): ModelOption | null {
  const transport = openCodeZenTransport(id);
  if (transport === "unsupported") return null;
  const profile = config.profile ? config.profiles[config.profile] : undefined;
  const label = transport === "responses" ? "Responses API"
    : transport === "anthropic" ? "Messages API"
      : "Chat Completions API";
  return {
    id,
    label: id,
    description: `OpenCode Zen - ${label}`,
    contextWindow: profile?.model_context?.[id] ?? profile?.context_window ?? config.contextWindow,
    // The public Zen catalog currently has no modality metadata. False is safer than sending an image
    // to a text-only route; users can still select a separately verified vision profile.
    vision: false,
  };
}

/** Zen's public model catalog needs no credential. Catalog failure degrades to the profile's known models. */
export async function listOpenCodeZenModelOptions(config: NekoConfig): Promise<ModelOption[]> {
  const profile = config.profile ? config.profiles[config.profile] : undefined;
  const configured = [...new Set([config.model, ...(profile?.models ?? [])].filter(Boolean))]
    .map((id) => option(config, id))
    .filter((item): item is ModelOption => item !== null);
  try {
    const response = await fetch(`${OPENCODE_ZEN_BASE_URL}/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!isJsonObject(payload) || !Array.isArray(payload.data)) throw new Error("invalid model catalog");
    const live = payload.data
      .map((model: any) => isText(model?.id) ? option(config, model.id) : null)
      .filter((item): item is ModelOption => item !== null);
    if (!live.length) return configured;
    const ids = new Set(live.map((item) => item.id));
    return [...live, ...configured.filter((item) => !ids.has(item.id))];
  } catch {
    return configured;
  }
}
