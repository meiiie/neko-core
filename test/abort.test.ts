import { expect, test } from "bun:test";

import { Agent } from "../src/core/agent.ts";
import { OpenAICompatProvider, type Provider, type ProviderResponse } from "../src/adapters/providers.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("provider aborts immediately on a pre-aborted signal (no fetch, no retry)", async () => {
  const cfg: any = {
    baseUrl: "http://10.255.255.1:9", model: "x", apiKey: "k", temperature: 0, maxTokens: 10,
    maxRetries: 4, timeoutSeconds: 30, retryBaseDelaySeconds: 1.5, retryMaxDelaySeconds: 30,
  };
  const p = new OpenAICompatProvider(cfg);
  const ac = new AbortController();
  ac.abort();
  const t = Date.now();
  await expect(p.complete([{ role: "user", content: "hi" }], undefined, undefined, ac.signal)).rejects.toThrow();
  expect(Date.now() - t).toBeLessThan(500); // instant, not ~22s of retries
});

test("agent.run returns [interrupted] when the signal is already aborted", async () => {
  const provider: Provider = { async complete(): Promise<ProviderResponse> { return { content: "x", tool_calls: [] }; } };
  const agent = new Agent({ provider, tools: new ToolRegistry(process.cwd(), "default") });
  const ac = new AbortController();
  ac.abort();
  expect(await agent.run("do it", ac.signal)).toBe("[interrupted]");
});
