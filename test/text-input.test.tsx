import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { useState } from "react";

import { TextInput } from "../src/ui/text-input.tsx";

const tick = (ms = 45) => new Promise((r) => setTimeout(r, ms));

function Harness({ cb }: { cb: (v: string) => void }) {
  const [v, setV] = useState("");
  return <TextInput value={v} onChange={setV} onSubmit={cb} />;
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
    return <TextInput value={v} onChange={setV} onSubmit={(x) => (submitted = x)} />;
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
    return <TextInput value={v} onChange={setV} onSubmit={(x) => (out = x)} />;
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
