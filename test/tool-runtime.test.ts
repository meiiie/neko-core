import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { __formatBashExitForTest, __taskkillResultSucceededForTest, __windowsDescendantSnapshotForTest, type ApprovalGate, ToolRegistry, todosContextBlock } from "../src/core/tool-runtime.ts";
import type { PermissionMode } from "../src/core/permissions.ts";
import { isText } from "../src/shared/wire.ts";

function makeReg(mode: PermissionMode = "auto", prompt: ApprovalGate = () => true) {
  const root = mkdtempSync(join(tmpdir(), "neko-tr-"));
  return { root, reg: new ToolRegistry(root, mode, prompt) };
}

test("todosContextBlock: empty -> '', populated -> the plan", () => {
  expect(todosContextBlock([])).toBe("");
  const b = todosContextBlock([{ content: "build X", status: "in_progress" }, { content: "test", status: "pending" }]);
  expect(b).toContain("Current plan");
  expect(b).toContain("build X");
  expect(b).toContain("[~]"); // in_progress marker
});

test("write then read", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("write_file", { path: "a.txt", content: "hi" })).toContain("Wrote");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("hi");
});

test("an exact outside-workspace structured write always prompts and remains checkpoint-reversible", async () => {
  let prompts = 0;
  const { root, reg } = makeReg("auto", () => { prompts++; return true; });
  const outside = mkdtempSync(join(tmpdir(), "neko-host-write-"));
  const target = join(outside, "note.txt");
  writeFileSync(target, "before");
  try {
    expect(await reg.execute("write_file", { path: target, content: "after" })).toContain("Wrote");
    expect(prompts).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("after");
    expect(reg.restoreCheckpoint()).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("before");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("outside-workspace structured writes are denied without consent and system roots never reach the prompt", async () => {
  let prompts = 0;
  const { root, reg } = makeReg("auto", () => { prompts++; return false; });
  const outside = mkdtempSync(join(tmpdir(), "neko-host-deny-"));
  const target = join(outside, "denied.txt");
  try {
    expect(await reg.execute("write_file", { path: target, content: "no" })).toContain("Denied by user");
    expect(prompts).toBe(1);
    expect(existsSync(target)).toBe(false);

    prompts = 0;
    const protectedTarget = process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "neko-host-write-refusal.txt")
      : "/etc/neko-host-write-refusal.txt";
    expect(await reg.execute("write_file", { path: protectedTarget, content: "no" })).toContain("protected from host writes");
    expect(prompts).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("edit falls back to a whitespace-tolerant line match", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "code.ts"), "function f() {\nconst x = 1;\n}\n"); // file line: no indent
  // old_string has MORE indent than the file -> exact fails, line-trimmed match succeeds.
  const out = await reg.execute("edit", { path: "code.ts", old_string: "    const x = 1;", new_string: "    const x = 2;" });
  expect(out).toContain("Edited");
  expect(await reg.execute("read_file", { path: "code.ts" })).toContain("const x = 2;");
});

test("edit returns a unified diff (context, -removed, +added)", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "f.ts"), "a();\nb();\nc();\nd();\n");
  const out = await reg.execute("edit", { path: "f.ts", old_string: "c();", new_string: "C1();\nC2();" });
  expect(out).toContain("Edited f.ts");
  expect(out).toContain("(+2 -1)");
  // Claude-style rows: line number FIRST, then the +/-/space marker, then the content.
  expect(out).toMatch(/\s+3 - c\(\);/); // removed line 3 (red), line-numbered
  expect(out).toMatch(/\s+3 \+ C1\(\);/); // added (green), line-numbered
  expect(out).toMatch(/\s+2 {3}b\(\);/); // context line 2 (dim): number, then space-marker, then content
});

test("multi_edit applies several edits atomically", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "m.ts"), "let a = 1;\nlet b = 2;\nlet c = 3;\n");
  const out = await reg.execute("multi_edit", {
    path: "m.ts",
    edits: [
      { old_string: "a = 1", new_string: "a = 10" },
      { old_string: "c = 3", new_string: "c = 30" },
    ],
  });
  expect(out).toContain("2 edits");
  const after = await reg.execute("read_file", { path: "m.ts" });
  expect(after).toContain("a = 10");
  expect(after).toContain("c = 30");

  // atomic: a failing edit writes nothing
  writeFileSync(join(root, "n.ts"), "x = 1;\n");
  const fail = await reg.execute("multi_edit", {
    path: "n.ts",
    edits: [{ old_string: "x = 1", new_string: "x = 2" }, { old_string: "NOPE", new_string: "y" }],
  });
  expect(fail).toContain("not found");
  expect(await reg.execute("read_file", { path: "n.ts" })).toContain("x = 1;"); // unchanged
});

test("multi_edit refuses a missing new_string without deleting content", async () => {
  const { root, reg } = makeReg();
  const path = join(root, "missing-new.ts");
  writeFileSync(path, "const keep = true;\n");
  const before = readFileSync(path, "utf-8");
  const out = await reg.execute("multi_edit", {
    path: "missing-new.ts",
    edits: [{ old_string: "keep = true" }],
  });
  expect(out).toContain("needs string new_string");
  expect(readFileSync(path, "utf-8")).toBe(before);
});

test("edit reports an ambiguous whitespace match instead of guessing", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "d.ts"), "a();\na();\n"); // two lines, no indent
  // old_string with extra indent -> exact 0, but trims to match BOTH lines -> refuse.
  expect(await reg.execute("edit", { path: "d.ts", old_string: "    a();", new_string: "b();" })).toContain("matches 2 places");
});

test("read missing", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("read_file", { path: "x" })).toContain("no such file");
});

test("search", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
  expect(await reg.execute("search", { pattern: "beta" })).toContain("a.txt:2");
});

