import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ToolRegistry, autoApprove, deniedOutsideRoot } from "../src/core/tool-runtime.ts";

function workspace(): { root: string; outside: string; clean: () => void } {
  const base = mkdtempSync(join(tmpdir(), "neko-scope-"));
  const root = join(base, "project");
  const outside = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "inside.txt"), "in the project\n");
  writeFileSync(join(outside, "SKILL.md"), "# a skill living somewhere else\n");
  return { root, outside, clean: () => rmSync(base, { recursive: true, force: true }) };
}

test("a read outside the project root succeeds when the host allows it", async () => {
  const { root, outside, clean } = workspace();
  try {
    const registry = new ToolRegistry(root, "auto", autoApprove);
    const result = await registry.execute("read_file", { path: join(outside, "SKILL.md") });
    expect(String(result)).toContain("a skill living somewhere else");
    // The reported bug: a skill file one directory over was unreadable, which made ordinary work
    // impossible rather than safer.
    expect(String(result)).not.toContain("escapes project root");
  } finally {
    clean();
  }
});

test("the same read is refused when the host closes the wall", async () => {
  const { root, outside, clean } = workspace();
  try {
    const registry = new ToolRegistry(root, "auto", autoApprove);
    registry.readOutsideRoot = false;
    const result = await registry.execute("read_file", { path: join(outside, "SKILL.md") });
    expect(String(result)).toContain("escapes project root");
  } finally {
    clean();
  }
});

test("writing outside the root stays refused, allowed reads or not", async () => {
  const { root, outside, clean } = workspace();
  try {
    const registry = new ToolRegistry(root, "auto", autoApprove);
    expect(registry.readOutsideRoot).toBe(true); // reads are open...
    for (const call of [
      ["write_file", { path: join(outside, "new.txt"), content: "no" }],
      ["edit", { path: join(outside, "SKILL.md"), old_string: "skill", new_string: "no" }],
    ] as const) {
      const result = await registry.execute(call[0], call[1] as Record<string, any>);
      expect(String(result)).toContain("escapes project root"); // ...and writes are not
    }
  } finally {
    clean();
  }
});

test("an explicit additional root allows structured writes without granting its siblings or aliases", async () => {
  const { root, outside, clean } = workspace();
  const sibling = join(dirname(outside), "not-granted");
  try {
    mkdirSync(sibling, { recursive: true });
    const registry = new ToolRegistry(root, "auto", autoApprove);
    registry.additionalWriteRoots = [outside];

    expect(await registry.execute("write_file", { path: join(outside, "notes.md"), content: "one\n" }))
      .toContain("Wrote");
    expect(await registry.execute("edit", {
      path: join(outside, "notes.md"), old_string: "one", new_string: "two",
    })).toContain("Edited");
    expect(await registry.execute("multi_edit", {
      path: join(outside, "notes.md"), edits: [{ old_string: "two", new_string: "three" }],
    })).toContain("Edited");
    expect(readFileSync(join(outside, "notes.md"), "utf8")).toBe("three\n");

    expect(String(await registry.execute("write_file", {
      path: join(sibling, "blocked.txt"), content: "no",
    }))).toContain("escapes project root");
    expect(String(await registry.execute("write_file", {
      path: join(outside, ".env"), content: "SECRET=no",
    }))).toContain("refused");

    const alias = join(outside, "alias");
    symlinkSync(sibling, alias, process.platform === "win32" ? "junction" : "dir");
    expect(String(await registry.execute("write_file", {
      path: join(alias, "escaped.txt"), content: "no",
    }))).toContain("escapes additional write root via a symlink");
  } finally {
    clean();
  }
});

