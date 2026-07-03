import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";

import { highlightLine } from "../src/ui/highlight.tsx";
import { TranscriptLine } from "../src/ui/transcript.tsx";

const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const cfg = {} as any;

/** The color a given token was highlighted as (a colored token is a <Text color=...>word</Text>);
 * plain tokens are raw strings, so an unhighlighted word returns undefined. */
function colorOf(nodes: ReturnType<typeof highlightLine>, word: string): string | undefined {
  for (const n of nodes) {
    const props = (n as ReactElement | null)?.props as { children?: unknown; color?: string } | undefined;
    if (props && props.children === word) return props.color;
  }
  return undefined;
}

test("highlightLine colors keyword/type/string/number/function per token", () => {
  const js = highlightLine("import { Link } from 'react-router-dom';");
  expect(colorOf(js, "import")).toBe("magenta"); // keyword
  expect(colorOf(js, "from")).toBe("magenta");
  expect(colorOf(js, "Link")).toBe("cyan"); // Capitalized identifier -> type/component
  expect(colorOf(js, "'react-router-dom'")).toBe("green"); // string

  const fn = highlightLine("const total = computeSum(items);");
  expect(colorOf(fn, "const")).toBe("magenta");
  expect(colorOf(fn, "computeSum")).toBe("blue"); // identifier before "(" -> function call
  expect(colorOf(fn, "items")).toBeUndefined(); // plain identifier -> not colored

  const ty = highlightLine("let n: Promise<number> = f;");
  expect(colorOf(ty, "Promise")).toBe("cyan"); // builtin generic type
  expect(colorOf(ty, "number")).toBe("cyan");

  const nums = highlightLine("x = 42");
  expect(colorOf(nums, "42")).toBe("yellow");
});

test("highlightLine treats a whole-line comment as a comment (gray), preserves indentation", () => {
  const c = highlightLine("  // a note");
  expect(colorOf(c, "// a note")).toBe("gray");
  // Leading indentation is preserved as a plain leading string on the first node.
  expect(String(highlightLine("    x = 1")[0]).startsWith("    ")).toBe(true);
});

test("Write diff shows LINE NUMBERS + code content + indentation (like Claude Code)", () => {
  // tool-runtime.ts write format: "NNNN + code" (right-aligned line number, then marker).
  const text = "Wrote Landing.tsx  (overwrote, +2)\n   1 + import { Link } from 'react-router-dom';\n   2 +   GraduationCap,";
  const { lastFrame } = render(<TranscriptLine line={{ id: 1, kind: "tool_result", text }} cfg={cfg} cols={100} />);
  const clean = strip(lastFrame());
  expect(clean).toContain("1 + import { Link } from 'react-router-dom';"); // line number 1 shown
  expect(clean).toContain("2 +   GraduationCap,"); // line number 2 + 3-space code indent survives
});

test("Edit diff keeps line numbers and the +/- markers", () => {
  const text = "Edited app.ts  (+1 -1)\n  20 - const x = oldValue;\n  20 + const x = newValue;";
  const { lastFrame } = render(<TranscriptLine line={{ id: 2, kind: "tool_result", text }} cfg={cfg} cols={100} />);
  const clean = strip(lastFrame());
  expect(clean).toContain("20 - const x = oldValue;");
  expect(clean).toContain("20 + const x = newValue;");
});
