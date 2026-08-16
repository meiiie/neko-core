import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHandoffStore } from "../src/adapters/session-handoff.ts";
import { loadSession, newSessionId, saveSession, setSessionsDir } from "../src/adapters/session.ts";

const ROOT = mkdtempSync(join(tmpdir(), "neko-handoff-store-"));
const TEST_HOME = join(ROOT, "home");
const SESSIONS = join(ROOT, "sessions");
const PENDING = join(TEST_HOME, ".neko-core", "handoffs", "v1", "pending");

beforeAll(() => setSessionsDir(SESSIONS));
function resetStores(): void {
  rmSync(SESSIONS, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".neko-core"), { recursive: true, force: true });
  mkdirSync(SESSIONS, { recursive: true });
  mkdirSync(TEST_HOME, { recursive: true });
}

beforeEach(resetStores);
afterAll(() => {
  setSessionsDir(null);
  rmSync(ROOT, { recursive: true, force: true });
});

function session(label: string, cwd = join(ROOT, label), message = `private transcript ${label}`): string {
  if (cwd.length < 240 && !/[\u0000-\u001f\u007f-\u009f]/.test(cwd)) mkdirSync(cwd, { recursive: true });
  const id = newSessionId();
  saveSession({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: "",
    cwd,
    model: "test-model",
    messages: [{ role: "user", content: message }],
  });
  return id;
}

test("send writes an immutable summary-only envelope and listPending does not consume it", () => {
  const source = session("source", undefined, "SOURCE_TRANSCRIPT_MUST_NOT_LEAK");
  const target = session("target", undefined, "TARGET_TRANSCRIPT_MUST_NOT_LEAK");
  const store = new SessionHandoffStore(TEST_HOME);
  const sent = store.send(source, target, "Done:\n- parser fixed\n- tests pass");
  const path = join(PENDING, `${sent.id}.json`);
  const raw = readFileSync(path, "utf8");
  const stored = JSON.parse(raw);

  expect(Object.keys(stored).sort()).toEqual([
    "createdAt", "id", "kind", "provenance", "schema", "source", "summary", "targetSessionId",
  ]);
  expect(stored).toEqual(sent);
  expect(stored.schema).toBe("neko.session-handoff/v1");
  expect(stored.kind).toBe("summary");
  expect(stored.source).toMatchObject({ sessionId: source, model: "test-model", messageCount: 1 });
  expect(stored.provenance).toBe("local-unverified");
  expect(raw).not.toContain("SOURCE_TRANSCRIPT_MUST_NOT_LEAK");
  expect(raw).not.toContain("TARGET_TRANSCRIPT_MUST_NOT_LEAK");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);

  const first = store.listPending(target);
  const second = store.listPending(target);
  expect(first).toEqual({ items: [sent], rejected: [], truncated: false });
  expect(second).toEqual(first);
  expect(existsSync(path)).toBe(true);
});

test("send validates both saved sessions and bounds summary bytes", () => {
  const source = session("source-validation");
  const target = session("target-validation");
  const store = new SessionHandoffStore(TEST_HOME);

  expect(() => store.send("../escape", target, "summary")).toThrow("Invalid source session ID");
  expect(() => store.send(newSessionId(), target, "summary")).toThrow("Source session is unavailable");
  expect(() => store.send(source, newSessionId(), "summary")).toThrow("Target session is unavailable");
  expect(() => store.send(source, source, "summary")).toThrow("must differ");
  expect(() => store.send(source, target, "  ")).toThrow("summary is required");
  expect(() => store.send(source, target, "terminal\u001b[31m injection")).toThrow("unsafe control");
  expect(() => store.send(source, target, "e".repeat(16 * 1024 + 1))).toThrow("exceeds 16 KiB");
  expect(() => store.send(source, target, "é".repeat(8193))).toThrow("exceeds 16 KiB");
  expect(store.send(source, target, "e".repeat(16 * 1024)).summary.length).toBe(16 * 1024);
});

test("send rejects unsafe derived metadata and an oversized envelope", () => {
  const target = session("target-metadata");
  expect(() => session("unsafe-metadata", "bad\ncwd")).toThrow("Invalid session");
  const huge = session("huge-metadata", "x".repeat(65 * 1024));
  const store = new SessionHandoffStore(TEST_HOME);

  expect(() => store.send(huge, target, "summary")).toThrow("envelope exceeds 64 KiB");
});

test("listPending returns only the requested recipient's envelopes", () => {
  const source = session("source-filter");
  const targetA = session("target-a");
  const targetB = session("target-b");
  const store = new SessionHandoffStore(TEST_HOME);
  const forA = store.send(source, targetA, "for A");
  store.send(source, targetB, "for B");

  expect(store.listPending(targetA)).toEqual({ items: [forA], rejected: [], truncated: false });
  expect(() => store.listPending("../escape")).toThrow("Invalid target session ID");
  expect(() => store.listPending(newSessionId())).toThrow("Target session is unavailable");
});

