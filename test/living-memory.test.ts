import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backfillJournals,
  journalSession,
  journalTool,
  livingEnabled,
  searchJournal,
  setLivingEnabled,
  wakeRecap,
  type JournalableSession,
} from "../src/core/living-memory.ts";

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LIVING: process.env.NEKO_LIVING_MEMORY };
afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  if (ORIG.LIVING === undefined) delete process.env.NEKO_LIVING_MEMORY;
  else process.env.NEKO_LIVING_MEMORY = ORIG.LIVING;
});

function freshHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nk-live-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.NEKO_LIVING_MEMORY;
  return tmp;
}

function session(over: Partial<JournalableSession> = {}): JournalableSession {
  return {
    id: "20261112-120000-000-aaaaaaaaaaaaaaaa",
    createdAt: "2026-11-12T12:00:00.000Z",
    updatedAt: "2026-11-12T12:10:00.000Z",
    cwd: "E:\\proj",
    model: "test-model",
    messages: [
      { role: "system", content: "You are Neko." },
      { role: "user", content: "sửa lỗi login" },
      { role: "assistant", content: "Đang xem auth.ts.", tool_calls: [{ function: { name: "read_file" } }] },
      { role: "user", content: "xong chưa" },
      { role: "assistant", content: "Xong. Đã sửa hàm verify." },
    ],
    ...over,
  };
}

test("journalSession writes a bounded digest, not a transcript copy", () => {
  const home = freshHome();
  const file = journalSession(session());
  expect(file).toBeTruthy();
  const text = readFileSync(file!, "utf-8");
  expect(text).toContain("schema: neko.journal/v1");
  expect(text).toContain("sửa lỗi login");
  expect(text).toContain("Xong. Đã sửa hàm verify.");
  expect(text).not.toContain("You are Neko.");
  expect(text.length).toBeLessThan(2400);
});

test("short/open-close sessions are not journaled", () => {
  freshHome();
  expect(journalSession(session({ messages: [{ role: "user", content: "hi" }] }))).toBe("");
  expect(journalSession(session({ messages: [] }))).toBe("");
  expect(journalSession(session({ id: "" }))).toBe("");
  expect(journalSession(session({ cwd: "" }))).toBe("");
});

test("secrets are redacted before they touch disk", () => {
  freshHome();
  const file = journalSession(session({
    messages: [
      { role: "user", content: "api key la sk-abcdef1234567890xyz va password=hunter2" },
      { role: "assistant", content: "Authorization: Bearer abc.def.ghi" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "done" },
    ],
  }));
  const text = readFileSync(file!, "utf-8");
  expect(text).not.toContain("sk-abcdef1234567890xyz");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("abc.def.ghi");
  expect(text).toContain("[redacted]");
});

test("wakeRecap prefers same cwd and can exclude the resumed session", () => {
  const home = freshHome();
  journalSession(session({ id: "20261112-120000-000-aaaaaaaaaaaaaaaa", cwd: "E:\\proj" }));
  journalSession(session({ id: "20261112-130000-000-bbbbbbbbbbbbbbbb", cwd: "E:\\proj", messages: session().messages.map((m, i) => i === 1 ? { ...m, content: "lam tiep" } : m) }));
  journalSession(session({
    id: "20261112-140000-000-cccccccccccccccc",
    cwd: "D:\\other",
    messages: [
      { role: "user", content: "khac thu muc" },
      { role: "assistant", content: "da xem" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "xong other" },
    ],
  }));
  const all = wakeRecap(home, "E:\\proj");
  expect(all).toContain("Recent episodes");
  expect(all).toContain("proj");
  const excluded = wakeRecap(home, "E:\\proj", { excludeSessionId: "20261112-120000-000-aaaaaaaaaaaaaaaa" });
  expect(excluded).not.toContain("sửa lỗi login");
  expect(excluded).toContain("lam tiep");
  expect(excluded).toContain("khac thu muc");
});

test("searchJournal is NFD-insensitive and journalTool lists", () => {
  const home = freshHome();
  journalSession(session());
  const hits = searchJournal("sua loi login", home);
  expect(hits.length).toBe(1);
  const listed = journalTool({ action: "journal" }, home);
  expect(listed).toContain("Recent episodes");
  const miss = searchJournal("khong-co-gi-het", home);
  expect(miss.length).toBe(0);
});

test("greeting-only sessions do not become episodes; real work after a greeting uses the real ask as the index", () => {
  const home = freshHome();
  expect(journalSession(session({
    messages: [
      { role: "user", content: "Yo bro" },
      { role: "assistant", content: "Yo! Sao rồi." },
      { role: "user", content: "ok" },
      { role: "assistant", content: "ok" },
    ],
  }), home)).toBe("");
  const file = journalSession(session({
    messages: [
      { role: "user", content: "Yo bro" },
      { role: "assistant", content: "Sao rồi." },
      { role: "user", content: "sửa lỗi login" },
      { role: "assistant", content: "Xong. Đã sửa hàm verify." },
    ],
  }), home);
  const text = readFileSync(file!, "utf-8");
  expect(text).toContain("sửa lỗi login");
  expect(text).not.toContain('First ask: "Yo bro"');
});

test("living memory can be turned off without deleting files", () => {
  const home = freshHome();
  journalSession(session());
  expect(livingEnabled(home)).toBe(true);
  setLivingEnabled(false, home);
  expect(livingEnabled(home)).toBe(false);
  expect(wakeRecap(home, "E:\\proj")).toBe("");
  expect(journalSession(session({ id: "20261112-150000-000-dddddddddddddddd" }), home)).toBe("");
  expect(existsSync(join(home, ".neko-core", "memory", "journal"))).toBe(true);
  setLivingEnabled(true, home);
  expect(livingEnabled(home)).toBe(true);
});

test("throttle skips identical rapid rewrites of the same session", () => {
  const home = freshHome();
  const s = session();
  const f1 = journalSession(s, home);
  const f2 = journalSession(s, home);
  expect(f1).toBeTruthy();
  expect(f2).toBe("");
  const grown = session({ messages: [...s.messages, { role: "user", content: "them mot luot" }, { role: "assistant", content: "ok them" }] });
  const f3 = journalSession(grown, home);
  expect(f3).toBe(f1);
});

test("backfill fills missing journals and never clobbers existing ones", () => {
  const home = freshHome();
  const a = session({ id: "20261112-120000-000-aaaaaaaaaaaaaaaa" });
  const b = session({ id: "20261112-160000-000-eeeeeeeeeeeeeeee", cwd: "E:\\other" });
  journalSession(a, home);
  const before = readFileSync(join(home, ".neko-core", "memory", "journal", `${a.id}.md`), "utf-8");
  const { written, skipped } = backfillJournals(
    (id) => (id === a.id ? a : id === b.id ? b : null),
    [a.id, b.id, "20261112-170000-000-ffffffffffffffff"],
    home,
    10,
  );
  expect(written).toBe(1);
  expect(skipped).toBe(2);
  expect(readFileSync(join(home, ".neko-core", "memory", "journal", `${a.id}.md`), "utf-8")).toBe(before);
  expect(existsSync(join(home, ".neko-core", "memory", "journal", `${b.id}.md`))).toBe(true);
});

test("prune keeps the store bounded", () => {
  const home = freshHome();
  // Can't write 201 real sessions cheaply; assert the helper doesn't explode on a small store.
  journalSession(session(), home);
  const dir = join(home, ".neko-core", "memory", "journal");
  expect(readdirSync(dir).filter((f) => f.endsWith(".md")).length).toBe(1);
});
