import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextProjection, type ViewPart } from "../experiments/context-projection/projection.ts";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";

test("1280 adversarial edits preserve activation boundaries, exact revisions and immutable originals", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-projection-adversarial-"));
  const roots = [join(home, "one", "app"), join(home, "two", "app")];
  roots.forEach(root => mkdirSync(root, {recursive: true}));
  const cases = Array.from({length: 8}, (_, i) => {
    const scope = createTaskScope(`task-${i % 4}`, roots[Math.floor(i / 4)]);
    const view = new ContextProjection(scope, ["HOST_POLICY", `TASK_${i}`], 32_768, () => {});
    view.append(scope, {id: "same_id", text: `ORIGINAL_${i}`});
    const parts: readonly ViewPart[] = [{kind: "source", id: "same_id"}];
    const undo: Array<readonly ViewPart[]> = [];
    return {scope, view, revision: 1, parts, undo};
  });
  try {
    for (let step = 0; step < 1280; step++) {
      const index = (step * 5) % cases.length;
      const current = cases[index], foreign = cases[(index + 4) % cases.length];
      const before = current.view.snapshot(current.scope);
      expect(before.revision).toBe(current.revision);
      expect(before.parts).toEqual(current.parts);
      expect(() => current.view.apply(foreign.scope, current.revision, [])).toThrow("another runtime");
      expect(() => current.view.evidence(foreign.scope, "same_id")).toThrow("another runtime");
      expect(current.view.snapshot(current.scope)).toEqual(before);
      const oldRevision = current.revision;
      if (step % 7 === 0 && current.undo.length) {
        current.view.undo(current.scope, current.revision);
        current.parts = current.undo.pop()!;
      } else {
        const next = [{kind: "note" as const, text: `DERIVED_${step}`, sources: ["same_id"]}];
        current.view.apply(current.scope, current.revision, next);
        current.undo.push(current.parts);
        if (current.undo.length > 16) current.undo.shift();
        current.parts = structuredClone(next);
        next[0].text = "MUTATED_CALLER_OBJECT";
        next[0].sources[0] = "FOREIGN";
      }
      current.revision++;
      expect(() => current.view.apply(current.scope, oldRevision, [])).toThrow("Stale");
      expect(current.view.snapshot(current.scope).parts).toEqual(current.parts);
      expect(current.view.evidence(current.scope, "same_id").text).toBe(`ORIGINAL_${index}`);
    }
    for (const current of cases) {
      revokeTaskScope(current.scope);
      expect(() => current.view.snapshot(current.scope)).toThrow("active runtime");
    }
  } finally { cases.forEach(current => revokeTaskScope(current.scope)); }
});

test("characterization: valid citations do not prove that a derived note honors a correction", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-projection-truth-gap-"));
  const scope = createTaskScope("corrections", root);
  try {
    const view = new ContextProjection(scope, ["HOST_POLICY", "Remember the current project setting"], 8192, () => {});
    view.append(scope, {id: "old", text: "The package manager is npm."});
    view.append(scope, {id: "correction", text: "Correction: the package manager is pnpm, not npm."});
    // This is intentionally a wrong statement with a real citation. The prototype validates source
    // identity and scope, not entailment or fact supersession. Do not report this test as memory accuracy.
    view.apply(scope, view.snapshot(scope).revision, [{kind: "note", text: "The current package manager is npm.", sources: ["correction"]}]);
    expect(view.snapshot(scope).parts).toEqual([{kind: "note", text: "The current package manager is npm.", sources: ["correction"]}]);
    expect(view.evidence(scope, "correction").text).toContain("pnpm, not npm");
    view.apply(scope, view.snapshot(scope).revision, []);
    expect(view.snapshot(scope).parts).toHaveLength(0);
    expect(view.evidence(scope, "correction").text).toContain("pnpm, not npm");
  } finally { revokeTaskScope(scope); }
});

test("fresh construction does not silently adopt another activation or import its evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-projection-restart-gap-"));
  const oldScope = createTaskScope("same-task", root);
  const old = new ContextProjection(oldScope, ["POLICY"], 8192, () => {});
  old.append(oldScope, {id: "fact", text: "LATEST_CORRECTION"});
  revokeTaskScope(oldScope);
  const nextScope = createTaskScope("same-task", root);
  try {
    const next = new ContextProjection(nextScope, ["POLICY"], 8192, () => {});
    expect(next.snapshot(nextScope).evidenceCount).toBe(0);
    expect(() => old.evidence(nextScope, "fact")).toThrow("active runtime");
    expect(() => next.evidence(nextScope, "fact")).toThrow("Unknown");
  } finally { revokeTaskScope(nextScope); }
});
