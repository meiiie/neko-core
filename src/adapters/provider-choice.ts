/** Pure provider/auth presentation logic shared by the TUI pickers. Credentials stay in their adapters. */
import type { NekoConfig, Profile } from "./config.ts";

export interface Choice {
  id: string;
  label: string;
  detail: string;
}

export interface AuthAvailability {
  chatgpt: boolean;
  gemini: boolean;
  grok: boolean;
  kimi: boolean;
  opencode: boolean;
  cline?: boolean;
  apiProfiles: Set<string>;
}

function familyOf(name: string, profile: Profile): string {
  return profile.family || name;
}

function familyLabel(family: string): string {
  if (family === "openai") return "OpenAI";
  if (family === "google") return "Google";
  if (family === "anthropic") return "Anthropic";
  if (family === "xai") return "xAI";
  if (family === "kimi") return "Kimi";
  if (family === "deepseek") return "DeepSeek";
  if (family === "zai") return "Z.AI";
  if (family === "openrouter") return "OpenRouter";
  if (family === "bai") return "B.AI";
  if (family === "tokenrouter") return "TokenRouter";
  if (family === "opencode") return "OpenCode";
  if (family === "cline") return "Cline";
  return family;
}

export function providerChoices(cfg: NekoConfig, authOnly = false): Choice[] {
  const seen = new Set<string>();
  const choices: Choice[] = [];
  for (const name of Object.keys(cfg.profiles).sort()) {
    const profile = cfg.profiles[name];
    const family = familyOf(name, profile);
    if (seen.has(family)) continue;
    const routes = Object.entries(cfg.profiles).filter(([n, p]) => familyOf(n, p) === family);
    seen.add(family);
    if (authOnly && routes.every(([, route]) => route.auth === "none")) continue;
    const current = routes.some(([n]) => n === cfg.profile) ? "  (current)" : "";
    choices.push({
      id: family,
      label: familyLabel(family),
      detail: family === "openai"
        ? `ChatGPT Plus/Pro or API key${current}`
        : family === "google"
          ? `Gemini API key or Code Assist Enterprise${current}`
          : family === "anthropic"
            ? `Claude API key${current}`
            : family === "xai"
              ? `Grok subscription or xAI API key${current}`
              : family === "kimi"
                ? `Kimi Code account or API key${current}`
                : family === "deepseek"
                  ? `DeepSeek API key${current}`
                  : family === "zai"
                    ? `Coding Plan (GLM-5.3) or pay-as-you-go API${current}`
                    : family === "openrouter"
                      ? `one API key for the live tool-capable model catalog${current}`
                      : family === "bai"
                        ? `one API key for the live GLM, Qwen, DeepSeek, and MiMo catalog${current}`
                        : family === "tokenrouter"
                          ? `one API key for the live multi-provider model catalog${current}`
                      : family === "opencode"
                        ? `Console account OAuth or Zen service-account key${current}`
                      : family === "cline"
                        ? `Account OAuth or API key${current}`
                      : `${profile.provider ?? "?"} · ${profile.model ?? "?"}${current}`,
    });
  }
  return choices;
}

export function authChoices(cfg: NekoConfig, family: string, availability: AuthAvailability): Choice[] {
  return Object.entries(cfg.profiles)
    .filter(([name, profile]) => familyOf(name, profile) === family)
    .sort(([, a], [, b]) => family === "google"
      ? (a.auth === "api_key" ? -1 : b.auth === "api_key" ? 1 : 0)
      : (a.auth?.endsWith("_oauth") ? -1 : b.auth?.endsWith("_oauth") ? 1 : 0))
    .map(([name, profile]) => {
      const ready = profile.auth === "none"
        || (profile.auth === "chatgpt_oauth" ? availability.chatgpt
          : profile.auth === "gemini_oauth" ? availability.gemini
          : profile.auth === "grok_oauth" ? availability.grok
            : profile.auth === "kimi_oauth" ? availability.kimi
              : profile.auth === "opencode_oauth" ? availability.opencode
                : profile.auth === "cline_oauth" ? Boolean(availability.cline)
            : availability.apiProfiles.has(name));
      const billing = profile.auth === "none" ? "no sign-in required"
        : profile.auth === "chatgpt_oauth" ? "subscription, no API billing"
          : profile.auth === "gemini_oauth" ? "Standard/Enterprise only; consumer plans moved to Antigravity"
            : profile.auth === "grok_oauth" ? "Grok subscription; official xAI device OAuth"
              : profile.auth === "kimi_oauth" ? "Kimi Code account; no API key"
                : profile.auth === "opencode_oauth" ? "OpenCode Console account; device OAuth"
                  : profile.auth === "cline_oauth" ? "Cline Account; official WorkOS device OAuth"
            : family === "google" ? "official API; free tier available"
              : family === "zai" ? (name === "zai" ? "Coding Plan subscription quota; GLM-5.3 available" : "pay-as-you-go API billing")
                : family === "openrouter" ? "OpenRouter pay-as-you-go billing"
                  : family === "bai" ? "B.AI API billing; current promotions are provider-controlled"
                    : family === "tokenrouter" ? "TokenRouter API billing; free routes may change"
                  : family === "opencode" ? "OpenCode Zen service-account billing"
                    : family === "cline" ? "Cline API billing"
                  : "pay-as-you-go API";
      return {
        id: name,
        label: profile.label || name,
        detail: `${ready ? "connected" : "not connected"} · ${billing}${name === cfg.profile ? "  (current)" : ""}`,
      };
    });
}

export function profileDisplayName(cfg: NekoConfig): string {
  if (!cfg.profile) return cfg.provider;
  const profile = cfg.profiles[cfg.profile];
  const family = familyLabel(profile?.family || cfg.profile);
  return profile?.label ? `${family} · ${profile.label}` : family;
}
