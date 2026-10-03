import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { SelectList } from "../src/ui/select-list.tsx";

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (value: string | undefined) => (value ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("wheel input moves a picker even though wheel is also a pointer report", async () => {
  const items = [
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
    { id: "three", label: "Three" },
    { id: "four", label: "Four" },
    { id: "five", label: "Five" },
  ];
  const picker = render(
    <SelectList
      title="Choose"
      items={items}
      cols={60}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );

  expect(strip(picker.lastFrame())).toMatch(/>\s+One/);
  picker.stdin.write("\x1b[<65;10;5M");
  await tick();
  expect(strip(picker.lastFrame())).toMatch(/>\s+Two/);

  picker.stdin.write("\x1b[<65;10;5M");
  picker.stdin.write("\x1b[<65;10;5M");
  picker.stdin.write("\x1b[<65;10;5M");
  await tick();
  expect(strip(picker.lastFrame())).toMatch(/>\s+Five/);

  picker.unmount();
});

test("an empty search explains recovery and Enter cannot select an absent item", async () => {
  let selected = 0, cancelled = 0;
  const c = render(<SelectList title="Model" items={[{id: "one", label: "GLM"}]} cols={80}
    onSelect={() => {selected++;}} onCancel={() => {cancelled++;}} />);
  try {
    await tick(); c.stdin.write("zzz"); await tick();
    expect(strip(c.lastFrame())).toContain("No matching items");
    c.stdin.write("\r"); await tick(); expect(selected).toBe(0);
    c.stdin.write("\x1b"); await tick(); expect(cancelled).toBe(1);
  } finally {c.unmount();}
});
