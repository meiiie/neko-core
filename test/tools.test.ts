import { expect, test } from "bun:test";

import { GATED, resolveTool, SAFE, toOpenAISchema, toolSchemas } from "../src/tools.ts";

test("schema shape", () => {
  const s = toOpenAISchema(resolveTool("read_file"));
  expect(s.type).toBe("function");
  expect(s.function.name).toBe("read_file");
  expect(s.function.parameters.required).toEqual(["path"]);
});

test("tool order", () => {
  expect(toolSchemas().map((t: any) => t.function.name)).toEqual([
    "read_file", "search", "glob", "ls", "write_file", "edit", "bash", "todo_write",
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
