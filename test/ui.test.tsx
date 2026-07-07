import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { useRef, useState } from "react";

import { Markdown } from "../src/ui/markdown.tsx";
import { TextInput } from "../src/ui/text-input.tsx";

const pasteProps = () => {
  const pastedContents = useRef(new Map<number, string>());
  const nextPasteId = useRef(1);
  return { pastedContents: pastedContents.current, nextPasteId, onCommitPastes: () => { pastedContents.current.clear(); nextPasteId.current = 1; } };
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("TextInput appends a multibyte Vietnamese char as one codepoint (the old bug split it)", async () => {
  let val = "";
  function Wrap() {
    const [v, setV] = useState("");
    val = v;
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} {...pasteProps()} />;
  }
  const { stdin, unmount } = render(<Wrap />);
  stdin.write("ch");
  await tick();
  stdin.write("ệ"); // precomposed U+1EC7
  await tick();
  expect(val).toBe("chệ");
  expect([...val].length).toBe(3); // 3 codepoints, not split/duplicated
  unmount();
});

test("IME backspace+insert composes (no stale-closure duplication: 'mọ' not 'moọ')", async () => {
  const DEL = String.fromCharCode(127); // backspace
  const oDotBelow = String.fromCharCode(0x1ecd); // "ọ"
  let val = "";
  function Wrap() {
    const [v, setV] = useState("mo");
    val = v;
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} {...pasteProps()} />;
  }
  const { stdin, unmount } = render(<Wrap />);
  stdin.write(DEL); // IME deletes "o" -> "m"
  stdin.write(oDotBelow); // ...then inserts the toned vowel, back-to-back
  await tick();
  expect(val).toBe("m" + oDotBelow); // "mọ"
  unmount();
});

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

test("Markdown renders blockquotes and link text", () => {
  const { lastFrame } = render(<Markdown text={"> a quote\nsee [the docs](http://x.io)"} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("a quote");
  expect(out).toContain("the docs"); // link text shown
  expect(out).not.toContain("http://x.io"); // url hidden
});
