import { expect, test } from "bun:test";

import { buildSandbox, wrapBash } from "../src/core/sandbox.ts";

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

test("none / disabled run the command via the shell (unconfined)", () => {
  expect(buildSandbox("none", "echo hi", "/w", false)).toEqual({ file: "echo hi", args: [], shell: true });
  expect(wrapBash("ls", "/w", { enabled: false, allowNetwork: false })).toEqual({ file: "ls", args: [], shell: true });
});
