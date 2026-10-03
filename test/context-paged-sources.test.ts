import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PagedSources } from "../experiments/context-projection/paged-sources.ts";
import { captureSourceGroup, admitStructuredSource, renderStructuredView } from "../experiments/context-projection/structured-sources.ts";
import { saveContextBundle, saveContextBundleAsync, loadContextBundle } from "../experiments/context-projection/storage.ts";
import { ContextProjection } from "../experiments/context-projection/projection.ts";
import { createTaskScope, revokeTaskScope, type TaskScope } from "../src/core/task-scope.ts";
import type { JsonObject } from "../src/shared/wire.ts";

const source = (scope: TaskScope, sequence: number, value: string, previous = "", payload = "ack") => captureSourceGroup(scope, sequence,
  [{role: "user", content: value}, {role: "assistant", content: payload}], [], "user",
  [{key: "current.value", messageIndex: 0, start: 0, end: value.length, supersedes: previous ? [`${previous}_0`] : []}]);

test("1024 original turns exceed the in-memory prototype while disk paging and working caches stay bounded", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-context-"));
  let scope = createTaskScope("long-session", home);
  let journal = new PagedSources(home, scope);
  let previous = "", first = "";
  try {
    for (let index = 0; index < 1024; index++) {
      const chunk = source(scope, index + 1, `VALUE_${index}`, previous, "original body ".repeat(800));
      if (!first) first = chunk.id;
      journal.append(chunk); previous = chunk.id;
    }
    expect(journal.stats()).toEqual({sources: 1024, cachedObjects: 0, cachedBytes: 0});
    const frozen = journal.reference();
    revokeTaskScope(scope); scope = createTaskScope("long-session", home);
    journal = new PagedSources(home, scope, JSON.parse(JSON.stringify(frozen)));
    expect(journal.stats().cachedObjects).toBe(1);
    expect(journal.facts(scope)[0].alternatives[0].value).toBe("VALUE_1023");
    expect(journal.read(first).text).toContain('"VALUE_0"');
    let page = journal.page(), seen = page.sources.length;
    while (page.older) { page = journal.page(page.older); seen += page.sources.length; }
    expect(seen).toBe(1024);
    expect(journal.stats().cachedObjects).toBeLessThanOrEqual(64);
    expect(journal.stats().cachedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    const prefix: JsonObject[] = [{role: "system", content: "HOST_POLICY"}];
    const view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 64 * 1024, () => {});
    const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
    const facts = (runtimeScope: TaskScope) => journal.facts(runtimeScope);
    for (const chunk of journal.page(undefined, 2).sources) admitStructuredSource(scope, view, chunk, prefix, 100_000, count, facts);
    expect(view.snapshot(scope).evidenceCount).toBe(2);
    const working = renderStructuredView(scope, view, prefix, 100_000, count, undefined, facts);
    expect(working.at(-1)?.content).toContain('"VALUE_1023"');
    saveContextBundle(home, scope, view, working, journal.reference(), null, prefix, 100_000, count);
    revokeTaskScope(scope); scope = createTaskScope("long-session", home);
    const restored = loadContextBundle(home, scope, prefix, 64 * 1024, () => {}, 100_000, count);
    journal = restored.journal;
    expect(restored.view.snapshot(scope).evidenceCount).toBe(2);
    expect(restored.messages).toEqual(working);
    expect(journal.stats().sources).toBe(1024);
    expect(journal.stats().cachedObjects).toBeLessThanOrEqual(3);
  } finally { revokeTaskScope(scope); }
}, 30_000);

test("frozen cursors and separate branches cannot silently retarget an earlier journal checkpoint", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-branches-"));
  const scope = createTaskScope("branches", home);
  try {
    const first = source(scope, 1, "A");
    const journal = new PagedSources(home, scope);
    const original = journal.append(first);
    const second = source(scope, 2, "B", first.id);
    journal.append(second);
    expect(journal.page(original.head).sources.map(item => item.id)).toEqual([first.id]);
    const branch = new PagedSources(home, scope, original);
    const other = source(scope, 2, "C", first.id);
    branch.append(other);
    expect(branch.page().sources.map(item => item.id)).toEqual([first.id, other.id]);
    expect(journal.page().sources.map(item => item.id)).toEqual([first.id, second.id]);
    expect(branch.facts(scope)[0].alternatives[0].value).toBe("C");
    expect(journal.facts(scope)[0].alternatives[0].value).toBe("B");
    const foreign = createTaskScope("foreign", home);
    try {
      expect(() => new PagedSources(home, foreign, original)).toThrow("Foreign");
      expect(() => journal.facts(foreign)).toThrow("another activation");
    } finally { revokeTaskScope(foreign); }
  } finally { revokeTaskScope(scope); }
});

