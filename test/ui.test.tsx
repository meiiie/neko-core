import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { Markdown } from "../src/ui/markdown.tsx";

test("Markdown renders headings, bold, inline code, bullets, fences", () => {
  const { lastFrame } = render(<Markdown text={"# Title\n- **bold** and `code`\n\n```\nblock\n```"} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Title");
  expect(out).toContain("bold and code");
  expect(out).toContain("block");
});
