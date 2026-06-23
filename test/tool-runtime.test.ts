import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ApprovalGate, ToolRegistry } from "../src/core/tool-runtime.ts";
import type { PermissionMode } from "../src/core/permissions.ts";

function makeReg(mode: PermissionMode = "auto", prompt: ApprovalGate = () => true) {
  const root = mkdtempSync(join(tmpdir(), "neko-tr-"));
  return { root, reg: new ToolRegistry(root, mode, prompt) };
}

test("write then read", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("write_file", { path: "a.txt", content: "hi" })).toContain("Wrote");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("hi");
});

test("edit falls back to a whitespace-tolerant line match", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "code.ts"), "function f() {\nconst x = 1;\n}\n"); // file line: no indent
  // old_string has MORE indent than the file -> exact fails, line-trimmed match succeeds.
  const out = await reg.execute("edit", { path: "code.ts", old_string: "    const x = 1;", new_string: "    const x = 2;" });
  expect(out).toContain("Edited");
  expect(await reg.execute("read_file", { path: "code.ts" })).toContain("const x = 2;");
});

test("edit returns a unified diff (context, -removed, +added)", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "f.ts"), "a();\nb();\nc();\nd();\n");
  const out = await reg.execute("edit", { path: "f.ts", old_string: "c();", new_string: "C1();\nC2();" });
  expect(out).toContain("Edited f.ts");
  expect(out).toContain("(+2 -1)");
  expect(out).toMatch(/-\s+3\s+c\(\);/); // removed line 3 (red), with line number
  expect(out).toMatch(/\+\s+3\s+C1\(\);/); // added (green), line-numbered
  expect(out).toMatch(/\s+2\s+b\(\);/); // context line 2 (dim) with its number
});

test("multi_edit applies several edits atomically", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "m.ts"), "let a = 1;\nlet b = 2;\nlet c = 3;\n");
  const out = await reg.execute("multi_edit", {
    path: "m.ts",
    edits: [
      { old_string: "a = 1", new_string: "a = 10" },
      { old_string: "c = 3", new_string: "c = 30" },
    ],
  });
  expect(out).toContain("2 edits");
  const after = await reg.execute("read_file", { path: "m.ts" });
  expect(after).toContain("a = 10");
  expect(after).toContain("c = 30");

  // atomic: a failing edit writes nothing
  writeFileSync(join(root, "n.ts"), "x = 1;\n");
  const fail = await reg.execute("multi_edit", {
    path: "n.ts",
    edits: [{ old_string: "x = 1", new_string: "x = 2" }, { old_string: "NOPE", new_string: "y" }],
  });
  expect(fail).toContain("not found");
  expect(await reg.execute("read_file", { path: "n.ts" })).toContain("x = 1;"); // unchanged
});

test("edit reports an ambiguous whitespace match instead of guessing", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "d.ts"), "a();\na();\n"); // two lines, no indent
  // old_string with extra indent -> exact 0, but trims to match BOTH lines -> refuse.
  expect(await reg.execute("edit", { path: "d.ts", old_string: "    a();", new_string: "b();" })).toContain("matches 2 places");
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

test("task delegates to the subagent callback (and reports when unavailable)", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("task", { description: "x", prompt: "do y" })).toContain("not available");
  reg.subagent = async (prompt) => `sub did: ${prompt}`;
  expect(await reg.execute("task", { description: "x", prompt: "do y" })).toBe("sub did: do y");
});

test("adversarial check blocks an auto-approved mutating tool when it flags unsafe", async () => {
  const { reg } = makeReg("auto", () => true);
  reg.checkAction = async () => ({ ok: false, reason: "looks like exfiltration" });
  expect(await reg.execute("write_file", { path: "x.txt", content: "data" })).toContain("Blocked by adversarial check");
  expect(await reg.execute("read_file", { path: "x.txt" })).not.toContain("adversarial"); // read-only not checked
  reg.checkAction = async () => ({ ok: true, reason: "SAFE" });
  expect(await reg.execute("write_file", { path: "y.txt", content: "ok" })).toContain("Wrote");
});

test("adversarial check also vets auto-approved MCP tools", async () => {
  const { reg } = makeReg("auto", () => true);
  reg.mcp = {
    toolSchemas: () => [],
    has: (n: string) => n === "mcp__x__do",
    call: async () => "ran mcp",
  };
  reg.checkAction = async () => ({ ok: false, reason: "injection" });
  expect(await reg.execute("mcp__x__do", {})).toContain("Blocked by adversarial check");
  reg.checkAction = async () => ({ ok: true, reason: "SAFE" });
  expect(await reg.execute("mcp__x__do", {})).toBe("ran mcp");
});

test("checkpoint/restore reverts this turn's file edits (and deletes new files)", async () => {
  const { root, reg } = makeReg("auto", () => true);
  writeFileSync(join(root, "keep.ts"), "original\n");
  reg.clearCheckpoint();
  await reg.execute("edit", { path: "keep.ts", old_string: "original", new_string: "changed" });
  await reg.execute("write_file", { path: "new.ts", content: "brand new" });
  expect(await reg.execute("read_file", { path: "keep.ts" })).toContain("changed");
  const reverted = reg.restoreCheckpoint();
  expect(reverted).toBe(2);
  expect(await reg.execute("read_file", { path: "keep.ts" })).toContain("original"); // restored
  expect(await reg.execute("read_file", { path: "new.ts" })).toContain("no such file"); // deleted
});

test("task forwards subagent_type to the sub-agent", async () => {
  const { reg } = makeReg("auto", () => true);
  let gotType: string | undefined = "UNSET";
  reg.subagent = async (prompt, type) => { gotType = type; return `ran: ${prompt}`; };
  const out = await reg.execute("task", { description: "x", prompt: "do it", subagent_type: "reviewer" });
  expect(out).toBe("ran: do it");
  expect(gotType).toBe("reviewer");
});

test("bash returns exit code + output", async () => {
  const { reg } = makeReg("auto", () => true);
  const out = await reg.execute("bash", { command: "echo hello" });
  expect(out).toContain("hello");
  expect(out).toContain("exit 0");
});

test("Ctrl+B moves a running bash command to the background", async () => {
  const { reg } = makeReg("auto", () => true);
  const p = reg.execute("bash", { command: 'node -e "setTimeout(function(){},600)"' });
  await new Promise((r) => setTimeout(r, 150));
  expect(reg.detachRunningBash()).toBe(true); // a bash is running -> detached
  const out = await p;
  expect(out).toContain("background");
  expect(reg.backgrounds.length).toBe(1);
  expect(reg.detachRunningBash()).toBe(false); // nothing running now
});

test("catastrophic bash is refused even in auto mode (seatbelt)", async () => {
  const { reg } = makeReg("auto", () => true); // auto would otherwise auto-approve bash
  expect(await reg.execute("bash", { command: "rm -rf /" })).toContain("Refused"); // never runs
  expect(await reg.execute("bash", { command: "rm -rf ~" })).toContain("Refused");
  expect(await reg.execute("bash", { command: "echo hello" })).not.toContain("Refused"); // safe runs
});

test("pre_tool_use hook blocks a tool on non-zero exit, allows on zero", async () => {
  const blocked = makeReg("auto", () => true).reg;
  blocked.hooks = { preToolUse: "exit 3" };
  expect(await blocked.execute("ls", {})).toContain("Blocked by pre_tool_use hook");

  const allowed = makeReg("auto", () => true).reg;
  allowed.hooks = { preToolUse: "exit 0" };
  expect(await allowed.execute("ls", {})).not.toContain("Blocked");
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
