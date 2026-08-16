import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  buildTrustedExecutablePath,
  buildHarborArgs,
  cleanupHarborStaging,
  collectBuildIdentity,
  gitProvenanceEnv,
  hardenPrivateHarborRoot,
  harborProcessEnv,
  HARBOR_LEASE_MARGIN_MS,
  HARBOR_RUN_DEADLINE_MS,
  HARBOR_HOST_RUNNER_BASENAME,
  HARBOR_RUNNER_HOME_ENV,
  HARBOR_VERSION,
  parseHarborEvalArgs,
  preflightDockerCompose,
  resolveDockerComposeProgramFiles,
  resolveEvalIdentity,
  resolveHarborExecutables,
  stageHarborHostGrant,
  TERMINAL_BENCH_2_1_DATASET,
  type HarborBuildIdentity,
} from "../scripts/harbor-eval.ts";
import { isBool } from "../src/shared/wire.ts";

const digest = (character: string) => character.repeat(64);
const buildIdentity: HarborBuildIdentity = {
  runnerPath: join("C:/work", HARBOR_HOST_RUNNER_BASENAME),
  runnerSha256: digest("a"),
  runnerSourceSha256: digest("b"),
  launcherSourceSha256: digest("c"),
  hostAgentSha256: digest("d"),
  remoteToolsSha256: digest("e"),
  sourceRevision: "0123456789abcdef0123456789abcdef01234567",
  sourceDirty: true,
  buildBunVersion: "1.3.5",
};
const kimiIdentity = { profile: "kimi", provider: "kimi", model: "kimi/kimi-for-coding" } as const;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Harbor evaluation launcher", () => {
  test("defaults to one frozen public Terminal-Bench 2.1 task", () => {
    expect(parseHarborEvalArgs([])).toEqual({
      limit: 1,
      reasoningEffort: "max",
      maxSteps: 40,
      adaptiveEffort: false,
      loop: true,
      passthrough: [],
    });
  });

  test("canonicalizes only safe include/exclude, attempt, concurrency, and confirmation flags", () => {
    const options = parseHarborEvalArgs([
      "--profile", "kimi",
      "--limit", "3",
      "--",
      "-i", "make-*",
      "-x", "skip-*",
      "-k", "3",
      "-n", "2",
      "--n-concurrent-agents", "1",
      "-y",
    ]);
    expect(options.profile).toBe("kimi");
    expect(options.limit).toBe(3);
    expect(options.passthrough).toEqual([
      "--include-task-name", "terminal-bench/make-*",
      "--exclude-task-name", "terminal-bench/skip-*",
      "--n-attempts", "3",
      "--n-concurrent", "2",
      "--n-concurrent-agents", "1",
      "--yes",
    ]);
    expect(() => parseHarborEvalArgs(["--limit", "0"])).toThrow("positive integer");
    expect(() => parseHarborEvalArgs(["--", "--n-attempts", "0"])).toThrow("positive integer");
  });

  test("rejects passthrough authority, budget, agent, model, and environment overrides", () => {
    const refused = [
      ["--agent", "oracle"],
      ["--agent-kwarg", "runner_path=other"],
      ["--agent-env", "NEKO_API_KEY=secret"],
      ["--allow-agent-host", "example.com"],
      ["--env", "islo"],
      ["--environment-kwarg", "x=y"],
      ["--model", "other/model"],
      ["--dataset", "other/dataset"],
      ["--config", "job.json"],
      ["--timeout-multiplier", "2"],
      ["--n-tasks", "50"],
      ["--max-retries", "5"],
      ["--task", "terminal-bench/make-mips-interpreter"],
      ["-t", "terminal-bench/make-mips-interpreter"],
    ];
    for (const args of refused) {
      expect(() => parseHarborEvalArgs(["--", ...args])).toThrow("not allowed");
    }
  });

  test("parses and validates the frozen Neko behavior settings", () => {
    const options = parseHarborEvalArgs([
      "--effort", "xhigh",
      "--max-steps", "64",
      "--adaptive-effort",
      "--no-loop",
    ]);
    expect(options.reasoningEffort).toBe("xhigh");
    expect(options.maxSteps).toBe(64);
    expect(options.adaptiveEffort).toBe(true);
    expect(options.loop).toBe(false);
    expect(() => parseHarborEvalArgs(["--max-steps", "2.5"])).toThrow("positive integer");
    expect(() => parseHarborEvalArgs(["--effort", "high;echo"])).toThrow("effort tier");
  });

  test("refuses every attempt to replace the pinned public dataset", () => {
    expect(() => parseHarborEvalArgs([
      "--dataset", "terminal-bench/terminal-bench-2",
    ])).toThrow("Unknown option --dataset");
    expect(() => parseHarborEvalArgs([
      "--", "--dataset", "terminal-bench/terminal-bench-2",
    ])).toThrow("not allowed");
  });

  test("rejects the single-task shortcut before and after the passthrough separator", () => {
    expect(() => parseHarborEvalArgs(["--task", "terminal-bench/make-mips-interpreter"]))
      .toThrow("Unknown option --task");
    expect(() => parseHarborEvalArgs(["-t", "terminal-bench/make-mips-interpreter"]))
      .toThrow("Unknown option -t");
    expect(() => parseHarborEvalArgs(["--", "--task", "terminal-bench/make-mips-interpreter"]))
      .toThrow("not allowed");
    expect(() => parseHarborEvalArgs(["--", "-t", "terminal-bench/make-mips-interpreter"]))
      .toThrow("not allowed");
  });

  test("binds each allowed profile to one provider and Harbor model prefix", () => {
    expect(resolveEvalIdentity(
      parseHarborEvalArgs(["--profile", "chatgpt"]),
      {},
      {},
    )).toEqual({ profile: "chatgpt", provider: "chatgpt", model: "openai/gpt-5.6-sol" });
    expect(resolveEvalIdentity(
      parseHarborEvalArgs(["--profile", "chatgpt", "--model", "gpt-5.6-luna"]),
      {},
      {},
    )).toEqual({ profile: "chatgpt", provider: "chatgpt", model: "openai/gpt-5.6-luna" });
    expect(resolveEvalIdentity(
      parseHarborEvalArgs(["--profile", "kimi"]),
      {},
      {},
    )).toEqual(kimiIdentity);
    expect(() => resolveEvalIdentity(
      parseHarborEvalArgs(["--profile", "kimi", "--model", "openai/gpt-5.6-luna"]),
      {},
      {},
    )).toThrow("requires a kimi/ model");
    expect(() => resolveEvalIdentity(
      parseHarborEvalArgs(["--profile", "chatgpt"]),
      { profiles: { chatgpt: { provider: "openai_compat" } } },
      {},
    )).toThrow("must use provider chatgpt");
    expect(() => resolveEvalIdentity(
      parseHarborEvalArgs(["--profile", "other"]),
      {},
      {},
    )).toThrow("not allowed");
  });

  test("pins Harbor and passes the complete host-runner identity without legacy upload paths", () => {
    const options = parseHarborEvalArgs(["--profile", "kimi"]);
    const args = buildHarborArgs({
      options,
      ...kimiIdentity,
      buildIdentity,
      jobsDir: resolve("jobs"),
    });
    expect(args.slice(0, 7)).toEqual([
      "--isolated", "--no-env-file", "--no-config",
      "--from", `harbor==${HARBOR_VERSION}`, "harbor", "run",
    ]);
    expect(args[args.indexOf("--jobs-dir") + 1]).toBe(resolve("jobs"));
    expect(args[args.indexOf("-d") + 1]).toBe(TERMINAL_BENCH_2_1_DATASET);
    expect(args).toContain("evals.harbor.neko_host_agent:NekoHostAgent");
    expect(args).toContain(`runner_path=${buildIdentity.runnerPath}`);
    expect(args).toContain(`runner_sha256=${buildIdentity.runnerSha256}`);
    expect(args).toContain(`runner_source_sha256=${buildIdentity.runnerSourceSha256}`);
    expect(args).toContain(`launcher_source_sha256=${buildIdentity.launcherSourceSha256}`);
    expect(args).toContain(`host_agent_sha256=${buildIdentity.hostAgentSha256}`);
    expect(args).toContain(`remote_tools_sha256=${buildIdentity.remoteToolsSha256}`);
    expect(args).toContain("profile=kimi");
    expect(args).toContain("reasoning_effort=max");
    expect(args).toContain("max_steps=40");
    expect(args).toContain("adaptive_effort=false");
    expect(args).toContain("loop=true");
    expect(args).toContain(`source_revision=${buildIdentity.sourceRevision}`);
    expect(args).toContain("source_dirty=true");
    expect(args).toContain(`dataset_request=${TERMINAL_BENCH_2_1_DATASET}`);
    expect(args).toContain("kimi/kimi-for-coding");
    const serialized = args.join(" ");
    expect(serialized).not.toContain("evals.harbor.neko_agent:NekoAgent");
    expect(serialized).not.toContain("binary_path=");
    expect(serialized).not.toContain("binary_sha256=");
    expect(serialized).not.toContain("codex_path=");
    expect(serialized).not.toContain("auth_path=");
    expect(serialized).not.toContain(HARBOR_RUNNER_HOME_ENV);
    expect(serialized).not.toContain("--agent-env");
  });

  test("passes the selected host Codex digest for ChatGPT without exposing its path", () => {
    const args = buildHarborArgs({
      options: parseHarborEvalArgs(["--profile", "chatgpt"]),
      profile: "chatgpt",
      provider: "chatgpt",
      model: "openai/gpt-5.6-luna",
      buildIdentity: { ...buildIdentity, codexSha256: digest("f") },
      jobsDir: resolve("jobs"),
    });
    expect(args).toContain(`codex_sha256=${digest("f")}`);
    expect(args.join(" ")).not.toContain("codex_path=");
  });

  test("hashes the canonical runner, control bridges, and actually selected Codex executable", () => {
    const root = realpathSync.native(resolve(import.meta.dir, ".."));
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-identity-")));
    try {
      const runner = join(temporary, HARBOR_HOST_RUNNER_BASENAME);
      const codex = join(temporary, process.platform === "win32" ? "codex.exe" : "codex");
      writeFileSync(runner, "runner-bits");
      writeFileSync(codex, "codex-bits");
      const identity = collectBuildIdentity(root, runner, "chatgpt", {
        launcherCwd: temporary,
        discoverCodex: () => ({
          state: "ready",
          detail: "fixture",
          executable: { path: codex, kind: "app-server", source: "environment", version: "0.144.1" },
        }),
      });
      expect(identity.runnerPath).toBe(realpathSync.native(runner));
      expect(identity.runnerSha256).toBe(sha256(runner));
      expect(identity.codexSha256).toBe(sha256(codex));
      expect(identity.runnerSourceSha256).toBe(sha256(join(root, "evals", "harbor", "host_runner.ts")));
      expect(identity.launcherSourceSha256).toBe(sha256(join(root, "scripts", "harbor-eval.ts")));
      expect(identity.hostAgentSha256).toBe(sha256(join(root, "evals", "harbor", "neko_host_agent.py")));
      expect(identity.remoteToolsSha256).toBe(sha256(join(root, "evals", "harbor", "remote_tools.py")));
      expect(identity.sourceRevision).toMatch(/^[a-f0-9]{40,64}$/);
      expect(isBool(identity.sourceDirty)).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("rejects a hard-linked or wrong-basename runner before Harbor starts", () => {
    const root = realpathSync.native(resolve(import.meta.dir, ".."));
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-links-")));
    try {
      const runner = join(temporary, HARBOR_HOST_RUNNER_BASENAME);
      writeFileSync(runner, "runner-bits");
      linkSync(runner, join(temporary, "runner-hard-link"));
      expect(() => collectBuildIdentity(root, runner, "kimi", { launcherCwd: temporary })).toThrow("single-link");

      const wrongName = join(temporary, process.platform === "win32" ? "other.exe" : "other");
      writeFileSync(wrongName, "other-bits");
      expect(() => collectBuildIdentity(root, wrongName, "kimi", { launcherCwd: temporary })).toThrow("basename");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("stages only a bounded access-only ChatGPT lease and digest-pinned bridge", () => {
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-grant-test-")));
    try {
      const sourceRoot = join(temporary, "source");
      const privateRoot = join(temporary, "private");
      mkdirSync(join(sourceRoot, "evals", "harbor"), { recursive: true });
      mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
      mkdirSync(privateRoot);
      const sourceFiles = {
        runnerSourceSha256: join(sourceRoot, "evals", "harbor", "host_runner.ts"),
        launcherSourceSha256: join(sourceRoot, "scripts", "harbor-eval.ts"),
        hostAgentSha256: join(sourceRoot, "evals", "harbor", "neko_host_agent.py"),
        remoteToolsSha256: join(sourceRoot, "evals", "harbor", "remote_tools.py"),
      };
      for (const [name, path] of Object.entries(sourceFiles)) writeFileSync(path, `fixture:${name}`);
      const codex = join(temporary, process.platform === "win32" ? "codex-app-server.exe" : "codex-app-server");
      writeFileSync(codex, "fixture-codex");
      const now = 1_900_000_000_000;
      const expiresAt = now + HARBOR_RUN_DEADLINE_MS + HARBOR_LEASE_MARGIN_MS;
      const identity: HarborBuildIdentity = {
        ...buildIdentity,
        runnerSourceSha256: sha256(sourceFiles.runnerSourceSha256),
        launcherSourceSha256: sha256(sourceFiles.launcherSourceSha256),
        hostAgentSha256: sha256(sourceFiles.hostAgentSha256),
        remoteToolsSha256: sha256(sourceFiles.remoteToolsSha256),
        codexSha256: sha256(codex),
      };
      const grant = stageHarborHostGrant({
        privateRoot,
        sourceRoot,
        buildIdentity: identity,
        codexStatus: {
          state: "ready",
          detail: "fixture",
          executable: { path: realpathSync.native(codex), kind: "app-server", source: "environment", version: "0.145.0" },
        },
        credentials: {
          accessToken: "access-only-sentinel",
          refreshToken: "durable-refresh-must-not-copy",
          expiresAt,
          accountId: "acct-fixture",
        },
        now,
      });
      const authDir = join(grant.runnerHome, ".neko-core");
      expect(readdirSync(authDir)).toEqual(["chatgpt-auth.json"]);
      const authBytes = readFileSync(join(authDir, "chatgpt-auth.json"), "utf8");
      expect(JSON.parse(authBytes)).toEqual({
        accessToken: "access-only-sentinel",
        refreshToken: "",
        expiresAt,
        accountId: "acct-fixture",
      });
      expect(authBytes).not.toContain("durable-refresh-must-not-copy");
      const manifest = readFileSync(join(grant.runnerHome, ".neko-harbor-host-grant.json"), "utf8");
      expect(manifest).not.toContain("access-only-sentinel");
      expect(manifest).not.toContain("durable-refresh-must-not-copy");
      const harborArgs = buildHarborArgs({
        options: parseHarborEvalArgs(["--profile", "chatgpt", "--model", "gpt-5.6-sol"]),
        profile: "chatgpt",
        provider: "chatgpt",
        model: "openai/gpt-5.6-sol",
        buildIdentity: identity,
        jobsDir: resolve("jobs"),
      }).join(" ");
      expect(harborArgs).not.toContain(privateRoot);
      expect(harborArgs).not.toContain(realpathSync.native(codex));
      expect(harborArgs).not.toContain(HARBOR_RUNNER_HOME_ENV);
      expect(readdirSync(join(grant.bridgePath, "evals", "harbor")).sort()).toEqual([
        "__init__.py", "host_runner.ts", "neko_host_agent.py", "remote_tools.py",
      ]);

      const tooShort = join(temporary, "too-short");
      mkdirSync(tooShort);
      expect(() => stageHarborHostGrant({
        privateRoot: tooShort,
        sourceRoot,
        buildIdentity: identity,
        codexStatus: {
          state: "ready",
          detail: "fixture",
          executable: { path: realpathSync.native(codex), kind: "app-server", source: "environment", version: "0.145.0" },
        },
        credentials: { accessToken: "access", refreshToken: "refresh", expiresAt: expiresAt - 1, accountId: "acct" },
        now,
      })).toThrow("cannot cover");
      expect(() => stageHarborHostGrant({
        privateRoot: tooShort,
        sourceRoot,
        buildIdentity: identity,
        codexStatus: {
          state: "ready",
          detail: "fixture",
          executable: { path: realpathSync.native(codex), kind: "app-server", source: "environment", version: "0.145.0" },
        },
        credentials: { accessToken: "access", refreshToken: "refresh", expiresAt: expiresAt + 0.5, accountId: "acct" },
        now,
      })).toThrow("cannot cover");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" && process.env.CI === "true"
    && process.env.NEKO_REQUIRE_WINDOWS_ACL_TEST !== "1")(
    "hardens the private staging root before credential material exists",
    () => {
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-private-test-")));
    try {
      expect(hardenPrivateHarborRoot(temporary)).toBe(temporary);
      if (process.platform !== "win32") expect(statSync(temporary).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    }, { timeout: 60_000 });

  test("removes both bounded Harbor staging roots", () => {
    const privateRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-private-")));
    const buildRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-eval-")));
    writeFileSync(join(privateRoot, "credential-sentinel"), "private");
    writeFileSync(join(buildRoot, "runner-sentinel"), "build");

    cleanupHarborStaging(privateRoot, buildRoot);

    expect(existsSync(privateRoot)).toBe(false);
    expect(existsSync(buildRoot)).toBe(false);
  });

  test("attempts both bounded cleanup targets and reports only a generic failure", () => {
    const privateRoot = join(realpathSync.native(tmpdir()), "neko-harbor-private-cleanup-fixture");
    const buildRoot = join(realpathSync.native(tmpdir()), "neko-harbor-eval-cleanup-fixture");
    const attempted: string[] = [];
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const remove = ((target: Parameters<typeof rmSync>[0]) => {
      attempted.push(String(target));
      if (String(target) === privateRoot) throw new Error("sensitive cleanup detail");
    }) as typeof rmSync;

    expect(() => cleanupHarborStaging(privateRoot, buildRoot, remove, () => {}))
      .toThrow("Harbor temporary staging cleanup failed.");
    expect(attempted).toEqual([...Array(8).fill(privateRoot), buildRoot]);
  });

  test("retries transient staging locks with bounded launcher backoff", () => {
    const privateRoot = join(realpathSync.native(tmpdir()), "neko-harbor-private-retry-fixture");
    const buildRoot = join(realpathSync.native(tmpdir()), "neko-harbor-eval-retry-fixture");
    const attempted: string[] = [];
    const delays: number[] = [];
    let buildFailures = 3;
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const remove = ((target: Parameters<typeof rmSync>[0], options: Parameters<typeof rmSync>[1]) => {
      attempted.push(String(target));
      expect(options).toMatchObject({ recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
      if (String(target) === buildRoot && buildFailures-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }) as typeof rmSync;

    cleanupHarborStaging(privateRoot, buildRoot, remove, (milliseconds) => delays.push(milliseconds));

    expect(attempted).toEqual([privateRoot, buildRoot, buildRoot, buildRoot, buildRoot]);
    expect(delays).toEqual([250, 500, 750]);
  });

  test("refuses cleanup outside the two direct temporary staging prefixes", () => {
    for (const invalid of [
      realpathSync.native(tmpdir()),
      join(realpathSync.native(tmpdir()), "neko-harbor-private-"),
    ]) {
      let attempted = false;
      // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
      const remove = (() => { attempted = true; }) as typeof rmSync;
      expect(() => cleanupHarborStaging(invalid, "", remove))
        .toThrow("Harbor temporary staging cleanup failed.");
      expect(attempted).toBe(false);
    }
  });

  test("constructs a default-deny Harbor environment and exposes only transient private locators", () => {
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-env-")));
    const trustedPath = dirname(realpathSync.native(process.execPath));
    try {
      const runtime = join(temporary, "runtime");
      mkdirSync(runtime);
      const grant = {
        runnerHome: join(temporary, "private-runner-home"),
        bridgePath: join(temporary, "private-bridge"),
        expiresAt: Date.now() + HARBOR_RUN_DEADLINE_MS + HARBOR_LEASE_MARGIN_MS,
      };
      const sentinel = "random-host-secret-6d14";
      const dockerProgramFiles = join(temporary, "canonical-program-files");
      mkdirSync(dockerProgramFiles);
      const env = harborProcessEnv({
        Path: join(temporary, "workspace-path-poison"),
        PYTHONPATH: "C:/untrusted-python",
        PythonUtf8: "0",
        PYTHONHOME: "C:/untrusted-python-home",
        NEKO_HARBOR_AUTH_PATH: "C:/legacy-auth.json",
        GIT_DIR: "C:/other-repository/.git",
        git_work_tree: "C:/other-repository",
        UV_TOOL_DIR: "C:/untrusted-uv-tools",
        NEKO_PROFILE: "other",
        NEKO_PROVIDER: "openai_compat",
        NEKO_MODEL: "other-model",
        NEKO_API_KEY: sentinel,
        OPENAI_API_KEY: sentinel,
        NEKO_TEST_HOST_SENTINEL: sentinel,
        ProgramFiles: join(temporary, sentinel),
        "ProgramFiles(x86)": join(temporary, sentinel, "x86"),
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        ComSpec: process.env.ComSpec,
        PATHEXT: process.env.PATHEXT,
      }, trustedPath, runtime, grant, realpathSync.native(dockerProgramFiles));
      expect(env.PATH).toBe(trustedPath);
      expect(env.PYTHONPATH).toBe(grant.bridgePath);
      expect(env[HARBOR_RUNNER_HOME_ENV]).toBe(grant.runnerHome);
      expect(env.HOME).toBe(realpathSync.native(runtime));
      expect(env.PYTHONUTF8).toBe("1");
      expect(env.PYTHONIOENCODING).toBe("utf-8");
      expect(env.ProgramFiles).toBe(realpathSync.native(dockerProgramFiles));
      expect(JSON.stringify(env)).not.toContain(sentinel);
      for (const key of ["NEKO_API_KEY", "OPENAI_API_KEY", "NEKO_TEST_HOST_SENTINEL", "NEKO_PROFILE",
        "NEKO_PROVIDER", "NEKO_MODEL", "PYTHONHOME", "GIT_DIR", "UV_TOOL_DIR", "PROGRAMFILES(X86)"]) {
        expect(Object.keys(env).some((candidate) => candidate.toUpperCase() === key)).toBe(false);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")(
    "binds ProgramFiles only when Docker and its Compose system plugin pass canonical validation",
    () => {
      const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-compose-")));
      const workspace = join(temporary, "repo");
      const programFiles = join(temporary, "Program Files");
      const docker = join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe");
      const compose = join(programFiles, "Docker", "cli-plugins", "docker-compose.exe");
      try {
        mkdirSync(workspace);
        mkdirSync(dirname(docker), { recursive: true });
        mkdirSync(dirname(compose), { recursive: true });
        writeFileSync(docker, "trusted docker fixture");
        expect(() => resolveDockerComposeProgramFiles(
          workspace,
          docker,
          { ProgramFiles: programFiles },
        )).toThrow("system plugin is unavailable");

        writeFileSync(compose, "trusted compose fixture");
        expect(resolveDockerComposeProgramFiles(
          workspace,
          docker,
          { ProgramFiles: programFiles },
        )).toBe(realpathSync.native(programFiles));
        expect(() => resolveDockerComposeProgramFiles(
          workspace,
          docker,
          { ProgramFiles: workspace },
        )).toThrow();
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  test("preflights the exact Docker Compose subcommand before Harbor", async () => {
    const calls: unknown[][] = [];
    const execute = async (...args: [string, string[], string, boolean, Record<string, string>]) => {
      calls.push(args);
      return 0;
    };
    await preflightDockerCompose("C:/trusted/docker.exe", "C:/staging", { PATH: "C:/trusted" }, execute);
    expect(calls).toEqual([[
      "C:/trusted/docker.exe",
      ["compose", "version"],
      "C:/staging",
      true,
      { PATH: "C:/trusted" },
    ]]);
    expect(preflightDockerCompose(
      "C:/trusted/docker.exe",
      "C:/staging",
      { PATH: "C:/trusted" },
      async () => 1,
    )).rejects.toThrow("credential-safe Harbor environment");
  });

  test("resolves Git, Docker, and uvx outside a workspace-local Windows PATH poison", () => {
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-path-")));
    const workspace = join(temporary, "repo");
    const trusted = join(temporary, "tools");
    try {
      mkdirSync(workspace);
      mkdirSync(trusted);
      for (const name of ["git.exe", "docker.exe", "uvx.exe"]) {
        writeFileSync(join(workspace, name), `workspace poison: ${name}`);
        writeFileSync(join(trusted, name), `trusted fixture: ${name}`);
      }
      const executables = resolveHarborExecutables(
        workspace,
        [workspace, trusted].join(delimiter),
        "win32",
      );
      expect(executables).toEqual({
        git: realpathSync.native(join(trusted, "git.exe")),
        docker: realpathSync.native(join(trusted, "docker.exe")),
        uvx: realpathSync.native(join(trusted, "uvx.exe")),
      });
      expect(buildTrustedExecutablePath(workspace, Object.values(executables), "win32"))
        .toBe(realpathSync.native(trusted));
      expect(() => resolveHarborExecutables(workspace, workspace, "win32")).toThrow("outside the workspace");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("scrubs GIT_DIR provenance poison and rejects a non-root repository path", () => {
    const root = realpathSync.native(resolve(import.meta.dir, ".."));
    const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "neko-harbor-git-")));
    try {
      const runner = join(temporary, HARBOR_HOST_RUNNER_BASENAME);
      writeFileSync(runner, "runner-bits");
      const poisoned = {
        ...process.env,
        GIT_DIR: join(temporary, "other.git"),
        git_work_tree: temporary,
      };
      const identity = collectBuildIdentity(root, runner, "kimi", {
        launcherCwd: temporary,
        sourceEnv: poisoned,
      });
      expect(identity.sourceRevision).toMatch(/^[a-f0-9]{40,64}$/);
      const gitEnv = gitProvenanceEnv(poisoned, realpathSync.native(tmpdir()));
      expect(Object.keys(gitEnv).some((key) => key.toUpperCase().startsWith("GIT_"))).toBe(false);
      expect(() => collectBuildIdentity(join(root, "scripts"), runner, "kimi", {
        launcherCwd: temporary,
        sourceEnv: poisoned,
      })).toThrow("Git top-level does not match");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
