/** OpenCode account OAuth and Zen API-key adapters behind one provider-neutral core port. */
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse } from "../core/ports.ts";
import { isJsonNumber, isJsonObject, isText, type JsonObject, type JsonValue } from "../shared/wire.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { NekoConfig } from "./config.ts";
import { OpenAICompatProvider, type ModelOption } from "./providers.ts";
import { ResponsesProvider } from "./responses-provider.ts";
import { hasOpenCodeCredentials, loadOpenCodeAccountConfig, type OpenCodeAccountConfig } from "./opencode-auth.ts";

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";

export type OpenCodeZenTransport = "responses" | "anthropic" | "openai_compat" | "unsupported";

type RemoteModel = JsonObject;
type RemoteProvider = JsonObject;

interface AccountTarget {
  id: string;
  providerId: string;
  modelId: string;
  apiModelId: string;
  baseUrl: string;
  transport: Exclude<OpenCodeZenTransport, "unsupported">;
  token: string;
  providerName: string;
  model: RemoteModel;
}

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

function trustedAccountEndpoint(value: JsonValue | undefined): string | null {
  if (!isText(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "opencode.ai" && !host.endsWith(".opencode.ai"))) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function accountTransport(packageName: JsonValue | undefined): OpenCodeZenTransport {
  if (packageName === "@ai-sdk/openai") return "responses";
  if (packageName === "@ai-sdk/anthropic") return "anthropic";
  if (packageName === "@ai-sdk/openai-compatible") return "openai_compat";
  return "unsupported";
}

function providerEntries(account: OpenCodeAccountConfig): Array<[string, RemoteProvider]> {
  const providers = account.config.provider;
  if (!isJsonObject(providers)) return [];
  return Object.entries(providers).flatMap(([name, value]): Array<[string, RemoteProvider]> =>
    isJsonObject(value) ? [[name, value]] : []
  );
}

function accountTarget(account: OpenCodeAccountConfig, id: string): AccountTarget {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new Error("OpenCode Console models use provider/model IDs. Run /model and choose an account model.");
  }
  const providerId = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  const provider = providerEntries(account).find(([name]) => name === providerId)?.[1];
  const models = provider && isJsonObject(provider.models) ? provider.models : null;
  const model = models?.[modelId];
  if (!provider || !isJsonObject(model)) throw new Error(`OpenCode Console no longer advertises model '${id}'. Run /model again.`);
  const override = isJsonObject(model.provider) ? model.provider : {};
  const packageName = override.npm ?? provider.npm;
  const transport = accountTransport(packageName);
  if (transport === "unsupported") {
    throw new Error(`OpenCode Console model '${id}' uses unsupported protocol '${String(packageName || "native")}'.`);
  }
  const options = isJsonObject(provider.options) ? provider.options : {};
  let baseUrl = trustedAccountEndpoint(override.api ?? provider.api ?? options.baseURL);
  if (!baseUrl) throw new Error(`OpenCode Console model '${id}' returned an untrusted or invalid endpoint.`);
  if (transport === "anthropic" && baseUrl.endsWith("/v1")) baseUrl = baseUrl.slice(0, -3);
  return {
    id,
    providerId,
    modelId,
    apiModelId: isText(model.id) ? model.id : modelId,
    baseUrl,
    transport,
    token: account.token,
    providerName: isText(provider.name) ? provider.name : providerId,
    model,
  };
}

function accountDelegateConfig(config: NekoConfig, target: AccountTarget): NekoConfig {
  const copy = config.withModel(target.apiModelId);
  copy.data.provider = target.transport;
  copy.data.base_url = target.baseUrl;
  const limit = isJsonObject(target.model.limit) ? target.model.limit : null;
  if (isJsonNumber(limit?.context) && limit.context > 0) {
    copy.data.context_window = limit.context;
  }
  return copy;
}

/** Account OAuth gets a server-managed catalog; every completion revalidates the selected route before use. */
export class OpenCodeAccountProvider implements Provider {
  private accountCache: { until: number; value: OpenCodeAccountConfig } | null = null;
  private readonly delegates = new Map<string, { token: string; provider: Provider }>();

  constructor(private readonly config: NekoConfig) {}

  private async account(): Promise<OpenCodeAccountConfig> {
    if (this.accountCache && this.accountCache.until > Date.now()) return this.accountCache.value;
    const value = await loadOpenCodeAccountConfig();
    this.accountCache = { until: Date.now() + 60_000, value };
    return value;
  }

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (!this.config.model) throw new Error("OpenCode Console needs a model. Use /model to choose one.");
    const target = accountTarget(await this.account(), this.config.model);
    const key = `${target.transport}:${target.baseUrl}:${target.apiModelId}`;
    let current = this.delegates.get(key);
    if (current && current.token !== target.token) {
      await current.provider.dispose?.();
      this.delegates.delete(key);
      current = undefined;
    }
    if (!current) {
      const delegated = accountDelegateConfig(this.config, target);
      const resolveToken = () => target.token;
      const provider = target.transport === "responses"
        ? new ResponsesProvider(delegated, resolveToken)
        : target.transport === "anthropic"
          ? new AnthropicProvider(delegated, resolveToken)
          : new OpenAICompatProvider(delegated, resolveToken);
      current = { token: target.token, provider };
      this.delegates.set(key, current);
    }
    return current.provider.complete(messages, tools, onDelta, signal, opts);
  }

  async dispose(): Promise<void> {
    const delegates = [...this.delegates.values()].map((entry) => entry.provider);
    this.delegates.clear();
    this.accountCache = null;
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

function accountOption(config: NekoConfig, account: OpenCodeAccountConfig, providerId: string, provider: RemoteProvider, modelId: string, model: RemoteModel): ModelOption | null {
  const id = `${providerId}/${modelId}`;
  try { accountTarget(account, id); }
  catch { return null; }
  if (model.tool_call === false) return null;
  const modalities = isJsonObject(model.modalities) && Array.isArray(model.modalities.input) ? model.modalities.input : [];
  const limit = isJsonObject(model.limit) ? model.limit : null;
  return {
    id,
    label: isText(model.name) ? model.name : modelId,
    description: `OpenCode Console - ${isText(provider.name) ? provider.name : providerId}`,
    contextWindow: isJsonNumber(limit?.context)
      ? limit.context
      : config.contextWindow,
    vision: model.attachment === true || modalities.includes("image"),
  };
}

export async function listOpenCodeAccountModelOptions(config: NekoConfig): Promise<ModelOption[]> {
  const profile = config.profile ? config.profiles[config.profile] : undefined;
  const fallback = [...new Set([config.model, ...(profile?.models ?? [])].filter(Boolean))].map((id) => ({
    id,
    label: id,
    description: "OpenCode Console account",
    contextWindow: profile?.model_context?.[id] ?? profile?.context_window ?? config.contextWindow,
    vision: false,
  }));
  if (!hasOpenCodeCredentials()) return fallback;
  try {
    const account = await loadOpenCodeAccountConfig();
    const live = providerEntries(account).flatMap(([providerId, provider]) => {
      if (!isJsonObject(provider.models)) return [];
      return Object.entries(provider.models)
        .map(([modelId, model]) => isJsonObject(model) ? accountOption(config, account, providerId, provider, modelId, model) : null)
        .filter((option): option is ModelOption => option !== null);
    });
    return live.length ? live.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)) : fallback;
  } catch {
    return fallback;
  }
}