test("glob + ls", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.ts"), "x");
  expect(await reg.execute("glob", { pattern: "**/*.ts" })).toContain("a.ts");
  expect(await reg.execute("ls", {})).toContain("a.ts");
});

test("edit unique / not found / ambiguous", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.ts"), "const x = 1;\nconst x2 = 1;\n");
  expect(await reg.execute("edit", { path: "a.ts", old_string: "x2", new_string: "y2" })).toContain("Edited");
  expect(await reg.execute("edit", { path: "a.ts", old_string: "zzz", new_string: "q" })).toContain("not found");
  expect(await reg.execute("edit", { path: "a.ts", old_string: "const ", new_string: "let " })).toContain("times");
});

test("outside writes need consent while reads remain the host's call", async () => {
  let prompts = 0;
  const { reg } = makeReg("auto", () => { prompts++; return false; });
  expect(await reg.execute("write_file", { path: "../neko-no-consent-outside", content: "no" })).toContain("Denied by user");
  expect(prompts).toBe(1);
  // Reads do by default — the wall around them stopped ordinary work (a skill file one directory over)
  // without bounding any damage. Full coverage in test/read-outside-root.test.ts.
  expect(await reg.execute("read_file", { path: "../neko-no-consent-outside" })).toContain("no such file");
  reg.readOutsideRoot = false;
  expect(await reg.execute("read_file", { path: "../neko-no-consent-outside" })).toContain("escapes project root");
});

test("hard project read wall hides and refuses the host disk cleanup scan", async () => {
  const { reg } = makeReg();
  reg.readOutsideRoot = false;
  expect(reg.schemas().map((schema: any) => schema.function.name)).not.toContain("disk_cleanup_scan");
  expect(await reg.execute("disk_cleanup_scan", {})).toContain("read_outside_root=false");
});

test("missing required arg", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("read_file", {})).toContain("missing required argument");
});

test("unknown tool", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("frobnicate", {})).toContain("Unknown tool");
});

test("plan blocks writes, allows reads", async () => {
  const { root, reg } = makeReg("plan", () => false);
  writeFileSync(join(root, "a.txt"), "yo");
  expect(await reg.execute("write_file", { path: "b.txt", content: "x" })).toContain("plan");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("yo");
});

test("plan blocks persistent-memory mutations but allows their read actions", async () => {
  const { reg } = makeReg("plan", () => false);
  expect(await reg.execute("memory", { action: "read", name: "missing" })).not.toContain("Blocked");
  expect(await reg.execute("memory", { action: "write", name: "x", content: "secret" })).toContain("plan");
  expect(await reg.execute("workflow", { action: "delete", name: "x" })).toContain("plan");
  expect(await reg.execute("playbook", { action: "add", content: "x" })).toContain("plan");
});

test("default + deny gate denies gated, allows safe", async () => {
  const { root, reg } = makeReg("default", () => false);
  writeFileSync(join(root, "a.txt"), "yo");
  expect(await reg.execute("write_file", { path: "b.txt", content: "x" })).toContain("Denied");
  expect(await reg.execute("read_file", { path: "a.txt" })).toContain("yo");
});

test("accept-edits auto-approves edits but prompts bash", async () => {
  const { reg } = makeReg("accept-edits", () => false);
  expect(await reg.execute("write_file", { path: "b.txt", content: "x" })).toContain("Wrote");
  expect(await reg.execute("multi_edit", { path: "b.txt", edits: [{ old_string: "x", new_string: "y" }] })).toContain("Edited");
  expect(await reg.execute("bash", { command: "echo no" })).toContain("Denied");
});

test("auto mode refuses unsandboxed host-daemon commands without an explicit override", async () => {
  const { reg } = makeReg("auto", () => true);
  const out = await reg.execute("bash", { command: "docker ps" });
  expect(out).toContain("host daemon outside Neko's OS sandbox");
  expect(out).toContain("allow_dangerous_bash");
});

test("auto mode cannot silently cross the computer host boundary", async () => {
  let prompts = 0;
  let executions = 0;
  const { reg } = makeReg("auto", () => { prompts++; return false; });
  reg.computerHandler = () => { executions++; return "host action ran"; };

  expect(await reg.execute("computer", { action: "read" })).toContain("Denied by user");
  expect(prompts).toBe(1);
  expect(executions).toBe(0);

  // An affirmative approval is separate, explicit authority; auto mode alone was insufficient.
  reg.prompt = () => { prompts++; return true; };
  expect(await reg.execute("computer", { action: "read" })).toBe("host action ran");
  expect(prompts).toBe(2);
  expect(executions).toBe(1);
});

test("disabled tool is hidden from schemas and blocked on execute", async () => {
  const { reg } = makeReg();
  reg.disabled.add("bash");
  expect(reg.schemas().map((s: any) => s.function.name)).not.toContain("bash");
  expect(await reg.execute("bash", { command: "echo hi" })).toContain("disabled");
});

test("task delegates to the subagent callback (and reports when unavailable)", async () => {
  const { reg } = makeReg();
  expect(await reg.execute("task", { description: "x", prompt: "do y" })).toContain("not available");
  reg.subagent = async (prompt) => `sub did: ${prompt}`;
  expect(await reg.execute("task", { description: "x", prompt: "do y" })).toBe("sub did: do y");
});

test("generic task is approval-gated while reviewer remains safe and read-only", async () => {
  let calls = 0;
  const { reg } = makeReg("default", () => false);
  reg.subagent = async () => { calls++; return "review complete"; };

  expect(await reg.execute("task", { description: "worker", prompt: "change it" })).toContain("Denied by user");
  expect(calls).toBe(0);
  expect(await reg.execute("task", { description: "review", prompt: "inspect it", subagent_type: "reviewer" })).toBe("review complete");
  expect(calls).toBe(1);
});

