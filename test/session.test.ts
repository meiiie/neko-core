import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { latestSession, listSessionMetas, listSessions, loadSession, newSessionId, saveSession } from "../src/adapters/session.ts";

// Isolate from the user's real ~/.neko-core: these tests WRITE session files, so point HOME at a throwaway
// dir for their duration. Otherwise they pollute the user's real session history AND get slowed by it —
// running this suite hundreds of times (the self-improve loop) bloated that dir to thousands of files,
// making latestSession's directory scan time out here (a false test failure). Restored in afterAll.
const TEST_HOME = mkdtempSync(join(tmpdir(), "neko-sess-home-"));
const SAVED = { up: process.env.USERPROFILE, home: process.env.HOME };
beforeAll(() => { process.env.USERPROFILE = TEST_HOME; process.env.HOME = TEST_HOME; });
afterAll(() => {
  process.env.USERPROFILE = SAVED.up; process.env.HOME = SAVED.home;
  rmSync(TEST_HOME, { recursive: true, force: true });
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
    for (const id of [a, b]) rmSync(join(TEST_HOME, ".neko-core", "sessions", `${id}.json`), { force: true });
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
    rmSync(join(TEST_HOME, ".neko-core", "sessions", `${id}.json`), { force: true });
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
    expect(existsSync(join(TEST_HOME, ".neko-core", "sessions", ".index.json"))).toBe(true);
    expect(listSessionMetas().find((x) => x.id === id)?.msgCount).toBe(2);

    // Change the session (more messages, new mtime) -> the meta re-parses, not stale.
    saveSession({ ...sess, messages: [...sess.messages, { role: "user", content: "more" }] });
    expect(listSessionMetas().find((x) => x.id === id)?.msgCount).toBe(3);
  } finally {
    rmSync(join(TEST_HOME, ".neko-core", "sessions", `${id}.json`), { force: true });
  }
});

