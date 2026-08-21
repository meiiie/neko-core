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
  const choices = authChoices(cfg("chatgpt"), "openai", { chatgpt: true, gemini: false, kimi: false, opencode: false, apiProfiles: new Set() });
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
  const choices = authChoices(cfg("gemini"), "google", { chatgpt: false, gemini: true, kimi: false, opencode: false, apiProfiles: new Set() });
  expect(choices.map((choice) => choice.id)).toEqual(["gemini-api", "gemini"]);
  expect(choices[0].detail).toContain("official API; free tier available");
  expect(choices[1].detail).toContain("Standard/Enterprise only");
  expect(choices[1].detail).toContain("connected");
});

test("Anthropic and xAI group their official API routes without exposing proxy OAuth", () => {
  const choices = providerChoices(cfg("claude"));
  expect(choices.find((choice) => choice.id === "anthropic")).toMatchObject({ label: "Anthropic", detail: expect.stringContaining("Claude API key") });
  expect(choices.find((choice) => choice.id === "xai")).toMatchObject({ label: "xAI", detail: expect.stringContaining("Grok or Grok Build API key") });
  expect(authChoices(cfg("claude"), "anthropic", { chatgpt: false, gemini: false, kimi: false, opencode: false, apiProfiles: new Set(["claude"]) }).map((choice) => choice.id)).toEqual(["claude", "fable"]);
  expect(authChoices(cfg("xai"), "xai", { chatgpt: false, gemini: false, kimi: false, opencode: false, apiProfiles: new Set(["xai"]) }).map((choice) => choice.id)).toEqual(["xai", "grok-build"]);
});

test("Kimi groups official account OAuth and API billing while DeepSeek stays API-key only", () => {
  const grouped = providerChoices(cfg("kimi"));
  expect(grouped.filter((choice) => choice.id === "kimi")).toHaveLength(1);
  expect(grouped.find((choice) => choice.id === "kimi")?.detail).toContain("Kimi Code account or API key");
  const kimi = authChoices(cfg("kimi"), "kimi", { chatgpt: false, gemini: false, kimi: true, opencode: false, apiProfiles: new Set() });
  expect(kimi.map((choice) => choice.id)).toEqual(["kimi", "moonshot"]);
  expect(kimi[0].detail).toContain("connected");
  expect(kimi[0].detail).toContain("no API key");
  expect(providerChoices(cfg("deepseek")).find((choice) => choice.id === "deepseek")?.detail).toContain("DeepSeek API key");
});

test("Z.AI groups Coding Plan and paid API routes while naming their billing boundary", () => {
  const grouped = providerChoices(cfg("zai"));
  expect(grouped.filter((choice) => choice.id === "zai")).toHaveLength(1);
  expect(grouped.find((choice) => choice.id === "zai")).toMatchObject({
    label: "Z.AI",
    detail: expect.stringContaining("Coding Plan (GLM-5.3) or pay-as-you-go API"),
  });
  const routes = authChoices(cfg("zai"), "zai", {
    chatgpt: false, gemini: false, kimi: false, opencode: false, apiProfiles: new Set(["zai"]),
  });
  expect(routes.map((choice) => choice.id)).toEqual(["zai", "zai-openai"]);
  expect(routes[0]).toMatchObject({
    label: "GLM Coding Plan",
    detail: expect.stringContaining("subscription quota; GLM-5.3 available"),
  });
  expect(routes[1]).toMatchObject({ label: "Z.AI API (pay-as-you-go)", detail: expect.stringContaining("pay-as-you-go API billing") });
  expect(profileDisplayName(cfg("zai"))).toContain("GLM Coding Plan");
});

test("OpenRouter is a first-class API route with an explicit billing boundary", () => {
  const grouped = providerChoices(cfg("openrouter"));
  expect(grouped.find((choice) => choice.id === "openrouter")).toMatchObject({
    label: "OpenRouter",
    detail: expect.stringContaining("live tool-capable model catalog"),
  });
  const routes = authChoices(cfg("openrouter"), "openrouter", {
    chatgpt: false, gemini: false, kimi: false, opencode: false, apiProfiles: new Set(["openrouter"]),
  });
  expect(routes).toEqual([expect.objectContaining({
    id: "openrouter",
    label: "OpenRouter API key",
    detail: expect.stringContaining("OpenRouter pay-as-you-go billing"),
  })]);
  expect(profileDisplayName(cfg("openrouter"))).toBe("OpenRouter · OpenRouter API key");
});

test("OpenCode keeps Console OAuth and Zen service-account billing visibly separate", () => {
  const grouped = providerChoices(cfg("opencode"));
  expect(grouped.find((choice) => choice.id === "opencode")).toMatchObject({
    label: "OpenCode",
    detail: expect.stringContaining("Console account OAuth or Zen service-account key"),
  });
  const routes = authChoices(cfg("opencode"), "opencode", {
    chatgpt: false, gemini: false, kimi: false, opencode: true, apiProfiles: new Set(["opencode"]),
  });
  expect(routes.map((route) => route.id)).toEqual(["opencode-account", "opencode"]);
  expect(routes[0]).toMatchObject({
    label: "OpenCode Console account",
    detail: expect.stringContaining("device OAuth"),
  });
  expect(routes[1]).toMatchObject({
    label: "OpenCode Zen API key",
    detail: expect.stringContaining("service-account billing"),
  });
  expect(profileDisplayName(cfg("opencode"))).toBe("OpenCode · OpenCode Zen API key");
});

test("profile display and model context name the active OpenAI auth route", () => {
  expect(profileDisplayName(cfg("chatgpt"))).toBe("OpenAI · ChatGPT Plus/Pro");
  expect(profileDisplayName(cfg("openai"))).toBe("OpenAI · API key (pay-as-you-go)");
});
