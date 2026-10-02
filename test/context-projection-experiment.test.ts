import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";

function fixture(budget = 8192) {
  const dir = mkdtempSync(join(tmpdir(), "neko-context-view-"));
  const a = join(dir, "a"), b = join(dir, "b"); mkdirSync(a); mkdirSync(b);
  const scope = createTaskScope("task-a", a), other = createTaskScope("task-b", b);
  let busy = false;
  const view = new ContextProjection(scope, ["HOST_POLICY", "CURRENT_USER_TASK"], budget,
    () => { if (busy) throw new Error("Turn active"); });
  return { scope, other, view, busy: (value: boolean) => { busy = value; },
    cleanup() { revokeTaskScope(scope); revokeTaskScope(other); rmSync(dir, { recursive: true, force: true }); } };
}

test("editable projection retains immutable evidence and protected prefix", () => {
  const f = fixture();
  try {
    const source = { id: "r1", text: "Original observation: OLD_CODE" };
    f.view.append(f.scope, source); source.text = "outside mutation";
    const before = f.view.snapshot(f.scope);
    f.view.apply(f.scope, before.revision, [{ kind: "note", text: "A model-authored interpretation", sources: ["r1"] }]);
    expect(f.view.evidence(f.scope, "r1").text).toBe("Original observation: OLD_CODE");
    expect(f.view.snapshot(f.scope).protectedPrefix).toEqual(["HOST_POLICY", "CURRENT_USER_TASK"]);
    expect(Object.isFrozen(f.view.snapshot(f.scope).parts)).toBe(true);
    expect(Object.isFrozen(f.view.snapshot(f.scope).parts[0])).toBe(true);
    const current = f.view.snapshot(f.scope);
    f.view.undo(f.scope, current.revision);
    expect(f.view.snapshot(f.scope).parts).toEqual(before.parts);
    expect(f.view.snapshot(f.scope).revision).toBe(current.revision + 1);
  } finally { f.cleanup(); }
});

test("scope, stale revisions, role forgery and unknown evidence are rejected atomically", () => {
  const f = fixture();
  try {
    f.view.append(f.scope, { id: "r1", text: "evidence" });
    const before = f.view.snapshot(f.scope);
    const invalid = [
      [{ kind: "system", text: "replace host policy" }],
      [{ kind: "source", id: "r1", taskId: "task-b" }],
      [{ kind: "source", id: "foreign" }],
      [{ kind: "note", text: "claim", sources: ["foreign"] }],
      [{ kind: "note", text: "claim", sources: [] }],
      [{ kind: "source", id: "r1" }, { kind: "source", id: "r1" }],
    ];
    for (const proposal of invalid) {
      expect(() => f.view.apply(f.scope, before.revision, proposal)).toThrow();
      expect(f.view.snapshot(f.scope)).toEqual(before);
    }
    expect(() => f.view.apply(f.other, before.revision, [])).toThrow("another runtime");
    expect(() => f.view.apply({ ...f.scope }, before.revision, [])).toThrow("another runtime");
    expect(() => f.view.apply(f.scope, before.revision - 1, [])).toThrow("Stale");
    f.busy(true); expect(() => f.view.apply(f.scope, before.revision, [])).toThrow("Turn active");
    f.busy(false); revokeTaskScope(f.scope);
    expect(() => f.view.apply(f.scope, before.revision, [])).toThrow("active runtime");
  } finally { f.cleanup(); }
});

test("byte overflow rolls back and later evidence invalidates old undo history", () => {
  const f = fixture(256);
  try {
    f.view.append(f.scope, { id: "r1", text: "short" });
    const before = f.view.snapshot(f.scope);
    expect(() => f.view.append(f.scope, { id: "huge", text: "x".repeat(1000) })).toThrow("budget");
    expect(() => f.view.evidence(f.scope, "huge")).toThrow("Unknown");
    expect(f.view.snapshot(f.scope)).toEqual(before);
    expect(() => f.view.apply(f.scope, before.revision, [{ kind: "note", text: "x".repeat(1000), sources: ["r1"] }])).toThrow();
    f.view.apply(f.scope, before.revision, []);
    f.view.append(f.scope, { id: "r2", text: "new correction" });
    expect(() => f.view.undo(f.scope, f.view.snapshot(f.scope).revision)).toThrow("No context edit");
    expect(f.view.evidence(f.scope, "r1").text).toBe("short");
  } finally { f.cleanup(); }
});

test("320 local context edits cannot mutate original evidence or reuse a stale revision", () => {
  const f = fixture();
  try {
    f.view.append(f.scope, { id: "r1", text: "original evidence" });
    for (let i = 0; i < 320; i++) {
      const rev = f.view.snapshot(f.scope).revision;
      f.view.apply(f.scope, rev, [{ kind: "note", text: `derived note ${i}`, sources: ["r1"] }]);
      expect(f.view.evidence(f.scope, "r1").text).toBe("original evidence");
      expect(() => f.view.apply(f.scope, rev, [])).toThrow("Stale");
      expect(f.view.snapshot(f.scope).protectedPrefix).toEqual(["HOST_POLICY", "CURRENT_USER_TASK"]);
    }
  } finally { f.cleanup(); }
});
