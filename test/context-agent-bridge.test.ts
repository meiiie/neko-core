import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { admitStructuredSource, captureSourceGroup } from "../experiments/context-projection/structured-sources.ts";
import { commitStagedContextEdit, stageContextEdit, workingContextDigest, type StagedContextEdit } from "../experiments/context-projection/staged-edit.ts";
import type { JsonObject } from "../src/shared/wire.ts";

test("opt-in host bridge preserves a real Agent tool round and applies the corrected context only between turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-context-agent-"));
  writeFileSync(join(root, "fixture.txt"), "RAW_FILE_OBSERVATION");
  const scope = createTaskScope("agent-bridge", root);
  const tools = new ToolRegistry(root, "auto", () => false);
  tools.bindTaskScope(scope);
  let busy = false, stage: StagedContextEdit | undefined;
  let prefix: JsonObject[] = [], base: JsonObject[] = [];
  let sourceId = "";
  let view: ContextProjection;
  const requests: string[] = [];
  const agent = new Agent({tools, systemPrompt: "HOST_POLICY", maxContextTokens: 100_000,
    verifyBeforeExit: false, verifyStateChangesBeforeExit: false,
    provider: {complete: async messages => {
      requests.push(JSON.stringify(messages));
      const user = [...messages].reverse().find(message => message.role === "user")?.content;
      if (user === "npm") {
        if (messages.at(-1)?.role !== "tool") return {content: null, tool_calls: [{id: "read-original", name: "read_file", arguments: {path: "fixture.txt"}}]};
        return {content: "Observed initial setting", tool_calls: []};
      }
      if (user === "pnpm") {
        stage = stageContextEdit(scope, view, [{kind: "note", text: "Historical initial setting: npm", sources: [sourceId]}], base);
        const before = view.snapshot(scope), working = workingContextDigest(agent.messages);
        expect(() => commitStagedContextEdit(scope, view, stage!, agent, working, prefix, 30_000, count)).toThrow("unarchived");
        expect(view.snapshot(scope)).toEqual(before);
        expect(workingContextDigest(agent.messages)).toBe(working);
        return {content: "Correction received", tool_calls: []};
      }
      const pinned = messages.findLast(message => String(message.content ?? "").startsWith("[Host-selected exact user-source spans"));
      if (!pinned) throw new Error("Corrected source facts were not supplied to the provider");
      const facts = JSON.parse(String(pinned.content).split("\n").slice(1).join("\n"));
      return {content: String(facts[0].alternatives[0].value), tool_calls: []};
    }},
  });
  const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
  try {
    busy = true; await agent.run("npm"); busy = false;
    prefix = structuredClone(agent.messages.filter(message => message.role === "system"));
    view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 16_384, () => {if (busy) throw new Error("Turn active");});
    const first = captureSourceGroup(scope, 1, agent.messages.filter(message => message.role !== "system"), [], "user",
      [{key: "packageManager", messageIndex: 0, start: 0, end: 3, supersedes: []}]);
    sourceId = first.id;
    admitStructuredSource(scope, view, first, prefix, 30_000, count);
    expect(first.text).toContain("RAW_FILE_OBSERVATION");
    base = structuredClone(agent.messages);
    busy = true; await agent.run("pnpm"); busy = false;
    const second = captureSourceGroup(scope, 2, agent.messages.slice(base.length), [], "user",
      [{key: "packageManager", messageIndex: 0, start: 0, end: 4, supersedes: [`${first.id}_0`]}]);
    admitStructuredSource(scope, view, second, prefix, 30_000, count);
    expect(stage).toBeDefined();
    commitStagedContextEdit(scope, view, stage!, agent, workingContextDigest(agent.messages), prefix, 30_000, count);
    expect(view.evidence(scope, first.id).text).toContain("RAW_FILE_OBSERVATION");
    busy = true; const answer = await agent.run("current package manager?"); busy = false;
    expect(answer).toBe("pnpm");
    expect(requests.at(-1)).toContain('Host-selected exact user-source spans');
    expect(requests.at(-1)).toContain('Unverified derived note');
  } finally { busy = false; revokeTaskScope(scope); }
});
