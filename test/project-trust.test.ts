import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { listAgents, loadAgent } from "../src/adapters/agents.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { loadProjectContext } from "../src/adapters/context.ts";
import { collectChecks } from "../src/adapters/doctor.ts";
import { inspectProjectTrust, listTrustedProjects, PROJECT_TRUST_RECORD_LIMIT, revokeProjectTrust, trustProject } from "../src/adapters/project-trust.ts";
import { loadRecipe } from "../src/adapters/recipes.ts";
import { evaluatePolicy } from "../src/adapters/registry.ts";
import { loadSkill } from "../src/adapters/skills.ts";
import { configureToolRegistry } from "../src/adapters/tool-registry.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");
const tempDirs: string[] = [];
let savedNekoEnv: Record<string, string | undefined> = {};

function fixture(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "neko-project-trust-")));
  tempDirs.push(base);
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value);
  writeFileSync(path, text);
  return text;
}

function cleanEnv(home: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && !key.startsWith("NEKO_")
      && !["OPENAI_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"].includes(key))) as Record<string, string>;
  return { ...env, HOME: home, USERPROFILE: home, NEKO_AUTO_UPDATE: "0" };
}

function readRecordStore(home: string): string {
  const dir = join(home, ".neko-core", "trusted-projects.d");
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
}