test("a simulated disk-full write leaves the previous source head and facts recoverable", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-disk-full-"));
  const scope = createTaskScope("disk-full", home);
  const journal = new PagedSources(home, scope);
  const first = source(scope, 1, "OLD");
  const before = journal.append(first);
  const modules = {
    journal: new URL("../experiments/context-projection/paged-sources.ts", import.meta.url).href,
    source: new URL("../experiments/context-projection/structured-sources.ts", import.meta.url).href,
    scope: new URL("../src/core/task-scope.ts", import.meta.url).href,
  };
  const script = `import {mock} from 'bun:test'; import * as fs from 'node:fs';
    mock.module('node:fs',()=>({...fs,writeFileSync(){const error=new Error('simulated disk full');error.code='ENOSPC';throw error;}}));
    const {PagedSources}=await import(${JSON.stringify(modules.journal)});
    const {captureSourceGroup}=await import(${JSON.stringify(modules.source)});
    const {createTaskScope}=await import(${JSON.stringify(modules.scope)});
    const scope=createTaskScope('disk-full',${JSON.stringify(home)});
    const journal=new PagedSources(${JSON.stringify(home)},scope,${JSON.stringify(before)});
    const next=captureSourceGroup(scope,2,[{role:'user',content:'NEW'},{role:'assistant',content:'ack'}]);
    let failed=false;try{journal.append(next);}catch(e){failed=e.code==='ENOSPC';}
    console.log(JSON.stringify({failed,reference:journal.reference(),value:journal.facts(scope)[0].alternatives[0].value}));`;
  const child = Bun.spawn([process.execPath, "--eval", script], {stdin: "ignore", stdout: "pipe", stderr: "pipe"});
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({code, error}).toEqual({code: 0, error: ""});
  expect(JSON.parse(output)).toEqual({failed: true, reference: before, value: "OLD"});
  expect(new PagedSources(home, scope, before).read(first.id).text).toContain('"OLD"');
  revokeTaskScope(scope);
});

test("an oversized original is rejected without truncation or a changed source head", () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-large-"));
  const scope = createTaskScope("large", home);
  try {
    const journal = new PagedSources(home, scope);
    const before = journal.append(source(scope, 1, "ORIGINAL"));
    expect(() => journal.append(source(scope, 2, "NEW", "", "x".repeat(2 * 1024 * 1024)))).toThrow("storage budget");
    expect(journal.reference()).toEqual(before);
    expect(journal.facts(scope)[0].alternatives[0].value).toBe("ORIGINAL");
  } finally { revokeTaskScope(scope); }
});


test("async ancestry keeps the event loop available and preserves the selected branch", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-async-"));
  const scope = createTaskScope("async-ancestry", home), journal = new PagedSources(home, scope);
  let first = "";
  for (let i = 1; i <= 128; i++) {
    const chunk = captureSourceGroup(scope, i, [{role: "user", content: `turn ${i}`}, {role: "assistant", content: "ack"}]);
    journal.append(chunk); first ||= chunk.id;
  }
  const before = journal.reference();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await journal.assertContainsAsync([first]);
    expect(ticks).toBeGreaterThan(0);
    expect(journal.reference()).toEqual(before);
    expect(journal.stats().cachedObjects).toBe(0);
    await expect(journal.assertContainsAsync(["f".repeat(64)])).rejects.toThrow("outside the selected journal branch");
  } finally { clearInterval(timer); revokeTaskScope(scope); }
});

test("async ancestry rejects cancellation, concurrent append and retired activation without a stale success", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-async-race-"));
  const scope = createTaskScope("async-race", home), journal = new PagedSources(home, scope);
  const first = captureSourceGroup(scope, 1, [{role: "user", content: "first"}, {role: "assistant", content: "ack"}]);
  journal.append(first);
  const before = journal.reference(), abort = new AbortController();
  const cancelled = journal.assertContainsAsync([first.id], abort.signal); abort.abort();
  await expect(cancelled).rejects.toThrow();
  expect(journal.reference()).toEqual(before);
  const changing = journal.assertContainsAsync([first.id]);
  journal.append(captureSourceGroup(scope, 2, [{role: "user", content: "second"}, {role: "assistant", content: "ack"}]));
  await expect(changing).rejects.toThrow("changed during ancestry validation");
  const retiring = journal.assertContainsAsync([first.id]); revokeTaskScope(scope);
  await expect(retiring).rejects.toThrow("active runtime");
});


test("async ancestry checks persisted object integrity and honors an already aborted empty query", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-async-corrupt-"));
  const scope = createTaskScope("async-corrupt", home), journal = new PagedSources(home, scope);
  const first = captureSourceGroup(scope, 1, [{role: "user", content: "first"}, {role: "assistant", content: "ack"}]);
  journal.append(first);
  const before = journal.reference();
  const aborted = new AbortController(); aborted.abort();
  await expect(journal.assertContainsAsync([], aborted.signal)).rejects.toThrow();
  const path = join(home, ".neko-core", "context-source-journal", before.scope, `${before.head}.json`);
  writeFileSync(path, "{}");
  try {
    await expect(journal.assertContainsAsync([first.id])).rejects.toThrow("integrity mismatch");
    expect(journal.reference()).toEqual(before);
  } finally { revokeTaskScope(scope); }
});


