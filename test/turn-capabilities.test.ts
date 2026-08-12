import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";

import { trustProject } from "../src/adapters/project-trust.ts";
import {
  EXACT_FILE_TURN_TOOLS,
  planTurnCapabilities,
  type TurnCapabilityInput,
} from "../src/adapters/turn-capabilities.ts";
import { ToolRegistry, type ToolTurnPolicy } from "../src/core/tool-runtime.ts";
import type { McpTools } from "../src/core/ports.ts";
import { detectSandbox, resolveSrtBunBridge, sandboxActive } from "../src/core/sandbox.ts";
import { isForegroundValidatorOnlyCommand } from "../src/core/validation-command.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; home: string; prompt: string } {
  const root = mkdtempSync(join(tmpdir(), "neko-turn-root-"));
  const home = mkdtempSync(join(tmpdir(), "neko-turn-home-"));
  tempDirs.push(root, home);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "target.ts"), "export const answer = 41;\n", "utf8");
  return {
    root,
    home,
    prompt: "Fix the bug in src/target.ts so all existing tests pass. Make the smallest correct change. Run the tests.",
  };
}

function plan(input: Partial<TurnCapabilityInput> & Pick<TurnCapabilityInput, "rawUserText" | "root" | "home">) {
  return planTurnCapabilities({ source: "user", imageCount: 0, attachmentCount: 0, ...input });
}

function exactPolicy(): ToolTurnPolicy {
  return {
    name: "exact-file-edit",
    allowedTools: EXACT_FILE_TURN_TOOLS,
    allowBackgroundBash: false,
    editTarget: "src/target.ts",
    bashPolicy: "foreground-validator-only",
    reason: "proof-grade exact-file edit",
  };
}

function projectBytes(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) projectBytes(root, path, out);
    else if (entry.isFile()) out[relative(root, path).replace(/\\/g, "/")] = readFileSync(path).toString("base64");
  }
  return out;
}

test("turn lease intersects disabled, role, and ephemeral tool authority, then restores base state", async () => {
  const { root } = fixture();
  const registry = new ToolRegistry(root, "auto", () => true);
  registry.allowOnlyTools(["read_file", "edit", "bash", "skill"]);
  registry.disabled.add("edit");

  const lease = registry.enterTurn(exactPolicy());
  expect(registry.schemas().map((schema) => schema.function.name)).toEqual(["read_file", "bash"]);
  expect(registry.isToolAvailable("skill")).toBe(false);
  expect(await registry.execute("skill", { name: "systematic-debugging" })).toContain("not available for this turn");
  expect(await registry.execute("edit", { path: "src/target.ts", old_string: "41", new_string: "42" })).toContain("disabled");
  expect(await registry.execute("bash", { command: "echo test", run_in_background: true })).toContain("background bash is unavailable for this turn");
  let detached = 0;
  (registry as any).detachCurrent = () => { detached++; };
  expect(registry.detachRunningBash()).toBe(false);
  expect(detached).toBe(0);

  expect(() => registry.enterTurn(exactPolicy())).toThrow("turn tool policy is already active");
  lease.close();
  lease.close();

  expect(registry.detachRunningBash()).toBe(true);
  expect(detached).toBe(1);
  expect(registry.isToolAvailable("skill")).toBe(true);
  expect(registry.isToolAvailable("edit")).toBe(false);
  expect(registry.schemas().map((schema) => schema.function.name)).toEqual(["read_file", "bash", "skill"]);
});

test("turn lease is restored by caller finally on success and throw", async () => {
  const { root } = fixture();
  const registry = new ToolRegistry(root, "auto", () => true);
  const run = async (body: () => Promise<void>) => {
    const lease = registry.enterTurn(exactPolicy());
    try {
      await body();
    } finally {
      lease.close();
    }
  };

  await run(async () => {
    expect(registry.isToolAvailable("memory")).toBe(false);
  });
  expect(registry.isToolAvailable("memory")).toBe(true);

  await expect(run(async () => { throw new Error("turn failed"); })).rejects.toThrow("turn failed");
  expect(registry.isToolAvailable("memory")).toBe(true);
});

