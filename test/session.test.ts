import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listSessions, loadSession, newSessionId, saveSession } from "../src/session.ts";

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
