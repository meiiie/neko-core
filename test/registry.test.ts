import { expect, test } from "bun:test";

import { NekoConfig } from "../src/config.ts";
import { evaluatePolicy } from "../src/registry.ts";

function cfg(mode = "default") {
  return new NekoConfig({ mode }, null, {}, "");
}

test("policy passes for the default registries", () => {
  expect(evaluatePolicy(cfg()).verdict).toBe("pass");
});

test("policy warns on auto mode (bounded autonomy)", () => {
  const report = evaluatePolicy(cfg("auto"));
  expect(report.verdict).toBe("warn");
  expect(report.findings.some((f) => f.code === "bounded_autonomy_on")).toBe(true);
});
