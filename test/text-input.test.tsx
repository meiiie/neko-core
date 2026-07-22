import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { useRef, useState } from "react";

import { TextInput } from "../src/ui/text-input.tsx";

const tick = (ms = 45) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

/** Default paste-collapse props TextInput now requires (owned by the parent in real use). */
function usePasteProps() {
  const pastedContents = useRef(new Map<number, string>());
  const nextPasteId = useRef(1);
  return { pastedContents: pastedContents.current, nextPasteId, onCommitPastes: () => { pastedContents.current.clear(); nextPasteId.current = 1; } };
}

function Harness({ cb }: { cb: (v: string) => void }) {
  const [v, setV] = useState("");
  return <TextInput value={v} onChange={setV} onSubmit={cb} {...usePasteProps()} />;
}

test("inserts at the cursor after moving left", async () => {
  let out = "";
  const c = render(<Harness cb={(v) => (out = v)} />);
  c.stdin.write("a");
  await tick();
  c.stdin.write("c");
  await tick();
  c.stdin.write("\x1b[D"); // left arrow -> cursor between a and c
  await tick();
  c.stdin.write("b");
  await tick();
  c.stdin.write("\r");
  await tick();
  expect(out).toBe("abc");
  c.unmount();
});

test("a multi-line paste inserts without submitting early", async () => {
  let submitted: string | null = null;
  let last = "";
  function H2() {
    const [v, setV] = useState("");
    last = v;
    return <TextInput value={v} onChange={setV} onSubmit={(x) => (submitted = x)} {...usePasteProps()} />;
  }
  const c = render(<H2 />);
  c.stdin.write("foo();\nbar();"); // one paste chunk with a newline
  await tick();
  expect(submitted).toBeNull(); // did NOT submit on the embedded newline
  expect(last).toBe("foo();\nbar();");
  c.unmount();
});

test("modified Enter inserts a newline instead of submitting (CSI-u shift, modifyOtherKeys, \\x1b\\r meta)", async () => {
  let submitted: string | null = null;
  let last = "";
  function H() {
    const [v, setV] = useState("");
    last = v;
    return <TextInput value={v} onChange={setV} onSubmit={(x) => (submitted = x)} {...usePasteProps()} />;
  }
  const c = render(<H />);
  c.stdin.write("a");
  await tick();
  c.stdin.write("\x1b[13;2u"); // Shift+Enter, kitty CSI-u (Ink parses it to return+shift)
  await tick();
  c.stdin.write("\x1b[27;5;13~"); // Ctrl+Enter, xterm modifyOtherKeys (raw sequence route)
  await tick();
  c.stdin.write("\x1b\r"); // \x1b\r terminal-setup-style binding (return+meta)
  await tick();
  c.stdin.write("b");
  await tick();
  expect(submitted).toBeNull();
  expect(last).toBe("a\n\n\nb");
  c.unmount();
});

test("backslash + Enter continues the line in ANY terminal (no special sequence needed)", async () => {
  let submitted: string | null = null;
  let last = "";
  function H() {
    const [v, setV] = useState("");
    last = v;
    return <TextInput value={v} onChange={setV} onSubmit={(x) => (submitted = x)} {...usePasteProps()} />;
  }
  const c = render(<H />);
  c.stdin.write("line1\\");
  await tick();
  c.stdin.write("\r"); // trailing backslash -> newline, no submit
  await tick();
  c.stdin.write("line2");
  await tick();
  expect(submitted).toBeNull();
  expect(last).toBe("line1\nline2");
  c.stdin.write("\r"); // plain Enter still submits
  await tick();
  expect(String(submitted)).toBe("line1\nline2");
  c.unmount();
});

