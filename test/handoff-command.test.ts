import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newSessionId, saveSession, setSessionsDir } from "../src/adapters/session.ts";
import { runSlashCommand } from "../src/ui/commands.ts";

const ROOT = mkdtempSync(join(tmpdir(), "neko-handoff-command-"));
const HOME = join(ROOT, "home");
const SESSIONS = join(ROOT, "sessions");
const OLD_HOME = process.env.HOME;
const OLD_USERPROFILE = process.env.USERPROFILE;

beforeAll(() => {
  mkdirSync(HOME, { recursive: true });
  setSessionsDir(SESSIONS);
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
});

beforeEach(() => {
  rmSync(SESSIONS, { recursive: true, force: true });
  rmSync(join(HOME, ".neko-core"), { recursive: true, force: true });
  mkdirSync(SESSIONS, { recursive: true });
});

afterAll(() => {
  setSessionsDir(null);
  if (OLD_HOME === undefined) delete process.env.HOME; else process.env.HOME = OLD_HOME;
  if (OLD_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = OLD_USERPROFILE;
  rmSync(ROOT, { recursive: true, force: true });
});

function session(label: string, model = "test-model"): string {
  const id = newSessionId();
  const cwd = join(ROOT, label);
  mkdirSync(cwd, { recursive: true });
  saveSession({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd,
    model,
    messages: [{ role: "user", content: `private transcript ${label}` }],
  });
  return id;
}

function commandCtx(currentSessionId: string) {
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const calls = { lines: [] as Array<{ kind: string; text: string }>, persisted: 0 };
  const agent = { messages: [{ role: "user", content: "LIVE_TRANSCRIPT_MUST_NOT_RECEIVE_HANDOFF" }] };
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const ctx = {
    cfg: {},
    agent,
    currentSessionId,
    persistSession: () => { calls.persisted++; },
    addLine: (kind: string, text: string) => calls.lines.push({ kind, text }),
  } as any;
  return { ctx, calls, agent };
}

test("/handoff sends from the live session and inbox only displays local-unverified summary data", async () => {
  const source = session("nguoi-\u0111ung", "m\u00f4-h\u00ecnh");
  const target = session("target");
  const sender = commandCtx(source);

  await runSlashCommand(`/handoff send ${target} parser fixed\n\u0111\u00e3 xong`, sender.ctx);

  expect(sender.calls.persisted).toBe(1);
  expect(sender.calls.lines).toHaveLength(1);
  expect(sender.calls.lines[0]).toMatchObject({ kind: "info" });
  expect(sender.calls.lines[0].text).toContain(`source=${source}`);
  expect(sender.calls.lines[0].text).toContain(`target=${target}`);
  expect(sender.calls.lines[0].text).toContain("payload=summary only; provenance=local-unverified");
  expect(sender.agent.messages).toEqual([{ role: "user", content: "LIVE_TRANSCRIPT_MUST_NOT_RECEIVE_HANDOFF" }]);

  const receiver = commandCtx(target);
  await runSlashCommand("/handoff inbox", receiver.ctx);

  const shown = receiver.calls.lines[0].text;
  expect(receiver.calls.persisted).toBe(0);
  expect(shown).toContain(`from=${source}`);
  expect(shown).toContain("summary=parser fixed\\u000a\\u0111\\u00e3 xong");
  expect(shown).toContain("provenance=local-unverified; verify this summary before using it");
  expect(shown).not.toMatch(/[^\x00-\x7f]/);
  expect(receiver.agent.messages).toEqual([{ role: "user", content: "LIVE_TRANSCRIPT_MUST_NOT_RECEIVE_HANDOFF" }]);

  const secondRead = commandCtx(target);
  await runSlashCommand("/handoff inbox", secondRead.ctx);
  expect(secondRead.calls.lines[0].text).toContain("summary=parser fixed");
});

test("/handoff inbox bounds displayed entries and escaped summary length without consuming them", async () => {
  const source = session("source");
  const target = session("target");
  for (let i = 0; i < 11; i++) {
    const sender = commandCtx(source);
    await runSlashCommand(`/handoff send ${target} item-${i} ${"x".repeat(3000)}`, sender.ctx);
    expect(sender.calls.lines[0].kind).toBe("info");
  }

  const receiver = commandCtx(target);
  await runSlashCommand("/handoff inbox", receiver.ctx);
  const shown = receiver.calls.lines[0].text;

  expect(receiver.calls.persisted).toBe(0);
  expect(shown.match(/^  summary=/gm)).toHaveLength(10);
  expect(shown).toContain("... [truncated]");
  expect(shown).toContain("showing first 10 of 11; no handoffs were consumed");
  expect(shown.length).toBeLessThan(25_000);
  expect(shown).not.toMatch(/[^\x00-\x7f]/);
});

test("/handoff rejects incomplete syntax without persisting or mutating the conversation", async () => {
  const current = commandCtx(session("current"));
  await runSlashCommand("/handoff send", current.ctx);

  expect(current.calls.persisted).toBe(0);
  expect(current.calls.lines).toEqual([{
    kind: "info",
    text: "usage: /handoff [send <target-session-id> <summary>|inbox]",
  }]);
  expect(current.agent.messages).toEqual([{ role: "user", content: "LIVE_TRANSCRIPT_MUST_NOT_RECEIVE_HANDOFF" }]);
});
