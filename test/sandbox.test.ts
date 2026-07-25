import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSandbox, destructiveInWorkspace, findWindowsBash, isDockerCommand, plainTarget, purgeStaleSrtScripts, srtScript, srtSettings, wrapBash, writeEphemeralSrtScript } from "../src/core/sandbox.ts";

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

test("srt runs bash via a script file + confines writes + hard-blocks network by default", () => {
  const launch = { exe: "C:\\bin\\srt.exe", settingsPath: "C:\\tmp\\s.json", bash: "C:\\Git\\bin\\bash.exe", scriptPath: "C:\\tmp\\cmd-1.sh" };
  expect(buildSandbox("srt", "echo hi", "C:\\work", false, launch)).toEqual({
    file: "C:\\bin\\srt.exe",
    // Command bytes live in the script FILE; the -c line carries only two quoted paths.
    args: ["--settings", "C:\\tmp\\s.json", "-c", '"C:\\Git\\bin\\bash.exe" "C:\\tmp\\cmd-1.sh"'],
    shell: false,
  });
  const s = JSON.parse(srtSettings("C:\\work", false));
  expect(s.filesystem).toEqual({ denyRead: [], allowWrite: ["C:\\work"], denyWrite: [] }); // all 4 keys schema-required
  expect(s.network).toEqual({ allowedDomains: [], deniedDomains: ["*"] }); // hard block, denied checked first
});

test("srt network allow = the sandbox_domains allowlist (no allow-all in srt) + -c without git-bash", () => {
  expect(JSON.parse(srtSettings("C:\\w", true, ["github.com", "*.npmjs.org"])).network).toEqual({
    allowedDomains: ["github.com", "*.npmjs.org"],
    deniedDomains: [],
    strictAllowlist: true, // the CLI has no ask callback; the allowlist is policy, not a prompt hint
  });
  const t = buildSandbox("srt", "x", "C:\\w", true, { exe: "srt.exe", settingsPath: "s.json", bash: null, scriptPath: null });
  expect(t.args).toEqual(["--settings", "s.json", "-c", "x"]);
});

test("srtScript restores the workspace cwd and single-quote-escapes the root path", () => {
  expect(srtScript("C:\\wo'rk", "echo hi")).toBe("cd 'C:\\wo'\\''rk' || exit 1\necho hi\n");
});

test("srt command scripts are unique and removed after their launch lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-srt-script-"));
  try {
    const secret = "TOKEN=must-not-remain";
    const first = writeEphemeralSrtScript(dir, "C:\\work", `echo ${secret}`);
    const second = writeEphemeralSrtScript(dir, "C:\\work", `echo ${secret}`);
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path, "utf8")).toContain(secret);
    first.cleanup();
    first.cleanup(); // idempotent close+error races
    second.cleanup();
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("srt startup purges legacy secret scripts and only old crash orphans", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-srt-purge-"));
  try {
    const legacy = join(dir, "cmd-012345abcdef.sh");
    const orphan = join(dir, "cmd-12-deadbeef.sh");
    const active = join(dir, "cmd-12-live.sh");
    writeFileSync(legacy, "legacy secret");
    writeFileSync(orphan, "orphan secret");
    writeFileSync(active, "active");
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(orphan, old, old);
    purgeStaleSrtScripts(dir);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(active)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destructiveInWorkspace fires on irreversible mass-deletion, not on ordinary commands", () => {
  // FIRES: the forms that irreversibly lose workspace data.
  for (const cmd of [
    "rm -rf src", "rm -r build", "rm -f keep.txt", "rm *.log", "rm -rf .git",
    "git clean -fdx", "git reset --hard HEAD~1", "git checkout -- .", "git checkout .",
    "find . -name '*.ts' -delete", "find . -type f -exec rm {} +",
    "python3 -c 'import shutil; shutil.rmtree(\"x\")'", "node -e 'fs.rmSync(\".\", {recursive:true})'",
    "shred -u secret", "truncate -s 0 db.sqlite",
  ]) {
    expect(destructiveInWorkspace(cmd)).not.toBeNull();
  }
  // DOES NOT fire: convenient everyday commands (incl. a plain single-file delete).
  for (const cmd of [
    "rm keep.txt", "ls -la", "cat README.md", "git status", "git commit -m x",
    "npm install", "bun test", "echo hello > out.txt", "grep -rf pattern .", "mkdir -p a/b",
  ]) {
    expect(destructiveInWorkspace(cmd)).toBeNull();
  }
});

test("plainTarget: git-bash runs `bash -c cmd`, else the raw command via the platform shell", () => {
  // Windows with a real bash found -> POSIX bash, so Unix idioms (heredocs, $VAR, pipes) work.
  expect(plainTarget("echo hi", "C:/Git/bin/bash.exe")).toEqual({
    file: "C:/Git/bin/bash.exe", args: ["-c", "echo hi"], shell: false,
  });
  // No bash (POSIX, or Windows without git-bash) -> hand the command to the platform shell as-is.
  expect(plainTarget("echo hi", null)).toEqual({ file: "echo hi", args: [], shell: true });
});

test("isDockerCommand detects docker/compose/podman (incl. sudo + env prefix), not lookalikes", () => {
  for (const cmd of ["docker build -t x .", "docker compose up", "docker-compose up -d", "podman run x",
                     "sudo docker ps", "DOCKER_BUILDKIT=1 docker build .", "  docker   run  x"]) {
    expect(isDockerCommand(cmd)).toBe(true);
  }
  for (const cmd of ["dockerize x", "echo docker", "ls && docker ps", "mydocker run", "git commit -m docker"]) {
    expect(isDockerCommand(cmd)).toBe(false);
  }
});

test("wrapBash never sandboxes a docker command, even when the sandbox is enabled", () => {
  // docker must reach the host daemon; sandboxing it just breaks it, so it runs unconfined.
  const t = wrapBash("docker build -t x .", "/w", { enabled: true, allowNetwork: false });
  if (process.platform === "win32" && findWindowsBash()) {
    expect(t.args).toEqual(["-c", "docker build -t x ."]);
  } else {
    expect(t).toEqual({ file: "docker build -t x .", args: [], shell: true });
  }
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
