import { expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { TranscriptViewer } from "../src/ui/transcript-viewer.tsx";
import { buildReplayLines } from "../src/ui/chat-lines.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 100));

test("ordinary transcript exposes final tool rows beyond400 and search navigates deep matches", async () => {
  let id = 0;
  const lines = buildReplayLines([{role: "tool", content: Array.from({length: 600}, (_, i) => `TOOL_ROW_${i}`).join("\n")}], () => ++id);
  const c = render(<TranscriptViewer lines={lines} cols={80} rows={20} onClose={() => {}} />);
  try {
    await tick();
    expect(c.lastFrame()).toContain("TOOL_ROW_599");
    c.stdin.write("TOOL_ROW_300");
    await tick();
    expect(c.lastFrame()).toContain("found 1");
    expect(c.lastFrame()).toContain("TOOL_ROW_300");
    c.stdin.write("\x1b");
    await tick();
    expect(c.lastFrame()).toContain("TOOL_ROW_599");
  } finally { c.unmount(); }
});

test("repeated search navigates both matches without losing surrounding text", async () => {
  const text = Array.from({length: 100}, (_, i) => `${i === 20 || i === 80 ? 'TARGET' : 'ROW'}_${i}`).join("\n");
  const c = render(<TranscriptViewer lines={[{id: 1, kind: "assistant", text}]} cols={80} rows={20} onClose={() => {}} />);
  try {
    await tick(); c.stdin.write("TARGET"); await tick();
    expect(c.lastFrame()).toContain("TARGET_20");
    c.stdin.write("\t"); await tick();
    expect(c.lastFrame()).toContain("TARGET_80");
    c.stdin.write("\x1b[Z"); await tick();
    expect(c.lastFrame()).toContain("TARGET_20");
  } finally { c.unmount(); }
});

test("resize keeps a deep reading anchor instead of jumping to the newest message", async () => {
  const lines = [{id: 1, kind: "assistant" as const, text: Array.from({length: 100}, (_, i) => `LINE_${i} ${'x'.repeat(40)}`).join("\n")}];
  const close = () => {};
  const c = render(<TranscriptViewer lines={lines} cols={80} rows={20} onClose={close} />);
  try {
    await tick();
    c.stdin.write("LINE_40 "); await tick();
    expect(c.lastFrame()).toContain("LINE_40");
    c.rerender(<TranscriptViewer lines={lines} cols={40} rows={20} onClose={close} />);
    await tick();
    expect(c.lastFrame()).toContain("LINE_40");
    expect(c.lastFrame()).not.toContain("LINE_99");
  } finally { c.unmount(); }
});


test("fullscreen flex siblings cannot shrink individual transcript rows out of view", async () => {
  const lines = [{id: 1, kind: "tool_result" as const, text: Array.from({length: 100}, (_, i) => `ROW_${i}`).join("\n")}];
  const c = render(<Box flexDirection="column" height={19}>
    <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden"><Text>{"prior\n".repeat(8)}</Text></Box>
    <TranscriptViewer lines={lines} cols={80} rows={20} onClose={() => {}} />
  </Box>);
  try {
    await tick();
    for (let i = 88; i < 100; i++) expect(c.lastFrame()).toContain(`ROW_${i}`);
  } finally { c.unmount(); }
});
