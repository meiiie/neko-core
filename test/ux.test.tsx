/** UX/UI coverage: status bar, thinking line, reasoning, hotkeys, diff preview, completion line. */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { CompactingLine, fmtElapsed, RunningLine, ThinkingLine } from "../src/ui/thinking-line.tsx";
import { ApprovalBox } from "../src/ui/approval-box.tsx";
import { TranscriptLine, type Line } from "../src/ui/transcript.tsx";
import { TranscriptViewer } from "../src/ui/transcript-viewer.tsx";
import { RichView } from "../src/ui/rich-transcript.tsx";
import { NekoConfig } from "../src/adapters/config.ts";

const CFG = new NekoConfig({}, null, {}, "");

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
/** Poll the render until any frame matches — robust against streaming throttle / event-loop timing. */
async function until(c: { frames: string[] }, pred: (allFrames: string) => boolean, ms = 1500): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (pred(strip(c.frames.join("\n")))) return true;
    await tick(25);
  }
  return pred(strip(c.frames.join("\n")));
}

class Echo implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.("hello");
    return { content: "hello", tool_calls: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } };
  }
}

class Reasoner implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.("let me think hard", "reasoning");
    await tick(60);
    onDelta?.("the answer");
    return { content: "the answer", tool_calls: [] };
  }
}

// Streams a markdown reply token-by-token, then HANGS before returning - so the reply stays LIVE
// (uncommitted): anything the frame shows can only have come from the streaming band, not a commit.
// `cancel` breaks the hang so the test tears down cleanly (no dangling timer to pressure other tests).
const MD_REPLY = "Đây là **tổng hợp** hôm nay:\n\n## Nga - Ukraine\n\n- Cuộc gọi **Trump - Putin**\n\nBạn muốn đi sâu?";
class MdHang implements Provider {
  cancelled = false;
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    for (const tok of MD_REPLY.match(/\S+\s*|\n/g) ?? []) { if (this.cancelled) break; onDelta?.(tok); await tick(6); }
    for (let i = 0; i < 200 && !this.cancelled; i++) await tick(15); // hang until the test cancels it
    return { content: MD_REPLY, tool_calls: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
  }
}

test("status bar shows mode + context %", () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  const f = strip(c.lastFrame());
  expect(f).toContain("auto");
  expect(f).toContain("ctx");
  expect(f).toContain("shift+tab");
  c.unmount();
});

test("ThinkingLine shows effort + per-turn tokens split input/output", () => {
  const f = strip(render(<ThinkingLine verb="Thinking" elapsed={11} liveIn={() => 1200} liveOut={() => 340} step={1} queued={0} effort="xhigh" />).lastFrame());
  expect(f).toContain("xhigh effort");
  expect(f).toContain("↑1.2k");   // input (context sent)
  expect(f).toContain("↓340");    // output (generated)
  expect(f).toContain("esc to interrupt");
});

test("CompactingLine shows the progress bar, percent, and a tip", () => {
  const f = strip(render(<CompactingLine start={1_000_000} />).lastFrame());
  expect(f).toContain("Compacting conversation");
  expect(f).toContain("0%");            // frame 0: elapsed 0 -> 0%
  expect(f).toContain("▱");             // empty bar segments visible
  expect(f).toContain("tip:");
});

