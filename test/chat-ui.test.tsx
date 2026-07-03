import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { VERSION } from "../src/shared/version.ts";
import { ApprovalBox, ChatApp, clampToRows, recoverTodos, renderTail } from "../src/ui/chat.tsx";

test("clampToRows bounds the live stream to the viewport height (fixes streaming scroll-jump)", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const out = clampToRows(text, 10, 80);
  expect(out.split("\n").length).toBeLessThanOrEqual(11); // ~10 rows + the "..." marker
  expect(out).toContain("line 99"); // keeps the latest (tail)
  expect(out.startsWith("...")).toBe(true); // marks truncation
  const wide = "x".repeat(240) + "\nshort"; // 240/80 = 3 wrapped rows
  expect(clampToRows(wide, 2, 80).includes("x".repeat(240))).toBe(false); // 3 rows > 2 budget -> dropped
});

test("renderTail bounds live-stream rendering to O(1) so the event loop can't stall on huge output", () => {
  expect(renderTail("short text")).toBe("short text"); // under cap -> unchanged
  const huge = Array.from({ length: 100000 }, (_, i) => `line ${i}`).join("\n"); // ~> 4000 chars
  const out = renderTail(huge, 4000);
  expect(out.length).toBeLessThan(4200); // capped regardless of input size
  expect(out.startsWith("...")).toBe(true); // truncation marker
  expect(out).toContain("line 99999"); // the latest content is kept (the tail)
  expect(out).not.toContain("line 0\n"); // the old head is dropped
});

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
// Poll until a predicate holds (or the budget runs out). Async tool tests must NOT hinge on a fixed
// tick: git-bash spawn + the follow-up provider call vary a lot with machine load, so a fixed wait
// flakes. Budget is per-call; keep (#calls * budget) under each test's jest timeout.
const until = async (pred: () => boolean, ms = 8000) => { for (let w = 0; w < ms && !pred(); w += 20) await tick(20); return pred(); };

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
  expect(out).toContain(VERSION); // version line under the logo
  expect(out).toContain("auto"); // mode shown in the bottom status bar
  expect(out).toContain("shift+tab"); // status bar hint
  unmount();
});

test("slash menu: Down navigates suggestions instead of rewinding the prompt; Tab completes", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { lastFrame, stdin, unmount } = render(<ChatApp yolo provider={provider} />);
  await tick();
  stdin.write("/"); // open the slash menu
  await tick();
  expect(lastFrame() ?? "").toContain("up/down to select, tab to complete"); // menu open
  stdin.write("[B"); // Down arrow — must move the highlight, NOT clear/rewind the input
  await tick();
  // If Down had fallen through to history it would have cleared the input -> menu (and its hint) gone.
  expect(lastFrame() ?? "").toContain("up/down to select, tab to complete"); // still open => prompt intact
  stdin.write("h"); // narrow to /help-ish, then complete with Tab
  await tick();
  stdin.write("\t");
  await tick();
  expect(lastFrame() ?? "").toMatch(/\/h\w+/); // a full command name was filled into the prompt
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
  const seen = (s: string) => frames.join("\n").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  stdin.write("run echo");
  await tick(20);
  stdin.write("\r"); // Enter
  expect(await until(() => (lastFrame() ?? "").includes("Approve bash?"))).toBe(true); // approval box appeared
  expect(lastFrame() ?? "").toContain("$ echo hi"); // command preview
  stdin.write("y"); // approve
  expect(await until(() => seen("(exit 0)"))).toBe(true); // tool ran after approval (git-bash spawn can be slow)
  expect(await until(() => seen("Finished"))).toBe(true); // final answer
  unmount();
}, 40000);

test("plan mode: exit_plan_mode shows the plan, 'y' proceeds", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "p", name: "exit_plan_mode", arguments: { plan: "## Plan\n1. do X" } }] },
    { content: "Implemented.", tool_calls: [] },
  ]);
  const { stdin, lastFrame, frames, unmount } = render(<ChatApp yolo={false} provider={provider} />);
  const seen = (s: string) => frames.join("\n").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  stdin.write("plan it");
  await tick(20);
  stdin.write("\r");
  expect(await until(() => (lastFrame() ?? "").includes("Ready to code?"))).toBe(true); // plan review box
  expect(lastFrame() ?? "").toContain("do X"); // plan content rendered
  stdin.write("y"); // approve -> proceed
  expect(await until(() => seen("Implemented."))).toBe(true); // agent continued after approval
  unmount();
}, 40000);

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
}, 15000); // generous wall-clock: three poll-loops can be slow when the machine is under heavy load

test("ApprovalBox shows an edit diff preview", () => {
  const approval = { toolName: "edit", args: { path: "a.ts", old_string: "const x = 1", new_string: "const x = 2" }, resolve: () => {} };
  const { lastFrame, unmount } = render(<ApprovalBox approval={approval} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Approve edit?");
  expect(out).toContain("- const x = 1");
  expect(out).toContain("+ const x = 2");
  unmount();
});

test("slash menu: Enter completes a PARTIAL command to the highlighted match and runs it", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, lastFrame, unmount } = render(<ChatApp yolo provider={provider} />);
  await tick();
  stdin.write("/hel"); // partial - the menu highlights /help
  await tick();
  expect(lastFrame() ?? "").toContain("up/down to select, tab to complete"); // menu open on the partial
  stdin.write("\r"); // Enter: before the fix this submitted the raw "/hel" (unknown); now it runs /help
  await tick(120);
  const out = (lastFrame() ?? "");
  expect(out).not.toContain("up/down to select"); // menu closed - a command ran
  // /help prints the help text; its header line proves the completed command executed, not "/hel".
  expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/help|commands|\/model|\/resume/i);
  unmount();
}, 15000);

test("recoverTodos: rebuilds the todo tracker from the last todo_write in saved messages", () => {
  const msgs = [
    { role: "user", content: "build X" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }) } }] },
    { role: "tool", tool_call_id: "1", content: "Update Todos" },
    // a LATER todo_write supersedes the earlier one
    { role: "assistant", content: "", tool_calls: [{ function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] }) } }] },
  ];
  const todos = recoverTodos(msgs);
  expect(todos.length).toBe(3); // the LATEST plan
  expect(todos.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
  expect(recoverTodos([{ role: "user", content: "no todos here" }])).toEqual([]); // none -> empty
});
