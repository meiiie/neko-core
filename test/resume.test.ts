/**
 * Regression tests for the "/resume is broken" report (2026-07-28):
 *  - "/resume all" was parsed as a session ID ("no session 'all'") instead of the all-projects scope.
 *  - Gated denials in a non-interactive run were silent to the model, so a delegated `neko run`
 *    finished "cleanly" with no file written and no explanation (the 191-token nothing).
 * The third leg of that report — the test suite flooding the real ~/.neko-core/sessions — is covered
 * in session.test.ts ("NODE_ENV=test diverts the store away from the real home").
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSession, setSessionsDir } from "../src/adapters/session.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { runSlashCommand } from "../src/ui/commands.ts";

const STORE = mkdtempSync(join(tmpdir(), "neko-resume-cmd-"));
beforeAll(() => {
  setSessionsDir(STORE);
  const stamp = new Date().toISOString();
  saveSession({ id: "here-1", createdAt: stamp, updatedAt: stamp, cwd: process.cwd(), model: "m", messages: [{ role: "user", content: "local work" }] });
  saveSession({ id: "away-1", createdAt: stamp, updatedAt: stamp, cwd: "/some/other/project", model: "m", messages: [{ role: "user", content: "remote work" }] });
});
afterAll(() => {
  setSessionsDir(null);
  rmSync(STORE, { recursive: true, force: true });
});

/** The slice of CommandCtx the /resume path touches, with capture hooks. */
function mockCtx() {
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const calls = { overlays: [] as any[], lines: [] as string[], resumed: [] as string[] };
  const ctx: any = {
    cfg: {}, agent: { messages: [] },
    addLine: (_kind: string, text: string) => calls.lines.push(text),
    setOverlay: (o: any) => { if (o) calls.overlays.push(o); },
    resumeInto: (s: any) => calls.resumed.push(s.id),
  };
  return { ctx, calls };
}

test("/resume is folder-first with every project searchable; /resume all is the flat global list", async () => {
  const a = mockCtx();
  await runSlashCommand("/resume", a.ctx);
  expect(a.calls.overlays.length).toBe(1);
  expect(a.calls.overlays[0].title).toBe("Resume session");
  // Smart scope: this folder's sessions FIRST, other projects after (so typing can find them).
  expect(a.calls.overlays[0].items.map((i: any) => i.id)).toEqual(["here-1", "away-1"]);
  expect(a.calls.overlays[0].items[0].detail).not.toContain("other/project"); // local rows stay clean
  expect(a.calls.overlays[0].items[1].detail).toContain("other/project"); // foreign rows carry their folder

  const b = mockCtx();
  await runSlashCommand("/resume all", b.ctx);
  expect(b.calls.overlays.length).toBe(1);
  expect(b.calls.overlays[0].title).toBe("Resume session (all projects, newest first)");
  const ids = b.calls.overlays[0].items.map((i: any) => i.id);
  expect(ids).toContain("here-1");
  expect(ids).toContain("away-1"); // "all" is a scope, never a session id
  expect(b.calls.lines).toEqual([]); // and never "no session 'all'"
});

test("resuming a session from another folder states where it was recorded", async () => {
  const a = mockCtx();
  await runSlashCommand("/resume", a.ctx);
  const overlay = a.calls.overlays[0];
  overlay.onSelect(overlay.items.find((i: any) => i.id === "away-1"));
  expect(a.calls.resumed).toEqual(["away-1"]);
  expect(a.calls.lines.join("\n")).toContain("recorded in /some/other/project");
  // A local pick stays quiet.
  const b = mockCtx();
  await runSlashCommand("/resume", b.ctx);
  const ob = b.calls.overlays[0];
  ob.onSelect(ob.items.find((i: any) => i.id === "here-1"));
  expect(b.calls.resumed).toEqual(["here-1"]);
  expect(b.calls.lines).toEqual([]);
});

test("/resume <id> still resumes by id, and an unknown id explains the 'all' scope", async () => {
  const a = mockCtx();
  await runSlashCommand("/resume away-1", a.ctx);
  expect(a.calls.resumed).toEqual(["away-1"]);

  const b = mockCtx();
  await runSlashCommand("/resume nope-404", b.ctx);
  expect(b.calls.resumed).toEqual([]);
  expect(b.calls.lines.join("\n")).toContain("no session 'nope-404'");
  expect(b.calls.lines.join("\n")).toContain("/resume all");
});

test("a denialNote rides along on every gated denial, and the file is untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-denial-note-"));
  try {
    const reg = new ToolRegistry(root, "default", () => false); // headless: the gate can only deny
    reg.denialNote = "(non-interactive run: approval prompts cannot be answered - do NOT retry)";
    const obs = await reg.execute("write_file", { path: "out.md", content: "hello" });
    expect(String(obs)).toContain("Denied by user: write_file");
    expect(String(obs)).toContain("do NOT retry");
    expect(() => readFileSync(join(root, "out.md"), "utf8")).toThrow(); // denial means denied
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