test("resume-from-summary: a large session prompts to summarize, a small one resumes directly", async () => {
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-resume-home-")); // isolate prefs.json (loadPrefs reads HOME)
  process.env.USERPROFILE = home; process.env.HOME = home;
  try {
    // >60% of the default 131072-token window: estimateTokens = chars/4, so ~340k chars ~= 85k tokens.
    const big: any = { id: "big", createdAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [{ role: "user", content: "x".repeat(340_000) }] };
    const c = render(<ChatApp yolo provider={new Echo()} resumedSession={big} />);
    expect(await until(c, (f) => /Resume from a summary/i.test(f))).toBe(true);
    c.unmount();

    const small: any = { id: "small", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [{ role: "user", content: "hi there small session" }] };
    const c2 = render(<ChatApp yolo provider={new Echo()} resumedSession={small} />);
    await tick(150);
    const f2 = strip(c2.frames.join("\n"));
    expect(/Resume from a summary/i.test(f2)).toBe(false); // no prompt for a small session
    expect(f2).toContain("hi there small session");        // replayed directly
    c2.unmount();
  } finally {
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("TranscriptViewer opens at the bottom, then type-to-search filters", async () => {
  const lines: Line[] = [];
  for (let i = 0; i < 40; i++) lines.push({ id: i, kind: i % 2 ? "assistant" : "user", text: `message number ${i}` });
  lines.push({ id: 999, kind: "user", text: "NEEDLE unique marker" });
  const c = render(<TranscriptViewer lines={lines} cols={80} rows={20} onClose={() => {}} />);
  const f = strip(c.lastFrame());
  expect(f).toContain("Conversation");
  expect(f).toContain("41 entries");
  expect(f).toContain("NEEDLE");        // opens at the bottom -> the last entry is visible
  c.stdin.write("NEEDLE");              // type-to-search
  expect(await until(c, (fr) => /found 1/.test(fr))).toBe(true);
  c.unmount();
});

test("/transcript opens the full-thread viewer over the resumed session", async () => {
  const s: any = { id: "t", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [
    { role: "user", content: "first earlier question" },
    { role: "assistant", content: "an earlier answer" },
  ] };
  const c = render(<ChatApp yolo provider={new Echo()} resumedSession={s} />);
  await tick(60);
  c.stdin.write("/transcript");
  c.stdin.write("\r");
  expect(await until(c, (f) => /Conversation/.test(f) && /first earlier question/.test(f))).toBe(true);
  c.unmount();
});

test("fullscreen mode renders a scrollable transcript region (alt-screen), inline stays default", async () => {
  const prev = process.env.NEKO_FULLSCREEN;
  process.env.NEKO_FULLSCREEN = "1";
  try {
    const msgs: any[] = [];
    for (let i = 0; i < 40; i++) { msgs.push({ role: "user", content: `question ${i}` }); msgs.push({ role: "assistant", content: `answer ${i}` }); }
    const s: any = { id: "fs", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const c = render(<ChatApp yolo provider={new Echo()} resumedSession={s} />);
    await tick(150);
    const f = strip(c.frames.join("\n"));
    expect(f).toContain("\x1b[?1049h"); // entered the alternate screen
    expect(f).toContain("answer 39");   // rich transcript, sticky-bottom -> newest content visible
    c.unmount();
  } finally {
    if (prev === undefined) delete process.env.NEKO_FULLSCREEN; else process.env.NEKO_FULLSCREEN = prev;
  }
});

test("RichView pastes exactly the visible window of cached rows (tail and scrolled)", () => {
  const rows = Array.from({ length: 200 }, (_, i) => `row ${i}`);
  // Pinned tail (dist=0): last rows visible.
  const r = render(<RichView rows={rows} dist={0} viewH={5} width={40} />);
  const f = r.lastFrame() ?? "";
  expect(f).toContain("row 199");
  expect(f).not.toContain("row 194"); // only viewH rows mounted - O(viewport), the lag-bug guard
  r.unmount();
  // Scrolled 100 rows up: window ends 100 rows above the tail.
  const r2 = render(<RichView rows={rows} dist={100} viewH={5} width={40} />);
  const f2 = r2.lastFrame() ?? "";
  expect(f2).toContain("row 99");
  expect(f2).not.toContain("row 100"); // nothing below the window
  expect(f2).not.toContain("row 199"); // the tail is not even mounted
  r2.unmount();
});

test("ansi-cache: warm is WINDOWED - a marathon session does not warm its distant history", async () => {
  const { warmAnsiCache, getCachedRows, clearAnsiCache, WARM_WINDOW } = await import("../src/ui/ansi-cache.ts");
  clearAnsiCache();
  const many: Line[] = Array.from({ length: WARM_WINDOW + 200 }, (_, i) => ({ id: 50000 + i, kind: "info", text: `l${i}` }));
  await new Promise<void>((resolve) => {
    const t0 = Date.now();
    warmAnsiCache(many, 60, CFG, () => {
      const done = many.slice(-WARM_WINDOW).every((l) => getCachedRows(l, 60));
      if (done || Date.now() - t0 > 20000) resolve();
    });
  });
  expect(getCachedRows(many[many.length - 1], 60)).not.toBe(null); // tail warmed
  expect(getCachedRows(many[0], 60)).toBe(null);                    // distant history NOT warmed (stays fallback)
  // ...until the user scrolls near it: warm again with a center on the old region.
  await new Promise<void>((resolve) => {
    const t0 = Date.now();
    warmAnsiCache(many, 60, CFG, () => {
      if (getCachedRows(many[0], 60) || Date.now() - t0 > 20000) resolve();
    }, 0);
  });
  expect(getCachedRows(many[0], 60)).not.toBe(null);
  clearAnsiCache();
}, 45000);

test("ansi-cache: renderLineRows renders a line rich once; fallback is instant plain", async () => {
  const { renderLineRows, fallbackRows, clearAnsiCache } = await import("../src/ui/ansi-cache.ts");
  const line: Line = { id: 90001, kind: "assistant", text: "# Tiêu đề\n\n**đậm** và `code`" };
  const rows = renderLineRows(line, 60, CFG);
  expect(rows.length).toBeGreaterThan(1);              // markdown produced structured rows (heading + body)
  expect(rows.join("\n")).toContain("Tiêu đề");        // content survived the off-screen render
  // (ANSI styling is chalk-gated on TTY detection: present in a real terminal, absent under bun test -
  // asserting codes here would test the environment, not the cache.)
  const fb = fallbackRows({ id: 90002, kind: "user", text: "xin chào" });
  expect(fb[0]).toBe("> xin chào");                      // plain, glyph-prefixed, instant
  clearAnsiCache();
});

test("fullscreen history: PgUp shows the jump pill; a new turn counts; End returns to the tail", async () => {
  const prev = process.env.NEKO_FULLSCREEN;
  process.env.NEKO_FULLSCREEN = "1";
  try {
    const msgs: any[] = [];
    for (let i = 0; i < 30; i++) { msgs.push({ role: "user", content: `q ${i}` }); msgs.push({ role: "assistant", content: `a ${i}` }); }
    const s: any = { id: "pill", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const c = render(<ChatApp yolo provider={new Echo()} resumedSession={s} />);
    await tick(120);
    c.stdin.write("\x1b[5~"); // PgUp -> scroll up (line-anchored; flush is coalesced ~33ms)
    expect(await until(c, (f) => /Jump to bottom \(ctrl\+End\)/.test(f))).toBe(true);
    c.stdin.write("hi there"); // type, then submit separately (one chunk with \r would read as a paste)
    await tick(60);
    c.stdin.write("\r"); // run a turn while scrolled up -> Echo replies
    expect(await until(c, (f) => /new message/.test(f))).toBe(true); // pill counts the new activity
    c.stdin.write("\x1b[F"); // End -> back to the live tail
    expect(await until(c, (f) => {
      const frames = f.split("\n");
      return frames.some((x) => x.includes("hello")) && !/Jump to bottom/.test(frames.slice(-30).join("\n"));
    })).toBe(true);
    c.unmount();
  } finally {
    if (prev === undefined) delete process.env.NEKO_FULLSCREEN; else process.env.NEKO_FULLSCREEN = prev;
  }
});

test("input footer: the prompt is BOXED by a rule above AND below, status beneath", () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  const lines = strip(c.lastFrame()).split("\n");
  const promptIdx = lines.findIndex((l) => l.includes("Try:"));
  const statusIdx = lines.findIndex((l) => l.includes("shift+tab to cycle"));
  expect(promptIdx).toBeGreaterThanOrEqual(1);
  expect(lines[promptIdx - 1]).toMatch(/─{5,}/);   // rule ABOVE the prompt
  expect(lines[promptIdx + 1]).toMatch(/─{5,}/);   // rule BELOW the prompt - the input stays boxed (both bars)
  expect(statusIdx).toBe(promptIdx + 2);           // status sits just under the lower rule
  c.unmount();
});

test("tab title is the session NAME (first message), stable - not each per-turn prompt", async () => {
  const captured: string[] = [];
  const origWrite = process.stdout.write, origTTY = (process.stdout as any).isTTY;
  (process.stdout as any).isTTY = true;
  (process.stdout as any).write = ((s: any) => { captured.push(String(s)); return true; }) as any;
  const titleOf = () => { const m = [...captured.join("").matchAll(/\x1b\]2;([^\x07]*)\x07/g)].pop(); return m ? m[1] : ""; };
  const pollTitle = async (pred: (t: string) => boolean, ms = 1500) => { for (let w = 0; w < ms; w += 25) { if (pred(titleOf())) return true; await tick(25); } return pred(titleOf()); };
  try {
    const c = render(<ChatApp yolo provider={new Echo()} />);
    await tick(60);
    c.stdin.write("first message here"); await tick(20); c.stdin.write("\r");   // first turn NAMES the session
    expect(await pollTitle((t) => t.includes("first message here"))).toBe(true);
    captured.length = 0;
    c.stdin.write("second different prompt"); await tick(20); c.stdin.write("\r"); // a later turn must NOT rename it
    await tick(250);
    expect(titleOf()).toContain("first message here");        // still the session name...
    expect(titleOf()).not.toContain("second different prompt"); // ...not the new prompt
    c.unmount();
  } finally {
    (process.stdout as any).write = origWrite; (process.stdout as any).isTTY = origTTY;
  }
});

test("fullscreen find: Ctrl+F opens the find bar and typing shows a match badge", async () => {
  const prev = process.env.NEKO_FULLSCREEN;
  process.env.NEKO_FULLSCREEN = "1";
  try {
    const msgs: any[] = [];
    for (let i = 0; i < 20; i++) { msgs.push({ role: "user", content: `question ${i}` }); msgs.push({ role: "assistant", content: `answer NEEDLE ${i}` }); }
    const s: any = { id: "fsf", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const c = render(<ChatApp yolo provider={new Echo()} resumedSession={s} />);
    await tick(120);
    c.stdin.write("\x06"); // Ctrl+F -> open find
    await tick(60);
    c.stdin.write("NEEDLE");
    await tick(100);
    const f = strip(c.frames.join("\n"));
    expect(f).toContain("find:");
    expect(f).toMatch(/\d+\/\d+/); // match badge like "1/20"
    c.unmount();
  } finally {
    if (prev === undefined) delete process.env.NEKO_FULLSCREEN; else process.env.NEKO_FULLSCREEN = prev;
  }
});

test("resize triggers a debounced full wipe + Static re-emit (ghost-frame regression guard)", async () => {
  const s: any = { id: "rz", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [
    { role: "user", content: "resize-marker question" },
    { role: "assistant", content: "resize-marker answer" },
  ] };
  const c = render(<ChatApp yolo provider={new Echo()} resumedSession={s} />);
  await tick(80);
  const before = c.frames.length;
  (c.stdout as any).emit("resize"); // terminal resized (e.g. maximized)
  // Poll (not a fixed sleep): the 150ms debounce + remount render can land late under suite load.
  expect(await until(c, () => {
    const after = c.frames.slice(before).join("\n");
    return after.includes("\x1b[2J") && after.includes("resize-marker question");
  }, 3000)).toBe(true); // wipe went out AND Static remounted -> transcript re-emitted fresh
  c.unmount();
});

test("ApprovalBox renders an edit diff preview (- old / + new)", () => {
  const f = strip(render(<ApprovalBox approval={{ toolName: "edit", args: { path: "a.ts", old_string: "let x = 1", new_string: "let x = 2" }, resolve: () => {} }} />).lastFrame());
  expect(f).toContain("- let x = 1");
  expect(f).toContain("+ let x = 2");
});

test("reasoning shows live while busy, clears when done", async () => {
  const c = render(<ChatApp yolo provider={new Reasoner()} />);
  await tick();
  c.stdin.write("go");
  await tick(20);
  c.stdin.write("\r");
  expect(await until(c, (f) => f.includes("let me think hard"))).toBe(true); // shown mid-turn
  expect(await until(c, (f) => f.includes("the answer"))).toBe(true); // final answer lands
  expect(strip(c.lastFrame())).not.toContain("let me think hard"); // thinking cleared when done
  c.unmount();
});

test("post-turn run-time line + placeholder drops after first turn", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  expect(strip(c.lastFrame())).toContain("Try:"); // placeholder before the first turn
  c.stdin.write("hi");
  await tick(20);
  c.stdin.write("\r");
  expect(await until(c, (f) => /for \d+s/.test(f))).toBe(true); // completion line appears
  expect(strip(c.lastFrame())).not.toContain("Try:"); // placeholder gone
  c.unmount();
});

test("Shift+Tab cycles the permission mode (auto -> default)", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  expect(strip(c.lastFrame())).toContain("auto");
  c.stdin.write("\x1b[Z"); // Shift+Tab
  await tick(50);
  expect(strip(c.lastFrame())).toContain("default");
  c.unmount();
});

test("slash menu autocompletes as you type", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/mod");
  await tick(50);
  expect(strip(c.lastFrame())).toContain("/model");
  c.unmount();
});

test("/help lists the command set", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/help");
  await tick(20);
  c.stdin.write("\r");
  await tick(60);
  expect(strip(c.frames.join("\n"))).toContain("Commands:");
  c.unmount();
});

