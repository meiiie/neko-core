import type { BenchTask } from "./bench.ts";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface HiddenBenchProgram {
  body: string;
  modules: readonly { specifier: string; bindings: readonly string[] }[];
}

export type HiddenBenchVerifier = (dir: string, program: HiddenBenchProgram, sourceFiles: readonly string[]) => Promise<boolean>;

const protectedFiles = (...keep: string[]): NonNullable<BenchTask["constraints"]> =>
  keep.map((path) => ({ id: `keep-${path}`, keep: path }));

function exactInventory(...expected: string[]): NonNullable<BenchTask["constraints"]>[number] {
  const wanted = [...expected].sort();
  const wantedDirs = new Set<string>();
  for (const name of wanted) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) wantedDirs.add(parts.slice(0, index).join("/"));
  }
  return {
    id: "exact-inventory",
    check: (dir) => {
      try {
        const lexicalRoot = resolve(dir);
        const rootStat = lstatSync(lexicalRoot);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
        const root = realpathSync(lexicalRoot);
        const found: string[] = [];
        const foundDirs: string[] = [];
        const pending = [""];
        while (pending.length) {
          const relDir = pending.pop()!;
          const absoluteDir = join(root, relDir);
          const dirStat = lstatSync(absoluteDir);
          if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return false;
          const realDir = realpathSync(absoluteDir);
          const escaped = relative(root, realDir);
          if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) return false;
          const entries = readdirSync(absoluteDir, { withFileTypes: true });
          if (entries.length > 64) return false;
          for (const entry of entries) {
            const rel = join(relDir, entry.name);
            const lexical = join(root, rel);
            const stat = lstatSync(lexical);
            if (stat.isSymbolicLink()) return false;
            if (stat.isDirectory()) {
              const normalized = rel.split(sep).join("/");
              foundDirs.push(normalized);
              pending.push(rel);
            }
            else if (stat.isFile() && stat.nlink === 1) found.push(rel.split(sep).join("/"));
            else return false;
            if (found.length + foundDirs.length > 64) return false;
          }
        }
        const sortedFiles = found.sort();
        const sortedDirs = foundDirs.sort();
        const expectedDirs = [...wantedDirs].sort();
        return sortedFiles.length === wanted.length
          && sortedFiles.every((name, index) => name === wanted[index])
          && sortedDirs.length === expectedDirs.length
          && sortedDirs.every((name, index) => name === expectedDirs[index]);
      } catch {
        return false;
      }
    },
  };
}