test("adversarial check blocks an auto-approved mutating tool when it flags unsafe", async () => {
  const { reg } = makeReg("auto", () => true);
  reg.checkAction = async () => ({ ok: false, reason: "looks like exfiltration" });
  expect(await reg.execute("write_file", { path: "x.txt", content: "data" })).toContain("Blocked by adversarial check");
  expect(await reg.execute("memory", { action: "write", name: "x", content: "data" })).toContain("Blocked by adversarial check");
  expect(await reg.execute("read_file", { path: "x.txt" })).not.toContain("adversarial"); // read-only not checked
  expect(await reg.execute("memory", { action: "read", name: "x" })).not.toContain("adversarial");
  reg.checkAction = async () => ({ ok: true, reason: "SAFE" });
  expect(await reg.execute("write_file", { path: "y.txt", content: "ok" })).toContain("Wrote");
});

test("adversarial check also vets auto-approved MCP tools", async () => {
  const { reg } = makeReg("auto", () => true);
  reg.mcp = {
    toolSchemas: () => [],
    has: (n: string) => n === "mcp__x__do",
    call: async () => "ran mcp",
  };
  reg.checkAction = async () => ({ ok: false, reason: "injection" });
  expect(await reg.execute("mcp__x__do", {})).toContain("Blocked by adversarial check");
  reg.checkAction = async () => ({ ok: true, reason: "SAFE" });
  expect(await reg.execute("mcp__x__do", {})).toBe("ran mcp");
});

test("an external adapter can declare an attached-tab observation safe", async () => {
  let prompts = 0;
  let checks = 0;
  let receivedSignal: AbortSignal | undefined;
  const { reg } = makeReg("default", () => { prompts++; return false; });
  reg.mcp = {
    toolSchemas: () => [],
    has: (name: string) => name === "mcp__neko_browser__watch",
    permission: () => "safe",
    call: async (_name: string, _args: any, signal?: AbortSignal) => {
      receivedSignal = signal;
      return "watched";
    },
  };
  reg.checkAction = async () => { checks++; return { ok: false, reason: "should not run" }; };
  const abort = new AbortController();
  expect(await reg.execute("mcp__neko_browser__watch", { durationMs: 250 }, abort.signal)).toBe("watched");
  expect(prompts).toBe(0);
  expect(checks).toBe(0);
  expect(receivedSignal).toBe(abort.signal);
});

test("checkpoint/restore reverts this turn's file edits (and deletes new files)", async () => {
  const { root, reg } = makeReg("auto", () => true);
  writeFileSync(join(root, "keep.ts"), "original\n");
  reg.clearCheckpoint();
  await reg.execute("edit", { path: "keep.ts", old_string: "original", new_string: "changed" });
  await reg.execute("write_file", { path: "new.ts", content: "brand new" });
  expect(await reg.execute("read_file", { path: "keep.ts" })).toContain("changed");
  const reverted = reg.restoreCheckpoint();
  expect(reverted).toBe(2);
  expect(await reg.execute("read_file", { path: "keep.ts" })).toContain("original"); // restored
  expect(await reg.execute("read_file", { path: "new.ts" })).toContain("no such file"); // deleted
  expect(reg.consumeRestoreConflicts()).toEqual([]);
});

