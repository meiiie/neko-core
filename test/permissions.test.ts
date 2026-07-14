import { expect, test } from "bun:test";

import { decide, nextMode } from "../src/core/permissions.ts";
import { resolveTool } from "../src/core/tools.ts";

const read = resolveTool("read_file");
const write = resolveTool("write_file");
const edit = resolveTool("edit");
const multiEdit = resolveTool("multi_edit");
const bash = resolveTool("bash");
const memory = resolveTool("memory");

test("safe tools always allowed", () => {
  for (const m of ["default", "accept-edits", "plan", "auto"] as const) {
    expect(decide(m, read)).toBe("allow");
  }
});

test("auto allows gated", () => {
  expect(decide("auto", write)).toBe("allow");
  expect(decide("auto", bash)).toBe("allow");
});

test("plan denies gated", () => {
  expect(decide("plan", write)).toBe("deny");
  expect(decide("plan", bash)).toBe("deny");
});

test("accept-edits: edits allow, bash prompts", () => {
  expect(decide("accept-edits", write)).toBe("allow");
  expect(decide("accept-edits", edit)).toBe("allow");
  expect(decide("accept-edits", multiEdit)).toBe("allow");
  expect(decide("accept-edits", bash)).toBe("prompt");
});

test("action-sensitive tools gate only their mutating actions", () => {
  expect(decide("plan", memory, { action: "read" })).toBe("allow");
  expect(decide("plan", memory, { action: "search" })).toBe("allow");
  expect(decide("plan", memory, { action: "write" })).toBe("deny");
  expect(decide("default", memory, { action: "delete" })).toBe("prompt");
  expect(decide("default", memory, { action: "append" })).toBe("prompt");
  expect(decide("auto", memory, { action: "write" })).toBe("allow");
});

test("default prompts gated", () => {
  expect(decide("default", write)).toBe("prompt");
});

test("nextMode cycles default -> accept-edits -> plan -> auto -> default", () => {
  expect(nextMode("default")).toBe("accept-edits");
  expect(nextMode("accept-edits")).toBe("plan");
  expect(nextMode("plan")).toBe("auto");
  expect(nextMode("auto")).toBe("default");
});