test("error lines render with a visible marker (not a dim info line)", () => {
  const f = strip(render(<TranscriptLine line={{ id: 1, kind: "error", text: "HTTP 500" }} cfg={CFG} />).lastFrame());
  expect(f).toContain("✗ HTTP 500");
});

test("expanded tool result keeps the diff +/- lines", () => {
  const diff = "Edited f.ts  (+1 -1)\n-    3  old();\n+    3  new();";
  const f = strip(render(<TranscriptLine line={{ id: 1, kind: "tool_result_full", text: diff }} cfg={CFG} />).lastFrame());
  expect(f).toContain("- ");
  expect(f).toContain("old();");
  expect(f).toContain("new();");
});

test("fmtElapsed: raw seconds under a minute, then Xm YYs (zero-padded) past it", () => {
  expect(fmtElapsed(5)).toBe("5s");
  expect(fmtElapsed(59)).toBe("59s");
  expect(fmtElapsed(60)).toBe("1m 00s");
  expect(fmtElapsed(65)).toBe("1m 05s");
  expect(fmtElapsed(194)).toBe("3m 14s");
});

test("RunningLine shows a dot + the tool label while a call is in flight", () => {
  const f = strip(render(<RunningLine text="Running ls" />).lastFrame());
  expect(f).toContain("Running ls");
  expect(f).toContain("●"); // the (blinking) running dot
});