test("async bundle preparation rejects changed working state and cancellation without replacing a checkpoint", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-async-bundle-"));
  const scope = createTaskScope("async-bundle", home), journal = new PagedSources(home, scope);
  const prefix: JsonObject[] = [{role: "system", content: "HOST_POLICY"}];
  const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
  let busy = false;
  const view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 64 * 1024, () => { if (busy) throw new Error("runtime busy"); });
  const chunk = captureSourceGroup(scope, 1, [{role: "user", content: "first"}, {role: "assistant", content: "ack"}]);
  journal.append(chunk);
  const facts = (runtime: TaskScope) => journal.facts(runtime);
  admitStructuredSource(scope, view, chunk, prefix, 100_000, count, facts);
  const messages = renderStructuredView(scope, view, prefix, 100_000, count, undefined, facts);
  const reference = journal.reference();
  try {
    expect(await saveContextBundleAsync(home, scope, view, messages, reference, null, prefix, 100_000, count)).toBe(1);
    const changed = structuredClone(messages);
    const pending = saveContextBundleAsync(home, scope, view, changed, reference, 1, prefix, 100_000, count);
    changed[0].content = "changed during I/O";
    await expect(pending).rejects.toThrow("changed during asynchronous checkpoint preparation");
    const abort = new AbortController();
    const cancelled = saveContextBundleAsync(home, scope, view, messages, reference, 1, prefix, 100_000, count, abort.signal);
    abort.abort(); await expect(cancelled).rejects.toThrow();
    const duringTurn = saveContextBundleAsync(home, scope, view, messages, reference, 1, prefix, 100_000, count);
    busy = true; await expect(duringTurn).rejects.toThrow("runtime busy"); busy = false;
    const restored = loadContextBundle(home, scope, prefix, 64 * 1024, () => {}, 100_000, count);
    expect(restored.revision).toBe(1);
    expect(restored.messages).toEqual(messages);
    const competing = await Promise.allSettled([
      saveContextBundleAsync(home, scope, view, messages, reference, 1, prefix, 100_000, count),
      saveContextBundleAsync(home, scope, view, messages, reference, 1, prefix, 100_000, count),
    ]);
    expect(competing.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(loadContextBundle(home, scope, prefix, 64 * 1024, () => {}, 100_000, count).revision).toBe(2);
  } finally { revokeTaskScope(scope); }
});


test("bundle publication rejects a reentrant counter changing the view after rendering", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-paged-counter-reentry-"));
  const scope = createTaskScope("counter-reentry", home), journal = new PagedSources(home, scope);
  const prefix: JsonObject[] = [{role: "system", content: "HOST_POLICY"}];
  const count = (messages: readonly JsonObject[]) => JSON.stringify(messages).length;
  const view = new ContextProjection(scope, prefix.map(message => JSON.stringify(message)), 64 * 1024, () => {});
  const chunk = captureSourceGroup(scope, 1, [{role: "user", content: "first"}, {role: "assistant", content: "ack"}]);
  journal.append(chunk);
  const facts = (runtime: TaskScope) => journal.facts(runtime);
  admitStructuredSource(scope, view, chunk, prefix, 100_000, count, facts);
  const messages = renderStructuredView(scope, view, prefix, 100_000, count, undefined, facts);
  try {
    expect(saveContextBundle(home, scope, view, messages, journal.reference(), null, prefix, 100_000, count)).toBe(1);
    const reentrant = (rendered: readonly JsonObject[]) => {
      const snapshot = view.snapshot(scope);
      view.apply(scope, snapshot.revision, JSON.parse(JSON.stringify(snapshot.parts)));
      return count(rendered);
    };
    await expect(saveContextBundleAsync(home, scope, view, messages, journal.reference(), 1, prefix, 100_000, reentrant))
      .rejects.toThrow("Token counting changed");
    const mutating = (rendered: readonly JsonObject[]) => { rendered[0].content = "counter changed policy"; return count(rendered); };
    expect(() => renderStructuredView(scope, view, prefix, 100_000, mutating, undefined, facts)).toThrow("Token counting changed");
    const driftingReference = journal.reference();
    const retargeting = (rendered: readonly JsonObject[]) => { driftingReference.head = "f".repeat(64); return count(rendered); };
    await expect(saveContextBundleAsync(home, scope, view, messages, driftingReference, 1, prefix, 100_000, retargeting))
      .rejects.toThrow("Context changed during checkpoint validation");
    expect(loadContextBundle(home, scope, prefix, 64 * 1024, () => {}, 100_000, count).revision).toBe(1);
  } finally { revokeTaskScope(scope); }
});