test("exact-file lease advertises its real edit and validator contract without mutating global schemas", () => {
  const { root } = fixture();
  const registry = new ToolRegistry(root, "auto", () => true);
  const fullEdit = structuredClone(registry.schemas().find((schema) => schema.function.name === "edit"));
  const fullBash = structuredClone(registry.schemas().find((schema) => schema.function.name === "bash"));

  const lease = registry.enterTurn(exactPolicy());
  const descriptor = registry.turnPolicyDescriptor();
  expect(descriptor).toEqual({
    name: "exact-file-edit",
    editTarget: "src/target.ts",
    bashPolicy: "foreground-validator-only",
    strictEditMatch: true,
  });
  expect(Object.isFrozen(descriptor)).toBe(true);

  const schemas = registry.schemas();
  const edit = schemas.find((schema) => schema.function.name === "edit");
  const bash = schemas.find((schema) => schema.function.name === "bash");
  expect(edit.function.description).toContain("Edit only src/target.ts");
  expect(edit.function.parameters.properties.path.description).toContain("src/target.ts");
  expect(edit.function.parameters.properties.old_string.description).toContain("Whitespace-tolerant matching is disabled");
  expect(edit.function.parameters.properties.old_string.description).toContain("shortest unique substring");
  expect(bash.function.description).toContain("isolated read-only project workspace");
  expect(bash.function.parameters.properties.run_in_background).toBeUndefined();
  expect(bash.function.parameters.properties.command.description).toContain("Validator && validator");

  lease.close();
  expect(registry.turnPolicyDescriptor()).toBeUndefined();
  expect(registry.schemas().find((schema) => schema.function.name === "edit")).toEqual(fullEdit);
  expect(registry.schemas().find((schema) => schema.function.name === "bash")).toEqual(fullBash);
});

test("turn denial precedes hooks, approval, lazy loading, and direct MCP execution", async () => {
  const { root } = fixture();
  let approvals = 0;
  let loads = 0;
  let calls = 0;
  const external = "mcp__loaded__mutate";
  const mcp: McpTools = {
    toolSchemas: () => [
      { type: "function", function: { name: "mcp_load", description: "load", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: external, description: "mutate", parameters: { type: "object", properties: {} } } },
    ],
    has: (name) => name === external,
    loadTools: () => { loads++; return "loaded"; },
    call: async () => { calls++; return "called"; },
  };
  const registry = new ToolRegistry(root, "default", () => { approvals++; return true; }, mcp);
  const hook = join(root, "hook.cjs");
  writeFileSync(hook, "require('node:fs').writeFileSync('hook-ran', 'yes');\n", "utf8");
  registry.hooks = { preToolUse: `\"${process.execPath}\" \"${hook}\"` };

  const lease = registry.enterTurn(exactPolicy());
  expect(registry.schemas().map((schema) => schema.function.name)).toEqual(["read_file", "edit", "bash"]);
  expect(await registry.execute(external, {})).toContain("not available for this turn");
  expect(await registry.execute("mcp_load", { names: [external] })).toContain("not available for this turn");
  expect({ approvals, loads, calls }).toEqual({ approvals: 0, loads: 0, calls: 0 });
  expect(existsSync(join(root, "hook-ran"))).toBe(false);
  lease.close();
});

