import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { Markdown } from "../src/ui/markdown.tsx";
import { TranscriptLine } from "../src/ui/transcript.tsx";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("markdown table renders bold cells, decodes entities and <br>", () => {
  const md = [
    "| **Shop** | **Note** |",
    "|---|---|",
    "| **A** | warranty<br>delivery |",
    "| Cửa h&#224;ng | ok |",
  ].join("\n");
  const out = strip(render(<Markdown text={md} />).lastFrame());
  expect(out).not.toContain("**"); // bold markers stripped
  expect(out).not.toContain("<br>"); // <br> decoded
  expect(out).toContain("Cửa hàng"); // &#224; -> à
});

test("tool_result collapses past 8 lines with a ctrl+o hint", () => {
  const text = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
  const out = strip(render(<TranscriptLine line={{ id: 1, kind: "tool_result", text }} cfg={{} as any} />).lastFrame());
  expect(out).toContain("ctrl+o to expand");
  expect(out).toContain("+4 lines");
  expect(out).not.toContain("line9"); // 9th+ lines hidden
});
