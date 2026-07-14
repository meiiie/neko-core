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
  kimi: boolean;
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
              ? `Grok or Grok Build API key${current}`
              : family === "kimi"
                ? `Kimi Code account or API key${current}`
                : family === "deepseek"
                  ? `DeepSeek API key${current}`
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
          : profile.auth === "kimi_oauth" ? availability.kimi
            : availability.apiProfiles.has(name));
      const billing = profile.auth === "none" ? "no sign-in required"
        : profile.auth === "chatgpt_oauth" ? "subscription, no API billing"
          : profile.auth === "gemini_oauth" ? "Standard/Enterprise only; consumer plans moved to Antigravity"
            : profile.auth === "kimi_oauth" ? "Kimi Code account; no API key"
            : family === "google" ? "official API; free tier available"
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
