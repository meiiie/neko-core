import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { evaluatePolicy, listCommands } from "../src/adapters/registry.ts";

function cfg(mode = "default") {
  return new NekoConfig({ mode }, null, {}, "");
}

test("policy passes for the default registries", () => {
  expect(evaluatePolicy(cfg()).verdict).toBe("pass");
});

test("policy warns on auto mode (bounded autonomy)", () => {
  const report = evaluatePolicy(cfg("auto"), { kind: "none", live: false });
  expect(report.verdict).toBe("warn");
  expect(report.findings.some((f) => f.code === "bounded_autonomy_on")).toBe(true);
  expect(report.findings.some((f) => f.code === "auto_without_live_sandbox" && f.message.includes("UNCONFINED AUTO"))).toBe(true);
});

test("policy distinguishes an unavailable sandbox from an unhealthy fail-closed sandbox", () => {
  const unavailable = evaluatePolicy(
    new NekoConfig({ mode: "auto", sandbox: true }, null, {}, ""),
    { kind: "none", live: false },
  );
  expect(unavailable.findings.some((finding) =>
    finding.code === "auto_without_live_sandbox" && finding.message.includes("UNCONFINED AUTO")
  )).toBe(true);

  const unhealthy = evaluatePolicy(
    new NekoConfig({ mode: "auto", sandbox: true }, null, {}, ""),
    { kind: "srt", live: false },
  );
  expect(unhealthy.findings.some((finding) =>
    finding.code === "auto_with_unusable_sandbox" && finding.message.includes("FAILS CLOSED")
  )).toBe(true);
  expect(unhealthy.findings.some((finding) => finding.message.includes("UNCONFINED AUTO"))).toBe(false);

  const transient = evaluatePolicy(
    new NekoConfig({ mode: "auto", sandbox: true }, null, {}, ""),
    { kind: "srt", live: false, detail: "code=ETIMEDOUT timeout=true elapsed_ms=20060" },
  );
  expect(transient.findings.some((finding) => finding.code === "auto_srt_probe_timed_out")).toBe(true);
  expect(transient.findings.some((finding) => finding.code === "auto_with_unusable_sandbox")).toBe(false);
  expect(transient.findings.some((finding) => finding.message.includes("UNCONFINED AUTO"))).toBe(false);
});

test("command registry covers every canonical public CLI dispatch", () => {
  const names = new Set(listCommands().map((command) => command.name));
  const dispatched = [
    "chat", "resume", "run", "acp", "oracle", "bench",
    "config", "doctor", "profiles", "init-user", "init", "login", "logout", "update",
    "tools", "agents", "commands", "capabilities", "policy", "trust", "handoff", "context",
    "sessions", "skills", "procurement", "recipes", "mcp", "support", "browser", "meeting", "setup",
    "version", "help",
  ];
  expect([...names].sort()).toEqual([...dispatched].sort());
});
