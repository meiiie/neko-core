import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { ApprovalBox, ChatApp } from "../src/ui/chat.tsx";

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** Scripted provider: step responses in order; streams content via onDelta. */
class MockProvider implements Provider {
  index = 0;
  constructor(private script: ProviderResponse[]) {}
  async complete(_messages: any[], _tools?: any[], onDelta?: (t: string) => void): Promise<ProviderResponse> {
    const res = this.script[Math.min(this.index, this.script.length - 1)];
    this.index++;
    if (res.content && onDelta) onDelta(res.content);
    return res;
  }
}

test("resume re-renders the prior conversation", () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const resumed = {
    id: "s1", createdAt: "", updatedAt: "", cwd: process.cwd(), model: "m",
    messages: [{ role: "user", content: "hello before" }, { role: "assistant", content: "earlier reply" }],
  };
  const { lastFrame, unmount } = render(<ChatApp yolo provider={provider} resumedSession={resumed as any} sessionId="s1" />);
  const out = lastFrame() ?? "";
  expect(out).toContain("hello before"); // prior user turn replayed
  expect(out).toContain("earlier reply"); // prior assistant turn replayed
  unmount();
});

test("header + input + status bar render on start", () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { lastFrame, unmount } = render(<ChatApp yolo provider={provider} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("0.2.0"); // version line under the logo
  expect(out).toContain("auto"); // mode shown in the bottom status bar
  expect(out).toContain("shift+tab"); // status bar hint
  unmount();
});

test("auto mode: a safe tool call + markdown answer render end-to-end", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "c1", name: "ls", arguments: {} }] },
    { content: "Done **listing**.", tool_calls: [] },
  ]);
  const { stdin, frames, unmount } = render(<ChatApp yolo provider={provider} />);
  stdin.write("look around");
  await tick(20);
  stdin.write("\r"); // Enter
  await tick(250);
  const all = frames.join("\n");
  expect(all).toContain("> look around"); // user line
  expect(all).toContain("List"); // tool-call line (Claude-style label for ls)
  expect(all).toContain("Done listing"); // markdown-rendered assistant answer
  unmount();
});

test("default mode: gated bash shows the approval box, 'y' approves", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "c1", name: "bash", arguments: { command: "echo hi" } }] },
    { content: "Finished.", tool_calls: [] },
  ]);
  const { stdin, lastFrame, frames, unmount } = render(<ChatApp yolo={false} provider={provider} />);
  stdin.write("run echo");
  await tick(20);
  stdin.write("\r"); // Enter
  await tick(200);
  expect(lastFrame() ?? "").toContain("Approve bash?"); // approval box appeared
  expect(lastFrame() ?? "").toContain("$ echo hi"); // command preview
  stdin.write("y"); // approve
  await tick(600); // async bash: spawn + close + the next provider call
  const all = frames.join("\n");
  expect(all).toContain("(exit 0)"); // tool ran after approval
  expect(all).toContain("Finished"); // final answer
  unmount();
});

test("plan mode: exit_plan_mode shows the plan, 'y' proceeds", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "p", name: "exit_plan_mode", arguments: { plan: "## Plan\n1. do X" } }] },
    { content: "Implemented.", tool_calls: [] },
  ]);
  const { stdin, lastFrame, frames, unmount } = render(<ChatApp yolo={false} provider={provider} />);
  stdin.write("plan it");
  await tick(20);
  stdin.write("\r");
  await tick(200);
  expect(lastFrame() ?? "").toContain("Ready to code?"); // plan review box
  expect(lastFrame() ?? "").toContain("do X"); // plan content rendered
  stdin.write("y"); // approve -> proceed
  await tick(200);
  expect(frames.join("\n")).toContain("Implemented."); // agent continued after approval
  unmount();
});

test("typing '/' shows a slash-command autocomplete menu", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, lastFrame, unmount } = render(<ChatApp yolo provider={provider} />);
  stdin.write("/c");
  await tick(60);
  const out = lastFrame() ?? "";
  expect(out).toContain("/cost");
  expect(out).toContain("/clear");
  expect(out).not.toContain("/exit"); // filtered: doesn't start with /c
  unmount();
});

test("input typed while busy is queued, then drained", async () => {
  // First turn takes a moment; a second submit during it should queue.
  class SlowMock implements Provider {
    i = 0;
    async complete(): Promise<ProviderResponse> {
      this.i++;
      if (this.i === 1) {
        await new Promise((r) => setTimeout(r, 250));
        return { content: "first", tool_calls: [] };
      }
      return { content: "second", tool_calls: [] };
    }
  }
  const { stdin, frames, unmount } = render(<ChatApp yolo provider={new SlowMock()} />);
  const seen = (s: string) => frames.join("\n").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  const until = async (pred: () => boolean, ms = 2500) => { for (let w = 0; w < ms && !pred(); w += 20) await tick(20); return pred(); };

  stdin.write("task one");
  await tick(20);
  stdin.write("\r");
  expect(await until(() => seen("esc to interrupt"))).toBe(true); // turn 1 is in flight (busy) — deterministic
  stdin.write("task two");
  await tick(20);
  stdin.write("\r"); // submitted while busy -> must queue
  expect(await until(() => seen("queued:"))).toBe(true); // queue indicator appeared
  expect(await until(() => seen("second"))).toBe(true); // queued task drained + ran after the first
  unmount();
});

test("ApprovalBox shows an edit diff preview", () => {
  const approval = { toolName: "edit", args: { path: "a.ts", old_string: "const x = 1", new_string: "const x = 2" }, resolve: () => {} };
  const { lastFrame, unmount } = render(<ApprovalBox approval={approval} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Approve edit?");
  expect(out).toContain("- const x = 1");
  expect(out).toContain("+ const x = 2");
  unmount();
});
