import { expect, test } from "bun:test";

import { DEFAULTS, NekoConfig } from "../src/adapters/config.ts";
import { authChoices, profileDisplayName, providerChoices } from "../src/adapters/provider-choice.ts";

function cfg(profile: string | null): NekoConfig {
  const profiles = structuredClone(DEFAULTS.profiles);
  const data = profile ? { ...DEFAULTS, ...profiles[profile] } : { ...DEFAULTS };
  return new NekoConfig(data, profile, profiles, "");
}

test("provider picker groups ChatGPT subscription and OpenAI API under one OpenAI entry", () => {
  const choices = providerChoices(cfg("chatgpt"));
  expect(choices.filter((choice) => choice.id === "openai")).toHaveLength(1);
  expect(choices.some((choice) => choice.id === "chatgpt")).toBe(false);
  expect(choices.find((choice) => choice.id === "openai")?.detail).toContain("ChatGPT Plus/Pro or API key");
  expect(providerChoices(cfg("chatgpt"), true).some((choice) => choice.id === "ollama")).toBe(false);
});

test("OpenAI auth picker keeps subscription and API billing visibly separate", () => {
  const choices = authChoices(cfg("chatgpt"), "openai", { chatgpt: true, gemini: false, kimi: false, apiProfiles: new Set() });
  expect(choices.map((choice) => choice.id)).toEqual(["chatgpt", "openai"]);
  expect(choices[0].detail).toContain("subscription, no API billing");
  expect(choices[0].detail).toContain("connected");
  expect(choices[1].detail).toContain("pay-as-you-go API");
  expect(choices[1].detail).toContain("not connected");
});

test("Google auth picker recommends the official API free tier and keeps enterprise OAuth explicit", () => {
  const grouped = providerChoices(cfg("gemini"));
  expect(grouped.filter((choice) => choice.id === "google")).toHaveLength(1);
  expect(grouped.find((choice) => choice.id === "google")?.detail).toContain("Gemini API key or Code Assist Enterprise");
  const choices = authChoices(cfg("gemini"), "google", { chatgpt: false, gemini: true, kimi: false, apiProfiles: new Set() });
  expect(choices.map((choice) => choice.id)).toEqual(["gemini-api", "gemini"]);
  expect(choices[0].detail).toContain("official API; free tier available");
  expect(choices[1].detail).toContain("Standard/Enterprise only");
  expect(choices[1].detail).toContain("connected");
});

test("Anthropic and xAI group their official API routes without exposing proxy OAuth", () => {
  const choices = providerChoices(cfg("claude"));
  expect(choices.find((choice) => choice.id === "anthropic")).toMatchObject({ label: "Anthropic", detail: expect.stringContaining("Claude API key") });
  expect(choices.find((choice) => choice.id === "xai")).toMatchObject({ label: "xAI", detail: expect.stringContaining("Grok or Grok Build API key") });
  expect(authChoices(cfg("claude"), "anthropic", { chatgpt: false, gemini: false, kimi: false, apiProfiles: new Set(["claude"]) }).map((choice) => choice.id)).toEqual(["claude", "fable"]);
  expect(authChoices(cfg("xai"), "xai", { chatgpt: false, gemini: false, kimi: false, apiProfiles: new Set(["xai"]) }).map((choice) => choice.id)).toEqual(["xai", "grok-build"]);
});

test("Kimi groups official account OAuth and API billing while DeepSeek stays API-key only", () => {
  const grouped = providerChoices(cfg("kimi"));
  expect(grouped.filter((choice) => choice.id === "kimi")).toHaveLength(1);
  expect(grouped.find((choice) => choice.id === "kimi")?.detail).toContain("Kimi Code account or API key");
  const kimi = authChoices(cfg("kimi"), "kimi", { chatgpt: false, gemini: false, kimi: true, apiProfiles: new Set() });
  expect(kimi.map((choice) => choice.id)).toEqual(["kimi", "moonshot"]);
  expect(kimi[0].detail).toContain("connected");
  expect(kimi[0].detail).toContain("no API key");
  expect(providerChoices(cfg("deepseek")).find((choice) => choice.id === "deepseek")?.detail).toContain("DeepSeek API key");
});

test("profile display and model context name the active OpenAI auth route", () => {
  expect(profileDisplayName(cfg("chatgpt"))).toBe("OpenAI · ChatGPT Plus/Pro");
  expect(profileDisplayName(cfg("openai"))).toBe("OpenAI · API key (pay-as-you-go)");
});
