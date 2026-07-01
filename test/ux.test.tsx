/** UX/UI coverage: status bar, thinking line, reasoning, hotkeys, diff preview, completion line. */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { RunningLine, ThinkingLine } from "../src/ui/thinking-line.tsx";
import { ApprovalBox } from "../src/ui/approval-box.tsx";
import { TranscriptLine } from "../src/ui/transcript.tsx";
import { NekoConfig } from "../src/adapters/config.ts";

const CFG = new NekoConfig({}, null, {}, "");

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
/** Poll the render until any frame matches — robust against streaming throttle / event-loop timing. */
async function until(c: { frames: string[] }, pred: (allFrames: string) => boolean, ms = 1500): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (pred(strip(c.frames.join("\n")))) return true;
    await tick(25);
  }
  return pred(strip(c.frames.join("\n")));
}

class Echo implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.("hello");
    return { content: "hello", tool_calls: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } };
  }
}

class Reasoner implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.("let me think hard", "reasoning");
    await tick(60);
    onDelta?.("the answer");
    return { content: "the answer", tool_calls: [] };
  }
}

test("status bar shows mode + context %", () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  const f = strip(c.lastFrame());
  expect(f).toContain("auto");
  expect(f).toContain("ctx");
  expect(f).toContain("shift+tab");
  c.unmount();
});

test("ThinkingLine shows effort + per-turn tokens", () => {
  const f = strip(render(<ThinkingLine verb="Thinking" elapsed={11} tokens={1200} step={1} queued={0} effort="xhigh" />).lastFrame());
  expect(f).toContain("xhigh effort");
  expect(f).toContain("1.2k tok");
  expect(f).toContain("esc to interrupt");
});

test("ApprovalBox renders an edit diff preview (- old / + new)", () => {
  const f = strip(render(<ApprovalBox approval={{ toolName: "edit", args: { path: "a.ts", old_string: "let x = 1", new_string: "let x = 2" }, resolve: () => {} }} />).lastFrame());
  expect(f).toContain("- let x = 1");
  expect(f).toContain("+ let x = 2");
});

test("reasoning shows live while busy, clears when done", async () => {
  const c = render(<ChatApp yolo provider={new Reasoner()} />);
  await tick();
  c.stdin.write("go");
  await tick(20);
  c.stdin.write("\r");
  expect(await until(c, (f) => f.includes("let me think hard"))).toBe(true); // shown mid-turn
  expect(await until(c, (f) => f.includes("the answer"))).toBe(true); // final answer lands
  expect(strip(c.lastFrame())).not.toContain("let me think hard"); // thinking cleared when done
  c.unmount();
});

test("post-turn run-time line + placeholder drops after first turn", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  expect(strip(c.lastFrame())).toContain("Try:"); // placeholder before the first turn
  c.stdin.write("hi");
  await tick(20);
  c.stdin.write("\r");
  expect(await until(c, (f) => /for \d+s/.test(f))).toBe(true); // completion line appears
  expect(strip(c.lastFrame())).not.toContain("Try:"); // placeholder gone
  c.unmount();
});

test("Shift+Tab cycles the permission mode (auto -> default)", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  expect(strip(c.lastFrame())).toContain("auto");
  c.stdin.write("\x1b[Z"); // Shift+Tab
  await tick(50);
  expect(strip(c.lastFrame())).toContain("default");
  c.unmount();
});

test("slash menu autocompletes as you type", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/mod");
  await tick(50);
  expect(strip(c.lastFrame())).toContain("/model");
  c.unmount();
});

test("/help lists the command set", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/help");
  await tick(20);
  c.stdin.write("\r");
  await tick(60);
  expect(strip(c.frames.join("\n"))).toContain("Commands:");
  c.unmount();
});

test("error lines render with a visible marker (not a dim info line)", () => {
  const f = strip(render(<TranscriptLine line={{ id: 1, kind: "error", text: "HTTP 500" }} cfg={CFG} />).lastFrame());
  expect(f).toContain("✗ HTTP 500");
});

test("expanded tool result keeps the diff +/- lines", () => {
  const diff = "Edited f.ts  (+1 -1)\n-    3  old();\n+    3  new();";
  const f = strip(render(<TranscriptLine line={{ id: 1, kind: "tool_result_full", text: diff }} cfg={CFG} />).lastFrame());
  expect(f).toContain("- ");
  expect(f).toContain("old();");
  expect(f).toContain("new();");
});

test("RunningLine shows a dot + the tool label while a call is in flight", () => {
  const f = strip(render(<RunningLine text="Running ls" />).lastFrame());
  expect(f).toContain("Running ls");
  expect(f).toContain("●"); // the (blinking) running dot
});

test("write_file approval previews size + a '+N more lines' hint", () => {
  const content = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
  const f = strip(render(<ApprovalBox approval={{ toolName: "write_file", args: { path: "x.html", content }, resolve: () => {} }} />).lastFrame());
  expect(f).toContain("20 lines");
  expect(f).toContain("+12 more lines");
});

test("typing '/' caps the command list with a '+N more' hint", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/");
  await tick(50);
  expect(strip(c.lastFrame())).toMatch(/\+\d+ more/);
  c.unmount();
});

test("Ctrl+C clears a non-empty input (does not exit)", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("some draft text");
  await tick(20);
  c.stdin.write("\x03"); // Ctrl+C
  await tick(40);
  expect(strip(c.lastFrame())).not.toContain("some draft text");
  c.unmount();
});
