import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { latestSession, listSessions, loadSession, newSessionId, saveSession } from "../src/adapters/session.ts";

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
    for (const id of [a, b]) rmSync(join(homedir(), ".neko-core", "sessions", `${id}.json`), { force: true });
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
    rmSync(join(homedir(), ".neko-core", "sessions", `${id}.json`), { force: true });
  }
});
