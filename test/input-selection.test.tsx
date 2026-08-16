import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { TextInput, caretIndexForClick, selectionRuns } from "../src/ui/text-input.tsx";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const frame = (c: { lastFrame: () => string | undefined }) => (c.lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");

/** Runs, rendered as the text they cover, with the selected one wrapped in brackets. */
function renderRuns(value: string, start: number, end: number, sel: { from: number; to: number } | null) {
  const cps = [...value];
  return selectionRuns(start, end, sel)
    .map((r) => (r.on ? "[" : "") + cps.slice(r.from, r.to).join("") + (r.on ? "]" : ""))
    .join("");
}

test("a selection splits a range into at most three runs", () => {
  const v = "hello world";
  expect(renderRuns(v, 0, 11, { from: 6, to: 11 })).toBe("hello [world]");
  expect(renderRuns(v, 0, 11, { from: 0, to: 5 })).toBe("[hello] world");
  expect(renderRuns(v, 0, 11, { from: 3, to: 8 })).toBe("hel[lo wo]rld");
  expect(renderRuns(v, 0, 11, { from: 0, to: 11 })).toBe("[hello world]");
  // Never more than three, whatever the range — the component relies on this to keep each visual line
  // a handful of flat strings rather than a per-codepoint fan-out.
  expect(selectionRuns(0, 11, { from: 3, to: 8 }).length).toBe(3);
});

test("an empty, inverted, or absent selection leaves the range whole", () => {
  const v = "hello world";
  for (const sel of [null, undefined, { from: 4, to: 4 }, { from: 9, to: 2 }]) {
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    expect(renderRuns(v, 0, 11, sel as any)).toBe("hello world");
    // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
    expect(selectionRuns(0, 11, sel as any).length).toBe(1);
  }
  // A selection entirely outside the range does not touch it either — this is what clips a highlight
  // to one visual line of a wrapped value.
  expect(renderRuns(v, 0, 5, { from: 6, to: 11 })).toBe("hello");
  expect(renderRuns(v, 6, 11, { from: 0, to: 5 })).toBe("world");
});

test("a selection spanning visual lines is clipped to each of them", () => {
  // "alpha bravo charlie" wrapped at 6 codepoints per line: the selection 3..15 covers the tail of the
  // first line, all of the second, and the head of the third.
  const v = "alpha bravo charlie";
  const sel = { from: 3, to: 15 };
  expect(renderRuns(v, 0, 6, sel)).toBe("alp[ha ]");
  expect(renderRuns(v, 6, 12, sel)).toBe("[bravo ]");
  expect(renderRuns(v, 12, 19, sel)).toBe("[cha]rlie");
});

test("an empty range yields nothing at all", () => {
  expect(selectionRuns(5, 5, { from: 0, to: 10 })).toEqual([]);
  expect(selectionRuns(5, 5, null)).toEqual([]);
});

test("the rendered value is unchanged by a highlight", async () => {
  // Ink strips styling when stdout is not a TTY, so the SGR itself is not observable here; what IS
  // observable is that splitting the runs does not drop, duplicate or reorder a character.
  const props = { onChange: () => {}, onSubmit: () => {}, width: 40, pastedContents: new Map<number, string>(), nextPasteId: { current: 1 } };
  const off = render(<TextInput value="hello world" {...props} />);
  await tick();
  const on = render(<TextInput value="hello world" selection={{ from: 6, to: 11 }} {...props} />);
  await tick();
  expect(frame(on)).toBe(frame(off));
  expect(frame(on)).toContain("hello world");
  off.unmount(); on.unmount();
});

test("a highlight over a masked value never exposes the secret", async () => {
  const c = render(
    <TextInput
      value="hunter2hunter2"
      onChange={() => {}}
      onSubmit={() => {}}
      mask
      width={40}
      selection={{ from: 0, to: 14 }}
      pastedContents={new Map()}
      nextPasteId={{ current: 1 }}
    />,
  );
  await tick();
  expect(frame(c)).not.toContain("hunter");
  expect(frame(c)).toContain("•••");
  c.unmount();
});

test("the geometry lookup is delta-based, which is what lets a drag anchor and extend", () => {
  const v = "hello world";
  const end = [...v].length;
  // The caret starts at the end of the value, and every delta is measured from wherever it is.
  expect(caretIndexForClick(v, end, 40, 0, -6)).toBe(5);
  expect(caretIndexForClick(v, end, 40, 0, -11)).toBe(0);
  expect(caretIndexForClick(v, 0, 40, 0, 5)).toBe(5);
  // Past either edge clamps instead of running off the value.
  expect(caretIndexForClick(v, 0, 40, 0, 99)).toBe(end);
  expect(caretIndexForClick(v, end, 40, 0, -99)).toBe(0);
});

test("looking up an index does not move the caret; clicking does, and says where", async () => {
  let indexAt: ((dRow: number, dCol: number, fromIndex?: number) => number) | null = null;
  let caretClick: ((dRow: number, dCol: number) => number) | null = null;
  const c = render(
    <TextInput
      value="hello world"
      onChange={() => {}}
      onSubmit={() => {}}
      width={40}
      registerIndexAt={(fn) => { indexAt = fn; }}
      registerCaretClick={(fn) => { caretClick = fn; }}
      pastedContents={new Map()}
      nextPasteId={{ current: 1 }}
    />,
  );
  await tick();
  expect(indexAt).toBeInstanceOf(Function);
  // Two identical lookups agree, because the first did not move the origin the second measures from.
  // A drag depends on this: it samples the pointer many times before the caret is allowed to move.
  expect(indexAt!(0, -6)).toBe(5);
  expect(indexAt!(0, -6)).toBe(5);
  // The press handler DOES move the caret, and returns the index so the drag can anchor there.
  expect(caretClick!(0, -6)).toBe(5);
  await tick();
  expect(indexAt!(0, 0)).toBe(5); // the caret is the new origin

  // A drag measures from where it STARTED, not from the caret, so it cannot be thrown off by a repaint
  // that has not landed yet. Origin 0 plus five columns is index 5, whatever the caret is doing.
  expect(indexAt!(0, 5, 0)).toBe(5);
  expect(indexAt!(0, 11, 0)).toBe(11);
  expect(indexAt!(0, -5, 11)).toBe(6);
  c.unmount();
});