test("a user prompt and a tool call each get a blank line above (turn separation)", () => {
  const u = strip(render(<TranscriptLine line={{ id: 1, kind: "user", text: "hi there" }} cfg={CFG} />).lastFrame()).split("\n");
  expect(u[0].trim()).toBe(""); // marginTop blank row so the prompt isn't glued to the previous turn
  expect(u.some((l) => l.includes("> hi there"))).toBe(true);
  const t = strip(render(<TranscriptLine line={{ id: 2, kind: "tool_call", text: "Bash(ls)" }} cfg={CFG} />).lastFrame()).split("\n");
  expect(t[0].trim()).toBe(""); // tool calls separate from the prompt / previous group
  expect(t.some((l) => l.includes("Bash(ls)"))).toBe(true);
});

test("write_file approval previews size + a '+N more lines' hint", () => {
  const content = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
  const f = strip(render(<ApprovalBox approval={{ toolName: "write_file", args: { path: "x.html", content }, resolve: () => {} }} />).lastFrame());
  expect(f).toContain("20 lines");
  expect(f).toContain("+12 more lines");
});

test("typing '/' caps the command list with a '+N more' hint", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/");
  await tick(50);
  expect(strip(c.lastFrame())).toMatch(/\+\d+ more/);
  c.unmount();
});