test("checkpoint ignores a failed mutation instead of later clobbering user bytes", async () => {
  const { root, reg } = makeReg("auto", () => true);
  const path = join(root, "keep.ts");
  writeFileSync(path, "original\n");
  reg.clearCheckpoint();
  expect(await reg.execute("edit", { path: "keep.ts", old_string: "missing", new_string: "agent" })).toContain("not found");

  writeFileSync(path, "user after failed edit\n");
  expect(reg.restoreCheckpoint()).toBe(0);
  expect(reg.consumeRestoreConflicts()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("user after failed edit\n");

  reg.clearCheckpoint();
  expect(await reg.execute("write_file", { path: "keep.ts" })).toContain("missing required argument: content");
  writeFileSync(path, "user after thrown write\n");
  expect(await reg.execute("write_file", { path: "keep.ts", content: "agent after retry\n" })).toContain("Wrote");
  expect(reg.restoreCheckpoint()).toBe(1);
  expect(reg.consumeRestoreConflicts()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("user after thrown write\n");
});

test("checkpoint preserves newer user edits and adopted new files as bounded conflicts", async () => {
  const { root, reg } = makeReg("auto", () => true);
  const keep = join(root, "keep.ts");
  const created = join(root, "new.ts");
  writeFileSync(keep, "original\n");
  reg.clearCheckpoint();
  expect(await reg.execute("edit", { path: "keep.ts", old_string: "original", new_string: "agent" })).toContain("Edited");
  expect(await reg.execute("write_file", { path: "new.ts", content: "agent" })).toContain("Wrote");

  writeFileSync(keep, "user after agent\n");
  writeFileSync(created, "user adopted file\n");
  expect(reg.restoreCheckpoint()).toBe(0);
  expect(reg.consumeRestoreConflicts()).toEqual(["keep.ts", "new.ts"]);
  expect(reg.consumeRestoreConflicts()).toEqual([]);
  expect(readFileSync(keep, "utf8")).toBe("user after agent\n");
  expect(readFileSync(created, "utf8")).toBe("user adopted file\n");
});

test("checkpoint never erases a user edit interleaved between two structured mutations", async () => {
  const { root, reg } = makeReg("auto", () => true);
  const path = join(root, "interleaved.ts");
  writeFileSync(path, "const a = 1;\nconst b = 1;\n");
  reg.clearCheckpoint();
  expect(await reg.execute("edit", { path: "interleaved.ts", old_string: "a = 1", new_string: "a = 2" })).toContain("Edited");
  writeFileSync(path, "const a = 2;\nconst b = 1;\n// human between edits\n");
  const hook = join(root, "conflict-hook.cjs");
  writeFileSync(hook, "require('node:fs').writeFileSync('conflict-hook-ran', 'yes');\n");
  reg.hooks = { preToolUse: `\"${process.execPath}\" \"${hook}\"`, postToolUse: `\"${process.execPath}\" \"${hook}\"` };
  expect(await reg.execute("edit", { path: "interleaved.ts", old_string: "b = 1", new_string: "b = 2" })).toContain("no further structured mutation was applied");
  expect(existsSync(join(root, "conflict-hook-ran"))).toBe(false);

  expect(reg.restoreCheckpoint()).toBe(0);
  expect(reg.consumeRestoreConflicts()).toEqual(["interleaved.ts"]);
  expect(readFileSync(path, "utf8")).toBe("const a = 2;\nconst b = 1;\n// human between edits\n");

  reg.clearCheckpoint();
  reg.hooks = undefined;
  expect(await reg.execute("edit", { path: "interleaved.ts", old_string: "a = 2", new_string: "a = 3" })).toContain("Edited");
  writeFileSync(path, "const a = 3;\nconst b = 2;\n// human after first write\n");
  expect(await reg.execute("edit", { path: "interleaved.ts", old_string: "missing", new_string: "never" })).toContain("no further structured mutation was applied");
  expect(reg.restoreCheckpoint()).toBe(0);
  expect(reg.consumeRestoreConflicts()).toEqual(["interleaved.ts"]);
  expect(readFileSync(path, "utf8")).toContain("human after first write");
});

test("structured writes refuse existing multiply-linked regular files", async () => {
  let approvals = 0;
  let checks = 0;
  const { root, reg } = makeReg("default", () => { approvals++; return true; });
  reg.checkAction = async () => { checks++; return { ok: true, reason: "safe" }; };
  const hook = join(root, "hardlink-hook.cjs");
  writeFileSync(hook, "require('node:fs').writeFileSync('hardlink-hook-ran', 'yes');\n");
  reg.hooks = { preToolUse: `\"${process.execPath}\" \"${hook}\"`, postToolUse: `\"${process.execPath}\" \"${hook}\"` };
  const outside = mkdtempSync(join(dirname(root), "neko-hardlink-outside-"));
  try {
    const cases = [
      ["write_file", { path: "write.ts", content: "changed\n" }],
      ["edit", { path: "edit.ts", old_string: "original", new_string: "changed" }],
      ["multi_edit", { path: "multi.ts", edits: [{ old_string: "original", new_string: "changed" }] }],
    ] as const;
    for (let index = 0; index < cases.length; index++) {
      const [tool, args] = cases[index]!;
      if (index === 1) reg.mode = "auto";
      const external = join(outside, `${tool}.ts`);
      // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
      const linked = join(root, String((args as any).path));
      writeFileSync(external, "original\n");
      try {
        linkSync(external, linked);
      } catch (error: any) {
        if (["EPERM", "EACCES", "EXDEV", "ENOTSUP", "ENOSYS"].includes(String(error?.code))) return;
        throw error;
      }
      // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
      const result = String(await reg.execute(tool, args as any));
      expect(result).toContain("multiply-linked structured-write target");
      expect(readFileSync(external, "utf8")).toBe("original\n");
    }
    expect({ approvals, checks }).toEqual({ approvals: 0, checks: 0 });
    expect(existsSync(join(root, "hardlink-hook-ran"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("approval-free read surfaces never expose multiply-linked file bytes", async () => {
  const { root, reg } = makeReg();
  const outside = mkdtempSync(join(dirname(root), "neko-read-hardlink-outside-"));
  const secret = "HARDLINK_CREDENTIAL_SENTINEL";
  try {
    const external = join(outside, "credential.txt");
    const alias = join(root, "innocent.txt");
    writeFileSync(external, secret);
    try {
      linkSync(external, alias);
    } catch (error: any) {
      if (["EPERM", "EACCES", "EXDEV", "ENOTSUP", "ENOSYS"].includes(String(error?.code))) return;
      throw error;
    }
    for (const [tool, args] of [
      ["read_file", { path: "innocent.txt" }],
      ["search", { pattern: secret }],
      ["glob", { pattern: "*.txt" }],
      ["ls", {}],
    ] as const) {
      const result = String(await reg.execute(tool, args));
      expect(result).not.toContain(secret);
      if (tool === "glob" || tool === "ls") expect(result).not.toContain("innocent.txt");
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("task forwards subagent_type to the sub-agent", async () => {
  const { reg } = makeReg("auto", () => true);
  let gotType: string | undefined = "UNSET";
  reg.subagent = async (prompt, type) => { gotType = type; return `ran: ${prompt}`; };
  const out = await reg.execute("task", { description: "x", prompt: "do it", subagent_type: "reviewer" });
  expect(out).toBe("ran: do it");
  expect(gotType).toBe("reviewer");
});

test("task forwards the parent abort signal and never starts when already aborted", async () => {
  const { reg } = makeReg("auto", () => true);
  let calls = 0;
  let receivedSignal: AbortSignal | undefined;
  reg.subagent = async (_prompt, _type, signal) => {
    calls++;
    receivedSignal = signal;
    return await new Promise<string>((resolve) => {
      if (signal?.aborted) return resolve("child interrupted");
      signal?.addEventListener("abort", () => resolve("child interrupted"), { once: true });
    });
  };

  const active = new AbortController();
  const running = reg.execute("task", { description: "wait", prompt: "wait" }, active.signal);
  active.abort();
  expect(await running).toBe("child interrupted");
  expect(receivedSignal).toBe(active.signal);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  expect(await reg.execute("task", { description: "wait", prompt: "wait" }, alreadyAborted.signal)).toBe("(interrupted)");
  expect(calls).toBe(1);
});

test("task does not spawn a child when the parent aborts during approval", async () => {
  let releaseApproval!: (approved: boolean) => void;
  const { reg } = makeReg("default", () => new Promise<boolean>((resolve) => { releaseApproval = resolve; }));
  let starts = 0;
  reg.subagent = async () => { starts++; return "should not start"; };
  const parent = new AbortController();

  const running = reg.execute("task", { description: "worker", prompt: "mutate" }, parent.signal);
  await Promise.resolve();
  parent.abort();
  releaseApproval(true);

  expect(await running).toBe("(interrupted)");
  expect(starts).toBe(0);
});

test("bash returns exit code + output", async () => {
  const { reg } = makeReg("auto", () => true);
  const out = await reg.execute("bash", { command: "echo hello" });
  expect(out).toContain("hello");
  expect(out).toContain("exit 0");
});

test("a signal-terminated bash close is never formatted as exit 0", () => {
  const out = __formatBashExitForTest(null, "partial output", "SIGTERM");
  expect(out).toStartWith("Error:");
  expect(out).toContain("SIGTERM");
  expect(out).not.toContain("exit 0");
});

test("Windows taskkill is effective only after a successful exit status", () => {
  expect(__taskkillResultSucceededForTest({ status: 0 })).toBe(true);
  expect(__taskkillResultSucceededForTest({ status: 1 })).toBe(false);
  expect(__taskkillResultSucceededForTest({ status: null, error: new Error("timed out") })).toBe(false);
  expect(__taskkillResultSucceededForTest({ status: 0, error: new Error("reported error") })).toBe(false);
});

test("Windows force cleanup retains descendant PIDs before their leader exits", () => {
  expect(__windowsDescendantSnapshotForTest([
    { pid: 20, parentPid: 10 },
    { pid: 30, parentPid: 20 },
    { pid: 99, parentPid: 1 },
  ], 10)).toEqual({ pids: [10, 20, 30], complete: true });
  expect(__windowsDescendantSnapshotForTest([
    { pid: 20, parentPid: 10 },
    { pid: 30, parentPid: 20 },
  ], 10, 2)).toEqual({ pids: [10, 20], complete: false });
});

test("Ctrl+B moves a running bash command to the background", async () => {
  const { reg } = makeReg("auto", () => true);
  const p = reg.execute("bash", { command: "sleep 0.6" });
  await new Promise((r) => setTimeout(r, 150));
  expect(reg.detachRunningBash()).toBe(true); // a bash is running -> detached
  const out = await p;
  expect(out).toContain("background");
  expect(reg.backgrounds.length).toBe(1);
  expect(reg.detachRunningBash()).toBe(false); // nothing running now
});

test("bash is interrupted at once when the abort signal fires (no long wait, no orphan)", async () => {
  const { reg } = makeReg("auto", () => true);
  const ctrl = new AbortController();
  const p = reg.execute("bash", { command: "sleep 10" }, ctrl.signal);
  setTimeout(() => ctrl.abort(), 150);
  const start = Date.now();
  const out = await p;
  expect(out).toContain("interrupted");
  expect(out).not.toContain("could not be confirmed");
  expect(Date.now() - start).toBeLessThan(8000); // bounded snapshot + tree kill, not the 10s command
}, 10_000);

function writeBashTreeFixture(root: string, marker: string): string {
  const grandchild = join(root, `grandchild-${marker}.ts`);
  const parent = join(root, `parent-${marker}.ts`);
  const trigger = join(root, `${marker}.trigger`);
  const childReady = join(root, `${marker}.child-ready`);
  writeFileSync(grandchild, [
    'import { existsSync, writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(childReady)}, "ready");`,
    `while (!existsSync(${JSON.stringify(trigger)})) await Bun.sleep(20);`,
    `writeFileSync(${JSON.stringify(join(root, marker))}, "orphan survived cancellation");`,
  ].join("\n"));
  writeFileSync(parent, [
    'import { spawn } from "node:child_process";',
    'import { existsSync, writeFileSync } from "node:fs";',
    `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(join(root, `${marker}.ready`))}, "ready");`,
    `while (!existsSync(${JSON.stringify(trigger)})) await Bun.sleep(20);`,
  ].join("\n"));
  return parent.replaceAll("\\", "/");
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(path)).toBe(true);
}

test("aborting bash kills grandchildren before returning", async () => {
  const { root, reg } = makeReg("auto", () => true);
  const marker = "abort-orphan.txt";
  const parent = writeBashTreeFixture(root, marker);
  const trigger = join(root, `${marker}.trigger`);
  const ctrl = new AbortController();
  try {
    const running = reg.execute("bash", { command: `bun ${JSON.stringify(parent)}` }, ctrl.signal);
    await waitForFile(join(root, `${marker}.ready`));
    await waitForFile(join(root, `${marker}.child-ready`));
    ctrl.abort();
    const out = String(await running);
    writeFileSync(trigger, "prove any surviving grandchild can still act");
    expect(out).toContain("interrupted");
    expect(out).not.toContain("could not be confirmed");
    await Bun.sleep(750);
    expect(existsSync(join(root, marker))).toBe(false);
  } finally {
    try { writeFileSync(trigger, "release any surviving fixture process"); } catch {}
    await Bun.sleep(100);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("timing out bash kills grandchildren before returning", async () => {
  const { root, reg } = makeReg("auto", () => true);
  const marker = "timeout-orphan.txt";
  const parent = writeBashTreeFixture(root, marker);
  const trigger = join(root, `${marker}.trigger`);
  reg.bashTimeoutCapMs = 1000;
  try {
    const running = reg.execute("bash", { command: `bun ${JSON.stringify(parent)}`, timeout: 1000 });
    await waitForFile(join(root, `${marker}.ready`));
    await waitForFile(join(root, `${marker}.child-ready`));
    const out = String(await running);
    writeFileSync(trigger, "prove any surviving grandchild can still act");
    expect(out).toContain("timed out after 1000ms");
    expect(out).not.toContain("could not be confirmed");
    await Bun.sleep(750);
    expect(existsSync(join(root, marker))).toBe(false);
  } finally {
    try { writeFileSync(trigger, "release any surviving fixture process"); } catch {}
    await Bun.sleep(100);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("skill tool loads a skill body on demand via the injected hook (progressive disclosure)", async () => {
  const { reg } = makeReg("auto", () => true);
  reg.loadSkill = (name) => (name === "demo" ? { body: "do the demo thing", dir: "/skills/demo" } : null);
  const out = await reg.execute("skill", { name: "demo" });
  expect(out).toContain("# Skill: demo");
  expect(out).toContain("do the demo thing");
  expect(out).toContain("/skills/demo"); // dir surfaced so bundled scripts are runnable
  const missing = await reg.execute("skill", { name: "nope" });
  expect(missing).toContain("no skill");
  expect(missing).toContain("Neko's catalog");
  expect(missing).toContain("do not search for or read a provider-native skill path");
  expect(missing).toContain("continue with the available Neko tools");
  expect(missing).not.toContain("follow that catalog's loader instructions");
});

test("read_file streams a bounded, resumable page of a huge file (no whole-file slurp -> OOM)", async () => {
  const { root, reg } = makeReg("auto", () => true);
  writeFileSync(join(root, "big.txt"), "A".repeat(45_000) + "STREAM_NEEDLE" + "B".repeat(555_000));
  const out = String(await reg.execute("read_file", { path: "big.txt" }));
  expect(out).toContain("more available");
  const column = Number(out.match(/column:(\d+)/)?.[1]);
  expect(column).toBeGreaterThan(1);
  expect(out.length).toBeLessThan(48_000);
  const second = String(await reg.execute("read_file", { path: "big.txt", offset: 1, column }));
  expect(second).toContain("STREAM_NEEDLE");
});

test("catastrophic bash is refused even in auto mode (seatbelt)", async () => {
  const { reg } = makeReg("auto", () => true); // auto would otherwise auto-approve bash
  expect(await reg.execute("bash", { command: "rm -rf /" })).toContain("Refused"); // never runs
  expect(await reg.execute("bash", { command: "rm -rf ~" })).toContain("Refused");
  expect(await reg.execute("bash", { command: "echo hello" })).not.toContain("Refused"); // safe runs
});

test("seatbelt is not bypassed by QUOTING the target (rm -rf \"$HOME\"/\"/\"/'~')", async () => {
  const { reg } = makeReg("auto", () => true);
  // A quote char between the flag and the dangerous token must not defeat the guard.
  for (const cmd of ['rm -rf "$HOME"', 'rm -rf "/"', "rm -rf '/'", "rm -rf '~'"]) {
    expect(await reg.execute("bash", { command: cmd })).toContain("Refused");
  }
  // Regression guard: quoting a normal relative path is still fine (no false positives).
  expect(await reg.execute("bash", { command: 'rm -rf "build"' })).not.toContain("Refused");
});

test("pre_tool_use hook blocks a tool on non-zero exit, allows on zero", async () => {
  const blocked = makeReg("auto", () => true).reg;
  blocked.hooks = { preToolUse: "exit 3" };
  expect(await blocked.execute("ls", {})).toContain("Blocked by pre_tool_use hook");

  const allowed = makeReg("auto", () => true).reg;
  allowed.hooks = { preToolUse: "exit 0" };
  expect(await allowed.execute("ls", {})).not.toContain("Blocked");
});

test("slow pre/post hooks never freeze the event loop", async () => {
  const { root, reg } = makeReg("auto", () => true);
  writeFileSync(join(root, "source.txt"), "ready", "utf8");
  const pre = join(root, "slow-pre.cjs");
  const post = join(root, "slow-post.cjs");
  const postMarker = join(root, "post-finished.txt");
  writeFileSync(pre, "setTimeout(() => process.exit(0), 200);\n", "utf8");
  writeFileSync(post, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(postMarker)}, 'done'), 300);\n`, "utf8");
  reg.hooks = { preToolUse: `\"${process.execPath}\" \"${pre}\"` };
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 10);
  try {
    expect(await reg.execute("read_file", { path: "source.txt" })).toContain("ready");
    expect(ticks).toBeGreaterThan(3);
    reg.hooks = { postToolUse: `\"${process.execPath}\" \"${post}\"` };
    const ticksBeforePost = ticks;
    expect(await reg.execute("read_file", { path: "source.txt" })).toContain("ready");
    expect(ticks).toBeGreaterThan(ticksBeforePost); // ordered hook runs, but the UI clock keeps moving
    const deadline = Date.now() + 3_000;
    while (!existsSync(postMarker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readFileSync(postMarker, "utf8")).toBe("done");
  } finally {
    clearInterval(ticker);
  }
});

test("Esc aborts a running pre-tool hook instead of waiting for its timeout", async () => {
  const { root, reg } = makeReg("auto", () => true);
  writeFileSync(join(root, "source.txt"), "ready", "utf8");
  const hook = join(root, "stuck-pre.cjs");
  writeFileSync(hook, "setTimeout(() => process.exit(0), 60000);\n", "utf8");
  reg.hooks = { preToolUse: `\"${process.execPath}\" \"${hook}\"` };
  const controller = new AbortController();
  let timerFired = false;
  setTimeout(() => { timerFired = true; controller.abort(); }, 100);
  const started = Date.now();
  const result = await reg.execute("read_file", { path: "source.txt" }, controller.signal);
  expect(result).toContain("interrupted");
  expect(timerFired).toBe(true);
  expect(Date.now() - started).toBeLessThan(8_000);
}, { timeout: 10_000 });

test("read-only task skips parent hooks and denied generic task runs no hook", async () => {
  const { root, reg } = makeReg("default", () => false);
  const marker = join(root, "parent-hook.txt");
  reg.hooks = { preToolUse: `echo hook>"${marker}"` };
  reg.subagent = async () => "child result";

  expect(await reg.execute("task", { prompt: "review", subagent_type: "reviewer" })).toBe("child result");
  expect(Bun.file(marker).size).toBe(0);

  expect(await reg.execute("task", { prompt: "mutate", subagent_type: "custom" })).toContain("Denied by user");
  expect(Bun.file(marker).size).toBe(0);

  reg.prompt = () => true;
  expect(await reg.execute("task", { prompt: "mutate", subagent_type: "custom" })).toBe("child result");
  expect(Bun.file(marker).size).toBeGreaterThan(0);
});

test("todo_write records the list on the registry and renders a checklist", async () => {
  const { reg } = makeReg();
  const out = await reg.execute("todo_write", {
    todos: [{ content: "scan", status: "completed" }, { content: "fix", status: "in_progress" }],
  });
  expect(out).toContain("[x] scan");
  expect(out).toContain("[~] fix");
  expect(reg.todos.length).toBe(2);
});

test("todo_write rejects ambiguous plans without corrupting the current plan", async () => {
  const { reg } = makeReg();
  await reg.execute("todo_write", { todos: [{ content: "keep me", status: "in_progress" }] });
  const invalid = [
    [{ content: "pending with no active item", status: "pending" }],
    [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }],
    [{ content: "same", status: "in_progress" }, { content: "SAME", status: "pending" }],
    [{ content: "", status: "in_progress" }],
    [{ content: "bad status", status: "done" }],
  ];
  for (const todos of invalid) expect(String(await reg.execute("todo_write", { todos }))).toStartWith("Error:");
  expect(reg.todos).toEqual([{ content: "keep me", status: "in_progress" }]);

  expect(String(await reg.execute("todo_write", { todos: [{ content: "keep me", status: "completed" }] }))).toContain("[x]");
  expect(reg.todos[0].status).toBe("completed");
});

test("read_file offset/limit returns a line window numbered from the offset", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "lines.txt"), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"));
  const out = await reg.execute("read_file", { path: "lines.txt", offset: 5, limit: 3 });
  expect(out).toContain("(lines 5-7 of 20)");
  expect(out).toMatch(/\s5\s+line5/); // numbered from the offset
  expect(out).toContain("line7");
  expect(out).not.toContain("line8");
  expect(out).not.toContain("line4");
});

test("read_file offset pages beyond the bounded prefix of a large file", async () => {
  const { root, reg } = makeReg();
  const body = Array.from({ length: 60_000 }, (_, i) => `line-${i + 1}-${"x".repeat(8)}`).join("\n");
  writeFileSync(join(root, "large-lines.txt"), body);
  const out = await reg.execute("read_file", { path: "large-lines.txt", offset: 50_000, limit: 2 });
  expect(out).toContain("line-50000-");
  expect(out).toContain("line-50001-");
  expect(out).not.toContain("line-49999-");
  expect(out).not.toContain("line-50002-");
});

test("read_file auto-pages dense short lines below the observation cap without losing the middle", async () => {
  const { root, reg } = makeReg();
  const lines = Array.from({ length: 12_000 }, (_, i) => i === 6_999 ? "needle-middle" : "x");
  writeFileSync(join(root, "dense.txt"), lines.join("\n"));
  const first = String(await reg.execute("read_file", { path: "dense.txt" }));
  expect(first.length).toBeLessThan(48_000);
  expect(first).toContain("more available");
  expect(first).not.toContain("needle-middle");
  const next = Number(first.match(/offset:(\d+)/)?.[1]);
  expect(next).toBeGreaterThan(1);
  const second = String(await reg.execute("read_file", { path: "dense.txt", offset: next }));
  expect(second).toContain("needle-middle");
});

test("read_file character-pages one very long line without discarding its tail", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "minified.json"), "A".repeat(45_000) + "TAIL_NEEDLE" + "B".repeat(45_000));
  const first = String(await reg.execute("read_file", { path: "minified.json" }));
  expect(first.length).toBeLessThan(48_000);
  expect(first).not.toContain("TAIL_NEEDLE");
  const column = Number(first.match(/column:(\d+)/)?.[1]);
  expect(column).toBeGreaterThan(1);
  const second = String(await reg.execute("read_file", { path: "minified.json", offset: 1, column }));
  expect(second).toContain("TAIL_NEEDLE");
});

test("search: case-insensitive is opt-in", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.txt"), "Hello World\n");
  expect(await reg.execute("search", { pattern: "hello" })).toContain("(no matches)"); // case-sensitive default
  expect(await reg.execute("search", { pattern: "hello", case_insensitive: true })).toContain("a.txt");
});

test("search: glob limits which files are searched", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "a.ts"), "needle\n");
  writeFileSync(join(root, "b.md"), "needle\n");
  const out = await reg.execute("search", { pattern: "needle", glob: "*.ts" });
  expect(out).toContain("a.ts");
  expect(out).not.toContain("b.md");
});

test("search: context shows surrounding lines", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "c.txt"), "one\ntwo\nTARGET\nfour\nfive\n");
  const out = await reg.execute("search", { pattern: "TARGET", context: 1 });
  expect(out).toContain("TARGET");
  expect(out).toContain("two"); // line before
  expect(out).toContain("four"); // line after
  expect(out).not.toContain("one"); // beyond a context of 1
});

test("bash honors the configured timeout ceiling", async () => {
  const { reg } = makeReg("auto", () => true);
  reg.bashTimeoutCapMs = 1000;
  const out = await reg.execute("bash", { command: "sleep 9", timeout: 9000 });
  expect(out).toContain("timed out after 1000ms");
}, 12_000);

test("bash run_in_background returns at once and records the job", async () => {
  const { reg } = makeReg("auto", () => true);
  const out = await reg.execute("bash", { command: "sleep 0.4", run_in_background: true });
  expect(out).toContain("Running in background");
  expect(reg.backgrounds.length).toBe(1);
});

test("a pre-aborted background bash call spawns no job", async () => {
  const { reg } = makeReg("auto", () => true);
  const ctrl = new AbortController();
  ctrl.abort();
  const out = await reg.execute("bash", { command: "sleep 9", run_in_background: true }, ctrl.signal);
  expect(out).toBe("(interrupted)");
  expect(reg.backgrounds).toHaveLength(0);
});

test("read_file: image returns metadata by default, vision content (data URL) when enabled", async () => {
  const { root, reg } = makeReg();
  const png = Buffer.alloc(24); // minimal PNG header carrying parseable dimensions
  png.writeUInt32BE(120, 16); // width
  png.writeUInt32BE(80, 20); // height
  writeFileSync(join(root, "logo.png"), png);
  const meta = await reg.execute("read_file", { path: "logo.png" });
  expect(isText(meta)).toBe(true);
  expect(meta).toContain("120x80"); // dimensions parsed from the header
  expect(meta).toContain("vision"); // hint to enable it
  reg.vision = true;
  const content = await reg.execute("read_file", { path: "logo.png" });
  expect(Array.isArray(content)).toBe(true);
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  const parts = content as any[];
  expect(parts.find((p) => p.type === "image_url").image_url.url).toContain("data:image/png;base64,");
  expect(parts.find((p) => p.type === "text").text).toContain("120x80");
});

test("read_file: a PDF is routed to text extraction and degrades gracefully", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "doc.pdf"), "not a real pdf");
  const out = await reg.execute("read_file", { path: "doc.pdf" });
  expect(isText(out)).toBe(true);
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  expect(out as string).toMatch(/PDF|extract|text/i); // never a thrown crash
}, { timeout: 35_000 }); // production intentionally gives the external extractor up to 30s

