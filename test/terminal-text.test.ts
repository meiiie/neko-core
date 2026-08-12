import { describe, expect, test } from "bun:test";

import { hasTerminalControl, terminalSafeText, writeTerminalSafe } from "../src/shared/terminal-text.ts";

describe("terminal-safe text", () => {
  test("escapes terminal controls while preserving ordinary Unicode and optional newlines", () => {
    const input = `xin chao\n\u001b]52;c;stolen\u0007\rnext\u009b31m`;
    const output = terminalSafeText(input, { preserveLineBreaks: true });

    expect(output).toBe("xin chao\n\\u001b]52;c;stolen\\u0007\\u000dnext\\u009b31m");
    expect(hasTerminalControl(output.replace(/\n/g, ""))).toBe(false);
  });

  test("split OSC and CSI fragments cannot reconstruct a control sequence", () => {
    let output = "";
    const stream = { write(chunk: string) { output += chunk; return true; } };

    for (const chunk of ["safe\u001b", "]52;c;payload", "\u0007then\u001b[", "31mred"]) {
      writeTerminalSafe(stream as any, chunk);
    }

    expect(output).toBe("safe\\u001b]52;c;payload\\u0007then\\u001b[31mred");
    expect(hasTerminalControl(output)).toBe(false);
  });

  test("the returned bound includes its truncation marker", () => {
    const output = terminalSafeText("a".repeat(100), { maxChars: 24 });
    expect(output.length).toBeLessThanOrEqual(24);
    expect(output).toEndWith("... [truncated]");
  });

  test("ASCII mode escapes non-ASCII code points for legacy Windows consoles", () => {
    expect(terminalSafeText("Neko mô hình 模型", { ascii: true }))
      .toBe("Neko m\\u00f4 h\\u00ecnh \\u6a21\\u578b");
  });
});
