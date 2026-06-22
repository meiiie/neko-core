import { expect, test } from "bun:test";

import { describeToolCall, GATED, resolveTool, SAFE, toOpenAISchema, toolSchemas } from "../src/core/tools.ts";

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
  expect(toolSchemas().map((t: any) => t.function.name)).toEqual([
    "read_file", "search", "glob", "ls", "write_file", "edit", "bash", "todo_write",
    "web_search", "web_fetch", "exit_plan_mode", "task",
  ]);
});

test("resolve unknown throws", () => {
  expect(() => resolveTool("nope")).toThrow();
});

test("permission classes", () => {
  expect(resolveTool("read_file").permission).toBe(SAFE);
  expect(resolveTool("glob").permission).toBe(SAFE);
  expect(resolveTool("write_file").permission).toBe(GATED);
  expect(resolveTool("edit").permission).toBe(GATED);
});