const CONFIG_HIDDEN: HiddenBenchProgram = {
  modules: [
    { specifier: "./src/resolve.mjs", bindings: ["clearConfigCache", "resolveConfig"] },
    { specifier: "./src/cache.mjs", bindings: ["cachedBase", "clearBaseCache"] },
  ],
  body: String.raw`
const attemptMutation = (mutate) => { try { mutate(); } catch {} };

const sourceA = {
  defaults: { retries: 3, label: "base", flags: { audit: true, nested: { color: "blue", keep: 1 } }, regions: ["us"] },
  profiles: { dev: { retries: 5, flags: { verbose: true, nested: { color: "red" } }, regions: ["eu"] } },
};
const sourceB = {
  defaults: { retries: 9, label: "other", flags: { audit: false }, regions: ["ap"] },
  profiles: { dev: { flags: { verbose: false } } },
};
const beforeA = JSON.stringify(sourceA);
const project = { label: "", flags: { audit: false, nested: { enabled: false } } };
const overrides = { retries: 0, flags: { verbose: false }, regions: [] };
const beforeProject = JSON.stringify(project);
const beforeOverrides = JSON.stringify(overrides);

clearConfigCache();
const first = resolveConfig({ source: sourceA, profile: "dev", projectId: "p1", project, overrides });
assert.deepEqual(first, {
  retries: 0,
  label: "",
  flags: { audit: false, verbose: false, nested: { color: "red", keep: 1, enabled: false } },
  regions: [],
});
assert.equal(JSON.stringify(sourceA), beforeA);
assert.equal(JSON.stringify(project), beforeProject);
assert.equal(JSON.stringify(overrides), beforeOverrides);

const again = resolveConfig({ source: sourceA, profile: "dev", projectId: "p1", project, overrides });
assert.deepEqual(again, first);
attemptMutation(() => { first.flags.nested.keep = 99; });
attemptMutation(() => { first.regions.push("result-mutation"); });
const afterResultMutation = resolveConfig({ source: sourceA, profile: "dev", projectId: "p1", project, overrides });
assert.equal(afterResultMutation.flags.nested.keep, 1, "a mutable result cannot alias cached state");
assert.deepEqual(afterResultMutation.regions, [], "a mutable result array cannot alias cached state");
assert.equal(resolveConfig({ source: sourceA, profile: "dev", projectId: "null", project: { label: null }, overrides: {} }).label, null);
assert.equal(resolveConfig({ source: sourceA, profile: "dev", projectId: "undefined", project: {}, overrides: { label: undefined } }).label, "base");

const projectOne = resolveConfig({ source: sourceA, profile: "dev", projectId: "project-one", project: { flags: { audit: false } }, overrides: {} });
const projectTwo = resolveConfig({ source: sourceA, profile: "dev", projectId: "project-two", project: { flags: { audit: true } }, overrides: {} });
assert.deepEqual(projectOne.flags, { audit: false, verbose: true, nested: { color: "red", keep: 1 } });
assert.deepEqual(projectTwo.flags, { audit: true, verbose: true, nested: { color: "red", keep: 1 } });

const reusedProjectOne = resolveConfig({ source: sourceA, profile: "dev", projectId: "reused-project", project: { label: "first" }, overrides: { retries: 1 } });
const reusedProjectTwo = resolveConfig({ source: sourceA, profile: "dev", projectId: "reused-project", project: { label: "second" }, overrides: { retries: 2 } });
assert.equal(reusedProjectOne.label, "first");
assert.equal(reusedProjectOne.retries, 1);
assert.equal(reusedProjectTwo.label, "second", "project layers are applied fresh when a project id is reused");
assert.equal(reusedProjectTwo.retries, 2, "explicit layers are applied fresh when a project id is reused");

const arraySource = { defaults: { regions: ["stable"] }, profiles: { dev: {} } };
clearConfigCache();
const arrayFirst = resolveConfig({ source: arraySource, profile: "dev", projectId: "array-1" });
arraySource.defaults.regions.push("caller-mutation");
const arrayAgain = resolveConfig({ source: arraySource, profile: "dev", projectId: "array-2" });
assert.deepEqual(arrayFirst.regions, ["stable"]);
assert.deepEqual(arrayAgain.regions, ["stable"], "cached base cannot alias caller-owned arrays");

clearBaseCache();
const cacheSource = {};
let builds = 0;
const devOne = cachedBase(cacheSource, "dev", () => ({ build: ++builds }));
const devTwo = cachedBase(cacheSource, "dev", () => ({ build: ++builds }));
const prod = cachedBase(cacheSource, "prod", () => ({ build: ++builds }));
assert.deepEqual(devOne, devTwo, "same source/profile reuses the same built value");
assert.notStrictEqual(devOne, prod, "profiles within one source have independent cache entries");
assert.equal(builds, 2);
clearBaseCache();
assert.deepEqual(cachedBase(cacheSource, "dev", () => ({ build: ++builds })), { build: 3 });
assert.equal(builds, 3, "clearBaseCache discards populated entries");

clearBaseCache();
const twinSourceOne = {};
const twinSourceTwo = {};
assert.deepEqual(cachedBase(twinSourceOne, "dev", () => ({ owner: "one" })), { owner: "one" });
assert.deepEqual(cachedBase(twinSourceTwo, "dev", () => ({ owner: "two" })), { owner: "two" }, "equal-shaped source objects have independent cache entries");

clearBaseCache();
const externalCacheSource = {};
const externalCacheKeys = Reflect.ownKeys(externalCacheSource);
assert.deepEqual(cachedBase(externalCacheSource, "dev", () => ({ owner: "external" })), { owner: "external" });
assert.deepEqual(Reflect.ownKeys(externalCacheSource), externalCacheKeys, "cache metadata must not be attached to the source object");
const frozenCacheSource = Object.freeze({});
assert.deepEqual(cachedBase(frozenCacheSource, "dev", () => ({ owner: "frozen" })), { owner: "frozen" }, "a frozen source remains a valid cache identity");
assert.deepEqual(Reflect.ownKeys(frozenCacheSource), [], "a frozen source remains untouched");

const nullPrototypeDefaults = Object.assign(Object.create(null), { kept: 1, changed: 1 });
const nullPrototypeProject = Object.assign(Object.create(null), { changed: 2, added: 3 });
const originalDate = new Date("2020-01-01T00:00:00.000Z");
const replacementDate = new Date("2021-02-03T00:00:00.000Z");
const originalMap = new Map([["base", { value: 1 }]]);
const replacementMap = new Map([["project", { value: 2 }]]);
const specialSource = { defaults: { options: nullPrototypeDefaults, stamp: originalDate, table: originalMap }, profiles: { dev: {} } };
clearConfigCache();
const special = resolveConfig({
  source: specialSource,
  profile: "dev",
  projectId: "special",
  project: { options: nullPrototypeProject, stamp: replacementDate, table: replacementMap },
});
assert.equal(special.options.kept, 1, "null-prototype plain objects merge recursively");
assert.equal(special.options.changed, 2);
assert.equal(special.options.added, 3);
assert.ok(special.stamp instanceof Date, "Date values replace rather than being recursively object-merged");
assert.equal(special.stamp.getTime(), replacementDate.getTime());
assert.notStrictEqual(special.stamp, replacementDate, "non-plain replacement values cannot alias their caller");
assert.ok(special.table instanceof Map, "Map values replace rather than being recursively object-merged");
assert.deepEqual([...special.table], [...replacementMap]);
assert.notStrictEqual(special.table, replacementMap, "non-plain replacement containers cannot alias their caller");
attemptMutation(() => { special.stamp.setUTCFullYear(2030); });
attemptMutation(() => { special.table.get("project").value = 99; });
assert.equal(replacementDate.getUTCFullYear(), 2021);
assert.equal(replacementMap.get("project").value, 2);

const clearableSource = { defaults: { label: "before-clear" }, profiles: { dev: {} } };
clearConfigCache();
assert.equal(resolveConfig({ source: clearableSource, profile: "dev", projectId: "clearable" }).label, "before-clear");
clearableSource.defaults.label = "after-clear";
clearConfigCache();
assert.equal(resolveConfig({ source: clearableSource, profile: "dev", projectId: "clearable" }).label, "after-clear", "clearConfigCache reloads a populated profile base");

const other = resolveConfig({ source: sourceB, profile: "dev", projectId: "p2", project: {}, overrides: {} });
assert.equal(other.retries, 9, "same profile name in another source must not reuse sourceA");
assert.equal(other.label, "other");
assert.deepEqual(other.regions, ["ap"]);
assert.equal(other.flags.verbose, false);
console.log("ok");
`,
};

