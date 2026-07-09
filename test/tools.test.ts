import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeToolCall, GATED, resolveTool, SAFE, toOpenAISchema, toolSchemas } from "../src/core/tools.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";

test("read_file refuses a path that escapes the root THROUGH a symlink (not just lexical ../)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nk-root-"));
  const outside = mkdtempSync(join(tmpdir(), "nk-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
  let linked = false;
  // a 'junction' (dir symlink) needs no admin on Windows; skip if the platform still refuses.
  try { symlinkSync(outside, join(root, "link"), "junction"); linked = true; } catch { /* no symlink perm */ }
  if (!linked) return;
  const tools = new ToolRegistry(root, "auto", () => true);
  const res = String(await tools.execute("read_file", { path: "link/secret.txt" }));
  expect(res).toMatch(/escapes project root/i); // refused
  expect(res).not.toContain("TOPSECRET"); // and never leaked the file
});

test("noTools (perception mode) exposes NO tool schemas — vision-only endpoints reject tool-calling", () => {
  const r = new ToolRegistry(process.cwd(), "auto", () => true);
  expect(r.schemas().length).toBeGreaterThan(0);
  r.noTools = true;
  expect(r.schemas()).toEqual([]);
});

test("computer action validates inputs deterministically (no NaN/garbage reaches PowerShell)", async () => {
  const tools = new ToolRegistry(process.cwd(), "auto", () => true);
  if (process.platform !== "win32") {
    // The computer tool drives Windows UI Automation; elsewhere it must refuse UP FRONT with a clear
    // platform message (not a confusing validation error for a tool that can't run anyway).
    expect(String(await tools.execute("computer", { action: "click" }))).toContain("Windows-only");
    return;
  }
  // These all return BEFORE spawnSync, so no PowerShell runs — pure input validation.
  expect(String(await tools.execute("computer", { action: "click" }))).toContain("numeric");
  expect(String(await tools.execute("computer", { action: "click", x: "abc", y: 5 }))).toContain("numeric");
  expect(String(await tools.execute("computer", { action: "stroke", points: [1, 2, "x", 4] }))).toContain("NUMBERS");
  expect(String(await tools.execute("computer", { action: "invoke" }))).toContain("needs 'name'");
  expect(String(await tools.execute("computer", { action: "type" }))).toContain("needs non-empty 'text'");
  expect(String(await tools.execute("computer", { action: "key" }))).toContain("needs 'keys'");
  expect(String(await tools.execute("computer", { action: "scroll", direction: "sideways" }))).toContain("up | down | left | right");
  expect(String(await tools.execute("computer", { action: "scroll", direction: "down", amount: 11 }))).toContain("integer from 1 to 10");
  expect(String(await tools.execute("computer", { action: "wait", duration_ms: -1 }))).toContain("0 to 10000");
  expect(String(await tools.execute("computer", { action: "open" }))).toContain("needs 'target'");
  expect(String(await tools.execute("computer", { action: "bogus" }))).toContain("Unknown computer action");
  expect(String(await tools.execute("computer", { action: "wait", duration_ms: 1 }))).toContain("waited 1 ms");
});

test("computer screenshot embeds vision bytes, while text-only mode keeps the helper path", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "nk-shot-root-"));
  const skill = join(root, "computer-use");
  const scripts = join(skill, "scripts");
  mkdirSync(scripts, { recursive: true });
  // A deterministic 1x1 GIF avoids reading the developer's real desktop in the unit suite.
  writeFileSync(join(scripts, "screenshot.ps1"), [
    'param([string]$out)',
    '[IO.File]::WriteAllBytes($out,[Convert]::FromBase64String("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="))',
    '[IO.File]::WriteAllText((Join-Path $PSScriptRoot "capture-path.txt"),$out)',
    'Write-Output ("saved $out view=1x1 screen=1x1 scale=1")',
  ].join("\n"));
  const tools = new ToolRegistry(root, "auto", () => true);
  tools.loadSkill = () => ({ body: "", dir: skill });
  const textOnly = String(await tools.execute("computer", { action: "screenshot" }));
  const fallbackPath = textOnly.match(/^saved\s+(.+?)\s+view=/)?.[1];
  expect(fallbackPath).toBeTruthy();
  expect(existsSync(fallbackPath!)).toBe(true); // separate vision helper can consume it
  rmSync(fallbackPath!, { force: true });

  tools.vision = true;
  const result = await tools.execute("computer", { action: "screenshot" });
  expect(Array.isArray(result)).toBe(true);
  const parts = result as any[];
  expect(parts.find((p) => p.type === "text").text).toContain("captured view=1x1 screen=1x1 scale=1");
  expect(parts.find((p) => p.type === "image_url").image_url.url).toContain("data:image/gif;base64,");
  const stalePath = parts.find((p) => p.type === "text").text.match(/neko_shot_\d+\.gif/)?.[0];
  expect(stalePath).toBeUndefined(); // dead temp paths are not advertised to the model
  const capturePath = readFileSync(join(scripts, "capture-path.txt"), "utf8");
  expect(existsSync(capturePath)).toBe(false); // bytes are embedded before finally removes the file
});

test("describeToolCall uses Claude-style labels + primary arg", () => {
  expect(describeToolCall("read_file", { path: "src/a.ts" })).toBe("Read(src/a.ts)");
  expect(describeToolCall("edit", { path: "a.ts" })).toBe("Update(a.ts)");
  expect(describeToolCall("bash", { command: "bun test" })).toBe("Bash(bun test)");
  expect(describeToolCall("ls", {})).toBe("List");
  expect(describeToolCall("todo_write", { todos: [] })).toBe("Update Todos");
  expect(describeToolCall("web_search", { query: "x" })).toBe("WebSearch(x)");
  expect(describeToolCall("web_fetch", { url: "http://x.io" })).toBe("Fetch(http://x.io)");
});

test("schema shape", () => {
  const s = toOpenAISchema(resolveTool("read_file"));
  expect(s.type).toBe("function");
  expect(s.function.name).toBe("read_file");
  expect(s.function.parameters.required).toEqual(["path"]);
});

test("tool order", () => {
  const expected = [
    "read_file", "search", "glob", "ls", "write_file", "edit", "multi_edit", "bash", "computer", "todo_write",
    "web_search", "web_fetch", "exit_plan_mode", "task", "memory", "skill", "workflow", "playbook",
  ];
  if (process.platform !== "win32") expected.splice(expected.indexOf("computer"), 1);
  expect(toolSchemas().map((t: any) => t.function.name)).toEqual(expected);
});

test("tool schemas hide Windows-only computer control on other platforms", () => {
  expect(toolSchemas("linux").map((t: any) => t.function.name)).not.toContain("computer");
  expect(toolSchemas("win32").map((t: any) => t.function.name)).toContain("computer");
});

test("resolve unknown throws", () => {
  expect(() => resolveTool("nope")).toThrow();
});

test("permission classes", () => {
  expect(resolveTool("read_file").permission).toBe(SAFE);
  expect(resolveTool("glob").permission).toBe(SAFE);
  expect(resolveTool("write_file").permission).toBe(GATED);
  expect(resolveTool("edit").permission).toBe(GATED);
  expect(resolveTool("computer").permission).toBe(GATED);
});