test("listPending reports non-files, bad names, oversize, UTF-8, JSON, and schema failures", () => {
  const source = session("source-rejections");
  const target = session("target-rejections");
  const store = new SessionHandoffStore(TEST_HOME);
  const valid = store.send(source, target, "valid");

  mkdirSync(join(PENDING, `${randomUUID()}.json`));
  writeFileSync(join(PENDING, "bad-name.txt"), "{}");
  writeFileSync(join(PENDING, "unrecognized.tmp"), "{}");
  writeFileSync(join(PENDING, `${randomUUID()}.json`), Buffer.alloc(64 * 1024 + 1));
  writeFileSync(join(PENDING, `${randomUUID()}.json`), Buffer.from([0xc3, 0x28]));
  writeFileSync(join(PENDING, `${randomUUID()}.json`), "not json");
  const mismatchedId = randomUUID();
  writeFileSync(join(PENDING, `${mismatchedId}.json`), JSON.stringify(valid));
  const extraFieldId = randomUUID();
  writeFileSync(join(PENDING, `${extraFieldId}.json`), JSON.stringify({ ...valid, id: extraFieldId, transcript: [] }));
  writeFileSync(join(PENDING, `${randomUUID()}.json.${randomUUID()}.tmp`), "partial temp");

  let symlinkCreated = false;
  try {
    symlinkSync(join(PENDING, `${valid.id}.json`), join(PENDING, `${randomUUID()}.json`));
    symlinkCreated = true;
  } catch { /* Creating symlinks may require Windows Developer Mode. */ }

  const result = store.listPending(target);
  const reasons = result.rejected.map((item) => item.reason);
  expect(result.items).toEqual([valid]);
  expect(reasons).toContain("not-regular-file");
  expect(reasons.filter((reason) => reason === "invalid-file-name").length).toBe(2);
  expect(reasons).toContain("envelope-too-large");
  expect(reasons).toContain("invalid-utf8");
  expect(reasons).toContain("invalid-json");
  expect(reasons.filter((reason) => reason === "invalid-envelope").length).toBe(2);
  if (symlinkCreated) expect(reasons.filter((reason) => reason === "not-regular-file").length).toBe(2);
  expect(result.truncated).toBe(false);
});

test("pending summaries remain self-contained when their source session changes or disappears", () => {
  const source = session("source-tamper");
  const target = session("target-tamper");
  const store = new SessionHandoffStore(TEST_HOME);
  const missingSource = store.send(source, target, "source later removed");
  rmSync(join(SESSIONS, `${source}.json`));
  expect(store.listPending(target)).toEqual({ items: [missingSource], rejected: [], truncated: false });

  resetStores();
  const source2 = session("source-tamper-2");
  const target2 = session("target-tamper-2");
  const snapshot = store.send(source2, target2, "metadata is a send-time snapshot");
  const changed = loadSession(source2)!;
  changed.cwd = join(ROOT, "source-moved");
  mkdirSync(changed.cwd, { recursive: true });
  saveSession(changed);
  expect(store.listPending(target2)).toEqual({ items: [snapshot], rejected: [], truncated: false });
});

test("immutable publication never overwrites an existing destination", () => {
  const source = session("source-immutable");
  const target = session("target-immutable");
  const store = new SessionHandoffStore(TEST_HOME);
  const sent = store.send(source, target, "original");
  const path = join(PENDING, `${sent.id}.json`);
  const sentinel = readFileSync(path, "utf8");
  // SAFETY: the test deliberately drives the store's private immutable-write path to prove it refuses.
  const internals = store as any;

  expect(() => internals.writeImmutable(path, "replacement")).toThrow();
  expect(readFileSync(path, "utf8")).toBe(sentinel);
});

test("listPending caps spool work and reports truncation", () => {
  const target = session("target-budget");
  mkdirSync(PENDING, { recursive: true });
  for (let index = 0; index < 1025; index++) writeFileSync(join(PENDING, `invalid-${index}.txt`), "{}");

  const result = new SessionHandoffStore(TEST_HOME).listPending(target);
  expect(result.items).toEqual([]);
  expect(result.rejected.length).toBe(1024);
  expect(result.truncated).toBe(true);
});

test("send rejects a handoff store redirected through a symlink or junction", () => {
  const source = session("source-symlink");
  const target = session("target-symlink");
  const outside = join(ROOT, "outside-handoff-store");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(TEST_HOME, ".neko-core"), process.platform === "win32" ? "junction" : "dir");

  expect(() => new SessionHandoffStore(TEST_HOME).send(source, target, "do not redirect")).toThrow("Unsafe handoff directory");
});
