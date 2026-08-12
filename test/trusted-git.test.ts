import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { trustedGitExecutable } from "../src/adapters/trusted-git.ts";

test("Git metadata lookup never resolves an executable from the untrusted workspace", () => {
  const base = mkdtempSync(join(tmpdir(), "neko-trusted-git-"));
  const repo = join(base, "repo");
  const tools = join(base, "tools");
  try {
    mkdirSync(repo);
    mkdirSync(tools);
    writeFileSync(join(repo, "git.exe"), "repo poison");
    writeFileSync(join(tools, "git.exe"), "trusted candidate");
    expect(trustedGitExecutable(repo, [repo, tools].join(delimiter), "win32"))
      .toBe(realpathSync(join(tools, "git.exe")));
    expect(trustedGitExecutable(repo, repo, "win32")).toBeNull();
    if (process.platform === "win32") {
      expect(trustedGitExecutable(repo.toUpperCase(), repo, "win32")).toBeNull();
    }

    const alias = join(base, "repo-alias");
    symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    expect(trustedGitExecutable(repo, alias, "win32")).toBeNull();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
