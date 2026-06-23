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
