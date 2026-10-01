import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { buildAgentRuntime } from "../src/adapters/agent-runtime.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import { NEKOCUT_HOST_PROFILE } from "../src/adapters/host-profile.ts";
import { inheritToolRegistrySettings } from "../src/adapters/tool-registry.ts";
import { createTaskScope, revokeTaskScope } from "../src/core/task-scope.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { ResidentUiaAdmissionError, ResidentUiaHost } from "../src/core/windows-uia-host.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "neko-task-input-"));
  const root = join(base, "root"), home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  return { root, home, cleanup() {
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep) || !basename(base).startsWith("neko-task-input-")) {
      throw new Error("Refusing cleanup outside the input binding fixture");
    }
    rmSync(base, { recursive: true, force: true });
  } };
}

function registryFor(f: ReturnType<typeof fixture>, mode: "auto" | "default" = "auto") {
  const registry = new ToolRegistry(f.root, mode, () => false);
  registry.memoryHome = f.home;
  registry.sandboxBash = false;
  return registry;
}

test("receipt projects the immutable local-helper ceiling separately from approval and OS authority", async () => {
  const f = fixture();
  try {
    const registry = registryFor(f);
    registry.bindTaskScope(createTaskScope("input-receipt", f.root));
    const receipt = registry.taskExecutionReceipt()!;
    expect(receipt).toMatchObject({ bashTarget: "host", osAuthority: "not-attested",
      interaction: { policy: "background", scope: "owned-local-computer-helpers", appliesToComputer: true,
        desktopIsolation: "not-attested" }, approval: { mode: "auto", yolo: false } });
    registry.explicitYolo = true;
    expect(registry.taskExecutionReceipt()?.approval).toEqual({ mode: "auto", yolo: true });
    registry.computerInputPolicy = "foreground";
    expect((registry.taskExecutionReceipt()!).interaction.policy).toBe("background");
    expect(await registry.execute("read_file", { path: "never-read.txt" })).toContain("capabilities changed");
    expect(registry.isToolAvailable("computer")).toBe(false);
  } finally { f.cleanup(); }
});

test("policy mutation is rejected before approval, review, hooks or computer dispatch", async () => {
  const f = fixture();
  let prompts = 0, reviews = 0, dispatches = 0;
  try {
    const registry = registryFor(f, "default");
    registry.prompt = () => { prompts++; return true; };
    registry.checkAction = async () => { reviews++; return { ok: true, reason: "fixture approval" }; };
    registry.hooks = { preToolUse: "echo hook > pre-hook.txt" };
    registry.computerHandler = () => { dispatches++; return "fake action"; };
    registry.bindTaskScope(createTaskScope("input-drift", f.root));
    registry.computerInputPolicy = "foreground";
    expect(await registry.execute("computer", { action: "invoke", inputPolicy: "foreground" }))
      .toContain("capabilities changed");
    expect(prompts).toBe(0); expect(reviews).toBe(0); expect(dispatches).toBe(0);
    expect(existsSync(join(f.root, "pre-hook.txt"))).toBe(false);
    expect((registry.taskExecutionReceipt()!).interaction.appliesToComputer).toBe(false);
  } finally { f.cleanup(); }
});

for (const edge of ["approval", "review"] as const) {
  test(`interaction drift during pending ${edge} cannot reach hooks or mutation`, async () => {
    const f = fixture();
    let entered!: () => void, finish!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const decision = new Promise<void>((resolve) => { finish = resolve; });
    try {
      const registry = registryFor(f, edge === "approval" ? "default" : "auto");
      if (edge === "approval") registry.prompt = async () => { entered(); await decision; return true; };
      else registry.checkAction = async () => { entered(); await decision; return { ok: true, reason: "fixture approval" }; };
      registry.hooks = { preToolUse: "echo hook > pending-hook.txt" };
      registry.bindTaskScope(createTaskScope(`input-${edge}`, f.root));
      const pending = registry.execute("write_file", { path: "after-wait.txt", content: "unexpected" });
      await waiting;
      registry.computerInputPolicy = "foreground";
      finish();
      expect(await pending).toContain("capabilities changed");
      expect(existsSync(join(f.root, "pending-hook.txt"))).toBe(false);
      expect(existsSync(join(f.root, "after-wait.txt"))).toBe(false);
    } finally { finish?.(); f.cleanup(); }
  });
}

test("child inheritance preserves an injected computer route without enabling task delegation", async () => {
  const f = fixture();
  try {
    const parent = registryFor(f);
    const handler = () => "injected action";
    parent.computerHandler = handler;
    const child = inheritToolRegistrySettings(registryFor(f), parent);
    expect(child.computerHandler).toBe(handler);
    expect(await child.execute("computer", { action: "click", x: 1, y: 1 })).toBe("injected action");
    parent.bindTaskScope(createTaskScope("no-delegation", f.root));
    expect(await parent.execute("task", { prompt: "unchanged scoped delegation guard" }))
      .toContain("scoped task delegation");
  } finally { f.cleanup(); }
});