function runCli(root: string, home: string, ...args: string[]): { status: number; output: string } {
  const result = Bun.spawnSync([process.execPath, entry, ...args], {
    cwd: root,
    env: cleanEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

beforeEach(() => {
  savedNekoEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEKO_") || ["OPENAI_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"].includes(key)) {
      savedNekoEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NEKO_") || ["OPENAI_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"].includes(key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedNekoEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("no project control files requires no trust", () => {
  const { root, home } = fixture();
  const inspection = inspectProjectTrust(root, home);
  expect(inspection.state).toBe("none");
  expect(inspection.files).toEqual([]);
  expect(loadConfig({ cwd: root, home }).projectTrust.state).toBe("none");
});

test("project trust rejects multiply-linked control files", () => {
  const { root, home } = fixture();
  const external = join(dirname(root), "credential-source.txt");
  writeFileSync(external, "PROJECT_CONTROL_CREDENTIAL_SENTINEL");
  try {
    linkSync(external, join(root, "AGENTS.md"));
  } catch (error: any) {
    if (["EPERM", "EACCES", "EXDEV", "ENOTSUP", "ENOSYS"].includes(String(error?.code))) return;
    throw error;
  }
  expect(inspectProjectTrust(root, home)).toMatchObject({ state: "error" });
  expect(() => trustProject(root, home)).toThrow("Cannot safely snapshot project control surfaces");
  expect(loadProjectContext(root, home)).not.toContain("PROJECT_CONTROL_CREDENTIAL_SENTINEL");
});

test("project controls are quarantined until their exact snapshot is trusted", () => {
  const { root, home } = fixture();
  const configPath = join(root, "neko.json");
  const originalConfig = writeJson(configPath, {
    provider: "project-provider-sentinel",
    base_url: "https://project.invalid/v1",
    model: "project-model-sentinel",
    mode: "auto",
    sandbox: false,
    api_key: "project-secret-sentinel",
  });

  const before = loadConfig({ cwd: root, home });
  expect(before.projectTrust.state).toBe("untrusted");
  expect(before.provider).toBe("openai_compat");
  expect(before.model).toBe("");
  expect(before.mode).toBe("default");
  expect(before.sandbox).toBe(true);
  expect(before.mcpServers.project).toBeUndefined();
  expect(before.apiKey).toBe("");
  before.data.sandbox = false;
  expect(collectChecks(before).find((check) => check.name === "project_trust")).toMatchObject({ status: "warn" });
  expect(evaluatePolicy(before).findings.some((finding) => finding.code === "project_config_untrusted")).toBe(true);

  const trusted = trustProject(root, home);
  expect(trusted.state).toBe("trusted");
  const after = loadConfig({ cwd: root, home });
  expect(after.projectTrust.state).toBe("trusted");
  expect(after.provider).toBe("project-provider-sentinel");
  expect(after.baseUrl).toBe("https://project.invalid/v1");
  expect(after.model).toBe("project-model-sentinel");
  expect(after.mode).toBe("auto");
  expect(after.sandbox).toBe(false);
  expect(after.hooks).toEqual({});
  expect(after.mcpServers.project).toBeUndefined();
  expect(after.apiKey).toBe("project-secret-sentinel");
  expect(collectChecks(after).find((check) => check.name === "project_trust")).toMatchObject({ status: "ok" });
  expect(evaluatePolicy(after).findings.some((finding) => finding.code === "project_config_untrusted")).toBe(false);

  const store = readRecordStore(home);
  expect(store).not.toContain("project-secret-sentinel");
  expect(store).not.toContain("https://project.invalid/v1");

  writeFileSync(configPath, originalConfig.replace("project-model-sentinel", "project-model-changed"));
  expect(inspectProjectTrust(root, home).state).toBe("changed");
  expect(loadConfig({ cwd: root, home }).model).toBe("");

  writeFileSync(configPath, originalConfig);
  expect(inspectProjectTrust(root, home).state).toBe("trusted");
  writeJson(join(root, ".neko-core", "config.json"), { temperature: 0.5 });
  expect(inspectProjectTrust(root, home).state).toBe("changed");
  rmSync(join(root, ".neko-core", "config.json"));
  expect(inspectProjectTrust(root, home).state).toBe("trusted");
});

test("trust is bound to the canonical project root as well as file bytes", () => {
  const first = fixture();
  const second = fixture();
  const contents = { model: "same-bytes" };
  writeJson(join(first.root, "neko.json"), contents);
  writeJson(join(second.root, "neko.json"), contents);
  trustProject(first.root, first.home);

  expect(inspectProjectTrust(first.root, first.home).state).toBe("trusted");
  expect(inspectProjectTrust(second.root, first.home).state).toBe("untrusted");
});

test("global config and MCP remain active while untrusted project controls stay quarantined", () => {
  const { root, home } = fixture();
  writeJson(join(home, ".neko-core", "config.json"), {
    provider: "global-provider",
    base_url: "https://global.invalid/v1",
    model: "global-model",
    hooks: { pre_tool_use: "global-hook" },
    mcp_servers: { global_config: { command: "global-config-command" } },
  });
  writeJson(join(home, ".mcp.json"), {
    mcpServers: { global_file: { command: "global-file-command" } },
  });
  writeJson(join(root, "neko.json"), {
    provider: "project-provider",
    base_url: "https://project.invalid/v1",
    model: "project-model",
    hooks: { pre_tool_use: "project-hook" },
  });
  writeJson(join(root, ".mcp.json"), {
    mcpServers: { project: { command: "project-command" } },
  });

  const cfg = loadConfig({ cwd: root, home });
  expect(cfg.projectTrust.state).toBe("error");
  expect(cfg.provider).toBe("global-provider");
  expect(cfg.baseUrl).toBe("https://global.invalid/v1");
  expect(cfg.model).toBe("global-model");
  expect(cfg.hooks.preToolUse).toBe("global-hook");
  expect(cfg.mcpServers.global_config?.command).toBe("global-config-command");
  expect(cfg.mcpServers.global_file?.command).toBe("global-file-command");
  expect(cfg.mcpServers.project).toBeUndefined();
});

test("a corrupt trust store fails closed and is never clobbered", () => {
  const { root, home } = fixture();
  writeJson(join(root, "neko.json"), { model: "quarantined-model" });
  const storePath = join(home, ".neko-core", "trusted-projects.json");
  mkdirSync(dirname(storePath), { recursive: true });
  const corrupt = "{ definitely-not-json";
  writeFileSync(storePath, corrupt);

  const inspection = inspectProjectTrust(root, home);
  expect(inspection.state).toBe("error");
  expect(inspection.reason).toContain("invalid JSON");
  const cfg = loadConfig({ cwd: root, home });
  expect(cfg.projectTrust.state).toBe("error");
  expect(cfg.model).toBe("");
  expect(() => trustProject(root, home)).toThrow("Project trust store is invalid JSON");
  expect(() => revokeProjectTrust(root, home)).toThrow("Project trust store is invalid JSON");
  expect(() => listTrustedProjects(home)).toThrow("Project trust store is invalid JSON");
  expect(readFileSync(storePath, "utf8")).toBe(corrupt);

  const poisoned = JSON.stringify({
    version: 1,
    projects: {
      ["0".repeat(64)]: {
        root,
        fingerprint: `sha256:${"0".repeat(64)}`,
        files: {},
        trustedAt: new Date(0).toISOString(),
      },
    },
  });
  writeFileSync(storePath, poisoned);
  expect(inspectProjectTrust(root, home).state).toBe("error");
  expect(() => trustProject(root, home)).toThrow("Project trust store contains an invalid record");
  expect(readFileSync(storePath, "utf8")).toBe(poisoned);
});

test("malformed project JSON fails closed without reflecting its contents", () => {
  const { root, home } = fixture();
  const sentinel = "PROJECT_SECRET_MUST_NOT_BE_PRINTED";
  writeFileSync(join(root, "neko.json"), `{ "api_key": "${sentinel}", broken }`);

  const inspection = inspectProjectTrust(root, home);
  expect(inspection.state).toBe("error");
  expect(inspection.reason).toBe("Cannot safely parse project control configuration");
  expect(inspection.reason).not.toContain(sentinel);
  const cfg = loadConfig({ cwd: root, home });
  expect(cfg.apiKey).toBe("");
  expect(JSON.stringify(cfg.projectTrust)).not.toContain(sentinel);
});

test("CLI rejects headless trust grants while reporting snapshots and mutations", () => {
  const { root, home } = fixture();
  const configPath = join(root, "neko.json");
  writeJson(configPath, { model: "cli-project-model" });

  const before = runCli(root, home, "trust", "status");
  expect(before.status).toBe(0);
  expect(before.output).toContain("Project trust: untrusted");
  expect(before.output).toContain("quarantined");

  const add = runCli(root, home, "trust", "add");
  expect(add.status).toBe(1);
  expect(add.output).toContain("only be added from an interactive terminal");
  expect(runCli(root, home, "trust", "status").output).toContain("Project trust: untrusted");

  // Mutation semantics are covered below the TTY-only CLI friction; a real PTY is exercised by the
  // compiled terminal probes, while unit tests must not synthesize a pseudo-human trust grant.
  trustProject(root, home);
  expect(runCli(root, home, "trust", "status").output).toContain("Project trust: trusted");
  const listed = runCli(root, home, "trust", "list");
  expect(listed.status).toBe(0);
  expect(listed.output).toContain("Trusted project snapshots:");
  expect(listed.output).toContain("neko-project-trust-");

  writeJson(configPath, { model: "cli-project-model-mutated" });
  expect(runCli(root, home, "trust", "status").output).toContain("Project trust: changed");
  const revoke = runCli(root, home, "trust", "revoke");
  expect(revoke.status).toBe(0);
  expect(revoke.output).toContain("Project trust revoked");
  expect(runCli(root, home, "trust", "status").output).toContain("Project trust: untrusted");
}, { timeout: 15_000 });

test("--yolo changes approval mode but cannot bypass project trust", () => {
  const { root, home } = fixture();
  writeJson(join(root, "neko.json"), {
    model: "YOLO_PROJECT_MODEL_MUST_STAY_QUARANTINED",
    hooks: { pre_tool_use: "YOLO_PROJECT_HOOK_MUST_STAY_QUARANTINED" },
  });
  writeJson(join(root, ".mcp.json"), {
    mcpServers: { project: { command: "YOLO_PROJECT_MCP_MUST_STAY_QUARANTINED" } },
  });

  const config = runCli(root, home, "--yolo", "config");
  expect(config.status).toBe(0);
  expect(config.output).toContain("mode = auto");
  expect(config.output).not.toContain("YOLO_PROJECT_MODEL_MUST_STAY_QUARANTINED");
  expect(config.output).not.toContain("YOLO_PROJECT_HOOK_MUST_STAY_QUARANTINED");
  expect(config.output).not.toContain("YOLO_PROJECT_MCP_MUST_STAY_QUARANTINED");
  expect(runCli(root, home, "--yolo", "trust", "status").output).toContain("Project trust: error");
}, { timeout: 15_000 });

test("project-local hooks and MCP execution routes stay disabled after trust", () => {
  const { root, home } = fixture();
  writeJson(join(home, ".neko-core", "config.json"), {
    hooks: { pre_tool_use: "global-hook.cmd" },
    mcp_servers: { global: { command: "global-mcp" } },
  });
  writeJson(join(root, "neko.json"), { model: "declarative-project-model" });
  writeJson(join(root, ".mcp.json"), {
    mcpServers: { project: { command: "node", args: ["./mutable-server.js"] } },
  });

  const inspection = inspectProjectTrust(root, home);
  expect(inspection.state).toBe("error");
  expect(inspection.reason).toContain("configure them globally");
  expect(() => trustProject(root, home)).toThrow("configure them globally");
  const cfg = loadConfig({ cwd: root, home });
  expect(cfg.hooks.preToolUse).toBe("global-hook.cmd");
  expect(cfg.mcpServers.global?.command).toBe("global-mcp");
  expect(cfg.mcpServers.project).toBeUndefined();

  rmSync(join(root, ".mcp.json"));
  writeJson(join(root, "neko.json"), {
    profiles: { dormant: { hooks: { pre_tool_use: "./mutable-hook.cmd" } } },
  });
  expect(inspectProjectTrust(root, home).state).toBe("error");
  expect(() => trustProject(root, home)).toThrow("configure them globally");

  writeFileSync(join(root, "neko.json"), '{"__proto__":{"hooks":{"pre_tool_use":"./polluted-hook.cmd"},"mcp_servers":{"polluted":{"command":"evil"}}}}');
  expect(inspectProjectTrust(root, home).state).toBe("error");
  const unpolluted = loadConfig({ cwd: root, home });
  expect(unpolluted.hooks.preToolUse).toBe("global-hook.cmd");
  expect(unpolluted.mcpServers.polluted).toBeUndefined();
});

test("a project cannot grant itself an outside write root even after trust", () => {
  const { root, home } = fixture();
  const outside = join(dirname(root), "outside-authority");
  mkdirSync(outside, { recursive: true });
  writeJson(join(root, "neko.json"), { additional_write_roots: [outside] });

  const inspection = inspectProjectTrust(root, home);
  expect(inspection.state).toBe("error");
  expect(inspection.reason).toContain("external write roots");
  expect(() => trustProject(root, home)).toThrow("configure them globally");

  const cfg = loadConfig({ cwd: root, home });
  expect(cfg.additionalWriteRoots).toEqual([join(home, ".neko-core", "research")]);
});

test("all project prompts, skills, agents, and recipes use one exact trusted snapshot", () => {
  const { root, home } = fixture();
  mkdirSync(join(home, ".neko-core", "skills"), { recursive: true });
  mkdirSync(join(home, ".neko-core", "agents"), { recursive: true });
  mkdirSync(join(home, ".neko-core", "recipes"), { recursive: true });
  writeFileSync(join(home, ".neko-core", "NEKO.md"), "GLOBAL_CONTEXT_SENTINEL");
  writeFileSync(join(home, ".neko-core", "skills", "global.md"), "GLOBAL_SKILL_SENTINEL");
  writeFileSync(join(home, ".neko-core", "agents", "global-agent.md"), "GLOBAL_AGENT_SENTINEL");
  writeFileSync(join(home, ".neko-core", "recipes", "global-recipe.md"), "GLOBAL_RECIPE_SENTINEL");

  writeFileSync(join(root, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL\n@shared.md");
  writeFileSync(join(root, "shared.md"), "PROJECT_IMPORT_SENTINEL");
  const skillDir = join(root, ".neko-core", "skills", "project-skill");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "PROJECT_SKILL_SENTINEL");
  const asset = join(skillDir, "scripts", "run.cmd");
  writeFileSync(asset, "echo ORIGINAL_PROJECT_ASSET");
  mkdirSync(join(root, ".neko-core", "skills", "computer-use"), { recursive: true });
  writeFileSync(join(root, ".neko-core", "skills", "computer-use", "SKILL.md"), "MALICIOUS_COMPUTER_OVERRIDE");
  mkdirSync(join(root, ".neko-core", "agents"), { recursive: true });
  mkdirSync(join(root, ".neko-core", "recipes"), { recursive: true });
  writeFileSync(join(root, ".neko-core", "agents", "project-reviewer.md"), "PROJECT_AGENT_SENTINEL");
  writeFileSync(join(root, ".neko-core", "recipes", "project-recipe.md"), "PROJECT_RECIPE_SENTINEL");

  expect(loadProjectContext(root, home).map((item) => item.text).join("\n")).toContain("GLOBAL_CONTEXT_SENTINEL");
  expect(loadProjectContext(root, home).map((item) => item.text).join("\n")).not.toContain("PROJECT_CONTEXT_SENTINEL");
  expect(loadSkill("project-skill", root, home)).toBeNull();
  expect(loadAgent("project-reviewer", root, home)).toBeNull();
  expect(loadRecipe("project-recipe", root, home)).toBeNull();
  expect(loadSkill("global", root, home)?.body).toContain("GLOBAL_SKILL_SENTINEL");
  expect(loadAgent("global-agent", root, home)?.body).toContain("GLOBAL_AGENT_SENTINEL");
  expect(loadRecipe("global-recipe", root, home)?.body).toContain("GLOBAL_RECIPE_SENTINEL");

  trustProject(root, home);
  const context = loadProjectContext(root, home).map((item) => item.text).join("\n");
  expect(context).toContain("PROJECT_CONTEXT_SENTINEL");
  expect(context).toContain("PROJECT_IMPORT_SENTINEL");
  const projectSkill = loadSkill("project-skill", root, home)!;
  expect(projectSkill.body).toContain("PROJECT_SKILL_SENTINEL");
  expect(projectSkill.dir).toBe("");
  expect(projectSkill.source).toBe("project");
  expect(loadSkill("computer-use", root, home)?.body).not.toContain("MALICIOUS_COMPUTER_OVERRIDE");
  expect(loadAgent("project-reviewer", root, home)?.body).toContain("PROJECT_AGENT_SENTINEL");
  expect(loadRecipe("project-recipe", root, home)?.body).toContain("PROJECT_RECIPE_SENTINEL");

  const cfg = loadConfig({ cwd: root, home });
  const registry = configureToolRegistry(new ToolRegistry(root, "default", async () => false), cfg);
  expect(registry.loadSkill?.("project-skill")).toEqual({ body: "PROJECT_SKILL_SENTINEL", dir: "" });

  const emptyDir = join(skillDir, "empty");
  mkdirSync(emptyDir);
  expect(inspectProjectTrust(root, home).state).toBe("changed");
  rmSync(emptyDir, { recursive: true });
  expect(inspectProjectTrust(root, home).state).toBe("trusted");

  writeFileSync(asset, "echo MUTATED_PROJECT_ASSET");
  expect(inspectProjectTrust(root, home).state).toBe("changed");
  expect(loadSkill("project-skill", root, home)).toBeNull();
  expect(loadAgent("project-reviewer", root, home)).toBeNull();
  expect(loadRecipe("project-recipe", root, home)).toBeNull();
  expect(registry.loadSkill?.("project-skill")).toBeNull();
  expect(loadSkill("global", root, home)?.body).toContain("GLOBAL_SKILL_SENTINEL");
});

test("project trust is exact-cwd and never inherits ancestor instructions", () => {
  const { root, home } = fixture();
  writeFileSync(join(root, "AGENTS.md"), "ROOT_CONTEXT_SENTINEL");
  const child = join(root, "src");
  mkdirSync(child);
  trustProject(root, home);
  expect(loadProjectContext(root, home).some((item) => item.text.includes("ROOT_CONTEXT_SENTINEL"))).toBe(true);
  expect(inspectProjectTrust(child, home).state).toBe("none");
  expect(loadProjectContext(child, home).some((item) => item.text.includes("ROOT_CONTEXT_SENTINEL"))).toBe(false);

  writeFileSync(join(child, "AGENTS.md"), "CHILD_CONTEXT_SENTINEL");
  expect(inspectProjectTrust(child, home).state).toBe("untrusted");
  expect(loadProjectContext(child, home).some((item) => item.text.includes("CHILD_CONTEXT_SENTINEL"))).toBe(false);
  trustProject(child, home);
  expect(loadProjectContext(child, home).some((item) => item.text.includes("CHILD_CONTEXT_SENTINEL"))).toBe(true);
  expect(inspectProjectTrust(root, home).state).toBe("trusted");
});

test("symlink and junction control paths or project ancestors fail closed", () => {
  const first = fixture();
  const outside = join(dirname(first.root), "outside-skills");
  mkdirSync(join(outside, "x"), { recursive: true });
  writeFileSync(join(outside, "x", "SKILL.md"), "OUTSIDE_SKILL_SENTINEL");
  mkdirSync(join(first.root, ".neko-core"), { recursive: true });
  symlinkSync(outside, join(first.root, ".neko-core", "skills"), process.platform === "win32" ? "junction" : "dir");
  expect(inspectProjectTrust(first.root, first.home).state).toBe("error");
  expect(loadSkill("x", first.root, first.home)).toBeNull();

  const second = fixture();
  const base = dirname(second.root);
  const realParent = join(base, "real-parent");
  const aliasedParent = join(base, "aliased-parent");
  const realProject = join(realParent, "project");
  mkdirSync(realProject, { recursive: true });
  writeFileSync(join(realProject, "AGENTS.md"), "ALIASED_ROOT_SENTINEL");
  symlinkSync(realParent, aliasedParent, process.platform === "win32" ? "junction" : "dir");
  expect(inspectProjectTrust(join(aliasedParent, "project"), second.home).state).toBe("error");
});

test("project and trust-store bounds fail closed", () => {
  const oversized = fixture();
  const skillDir = join(oversized.root, ".neko-core", "skills", "large");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "blob.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
  expect(inspectProjectTrust(oversized.root, oversized.home).state).toBe("error");

  const crowded = fixture();
  const crowdedDir = join(crowded.root, ".neko-core", "skills");
  mkdirSync(crowdedDir, { recursive: true });
  for (let index = 0; index < 520; index++) mkdirSync(join(crowdedDir, `empty-${index}`));
  expect(inspectProjectTrust(crowded.root, crowded.home).state).toBe("error");

  const poisoned = fixture();
  writeFileSync(join(poisoned.root, "AGENTS.md"), "STORE_RECORD_SENTINEL");
  trustProject(poisoned.root, poisoned.home);
  const storeDir = join(poisoned.home, ".neko-core", "trusted-projects.d");
  const record = readdirSync(storeDir).find((name) => name.endsWith(".json"))!;
  writeFileSync(join(storeDir, record), "{ invalid-record-json");
  expect(inspectProjectTrust(poisoned.root, poisoned.home).state).toBe("error");
  expect(() => trustProject(poisoned.root, poisoned.home)).toThrow("invalid JSON");

  const linkedStore = fixture();
  writeFileSync(join(linkedStore.root, "AGENTS.md"), "LINKED_STORE_SENTINEL");
  trustProject(linkedStore.root, linkedStore.home);
  const linkedStoreDir = join(linkedStore.home, ".neko-core", "trusted-projects.d");
  const outsideStore = join(dirname(linkedStore.root), "outside-store");
  rmSync(linkedStoreDir, { recursive: true });
  mkdirSync(outsideStore);
  symlinkSync(outsideStore, linkedStoreDir, process.platform === "win32" ? "junction" : "dir");
  expect(inspectProjectTrust(linkedStore.root, linkedStore.home).state).toBe("error");
  expect(() => listTrustedProjects(linkedStore.home)).toThrow("directory is invalid");
});

test("concurrent trust additions and revocation cannot lose or resurrect records", async () => {
  const { root: first, home } = fixture();
  const base = dirname(first);
  const second = join(base, "project-two");
  const third = join(base, "project-three");
  mkdirSync(second);
  mkdirSync(third);
  writeFileSync(join(first, "AGENTS.md"), "FIRST");
  writeFileSync(join(second, "AGENTS.md"), "SECOND");
  writeFileSync(join(third, "AGENTS.md"), "THIRD");
  trustProject(first, home);

  const helper = join(base, "trust-worker.ts");
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "adapters", "project-trust.ts")).href;
  writeFileSync(helper, `import { trustProject, revokeProjectTrust } from ${JSON.stringify(moduleUrl)};\nconst [action, root, home] = process.argv.slice(2);\nif (action === "trust") trustProject(root, home); else revokeProjectTrust(root, home);\n`);
  const safeBunfig = join(import.meta.dir, "..", "bunfig.neko.toml");
  const workers = [
    ["revoke", first],
    ["trust", second],
    ["trust", third],
  ].map(([action, project]) => Bun.spawn([
    process.execPath, "--no-env-file", "--no-install", `--config=${safeBunfig}`,
    helper, action, project, home,
  ], { cwd: base, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" }));
  const exits = await Promise.all(workers.map((worker) => worker.exited));
  const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
  expect(exits, errors.join("\n")).toEqual([0, 0, 0]);
  expect(inspectProjectTrust(first, home).state).toBe("untrusted");
  expect(inspectProjectTrust(second, home).state).toBe("trusted");
  expect(inspectProjectTrust(third, home).state).toBe("trusted");
  expect(listTrustedProjects(home).map((project) => project.root).sort())
    .toEqual([second, third].map((project) => realpathSync.native(project)).sort());
}, { timeout: 30_000 });

test("concurrent additions at trust-store capacity remain readable and bounded", async () => {
  const { root, home } = fixture();
  const base = dirname(root);
  const existing: string[] = [];
  for (let index = 0; index < PROJECT_TRUST_RECORD_LIMIT - 1; index++) {
    const project = index === 0 ? root : join(base, `capacity-${index}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), `CAPACITY-${index}`);
    trustProject(project, home);
    existing.push(project);
  }

  const helper = join(base, "capacity-worker.ts");
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "adapters", "project-trust.ts")).href;
  writeFileSync(helper, `import { trustProject } from ${JSON.stringify(moduleUrl)};\ntrustProject(process.argv[2], process.argv[3]);\n`);
  const safeBunfig = join(import.meta.dir, "..", "bunfig.neko.toml");
  const candidates = [join(base, "capacity-a"), join(base, "capacity-b")];
  for (const candidate of candidates) {
    mkdirSync(candidate);
    writeFileSync(join(candidate, "AGENTS.md"), candidate);
  }
  const workers = candidates.map((project) => Bun.spawn([
    process.execPath, "--no-env-file", "--no-install", `--config=${safeBunfig}`,
    helper, project, home,
  ], { cwd: base, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" }));
  const exits = await Promise.all(workers.map((worker) => worker.exited));
  expect(exits.filter((code) => code === 0).length).toBeGreaterThanOrEqual(1);

  const listed = listTrustedProjects(home);
  expect(listed.length).toBeGreaterThanOrEqual(PROJECT_TRUST_RECORD_LIMIT);
  expect(listed.length).toBeLessThanOrEqual(PROJECT_TRUST_RECORD_LIMIT + 1);
  trustProject(existing[0], home); // refreshing an existing record remains possible at capacity
  const extra = join(base, "capacity-extra");
  mkdirSync(extra);
  writeFileSync(join(extra, "AGENTS.md"), "EXTRA");
  expect(() => trustProject(extra, home)).toThrow("project limit");
  expect(listTrustedProjects(home).length).toBe(listed.length);
}, { timeout: 60_000 });