test("credential paths are refused outside the root even with reads open", async () => {
  const { root, outside, clean } = workspace();
  try {
    mkdirSync(join(outside, ".ssh"), { recursive: true });
    writeFileSync(join(outside, ".ssh", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(outside, ".env"), "TOKEN=abc\n");
    const registry = new ToolRegistry(root, "auto", autoApprove);
    for (const path of [join(outside, ".ssh", "id_rsa"), join(outside, ".env")]) {
      const result = await registry.execute("read_file", { path });
      expect(String(result)).toContain("refused");
      expect(String(result)).not.toContain("BEGIN OPENSSH");
      expect(String(result)).not.toContain("TOKEN=abc");
    }
  } finally {
    clean();
  }
});

test("credential paths are refused and filtered inside the project in both read modes", async () => {
  const { root, clean } = workspace();
  try {
    mkdirSync(join(root, "certs"), { recursive: true });
    writeFileSync(join(root, ".env"), "NEKO_SECRET_SENTINEL=hidden\n");
    writeFileSync(join(root, ".envrc"), "NEKO_SECRET_SENTINEL=hidden envrc\n");
    writeFileSync(join(root, ".env-local"), "NEKO_SECRET_SENTINEL=hidden env-local\n");
    writeFileSync(join(root, ".env_prod"), "NEKO_SECRET_SENTINEL=hidden env-prod\n");
    writeFileSync(join(root, "certs", "server.pem"), "NEKO_SECRET_SENTINEL hidden key\n");
    writeFileSync(join(root, "public.txt"), "NEKO_SECRET_SENTINEL public fixture\n");
    for (const readOutsideRoot of [true, false]) {
      const registry = new ToolRegistry(root, "auto", autoApprove);
      registry.readOutsideRoot = readOutsideRoot;
      for (const path of [".env", ".envrc", ".env-local", ".env_prod", "certs/server.pem"]) {
        const result = String(await registry.execute("read_file", { path }));
        expect(result).toContain("refused");
        expect(result).not.toContain("hidden");
      }
      const search = String(await registry.execute("search", { pattern: "NEKO_SECRET_SENTINEL" }));
      expect(search).toContain("public.txt");
      expect(search).not.toContain("server.pem");
      expect(search).not.toContain(".env");
      expect(String(await registry.execute("glob", { pattern: "**/*" }))).not.toContain("server.pem");
      expect(String(await registry.execute("ls", { path: "." }))).not.toContain(".env");
      expect(String(await registry.execute("ls", { path: "certs" }))).not.toContain("server.pem");
    }
  } finally {
    clean();
  }
});

test("an innocently named junction cannot alias a denied credential store", async () => {
  const { root, outside, clean } = workspace();
  try {
    const keys = join(outside, ".ssh");
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, "id_ed25519"), "NEKO_ALIAS_SECRET\n");
    symlinkSync(keys, join(root, "docs"), process.platform === "win32" ? "junction" : "dir");
    const registry = new ToolRegistry(root, "auto", autoApprove);
    const result = String(await registry.execute("read_file", { path: "docs/id_ed25519" }));
    expect(result).toContain("refused");
    expect(result).not.toContain("NEKO_ALIAS_SECRET");
    const envrc = join(outside, ".envrc");
    writeFileSync(envrc, "NEKO_ENV_ALIAS_SECRET\n");
    symlinkSync(envrc, join(root, "env-rules"), "file");
    const envAlias = String(await registry.execute("read_file", { path: "env-rules" }));
    expect(envAlias).toContain("refused");
    expect(envAlias).not.toContain("NEKO_ENV_ALIAS_SECRET");
  } finally {
    clean();
  }
});

