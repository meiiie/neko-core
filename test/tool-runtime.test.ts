import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ApprovalGate, ToolRegistry } from "../src/tool-runtime.ts";
import type { PermissionMode } from "../src/permissions.ts";

function makeReg(mode: PermissionMode = "auto", prompt: ApprovalGate = () => true) {
  const root = mkdtempSync(join(tmpdir(), "neko-tr-"));
  return { root, reg: new ToolRegistry(root, mode, prompt) };
}

test("write then read", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("write_file", { path: "a.txt", content: "hi" })).toContain("Wrote");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("hi");
});

test("read missing", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("read_file", { path: "x" })).toContain("no such file");
});

test("search", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
  expect(await reg.execute("search", { pattern: "beta" })).toContain("a.txt:2");
});

test("glob + ls", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.ts"), "x");
  expect(await reg.execute("glob", { pattern: "**/*.ts" })).toContain("a.ts");
  expect(await reg.execute("ls", {})).toContain("a.ts");
});

test("edit unique / not found / ambiguous", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.ts"), "const x = 1;\nconst x2 = 1;\n");
  expect(await reg.execute("edit", { path: "a.ts", old_string: "x2", new_string: "y2" })).toContain("Edited");
  expect(await reg.execute("edit", { path: "a.ts", old_string: "zzz", new_string: "q" })).toContain("not found");
  expect(await reg.execute("edit", { path: "a.ts", old_string: "const ", new_string: "let " })).toContain("times");
});

test("path escape refused", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("read_file", { path: "../x" })).toContain("escapes project root");
});

test("missing required arg", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("read_file", {})).toContain("missing required argument");
});

test("unknown tool", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("frobnicate", {})).toContain("Unknown tool");
});

test("plan blocks writes, allows reads", async () => {
  const { root, reg } = makeReg("plan", () => false);
  writeFileSync(join(root, "a.txt"), "yo");
  expect(await reg.execute("write_file", { path: "b.txt", content: "x" })).toContain("plan");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("yo");
});

test("default + deny gate denies gated, allows safe", async () => {
  const { root, reg } = makeReg("default", () => false);
  writeFileSync(join(root, "a.txt"), "yo");
  expect(await reg.execute("write_file", { path: "b.txt", content: "x" })).toContain("Denied");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("yo");
});

test("accept-edits auto-approves edits but prompts bash", async () => {
  const { reg } = makeReg("accept-edits", () => false);
  expect(await reg.execute("write_file", { path: "b.txt", content: "x" })).toContain("Wrote");
  expect(await reg.execute("bash", { command: "echo no" })).toContain("Denied");
});

test("disabled tool is hidden from schemas and blocked on execute", async () => {
  const { reg } = makeReg();
  reg.disabled.add("bash");
  expect(reg.schemas().map((s: any) => s.function.name)).not.toContain("bash");
  expect(await reg.execute("bash", { command: "echo hi" })).toContain("disabled");
});

test("todo_write records the list on the registry and renders a checklist", async () => {
  const { reg } = makeReg();
  const out = await reg.execute("todo_write", {
    todos: [{ content: "scan", status: "completed" }, { content: "fix", status: "in_progress" }],
  });
  expect(out).toContain("[x] scan");
  expect(out).toContain("[~] fix");
  expect(reg.todos.length).toBe(2);
});
