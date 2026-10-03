import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { captureSourceGroup, currentStructuredFacts, renderStructuredView, applyStructuredEdit, admitStructuredSource } from "../experiments/context-projection/structured-sources.ts";
import { loadProjection, saveProjection } from "../experiments/context-projection/storage.ts";
import { createTaskScope, revokeTaskScope, type TaskScope } from "../src/core/task-scope.ts";
import type { JsonObject } from "../src/shared/wire.ts";

const prefix: JsonObject[] = [{role: "system", content: "Host policy and current task"}];
const protectedPrefix = prefix.map(message => JSON.stringify(message));
const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
const make = (scope: TaskScope, sequence: number, value: string, supersedes: string[] = []) => captureSourceGroup(scope, sequence,
  [{role: "user", content: value}, {role: "assistant", content: "recorded"}], [], "user",
  [{key: "project.packageManager", messageIndex: 0, start: 0, end: value.length, supersedes}]);

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-structured-facts-"));
  const scope = createTaskScope("facts", home);
  const view = new ContextProjection(scope, protectedPrefix, 8192, () => {});
  return {home, scope, view};
}

test("explicit corrections stay pinned even when an editable note contradicts or omits them", () => {
  const f = fixture();
  try {
    const first = make(f.scope, 1, "npm");
    admitStructuredSource(f.scope, f.view, first, prefix, 20_000, count);
    const corrected = make(f.scope, 2, "pnpm", [`${first.id}_0`]);
    admitStructuredSource(f.scope, f.view, corrected, prefix, 20_000, count);
    applyStructuredEdit(f.scope, f.view, f.view.snapshot(f.scope).revision,
      [{kind: "note", text: "Wrong derived note: npm", sources: [corrected.id]}], prefix, 20_000, count);
    expect(currentStructuredFacts(f.scope, f.view)[0].alternatives.map(fact => fact.value)).toEqual(["pnpm"]);
    expect(f.view.evidence(f.scope, first.id).text).toContain('"npm"');
    const rendered = renderStructuredView(f.scope, f.view, prefix, 20_000, count);
    expect(rendered[1].content).toContain("Unverified derived note");
    expect(rendered.at(-1)?.content).toContain('"value":"pnpm"');
    applyStructuredEdit(f.scope, f.view, f.view.snapshot(f.scope).revision, [], prefix, 20_000, count);
    expect(renderStructuredView(f.scope, f.view, prefix, 20_000, count).at(-1)?.content).toContain('"value":"pnpm"');
    const before = f.view.snapshot(f.scope);
    expect(() => applyStructuredEdit(f.scope, f.view, before.revision, [], prefix, 10, count)).toThrow("token budget");
    expect(f.view.snapshot(f.scope)).toEqual(before);
  } finally { revokeTaskScope(f.scope); }
});

test("unresolved contradictions remain explicit and stale corrections cannot overwrite a newer fact", () => {
  const f = fixture();
  try {
    const a = make(f.scope, 1, "npm"), b = make(f.scope, 2, "bun");
    admitStructuredSource(f.scope, f.view, a, prefix, 20_000, count);
    admitStructuredSource(f.scope, f.view, b, prefix, 20_000, count);
    expect(currentStructuredFacts(f.scope, f.view)[0].state).toBe("conflict");
    expect(currentStructuredFacts(f.scope, f.view)[0].alternatives).toHaveLength(2);
    const c = make(f.scope, 3, "pnpm", [`${a.id}_0`, `${b.id}_0`]);
    admitStructuredSource(f.scope, f.view, c, prefix, 20_000, count);
    expect(currentStructuredFacts(f.scope, f.view)[0].state).toBe("current");
    const before = f.view.snapshot(f.scope);
    const stale = make(f.scope, 4, "npm", [`${a.id}_0`]);
    expect(() => admitStructuredSource(f.scope, f.view, stale, prefix, 20_000, count)).toThrow("Stale");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    expect(() => f.view.evidence(f.scope, stale.id)).toThrow("Unknown");
    expect(currentStructuredFacts(f.scope, f.view)[0].alternatives[0].value).toBe("pnpm");
  } finally { revokeTaskScope(f.scope); }
});

test("model output and runtime summaries cannot mint user-fact annotations", () => {
  const f = fixture();
  try {
    const messages: JsonObject[] = [{role: "user", content: "question"}, {role: "assistant", content: "pnpm"}];
    const fact = {key: "tooling", messageIndex: 1, start: 0, end: 4, supersedes: []};
    expect(() => captureSourceGroup(f.scope, 1, messages, [], "user", [fact])).toThrow("original user");
    expect(() => captureSourceGroup(f.scope, 1, messages, [], "runtime", [{...fact, messageIndex: 0}])).toThrow("annotations");
    expect(() => captureSourceGroup(f.scope, 1, messages, [], "user", [{...fact, messageIndex: 0, end: 100}])).toThrow("original user");
  } finally { revokeTaskScope(f.scope); }
});

test("320 synthetic correction/compaction cycles retain the latest pinned source across four disk restarts", () => {
  const f = fixture();
  let scope = f.scope, view = f.view, previous = "", storeRevision: number | null = null;
  try {
    for (let turn = 0; turn < 320; turn++) {
      const value = `latest-value-${turn}`;
      const source = make(scope, turn + 1, value, previous ? [`${previous}_0`] : []);
      admitStructuredSource(scope, view, source, prefix, 20_000, count);
      // Deliberately poor synthetic compaction notes cannot delete the independently pinned source.
      applyStructuredEdit(scope, view, view.snapshot(scope).revision,
        [{kind: "note", text: "Stale or incomplete synthetic summary", sources: [source.id]}], prefix, 20_000, count);
      const facts = currentStructuredFacts(scope, view);
      expect(facts[0].state).toBe("current");
      expect(facts[0].alternatives.map(fact => fact.value)).toEqual([value]);
      expect(renderStructuredView(scope, view, prefix, 20_000, count).at(-1)?.content).toContain(JSON.stringify(value));
      previous = source.id;
      if ((turn + 1) % 80 === 0) {
        const working = createHash("sha256").update(JSON.stringify({turn, source: source.id})).digest("hex");
        const before = view.snapshot(scope);
        storeRevision = saveProjection(f.home, scope, view, working, storeRevision);
        revokeTaskScope(scope); scope = createTaskScope("facts", f.home);
        const restored = loadProjection(f.home, scope, protectedPrefix, 8192, () => {}, working);
        view = restored.view;
        expect(view.snapshot(scope)).toEqual(before);
        expect(currentStructuredFacts(scope, view)[0].alternatives[0].value).toBe(value);
      }
    }
    expect(view.snapshot(scope).evidenceCount).toBe(320);
  } finally { revokeTaskScope(scope); }
}, 20_000);
