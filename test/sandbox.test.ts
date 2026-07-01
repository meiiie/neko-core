import { expect, test } from "bun:test";

import { buildSandbox, findWindowsBash, plainTarget, wrapBash } from "../src/core/sandbox.ts";

test("bwrap confines fs to the workspace + blocks network by default", () => {
  const t = buildSandbox("bwrap", "echo hi", "/work", false);
  expect(t.file).toBe("bwrap");
  expect(t.shell).toBe(false);
  expect(t.args).toContain("--ro-bind"); // whole fs read-only
  expect(t.args.join(" ")).toContain("--bind /work /work"); // workspace read-write
  expect(t.args).toContain("--unshare-net"); // no network
  expect(t.args.slice(-3)).toEqual(["bash", "-c", "echo hi"]);
});

test("bwrap keeps network when explicitly allowed", () => {
  expect(buildSandbox("bwrap", "x", "/w", true).args).not.toContain("--unshare-net");
});

test("sandbox-exec profile confines writes + denies network", () => {
  const t = buildSandbox("sandbox-exec", "echo hi", "/work", false);
  expect(t.file).toBe("sandbox-exec");
  expect(t.args[1]).toContain("deny file-write*");
  expect(t.args[1]).toContain('(subpath "/work")');
  expect(t.args[1]).toContain("deny network*");
});

test("plainTarget: git-bash runs `bash -c cmd`, else the raw command via the platform shell", () => {
  // Windows with a real bash found -> POSIX bash, so Unix idioms (heredocs, $VAR, pipes) work.
  expect(plainTarget("echo hi", "C:/Git/bin/bash.exe")).toEqual({
    file: "C:/Git/bin/bash.exe", args: ["-c", "echo hi"], shell: false,
  });
  // No bash (POSIX, or Windows without git-bash) -> hand the command to the platform shell as-is.
  expect(plainTarget("echo hi", null)).toEqual({ file: "echo hi", args: [], shell: true });
});

test("none / disabled run the command unconfined (git-bash on Windows, platform shell elsewhere)", () => {
  const none = buildSandbox("none", "echo hi", "/w", false);
  const disabled = wrapBash("ls", "/w", { enabled: false, allowNetwork: false });
  if (process.platform === "win32" && findWindowsBash()) {
    for (const [t, cmd] of [[none, "echo hi"], [disabled, "ls"]] as const) {
      expect(t.shell).toBe(false);
      expect(t.file.toLowerCase()).toContain("bash");
      expect(t.args).toEqual(["-c", cmd]);
    }
  } else {
    expect(none).toEqual({ file: "echo hi", args: [], shell: true });
    expect(disabled).toEqual({ file: "ls", args: [], shell: true });
  }
});
