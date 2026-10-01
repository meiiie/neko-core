import { expect, test } from "bun:test";
import { NekoConfig } from "../src/adapters/config.ts";
import { OpenAICompatProvider } from "../src/adapters/providers.ts";
import { AnthropicProvider } from "../src/adapters/anthropic.ts";
import { ResponsesProvider } from "../src/adapters/responses-provider.ts";

for (const Adapter of [OpenAICompatProvider, AnthropicProvider, ResponsesProvider]) {
  test(`${Adapter.name} rejects pre-cancelled calls before credential resolution`, async () => {
    let calls = 0;
    const cfg = new NekoConfig({ base_url: "https://example.invalid/v1", model: "synthetic" }, null, {}, "");
    const provider = new Adapter(cfg, () => { calls++; throw new Error("credential lookup must not start"); });
    const controller = new AbortController(); controller.abort();
    await expect(provider.complete([], undefined, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  test(`${Adapter.name} cancellation stops waiting for a pending credential resolver`, async () => {
    const cfg = new NekoConfig({ base_url: "https://example.invalid/v1", model: "synthetic" }, null, {}, "");
    let release!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const key = new Promise<string>((resolve) => { release = resolve; });
    let headers = 0;
    const provider = new Adapter(cfg, () => { started(); return key; }, () => { headers++; throw new Error("headers must not start"); });
    const controller = new AbortController();
    const outcome = provider.complete([], undefined, undefined, controller.signal).then(() => null, (error) => error);
    await ready; controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([outcome, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 250); })]);
      expect(result).toMatchObject({ name: "AbortError" });
      expect(headers).toBe(0);
    } finally { if (timer) clearTimeout(timer); release("synthetic-key"); await outcome; }
  });
}
