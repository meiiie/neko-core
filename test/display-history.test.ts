import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayHistory } from "../src/adapters/display-history.ts";

test("320 turns remain pageable across checkpoints, restart and independent branches", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-"));
  const scope = {sessionId: "session", taskId: "alpha", root: home};
  let writer = new DisplayHistory(home, scope);
  for (let i = 0; i < 320; i++) {
    writer.append("user", `PROMPT_${i}`); writer.append("assistant", `ANSWER_${i}`);
    if (i % 40 === 39) writer = new DisplayHistory(home, scope, await writer.flush());
  }
  const ref = await writer.flush();
  const reader = new DisplayHistory(home, scope, ref);
  let page = await reader.page();
  let all = page.entries;
  while (page.older) { page = await reader.page(page.older); all = [...page.entries, ...all]; }
  expect(all).toHaveLength(640);
  for (let i = 0; i < 320; i++) { expect(all[2*i].text).toBe(`PROMPT_${i}`); expect(all[2*i+1].text).toBe(`ANSWER_${i}`); }
  const branch = new DisplayHistory(home, scope, ref);
  branch.append("assistant", "branch only"); await branch.flush();
  expect((await reader.page()).entries.at(-1)?.text).toBe("ANSWER_319");
  expect((await branch.page()).entries.at(-1)?.text).toBe("branch only");
});

test("task/root references and forged cursors cannot mix histories", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-scope-"));
  const writer = new DisplayHistory(home, {sessionId:"s", taskId:"a", root:home});
  writer.append("user", "private alpha"); const ref = await writer.flush();
  expect(() => new DisplayHistory(home, {sessionId:"s", taskId:"b", root:home}, ref)).toThrow();
  expect(() => new DisplayHistory(home, {sessionId:"s", taskId:"a", root:join(home,"other")}, ref)).toThrow();
  const beta = new DisplayHistory(home, {sessionId:"s", taskId:"b", root:home});
  await expect(beta.page({chunk:ref.head!})).rejects.toThrow();
  await expect(writer.page({chunk:"../outside"})).rejects.toThrow();
});

test("large records are not truncated and byte-limited pages advance exactly once", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-large-"));
  const writer = new DisplayHistory(home, {sessionId:"s", root:home});
  writer.append("assistant", "first"); writer.append("tool_result", "X".repeat(300_000)); writer.append("assistant", "last");
  await writer.flush();
  let page = await writer.page(); const all = [...page.entries];
  while (page.older) { page = await writer.page(page.older); all.unshift(...page.entries); }
  expect(all.map(x => x.text.length)).toEqual([5,300_000,4]);
});

test("corrupted bytes fail closed without changing the durable reference", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-display-integrity-"));
  const writer = new DisplayHistory(home, {sessionId:"s", root:home});
  writer.append("user","original"); const ref=await writer.flush();
  const path=join(home,'.neko-core','display-history',`${ref.head}.json`);
  writeFileSync(path,readFileSync(path,'utf8').replace('original','modified'));
  await expect(writer.page()).rejects.toThrow('integrity');
  expect(writer.reference()).toEqual(ref);
});
