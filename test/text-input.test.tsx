import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { useRef, useState } from "react";

import { TextInput } from "../src/ui/text-input.tsx";

const tick = (ms = 45) => new Promise((r) => setTimeout(r, ms));

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

test("caret is an OVERLAY: EOL shows ▏ (inverse), mid-text inverts the char (no inserted glyph)", async () => {
  // ink-testing-library runs with debug:true which strips ANSI color, so we check the CARET MARKER
  // in the stripped frame: at EOL it is a ▏ (kept as the inverse-cell glyph), mid-text the char under
  // the cursor is rendered twice would be wrong - so we only assert the EOL behavior + that mid-text
  // does NOT insert an extra ▏ glyph (it overlays the existing char instead).
  const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const c = render(<Harness cb={() => {}} />);
  expect(strip(c.lastFrame())).toContain("▏");     // empty input: caret cell shows
  c.stdin.write("ab");
  await tick();
  expect(strip(c.lastFrame())).toContain("ab▏");   // EOL: ▏ after the text
  c.stdin.write("\x1b[D");                          // left -> cursor between a and b
  await tick();
  // Mid-text: the caret OVERLAYS "b" (inverse) rather than inserting a ▏ between a and b.
  // Stripped frame should be "ab" (NOT "a▏b" as the old inserted-glyph caret would).
  expect(strip(c.lastFrame())).not.toContain("a▏b");
  c.unmount();
});

test("caret blinks when idle but stays solid while typing", async () => {
  const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const c = render(<Harness cb={() => {}} />);
  c.stdin.write("ab");
  await tick();
  expect(strip(c.lastFrame())).toContain("ab▏");    // solid immediately after a keystroke
  // Idle: within a couple of blink periods the caret must reach an OFF frame (no ▏ - the cell is blank).
  let sawOff = false;
  for (let i = 0; i < 40 && !sawOff; i++) { await tick(60); if (!strip(c.lastFrame()).includes("ab▏")) sawOff = true; }
  expect(sawOff).toBe(true);                        // it blinked off
  c.stdin.write("c");                               // typing re-solidifies it at once
  await tick();
  expect(strip(c.lastFrame())).toContain("abc▏");
  c.unmount();
}, 15000);

test("mouse activity (scroll/motion) does NOT keep the caret solid - only keys do", async () => {
  const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const c = render(<Harness cb={() => {}} />);
  c.stdin.write("ab");
  await tick();
  expect(strip(c.lastFrame())).toContain("ab▏");
  // Feed a continuous stream of mouse reports (wheel + any-motion) while otherwise idle. If these counted
  // as activity they'd freeze the blink solid forever; the caret must still reach an off frame.
  let sawOff = false;
  for (let i = 0; i < 40 && !sawOff; i++) {
    c.stdin.write("\x1b[<35;5;5M"); // an any-motion mouse report
    await tick(60);
    if (!strip(c.lastFrame()).includes("ab▏")) sawOff = true;
  }
  expect(sawOff).toBe(true); // blinked off despite the mouse traffic
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
  // cellWidth: ascii = 1, CJK = 2, combining = 0
  expect(cellWidth("a")).toBe(1);
  expect(cellWidth("字")).toBe(2);
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
  const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const frame = strip(c.lastFrame());
  expect(frame).not.toContain("secret123");   // no plaintext
  expect(frame).toMatch(/\u2022{9}/);         // 9 bullet chars for 9-char secret
  c.unmount();
});
