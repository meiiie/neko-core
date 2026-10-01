import { expect, test } from "bun:test";
import { cliProviderRetryStatus } from "../src/adapters/cli-provider-status.ts";

test("CLI retry status is visible without leaking reasoning or response bodies", () => {
  expect(cliProviderRetryStatus({ type: "retry_scheduled", attempt: 1, reason: "transport_unavailable", delayMs: 1500 }))
    .toBe("[provider: connection unavailable after attempt 1; retrying in 2s]");
  expect(cliProviderRetryStatus({ type: "retry_scheduled", attempt: 2, reason: "rate_limited", delayMs: 0 }))
    .toBe("[provider: rate limited after attempt 2; retrying in 0s]");
});

test("ordinary successful attempts do not add CLI noise", () => {
  expect(cliProviderRetryStatus({ type: "attempt_started", attempt: 1 })).toBeNull();
});

test("missing or invalid numeric retry metadata remains readable", () => {
  expect(cliProviderRetryStatus({ type: "retry_scheduled", attempt: NaN, delayMs: Infinity }))
    .toBe("[provider: request interrupted; retrying]");
  expect(cliProviderRetryStatus({ type: "retry_scheduled", attempt: -1, delayMs: -1 }))
    .toBe("[provider: request interrupted; retrying]");
});
