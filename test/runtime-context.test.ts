import { expect, test } from "bun:test";

import { skillsContextBlock } from "../src/adapters/skills.ts";
import { dynamicToolRuntimeBlock } from "../src/adapters/tool-registry.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

function registry(mode: "default" | "accept-edits" | "plan" | "auto" = "default"): ToolRegistry {
  const value = new ToolRegistry(process.cwd(), mode, () => true);
  value.loadSkill = () => null;
  value.sandboxBash = false;
  return value;
}

test("runtime block makes Neko mode and provider-native separation authoritative", () => {
  const value = registry("auto");
  const block = dynamicToolRuntimeBlock(value);

  expect(block).toStartWith("# NEKO DYNAMIC-TOOL RUNTIME\n");
  expect(block).toContain("Effective Neko permission mode: auto (yolo)");
  expect(block).toContain("host computer control still requires explicit consent");
  expect(block).toContain("Provider-native shell, apply_patch/edit, approvals, sandbox, and skills are a separate transport runtime");
  expect(block).toContain("Neko bash dynamic tool: callable");
  expect(block).toContain("sandbox=off (host/unconfined)");
  expect(block).toMatch(/shell=(?:GIT BASH \(POSIX\)|cmd\.exe|\/bin\/sh \(POSIX\))/);
  expect(block).not.toMatch(/[^\x00-\x7f]/);
});

test("runtime block follows live Neko mode and exposed tool surface", () => {
  const value = registry();
  expect(dynamicToolRuntimeBlock(value)).toContain("gated Neko actions, including bash, require user approval");

  value.mode = "plan";
  value.disabled.add("bash");
  value.disabled.add("skill");
  const block = dynamicToolRuntimeBlock(value);
  expect(block).toContain("Effective Neko permission mode: plan");
  expect(block).toContain("Neko bash dynamic tool: unavailable");
  expect(block).toContain("Neko skill dynamic tool: unavailable");
});

test("runtime block explains the exact target and validator-only bash lease", () => {
  const value = registry("auto");
  const lease = value.enterTurn({
    name: "exact-file-edit",
    allowedTools: ["read_file", "edit", "bash"],
    allowBackgroundBash: false,
    editTarget: "package.json",
    bashPolicy: "foreground-validator-only",
  });
  try {
    const block = dynamicToolRuntimeBlock(value);
    expect(block).toContain('Active exact-file turn: edit target="package.json"');
    expect(block).toContain("exactly one byte-for-byte old_string match");
    expect(block).toContain("Bash is foreground validator-only");
    expect(block).toContain("isolated read-only project workspace");
    expect(block).toContain("Build targets, fix/write/update flags");
    expect(block).toContain("exact-turn bash FAILS CLOSED; no host fallback");
    expect(block).not.toContain("UNCONFINED AUTO");
    expect(block).toContain("Do not use bash for pwd, echo, search, file reads, or mutation");
  } finally {
    lease.close();
  }
});

test("runtime block says unhealthy SRT fails closed without a host fallback", () => {
  const value = registry("auto");
  value.sandboxBash = true;
  value.sandboxAutoApprove = true;

  const block = dynamicToolRuntimeBlock(value, { kind: "srt", live: false });

  expect(block).toContain("FAILS CLOSED");
  expect(block).toContain("no host fallback");
  expect(block).toContain("re-checks SRT health");
  expect(block).toContain("Do not create a shell script");
  expect(block).not.toContain("host/unconfined");
  expect(block).not.toContain("UNCONFINED AUTO");
});

test("runtime block calls disabled or unavailable sandbox unconfined in auto mode", () => {
  const disabled = dynamicToolRuntimeBlock(registry("auto"));
  expect(disabled).toContain("UNCONFINED AUTO");

  const unavailableRegistry = registry("auto");
  unavailableRegistry.sandboxBash = true;
  const unavailable = dynamicToolRuntimeBlock(unavailableRegistry, { kind: "none", live: false });
  expect(unavailable).toContain("UNCONFINED AUTO");
  expect(unavailable).toContain("requested but unavailable (host/unconfined)");
  expect(unavailable).not.toContain("FAILS CLOSED");
});

test("Neko skill catalog is absent when the Neko skill tool is not callable", () => {
  const value = registry();
  expect(skillsContextBlock(value)).toContain("# NEKO SKILL CATALOG");

  value.disabled.add("skill");
  expect(skillsContextBlock(value)).toBe("");
  value.disabled.delete("skill");
  value.noTools = true;
  expect(skillsContextBlock(value)).toBe("");

  const unwired = new ToolRegistry(process.cwd(), "default", () => true);
  expect(skillsContextBlock(unwired)).toBe("");

  const readOnly = registry();
  readOnly.allowOnlyTools(["read_file", "search"]);
  expect(skillsContextBlock(readOnly)).toBe("");
  expect(dynamicToolRuntimeBlock(readOnly)).toContain("Neko bash dynamic tool: unavailable");
});