const INFLIGHT_HIDDEN: HiddenBenchProgram = {
  modules: [{ specifier: "./src/catalog.mjs", bindings: ["clearInflight", "getCatalogItem"] }],
  body: String.raw`
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

clearInflight();
let calls = 0;
const gate = deferred();
const loader = async (tenant, id) => { calls++; await gate.promise; return { tenant, id, calls }; };
const a = getCatalogItem({ tenant: "acme", id: "42", loader });
const b = getCatalogItem({ tenant: "acme", id: "42", loader });
assert.strictEqual(a, b, "same composite key returns the exact pending promise");
gate.resolve();
assert.strictEqual(await a, await b, "coalesced callers receive the exact same result object");
assert.equal(calls, 1, "same composite key invokes one loader");
await getCatalogItem({ tenant: "acme", id: "42", loader });
assert.equal(calls, 2, "a settled success is not a permanent value cache");

clearInflight();
const seen = [];
await Promise.all([
  getCatalogItem({ tenant: "left", id: "same", loader: async (tenant, id) => { seen.push(tenant + ":" + id); return tenant; } }),
  getCatalogItem({ tenant: "right", id: "same", loader: async (tenant, id) => { seen.push(tenant + ":" + id); return tenant; } }),
  getCatalogItem({ tenant: "left", id: "other", loader: async (tenant, id) => { seen.push(tenant + ":" + id); return id; } }),
]);
assert.deepEqual(seen.sort(), ["left:other", "left:same", "right:same"], "tenant and item id both belong to the lookup key");

for (const separator of ["", ":", "|", "/", "~", "\u0000"]) {
  clearInflight();
  const collision = await Promise.all([
    getCatalogItem({ tenant: "a" + separator + "b", id: "c", loader: async () => "first" }),
    getCatalogItem({ tenant: "a", id: "b" + separator + "c", loader: async () => "second" }),
  ]);
  assert.deepEqual(collision, ["first", "second"], "composite keys cannot collide through delimiters");
}

clearInflight();
const typedCollision = await Promise.all([
  getCatalogItem({ tenant: undefined, id: "typed", loader: async () => "undefined-tenant" }),
  getCatalogItem({ tenant: null, id: "typed", loader: async () => "null-tenant" }),
]);
assert.deepEqual(typedCollision, ["undefined-tenant", "null-tenant"], "composite-key encoding must remain injective across value types");

clearInflight();
const slowGate = deferred();
const slow = getCatalogItem({ tenant: "same-tenant", id: "slow", loader: async () => { await slowGate.promise; return "slow"; } });
const fast = getCatalogItem({ tenant: "same-tenant", id: "fast", loader: async () => "fast" });
let blockTimer;
const blocked = new Promise((resolve) => { blockTimer = setTimeout(() => resolve("blocked"), 1000); });
const fastResult = await Promise.race([fast, blocked]);
clearTimeout(blockTimer);
assert.equal(fastResult, "fast", "a different composite key cannot wait behind unrelated pending work");
slowGate.resolve();
assert.equal(await slow, "slow");

clearInflight();
const oldGate = deferred();
const newGate = deferred();
const oldPending = getCatalogItem({ tenant: "aba", id: "1", loader: async () => { await oldGate.promise; return "old"; } });
clearInflight();
const newPending = getCatalogItem({ tenant: "aba", id: "1", loader: async () => { await newGate.promise; return "new"; } });
oldGate.resolve();
assert.equal(await oldPending, "old");
const stillNew = getCatalogItem({ tenant: "aba", id: "1", loader: async () => "unexpected-third-load" });
assert.strictEqual(stillNew, newPending, "an older settle cannot delete a newer pending entry");
newGate.resolve();
assert.equal(await newPending, "new");

clearInflight();
const rejectedOldGate = deferred();
const replacementGate = deferred();
const rejectedOld = getCatalogItem({ tenant: "aba-reject", id: "1", loader: async () => { await rejectedOldGate.promise; throw new Error("old rejection"); } });
clearInflight();
const replacement = getCatalogItem({ tenant: "aba-reject", id: "1", loader: async () => { await replacementGate.promise; return "replacement"; } });
rejectedOldGate.resolve();
await assert.rejects(rejectedOld, /old rejection/);
assert.strictEqual(
  getCatalogItem({ tenant: "aba-reject", id: "1", loader: async () => "unexpected-third-load" }),
  replacement,
  "an older rejection cannot delete a newer pending entry",
);
replacementGate.resolve();
assert.equal(await replacement, "replacement");

clearInflight();
const syncBoom = new Error("synchronous loader failure");
let syncAttempts = 0;
const syncLoader = () => { syncAttempts++; if (syncAttempts === 1) throw syncBoom; return "sync-recovered"; };
const syncOne = getCatalogItem({ tenant: "sync", id: "1", loader: syncLoader });
const syncTwo = getCatalogItem({ tenant: "sync", id: "1", loader: syncLoader });
assert.strictEqual(syncOne, syncTwo, "a synchronous loader throw is still represented by one shared pending promise");
await assert.rejects(syncOne, (error) => error === syncBoom);
await assert.rejects(syncTwo, (error) => error === syncBoom);
assert.equal(await getCatalogItem({ tenant: "sync", id: "1", loader: syncLoader }), "sync-recovered");
assert.equal(syncAttempts, 2);

clearInflight();
const boom = new Error("temporary");
let attempts = 0;
const flaky = async () => { attempts++; if (attempts === 1) throw boom; return "recovered"; };
const p1 = getCatalogItem({ tenant: "t", id: "x", loader: flaky });
const p2 = getCatalogItem({ tenant: "t", id: "x", loader: flaky });
await assert.rejects(p1, (error) => error === boom);
await assert.rejects(p2, (error) => error === boom);
assert.equal(attempts, 1, "the failing in-flight request is shared");
assert.equal(await getCatalogItem({ tenant: "t", id: "x", loader: flaky }), "recovered");
assert.equal(attempts, 2, "rejection must evict the in-flight entry");
console.log("ok");
`,
};

