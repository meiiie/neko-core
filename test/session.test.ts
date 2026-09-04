import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireSessionLease, AsyncSessionWriter, isValidSessionId, latestSession, listSessionMetas, listSessions, loadSession, newSessionId, renameSession, renderSessions, saveSession, saveSessionAsync, setSessionsDir } from "../src/adapters/session.ts";
import { isJsonNumber } from "../src/shared/wire.ts";
import { createCompletionContract } from "../src/core/completion-contract.ts";

// Isolate from the user's real ~/.neko-core: these tests WRITE session files. Pointing HOME at a
// temp dir was the old way, but env mutation across bun test files is racy (see bun-test-env-races)
// — so the store is now redirected explicitly via setSessionsDir. (Without an override, NODE_ENV=test
// already diverts the store to a per-process temp dir; the explicit dir here lets the tests assert on
// the files themselves.)
const TEST_DIR = mkdtempSync(join(tmpdir(), "neko-sess-store-"));
beforeAll(() => setSessionsDir(TEST_DIR));
afterAll(() => {
  setSessionsDir(null);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("sessions are isolated per folder (latestSession filters by cwd)", () => {
  const a = newSessionId();
  const b = `${a}-b`;
  saveSession({ id: a, createdAt: new Date().toISOString(), updatedAt: "", cwd: "/tmp/neko-folder-A", model: "m", messages: [{ role: "user", content: "in A" }] });
  saveSession({ id: b, createdAt: new Date().toISOString(), updatedAt: "", cwd: "/tmp/neko-folder-B", model: "m", messages: [{ role: "user", content: "in B" }] });
  try {
    expect(latestSession("/tmp/neko-folder-A")?.id).toBe(a);
    expect(latestSession("/tmp/neko-folder-B")?.id).toBe(b);
  } finally {
    for (const id of [a, b]) rmSync(join(TEST_DIR, `${id}.json`), { force: true });
  }
});

test("save / load / list round-trip", () => {
  const id = newSessionId();
  saveSession({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd: "/tmp/neko-session-test",
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  try {
    const loaded = loadSession(id);
    expect(loaded?.id).toBe(id);
    expect(loaded?.messages.length).toBe(1);
    expect(listSessions().some((s) => s.id === id)).toBe(true);
  } finally {
    rmSync(join(TEST_DIR, `${id}.json`), { force: true });
  }
});

test("session round-trips a bounded completion contract and rejects malformed criteria", () => {
  const id = newSessionId();
  const completionContract = createCompletionContract("ship", { criteria: [
    { requirement: "Tests pass", source: "repository", verification: "bun test" },
  ] }, "2026-08-29T00:00:00.000Z");
  saveSession({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd: "/tmp/neko-contract-session",
    model: "m",
    messages: [],
    completionContract,
  });
  try {
    expect(loadSession(id)?.completionContract).toEqual(completionContract);
    // SAFETY: deliberately malformed test payload exercises the runtime session parser.
    expect(() => saveSession({
      id: `${id}-bad`,
      createdAt: new Date().toISOString(),
      updatedAt: "",
      cwd: "/tmp/neko-contract-session",
      model: "m",
      messages: [],
      completionContract: { ...completionContract, criteria: [] },
    } as any)).toThrow("Invalid session");
  } finally {
    rmSync(join(TEST_DIR, `${id}.json`), { force: true });
  }
});

test("async checkpoints yield to the event loop and preserve the last readable backup", async () => {
  const id = `${newSessionId()}-async`;
  const base = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd: "/tmp/neko-session-async",
    model: "m",
    messages: Array.from({ length: 384 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `${index}:` + "x".repeat(32 * 1024),
    })),
  };
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 1);
  try {
    await saveSessionAsync(base);
    await saveSessionAsync({ ...base, messages: [...base.messages, { role: "assistant", content: "newest" }] });
    expect(ticks).toBeGreaterThan(0);
    expect(loadSession(id)?.messages.at(-1)?.content).toBe("newest");
    writeFileSync(join(TEST_DIR, `${id}.json`), "{broken", "utf8");
    expect(loadSession(id)?.messages).toHaveLength(base.messages.length);
  } finally {
    clearInterval(ticker);
    rmSync(join(TEST_DIR, `${id}.json`), { force: true });
    rmSync(join(TEST_DIR, `${id}.json.bak`), { force: true });
  }
}, { timeout: 30_000 });

test("AsyncSessionWriter coalesces pending generations and never overlaps writes", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const saved: string[] = [];
  let active = 0;
  let maxActive = 0;
  const writer = new AsyncSessionWriter(async (session) => {
    active++;
    maxActive = Math.max(maxActive, active);
    saved.push(String(session.messages[0]?.content));
    if (saved.length === 1) await firstGate;
    active--;
  });
  const make = (content: string) => ({
    id: newSessionId(), createdAt: new Date().toISOString(), updatedAt: "", cwd: "/tmp", model: "m",
    messages: [{ role: "user", content }],
  });
  const first = writer.save(make("first"));
  const skipped = writer.save(make("skipped"));
  const latest = writer.save(make("latest"));
  releaseFirst();
  await Promise.all([first, skipped, latest, writer.flush()]);
  expect(saved).toEqual(["first", "latest"]);
  expect(maxActive).toBe(1);
});

