import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { Provider, ProviderResponse } from "../src/providers.ts";
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

test("welcome box + input box render on start", () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { lastFrame, unmount } = render(<ChatApp yolo provider={provider} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Neko Code");
  expect(out).toContain("[auto] >"); // bordered input prompt shows the mode
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
  expect(all).toContain("ls("); // tool-call line
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
  await tick(250);
  const all = frames.join("\n");
  expect(all).toContain("(exit 0)"); // tool ran after approval
  expect(all).toContain("Finished"); // final answer
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

test("ApprovalBox shows an edit diff preview", () => {
  const approval = { toolName: "edit", args: { path: "a.ts", old_string: "const x = 1", new_string: "const x = 2" }, resolve: () => {} };
  const { lastFrame, unmount } = render(<ApprovalBox approval={approval} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Approve edit?");
  expect(out).toContain("- const x = 1");
  expect(out).toContain("+ const x = 2");
  unmount();
});
