import { expect, test } from "bun:test";
import { DomainWorkingMemory } from "../src/adapters/domain-memory.ts";
import type { Provider } from "../src/core/ports.ts";

test("task frame preserves original goal, receipts and provider-owned continuation without mutating history", () => {
  const memory = new DomainWorkingMemory();
  const request = "Bật TV; chưa biết volume. À thôi, đừng đổi kênh.";
  memory.start(request);
  memory.observe("<task_note>Đã đổi kênh; chọn volume 30.</task_note>");
  const messages: Parameters<Provider["complete"]>[0] = [
    { role: "system", content: "Host policy" }, { role: "user", content: request },
    { role: "assistant", content: "<task_note>Wrong note</task_note>", provider_data: [{ type: "test", message: { thinking: "opaque continuation" } }] },
  ];
  const before = structuredClone(messages);
  const framed = memory.context(messages, [{ sequence: 1, name: "tv.control", arguments: { action: "on" }, effect: "write", outcome: "failed", observation: "error" }]);
  expect(messages).toEqual(before);
  expect(framed[0].content).toContain(JSON.stringify(request));
  expect(framed[0].content).toContain('"outcome":"failed"');
  expect(framed[2]).toEqual(before[2]);
  expect(framed.filter((m) => m.role === "system")).toHaveLength(1);
  expect(framed[0].content).not.toContain('"semanticSuccess":true');
});

test("a fresh task cannot recall another task's note and an instance cannot switch tasks", () => {
  const a = new DomainWorkingMemory(), b = new DomainWorkingMemory();
  a.start("first"); a.observe("<task_note>person_1</task_note>"); b.start("second");
  expect(b.snapshot().note).toBe("");
  expect(() => a.start("second")).toThrow();
});

test("malformed or excessive notes do not overwrite a usable note or run embedded tool prose", () => {
  const memory = new DomainWorkingMemory(); memory.start("goal");
  expect(memory.observe("<task_note>Need user choice</task_note>")).toBe(true);
  expect(memory.observe("<task_note>unclosed")).toBe(false);
  expect(memory.observe(`<task_note>${"x".repeat(2401)}</task_note>`)).toBe(false);
  expect(memory.observe("<task_note>one</task_note><task_note>two</task_note>")).toBe(false);
  expect(memory.snapshot()).toMatchObject({ note: "Need user choice", revision: 1, rejected: 3 });
  expect(memory.visibleAnswer("<task_note>Need choice</task_note>Which person?")).toBe("Which person?");
});