test("durable metadata round-trips and a corrupt primary falls back to the last good checkpoint", () => {
  const id = `${newSessionId()}-durable`;
  const now = new Date().toISOString();
  saveSession({
    schemaVersion: 2,
    id,
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp/durable",
    provider: "openai_compat",
    model: "model-a",
    profile: "profile-a",
    mode: "plan",
    reasoningEffort: "high",
    revision: 1,
    messages: [{ role: "user", content: "checkpoint one" }],
    turnState: { status: "running", activeToolCallIds: ["call-1"] },
    usage: {
      promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 3, cacheWriteTokens: 0,
      calls: 1, lastPrompt: 10, lastCompletion: 2, lastCached: 3, lastCacheWrite: 0,
    },
  });
  const newer = loadSession(id)!;
  newer.revision = 2;
  newer.messages.push({ role: "assistant", content: "checkpoint two" });
  newer.turnState = { status: "idle", activeToolCallIds: [] };
  saveSession(newer);
  expect(loadSession(id)?.revision).toBe(2);
  expect(existsSync(join(TEST_DIR, `${id}.json.bak`))).toBe(true);

  writeFileSync(join(TEST_DIR, `${id}.json`), "{broken", "utf8");
  const recovered = loadSession(id)!;
  expect(recovered.revision).toBe(1);
  expect(recovered.messages.at(-1)?.content).toBe("checkpoint one");
  expect(listSessionMetas().find((meta) => meta.id === id)).toMatchObject({
    provider: "openai_compat",
    profile: "profile-a",
    mode: "plan",
    revision: 1,
  });
  rmSync(join(TEST_DIR, `${id}.json`), { force: true });
  rmSync(join(TEST_DIR, `${id}.json.bak`), { force: true });
});

test("session writer leases reject overlap, release cleanly, and recover a dead owner", () => {
  const id = `${newSessionId()}-lease`;
  const first = acquireSessionLease(id);
  expect(() => acquireSessionLease(id)).toThrow("active writer");
  first.release();
  const second = acquireSessionLease(id);
  second.release();

  writeFileSync(join(TEST_DIR, `${id}.json.lock`), JSON.stringify({
    pid: 2_147_483_647,
    token: "stale",
    acquiredAt: new Date().toISOString(),
  }), "utf8");
  const recovered = acquireSessionLease(id);
  recovered.release();
  expect(existsSync(join(TEST_DIR, `${id}.json.lock`))).toBe(false);
});

test("save refuses an oversized UTF-8 session without replacing its last readable checkpoint", () => {
  const id = newSessionId();
  const path = join(TEST_DIR, `${id}.json`);
  const baseline = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd: "/tmp/neko-session-size-test",
    model: "m",
    messages: [{ role: "user", content: "readable checkpoint" }],
  };
  saveSession(baseline);
  const original = readFileSync(path, "utf8");
  try {
    // 33 MiB of two-byte UTF-8 characters is below the old character-count boundary but above the
    // 64 MiB on-disk boundary. This proves the writer uses the same byte unit as the reader.
    const oversized = {
      ...baseline,
      messages: [{ role: "user", content: "é".repeat(33 * 1024 * 1024) }],
    };
    expect(() => saveSession(oversized)).toThrow("exceeds 64 MiB");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(loadSession(id)?.messages[0]?.content).toBe("readable checkpoint");
  } finally {
    rmSync(path, { force: true });
  }
}, { timeout: 30_000 });

test("session round-trip preserves validated local message markers", () => {
  const id = newSessionId();
  saveSession({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd: "/tmp/neko-internal-marker-test",
    model: "m",
    messages: [
      { role: "user", content: "human", _neko_internal: false },
      { role: "user", content: "VERIFY BEFORE FINISHING: inspect", _neko_internal: true },
    ],
  });
  try {
    expect(loadSession(id)?.messages.map((message) => message._neko_internal)).toEqual([false, true]);
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    expect(() => saveSession({
      id: `${id}-invalid`,
      createdAt: new Date().toISOString(), updatedAt: "", cwd: "/tmp", model: "m",
      messages: [{ role: "user", content: "bad marker", _neko_internal: "true" }],
    } as any)).toThrow("Invalid session");
  } finally {
    rmSync(join(TEST_DIR, `${id}.json`), { force: true });
  }
});

