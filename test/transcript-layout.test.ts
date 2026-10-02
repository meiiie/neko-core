import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { TranscriptLayout } from "../src/ui/transcript-layout.ts";

test("full transcript reaches start, middle and end of long prose and tool output", () => {
  for (const kind of ["assistant", "tool_result"] as const) {
    const layout = new TranscriptLayout([{ id: 1, kind, text: Array.from({length: 600}, (_, i) => `ROW_${i}`).join("\n") }], 80);
    expect(layout.totalRows).toBe(601);
    expect(layout.window(0, 1)[0].text).toContain("ROW_0");
    expect(layout.window(300, 1)[0].text).toContain("ROW_300");
    expect(layout.window(599, 1)[0].text).toContain("ROW_599");
    expect(layout.find("ROW_599")).toEqual([599]);
  }
});

test("layout wraps graphemes without splitting emoji or wide characters", () => {
  const text = "界👩‍💻e\u0301".repeat(10);
  const layout = new TranscriptLayout([{id: 1, kind: "assistant", text}], 12);
  const rows = layout.window(0, layout.totalRows).slice(0, -1);
  expect(rows.map(r => r.text.slice(2)).join("")).toBe(text);
  for (const row of rows) expect(stringWidth(row.text)).toBeLessThanOrEqual(12);
});

test("literal search reports deep and repeated results with original Unicode offsets", () => {
  const layout = new TranscriptLayout([{id: 1, kind: "user", text: "İ".repeat(20) + "\nneedle.*\nneedle.*"}], 80);
  expect(layout.find("NEEDLE.*")).toEqual([1, 2]);
  expect(layout.find("missing")).toEqual([]);
});

test("window includes separators and never exceeds its requested height", () => {
  const layout = new TranscriptLayout(Array.from({length: 1000}, (_, id) => ({id, kind: "user" as const, text: `ITEM_${id}`})), 80);
  expect(layout.window(1998, 20).map(r => r.text)).toEqual(["> ITEM_999", ""]);
  expect(layout.window(1000, 12)).toHaveLength(12);
  expect(layout.window(2000, 12)).toEqual([]);
});

test("untrusted controls are escaped instead of being emitted to the terminal", () => {
  const layout = new TranscriptLayout([{id: 1, kind: "tool_result", text: "\x1b]52;c;payload\x07"}], 80);
  expect(layout.window(0, 5).map(r => r.text).join("\n")).not.toContain("\x1b");
});

test("large asynchronous preparation yields and is cancellable", async () => {
  const lines = [{id: 1, kind: "assistant" as const, text: "abc ".repeat(250_000)}];
  const controller = new AbortController();
  let yielded = false;
  setTimeout(() => { yielded = true; controller.abort(); }, 0);
  await expect(TranscriptLayout.create(lines, 80, controller.signal)).rejects.toThrow();
  expect(yielded).toBe(true);
  const ready = await TranscriptLayout.create([{id: 2, kind: "assistant", text: "first\nlast"}], 80, new AbortController().signal);
  expect(ready.window(1, 1)[0].text).toContain("last");
});
