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

test("Markdown renders a table aligned by columns", () => {
  const { lastFrame } = render(<Markdown text={"| Name | Age |\n|---|---|\n| Neko | 1 |"} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Name");
  expect(out).toContain("Age");
  expect(out).toContain("Neko");
});

test("Markdown highlights code while preserving the text", () => {
  const { lastFrame } = render(<Markdown text={'```\nconst x = "hi"; // note\n```'} />);
  expect(lastFrame() ?? "").toContain('const x = "hi"; // note');
});
