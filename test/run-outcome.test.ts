import { expect, test } from "bun:test";

import { headlessRunOutcome } from "../src/adapters/run-outcome.ts";

test("headless run exits nonzero on unresolved validation while preserving an actionable warning", () => {
  const failedStatus = {
    ok: false,
    reason: "validation_failed" as const,
    command: "rtk bun test",
    detail: "(exit 1 -- command FAILED)",
  };
  const failed = headlessRunOutcome(true, failedStatus);
  expect(failed.exitCode).toBe(1);
  expect(failed.warning).toContain("run incomplete");
  expect(failed.warning).toContain("rtk bun test");

  expect(headlessRunOutcome(true, { ok: true })).toEqual({ exitCode: 0 });
  const denied = headlessRunOutcome(true, { ok: true }, 2);
  expect(denied.exitCode).toBe(1);
  expect(denied.warning).toContain("2 gated tool calls were auto-denied");
  const deniedAndUnverified = headlessRunOutcome(true, failedStatus, 1);
  expect(deniedAndUnverified.warning?.match(/\[neko\]/g)).toHaveLength(1);
  expect(headlessRunOutcome(false, { ok: false, reason: "validation_missing" })).toEqual({ exitCode: 0 });
});