test("exact-file lease binds edit to its canonical target and checks bash before approval or hooks", async () => {
  const { root } = fixture();
  writeFileSync(join(root, "src", "other.ts"), "export const other = 1;\n", "utf8");
  let approvals = 0;
  const registry = new ToolRegistry(root, "default", () => { approvals++; return false; });
  const hook = join(root, "hook.cjs");
  writeFileSync(hook, "require('node:fs').writeFileSync('boundary-hook-ran', 'yes');\n", "utf8");
  registry.hooks = { preToolUse: `\"${process.execPath}\" \"${hook}\"` };

  const lease = registry.enterTurn(exactPolicy());
  expect(await registry.execute("edit", {
    path: "src/other.ts", old_string: "other = 1", new_string: "other = 2",
  })).toContain("restricted to src/target.ts");
  expect(await registry.execute("bash", { command: "bun test && echo looked-good" })).toContain("foreground validator in an isolated read-only project workspace");
  const alias = join(root, "alias");
  symlinkSync(join(root, "src"), alias, process.platform === "win32" ? "junction" : "dir");
  expect(await registry.execute("edit", {
    path: "alias/target.ts", old_string: "answer = 41", new_string: "answer = 42",
  })).toContain("not a canonical regular file");
  expect(approvals).toBe(0);
  expect(existsSync(join(root, "boundary-hook-ran"))).toBe(false);
  expect(readFileSync(join(root, "src", "other.ts"), "utf8")).toContain("other = 1");

  // A canonical alias reaches the ordinary approval gate. A syntactically valid validator still
  // fails before approval when the configured exact-turn read-only sandbox is unavailable.
  expect(await registry.execute("edit", {
    path: "src/./target.ts", old_string: "answer = 41", new_string: "answer = 42",
  })).toContain("Denied by user");
  expect(await registry.execute("bash", { command: "rtk bun run typecheck -- --pretty false" })).toContain("project mounted read-only");
  expect(approvals).toBe(1);
  lease.close();
});

test("exact-file bash policy accepts only authoritative non-mutating validator invocations", () => {
  for (const command of [
    "bun test",
    "rtk bun run typecheck -- --pretty false",
    "npm test -- --runInBand",
    "bun test && rtk bun run typecheck",
    "FOO=1 pytest tests/unit/test_one.py -q",
  ]) expect(isForegroundValidatorOnlyCommand(command)).toBe(true);

  for (const command of [
    "bun test || true",
    "bun test > test.log",
    "bun test && echo looked-good",
    "echo preparing && bun test",
    "bun test $(touch changed.ts)",
    "bun test @(touch changed.ts)",
    "bun test <(touch changed.ts)",
    "pnpm lint:fix",
    "npm run test:update",
    "bun test --fix",
    "bun test --write",
    "jest -u",
    "vitest --update-snapshots",
    "pytest --snapshot-update",
    "bun run build",
    "cargo build",
    "dotnet build",
    "make build",
  ]) expect(isForegroundValidatorOnlyCommand(command)).toBe(false);
  expect(isForegroundValidatorOnlyCommand("bun test", { run_in_background: true })).toBe(false);
});

test("exact-file validators fail closed before approval when read-only isolation is unavailable", async () => {
  const { root } = fixture();
  let approvals = 0;
  const registry = new ToolRegistry(root, "default", () => { approvals++; return true; });
  registry.sandboxBash = false;
  const lease = registry.enterTurn(exactPolicy());
  try {
    const result = String(await registry.execute("bash", { command: "bun test" }));
    expect(result).toContain("project mounted read-only");
    expect(result).toContain("bash was not executed");
    expect(approvals).toBe(0);
  } finally {
    lease.close();
  }
});

test("exact-file edit refuses an intervening whitespace change instead of clobbering it", async () => {
  const { root } = fixture();
  const target = join(root, "src", "target.ts");
  writeFileSync(target, "  export const answer = 41;\n", "utf8");
  const registry = new ToolRegistry(root, "auto", () => true);
  const lease = registry.enterTurn(exactPolicy());

  await registry.execute("read_file", { path: "src/target.ts" });
  writeFileSync(target, "\texport const answer = 41;\n", "utf8");
  const observation = String(await registry.execute("edit", {
    path: "src/target.ts",
    old_string: "  export const answer = 41;",
    new_string: "  export const answer = 42;",
  }));
  expect(observation).toContain("match current bytes exactly once");
  expect(observation).toContain("found 0");
  expect(observation).toContain("shortest unique exact substring");
  expect(readFileSync(target, "utf8")).toBe("\texport const answer = 41;\n");

  lease.close();
});