test("session IDs are unique, leaf-only, and reject Windows device names", () => {
  const ids = Array.from({ length: 1000 }, () => newSessionId());
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(isValidSessionId(id)).toBe(true);
  for (const id of ["../outside", "..\\outside", "C:escape", "NUL", "con.json", "name.", "a/b", "a\\b", ""]) {
    expect(isValidSessionId(id)).toBe(false);
  }
});

test("load/save/rename cannot traverse the session store", () => {
  const escaped = join(TEST_DIR, "..", "neko-session-escaped.json");
  rmSync(escaped, { force: true });
  const invalid = {
    id: "../neko-session-escaped",
    createdAt: new Date().toISOString(), updatedAt: "", cwd: "/tmp", model: "m",
    messages: [{ role: "user", content: "do not write" }],
  };
  expect(() => saveSession(invalid)).toThrow("Invalid session");
  expect(loadSession(invalid.id)).toBeNull();
  renameSession(invalid.id, "escaped");
  expect(existsSync(escaped)).toBe(false);
});

test("session payload shape and embedded ID must match the filename", () => {
  const wrongId = `${newSessionId()}-wrong`;
  const malformedId = `${newSessionId()}-malformed`;
  writeFileSync(join(TEST_DIR, `${wrongId}.json`), JSON.stringify({
    id: "different", createdAt: "x", updatedAt: "x", cwd: "/tmp", model: "m",
    messages: [{ role: "user", content: "x" }],
  }));
  writeFileSync(join(TEST_DIR, `${malformedId}.json`), JSON.stringify({
    id: malformedId, createdAt: "x", updatedAt: "x", cwd: "/tmp", model: "m", messages: "not-an-array",
  }));
  try {
    expect(loadSession(wrongId)).toBeNull();
    expect(loadSession(malformedId)).toBeNull();
    expect(listSessions().some((session) => session.id === wrongId || session.id === malformedId)).toBe(false);
    expect(listSessionMetas().some((meta) => meta.id === wrongId || meta.id === malformedId)).toBe(false);
  } finally {
    rmSync(join(TEST_DIR, `${wrongId}.json`), { force: true });
    rmSync(join(TEST_DIR, `${malformedId}.json`), { force: true });
  }
});

test("session metadata rejects terminal controls while printable Unicode remains listable", () => {
  const unsafeId = `${newSessionId()}-controls`;
  const safeId = `${newSessionId()}-unicode`;
  const unsafePath = join(TEST_DIR, `${unsafeId}.json`);
  const safePath = join(TEST_DIR, `${safeId}.json`);
  writeFileSync(unsafePath, JSON.stringify({
    id: unsafeId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: "/tmp/safe\u001b]2;PWN\u0007",
    model: "m",
    title: "title\u001b]52;c;UE9JU09O\u0007",
    messages: [{ role: "user", content: "x" }],
  }));
  try {
    expect(loadSession(unsafeId)).toBeNull();
    expect(() => saveSession({
      id: `${unsafeId}-save`, createdAt: new Date().toISOString(), updatedAt: "",
      cwd: "/tmp/safe", model: "m", title: "bad\u001btitle", messages: [],
    })).toThrow("Invalid session");

    saveSession({
      id: safeId, createdAt: new Date().toISOString(), updatedAt: "",
      cwd: "/tmp/du-an", model: "mo-hinh", title: "Phiên tiếng Việt", messages: [],
    });
    const rendered = renderSessions();
    expect(rendered).toContain("Phiên tiếng Việt");
    expect(rendered).not.toContain("PWN");
    expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  } finally {
    rmSync(unsafePath, { force: true });
    rmSync(safePath, { force: true });
    rmSync(join(TEST_DIR, `${unsafeId}-save.json`), { force: true });
  }
});

