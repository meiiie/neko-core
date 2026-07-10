import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { fileUri, linkSegments, osc8, sanitizeUri } from "../src/ui/links.ts";
import { TranscriptLine } from "../src/ui/transcript.tsx";

const OPEN = "\x1b]8;;";
const CLOSE = "\x1b]8;;\x07";

// ---- helpers -------------------------------------------------------------------------------------

test("osc8 wraps text in an OSC 8 hyperlink; an empty URI yields bare text", () => {
  expect(osc8("https://a.vn/x", "label")).toBe(OPEN + "https://a.vn/x\x07label" + CLOSE);
  expect(osc8("", "label")).toBe("label");
});

test("sanitizeUri strips control bytes (an embedded ESC/BEL would corrupt the sequence - injection defense)", () => {
  expect(sanitizeUri("https://a.vn/\x1b]8;;evil\x07x")).toBe("https://a.vn/]8;;evilx");
  expect(osc8("\x07\x1b", "t")).toBe("t"); // nothing left after sanitize -> bare text, never a broken sequence
});

test("fileUri: Windows drive path -> file:/// URI with encoded spaces and #", () => {
  expect(fileUri("E:\\Sach\\Sua\\file name.pptx")).toBe("file:///E:/Sach/Sua/file%20name.pptx");
  expect(fileUri("C:/a#b.txt")).toBe("file:///C:/a%23b.txt");
  expect(fileUri("/home/u/x.txt")).toBe("file:///home/u/x.txt");
});

test("linkSegments finds bare URLs and absolute Windows paths, excluding trailing punctuation", () => {
  const segs = linkSegments("xem https://tiki.vn/p/123. va E:\\docs\\deck.pptx nhe");
  expect(segs).toEqual([
    "xem ",
    { uri: "https://tiki.vn/p/123", text: "https://tiki.vn/p/123" },
    ". va ",
    { uri: "file:///E:/docs/deck.pptx", text: "E:\\docs\\deck.pptx" },
    " nhe",
  ]);
});

test("linkSegments leaves non-targets alone (bare drive, bare scheme, plain prose)", () => {
  expect(linkSegments("gia $5 va C: la o dia")).toEqual(["gia $5 va C: la o dia"]);
  expect(linkSegments("https:// khong phai link")).toEqual(["https:// khong phai link"]);
});

// ---- transcript lines ----------------------------------------------------------------------------

test("tool_call line: an existing file path becomes a file:// hyperlink; a command stays plain", () => {
  const cfg: any = {};
  const linked = render(<TranscriptLine line={{ id: 1, kind: "tool_call", text: "Read(src/core/agent.ts)" }} cfg={cfg} />).lastFrame() ?? "";
  expect(linked).toContain(OPEN + "file:///");
  expect(linked).toContain("agent.ts");
  const missing = render(<TranscriptLine line={{ id: 2, kind: "tool_call", text: "Read(no/such/file.ts)" }} cfg={cfg} />).lastFrame() ?? "";
  expect(missing).not.toContain(OPEN);
  const cmd = render(<TranscriptLine line={{ id: 3, kind: "tool_call", text: "Bash(ls -la)" }} cfg={cfg} />).lastFrame() ?? "";
  expect(cmd).not.toContain(OPEN);
});

test("tool_result plain line: a bare URL becomes a real hyperlink (web_search results must be reachable)", () => {
  const cfg: any = {};
  const out = render(
    <TranscriptLine line={{ id: 4, kind: "tool_result", text: "1. iPhone 15 gia tot - https://cellphones.com.vn/iphone-15.html" }} cfg={cfg} />,
  ).lastFrame() ?? "";
  expect(out).toContain(OPEN + "https://cellphones.com.vn/iphone-15.html\x07");
  expect(out).toContain(CLOSE);
});
