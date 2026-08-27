/** Cline Account transport and live model discovery. */
import type { NekoConfig } from "./config.ts";
import { OpenAICompatProvider, type ModelOption } from "./providers.ts";
import type { CompleteOptions, DeltaHook, Provider, ProviderResponse } from "../core/ports.ts";
import { isJsonObject, isText, type JsonValue } from "../shared/wire.ts";
import {
  CLINE_API_BASE_URL,
  clineIdentityHeaders,
  hasClineCredentials,
  validClineAccessToken,
} from "./cline-auth.ts";

/** Account auth uses Cline's OpenAI-compatible API with a Neko-owned, refreshable token. */
export class ClineAccountProvider implements Provider {
  private forceRefresh = false;
  private readonly delegate: OpenAICompatProvider;

  constructor(private readonly cfg: NekoConfig) {
    this.delegate = new OpenAICompatProvider(cfg, async () => {
      const token = await validClineAccessToken({ force: this.forceRefresh });
      this.forceRefresh = false;
      return token;
    }, clineIdentityHeaders);
  }

  async complete(messages: any[], tools?: any[], onDelta?: DeltaHook, signal?: AbortSignal, opts?: CompleteOptions): Promise<ProviderResponse> {
    if (this.cfg.baseUrl !== CLINE_API_BASE_URL) {
      throw new Error("Cline Account must use the official https://api.cline.bot/api/v1 endpoint.");
    }
    try {
      return await this.delegate.complete(messages, tools, onDelta, signal, opts);
    } catch (error) {
      if (!/\bHTTP 401\b/i.test(error instanceof Error ? error.message : String(error))) throw error;
      this.forceRefresh = true;
      return await this.delegate.complete(messages, tools, onDelta, signal, opts);
    } finally {
      this.forceRefresh = false;
    }
  }
}

function configuredOptions(config: NekoConfig): ModelOption[] {
  const profile = config.profile ? config.profiles[config.profile] : undefined;
  return [...new Set([config.model, ...(profile?.models ?? [])].filter(Boolean))].map((id) => ({
    id,
    label: id,
    description: "Cline",
    contextWindow: profile?.model_context?.[id] ?? profile?.context_window ?? config.contextWindow,
    vision: false,
  }));
}

function remoteOption(value: JsonValue, group: string, config: NekoConfig): ModelOption | null {
  if (!isJsonObject(value) || !isText(value.id)) return null;
  if (value.tool_call === false || value.supportsTools === false) return null;
  const description = isText(value.description) ? value.description : "";
  const context = Number(value.context_length ?? value.contextWindow ?? 0);
  const name = isText(value.name) ? value.name : value.id;
  return {
    id: value.id,
    label: name === value.id ? value.id : `${name} (${value.id})`,
    description: [group, description].filter(Boolean).join(" - "),
    contextWindow: Number.isFinite(context) && context > 0 ? context : config.contextWindow,
    vision: value.supportsImages === true || value.vision === true,
  };
}

function mergeOptions(...groups: ModelOption[][]): ModelOption[] {
  const seen = new Set<string>();
  return groups.flat().filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

async function readJson(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Cline model catalog was too large.");
  // SAFETY: JSON syntax can produce only the JsonValue domain.
  return JSON.parse(text) as JsonValue;
}

async function recommendedOptions(config: NekoConfig, fetchImpl: typeof fetch): Promise<ModelOption[]> {
  try {
    const response = await fetchImpl(`${CLINE_API_BASE_URL}/ai/cline/recommended-models`, {
      headers: { ...clineIdentityHeaders(), Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const payload = await readJson(response);
    if (!isJsonObject(payload)) return [];
    const rows: ModelOption[] = [];
    for (const [field, label] of [["free", "Free"], ["clinePass", "Cline Pass"], ["recommended", "Recommended"], ["clineCloud", "Cline Cloud"]] as const) {
      const values = Array.isArray(payload[field]) ? payload[field] : [];
      for (const value of values) {
        const option = remoteOption(value, label, config);
        if (option) rows.push(option);
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function accountOptions(config: NekoConfig, fetchImpl: typeof fetch): Promise<ModelOption[]> {
  if (!hasClineCredentials()) return [];
  const request = async (force = false): Promise<Response> => fetchImpl(`${CLINE_API_BASE_URL}/models`, {
    headers: { ...clineIdentityHeaders(), Accept: "application/json", Authorization: `Bearer ${await validClineAccessToken({ fetchImpl, force })}` },
    signal: AbortSignal.timeout(12_000),
  });
  try {
    let response = await request();
    if (response.status === 401) response = await request(true);
    if (!response.ok) return [];
    const payload = await readJson(response);
    const values = isJsonObject(payload) && Array.isArray(payload.data) ? payload.data : [];
    return values.map((value) => remoteOption(value, "Cline Account", config)).filter((value): value is ModelOption => value !== null);
  } catch {
    return [];
  }
}

/** Public recommendations keep /model useful before sign-in; account models take precedence after it. */
export async function listClineModelOptions(config: NekoConfig, fetchImpl: typeof fetch = fetch): Promise<ModelOption[]> {
  const [account, recommended] = await Promise.all([
    accountOptions(config, fetchImpl),
    recommendedOptions(config, fetchImpl),
  ]);
  return mergeOptions(account, recommended, configuredOptions(config));
}
