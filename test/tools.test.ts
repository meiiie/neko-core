import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeToolCall, GATED, resolveTool, SAFE, toOpenAISchema, toolSchemas } from "../src/core/tools.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("read_file refuses a path that escapes the root THROUGH a symlink (not just lexical ../)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nk-root-"));
  const outside = mkdtempSync(join(tmpdir(), "nk-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
  let linked = false;
  // a 'junction' (dir symlink) needs no admin on Windows; skip if the platform still refuses.
  try { symlinkSync(outside, join(root, "link"), "junction"); linked = true; } catch { /* no symlink perm */ }
  if (!linked) return;
  const tools = new ToolRegistry(root, "auto", () => true);
  const res = String(await tools.execute("read_file", { path: "link/secret.txt" }));
  expect(res).toMatch(/escapes project root/i); // refused
  expect(res).not.toContain("TOPSECRET"); // and never leaked the file
});

test("noTools (perception mode) exposes NO tool schemas — vision-only endpoints reject tool-calling", () => {
  const r = new ToolRegistry(process.cwd(), "auto", () => true);
  expect(r.schemas().length).toBeGreaterThan(0);
  r.noTools = true;
  expect(r.schemas()).toEqual([]);
});

test("computer action validates inputs deterministically (no NaN/garbage reaches PowerShell)", async () => {
  const tools = new ToolRegistry(process.cwd(), "auto", () => true);
  if (process.platform !== "win32") {
    // The computer tool drives Windows UI Automation; elsewhere it must refuse UP FRONT with a clear
    // platform message (not a confusing validation error for a tool that can't run anyway).
    expect(String(await tools.execute("computer", { action: "click" }))).toContain("Windows-only");
    return;
  }
  // These all return BEFORE spawnSync, so no PowerShell runs — pure input validation.
  expect(String(await tools.execute("computer", { action: "click" }))).toContain("numeric");
  expect(String(await tools.execute("computer", { action: "click", x: "abc", y: 5 }))).toContain("numeric");
  expect(String(await tools.execute("computer", { action: "stroke", points: [1, 2, "x", 4] }))).toContain("NUMBERS");
  expect(String(await tools.execute("computer", { action: "invoke" }))).toContain("needs 'name'");
  expect(String(await tools.execute("computer", { action: "type" }))).toContain("needs non-empty 'text'");
  expect(String(await tools.execute("computer", { action: "key" }))).toContain("needs 'keys'");
  expect(String(await tools.execute("computer", { action: "scroll", direction: "sideways" }))).toContain("up | down | left | right");
  expect(String(await tools.execute("computer", { action: "scroll", direction: "down", amount: 11 }))).toContain("integer from 1 to 10");
  expect(String(await tools.execute("computer", { action: "wait", duration_ms: -1 }))).toContain("0 to 10000");
  expect(String(await tools.execute("computer", { action: "open" }))).toContain("needs 'target'");
  expect(String(await tools.execute("computer", { action: "bogus" }))).toContain("Unknown computer action");
  expect(String(await tools.execute("computer", { action: "wait", duration_ms: 1 }))).toContain("waited 1 ms");
});

test("describeToolCall uses Claude-style labels + primary arg", () => {
  expect(describeToolCall("read_file", { path: "src/a.ts" })).toBe("Read(src/a.ts)");
  expect(describeToolCall("edit", { path: "a.ts" })).toBe("Update(a.ts)");
  expect(describeToolCall("bash", { command: "bun test" })).toBe("Bash(bun test)");
  expect(describeToolCall("ls", {})).toBe("List");
  expect(describeToolCall("todo_write", { todos: [] })).toBe("Update Todos");
  expect(describeToolCall("web_search", { query: "x" })).toBe("WebSearch(x)");
  expect(describeToolCall("web_fetch", { url: "http://x.io" })).toBe("Fetch(http://x.io)");
});

test("schema shape", () => {
  const s = toOpenAISchema(resolveTool("read_file"));
  expect(s.type).toBe("function");
  expect(s.function.name).toBe("read_file");
  expect(s.function.parameters.required).toEqual(["path"]);
});

test("tool order", () => {
  const expected = [
    "read_file", "search", "glob", "ls", "write_file", "edit", "multi_edit", "bash", "computer", "todo_write",
    "web_search", "web_fetch", "exit_plan_mode", "task", "memory", "skill", "workflow", "playbook",
  ];
  if (process.platform !== "win32") expected.splice(expected.indexOf("computer"), 1);
  expect(toolSchemas().map((t: any) => t.function.name)).toEqual(expected);
});

test("tool schemas hide Windows-only computer control on other platforms", () => {
  expect(toolSchemas("linux").map((t: any) => t.function.name)).not.toContain("computer");
  expect(toolSchemas("win32").map((t: any) => t.function.name)).toContain("computer");
});

test("resolve unknown throws", () => {
  expect(() => resolveTool("nope")).toThrow();
});

test("permission classes", () => {
  expect(resolveTool("read_file").permission).toBe(SAFE);
  expect(resolveTool("glob").permission).toBe(SAFE);
  expect(resolveTool("write_file").permission).toBe(GATED);
  expect(resolveTool("edit").permission).toBe(GATED);
  expect(resolveTool("computer").permission).toBe(GATED);
});
