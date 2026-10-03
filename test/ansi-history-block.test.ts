import { expect, test } from "bun:test";
import { clearAnsiCache, fallbackRows, getCachedRows, warmAnsiCache } from "../src/ui/ansi-cache.ts";
import { NekoConfig } from "../src/adapters/config.ts";
import stringWidth from "string-width";

test("unwarmed rows cannot wrap beyond the frame differ band into the composer", () => {
  for (const width of [20, 76, 114]) {
    for (const text of ["long notice ".repeat(100), "漢字👩‍💻é".repeat(100)]) {
      const rows = fallbackRows({id: 777, kind: "info", text}, width);
      expect(rows).toHaveLength(1);
      expect(stringWidth(rows[0])).toBeLessThanOrEqual(width);
    }
  }
});

test("restored tool output ignores preview summaries and preserves deep and wide content", async () => {
  clearAnsiCache();
  const line = {id: 998878, kind: "tool_result_full" as const, summary: "Read 600 lines",
    text: Array.from({length: 600}, (_, i) => `TOOL_${i}`).join("\n") + "\n" + "x".repeat(400) + "WIDE_END"};
  warmAnsiCache([line], 80, new NekoConfig({}, null, {}, ""), () => {});
  const deadline = Date.now() + 5000;
  while (!getCachedRows(line, 80) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const rows = getCachedRows(line, 80)!;
  expect(rows).not.toBeNull();
  const text = rows.slice(0, rows.length).join("\n");
  expect(text).toContain("TOOL_0");
  expect(text).toContain("TOOL_300");
  expect(text).toContain("TOOL_599");
  expect(text).toContain("WIDE_END");
  clearAnsiCache();
});

test("large resumed blocks keep their first and last lines with lazy row materialization", async () => {
  clearAnsiCache();
  const line={id:998877,kind:"assistant" as const,text:Array.from({length:3000},(_,i)=>`CODE_${i}`).join("\n")};
  const cfg=new NekoConfig({},null,{},"");
  warmAnsiCache([line],80,cfg,()=>{});
  const end=Date.now()+5000;
  while(!getCachedRows(line,80)&&Date.now()<end) await new Promise(r=>setTimeout(r,10));
  const rows=getCachedRows(line,80)!;
  expect(rows).not.toBeNull();
  expect(rows.length).toBe(3001);
  expect(rows.at(0)).toContain("CODE_0");
  expect(rows.at(2999)).toContain("CODE_2999");
  expect(rows.slice(1500,1530)).toHaveLength(30);
  clearAnsiCache();
});