test("rename enforces metadata controls and the 64 MiB atomic publish boundary", () => {
  const id = `${newSessionId()}-rename-boundary`;
  const path = join(TEST_DIR, `${id}.json`);
  const limit = 64 * 1024 * 1024;
  const targetBytes = limit - 512;
  const session: any = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: "/tmp/neko-rename-boundary",
    model: "m",
    messages: [{ role: "user", content: "x".repeat(limit - 4096) }],
    branch: "",
    bytes: 0,
  };
  // Tune a readable fixture close enough to the reader ceiling that a valid 4 KiB title crosses it.
  for (let attempt = 0; attempt < 3; attempt++) {
    session.bytes = JSON.stringify(session.messages).length;
    const current = Buffer.byteLength(JSON.stringify(session, null, 2), "utf8");
    const delta = targetBytes - current;
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const content = session.messages[0].content as string;
    session.messages[0].content = delta >= 0 ? content + "x".repeat(delta) : content.slice(0, delta);
  }
  session.bytes = JSON.stringify(session.messages).length;
  const original = JSON.stringify(session, null, 2);
  expect(Buffer.byteLength(original, "utf8")).toBeLessThanOrEqual(limit);
  expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(limit - 4096);
  writeFileSync(path, original);
  try {
    expect(loadSession(id)?.messages[0]?.content).toBeTruthy();
    expect(() => renameSession(id, "bad\u001btitle")).toThrow("Invalid session title");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(() => renameSession(id, "t".repeat(4096))).toThrow("exceeds 64 MiB");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(loadSession(id)?.id).toBe(id);
  } finally {
    rmSync(path, { force: true });
  }
}, { timeout: 30_000 });

test("listSessionMetas: lightweight metadata, mtime-cached index, self-heals on change", () => {
  const id = newSessionId();
  const sess = { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cwd: "/tmp/neko-meta-test", model: "m", messages: [{ role: "user", content: "first question here" }, { role: "assistant", content: "an answer" }] };
  saveSession(sess);
  try {
    const metas = listSessionMetas();
    const m = metas.find((x) => x.id === id)!;
    expect(m).toBeTruthy();
    expect(m.msgCount).toBe(2);
    expect(m.titleText).toBe("first question here"); // precomputed title, no messages array on the meta
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    expect((m as any).messages).toBeUndefined(); // it's metadata only

    // The index file was written; a 2nd call reads it (mtime cache) and still returns the entry.
    expect(existsSync(join(TEST_DIR, ".index.json"))).toBe(true);
    expect(listSessionMetas().find((x) => x.id === id)?.msgCount).toBe(2);

    // A poisoned cache ID must not be trusted even when mtime/size still match; reparse the source.
    const poisonedPath = join(TEST_DIR, ".index.json");
    const poisoned = JSON.parse(readFileSync(poisonedPath, "utf-8"));
    poisoned.metas[id].id = "../poisoned";
    writeFileSync(poisonedPath, JSON.stringify(poisoned));
    expect(listSessionMetas().find((x) => x.id === id)?.id).toBe(id);

    // Change the session (more messages, new mtime) -> the meta re-parses, not stale.
    saveSession({ ...sess, messages: [...sess.messages, { role: "user", content: "more" }] });
    expect(listSessionMetas().find((x) => x.id === id)?.msgCount).toBe(3);

    // LEGACY index migration: entries without fsize (pre-upgrade) must be reused + stamped, NOT re-parsed
    // en masse (the one-time /resume picker stall after upgrading). Simulate by stripping fsize.
    const idxPath = join(TEST_DIR, ".index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf-8"));
    for (const k of Object.keys(idx.metas)) delete idx.metas[k].fsize;
    writeFileSync(idxPath, JSON.stringify(idx));
    expect(listSessionMetas().find((x) => x.id === id)?.msgCount).toBe(3); // still served
    const migrated = JSON.parse(readFileSync(idxPath, "utf-8"));
    expect(isJsonNumber(migrated.metas[id].fsize)).toBe(true); // ...and the entry was stamped in place
  } finally {
    rmSync(join(TEST_DIR, `${id}.json`), { force: true });
  }
});

// The pollution guard itself: under bun test WITHOUT an explicit override, nothing may touch the
// real ~/.neko-core/sessions. This is the regression test for the flood that broke /resume.
test("NODE_ENV=test diverts the store away from the real home", () => {
  setSessionsDir(null); // drop this file's override to observe the default test-time resolution
  try {
    const id = `${newSessionId()}-guard`;
    saveSession({ id, createdAt: new Date().toISOString(), updatedAt: "", cwd: "/tmp/g", model: "m", messages: [{ role: "user", content: "guard" }] });
    const real = join(process.env.USERPROFILE || process.env.HOME || "", ".neko-core", "sessions", `${id}.json`);
    const diverted = join(tmpdir(), `neko-test-sessions-${process.pid}`, `${id}.json`);
    expect(existsSync(real)).toBe(false);
    expect(existsSync(diverted)).toBe(true);
    rmSync(diverted, { force: true });
  } finally {
    setSessionsDir(TEST_DIR); // restore for any test that runs after this one
  }
});