const ATOMIC_HIDDEN: HiddenBenchProgram = {
  modules: [
    { specifier: "./src/events.mjs", bindings: ["updateEvent"] },
    { specifier: "./src/store.mjs", bindings: ["Store"] },
    { specifier: "./src/service.mjs", bindings: ["updateBatch", "updateOne"] },
  ],
  body: String.raw`
const attemptMutation = (mutate) => { try { mutate(); } catch {} };
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const seed = [{ id: "a", value: 1, tag: "A" }, { id: "b", value: 2, tag: "B" }];
const changes = [{ id: "a", patch: { value: 10 } }, { id: "b", patch: { value: 20 } }];
const beforeSeed = JSON.stringify(seed);
const beforeChanges = JSON.stringify(changes);
const store = new Store(seed);
assert.deepEqual(updateBatch(store, changes), [{ id: "a", value: 10, tag: "A" }, { id: "b", value: 20, tag: "B" }]);
assert.deepEqual(store.rows(), [{ id: "a", value: 10, tag: "A" }, { id: "b", value: 20, tag: "B" }]);
assert.deepEqual(store.events(), [
  { type: "updated", id: "a", before: { id: "a", value: 1, tag: "A" }, after: { id: "a", value: 10, tag: "A" } },
  { type: "updated", id: "b", before: { id: "b", value: 2, tag: "B" }, after: { id: "b", value: 20, tag: "B" } },
]);
assert.equal(JSON.stringify(seed), beforeSeed);
assert.equal(JSON.stringify(changes), beforeChanges);

const duplicate = new Store(seed);
assert.throws(() => updateBatch(duplicate, [changes[0], { id: "a", patch: { value: 11 } }]));
assert.deepEqual(duplicate.rows(), seed);
assert.deepEqual(duplicate.events(), []);

const unknown = new Store(seed);
assert.throws(() => updateBatch(unknown, [changes[0], { id: "missing", patch: { value: 3 } }]));
assert.deepEqual(unknown.rows(), seed);
assert.deepEqual(unknown.events(), []);

const malformed = new Store(seed);
assert.throws(() => updateBatch(malformed, [changes[0], { id: "b", patch: null }]));
assert.throws(() => updateBatch(malformed, [{ id: "", patch: {} }]));
assert.throws(() => updateBatch(malformed, [{ id: "a", patch: [] }]));
assert.throws(() => updateBatch(malformed, [{ id: "a", patch: { id: "b" } }]));
assert.deepEqual(malformed.rows(), seed);
assert.deepEqual(malformed.events(), []);

const commitFailure = new Store(seed, { failOnCommitIndex: 1 });
assert.throws(() => updateBatch(commitFailure, changes));
assert.deepEqual(commitFailure.rows(), seed, "commit failure must not publish a partial row set");
assert.deepEqual(commitFailure.events(), [], "commit failure must not publish partial events");

const firstCommitFailure = new Store(seed, { failOnCommitIndex: 0 });
assert.throws(() => updateBatch(firstCommitFailure, changes));
assert.deepEqual(firstCommitFailure.rows(), seed, "a failure on the first batch commit is also atomic");
assert.deepEqual(firstCommitFailure.events(), []);

const empty = new Store(seed);
assert.deepEqual(updateBatch(empty, []), []);
assert.deepEqual(empty.rows(), seed);
assert.deepEqual(empty.events(), []);

const ordered = new Store(seed);
const reversed = [changes[1], changes[0]];
assert.deepEqual(updateBatch(ordered, reversed).map((row) => row.id), ["b", "a"]);
assert.deepEqual(ordered.events().map((event) => event.id), ["b", "a"]);

const nested = new Store(seed);
const nestedPatch = { meta: { nested: 1 } };
const nestedResult = updateBatch(nested, [{ id: "a", patch: nestedPatch }]);
attemptMutation(() => { nestedPatch.meta.nested = 99; });
attemptMutation(() => { nestedResult[0].meta.nested = 77; });
assert.equal(nested.get("a").meta.nested, 1, "batch patches must not remain aliased");
assert.equal(nested.events()[0].after.meta.nested, 1, "returned batch rows cannot alias stored event payloads");
const nestedRowsView = nested.rows();
const nestedGetView = nested.get("a");
const nestedEventsView = nested.events();
assert.notStrictEqual(nestedResult[0].meta, nestedGetView.meta, "returned and stored rows use distinct nested values");
assert.notStrictEqual(nestedEventsView[0].after.meta, nestedGetView.meta, "stored rows and events use distinct nested values");
attemptMutation(() => { nestedRowsView[0].meta.nested = 66; });
attemptMutation(() => { nestedGetView.meta.nested = 55; });
attemptMutation(() => { nestedEventsView[0].after.meta.nested = 44; });
assert.equal(nested.get("a").meta.nested, 1, "rows and get views cannot alias stored rows");
assert.equal(nested.events()[0].after.meta.nested, 1, "events views cannot alias stored event payloads");

const existing = new Store(seed);
updateOne(existing, { id: "a", patch: { value: 3 } });
const rowsBeforeFailure = existing.rows();
const eventsBeforeFailure = existing.events();
assert.throws(() => updateBatch(existing, [{ id: "a", patch: { value: 4 } }, { id: "missing", patch: { value: 5 } }]));
assert.deepEqual(existing.rows(), rowsBeforeFailure, "rollback preserves pre-existing row state");
assert.deepEqual(existing.events(), eventsBeforeFailure, "rollback preserves pre-existing events");

const existingCommitFailure = new Store(seed, { failOnCommitIndex: 1 });
updateOne(existingCommitFailure, { id: "a", patch: { value: 3 } });
const rowsBeforeCommitFailure = existingCommitFailure.rows();
const eventsBeforeCommitFailure = existingCommitFailure.events();
assert.throws(() => updateBatch(existingCommitFailure, changes));
assert.deepEqual(existingCommitFailure.rows(), rowsBeforeCommitFailure, "batch commit failure preserves pre-existing row state");
assert.deepEqual(existingCommitFailure.events(), eventsBeforeCommitFailure, "batch commit failure preserves pre-existing events");

const nestedFailureSeed = [{ id: "a", meta: { value: 1 } }, { id: "b", meta: { value: 2 } }];
const nestedCommitFailure = new Store(nestedFailureSeed, { failOnCommitIndex: 1 });
updateOne(nestedCommitFailure, { id: "a", patch: { ready: true } });
const nestedRowsBeforeFailure = nestedCommitFailure.rows();
const nestedEventsBeforeFailure = nestedCommitFailure.events();
assert.throws(() => updateBatch(nestedCommitFailure, [
  { id: "a", patch: { meta: { value: 10 } } },
  { id: "b", patch: { meta: { value: 20 } } },
]));
assert.deepEqual(nestedCommitFailure.rows(), nestedRowsBeforeFailure, "batch rollback restores nested row state");
assert.deepEqual(nestedCommitFailure.events(), nestedEventsBeforeFailure, "batch rollback restores nested event history");

const callerRows = [{ id: "nested", value: 1, meta: { owned: true } }];
const rowAlias = new Store(callerRows);
attemptMutation(() => { callerRows[0].meta.owned = false; });
assert.equal(rowAlias.get("nested").meta.owned, true, "constructor rows must not remain aliased");

const sharedEventValue = { deep: { value: 1 } };
const directBefore = { id: "event", meta: sharedEventValue };
const directAfter = { id: "event", meta: sharedEventValue };
const directEvent = updateEvent(directBefore, directAfter);
assert.notStrictEqual(directEvent.before.meta, directBefore.meta, "updateEvent isolates caller-owned before values");
assert.notStrictEqual(directEvent.after.meta, directAfter.meta, "updateEvent isolates caller-owned after values");
assert.notStrictEqual(directEvent.before.meta, directEvent.after.meta, "event before and after snapshots are independently isolated");
attemptMutation(() => { sharedEventValue.deep.value = 9; });
assert.equal(directEvent.before.meta.deep.value, 1);
assert.equal(directEvent.after.meta.deep.value, 1);
attemptMutation(() => { directEvent.before.meta.deep.value = 8; });
assert.equal(directEvent.after.meta.deep.value, 1, "mutating one event snapshot cannot change the other");

const frozenSeed = deepFreeze([{ id: "frozen", meta: { value: 1 } }]);
const frozenChanges = deepFreeze([{ id: "frozen", patch: { meta: { value: 2 } } }]);
const frozenInputs = new Store(frozenSeed);
assert.deepEqual(updateBatch(frozenInputs, frozenChanges), [{ id: "frozen", meta: { value: 2 } }]);
assert.deepEqual(frozenInputs.rows(), [{ id: "frozen", meta: { value: 2 } }]);

const single = new Store(seed);
assert.deepEqual(updateOne(single, { id: "a", patch: { value: 7 } }), { id: "a", value: 7, tag: "A" });
assert.deepEqual(single.rows().map((row) => row.value), [7, 2]);
assert.deepEqual(single.events(), [
  { type: "updated", id: "a", before: { id: "a", value: 1, tag: "A" }, after: { id: "a", value: 7, tag: "A" } },
]);
const callerPatch = { meta: { nested: 1 } };
const singleResult = updateOne(single, { id: "b", patch: callerPatch });
attemptMutation(() => { callerPatch.meta.nested = 99; });
attemptMutation(() => { singleResult.meta.nested = 77; });
assert.equal(single.get("b").meta.nested, 1, "caller patch objects must not remain aliased");
assert.equal(single.events()[1].after.meta.nested, 1, "returned rows cannot alias stored event payloads");
const singleWithBatchFailureHook = new Store(seed, { failOnCommitIndex: 0 });
assert.deepEqual(updateOne(singleWithBatchFailureHook, { id: "a", patch: { value: 8 } }), { id: "a", value: 8, tag: "A" });
assert.deepEqual(singleWithBatchFailureHook.events(), [
  { type: "updated", id: "a", before: { id: "a", value: 1, tag: "A" }, after: { id: "a", value: 8, tag: "A" } },
]);
console.log("ok");
`,
};

