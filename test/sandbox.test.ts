import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { buildSandbox, destructiveInWorkspace, detectSandbox, executableOnPath, findWindowsBash, formatSrtProbeFailure, isDockerCommand, normalizeSandboxDomains, plainTarget, purgeStaleSrtScripts, resolveSrtBunBridge, sandboxActive, srtHealthAsync, srtHealthCacheReusable, srtLaunchRefusal, srtScript, srtSettings, windowsSearchDirs, withSrtStateVolumeGuidance, wrapBash, writeEphemeralSrtBunShim, writeEphemeralSrtScript, writeEphemeralSrtSettings } from "../src/core/sandbox.ts";

test("one-call network domains are canonical, bounded, and never accept URLs or match-all", () => {
  expect(normalizeSandboxDomains([
    " Example.COM ", "example.com", "*.NPMJS.org:443", "registry:8443", "127.0.0.1:8080", "[::1]:443",
  ])).toEqual(["example.com", "*.npmjs.org:443", "registry:8443", "127.0.0.1:8080", "[::1]:443"]);
  for (const invalid of ["*", "https://example.com/x", "user@example.com", "example.com/path", "*.com", "2001:db8::1"]) {
    expect(() => normalizeSandboxDomains([invalid])).toThrow();
  }
  expect(() => normalizeSandboxDomains(Array.from({ length: 17 }, (_, i) => `h${i}.example.com`))).toThrow("at most 16");
});

test("security executables are resolved from PATH without trusting the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-path-primitive-"));
  const workspace = join(root, "repo");
  const trusted = join(root, "tools");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(trusted, { recursive: true });
    writeFileSync(join(workspace, "srt.exe"), "fake-workspace");
    writeFileSync(join(trusted, "srt.exe"), "trusted-path");
    expect(executableOnPath("srt.exe", [workspace, trusted].join(delimiter), workspace, "win32"))
      .toBe(realpathSync(join(trusted, "srt.exe")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bwrap confines fs to the workspace + blocks network by default", () => {
  const t = buildSandbox("bwrap", "echo hi", "/work", false);
  expect(t.file).toBe("bwrap");
  expect(t.shell).toBe(false);
  expect(t.args).toContain("--ro-bind"); // whole fs read-only
  expect(t.args.join(" ")).toContain("--bind /work /work"); // workspace read-write
  expect(t.args.join(" ")).toContain("--tmpfs /run"); // host daemon sockets are hidden
  expect(t.args).toContain("--unshare-net"); // no network
  expect(t.args).toContain("--unshare-pid"); // descendants die with the PID namespace
  expect(t.args).toContain("--as-pid-1");
  expect(t.args).toContain("--die-with-parent");
  expect(t.treeContainedOnClose).toBe(true);
  expect(t.args.slice(-3)).toEqual(["bash", "-c", "echo hi"]);
});

test("sandbox launch uses the exact primitive certified during discovery", () => {
  const certified = process.platform === "win32" ? "C:\\trusted\\bwrap.exe" : "/trusted/bin/bwrap";
  const target = buildSandbox("bwrap", "echo hi", "/work", false, undefined, certified, { shellExe: "/trusted/bin/bash" });
  expect(target.file).toBe(certified);
  expect(target.args.slice(-3)).toEqual(["/trusted/bin/bash", "-c", "echo hi"]);
});

test("bwrap keeps network when explicitly allowed", () => {
  expect(buildSandbox("bwrap", "x", "/w", true).args).not.toContain("--unshare-net");
});

test("ordinary sandbox profiles grant only explicit additional write roots", () => {
  const bwrap = buildSandbox("bwrap", "echo hi", "/work", false, undefined, "/usr/bin/bwrap", {
    shellExe: "/bin/bash",
    additionalWriteRoots: ["/home/me/.neko-core/research", "/data/shared"],
  });
  const bwrapArgs = bwrap.args.join(" ");
  expect(bwrapArgs).toContain("--bind /home/me/.neko-core/research /home/me/.neko-core/research");
  expect(bwrapArgs).toContain("--bind /data/shared /data/shared");

  const seatbelt = buildSandbox("sandbox-exec", "echo hi", "/work", false, undefined, "/usr/bin/sandbox-exec", {
    shellExe: "/bin/bash",
    additionalWriteRoots: ["/Users/me/.neko-core/research"],
  });
  expect(seatbelt.args[1]).toContain('(subpath "/Users/me/.neko-core/research")');

  const srt = JSON.parse(srtSettings(
    "C:\\work", false, [], [], ["C:\\work", "C:\\Users\\me\\.neko-core\\research"],
  ));
  expect(srt.filesystem.allowWrite).toEqual(["C:\\work", "C:\\Users\\me\\.neko-core\\research"]);
});