test("noTools overrides schemas, availability, and direct execution", async () => {
  const { root } = fixture();
  const registry = new ToolRegistry(root, "auto", () => true);
  registry.noTools = true;
  const lease = registry.enterTurn(exactPolicy());
  expect(registry.schemas()).toEqual([]);
  expect(registry.isToolAvailable("read_file")).toBe(false);
  expect(await registry.execute("read_file", { path: "src/target.ts" })).toContain("tools are disabled for this request");
  lease.close();
});

test("planner narrows only a canonical existing exact-file microtask", () => {
  const fx = fixture();
  const result = plan({ rawUserText: fx.prompt, root: fx.root, home: fx.home });
  expect(result).toMatchObject({
    profile: "exact-file-edit",
    allowedTools: EXACT_FILE_TURN_TOOLS,
    allowBackgroundBash: false,
    target: "src/target.ts",
    editTarget: "src/target.ts",
    bashPolicy: "foreground-validator-only",
  });

  for (const rawUserText of [
    fx.prompt.replace("src/target.ts", "src/../src/target.ts"),
    fx.prompt.replace("src/target.ts", "src/missing.ts"),
  ]) expect(plan({ rawUserText, root: fx.root, home: fx.home }).profile).toBe("full");

  const outsideDir = mkdtempSync(join(dirname(fx.root), "neko-turn-outside-"));
  tempDirs.push(outsideDir);
  writeFileSync(join(outsideDir, "outside.ts"), "export {};\n", "utf8");
  const outsidePath = `../${outsideDir.split(/[\\/]/).pop()}/outside.ts`;
  expect(plan({ rawUserText: fx.prompt.replace("src/target.ts", outsidePath), root: fx.root, home: fx.home }).profile).toBe("full");

  const alias = join(fx.root, "alias");
  symlinkSync(join(fx.root, "src"), alias, process.platform === "win32" ? "junction" : "dir");
  expect(plan({ rawUserText: fx.prompt.replace("src/target.ts", "alias/target.ts"), root: fx.root, home: fx.home }).profile).toBe("full");
});

test("planner and active exact lease reject multiply-linked targets on the same volume", async () => {
  const planned = fixture();
  const outside = mkdtempSync(join(dirname(planned.root), "neko-turn-hardlink-"));
  tempDirs.push(outside);
  const external = join(outside, "outside.ts");
  const target = join(planned.root, "src", "target.ts");
  writeFileSync(external, "export const answer = 41;\n", "utf8");
  rmSync(target);
  try {
    linkSync(external, target);
  } catch (error: any) {
    if (["EPERM", "EACCES", "EXDEV", "ENOTSUP", "ENOSYS"].includes(String(error?.code))) return;
    throw error;
  }
  expect(plan({ rawUserText: planned.prompt, root: planned.root, home: planned.home }).profile).toBe("full");

  const runtime = fixture();
  const runtimeOutside = mkdtempSync(join(dirname(runtime.root), "neko-turn-hardlink-runtime-"));
  tempDirs.push(runtimeOutside);
  const runtimeExternal = join(runtimeOutside, "outside.ts");
  const runtimeTarget = join(runtime.root, "src", "target.ts");
  writeFileSync(runtimeExternal, "export const answer = 41;\n", "utf8");
  const registry = new ToolRegistry(runtime.root, "auto", () => true);
  const lease = registry.enterTurn(exactPolicy());
  try {
    rmSync(runtimeTarget);
    linkSync(runtimeExternal, runtimeTarget);
    const result = String(await registry.execute("edit", {
      path: "src/target.ts", old_string: "answer = 41", new_string: "answer = 42",
    }));
    expect(result).toContain("not a canonical regular file");
    expect(readFileSync(runtimeExternal, "utf8")).toContain("answer = 41");
  } finally {
    lease.close();
  }
});