test("safe PDF reads never execute a workspace-local pdftotext", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "document.pdf"), "%PDF-1.4\n%%EOF\n");
  writeFileSync(join(root, process.platform === "win32" ? "pdftotext.exe" : "pdftotext"), "workspace poison");
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    const out = String(await reg.execute("read_file", { path: "document.pdf" }));
    expect(out).toContain("not found");
    expect(out).not.toContain("Error extracting PDF");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("read_file turns an accidental directory read into a bounded one-level listing and bounds media", async () => {
  const { root, reg } = makeReg();
  writeFileSync(join(root, "visible.txt"), "visible\n");
  const directory = String(await reg.execute("read_file", { path: "." }));
  expect(directory).toContain("[directory .; showing entries]");
  expect(directory).toContain("visible.txt");
  expect(directory).not.toContain("Error:");

  const oversized = join(root, "oversized.png");
  writeFileSync(oversized, "x");
  truncateSync(oversized, 20 * 1024 * 1024 + 1);
  const out = String(await reg.execute("read_file", { path: "oversized.png" }));
  expect(out).toContain("20 MiB read limit");
});

test("mcp_load routes to the hub loader as a safe meta-tool (no approval)", async () => {
  const { reg } = makeReg("default", () => false); // would deny a gated tool
  let gotNames: string[] = [];
  reg.mcp = {
    toolSchemas: () => [],
    has: () => false,
    call: async () => "",
    loadTools: (n: string[]) => { gotNames = n; return `loaded ${n.length}`; },
  };
  expect(await reg.execute("mcp_load", { names: ["mcp__x__a", "mcp__x__b"] })).toBe("loaded 2"); // not denied
  expect(gotNames).toEqual(["mcp__x__a", "mcp__x__b"]);
});

// rg exits 2 whenever ANY error occurred - including one unreadable file (a Windows `nul`, a
// vanished temp file) in a tree full of real matches. That exit must not throw the matches away.
test("formatRipgrepResult: partial read errors keep the matches; only a matchless error is fatal", async () => {
  const { formatRipgrepResult } = await import("../src/core/tool-runtime.ts");
  // One bad file, real matches on stdout (the field report: `rg: .\nul: Incorrect function`).
  const partial = formatRipgrepResult(2, "src\\a.ts:3: hit one\nsrc\\b.ts:9: hit two\n", "rg: .\\nul: Incorrect function. (os error 1)\n");
  expect(partial).toContain("src/a.ts:3: hit one");
  expect(partial).toContain("src/b.ts:9: hit two");
  expect(partial).toContain("some files could not be read");
  expect(partial).not.toStartWith("Error:");
  // A genuinely failed search (bad regex) still errors.
  expect(formatRipgrepResult(2, "", "regex parse error")).toStartWith("Error: regex parse error");
  // The boring paths are unchanged.
  expect(formatRipgrepResult(1, "", "")).toBe("(no matches)");
  expect(formatRipgrepResult(0, "src\\a.ts:1: x\n", "")).toBe("src/a.ts:1: x");
});
