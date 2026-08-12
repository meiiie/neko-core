import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BenchInfrastructureError, FRONTIER_TASKS, type BenchTask } from "../src/adapters/bench.ts";
import { sandboxActive } from "../src/core/sandbox.ts";

function requiredFrontierSandboxAvailable(
  live = sandboxActive(),
  required = process.env.NEKO_REQUIRE_SANDBOX_TESTS === "1",
): boolean {
  if (!live && required) {
    throw new Error("NEKO_REQUIRE_SANDBOX_TESTS=1 but no live OS sandbox is available for frontier oracles");
  }
  return live;
}

const frontierSandboxAvailable = requiredFrontierSandboxAvailable();

function stage(task: BenchTask): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `neko-frontier-${task.id}-`)));
  for (const [name, content] of Object.entries(task.files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function replace(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
}

const CONFIG_SOLUTION = {
  "src/merge.mjs": `const plain = (value) => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const clone = (value) => Array.isArray(value)
  ? value.map(clone)
  : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]))
    : value !== null && typeof value === "object" ? structuredClone(value) : value;
export function mergeConfig(base = {}, override = {}) {
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = plain(value) && plain(out[key]) ? mergeConfig(out[key], value) : clone(value);
  }
  return out;
}
`,
  "src/cache.mjs": `let bySource = new WeakMap();
export function cachedBase(source, profile, build) {
  let profiles = bySource.get(source);
  if (!profiles) { profiles = new Map(); bySource.set(source, profiles); }
  if (!profiles.has(profile)) profiles.set(profile, build());
  return profiles.get(profile);
}
export function clearBaseCache() { bySource = new WeakMap(); }
`,
};

const INFLIGHT_SOLUTION = {
  "src/key.mjs": `export function lookupKey(tenant, id) { return [tenant, id]; }
`,
  "src/inflight.mjs": `const pending = new Map();
export function shareInflight(key, load) {
  const [tenant, id] = key;
  let byId = pending.get(tenant);
  if (!byId) { byId = new Map(); pending.set(tenant, byId); }
  if (byId.has(id)) return byId.get(id);
  const promise = Promise.resolve().then(load);
  byId.set(id, promise);
  const clear = () => {
    if (byId.get(id) !== promise) return;
    byId.delete(id);
    if (byId.size === 0 && pending.get(tenant) === byId) pending.delete(tenant);
  };
  void promise.then(clear, clear);
  return promise;
}
export function clearInflightTable() { pending.clear(); }
`,
};

const ATOMIC_SOLUTION = {
  "src/validate.mjs": `export function validateChange(change) {
  if (!change || typeof change.id !== "string" || !change.id) throw new TypeError("invalid id");
  if (!change.patch || typeof change.patch !== "object" || Array.isArray(change.patch)) throw new TypeError("invalid patch");
  if ("id" in change.patch) throw new TypeError("patch cannot replace id");
  return change;
}
export function validateBatch(changes) {
  if (!Array.isArray(changes)) throw new TypeError("changes must be an array");
  const seen = new Set();
  return changes.map((change) => {
    validateChange(change);
    if (seen.has(change.id)) throw new Error("duplicate id: " + change.id);
    seen.add(change.id);
    return change;
  });
}
`,
  "src/events.mjs": `const copy = (value) => structuredClone(value);
export function updateEvent(before, after) {
  return { type: "updated", id: after.id, before: copy(before), after: copy(after) };
}
`,
  "src/store.mjs": `const copy = (value) => structuredClone(value);
export class Store {
  #rows;
  #events = [];
  #failOnCommitIndex;
  constructor(rows, { failOnCommitIndex = -1 } = {}) {
    this.#rows = new Map(rows.map((row) => [row.id, copy(row)]));
    this.#failOnCommitIndex = failOnCommitIndex;
  }
  has(id) { return this.#rows.has(id); }
  get(id) { const row = this.#rows.get(id); return row ? copy(row) : undefined; }
  commit(entry) {
    this.#rows.set(entry.id, copy(entry.after));
    this.#events.push(copy(entry.event));
  }
  commitBatch(entries) {
    const rows = new Map([...this.#rows].map(([id, row]) => [id, copy(row)]));
    const events = this.#events.map(copy);
    entries.forEach((entry, index) => {
      if (index === this.#failOnCommitIndex) throw new Error("injected commit failure");
      rows.set(entry.id, copy(entry.after));
      events.push(copy(entry.event));
    });
    this.#rows = rows;
    this.#events = events;
  }
  rows() { return [...this.#rows.values()].map(copy); }
  events() { return this.#events.map(copy); }
}
`,
  "src/service.mjs": `import { updateEvent } from "./events.mjs";
import { validateBatch, validateChange } from "./validate.mjs";
const copy = (value) => structuredClone(value);
const entryFor = (store, change) => {
  if (!store.has(change.id)) throw new Error("unknown id: " + change.id);
  const before = store.get(change.id);
  const after = { ...before, ...copy(change.patch), id: change.id };
  return { id: change.id, before, after, event: updateEvent(before, after) };
};

export function updateOne(store, change) {
  validateChange(change);
  const entry = entryFor(store, change);
  store.commit(entry);
  return copy(entry.after);
}
export function updateBatch(store, changes) {
  const valid = validateBatch(changes);
  const entries = valid.map((change) => entryFor(store, change));
  store.commitBatch(entries);
  return entries.map((entry) => copy(entry.after));
}
`,
};

const SOLUTIONS = new Map<string, Record<string, string>>([
  ["config-context-cache", CONFIG_SOLUTION],
  ["inflight-recovery", INFLIGHT_SOLUTION],
  ["atomic-batch", ATOMIC_SOLUTION],
]);

const IMMUTABLE_CONFIG_SOLUTION = {
  ...CONFIG_SOLUTION,
  "src/resolve.mjs": `import { cachedBase, clearBaseCache } from "./cache.mjs";
import { loadBase } from "./load.mjs";
import { mergeConfig } from "./merge.mjs";
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
export function resolveConfig({ source, profile, projectId, project = {}, overrides = {} }) {
  void projectId;
  const base = cachedBase(source, profile, () => loadBase(source, profile));
  return deepFreeze(mergeConfig(mergeConfig(base, project), overrides));
}
export const clearConfigCache = clearBaseCache;
`,
};

const IMMUTABLE_ATOMIC_SOLUTION = {
  ...ATOMIC_SOLUTION,
  "src/events.mjs": `const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const snapshot = (value) => deepFreeze(structuredClone(value));
export function updateEvent(before, after) {
  return deepFreeze({ type: "updated", id: after.id, before: snapshot(before), after: snapshot(after) });
}
`,
  "src/service.mjs": `import { updateEvent } from "./events.mjs";
import { validateBatch, validateChange } from "./validate.mjs";
const copy = (value) => structuredClone(value);
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const deepSeal = (value) => {
  if (value && typeof value === "object" && !Object.isSealed(value)) {
    for (const child of Object.values(value)) deepSeal(child);
    Object.seal(value);
  }
  return value;
};
const entryFor = (store, change) => {
  if (!store.has(change.id)) throw new Error("unknown id: " + change.id);
  const before = store.get(change.id);
  const after = { ...before, ...copy(change.patch), id: change.id };
  return { id: change.id, before, after, event: updateEvent(before, after) };
};
export function updateOne(store, change) {
  validateChange(change);
  const entry = entryFor(store, change);
  store.commit(entry);
  return deepSeal(copy(entry.after));
}
export function updateBatch(store, changes) {
  const valid = validateBatch(changes);
  const entries = valid.map((change) => entryFor(store, change));
  store.commitBatch(entries);
  return deepFreeze(entries.map((entry) => copy(entry.after)));
}
`,
};

const PARTIAL_REPAIRS = new Map<string, Record<string, string>>([
  ["config-context-cache", {
    ...CONFIG_SOLUTION,
    "src/cache.mjs": `export function cachedBase(source, profile, build) {
  void source; void profile;
  return build();
}
export function clearBaseCache() {}
`,
  }],
  ["inflight-recovery", {
    ...INFLIGHT_SOLUTION,
    "src/catalog.mjs": `import { fetchCatalogItem } from "./client.mjs";
import { clearInflightTable, shareInflight } from "./inflight.mjs";
import { lookupKey } from "./key.mjs";
export async function getCatalogItem({ tenant, id, loader }) {
  return await shareInflight(lookupKey(tenant, id), () => fetchCatalogItem(tenant, id, loader));
}
export const clearInflight = clearInflightTable;
`,
  }],
  ["atomic-batch", {
    ...ATOMIC_SOLUTION,
    "src/validate.mjs": `export function validateChange(change) {
  if (!change || typeof change.id !== "string" || !change.id) throw new TypeError("invalid id");
  if (!change.patch || typeof change.patch !== "object" || Array.isArray(change.patch)) throw new TypeError("invalid patch");
  if ("id" in change.patch) throw new TypeError("patch cannot replace id");
  return change;
}
export function validateBatch(changes) {
  if (!Array.isArray(changes)) throw new TypeError("changes must be an array");
  const seen = new Set();
  return changes.map((change) => {
    validateChange(change);
    if (seen.has(change)) throw new Error("duplicate change object");
    seen.add(change);
    return change;
  });
}
`,
  }],
]);

const ADMISSION_MUTANTS: Array<{ name: string; taskId: string; files: Record<string, string> }> = [
  {
    name: "config-broad-object-merge",
    taskId: "config-context-cache",
    files: {
      ...CONFIG_SOLUTION,
      "src/merge.mjs": `const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => Array.isArray(value)
  ? value.map(clone)
  : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]))
    : value;
export function mergeConfig(base = {}, override = {}) {
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = plain(value) && plain(out[key]) ? mergeConfig(out[key], value) : clone(value);
  }
  return out;
}
`,
    },
  },
  {
    name: "config-source-attached-cache",
    taskId: "config-context-cache",
    files: {
      ...CONFIG_SOLUTION,
      "src/cache.mjs": `const cacheSlot = Symbol("profile-cache");
export function cachedBase(source, profile, build) {
  if (!source[cacheSlot]) Object.defineProperty(source, cacheSlot, { value: new Map() });
  if (!source[cacheSlot].has(profile)) source[cacheSlot].set(profile, build());
  return source[cacheSlot].get(profile);
}
export function clearBaseCache() {}
`,
    },
  },
  {
    name: "config-final-result-cache",
    taskId: "config-context-cache",
    files: {
      ...CONFIG_SOLUTION,
      "src/resolve.mjs": `import { cachedBase, clearBaseCache } from "./cache.mjs";
import { loadBase } from "./load.mjs";
import { mergeConfig } from "./merge.mjs";
let resolvedBySource = new WeakMap();
export function resolveConfig({ source, profile, projectId, project = {}, overrides = {} }) {
  let byContext = resolvedBySource.get(source);
  if (!byContext) { byContext = new Map(); resolvedBySource.set(source, byContext); }
  const key = JSON.stringify([profile, projectId]);
  if (!byContext.has(key)) {
    const base = cachedBase(source, profile, () => loadBase(source, profile));
    byContext.set(key, mergeConfig(mergeConfig(base, project), overrides));
  }
  return structuredClone(byContext.get(key));
}
export function clearConfigCache() { resolvedBySource = new WeakMap(); clearBaseCache(); }
`,
    },
  },
  {
    name: "config-miswired-clear",
    taskId: "config-context-cache",
    files: {
      ...CONFIG_SOLUTION,
      "src/resolve.mjs": `import { cachedBase } from "./cache.mjs";
import { loadBase } from "./load.mjs";
import { mergeConfig } from "./merge.mjs";
export function resolveConfig({ source, profile, projectId, project = {}, overrides = {} }) {
  void projectId;
  const base = cachedBase(source, profile, () => loadBase(source, profile));
  return mergeConfig(mergeConfig(base, project), overrides);
}
export function clearConfigCache() {}
`,
    },
  },
  {
    name: "config-content-discriminator",
    taskId: "config-context-cache",
    files: {
      ...CONFIG_SOLUTION,
      "src/cache.mjs": `let bases = new Map();
export function cachedBase(source, profile, build) {
  const key = JSON.stringify([source.defaults?.label ?? "", profile]);
  if (!bases.has(key)) bases.set(key, build());
  return bases.get(key);
}
export function clearBaseCache() { bases = new Map(); }
`,
    },
  },
  {
    name: "inflight-alternate-delimiter",
    taskId: "inflight-recovery",
    files: {
      ...INFLIGHT_SOLUTION,
      "src/key.mjs": `export function lookupKey(tenant, id) { return tenant + "|" + id; }
`,
    },
  },
  {
    name: "inflight-json-tuple-type-collapse",
    taskId: "inflight-recovery",
    files: {
      ...INFLIGHT_SOLUTION,
      "src/key.mjs": `export function lookupKey(tenant, id) { return JSON.stringify([tenant, id]); }
`,
      "src/inflight.mjs": `const pending = new Map();
export function shareInflight(key, load) {
  if (pending.has(key)) return pending.get(key);
  const promise = Promise.resolve().then(load);
  pending.set(key, promise);
  const clear = () => { if (pending.get(key) === promise) pending.delete(key); };
  void promise.then(clear, clear);
  return promise;
}
export function clearInflightTable() { pending.clear(); }
`,
    },
  },
  {
    name: "inflight-unconditional-aba-cleanup",
    taskId: "inflight-recovery",
    files: {
      ...INFLIGHT_SOLUTION,
      "src/inflight.mjs": `const pending = new Map();
export function shareInflight(key, load) {
  if (pending.has(key)) return pending.get(key);
  const promise = Promise.resolve().then(load);
  pending.set(key, promise);
  const clear = () => pending.delete(key);
  void promise.then(clear, clear);
  return promise;
}
export function clearInflightTable() { pending.clear(); }
`,
    },
  },
  {
    name: "atomic-shallow-observer-views",
    taskId: "atomic-batch",
    files: {
      ...ATOMIC_SOLUTION,
      "src/store.mjs": `const copy = (value) => structuredClone(value);
export class Store {
  #rows;
  #events = [];
  #failOnCommitIndex;
  constructor(rows, { failOnCommitIndex = -1 } = {}) {
    this.#rows = new Map(rows.map((row) => [row.id, copy(row)]));
    this.#failOnCommitIndex = failOnCommitIndex;
  }
  has(id) { return this.#rows.has(id); }
  get(id) { const row = this.#rows.get(id); return row ? { ...row } : undefined; }
  commit(entry) {
    this.#rows.set(entry.id, copy(entry.after));
    this.#events.push(copy(entry.event));
  }
  commitBatch(entries) {
    const rows = new Map([...this.#rows].map(([id, row]) => [id, copy(row)]));
    const events = this.#events.map(copy);
    entries.forEach((entry, index) => {
      if (index === this.#failOnCommitIndex) throw new Error("injected commit failure");
      rows.set(entry.id, copy(entry.after));
      events.push(copy(entry.event));
    });
    this.#rows = rows;
    this.#events = events;
  }
  rows() { return [...this.#rows.values()].map((row) => ({ ...row })); }
  events() { return this.#events.map((event) => ({ ...event })); }
}
`,
    },
  },
  {
    name: "atomic-shallow-update-event",
    taskId: "atomic-batch",
    files: {
      ...ATOMIC_SOLUTION,
      "src/events.mjs": `export function updateEvent(before, after) {
  return { type: "updated", id: after.id, before: { ...before }, after: { ...after } };
}
`,
    },
  },
  {
    name: "atomic-shallow-rollback-snapshot",
    taskId: "atomic-batch",
    files: {
      ...ATOMIC_SOLUTION,
      "src/store.mjs": `const copy = (value) => structuredClone(value);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const mergeInto = (target, source) => {
  for (const [key, value] of Object.entries(source)) {
    target[key] = plain(target[key]) && plain(value) ? mergeInto(target[key], value) : copy(value);
  }
  return target;
};
export class Store {
  #rows;
  #events = [];
  #failOnCommitIndex;
  constructor(rows, { failOnCommitIndex = -1 } = {}) {
    this.#rows = new Map(rows.map((row) => [row.id, copy(row)]));
    this.#failOnCommitIndex = failOnCommitIndex;
  }
  has(id) { return this.#rows.has(id); }
  get(id) { const row = this.#rows.get(id); return row ? copy(row) : undefined; }
  commit(entry) {
    this.#rows.set(entry.id, copy(entry.after));
    this.#events.push(copy(entry.event));
  }
  commitBatch(entries) {
    const rowsBefore = new Map([...this.#rows].map(([id, row]) => [id, { ...row }]));
    const eventsBefore = this.#events.map(copy);
    try {
      entries.forEach((entry, index) => {
        mergeInto(this.#rows.get(entry.id), entry.after);
        this.#events.push(copy(entry.event));
        if (index === this.#failOnCommitIndex) throw new Error("injected commit failure");
      });
    } catch (error) {
      this.#rows = rowsBefore;
      this.#events = eventsBefore;
      throw error;
    }
  }
  rows() { return [...this.#rows.values()].map(copy); }
  events() { return this.#events.map(copy); }
}
`,
    },
  },
];

test("frontier tier is small, multi-step, and protects every public contract", () => {
  expect(FRONTIER_TASKS.map((task) => task.id)).toEqual([
    "config-context-cache",
    "inflight-recovery",
    "atomic-batch",
  ]);
  expect(new Set(FRONTIER_TASKS.map((task) => task.id)).size).toBe(FRONTIER_TASKS.length);
  for (const task of FRONTIER_TASKS) {
    expect(task.optimalSteps).toBeGreaterThanOrEqual(9);
    expect(task.constraints?.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(task.files).filter((name) => name.startsWith("src/")).length).toBeGreaterThanOrEqual(3);
  }
});

test("frontier inventory is exact and hidden verification rejects a hard-linked source", async () => {
  const task = FRONTIER_TASKS[1];
  const root = stage(task);
  const outside = mkdtempSync(join(tmpdir(), "neko-frontier-alias-"));
  try {
    const inventory = task.constraints?.find((constraint) => constraint.id === "exact-inventory");
    expect(inventory?.check?.(root)).toBe(true);
    writeFileSync(join(root, "unexpected.txt"), "not allowed\n");
    expect(inventory?.check?.(root)).toBe(false);
    unlinkSync(join(root, "unexpected.txt"));
    mkdirSync(join(root, "unexpected-empty"));
    expect(inventory?.check?.(root)).toBe(false);
    rmSync(join(root, "unexpected-empty"), { recursive: true, force: true });

    const source = join(root, "src/key.mjs");
    const external = join(outside, "key.mjs");
    writeFileSync(external, task.files["src/key.mjs"]);
    unlinkSync(source);
    linkSync(external, source);
    expect(inventory?.check?.(root)).toBe(false);
    await expect(task.verify(root)).rejects.toBeInstanceOf(BenchInfrastructureError);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("frontier verifier refuses candidate runtime inspection and early-success termination", async () => {
  const task = FRONTIER_TASKS[0];
  const root = stage(task);
  try {
    replace(root, CONFIG_SOLUTION);
    writeFileSync(
      join(root, "src/merge.mjs"),
      'console.log("ok"); process.exit(0);\nexport function mergeConfig() { return {}; }\n',
    );
    expect(await task.verify(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!frontierSandboxAvailable)("frontier hidden assertions are not materialized beside candidate modules", async () => {
  const task = FRONTIER_TASKS[0];
  const root = stage(task);
  try {
    replace(root, CONFIG_SOLUTION);
    const path = join(root, "src/merge.mjs");
    const solution = readFileSync(path, "utf8");
    writeFileSync(path, [
      "const make = (() => {}).constructor;",
      "const load = make(\"return im\" + \"port('node:fs')\");",
      "const fs = await load();",
      "const runtime = make('return pro' + 'cess')();",
      "if (!fs.readdirSync(runtime.cwd()).includes('oracle.mjs')) throw new Error('oracle source is not visible');",
      solution,
    ].join("\n"));
    expect(await task.verify(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!frontierSandboxAvailable)("frontier assertions use harness-captured methods", async () => {
  const task = FRONTIER_TASKS[0];
  const root = stage(task);
  try {
    replace(root, { "src/cache.mjs": CONFIG_SOLUTION["src/cache.mjs"] });
    const seededMerge = task.files["src/merge.mjs"];
    writeFileSync(join(root, "src/merge.mjs"), [
      "const make = (() => {}).constructor;",
      "const load = make(\"return im\" + \"port('node:as' + 'sert/strict')\");",
      "const module = await load();",
      "for (const name of ['deepEqual', 'equal', 'notStrictEqual', 'strictEqual']) module.default[name] = () => {};",
      seededMerge,
    ].join("\n"));
    expect(await task.verify(root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

test.skipIf(!frontierSandboxAvailable)("frontier seeds fail and reviewed reference repairs pass the post-turn hidden oracle", async () => {
  for (const task of FRONTIER_TASKS) {
    const root = stage(task);
    try {
      expect(await task.verify(root)).toBe(false);
      replace(root, SOLUTIONS.get(task.id)!);
      expect(await task.verify(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 300_000);

test.skipIf(!frontierSandboxAvailable)("frontier mutation probes accept isolated frozen and sealed snapshots", async () => {
  for (const [taskId, solution] of [
    ["config-context-cache", IMMUTABLE_CONFIG_SOLUTION],
    ["atomic-batch", IMMUTABLE_ATOMIC_SOLUTION],
  ] as const) {
    const task = FRONTIER_TASKS.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`missing frontier task: ${taskId}`);
    const root = stage(task);
    try {
      replace(root, solution);
      expect(await task.verify(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 180_000);

test.skipIf(!frontierSandboxAvailable)("frontier hidden oracles reject plausible partial repairs", async () => {
  for (const task of FRONTIER_TASKS) {
    const root = stage(task);
    try {
      replace(root, PARTIAL_REPAIRS.get(task.id)!);
      expect(await task.verify(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 180_000);

test.skipIf(!frontierSandboxAvailable)("frontier admission rejects known public-contract mutants", async () => {
  for (const mutant of ADMISSION_MUTANTS) {
    const task = FRONTIER_TASKS.find((candidate) => candidate.id === mutant.taskId);
    if (!task) throw new Error(`missing frontier task: ${mutant.taskId}`);
    const root = stage(task);
    try {
      replace(root, mutant.files);
      expect(await task.verify(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 600_000);