test("a live SRT exact validator cannot mutate the project directly or through temp aliases", async () => {
  if (process.platform !== "win32" || detectSandbox() !== "srt" || !sandboxActive() || !resolveSrtBunBridge(process.cwd())) return;
  const { root } = fixture();
  const tests = join(root, "test");
  const protectedPath = join(root, "protected.ts");
  const attack = join(tests, "validator-attack.test.ts");
  mkdirSync(tests, { recursive: true });
  writeFileSync(protectedPath, "protected\n", "utf8");
  writeFileSync(attack, [
    'import { copyFileSync, linkSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { tmpdir } from "node:os";',
    'import { expect, test } from "bun:test";',
    'test("workspace is read-only", () => {',
    '  const target = join(process.cwd(), "protected.ts");',
    '  const payload = join(tmpdir(), "payload.ts");',
    '  const alias = join(tmpdir(), "alias.ts");',
    '  writeFileSync(payload, "mutated\\n");',
    '  try { writeFileSync(target, "mutated\\n"); } catch {}',
    '  try { copyFileSync(payload, target); } catch {}',
    '  try { linkSync(target, alias); writeFileSync(alias, "mutated\\n"); } catch {}',
    '  expect(readFileSync(target, "utf8")).toBe("protected\\n");',
    '});',
    '',
  ].join("\n"), "utf8");

  const registry = new ToolRegistry(root, "auto", () => true);
  registry.sandboxBash = true;
  const lease = registry.enterTurn(exactPolicy());
  try {
    const attackResult = String(await registry.execute("bash", { command: "bun test" }));
    expect(readFileSync(protectedPath, "utf8")).toBe("protected\n");
    expect(attackResult).toContain("exit 0");

    writeFileSync(attack, 'import { expect, test } from "bun:test";\ntest("control", () => expect(2 + 2).toBe(4));\n', "utf8");
    const controlResult = String(await registry.execute("bash", { command: "bun test" }));
    expect(controlResult).toContain("exit 0");
    expect(readFileSync(protectedPath, "utf8")).toBe("protected\n");
  } finally {
    lease.close();
  }
}, 60_000);

test("a live SRT exact validator bridges canonical Bun into npm child scripts without changing project bytes", async () => {
  const bridge = process.platform === "win32" ? resolveSrtBunBridge(process.cwd()) : null;
  if (process.platform !== "win32" || detectSandbox() !== "srt" || !sandboxActive() || !bridge) return;
  const { root } = fixture();
  const target = join(root, "src", "target.ts");
  const testDir = join(root, "test");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "neko-srt-npm-validator",
    private: true,
    scripts: { test: "bun test test/bridge.test.ts" },
  }, null, 2) + "\n", "utf8");
  writeFileSync(join(testDir, "bridge.test.ts"), [
    'import { expect, test } from "bun:test";',
    `const expected = ${JSON.stringify(bridge.path.toLowerCase())};`,
    'test("uses the canonical Bun bridge", () => {',
    '  console.log(`NEKO_BRIDGE_EXEC=${process.execPath}`);',
    '  expect(process.execPath.toLowerCase()).toBe(expected);',
    '});',
    '',
  ].join("\n"), "utf8");
  // cmd.exe normally checks cwd before PATH. The launch posture must ignore this project-local
  // decoy and resolve the immutable per-launch shim instead.
  writeFileSync(join(root, "bun.cmd"), "@exit /b 86\r\n", "utf8");

  const registry = new ToolRegistry(root, "auto", () => true);
  registry.sandboxBash = true;
  const lease = registry.enterTurn(exactPolicy());
  try {
    const edit = String(await registry.execute("edit", {
      path: "src/target.ts", old_string: "answer = 41", new_string: "answer = 42",
    }));
    expect(edit).toContain("Edited src/target.ts");
    expect(readFileSync(target, "utf8")).toContain("answer = 42");
    const afterStructuredEdit = projectBytes(root);

    const direct = String(await registry.execute("bash", { command: "bun test test/bridge.test.ts" }));
    expect(direct).toContain("exit 0");
    expect(direct.toLowerCase()).toContain(`neko_bridge_exec=${bridge.path.toLowerCase()}`);
    expect(projectBytes(root)).toEqual(afterStructuredEdit);

    const throughNpm = String(await registry.execute("bash", { command: "npm test" }));
    expect(throughNpm).toContain("exit 0");
    expect(throughNpm.toLowerCase()).toContain(`neko_bridge_exec=${bridge.path.toLowerCase()}`);
    expect(projectBytes(root)).toEqual(afterStructuredEdit);
  } finally {
    lease.close();
  }
}, 90_000);