test("Neko and Codex auth/control stores stay hidden across every safe filesystem surface", async () => {
  const { root, outside, clean } = workspace();
  const hidden = [
    ".neko-core/config.json.bak-test",
    ".neko-core/chatgpt-auth.json",
    ".neko-core/kimi-auth.json.tmp-1",
    ".neko-core/mcp-auth/example/tokens.json",
    ".neko-core/gemini-home/oauth_creds.json",
    "custom-gemini/oauth_creds.json",
    ".neko-core/relay.json",
    ".neko-core/relay-sessions/session.json",
    ".neko-core/remote.json",
    ".neko-core/browser-bridge.json",
    ".neko-core/browser/default/Preferences",
    ".neko-core/codex-home/auth.json",
    ".codex/auth.json",
    ".codex/secrets/mcp_oauth.age",
    ".codex/.sandbox-secrets/sandbox_users.json",
  ];
  try {
    for (const rel of hidden) {
      const path = join(root, ...rel.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `NEKO_AUTH_CONTROL_SENTINEL hidden in ${rel}\n`);
    }
    const outsideAuth = join(outside, ".neko-core", "chatgpt-auth.json");
    mkdirSync(dirname(outsideAuth), { recursive: true });
    writeFileSync(outsideAuth, "NEKO_AUTH_CONTROL_SENTINEL hidden outside\n");
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(join(root, "fixtures", "auth.json"), "NEKO_AUTH_CONTROL_SENTINEL ordinary fixture\n");
    writeFileSync(join(root, ".neko-core", "remote.jsonschema"), "NEKO_AUTH_CONTROL_SENTINEL ordinary schema\n");
    writeFileSync(join(root, "public.txt"), "NEKO_AUTH_CONTROL_SENTINEL public control\n");

    const registry = new ToolRegistry(root, "auto", autoApprove);
    for (const rel of [...hidden, outsideAuth]) {
      const result = String(await registry.execute("read_file", { path: rel }));
      expect(result).toContain("refused");
      expect(result).not.toContain("NEKO_AUTH_CONTROL_SENTINEL");
    }
    expect(String(await registry.execute("read_file", { path: ".neko-core/remote.jsonschema" }))).toContain("ordinary schema");

    const search = String(await registry.execute("search", { pattern: "NEKO_AUTH_CONTROL_SENTINEL" }));
    expect(search).toContain("public.txt");
    expect(search).toContain("fixtures/auth.json");
    expect(search).not.toContain("hidden in");
    const searchedPaths = search.split(/\r?\n/).map((line) => line.split(":", 1)[0]);
    for (const rel of hidden) expect(searchedPaths).not.toContain(rel.replace(/\\/g, "/"));
    const stateSearch = String(await registry.execute("search", {
      path: ".neko-core",
      pattern: "NEKO_AUTH_CONTROL_SENTINEL",
    }));
    expect(stateSearch).toContain(".neko-core/remote.jsonschema");
    expect(stateSearch).not.toContain("hidden in");
    const forcedSecretGlob = String(await registry.execute("search", {
      pattern: "NEKO_AUTH_CONTROL_SENTINEL",
      glob: "**/oauth_creds.json",
    }));
    expect(forcedSecretGlob).not.toContain("hidden in");
    expect(forcedSecretGlob).not.toContain("NEKO_AUTH_CONTROL_SENTINEL");

    const glob = String(await registry.execute("glob", { pattern: "**/*" }));
    expect(glob).toContain("fixtures/auth.json");
    const globbedPaths = glob.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const rel of hidden) expect(globbedPaths).not.toContain(rel.replace(/\\/g, "/"));
    const stateGlob = String(await registry.execute("glob", { path: ".neko-core", pattern: "**/*" }));
    expect(stateGlob).toContain(".neko-core/remote.jsonschema");
    const stateGlobPaths = new Set(stateGlob.split(/\r?\n/));
    for (const rel of hidden.filter((path) => path.startsWith(".neko-core/"))) {
      expect(stateGlobPaths.has(rel.replace(/\\/g, "/"))).toBe(false);
    }

    symlinkSync(join(root, ".neko-core"), join(root, "state"), process.platform === "win32" ? "junction" : "dir");
    const aliasedRead = String(await registry.execute("read_file", { path: "state/chatgpt-auth.json" }));
    expect(aliasedRead).toContain("refused");
    expect(aliasedRead).not.toContain("NEKO_AUTH_CONTROL_SENTINEL");
    expect(String(await registry.execute("search", { path: "state", pattern: "NEKO_AUTH_CONTROL_SENTINEL" }))).not.toContain("hidden in");
  } finally {
    clean();
  }
});

