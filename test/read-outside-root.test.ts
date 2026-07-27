import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("the deny list names what it is protecting", () => {
  const cases: Array<[string, string]> = [
    ["C:/Users/Admin/.ssh/config", "SSH keys"],
    ["/home/x/.aws/credentials", "AWS credentials"],
    ["C:/Users/Admin/.neko-core/config.json", "Neko's own key store"],
    ["/srv/app/.env.production", "an environment file"],
    ["/certs/server.pem", "key material"],
    ["C:/Users/Admin/AppData/Local/Google/Chrome/User Data/Default/Login Data", "a credential store"],
    ["C:/Users/Admin/AppData/Local/Google/Chrome/User Data/Default/History", "a browser profile"],
    ["/etc/shadow", "a system credential file"],
  ];
  for (const [path, reason] of cases) expect(deniedOutsideRoot(path)).toBe(reason);
  // Ordinary paths are not swept up by the pattern that catches the sensitive ones.
  for (const path of ["/home/x/projects/app/src/env.ts", "C:/repos/keys.md", "/docs/environment.md"]) {
    expect(deniedOutsideRoot(path)).toBeNull();
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
