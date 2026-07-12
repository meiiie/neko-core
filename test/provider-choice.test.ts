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
  const choices = authChoices(cfg("chatgpt"), "openai", { chatgpt: true, gemini: false, apiProfiles: new Set() });
  expect(choices.map((choice) => choice.id)).toEqual(["chatgpt", "openai"]);
  expect(choices[0].detail).toContain("subscription, no API billing");
  expect(choices[0].detail).toContain("connected");
  expect(choices[1].detail).toContain("pay-as-you-go API");
  expect(choices[1].detail).toContain("not connected");
});

test("Google auth picker recommends API billing and keeps enterprise OAuth explicit", () => {
  const grouped = providerChoices(cfg("gemini"));
  expect(grouped.filter((choice) => choice.id === "google")).toHaveLength(1);
  expect(grouped.find((choice) => choice.id === "google")?.detail).toContain("Gemini API key or Code Assist Enterprise");
  const choices = authChoices(cfg("gemini"), "google", { chatgpt: false, gemini: true, apiProfiles: new Set() });
  expect(choices.map((choice) => choice.id)).toEqual(["gemini-api", "gemini"]);
  expect(choices[0].detail).toContain("pay-as-you-go API");
  expect(choices[1].detail).toContain("Standard/Enterprise only");
  expect(choices[1].detail).toContain("connected");
});

test("profile display and model context name the active OpenAI auth route", () => {
  expect(profileDisplayName(cfg("chatgpt"))).toBe("OpenAI · ChatGPT Plus/Pro");
  expect(profileDisplayName(cfg("openai"))).toBe("OpenAI · API key (pay-as-you-go)");
});