test("common developer CLI credential stores stay hidden without banning ordinary config fixtures", async () => {
  const { root, outside, clean } = workspace();
  const hidden = [
    ".npmrc",
    ".pypirc",
    ".config/gh/hosts.yml",
    "AppData/Roaming/GitHub CLI/hosts.yaml",
    "AppData/Roaming/gh/hosts.yml",
    ".config/gcloud/application_default_credentials.json",
    ".config/gcloud/credentials.db-wal",
    ".config/gcloud/access_tokens.db",
    ".config/gcloud/legacy_credentials/account/adc.json",
    ".azure/accessTokens.json",
    ".azure/msal_token_cache.bin",
    ".azure/msal_token_cache.json.bak",
    ".azure/service_principal_entries.json",
    ".kube/config",
  ];
  try {
    for (const rel of hidden) {
      const path = join(root, ...rel.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `NEKO_CLI_CREDENTIAL_SENTINEL hidden in ${rel}\n`);
    }
    const outsideNpmrc = join(outside, ".npmrc");
    writeFileSync(outsideNpmrc, "NEKO_CLI_CREDENTIAL_SENTINEL hidden outside\n");
    mkdirSync(join(root, "fixtures", "gh"), { recursive: true });
    writeFileSync(join(root, "fixtures", "gh", "hosts.yml"), "NEKO_CLI_CREDENTIAL_SENTINEL ordinary hosts fixture\n");
    writeFileSync(join(root, "fixtures", "config"), "NEKO_CLI_CREDENTIAL_SENTINEL ordinary config fixture\n");

    const registry = new ToolRegistry(root, "auto", autoApprove);
    for (const rel of [...hidden, outsideNpmrc]) {
      const result = String(await registry.execute("read_file", { path: rel }));
      expect(result).toContain("refused");
      expect(result).not.toContain("NEKO_CLI_CREDENTIAL_SENTINEL");
    }
    expect(String(await registry.execute("read_file", { path: "fixtures/gh/hosts.yml" }))).toContain("ordinary hosts fixture");
    expect(String(await registry.execute("read_file", { path: "fixtures/config" }))).toContain("ordinary config fixture");

    const search = String(await registry.execute("search", { pattern: "NEKO_CLI_CREDENTIAL_SENTINEL" }));
    expect(search).toContain("ordinary hosts fixture");
    expect(search).toContain("ordinary config fixture");
    expect(search).not.toContain("hidden in");
    for (const path of [".config/gh", ".config/gcloud", "AppData/Roaming/GitHub CLI", ".azure", ".kube"]) {
      const scoped = String(await registry.execute("search", { path, pattern: "NEKO_CLI_CREDENTIAL_SENTINEL" }));
      expect(scoped).not.toContain("hidden in");
      expect(scoped).not.toContain("NEKO_CLI_CREDENTIAL_SENTINEL");
    }
    const forced = String(await registry.execute("search", {
      pattern: "NEKO_CLI_CREDENTIAL_SENTINEL",
      glob: "**/hosts.y*ml",
    }));
    expect(forced).toContain("fixtures/gh/hosts.yml");
    expect(forced).not.toContain("hidden in");

    const glob = String(await registry.execute("glob", { pattern: "**/*" }));
    expect(glob).toContain("fixtures/gh/hosts.yml");
    for (const rel of hidden) expect(glob).not.toContain(rel.replace(/\\/g, "/"));

    symlinkSync(join(root, ".config", "gh"), join(root, "session"), process.platform === "win32" ? "junction" : "dir");
    const aliasRead = String(await registry.execute("read_file", { path: "session/hosts.yml" }));
    expect(aliasRead).toContain("refused");
    expect(aliasRead).not.toContain("NEKO_CLI_CREDENTIAL_SENTINEL");
    expect(String(await registry.execute("search", { path: "session", pattern: "NEKO_CLI_CREDENTIAL_SENTINEL" }))).not.toContain("hidden in");
  } finally {
    clean();
  }
});

