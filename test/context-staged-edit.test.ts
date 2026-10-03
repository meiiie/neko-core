import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { captureSourceGroup, admitStructuredSource, renderStructuredView } from "../experiments/context-projection/structured-sources.ts";
import { stageContextEdit, commitStagedContextEdit, workingContextDigest } from "../experiments/context-projection/staged-edit.ts";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";
import type { JsonObject } from "../src/shared/wire.ts";

const prefix: JsonObject[] = [{role: "system", content: "HOST_POLICY"}];
const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
function fixture() {
  const scope = createTaskScope("staging", mkdtempSync(join(tmpdir(), "neko-context-stage-")));
  let busy = false;
  const view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 8192, () => {if (busy) throw new Error("Turn active");});
  const old = captureSourceGroup(scope, 1, [{role: "user", content: "old request"}, {role: "assistant", content: "old answer"}]);
  admitStructuredSource(scope, view, old, prefix, 20_000, count);
  const working = {messages: renderStructuredView(scope, view, prefix, 20_000, count)};
  return {scope, view, old, working, busy: (value: boolean) => {busy = value;}};
}

test("a proposal staged during a turn commits only after quiescence and preserves its new complete tail", () => {
  const f = fixture();
  try {
    f.busy(true);
    const token = stageContextEdit(f.scope, f.view, [{kind: "note", text: "older summary", sources: [f.old.id]}], f.working.messages);
    const before = f.view.snapshot(f.scope), digest = workingContextDigest(f.working.messages);
    expect(() => commitStagedContextEdit(f.scope, f.view, token, f.working, digest, prefix, 20_000, count)).toThrow("Turn active");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    f.busy(false);
    const tail: JsonObject[] = [{role: "user", content: "NEW_USER_CORRECTION"}, {role: "assistant", content: "NEW_RESPONSE"}];
    admitStructuredSource(f.scope, f.view, captureSourceGroup(f.scope, 2, tail), prefix, 20_000, count);
    f.working.messages.push(...tail);
    const next = commitStagedContextEdit(f.scope, f.view, token, f.working, workingContextDigest(f.working.messages), prefix, 20_000, count);
    expect(f.working.messages.slice(-2)).toEqual(tail);
    expect(f.working.messages[1].role).toBe("assistant");
    expect(f.working.messages[1].content).toContain("Unverified derived note");
    expect(next).toBe(workingContextDigest(f.working.messages));
    expect(() => commitStagedContextEdit(f.scope, f.view, token, f.working, next, prefix, 20_000, count)).toThrow("consumed");
  } finally { revokeTaskScope(f.scope); }
});

test("a stale, forged, replaced or reentrant proposal cannot change the view or working messages", () => {
  const f = fixture();
  try {
    const first = stageContextEdit(f.scope, f.view, [], f.working.messages);
    const token = stageContextEdit(f.scope, f.view, [], f.working.messages);
    const digest = workingContextDigest(f.working.messages), before = f.view.snapshot(f.scope);
    expect(() => commitStagedContextEdit(f.scope, f.view, first, f.working, digest, prefix, 20_000, count)).toThrow("Unknown");
    expect(() => commitStagedContextEdit(f.scope, f.view, {...token}, f.working, digest, prefix, 20_000, count)).toThrow("Unknown");
    expect(() => commitStagedContextEdit(f.scope, f.view, token, f.working, "0".repeat(64), prefix, 20_000, count)).toThrow("checkpoint changed");
    expect(() => commitStagedContextEdit(f.scope, f.view, token, f.working, digest, prefix, 1, count)).toThrow("token budget");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    expect(workingContextDigest(f.working.messages)).toBe(digest);
    f.view.apply(f.scope, before.revision, []);
    expect(() => commitStagedContextEdit(f.scope, f.view, token, f.working, digest, prefix, 20_000, count)).toThrow("view changed");
  } finally { revokeTaskScope(f.scope); }
});

test("unarchived canonical tail cannot be silently dropped by a staged compaction", () => {
  const f = fixture();
  try {
    const token = stageContextEdit(f.scope, f.view, [], f.working.messages);
    f.working.messages.push({role: "user", content: "NEW_UNARCHIVED_CORRECTION"});
    const before = f.view.snapshot(f.scope), digest = workingContextDigest(f.working.messages);
    expect(() => commitStagedContextEdit(f.scope, f.view, token, f.working, digest, prefix, 20_000, count)).toThrow("unarchived");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    expect(workingContextDigest(f.working.messages)).toBe(digest);
  } finally { revokeTaskScope(f.scope); }
});