/**
 * A deliberately small, non-textbook coding tier. Public tests make the task reproducible; these
 * post-turn checks add deterministic edge cases that were not available to the model while planning.
 */
export function createFrontierTasks(verifyHidden: HiddenBenchVerifier): BenchTask[] {
  return [
    {
      id: "config-context-cache",
      files: {
        "package.json": "{\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"bun test\" }\n}\n",
        "SPEC.md": "# Config resolution contract\n\nResolve layers in this order: defaults < profile < project < explicit overrides. Objects are plain only when their prototype is Object.prototype or null: nested plain objects merge recursively, while arrays and other non-plain values replace. Undefined means no override, while false, 0, the empty string, and null are real values. Calls must not mutate or alias caller-owned data. A cached profile base is scoped to the source object and profile, with cache metadata kept outside the source; project and explicit layers are always applied fresh. Implementation modules stay pure: use relative imports only, with no process termination, host filesystem/runtime inspection, eval, or dynamic import.\n",
        "src/merge.mjs": "const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);\nexport function mergeConfig(base = {}, override = {}) {\n  const out = { ...base };\n  for (const [key, value] of Object.entries(override)) {\n    if (!value) continue;\n    out[key] = plain(value) && plain(out[key]) ? { ...out[key], ...value } : value;\n  }\n  return out;\n}\n",
        "src/cache.mjs": "const bases = new Map();\nexport function cachedBase(source, profile, build) {\n  if (!bases.has(profile)) bases.set(profile, build());\n  return bases.get(profile);\n}\nexport function clearBaseCache() { bases.clear(); }\n",
        "src/load.mjs": "import { mergeConfig } from './merge.mjs';\nexport function loadBase(source, profile) {\n  return mergeConfig(source.defaults ?? {}, source.profiles?.[profile] ?? {});\n}\n",
        "src/resolve.mjs": "import { cachedBase, clearBaseCache } from './cache.mjs';\nimport { loadBase } from './load.mjs';\nimport { mergeConfig } from './merge.mjs';\nexport function resolveConfig({ source, profile, projectId, project = {}, overrides = {} }) {\n  void projectId;\n  const base = cachedBase(source, profile, () => loadBase(source, profile));\n  return mergeConfig(mergeConfig(base, project), overrides);\n}\nexport const clearConfigCache = clearBaseCache;\n",
        "test/config.test.mjs": "import { expect, test } from 'bun:test';\nimport { clearConfigCache, resolveConfig } from '../src/resolve.mjs';\n\ntest('project and explicit falsy overrides stay isolated', () => {\n  const source = { defaults: { retries: 3, flags: { audit: true, verbose: true } }, profiles: { dev: { retries: 5 } } };\n  clearConfigCache();\n  const a = resolveConfig({ source, profile: 'dev', projectId: 'a', project: { flags: { audit: false } }, overrides: { retries: 0 } });\n  const b = resolveConfig({ source, profile: 'dev', projectId: 'b', project: { flags: { audit: true } }, overrides: {} });\n  expect(a.retries).toBe(0);\n  expect(a.flags).toEqual({ audit: false, verbose: true });\n  expect(b.flags).toEqual({ audit: true, verbose: true });\n});\n",
      },
      prompt: "A config-cache refactor made resolved settings leak or disappear across project contexts. Diagnose and fix the implementation under src/ so it obeys SPEC.md and `bun test` passes. Preserve the exported API. Change existing implementation files only; do not add files or modify SPEC.md, package.json, or test/config.test.mjs.",
      verify: (dir) => verifyHidden(dir, CONFIG_HIDDEN, [
        "src/merge.mjs", "src/cache.mjs", "src/load.mjs", "src/resolve.mjs",
      ]),
      optimalSteps: 10,
      constraints: [
        ...protectedFiles("SPEC.md", "package.json", "test/config.test.mjs"),
        exactInventory("package.json", "SPEC.md", "src/merge.mjs", "src/cache.mjs", "src/load.mjs", "src/resolve.mjs", "test/config.test.mjs"),
      ],
    },
    {
      id: "inflight-recovery",
      files: {
        "package.json": "{\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"bun test\" }\n}\n",
        "CONTRACT.md": "# In-flight lookup contract\n\nCatalog lookups are keyed by both tenant and item id. Composite-key semantics are injective: distinct component values are not collapsed by string coercion or delimiters. Concurrent calls for the same composite key share exactly one pending loader promise and its exact result or rejection. The table contains pending work only: success and failure both remove their own entry, so a later call starts a fresh load. Different composite keys never block or share results. Implementation modules stay pure: use relative imports only, with no process termination, host filesystem/runtime inspection, eval, or dynamic import.\n",
        "src/key.mjs": "export function lookupKey(tenant, id) { return String(id); }\n",
        "src/inflight.mjs": "const pending = new Map();\nexport function shareInflight(key, load) {\n  if (pending.has(key)) return pending.get(key);\n  const promise = Promise.resolve().then(load);\n  pending.set(key, promise);\n  return promise;\n}\nexport function clearInflightTable() { pending.clear(); }\n",
        "src/client.mjs": "export async function fetchCatalogItem(tenant, id, loader) {\n  return await loader(tenant, id);\n}\n",
        "src/catalog.mjs": "import { fetchCatalogItem } from './client.mjs';\nimport { clearInflightTable, shareInflight } from './inflight.mjs';\nimport { lookupKey } from './key.mjs';\nexport function getCatalogItem({ tenant, id, loader }) {\n  return shareInflight(lookupKey(tenant, id), () => fetchCatalogItem(tenant, id, loader));\n}\nexport const clearInflight = clearInflightTable;\n",
        "test/catalog.test.mjs": "import { expect, test } from 'bun:test';\nimport { clearInflight, getCatalogItem } from '../src/catalog.mjs';\n\ntest('a rejected in-flight lookup can be retried', async () => {\n  clearInflight();\n  let calls = 0;\n  const loader = async () => { calls++; if (calls === 1) throw new Error('temporary'); return 'ok'; };\n  await expect(getCatalogItem({ tenant: 't', id: '1', loader })).rejects.toThrow('temporary');\n  await expect(getCatalogItem({ tenant: 't', id: '1', loader })).resolves.toBe('ok');\n  expect(calls).toBe(2);\n});\n",
      },
      prompt: "Concurrent catalog lookups were refactored and now duplicate work; after one loader failure the same key can stay poisoned. Diagnose and fix the modules under src/ to satisfy CONTRACT.md and `bun test`, without dependencies or network access. Preserve the public API. Change existing implementation files only; do not add files or edit CONTRACT.md, package.json, or test/catalog.test.mjs.",
      verify: (dir) => verifyHidden(dir, INFLIGHT_HIDDEN, [
        "src/key.mjs", "src/inflight.mjs", "src/client.mjs", "src/catalog.mjs",
      ]),
      optimalSteps: 9,
      constraints: [
        ...protectedFiles("CONTRACT.md", "package.json", "test/catalog.test.mjs"),
        exactInventory("package.json", "CONTRACT.md", "src/key.mjs", "src/inflight.mjs", "src/client.mjs", "src/catalog.mjs", "test/catalog.test.mjs"),
      ],
    },
    {
      id: "atomic-batch",
      files: {
        "package.json": "{\n  \"type\": \"module\",\n  \"scripts\": { \"test\": \"bun test\" }\n}\n",
        "SPEC.md": "# Batch update contract\n\nupdateOne keeps its current public behavior: it returns the complete updated row and publishes one complete update event. updateBatch validates the complete request before publication, rejects malformed, duplicate, or unknown ids, preserves request order, and commits rows plus events all-or-nothing. The Store failOnCommitIndex option is a batch-only failure hook: validation or an injected batch commit failure leaves both rows and events structurally equal to their pre-call values. Empty input is a successful no-op. Caller-owned rows, changes, patch objects, returned rows, stored rows, and event payloads never share mutable nested references; each event's before and after snapshots are isolated from their inputs and from each other. Implementation modules stay pure: use relative imports only, with no process termination, host filesystem/runtime inspection, eval, or dynamic import.\n",
        "src/validate.mjs": "export function validateChange(change) {\n  if (!change || typeof change.id !== 'string' || !change.id) throw new TypeError('invalid id');\n  if (!change.patch || typeof change.patch !== 'object' || Array.isArray(change.patch)) throw new TypeError('invalid patch');\n  if ('id' in change.patch) throw new TypeError('patch cannot replace id');\n  return change;\n}\nexport function validateBatch(changes) { return changes.map(validateChange); }\n",
        "src/events.mjs": "export function updateEvent(before, after) {\n  return { type: 'updated', id: after.id, before: { ...before }, after: { ...after } };\n}\n",
        "src/store.mjs": "export class Store {\n  #rows;\n  #events = [];\n  #failOnCommitIndex;\n  constructor(rows, { failOnCommitIndex = -1 } = {}) {\n    this.#rows = new Map(rows.map((row) => [row.id, { ...row }]));\n    this.#failOnCommitIndex = failOnCommitIndex;\n  }\n  has(id) { return this.#rows.has(id); }\n  get(id) { const row = this.#rows.get(id); return row ? { ...row } : undefined; }\n  commit(entry) {\n    this.#rows.set(entry.id, { ...entry.after });\n    this.#events.push({ ...entry.event });\n  }\n  commitBatch(entries) {\n    entries.forEach((entry, index) => {\n      this.commit(entry);\n      if (index === this.#failOnCommitIndex) throw new Error('injected commit failure');\n    });\n  }\n  rows() { return [...this.#rows.values()].map((row) => ({ ...row })); }\n  events() { return this.#events.map((event) => ({ ...event })); }\n}\n",
        "src/service.mjs": "import { updateEvent } from './events.mjs';\nimport { validateBatch, validateChange } from './validate.mjs';\nexport function updateOne(store, change) {\n  validateChange(change);\n  if (!store.has(change.id)) throw new Error(`unknown id: ${change.id}`);\n  const before = store.get(change.id);\n  const after = { ...before, ...change.patch, id: change.id };\n  store.commit({ id: change.id, before, after, event: updateEvent(before, after) });\n  return after;\n}\nexport function updateBatch(store, changes) {\n  validateBatch(changes);\n  return changes.map((change) => updateOne(store, change));\n}\n",
        "test/batch.test.mjs": "import { expect, test } from 'bun:test';\nimport { Store } from '../src/store.mjs';\nimport { updateBatch } from '../src/service.mjs';\n\ntest('an unknown id cannot leave an earlier row updated', () => {\n  const seed = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];\n  const store = new Store(seed);\n  expect(() => updateBatch(store, [{ id: 'a', patch: { value: 10 } }, { id: 'missing', patch: { value: 3 } }])).toThrow();\n  expect(store.rows()).toEqual(seed);\n  expect(store.events()).toEqual([]);\n});\n",
      },
      prompt: "Batch updates can publish half a transaction when a later validation or commit fails. Diagnose and repair the modules under src/ so they obey SPEC.md and `bun test`, while preserving updateOne. Change existing implementation files only; do not add files or modify SPEC.md, package.json, or test/batch.test.mjs.",
      verify: (dir) => verifyHidden(dir, ATOMIC_HIDDEN, [
        "src/validate.mjs", "src/events.mjs", "src/store.mjs", "src/service.mjs",
      ]),
      optimalSteps: 10,
      constraints: [
        ...protectedFiles("SPEC.md", "package.json", "test/batch.test.mjs"),
        exactInventory("package.json", "SPEC.md", "src/validate.mjs", "src/events.mjs", "src/store.mjs", "src/service.mjs", "test/batch.test.mjs"),
      ],
    },
  ];
}