test("caretIndexForClick maps screen deltas to codepoint indexes on the wrap geometry", async () => {
  const { caretIndexForClick } = await import("../src/ui/text-input.tsx");
  // Single line, caret at end of "hello" (index 5): click 3 cells left -> index 2.
  expect(caretIndexForClick("hello", 5, 80, 0, -3)).toBe(2);
  // Click far left clamps to the line start; far right clamps to the end.
  expect(caretIndexForClick("hello", 3, 80, 0, -99)).toBe(0);
  expect(caretIndexForClick("hello", 3, 80, 0, 99)).toBe(5);
  // Multiline: caret at end of "bb" (index 5, line 1); click one row up, same column -> "aa" line.
  expect(caretIndexForClick("aa\nbb", 5, 80, -1, 0)).toBe(2);
  // ...and one row down from line 0 lands on line 1.
  expect(caretIndexForClick("aa\nbb", 0, 80, 1, 0)).toBe(3);
  // Row deltas clamp to the first/last line.
  expect(caretIndexForClick("aa\nbb", 0, 80, 99, 99)).toBe(5);
});

test("isEscapeResidue: single sequences AND concatenated bursts; never real text", async () => {
  const { isEscapeResidue } = await import("../src/ui/text-input.tsx");
  expect(isEscapeResidue("[<64;97;33M")).toBe(true);                       // one mouse report, ESC stripped
  expect(isEscapeResidue("\x1b[<64;97;33M")).toBe(true);                   // with ESC
  expect(isEscapeResidue("[<0;97;33M[<0;97;33m[<64;97;33M")).toBe(true);   // BURST (the leak from the field)
  expect(isEscapeResidue("[A")).toBe(true);                                // cursor-key residue
  expect(isEscapeResidue("hello")).toBe(false);
  expect(isEscapeResidue("a")).toBe(false);
  expect(isEscapeResidue("[bracketed text]")).toBe(false);                 // real text with brackets
});

test("ignores stray escape sequences (mouse reports) - never leak into the text", async () => {
  let out = "";
  let last = "";
  function H3() {
    const [v, setV] = useState("");
    last = v;
    return <TextInput value={v} onChange={setV} onSubmit={(x) => (out = x)} {...usePasteProps()} />;
  }
  const c = render(<H3 />);
  c.stdin.write("hi");
  await tick();
  c.stdin.write("\x1b[<64;10;5M"); // an SGR mouse wheel report
  await tick();
  expect(last).toBe("hi");            // the mouse bytes did not land in the line
  expect(last).not.toContain("64;10;5");
  c.unmount();
});

test("caret is the HARDWARE cursor: no glyph in the text, a zero-width sentinel marks the spot", async () => {
  // The caret is the terminal's real cursor (positioned by the differ from a zero-width sentinel).
  // In isolation (no differ) the sentinel is present but ZERO-WIDTH, so the visible text is TIGHT -
  // "ab" not "ab' + BAR + '", and mid-text "ab" not "a' + BAR + 'b" (no drawn glyph, no gap, no block).
  const SENT = "⁠";
  const c = render(<Harness cb={() => {}} />);
  expect(strip(c.lastFrame())).toContain(SENT);           // empty: the caret sentinel is placed
  c.stdin.write("ab");
  await tick();
  const eol = strip(c.lastFrame());
  expect(eol).toContain("ab");                            // text is tight
  expect(eol).not.toContain("' + BAR + '");                            // NO glyph drawn in the text
  expect(eol.replace(SENT, "")).toContain("ab");         // sentinel is zero-width -> text reads clean
  c.stdin.write("[D");                                // left -> cursor between a and b
  await tick();
  const mid = strip(c.lastFrame());
  expect(mid.replace(SENT, "")).toContain("ab");         // still tight "ab" (sentinel sits between them)
  expect(mid).not.toContain("' + BAR + '");                            // never a glyph
  expect(mid).not.toContain("abb");                      // never a duplicated char
  c.unmount();
});

