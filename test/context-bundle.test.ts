import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { PagedSources } from "../experiments/context-projection/paged-sources.ts";
import { saveContextBundle, loadContextBundle, saveProjection } from "../experiments/context-projection/storage.ts";
import { captureSourceGroup, admitStructuredSource, renderStructuredView } from "../experiments/context-projection/structured-sources.ts";
import { createTaskScope, revokeTaskScope, type TaskScope } from "../src/core/task-scope.ts";
import type { JsonObject } from "../src/shared/wire.ts";

const prefix: JsonObject[] = [{role: "system", content: "HOST_POLICY"}];
const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
const make = (scope: TaskScope, sequence: number, text: string) => captureSourceGroup(scope, sequence,
  [{role: "user", content: text}, {role: "assistant", content: "ack"}]);

test("one atomic bundle restores provider context, projection revision and the exact immutable source head", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-context-bundle-"));
  let scope = createTaskScope("bundle", home);
  try {
    const journal = new PagedSources(home, scope);
    const view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 8192, () => {});
    const a = make(scope, 1, "original"); journal.append(a);
    admitStructuredSource(scope, view, a, prefix, 20_000, count);
    const messages = renderStructuredView(scope, view, prefix, 20_000, count);
    expect(saveContextBundle(home, scope, view, messages, journal.reference(), null, prefix, 20_000, count)).toBe(1);
    const expected = {messages, view: view.snapshot(scope), sources: journal.reference()};
    // A later unreferenced journal branch must not silently replace the source head in the bundle.
    journal.append(make(scope, 2, "unpublished future source"));
    revokeTaskScope(scope); scope = createTaskScope("bundle", home);
    const restored = loadContextBundle(home, scope, prefix, 8192, () => {}, 20_000, count);
    expect(restored.messages).toEqual(expected.messages);
    expect(restored.view.snapshot(scope)).toEqual(expected.view);
    expect(restored.journal.reference()).toEqual(expected.sources);
    expect(restored.journal.stats().sources).toBe(1);
    expect(() => saveProjection(home, scope, restored.view, "a".repeat(64), 1)).toThrow("downgraded");
  } finally { revokeTaskScope(scope); }
});

test("mismatched working messages, branch sources and corrupted parent binding fail closed", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-context-bundle-reject-"));
  const scope = createTaskScope("bundle", home);
  try {
    const journal = new PagedSources(home, scope), a = make(scope, 1, "A");
    const old = journal.append(a);
    const b = make(scope, 2, "B"); journal.append(b);
    const branch = new PagedSources(home, scope, old), c = make(scope, 2, "C"); branch.append(c);
    const view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 8192, () => {});
    admitStructuredSource(scope, view, c, prefix, 20_000, count);
    const messages = renderStructuredView(scope, view, prefix, 20_000, count);
    expect(() => saveContextBundle(home, scope, view, messages, journal.reference(), null, prefix, 20_000, count)).toThrow("selected journal branch");
    expect(() => saveContextBundle(home, scope, view, [{role: "system", content: "WRONG"}], branch.reference(), null, prefix, 20_000, count)).toThrow("validated projection");
    saveContextBundle(home, scope, view, messages, branch.reference(), null, prefix, 20_000, count);
    const directory = join(home, ".neko-core", "context-projection-experiment");
    const path = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    const payload = JSON.parse(readFileSync(path, "utf8"));
    payload.sourceJournal = journal.reference();
    writeFileSync(path, JSON.stringify(payload));
    expect(() => loadContextBundle(home, scope, prefix, 8192, () => {}, 20_000, count)).toThrow("binding");
  } finally { revokeTaskScope(scope); }
});
