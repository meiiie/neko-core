import { expect, test } from "bun:test";

import { NekoConfig } from "../src/adapters/config.ts";
import { collectCapabilities, evaluatePolicy, listCommands } from "../src/adapters/registry.ts";

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
  const unconfined = report.findings.find((f) => f.code === "auto_without_live_sandbox");
  expect(unconfined?.message).toContain("UNCONFINED AUTO");
  expect(unconfined?.message).toMatch(/destructive/i);
});

test("policy under explicit --yolo does not claim destructive bash still asks", () => {
  const report = evaluatePolicy(cfg("auto"), { kind: "none", live: false }, true);
  const bounded = report.findings.find((f) => f.code === "bounded_autonomy_on");
  const unconfined = report.findings.find((f) => f.code === "auto_without_live_sandbox");
  expect(bounded?.message).toMatch(/approval prompts are disabled/i);
  expect(unconfined?.message).toContain("UNCONFINED AUTO");
  expect(unconfined?.message).toMatch(/explicit --yolo disables remaining approval prompts/i);
  expect(unconfined?.message).not.toMatch(/still asks once/i);
});

test("policy distinguishes an unavailable sandbox from an unhealthy fail-closed sandbox", () => {
  const unavailable = evaluatePolicy(
    new NekoConfig({ mode: "auto", sandbox: true }, null, {}, ""),
    { kind: "none", live: false },
  );
  expect(unavailable.findings.some((finding) =>
    finding.code === "auto_with_unusable_sandbox"
    && finding.message.includes("FAILS CLOSED")
    && finding.message.includes("no trusted OS sandbox primitive")
  )).toBe(true);
  expect(unavailable.findings.some((finding) => finding.code === "auto_without_live_sandbox")).toBe(false);
  expect(unavailable.findings.some((finding) => finding.message.includes("UNCONFINED AUTO"))).toBe(false);

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

test("policy warns about a missing configured primitive outside auto mode", () => {
  const report = evaluatePolicy(
    new NekoConfig({ mode: "default", sandbox: true }, null, {}, ""),
    { kind: "none", live: false },
  );
  expect(report.findings).toContainEqual(expect.objectContaining({
    code: "sandbox_primitive_unavailable",
    severity: "warn",
    message: expect.stringContaining("FAILS CLOSED"),
  }));
  expect(report.findings.some((finding) => finding.message.includes("UNCONFINED AUTO"))).toBe(false);
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

test("capabilities file_write/shell mirror freer auto (not Claude-tight cwd/approval copy)", () => {
  const autoCaps = collectCapabilities(cfg("auto"));
  const fileWrite = autoCaps.find((c) => c.name === "file_write")!.detail;
  const shell = autoCaps.find((c) => c.name === "shell")!.detail;
  expect(fileWrite).toContain("mode=auto pre-authorizes ordinary outside-project writes");
  expect(fileWrite).not.toMatch(/project plus explicit additional_write_roots/);
  expect(shell).toContain("mode=auto");
  expect(shell).toContain("destructive");
  expect(shell).not.toBe("bash (gated: needs approval)");

  const defaultCaps = collectCapabilities(cfg("default"));
  expect(defaultCaps.find((c) => c.name === "file_write")!.detail).toContain("project plus explicit additional_write_roots");
  expect(defaultCaps.find((c) => c.name === "shell")!.detail).toBe("bash (gated: needs approval)");
});

test("capabilities mark missing local sandbox primitive as blocked Bash", () => {
  const config = new NekoConfig({ mode: "auto", sandbox: true }, null, {}, "");
  const runtime = { kind: "none" as const, live: false };
  for (const explicitYolo of [false, true]) {
    const shell = collectCapabilities(config, explicitYolo, runtime).find((c) => c.name === "shell")!;
    expect(shell.status).toBe("unavailable");
    expect(shell.detail).toContain("FAILS CLOSED");
    expect(shell.detail).toContain("no host fallback");
    expect(shell.detail).not.toContain("approval-free");
  }

  const hostShell = collectCapabilities(new NekoConfig({ mode: "auto", sandbox: false }, null, {}, ""), false, runtime)
    .find((c) => c.name === "shell")!;
  expect(hostShell.status).toBe("enabled");
  expect(hostShell.detail).toContain("ordinary commands without approval");
});
