import { describe, expect, test } from "bun:test";
import { buildHarborArgs, parseHarborEvalArgs } from "../scripts/harbor-eval.ts";

describe("Harbor evaluation launcher", () => {
  test("defaults to one public Terminal-Bench 2 task", () => {
    expect(parseHarborEvalArgs([])).toEqual({
      dataset: "terminal-bench/terminal-bench-2",
      limit: 1,
      noBuild: false,
      passthrough: [],
    });
  });

  test("validates limit and preserves explicit Harbor flags", () => {
    const options = parseHarborEvalArgs(["--profile", "kimi", "--limit", "3", "--", "--n-concurrent", "1"]);
    expect(options.profile).toBe("kimi");
    expect(options.limit).toBe(3);
    expect(options.passthrough).toEqual(["--n-concurrent", "1"]);
    expect(() => parseHarborEvalArgs(["--limit", "0"])).toThrow("positive integer");
  });

  test("normalizes the documented short Terminal-Bench task name", () => {
    const options = parseHarborEvalArgs(["--", "--include-task-name", "make-mips-interpreter", "--n-attempts", "3"]);
    expect(options.passthrough).toEqual([
      "--include-task-name", "terminal-bench/make-mips-interpreter", "--n-attempts", "3",
    ]);
  });

  test("builds an import-path agent command without credential data or local auth paths", () => {
    const options = parseHarborEvalArgs(["--profile", "kimi"]);
    const args = buildHarborArgs({
      options,
      binaryPath: "C:/work/neko-linux-x64",
      profile: "kimi",
      model: "kimi/kimi-for-coding",
    });
    expect(args).toContain("evals.harbor.neko_agent:NekoAgent");
    expect(args.join(" ")).not.toContain(".neko-core");
    expect(args.join(" ")).not.toContain("access_token");
  });
});