test("the deny list names what it is protecting", () => {
  const cases: Array<[string, string]> = [
    ["C:/Users/Admin/.ssh/config", "SSH keys"],
    ["/home/x/.aws/credentials", "AWS credentials"],
    ["C:/Users/Admin/.neko-core/config.json", "Neko's own key store"],
    ["C:/Users/Admin/.neko-core/chatgpt-auth.json", "Neko authentication credentials"],
    ["C:/Users/Admin/.neko-core/kimi-auth.json", "Neko authentication credentials"],
    ["C:/Users/Admin/.neko-core/mcp-auth/server/tokens.json", "Neko MCP OAuth credentials"],
    ["C:/Users/Admin/.neko-core/gemini-home/oauth_creds.json", "Gemini OAuth credentials"],
    ["C:/Users/Admin/.neko-core/relay.json", "Neko control credentials"],
    ["C:/Users/Admin/.neko-core/relay-sessions/abc.json", "Neko relay session credentials"],
    ["C:/Users/Admin/.neko-core/remote.json", "Neko control credentials"],
    ["C:/Users/Admin/.neko-core/browser-bridge.json", "Neko control credentials"],
    ["C:/Users/Admin/.neko-core/browser/default/Preferences", "a browser profile"],
    ["C:/Users/Admin/.neko-core/codex-home/auth.json", "Codex credentials"],
    ["C:/Users/Admin/.codex/auth.json", "Codex credentials"],
    ["C:/Users/Admin/.codex/secrets/mcp_oauth.age", "Codex credentials"],
    ["C:/Users/Admin/.codex/.sandbox-secrets/sandbox_users.json", "Codex credentials"],
    ["/home/x/.npmrc", "npm credentials"],
    ["/home/x/.pypirc", "PyPI credentials"],
    ["/home/x/.config/gh/hosts.yml", "GitHub CLI credentials"],
    ["C:/Users/Admin/AppData/Roaming/GitHub CLI/hosts.yml", "GitHub CLI credentials"],
    ["C:/Users/Admin/AppData/Roaming/gh/hosts.yaml", "GitHub CLI credentials"],
    ["/home/x/.config/gcloud/application_default_credentials.json", "Google Cloud credentials"],
    ["/home/x/.config/gcloud/credentials.db-wal", "Google Cloud credentials"],
    ["/home/x/.config/gcloud/legacy_credentials/account/adc.json", "Google Cloud credentials"],
    ["/home/x/.azure/accessTokens.json", "Azure credentials"],
    ["/home/x/.azure/msal_token_cache.bin", "Azure credentials"],
    ["/home/x/.azure/service_principal_entries.json", "Azure credentials"],
    ["/home/x/.kube/config", "Kubernetes credentials"],
    ["/srv/app/.env.production", "an environment file"],
    ["/srv/app/.envrc", "an environment file"],
    ["/srv/app/.env-local", "an environment file"],
    ["/srv/app/.env_prod", "an environment file"],
    ["/certs/server.pem", "key material"],
    ["C:/Users/Admin/AppData/Local/Google/Chrome/User Data/Default/Login Data", "a credential store"],
    ["C:/Users/Admin/AppData/Local/Google/Chrome/User Data/Default/History", "a browser profile"],
    ["/etc/shadow", "a system credential file"],
    ["/proc/self/environ", "a virtual system filesystem"],
    ["/sys/kernel/debug", "a virtual system filesystem"],
    ["/dev/mem", "a device file"],
  ];
  for (const [path, reason] of cases) expect(deniedOutsideRoot(path)).toBe(reason);
  const customCodexHome = join(tmpdir(), "custom-codex-state");
  expect(deniedOutsideRoot(join(customCodexHome, "auth.json"), { codexHomes: [customCodexHome] })).toBe("Codex credentials");
  const customState = join(tmpdir(), "custom-cli-state");
  expect(deniedOutsideRoot(join(customState, "hosts.yml"), { githubCliHomes: [customState] })).toBe("GitHub CLI credentials");
  expect(deniedOutsideRoot(join(customState, "credentials.db"), { gcloudHomes: [customState] })).toBe("Google Cloud credentials");
  expect(deniedOutsideRoot(join(customState, "msal_token_cache.bin"), { azureHomes: [customState] })).toBe("Azure credentials");
  expect(deniedOutsideRoot(join(customState, "cluster.conf"), { kubeConfigPaths: [join(customState, "cluster.conf")] })).toBe("Kubernetes credentials");
  expect(deniedOutsideRoot(join(customState, "npm-user-config"), { npmrcPaths: [join(customState, "npm-user-config")] })).toBe("npm credentials");
  for (const path of ["C:/work/NUL", "C:/work/con.txt", "C:/work/COM1.log", "C:/work/LPT9:", "\\\\.\\PhysicalDrive0", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1"]) {
    expect(deniedOutsideRoot(path, { codexHomes: [], platform: "win32" })).toBe("a Windows device");
  }
  expect(deniedOutsideRoot("C:/work/COM10.log", { codexHomes: [], platform: "win32" })).toBeNull();
  // Ordinary paths are not swept up by the pattern that catches the sensitive ones.
  for (const path of ["/home/x/projects/app/src/env.ts", "C:/repos/keys.md", "/docs/environment.md", "/repo/fixtures/auth.json", "/repo/gh/hosts.yml", "/repo/config", "/home/x/.neko-core/NEKO.md"]) {
    expect(deniedOutsideRoot(path)).toBeNull();
  }
});

test("virtual filesystems and Windows reserved devices are rejected before I/O", async () => {
  const { root, clean } = workspace();
  try {
    const registry = new ToolRegistry(root, "auto", autoApprove);
    if (process.platform === "win32") {
      for (const path of ["NUL", "con.txt", "nested/PRN", "COM1.log", "LPT9:"]) {
        const result = String(await registry.execute("read_file", { path }));
        expect(result).toContain("refused");
        expect(result).toContain("Windows device");
      }
    } else {
      for (const path of ["/proc/self/environ", "/sys/kernel", "/dev/null"]) {
        const result = String(await registry.execute("read_file", { path }));
        expect(result).toContain("refused");
      }
    }
  } finally {
    clean();
  }
});

test("listing and searching follow the same rule as reading", async () => {
  const { root, outside, clean } = workspace();
  try {
    const open = new ToolRegistry(root, "auto", autoApprove);
    expect(String(await open.execute("ls", { path: outside }))).toContain("SKILL.md");
    expect(String(await open.execute("glob", { pattern: "*.md", path: outside }))).toContain("SKILL.md");

    const walled = new ToolRegistry(root, "auto", autoApprove);
    walled.readOutsideRoot = false;
    expect(String(await walled.execute("ls", { path: outside }))).toContain("escapes project root");
  } finally {
    clean();
  }
});