for (const change of ["retirement", "policy"] as const) {
  test.skipIf(process.platform !== "win32")(`registry admission prevents a resident action after late ${change}`, async () => {
    const f = fixture();
    const original = ResidentUiaHost.prototype.request;
    let entered!: () => void, finish!: () => void, actions = 0;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const decision = new Promise<void>((resolve) => { finish = resolve; });
    try {
      // Fake the resident boundary only: no helper child, UIA or one-shot process is started.
      ResidentUiaHost.prototype.request = async function (_request, _timeout, _signal, ...rest: any[]) {
        entered(); await decision;
        rest[0]?.();
        actions++;
        return { id: 1, ok: true, output: "unexpected resident action" };
      };
      const registry = registryFor(f);
      registry.residentUia = true;
      registry.loadSkill = () => ({ name: "computer-use", dir: f.root, body: "fake support" });
      const scope = createTaskScope(`late-${change}`, f.root);
      registry.bindTaskScope(scope);
      const pending = registry.execute("computer", { action: "invoke", name: "fixture" });
      await waiting;
      if (change === "retirement") revokeTaskScope(scope);
      else registry.computerInputPolicy = "foreground";
      finish();
      expect(await pending).toContain(change === "retirement" ? "activation is retired" : "capabilities changed");
      expect(actions).toBe(0);
    } finally { finish?.(); ResidentUiaHost.prototype.request = original; f.cleanup(); }
  });
}


test("interaction drift while an isolated pre-hook waits blocks subsequent dispatch", async () => {
  const f = fixture();
  let pending: Promise<unknown> | undefined;
  try {
    writeFileSync(join(f.root, "hook-worker.ts"), `import { existsSync, writeFileSync } from "node:fs";
writeFileSync("hook-started", "ready");
const deadline = Date.now() + 3000;
while (!existsSync("hook-release") && Date.now() < deadline) await Bun.sleep(5);
if (!existsSync("hook-release")) process.exit(2);
`);
    const registry = registryFor(f);
    registry.hooks = { preToolUse: `"${process.execPath}" --no-env-file --no-install hook-worker.ts` };
    registry.bindTaskScope(createTaskScope("pre-hook-wait", f.root));
    pending = registry.execute("write_file", { path: "after-hook.txt", content: "unexpected" });
    const deadline = Date.now() + 2500;
    while (!existsSync(join(f.root, "hook-started")) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(join(f.root, "hook-started"))).toBe(true);
    registry.computerInputPolicy = "foreground";
    writeFileSync(join(f.root, "hook-release"), "release");
    expect(await pending).toContain("capabilities changed");
    expect(existsSync(join(f.root, "after-hook.txt"))).toBe(false);
  } finally {
    writeFileSync(join(f.root, "hook-release"), "release");
    await pending;
    f.cleanup();
  }
});

for (const failure of ["transport drift", "typed admission"] as const) {
  test.skipIf(process.platform !== "win32")(`resident ${failure} cannot retry through a one-shot helper`, async () => {
    const f = fixture();
    const original = ResidentUiaHost.prototype.request;
    let entered!: () => void, finish!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const decision = new Promise<void>((resolve) => { finish = resolve; });
    try {
      const scripts = join(f.root, "scripts");
      mkdirSync(scripts);
      // An echo-only fixture would expose an unwanted retry; never load a product native script.
      writeFileSync(join(scripts, "uia.ps1"), '# neko-computer-input-policy-v1\n"UNEXPECTED_ONE_SHOT"\n');
      ResidentUiaHost.prototype.request = async () => {
        entered(); await decision;
        if (failure === "typed admission") throw new ResidentUiaAdmissionError(new Error("trusted admission refused"));
        throw new Error("fake transport failure");
      };
      const registry = registryFor(f);
      registry.residentUia = true;
      registry.loadSkill = () => ({ name: "computer-use", dir: f.root, body: "fake support" });
      registry.bindTaskScope(createTaskScope(`retry-${failure.replaceAll(" ", "-")}`, f.root));
      const pending = registry.execute("computer", { action: "invoke", name: "fixture" });
      await waiting;
      if (failure === "transport drift") registry.computerInputPolicy = "foreground";
      finish();
      expect(await pending).toContain(failure === "transport drift" ? "capabilities changed" : "trusted admission refused");
    } finally { finish?.(); ResidentUiaHost.prototype.request = original; f.cleanup(); }
  });
}


test("host-profile composition binds configured interaction policy before Agent construction", async () => {
  const f = fixture();
  const scope = createTaskScope("host-profile-policy", f.root);
  let runtime: Awaited<ReturnType<typeof buildAgentRuntime>> | undefined;
  try {
    const cfg = new NekoConfig({ provider: "openai_compat", model: "synthetic-model",
      base_url: "http://127.0.0.1:9/v1", sandbox: false, computer_use_input_policy: "foreground" },
    null, {}, "", null, [], { state: "none", files: [] }, f.home);
    runtime = await buildAgentRuntime(cfg, { root: f.root, taskScope: scope,
      approval: () => false, hostProfile: NEKOCUT_HOST_PROFILE,
      hostTools: { toolSchemas: () => [], has: () => false, call: async () => "unused" } });
    // No provider or native call: inspect the production host-profile composition.
    expect(runtime.registry.computerInputPolicy).toBe("foreground");
    expect((runtime.registry.taskExecutionReceipt()!).interaction).toMatchObject({
      policy: "foreground", appliesToComputer: false, desktopIsolation: "not-attested" });
  } finally { revokeTaskScope(scope); await runtime?.close(); f.cleanup(); }
});