test("read-only bwrap uses isolated tmpfs and re-asserts a root nested below /tmp", () => {
  const t = buildSandbox("bwrap", "bun test", "/tmp/repo", false, undefined, "/usr/bin/bwrap", {
    readOnlyWorkspace: true,
    writableTemp: "/tmp/neko-validator-1",
  });
  const joined = t.args.join(" ");
  expect(joined).toContain("--tmpfs /tmp/neko-validator-1");
  expect(joined).toContain("--ro-bind /tmp/repo /tmp/repo");
  expect(joined).not.toContain("--bind /tmp /tmp");
  expect(joined).not.toContain("--bind /tmp/repo /tmp/repo");
});

test("sandbox profiles hide trusted benchmark implementation files", () => {
  const hidden = process.platform === "win32" ? "C:\\host\\neko-core\\frontier-bench.ts" : "/host/neko-core/frontier-bench.ts";
  const bwrap = buildSandbox("bwrap", "bun test", "/tmp/trial", false, undefined, "/usr/bin/bwrap", {
    shellExe: "/bin/bash",
    denyReadFiles: [hidden],
  });
  expect(bwrap.args.join(" ")).toContain(`--ro-bind /dev/null ${hidden}`);

  const seatbelt = buildSandbox("sandbox-exec", "bun test", "/tmp/trial", false, undefined, "/usr/bin/sandbox-exec", {
    shellExe: "/bin/bash",
    denyReadFiles: [hidden],
  });
  expect(seatbelt.args[1]).toContain(`(deny file-read* (literal "${hidden}"))`);

  const srt = JSON.parse(srtSettings("C:\\trial", false, [], [], ["C:\\trial"], [], [hidden]));
  expect(srt.filesystem.denyRead).toEqual([hidden]);
});