test("caret sentinel is placed after a keystroke and moves with typing", async () => {
  const SENT = "⁠";
  const c = render(<Harness cb={() => {}} />);
  c.stdin.write("ab");
  await tick();
  expect(strip(c.lastFrame())).toContain("ab" + SENT);   // caret sentinel right after the text
  c.stdin.write("c");
  await tick();
  expect(strip(c.lastFrame())).toContain("abc" + SENT);  // follows the new position
  c.unmount();
}, 15000);

test("mouse activity (scroll/motion) does NOT corrupt input or the caret", async () => {
  const c = render(<Harness cb={() => {}} />);
  c.stdin.write("ab");
  await tick();
  expect(strip(c.lastFrame())).toContain("ab");
  // A stream of mouse reports while otherwise idle must not be inserted as text.
  for (let i = 0; i < 10; i++) {
    c.stdin.write("[<35;5;5M"); // an any-motion mouse report
    await tick(60);
  }
  const frame = strip(c.lastFrame());
  expect(frame).toContain("ab");        // text intact
  expect(frame).not.toContain("35;5;5"); // no escape residue leaked into the value
  c.unmount();
}, 15000);

test("end-typing stays codepoint/NFC correct (IME path)", async () => {
  let out = "";
  const c = render(<Harness cb={(v) => (out = v)} />);
  for (const ch of "tieng") {
    c.stdin.write(ch);
    await tick();
  }
  c.stdin.write("\r");
  await tick();
  expect(out).toBe("tieng");
  c.unmount();
});

test("wrap: a long single-line value (no newline) wraps to multiple visual lines", async () => {
  const { wrapInput, cellWidth } = await import("../src/ui/text-input.tsx");
  // pure helper: "abcdef" at width 3 -> 3 lines (abc / def / caret-line), caret at end
  const cps = [..."abcdef"];
  const w = wrapInput(cps, cps.length, 3);
  expect(w.lines.length).toBe(2);             // "abc" and "def"
  expect(w.lines[0].cells.map((c) => c.ch).join("")).toBe("abc");
  expect(w.lines[1].cells.map((c) => c.ch).join("")).toBe("def");
  expect(w.caretLine).toBe(1);                // caret at EOL -> last line
  expect(wrapInput(cps, 3, 3).caretLine).toBe(1); // caret before "d" -> start of second line
  // cellWidth: ascii = 1, CJK = 2, combining = 0
  expect(cellWidth("a")).toBe(1);
  expect(cellWidth("字")).toBe(2);
  expect(cellWidth("😀")).toBe(2);
  expect(cellWidth("\u0301")).toBe(0);        // combining acute
});

test("wrap renders multiple visual lines in the frame (integration)", async () => {
  function H4() {
    const [v, setV] = useState("the quick brown fox jumps over");
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} width={20} {...usePasteProps()} />;
  }
  const c = render(<H4 />);
  await tick();
  const frame = c.lastFrame() ?? "";
  const lines = frame.split("\n");
  expect(lines.length).toBeGreaterThan(1);    // wrapped to 2+ visual lines
  expect(frame).toContain("the quick brown"); // first visual line present
  c.unmount();
});

test("mask renders bullets and stays single-line (no wrap fan-out)", async () => {
  function H5() {
    const [v, setV] = useState("secret123");
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} width={40} mask {...usePasteProps()} />;
  }
  const c = render(<H5 />);
  await tick();
  const frame = strip(c.lastFrame());
  expect(frame).not.toContain("secret123");   // no plaintext
  expect(frame).toMatch(/\u2022{9}/);         // 9 bullet chars for 9-char secret
  c.unmount();
});

