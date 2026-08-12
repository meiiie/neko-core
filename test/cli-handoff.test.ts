import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHandoffStore } from "../src/adapters/session-handoff.ts";
import { newSessionId, saveSession, setSessionsDir } from "../src/adapters/session.ts";

const root = mkdtempSync(join(tmpdir(), "neko-cli-handoff-"));
const home = join(root, "home");
const sessions = join(home, ".neko-core", "sessions");
const entry = join(import.meta.dir, "..", "bin", "neko.ts");
mkdirSync(sessions, { recursive: true });

function makeSession(label: string): string {
  const id = newSessionId();
  saveSession({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd: join(root, label),
    model: "test-model",
    messages: [{ role: "user", content: `PRIVATE_${label.toUpperCase()}_TRANSCRIPT` }],
  });
  return id;
}

function run(...args: string[]) {
  return Bun.spawnSync([process.execPath, entry, ...args], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "production", NEKO_AUTO_UPDATE: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterAll(() => {
  setSessionsDir(null);
  rmSync(root, { recursive: true, force: true });
});

test("CLI sends and inspects a summary-only cross-session handoff", () => {
  setSessionsDir(sessions);
  const source = makeSession("source");
  const target = makeSession("target");

  const sent = run("handoff", "send", source, target, "parser fixed; tests pass");
  expect(sent.exitCode).toBe(0);
  expect(sent.stdout.toString()).toContain("payload = summary only");
  const pending = join(home, ".neko-core", "handoffs", "v1", "pending");
  const files = readdirSync(pending).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const raw = readFileSync(join(pending, files[0]), "utf8");
  expect(raw).toContain("parser fixed; tests pass");
  expect(raw).not.toContain("PRIVATE_SOURCE_TRANSCRIPT");
  expect(raw).not.toContain("PRIVATE_TARGET_TRANSCRIPT");

  const inbox = run("handoff", "inbox", target);
  expect(inbox.exitCode).toBe(0);
  expect(inbox.stdout.toString()).toContain(`Pending handoffs for ${target}`);
  expect(inbox.stdout.toString()).toContain("summary=parser fixed; tests pass");
  expect(inbox.stdout.toString()).toContain("provenance=local-unverified");
});

test("CLI inbox bounds displayed entries and escaped summary output", () => {
  setSessionsDir(sessions);
  const source = makeSession("bounded-source");
  const target = makeSession("bounded-target");
  const store = new SessionHandoffStore(home);
  for (let index = 0; index < 11; index++) {
    store.send(source, target, `item-${index} ${"x".repeat(3000)}`);
  }

  const inbox = run("handoff", "inbox", target);
  const output = inbox.stdout.toString();
  expect(inbox.exitCode).toBe(0);
  expect(output.match(/^  summary=/gm)).toHaveLength(10);
  expect(output).toContain("... [truncated]");
  expect(output).toContain("Showing first 10 of 11; no handoffs were consumed.");
  expect(output.length).toBeLessThan(25_000);
  expect(output).not.toMatch(/[^\x00-\x7f]/);
});

test("sessions CLI never emits terminal controls from crafted session metadata", () => {
  setSessionsDir(sessions);
  const id = `${newSessionId()}-terminal-metadata`;
  const path = join(sessions, `${id}.json`);
  writeFileSync(path, JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: `${root}\u001b]2;PWN_TITLE\u0007`,
    model: "test-model",
    title: "safe\u001b]52;c;PWN_CLIPBOARD\u0007",
    messages: [{ role: "user", content: "ordinary message" }],
  }));

  try {
    const result = run("sessions");
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).toBe(0);
    expect(output).not.toContain("PWN_TITLE");
    expect(output).not.toContain("PWN_CLIPBOARD");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).not.toMatch(/[\u0080-\u009f]/);
  } finally {
    rmSync(path, { force: true });
  }
});