test("sandbox-exec profile confines writes + denies network", () => {
  const t = buildSandbox("sandbox-exec", "echo hi", "/work", false, undefined, undefined, { shellExe: "/bin/bash" });
  expect(t.file).toBe("sandbox-exec");
  expect(t.args[1]).toContain("deny file-write*");
  expect(t.args[1]).toContain('(subpath "/work")');
  expect(t.args[1]).toContain("/var/run/docker.sock");
  expect(t.args[1]).toContain("deny network*");
  expect(t.args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
});

test("read-only Seatbelt allows only unique temp writes and explicitly denies a root below /tmp", () => {
  const t = buildSandbox("sandbox-exec", "bun test", "/tmp/repo", false, undefined, "/usr/bin/sandbox-exec", {
    readOnlyWorkspace: true,
    writableTemp: "/tmp/neko-validator-1",
  });
  const profile = t.args[1];
  expect(profile).toContain('(allow file-write* (subpath "/tmp/neko-validator-1")');
  expect(profile).toContain('(deny file-write* (subpath "/tmp/repo"))');
  expect(profile).not.toContain('(subpath "/private/tmp")');
});

test("oracle Seatbelt profile can deny target forks while ordinary validators retain subprocesses", () => {
  const ordinary = buildSandbox("sandbox-exec", "bun test", "/tmp/repo", false, undefined, "/usr/bin/sandbox-exec", {
    readOnlyWorkspace: true,
    writableTemp: "/tmp/neko-validator-1",
    shellExe: "/bin/bash",
  });
  const oracle = buildSandbox("sandbox-exec", "exec /usr/bin/bun test.mjs", "/tmp/repo", false, undefined, "/usr/bin/sandbox-exec", {
    readOnlyWorkspace: true,
    writableTemp: "/tmp/neko-validator-2",
    shellExe: "/bin/bash",
    denyChildProcesses: true,
  });
  expect(ordinary.args[1]).not.toContain("deny process-fork");
  expect(ordinary.args[1]).not.toContain("deny signal");
  expect(ordinary.treeContainedOnClose).toBeUndefined();
  expect(oracle.args[1]).toContain("(deny process-fork)");
  expect(oracle.args[1]).toContain("(deny signal)");
  expect(oracle.args[1]).toContain("(allow signal (target same-sandbox))");
  expect(oracle.treeContainedOnClose).toBe(true);
});

test("srt runs bash via a script file + confines writes + hard-blocks network by default", () => {
  const launch = { exe: "C:\\bin\\srt.exe", settingsPath: "C:\\tmp\\s.json", bash: "C:\\Git\\bin\\bash.exe", scriptPath: "C:\\tmp\\cmd-1.sh" };
  expect(buildSandbox("srt", "echo hi", "C:\\work", false, launch)).toEqual({
    file: "C:\\bin\\srt.exe",
    // Command bytes live in the script FILE; the -c line carries only two quoted paths.
    args: ["--settings", "C:\\tmp\\s.json", "-c", '"C:\\Git\\bin\\bash.exe" "C:\\tmp\\cmd-1.sh"'],
    shell: false,
    treeContainedOnClose: true,
  });
  const s = JSON.parse(srtSettings("C:\\work", false));
  expect(s.filesystem).toEqual({ denyRead: [], allowRead: [], allowWrite: ["C:\\work"], denyWrite: [] });
  expect(s.network).toEqual({ allowedDomains: [], deniedDomains: ["*"] }); // hard block, denied checked first
});

test("read-only SRT explicitly denies the project and permits only unique temp writes", () => {
  const root = "E:\\tmp\\repo";
  const temp = "E:\\tmp\\neko-validator-1";
  const bun = "C:\\tools\\bun.exe";
  const s = JSON.parse(srtSettings(root, false, [], [root, bun], [temp], [root]));
  expect(s.filesystem).toEqual({
    denyRead: [],
    allowRead: [root, bun],
    allowWrite: [temp],
    denyWrite: [root],
  });
});

test("srt grants only the exact trusted Bun file and derives its Git-Bash bridge from that path", () => {
  const bun = "C:\\Users\\O'Brien\\tools\\bun.exe";
  const settings = JSON.parse(srtSettings("C:\\work", false, [], [bun]));
  expect(settings.filesystem.allowRead).toEqual([bun]);
  expect(settings.filesystem.allowRead).not.toContain("C:\\Users\\O'Brien\\tools");

  const script = srtScript("C:\\work", "bun --version", bun);
  expect(script).toContain("bun() { '/c/Users/O'\\''Brien/tools/bun.exe' \"$@\"; }");
  expect(script).toContain("export -f bun");
  expect(script).toContain("export NEKO_SRT_BUN_EXE='C:\\Users\\O'\\''Brien\\tools\\bun.exe'");
  expect(script).toContain("export NoDefaultCurrentDirectoryInExePath=1");
  expect(script.endsWith("bun --version\n")).toBe(true);
});

test.skipIf(process.platform !== "win32")("the SRT Bun bridge rejects workspace spoofing and freezes the accepted external identity", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-srt-bun-resolve-"));
  const workspace = join(root, "repo");
  const trusted = join(root, "trusted");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(trusted, { recursive: true });
    const spoof = join(workspace, "bun.exe");
    const external = join(trusted, "bun.exe");
    writeFileSync(spoof, "spoof");
    writeFileSync(external, "trusted");
    // Empty PATH/APPDATA/profile keep the resolution hermetic: only the explicit candidates run.
    expect(resolveSrtBunBridge(workspace, spoof, "", "win32", "", "")).toBeNull();
    const bridge = resolveSrtBunBridge(workspace, external, "", "win32", "", "");
    expect(bridge?.path).toBe(external);
    expect(bridge?.source).toBe("runtime");
    expect(Object.isFrozen(bridge)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("the SRT Bun bridge resolves npm-shim installs for compiled Neko (bun.cmd on PATH, real exe under node_modules)", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-srt-bun-npm-"));
  const workspace = join(root, "repo");
  const npmBin = join(root, "npm");
  const nested = join(npmBin, "node_modules", "bun", "bin");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(npmBin, "bun.cmd"), "@echo off\r\n");
    writeFileSync(join(nested, "bun.exe"), "real");
    // Git-Bash style PATH (POSIX drive mounts, colon-separated) must resolve identically.
    const posixPath = npmBin.replace(/^([A-Za-z]):[\\/]/, (_m, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/");
    const compiled = "C:\\neko\\dist\\neko.exe";
    const bridge = resolveSrtBunBridge(workspace, compiled, posixPath, "win32", "", "");
    expect(bridge?.path).toBe(nested + "\\bun.exe");
    expect(bridge?.source).toBe("npm-global");
    // Windows-style PATH finds the same bridge.
    const winBridge = resolveSrtBunBridge(workspace, compiled, npmBin, "win32", "", "");
    expect(winBridge?.source).toBe("npm-global");
    // APPDATA convention works even when npm is not on PATH at all.
    const appdataBridge = resolveSrtBunBridge(workspace, compiled, "", "win32", root, "");
    expect(appdataBridge?.path).toBe(nested + "\\bun.exe");
    expect(appdataBridge?.source).toBe("npm-global");
    // A bun.exe inside the workspace is never promoted, even via the npm layout.
    const wsNpm = join(workspace, "npm");
    const wsNested = join(wsNpm, "node_modules", "bun", "bin");
    mkdirSync(wsNested, { recursive: true });
    writeFileSync(join(wsNpm, "bun.cmd"), "@echo off\r\n");
    writeFileSync(join(wsNested, "bun.exe"), "spoof");
    expect(resolveSrtBunBridge(workspace, compiled, `${npmBin}${delimiter}${wsNpm}`, "win32", "", "")?.path).toBe(nested + "\\bun.exe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("the SRT Bun bridge resolves the official installer layout (~/.bun/bin)", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-srt-bun-official-"));
  const workspace = join(root, "repo");
  const bunBin = join(root, "home", ".bun", "bin");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    writeFileSync(join(bunBin, "bun.exe"), "official");
    const bridge = resolveSrtBunBridge(workspace, "C:\\neko\\dist\\neko.exe", "", "win32", "", join(root, "home"));
    expect(bridge?.path).toBe(join(bunBin, "bun.exe"));
    expect(bridge?.source).toBe("official-installer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("windowsSearchDirs understands Git-Bash POSIX PATH and Windows PATH", () => {
  const posix = "/c/Users/Admin/AppData/Roaming/npm:/usr/bin:/mingw64/bin";
  expect(windowsSearchDirs(posix)).toEqual([
    "C:\\Users\\Admin\\AppData\\Roaming\\npm",
    "\\usr\\bin",
    "\\mingw64\\bin",
  ]);
  expect(windowsSearchDirs("C:\\tools;D:\\bin")).toEqual(["C:\\tools", "D:\\bin"]);
  expect(windowsSearchDirs("")).toEqual([]);
});

test("a live Windows SRT exposes its exact Bun bridge and cleans all launch material", () => {
  const bridge = process.platform === "win32" ? resolveSrtBunBridge(process.cwd()) : null;
  if (process.platform !== "win32" || detectSandbox() !== "srt" || !sandboxActive() || !bridge) return;
  const target = wrapBash("bun --version", process.cwd(), { enabled: true, allowNetwork: false });
  const launchDir = target.env?.PATH?.split(delimiter)[0] ?? "";
  try {
    expect(target.env?.NEKO_SRT_BUN_EXE).toBe(bridge.path);
    expect(target.env?.NoDefaultCurrentDirectoryInExePath).toBe("1");
    expect(readFileSync(join(launchDir, "bun.cmd"), "utf8")).toBe('@"%NEKO_SRT_BUN_EXE%" %*\r\n');
    const result = spawnSync(target.file, target.args, {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000, windowsHide: true,
      env: { ...process.env, ...target.env },
    });
    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe(Bun.version);
  } finally {
    target.cleanup?.();
  }
  expect(existsSync(launchDir)).toBe(false);
}, 25_000);

test("srt network allow = the sandbox_domains allowlist (no allow-all in srt) + -c without git-bash", () => {
  expect(JSON.parse(srtSettings("C:\\w", true, ["github.com", "*.npmjs.org"])).network).toEqual({
    allowedDomains: ["github.com", "*.npmjs.org"],
    deniedDomains: [],
    strictAllowlist: true, // the CLI has no ask callback; the allowlist is policy, not a prompt hint
  });
  const t = buildSandbox("srt", "x", "C:\\w", true, { exe: "srt.exe", settingsPath: "s.json", bash: null, scriptPath: null });
  expect(t.args).toEqual(["--settings", "s.json", "-c", "x"]);
});

test("an enabled but unhealthy SRT is refused before launch, while other postures are not", () => {
  expect(srtLaunchRefusal(true, "srt", { ok: false, detail: "state DB unavailable" }))
    .toBe("Error: configured SRT sandbox is unusable; bash was not executed: state DB unavailable");
  expect(srtLaunchRefusal(true, "srt", { ok: true, detail: "healthy" })).toBeNull();
  expect(srtLaunchRefusal(false, "srt", { ok: false, detail: "down" })).toBeNull();
  expect(srtLaunchRefusal(true, "none", { ok: false, detail: "absent" })).toBeNull();
});

test("an SRT health-probe timeout retries the exact sandbox instead of creating a false refusal", () => {
  expect(srtLaunchRefusal(true, "srt", {
    ok: false,
    detail: "status=null signal=SIGTERM code=ETIMEDOUT timeout=true elapsed_ms=20060",
  })).toBeNull();
  expect(srtLaunchRefusal(true, "srt", {
    ok: false,
    detail: "credential store unavailable",
  })).toContain("bash was not executed");
});

test("SRT health failures expose timeout and signal details instead of exit question-mark", () => {
  const error = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
  expect(formatSrtProbeFailure({ status: null, signal: "SIGTERM", error, stdout: "", stderr: "" }, 20_017))
    .toBe("status=null signal=SIGTERM code=ETIMEDOUT timeout=true elapsed_ms=20017");
  expect(formatSrtProbeFailure({ status: null, signal: "SIGTERM", error, stdout: "starting", stderr: "" }, 20_017))
    .toBe("starting; status=null signal=SIGTERM code=ETIMEDOUT timeout=true elapsed_ms=20017");
  expect(formatSrtProbeFailure({ status: 1, signal: null, stdout: "", stderr: "account unavailable\n" }, 83))
    .toBe("account unavailable");
});

test("a failed SRT health result expires while a healthy result stays reusable", () => {
  const failed = { result: { ok: false, detail: "timeout" }, checkedAt: 1_000 };
  expect(srtHealthCacheReusable(failed, 30_999)).toBe(true);
  expect(srtHealthCacheReusable(failed, 31_000)).toBe(false);
  expect(srtHealthCacheReusable({ result: { ok: true, detail: "healthy" }, checkedAt: 1_000 }, 9_999_999)).toBe(true);
});

test("an aborted interactive turn does not wait for an SRT health probe", async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = performance.now();
  const result = await srtHealthAsync(controller.signal);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("interrupted");
  expect(performance.now() - startedAt).toBeLessThan(100);
});

test("an SRT SQLite shared-memory failure gives safe disk-space recovery guidance", () => {
  const out = srtLaunchRefusal(true, "srt", {
    ok: false,
    detail: "disk I/O error: Error code 4874: I/O error within the xShmMap method",
  })!;
  expect(out).toContain("%LOCALAPPDATA%");
  expect(out).toContain("may be full");
  expect(out).toContain("free disk space");
  expect(out).toContain("re-run `neko doctor`");
  expect(out).not.toMatch(/move LOCALAPPDATA|copy.*state\.db|acl recover|reinstall|delete/i);

  const launchFailure = withSrtStateVolumeGuidance(
    "(exit 1 -- command FAILED)\nSQLite error 4874 in xShmMap (SQLITE_IOERR_SHMSIZE)",
  );
  expect(launchFailure).toContain("%LOCALAPPDATA%");
  expect(withSrtStateVolumeGuidance(launchFailure)).toBe(launchFailure);
});

test("srtScript restores the workspace cwd and single-quote-escapes the root path", () => {
  expect(srtScript("C:\\wo'rk", "echo hi")).toBe("cd 'C:\\wo'\\''rk' || exit 1\necho hi\n");
});

test("srt settings ignore a poisoned deterministic temp file and clean up unique atomic material", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-srt-settings-"));
  try {
    const json = srtSettings("C:\\work", false, []);
    // Regression: the old content-addressed writer reused this predictable path without checking it.
    const poisoned = join(dir, `neko-srt-${createHash("sha256").update(json).digest("hex").slice(0, 12)}.json`);
    writeFileSync(poisoned, '{"network":"attacker-controlled"}', "utf8");

    const first = writeEphemeralSrtSettings(dir, "C:\\work", false, []);
    const second = writeEphemeralSrtSettings(dir, "C:\\work", false, []);
    expect(first.path).not.toBe(poisoned);
    expect(first.path).not.toBe(second.path);
    expect(lstatSync(first.path).isFile()).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe(json);
    expect(readFileSync(poisoned, "utf8")).toContain("attacker-controlled");

    first.cleanup();
    first.cleanup(); // close/error races are idempotent
    second.cleanup();
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live Windows SRT can write an exact additional root without host fallback", () => {
  if (process.platform !== "win32" || detectSandbox() !== "srt" || !sandboxActive()) return;
  const extra = mkdtempSync(join(tmpdir(), "neko-srt-extra-write-"));
  const output = join(extra, "canary.txt");
  const posix = output
    .replace(/^([A-Za-z]):[\\/]/, (_all, drive: string) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, "/");
  const target = wrapBash(`printf 'NEKO_SRT_EXTRA_ROOT_OK\\n' > '${posix}'`, process.cwd(), {
    enabled: true,
    allowNetwork: false,
    additionalWriteRoots: [extra],
  });
  try {
    const result = spawnSync(target.file, target.args, {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsHide: true,
      env: { ...process.env, ...target.env },
    });
    expect(result.status, String(result.stderr || result.stdout)).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("NEKO_SRT_EXTRA_ROOT_OK\n");
  } finally {
    target.cleanup?.();
    rmSync(extra, { recursive: true, force: true });
  }
}, 40_000);

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

test("the SRT child-process Bun shim is fixed, launch-local, and removed idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "neko-srt-bun-shim-"));
  try {
    const shim = writeEphemeralSrtBunShim(dir);
    const body = readFileSync(shim.path, "utf8");
    expect(shim.path).toBe(join(dir, "bun.cmd"));
    expect(body).toBe('@"%NEKO_SRT_BUN_EXE%" %*\r\n');
    expect(body).not.toContain("Users");
    shim.cleanup();
    shim.cleanup();
    expect(existsSync(shim.path)).toBe(false);
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

test("isDockerCommand detects direct and common shell-wrapped host-daemon CLIs", () => {
  for (const cmd of ["docker build -t x .", "docker compose up", "docker-compose up -d", "podman run x",
                     "sudo docker ps", "DOCKER_BUILDKIT=1 docker build .", "  docker   run  x",
                     "env FOO=1 docker ps", "bash -lc 'docker ps'", "cmd /c docker ps",
                     "powershell -Command docker ps", "ls && docker ps", "/usr/bin/podman ps"]) {
    expect(isDockerCommand(cmd)).toBe(true);
  }
  for (const cmd of ["dockerize x", "echo docker", "mydocker run", "git commit -m docker"]) {
    expect(isDockerCommand(cmd)).toBe(false);
  }
});

test("wrapBash only exposes a host daemon after the explicit capability override", () => {
  const contained = wrapBash("docker build -t x .", "/w", { enabled: true, allowNetwork: false });
  if (detectSandbox() !== "none") expect(contained.file.toLowerCase()).not.toContain("bash");
  contained.cleanup?.();

  const t = wrapBash("docker build -t x .", "/w", { enabled: true, allowNetwork: false, allowHostDaemon: true });
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