test("mask never leaks plaintext in single-line, multiline, or wrapped render paths", async () => {
  function Masked({ value, width }: { value: string; width: number }) {
    const [v, setV] = useState(value);
    return <TextInput value={v} onChange={setV} onSubmit={() => {}} width={width} mask {...usePasteProps()} />;
  }

  const assertNoLeak = (frame: string, secret: string) => {
    for (const ch of new Set([...secret].filter((c) => c !== "\n"))) {
      expect(frame).not.toContain(ch);
    }
  };

  const single = render(<Masked value="secret99" width={40} />);
  single.stdin.write("\x1b[D");
  await tick();
  const singleFrame = strip(single.lastFrame());
  assertNoLeak(singleFrame, "secret99");
  // cursor moved left -> the inserted caret splits the bullet run, so count TOTAL bullets (8), not a block
  expect((singleFrame.match(/\u2022/g) ?? []).length).toBe(8);
  single.unmount();

  const multilineSecret = "top\nsecret9";
  const multiline = render(<Masked value={multilineSecret} width={40} />);
  await tick();
  assertNoLeak(strip(multiline.lastFrame()), multilineSecret);
  multiline.unmount();

  const wrappedSecret = "verylongsecretvalue";
  const wrapped = render(<Masked value={wrappedSecret} width={5} />);
  await tick();
  const wrappedFrame = strip(wrapped.lastFrame());
  expect(wrappedFrame.split("\n").length).toBeGreaterThan(1);
  assertNoLeak(wrappedFrame, wrappedSecret);
  wrapped.unmount();
});

test("wrapInput does not emit a spurious empty line for a wide char narrower than width", async () => {
  const { wrapInput } = await import("../src/ui/text-input.tsx");
  // A 2-cell CJK char on a 1-col box: must occupy ONE line (no leading empty line), per the
  // "each visual line <= width" invariant (relaxed only when a single cell is wider than width).
  const w = wrapInput([..."字"], 0, 1);
  expect(w.lines.length).toBe(1);
  expect(w.lines[0].cells.length).toBe(1);
});

test("wrapInput breaks at a SPACE (word wrap), carrying the partial word - and the caret with it", async () => {
  const { wrapInput } = await import("../src/ui/text-input.tsx");
  // "ab cde" at width 5: greedy char-wrap would give "ab cd"/"e" (splitting "cde"); word-wrap keeps
  // the word whole -> "ab " / "cde" (image #79: "đã đấ|m" must not break mid-word).
  const cps = [..."ab cde"];
  const w = wrapInput(cps, cps.length, 5);
  expect(w.lines.map((l) => l.cells.map((c) => c.ch).join(""))).toEqual(["ab ", "cde"]);
  // caret at end rides the carried word -> second line
  expect(w.caretLine).toBe(1);
  // caret INSIDE the carried word (index 4 = "d") is also on the second line
  expect(wrapInput(cps, 4, 5).caretLine).toBe(1);
});

test("wrapInput hard-breaks a single word wider than the whole box (no space to break at)", async () => {
  const { wrapInput } = await import("../src/ui/text-input.tsx");
  // "abcdef" width 3, no spaces -> falls back to char-wrap "abc"/"def" (a word longer than the line
  // still has to break somewhere).
  const w = wrapInput([..."abcdef"], 6, 3);
  expect(w.lines.map((l) => l.cells.map((c) => c.ch).join(""))).toEqual(["abc", "def"]);
});

test("mask preserves line breaks in a multiline value (not collapsed to one bullet row)", async () => {
  const { render } = await import("ink-testing-library");
  const { useRef } = await import("react");
  const pp = () => { const p = useRef(new Map<number, string>()); const n = useRef(1); return { pastedContents: p.current, nextPasteId: n }; };
  function Masked({ value, width }: { value: string; width: number }) {
    const props = pp();
    return <TextInput value={value} onChange={() => {}} onSubmit={() => {}} width={width} mask {...props} />;
  }
  const c = render(<Masked value={"top\nsecret"} width={40} />);
  await tick();
  const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const frame = strip(c.lastFrame());
  expect(frame.split("\n").length).toBeGreaterThan(1); // line break preserved
  expect(frame).not.toContain("top");
  expect(frame).not.toContain("secret");
  c.unmount();
});