test("attachments, images, controller text, security, built-in domain, and explicit skills stay full", () => {
  const fx = fixture();
  const cases: TurnCapabilityInput[] = [
    { rawUserText: fx.prompt, source: "user", imageCount: 1, attachmentCount: 0, root: fx.root, home: fx.home },
    { rawUserText: fx.prompt, source: "user", imageCount: 0, attachmentCount: 1, root: fx.root, home: fx.home },
    { rawUserText: fx.prompt, source: "controller", imageCount: 0, attachmentCount: 0, root: fx.root, home: fx.home },
    { rawUserText: fx.prompt.replace("bug", "security vulnerability"), source: "user", imageCount: 0, attachmentCount: 0, root: fx.root, home: fx.home },
    { rawUserText: fx.prompt.replace("bug", "transcript bug"), source: "user", imageCount: 0, attachmentCount: 0, root: fx.root, home: fx.home },
    { rawUserText: `Use the systematic-debugging skill. ${fx.prompt}`, source: "user", imageCount: 0, attachmentCount: 0, root: fx.root, home: fx.home },
  ];
  for (const input of cases) expect(planTurnCapabilities(input).profile).toBe("full");
});

test("user-global domain routes widen, while project catch-all routes do not unless explicitly named", () => {
  const user = fixture();
  const userSkill = join(user.home, ".neko-core", "skills", "target-domain");
  mkdirSync(userSkill, { recursive: true });
  writeFileSync(join(userSkill, "SKILL.md"), "---\nname: target-domain\ndescription: Target domain rules\nmatch: src/target\\.ts\n---\nUser rules.\n", "utf8");
  expect(plan({ rawUserText: user.prompt, root: user.root, home: user.home }).profile).toBe("full");

  const project = fixture();
  const projectSkill = join(project.root, ".neko-core", "skills", "project-catch");
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(projectSkill, "SKILL.md"), "---\nname: project-catch\ndescription: Project catch all\nmatch: .*\n---\nProject rules.\n", "utf8");
  trustProject(project.root, project.home);

  expect(plan({ rawUserText: project.prompt, root: project.root, home: project.home }).profile).toBe("exact-file-edit");
  expect(plan({ rawUserText: `Use the project-catch skill. ${project.prompt}`, root: project.root, home: project.home }).profile).toBe("full");
});

test("project metadata cannot shadow a built-in domain route", () => {
  const fx = fixture();
  const projectSkill = join(fx.root, ".neko-core", "skills", "web-reach");
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(projectSkill, "SKILL.md"), "---\nname: web-reach\ndescription: Shadow\nmatch: ^never$\n---\nProject shadow.\n", "utf8");
  trustProject(fx.root, fx.home);

  expect(plan({ rawUserText: fx.prompt.replace("bug", "transcript bug"), root: fx.root, home: fx.home }).profile).toBe("full");
});

test("ordinary text cannot explicitly activate a project skill with a generic name", () => {
  const fx = fixture();
  const projectSkill = join(fx.root, ".neko-core", "skills", "tests");
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(projectSkill, "SKILL.md"), "---\nname: tests\ndescription: Generic collision\nmatch: ^never$\n---\nProject rules.\n", "utf8");
  trustProject(fx.root, fx.home);

  expect(plan({ rawUserText: fx.prompt, root: fx.root, home: fx.home }).profile).toBe("exact-file-edit");
  for (const activation of ["/skill tests", "$tests", "Use the tests skill."]) {
    expect(plan({ rawUserText: `${activation} ${fx.prompt}`, root: fx.root, home: fx.home }).profile).toBe("full");
  }
});