test("Ctrl+C clears a non-empty input (does not exit)", async () => {
  const c = render(<ChatApp yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("some draft text");
  await tick(20);
  c.stdin.write("\x03"); // Ctrl+C
  await tick(40);
  expect(strip(c.lastFrame())).not.toContain("some draft text");
  c.unmount();
});

test("renderNodeRows renders live Markdown to ANSI rows (no raw ** markers) - the fullscreen stream path", async () => {
  const { renderNodeRows } = await import("../src/ui/ansi-cache.ts");
  const { Markdown } = await import("../src/ui/markdown.tsx");
  const rows = renderNodeRows(<Markdown text={"# Tiêu đề\n\n**đậm** và thường"} width={40} compact />, 40);
  const flat = rows.join("\n");
  expect(flat).toContain("Tiêu đề");     // heading text rendered
  expect(flat).toContain("đậm");          // bold text rendered...
  expect(flat).not.toContain("**");       // ...WITHOUT the raw ** markers (the streaming bug)
  expect(flat).not.toContain("# ");       // heading marker consumed too
});

test("fullscreen streaming renders Markdown LIVE in the band (hidden-instance flush regression)", async () => {
  // The live stream renders markdown through the SHARED hidden Ink instance (renderNodeRows). Calling
  // that from inside the main app's React commit/effect phase makes Ink defer the hidden root's commit,
  // so its "synchronous" frame comes back EMPTY - the band stayed blank until the reply committed (the
  // "stream shows nothing / raw ** until done" bug). The fix renders it on a macrotask, off the flush.
  const prev = process.env.NEKO_FULLSCREEN;
  process.env.NEKO_FULLSCREEN = "1";
  const provider = new MdHang();
  try {
    const c = render(<ChatApp yolo provider={provider} />);
    await tick(60);
    c.stdin.write("go");
    await tick(20);
    c.stdin.write("\r");
    // Wait for the WHOLE reply to reach the live band (last line present) - provider is still hanging,
    // nothing committed. Assert against lastFrame (current screen), so mid-stream partial markers don't leak.
    for (let i = 0; i < 120 && !/Bạn muốn đi sâu/.test(strip(c.lastFrame())); i++) await tick(25);
    const f = strip(c.lastFrame());
    expect(f).toContain("Nga - Ukraine"); // ## header rendered live (not blank, not committed)
    expect(f).toContain("tổng hợp");       // earlier **bold** rendered live
    expect(f).not.toContain("## ");        // header marker consumed - it is FORMATTED, not raw
    expect(f).not.toContain("**");         // all bold markers closed and rendered
    c.unmount();
  } finally {
    provider.cancelled = true; // stop the hang so no timer outlives the test
    if (prev === undefined) delete process.env.NEKO_FULLSCREEN; else process.env.NEKO_FULLSCREEN = prev;
  }
}, 15000); // generous wall-clock: streaming + per-delta hidden-instance renders can run slow under suite load
