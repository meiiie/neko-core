import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { latestSession, listSessionMetas, listSessions, loadSession, newSessionId, saveSession, setSessionsDir } from "../src/adapters/session.ts";

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
    expect((m as any).messages).toBeUndefined(); // it's metadata only

    // The index file was written; a 2nd call reads it (mtime cache) and still returns the entry.
    expect(existsSync(join(TEST_DIR, ".index.json"))).toBe(true);
    expect(listSessionMetas().find((x) => x.id === id)?.msgCount).toBe(2);

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
    expect(typeof migrated.metas[id].fsize).toBe("number"); // ...and the entry was stamped in place
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
