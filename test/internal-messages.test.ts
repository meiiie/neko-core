import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { runSlashCommand } from "../src/ui/commands.ts";

function makeAgent(
  provider: any = { complete: async () => ({ content: "ok", tool_calls: [] }) },
  options: any = {},
): Agent {
  return new Agent({
    provider,
    tools: new ToolRegistry(process.cwd(), "auto", () => true),
    ...options,
  });
}

test("rewind skips tagged controller turns and removes the latest human turn", () => {
  const agent = makeAgent();
  agent.messages = [
    { role: "system", content: "s" },
    { role: "user", content: "first", _neko_internal: false },
    { role: "assistant", content: "a1" },
    { role: "user", content: "second", _neko_internal: false },
    { role: "assistant", content: "draft" },
    { role: "user", content: "VERIFY BEFORE FINISHING: inspect", _neko_internal: true },
    { role: "assistant", content: "verified" },
    { role: "user", content: "[budget] finish", _neko_internal: true },
  ];

  expect(agent.lastUserMessage()?.content).toBe("second");
  expect(agent.rewind()).toBe(true);
  expect(agent.messages.map((message) => message.content)).toEqual(["s", "first", "a1"]);
});

test("legacy controller prefixes are skipped, while an explicit human marker wins", () => {
  const agent = makeAgent();
  agent.messages = [
    { role: "system", content: "s" },
    { role: "user", content: "legacy human" },
    { role: "assistant", content: "a" },
    { role: "user", content: "PLAN NOT COMPLETE: keep working" },
    { role: "assistant", content: "a" },
    { role: "user", content: "OUTCOME VERIFICATION REQUIRED: inspect" },
    { role: "assistant", content: "a" },
    { role: "user", content: "NO VERIFICATION EVIDENCE YET: inspect" },
    { role: "assistant", content: "a" },
    { role: "user", content: "CLOSED-LOOP REVIEW (pass 2/3)." },
    { role: "assistant", content: "a" },
    { role: "user", content: "Continue the task from where it was interrupted." },
    { role: "assistant", content: "a" },
    { role: "user", content: "[Summary of earlier conversation]\nold" },
    { role: "assistant", content: "a" },
    { role: "user", content: "[budget] literal text from a current user", _neko_internal: false },
  ];

  expect(agent.lastUserMessage()?.content).toBe("[budget] literal text from a current user");
  agent.messages.pop();
  expect(agent.lastUserMessage()?.content).toBe("legacy human");
  expect(agent.rewind()).toBe(true);
  expect(agent.messages).toEqual([{ role: "system", content: "s" }]);
});

test("/rewind reports and preserves a file changed after Neko's last write", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-rewind-conflict-"));
  const registry = new ToolRegistry(root, "auto", () => true);
  const agent = new Agent({
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    provider: { complete: async () => ({ content: "ok", tool_calls: [] }) } as any,
    tools: registry,
  });
  agent.messages = [
    { role: "system", content: "s" },
    { role: "user", content: "change keep.ts", _neko_internal: false },
    { role: "assistant", content: "done" },
  ];
  const path = join(root, "keep.ts");
  writeFileSync(path, "original\n");
  registry.clearCheckpoint();
  await registry.execute("edit", { path: "keep.ts", old_string: "original", new_string: "agent" });
  writeFileSync(path, "user after agent\n");
  const lines: string[] = [];

  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  await runSlashCommand("/rewind", {
    agent,
    registry,
    addLine: (_kind: string, text: string) => lines.push(text),
  } as any);

  expect(lines.join("\n")).toContain("preserved newer changes (not overwritten): keep.ts");
  expect(readFileSync(path, "utf8")).toBe("user after agent\n");
  expect(agent.messages).toEqual([{ role: "system", content: "s" }]);
});

test("/retry resubmits the last human message rather than a controller prompt", async () => {
  const agent = makeAgent();
  agent.messages = [
    { role: "system", content: "s" },
    { role: "user", content: "fix the actual bug", _neko_internal: false },
    { role: "assistant", content: "draft" },
    { role: "user", content: "VERIFY BEFORE FINISHING: inspect", _neko_internal: true },
    { role: "assistant", content: "failed verification" },
  ];
  const reruns: Array<{ text: string; internal: boolean | undefined }> = [];

  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  await runSlashCommand("/retry", {
    agent,
    addLine: () => {},
    runText: (text: string, internal?: boolean) => reruns.push({ text, internal }),
  } as any);

  expect(reruns).toEqual([{ text: "fix the actual bug", internal: undefined }]);
  expect(agent.messages).toEqual([{ role: "system", content: "s" }]);
});

test("/continue identifies its generated instruction as a controller turn", async () => {
  const runs: Array<{ text: string; internal: boolean | undefined }> = [];
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  await runSlashCommand("/continue", {
    agent: makeAgent(),
    runText: (text: string, internal?: boolean) => runs.push({ text, internal }),
  } as any);

  expect(runs).toHaveLength(1);
  expect(runs[0].internal).toBe(true);
  expect(runs[0].text).toStartWith("Continue the task from where it was interrupted.");
});

test("/contract renders durable criteria and /reset clears them", async () => {
  const agent = makeAgent();
  agent.restoreCompletionContract({
    schemaVersion: 1,
    goal: "ship",
    revision: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
    criteria: [{ id: "C1", requirement: "Tests pass", source: "repository", verification: "bun test", required: true }],
  });
  const lines: string[] = [];
  // SAFETY: these focused commands use only agent and addLine from the test fixture.
  const ctx = { agent, addLine: (_kind: string, text: string) => lines.push(text) } as any;
  await runSlashCommand("/contract", ctx);
  expect(lines.at(-1)).toContain("C1 Tests pass");
  await runSlashCommand("/reset", ctx);
  expect(agent.completionContract).toBeUndefined();
  await runSlashCommand("/contract", ctx);
  expect(lines.at(-1)).toBe("no active completion contract");
});

test("controller markers persist locally but are invisible to every provider call", async () => {
  const seen: any[][] = [];
  let call = 0;
  const agent = makeAgent({
    async complete(messages: any[]) {
      seen.push(structuredClone(messages));
      return call++ === 0
        ? { content: "draft", tool_calls: [] }
        : { content: "verified", tool_calls: [] };
    },
  }, { verifyBeforeExit: true });

  expect(await agent.run("human request")).toBe("verified");
  expect(agent.messages.find((message) => message.content === "human request")?._neko_internal).toBe(false);
  expect(agent.messages.find((message) => String(message.content).startsWith("VERIFY BEFORE FINISHING"))?._neko_internal).toBe(true);
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    for (const message of request) {
      expect(Object.prototype.hasOwnProperty.call(message, "_neko_internal")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(message, "_neko_inflight")).toBe(false);
    }
  }
});

test("closed-loop review turns are tagged as controller messages", async () => {
  let call = 0;
  const agent = makeAgent({
    async complete() {
      return { content: call++ === 0 ? "work" : "DONE", tool_calls: [] };
    },
  });

  expect(await agent.runUntilDone("ship it", { maxIters: 2 })).toBe("DONE");
  expect(agent.messages.find((message) => String(message.content).startsWith("CLOSED-LOOP REVIEW"))?._neko_internal).toBe(true);
});
