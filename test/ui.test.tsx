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

test("Alt+V inserts the [Image #N] token AT THE CARET (inline, Claude-Code style)", async () => {
  let val = "";
  function Wrap() {
    const [v, setV] = useState("");
    val = v;
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} onPasteImage={() => "[Image #1]"} {...pasteProps()} />;
  }
  const { stdin, unmount } = render(<Wrap />);
  stdin.write("look  now"); // caret sits at the end; move it between the two spaces
  await tick();
  stdin.write("\x1b[D\x1b[D\x1b[D\x1b[D"); // four lefts -> after "look "
  await tick();
  stdin.write("\x1bv"); // Alt+V
  await tick();
  expect(val).toBe("look [Image #1]  now"); // token landed inline at the caret, not appended
  unmount();
});

test("Alt+V with no clipboard image (hook returns null) leaves the input untouched", async () => {
  let val = "";
  function Wrap() {
    const [v, setV] = useState("");
    val = v;
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} onPasteImage={() => null} {...pasteProps()} />;
  }
  const { stdin, unmount } = render(<Wrap />);
  stdin.write("hi");
  await tick();
  stdin.write("\x1bv");
  await tick();
  expect(val).toBe("hi");
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

test("Markdown renders blockquotes and link text (url carried as an OSC 8 hyperlink, not shown)", () => {
  const { lastFrame } = render(<Markdown text={"> a quote\nsee [the docs](http://x.io)"} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("a quote");
  expect(out).toContain("the docs"); // link text shown
  expect(out).toContain("\x1b]8;;http://x.io\x07"); // the url IS carried - as a real hyperlink
  const visible = out.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
  expect(visible).not.toContain("http://x.io"); // ...but never rendered as visible text
});
