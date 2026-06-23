/** UX/UI coverage: status bar, thinking line, reasoning, hotkeys, diff preview, completion line. */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { ThinkingLine } from "../src/ui/thinking-line.tsx";
import { ApprovalBox } from "../src/ui/approval-box.tsx";

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

class Echo implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: string) => void): Promise<ProviderResponse> {
    onDelta?.("hello");
    return { content: "hello", tool_calls: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } };
  }
}

class Reasoner implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: string) => void): Promise<ProviderResponse> {
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
  await tick(35);
  expect(strip(c.frames.join("\n"))).toContain("let me think hard"); // shown mid-turn
  await tick(250);
  expect(strip(c.lastFrame())).not.toContain("let me think hard"); // gone when done
  expect(strip(c.lastFrame())).toContain("the answer");
  c.unmount();
});

test("post-turn run-time line + placeholder drops after first turn", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  expect(strip(c.lastFrame())).toContain("Try:"); // placeholder before the first turn
  c.stdin.write("hi");
  await tick(20);
  c.stdin.write("\r");
  await tick(250);
  expect(strip(c.frames.join("\n"))).toMatch(/for \d+s/); // completion line
  expect(strip(c.lastFrame())).not.toContain("Try:"); // placeholder gone
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
