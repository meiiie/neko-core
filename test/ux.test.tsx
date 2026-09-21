/** UX/UI coverage: status bar, thinking line, reasoning, hotkeys, diff preview, completion line. */
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { cloneElement } from "react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { ChatApp } from "../src/ui/chat.tsx";
import { CompactingLine, fmtElapsed, RunningLine, ThinkingLine } from "../src/ui/thinking-line.tsx";
import { ApprovalBox } from "../src/ui/approval-box.tsx";
import { toolCallBulletColor, toolResultDisplayLines, TranscriptLine, type Line } from "../src/ui/transcript.tsx";
import { TranscriptViewer } from "../src/ui/transcript-viewer.tsx";
import { RichView } from "../src/ui/rich-transcript.tsx";
import { NekoConfig } from "../src/adapters/config.ts";
import { createTitleDriver } from "../src/ui/title.ts";

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

/** Render with fullscreen ON via the EXPLICIT ChatApp prop - never by mutating NEKO_FULLSCREEN, which is
 * racy under bun's CI test scheduling (shared process.env across file interleavings made inline tests in
 * OTHER files randomly mount fullscreen on GitHub runners). */
function renderFullscreen(node: any) {
  return render(cloneElement(node, { fullscreen: true }));
}

class Echo implements Provider {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.("hello");
    return { content: "hello", tool_calls: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 800 } };
  }
}

class Reasoner implements Provider {
  private releaseReasoning: (() => void) | null = null;
  release(): void { this.releaseReasoning?.(); }
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.("let me think hard", "reasoning");
    await new Promise<void>((resolve) => { this.releaseReasoning = resolve; });
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
  streamedAll = false;
  completed = false;
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    for (const tok of MD_REPLY.match(/\S+\s*|\n/g) ?? []) { if (this.cancelled) break; onDelta?.(tok); await tick(6); }
    this.streamedAll = true;
    while (!this.cancelled) await tick(15); // remain live until the test explicitly cancels it
    this.completed = true;
    return { content: MD_REPLY, tool_calls: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
  }
}

class ManagedUsageGap implements Provider {
  cancelled = false;
  async complete(_m: any[], _t: any[], onDelta?: (t: string, k?: "content" | "reasoning" | "tool") => void, _signal?: AbortSignal, opts?: any): Promise<ProviderResponse> {
    onDelta?.("x".repeat(400));
    opts?.onUsage?.({ prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 });
    await opts?.executeTool?.({ id: "usage-gap", name: "ls", arguments: { path: "." } });
    onDelta?.("y".repeat(80)); // 20 estimated tokens after the last authoritative snapshot
    while (!this.cancelled) await tick(15);
    return { content: "done", tool_calls: [], usage: { prompt_tokens: 1_000, completion_tokens: 120, total_tokens: 1_120 } };
  }
}

class MultiStepEstimateGap implements Provider {
  call = 0;
  secondStarted = false;
  cancelled = false;
  async complete(): Promise<ProviderResponse> {
    if (this.call++ === 0) {
      await tick(180);
      return {
        content: null,
        tool_calls: [{ id: "estimate-gap", name: "ls", arguments: { path: "." } }],
        usage: { prompt_tokens: 5_000, completion_tokens: 10, total_tokens: 5_010 },
      };
    }
    this.secondStarted = true;
    while (!this.cancelled) await tick(15);
    return { content: "done", tool_calls: [], usage: { prompt_tokens: 5_100, completion_tokens: 5, total_tokens: 5_105 } };
  }
}

class StreamingAnchorHang implements Provider {
  cancelled = false;
  async complete(_m: any[], _t: any[], onDelta?: (t: string, k?: "content" | "reasoning") => void): Promise<ProviderResponse> {
    onDelta?.(Array.from({ length: 20 }, (_, i) => `LIVE TAIL ROW ${i}`).join("\n"));
    while (!this.cancelled) await tick(15);
    return { content: "done", tool_calls: [], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
  }
}

test("status bar shows mode + context %", () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  const f = strip(c.lastFrame());
  expect(f).toContain("auto");
  expect(f).toContain("ctx");
  expect(f).toContain("shift+tab");
  c.unmount();
});

test("first-run status bar names the missing model instead of showing a dangling separator", () => {
  const saved = { userProfile: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-first-run-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
    const status = strip(c.lastFrame()).split("\n").find((line) => line.includes("shift+tab")) ?? "";
    expect(status).toContain("no model");
    c.unmount();
  } finally {
    if (saved.userProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.userProfile;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ThinkingLine shows effort + per-turn tokens split input/output", () => {
  const f = strip(render(<ThinkingLine verb="Thinking" elapsed={11} liveIn={() => 1200} liveOut={() => 340} step={1} queued={0} effort="xhigh" />).lastFrame());
  expect(f).toContain("xhigh effort");
  expect(f).toContain("turn total");
  expect(f).toContain("↑1.2k");   // input (context sent)
  expect(f).toContain("↓340");    // output (generated)
  expect(f).toContain("esc to interrupt");
});

test("ThinkingLine labels estimates with ~ and authoritative usage without it", () => {
  const f = strip(render(
    <ThinkingLine
      verb="Thinking"
      elapsed={2}
      liveIn={() => ({ value: 34_300, approximate: true })}
      liveOut={() => ({ value: 6100, approximate: false })}
      step={1}
      queued={0}
    />,
  ).lastFrame());
  expect(f).toContain("↑~34.3k");
  expect(f).toContain("↓6.1k");
  expect(f).not.toContain("↓~6.1k");
});

test("live token output adds post-snapshot text inside one provider-managed tool turn", async () => {
  const provider = new ManagedUsageGap();
  const c = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  try {
    c.stdin.write("exercise managed usage");
    await tick(60);
    c.stdin.write("\r");
    expect(await until(c, (frames) => frames.includes("↓~120"), 3000)).toBe(true);
  } finally {
    provider.cancelled = true;
    c.unmount();
    await tick(40);
  }
}, 10_000);

test("multi-step input estimate adds the pending context to already-booked usage", async () => {
  const provider = new MultiStepEstimateGap();
  const c = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  const values = () => [...strip(c.frames.join("\n")).matchAll(/↑~([\d.]+)(k?)/g)]
    .map((match) => Number(match[1]) * (match[2] ? 1_000 : 1));
  try {
    c.stdin.write("exercise multi-step estimate");
    await tick(60);
    c.stdin.write("\r");
    expect(await until(c, () => values().length > 0, 1000)).toBe(true);
    expect(await until(c, () => provider.secondStarted, 4000)).toBe(true);
    expect(await until(c, () => Math.max(...values()) > 6_000, 2000)).toBe(true);
  } finally {
    provider.cancelled = true;
    c.unmount();
    await tick(40);
  }
}, 10_000);

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
    const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={big} />);
    expect(await until(c, (f) => /Resume from a summary/i.test(f))).toBe(true);
    c.unmount();

    const small: any = { id: "small", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [{ role: "user", content: "hi there small session" }] };
    const c2 = render(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={small} />);
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

test("TranscriptViewer classifies SGR pointer reports before search text", async () => {
  const lines: Line[] = [];
  lines.push({ id: 0, kind: "user", text: "NEEDLE unique marker" });
  for (let i = 1; i < 80; i++) lines.push({ id: i, kind: i % 2 ? "assistant" : "user", text: `message number ${i}` });
  const c = render(<TranscriptViewer lines={lines} cols={80} rows={20} onClose={() => {}} />);

  c.stdin.write("\x1b[<64;40;10M");             // wheel up; Ink strips ESC before useInput
  c.stdin.write("[<35;41;10M");                 // motion already stripped by Ink
  c.stdin.write("[<66;41;10M[<67;41;10M");     // horizontal wheel is consumed without vertical remapping
  c.stdin.write("[<0;41;10M[<0;41;10m");       // press + release burst
  c.stdin.write("[<64;41;10M[<65;41;10M");     // cancelling wheel burst is still pointer input

  await tick(100);
  const afterPointer = strip(c.lastFrame());
  expect(afterPointer).toContain("80 entries");
  expect(afterPointer).not.toContain(" · end");
  expect(afterPointer).not.toContain("[<");
  expect(afterPointer).not.toContain("found 0");

  c.stdin.write("NEEDLE");
  expect(await until(c, (fr) => /found 1/.test(fr) && /NEEDLE unique marker/.test(fr))).toBe(true);
  c.unmount();
});

test("/transcript opens the full-thread viewer over the resumed session", async () => {
  const s: any = { id: "t", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [
    { role: "user", content: "first earlier question" },
    { role: "assistant", content: "an earlier answer" },
  ] };
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={s} />);
  await tick(60);
  c.stdin.write("/transcript");
  c.stdin.write("\r");
  expect(await until(c, (f) => /Conversation/.test(f) && /first earlier question/.test(f))).toBe(true);
  c.unmount();
});

test("fullscreen mode renders a scrollable transcript region (alt-screen), inline stays default", async () => {
  {
    const msgs: any[] = [];
    for (let i = 0; i < 40; i++) { msgs.push({ role: "user", content: `question ${i}` }); msgs.push({ role: "assistant", content: `answer ${i}` }); }
    const s: any = { id: "fs", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={s} />);
    await tick(150);
    const f = strip(c.frames.join("\n"));
    expect(f).toContain("\x1b[?1049h"); // entered the alternate screen
    expect(f).toContain("answer 39");   // rich transcript, sticky-bottom -> newest content visible
    c.unmount();
  }
});

test("fullscreen resume never paints reasoning fields or tool-attached progress", async () => {
  const resumed: any = {
    id: "private-resume", createdAt: "", updatedAt: "", cwd: process.cwd(), model: "m",
    messages: [
      {
        role: "assistant",
        content: "PRIVATE PROGRESS TEXT",
        reasoning: "PRIVATE RAW REASONING",
        provider_data: [{ type: "reasoning", summary: [{ text: "PRIVATE REASONING SUMMARY" }] }],
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo ok" }) } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "PUBLIC FINAL ANSWER" },
    ],
  };
  const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={resumed} sessionId={resumed.id} />);
  await tick(250);
  const frames = strip(c.frames.join("\n"));
  expect(frames).toContain("PUBLIC FINAL ANSWER");
  expect(frames).toContain("intermediate progress update hidden on resume");
  expect(frames).not.toContain("PRIVATE PROGRESS TEXT");
  expect(frames).not.toContain("PRIVATE RAW REASONING");
  expect(frames).not.toContain("PRIVATE REASONING SUMMARY");
  c.unmount();
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
  // Four-ish terminal viewports are enough to reproduce the resume freeze. The eager tail must stay
  // viewport-scale; the old 300-line window warmed this entire set even though only ~30 rows were visible.
  const many: Line[] = Array.from({ length: 120 }, (_, i) => ({ id: 50000 + i, kind: "info", text: `l${i}` }));
  await new Promise<void>((resolve) => {
    const t0 = Date.now();
    warmAnsiCache(many, 60, CFG, () => {
      const done = many.slice(-Math.min(WARM_WINDOW, many.length)).every((l) => getCachedRows(l, 60));
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

test("ansi-cache: oversized lines take the bounded plain path", async () => {
  const { canRichRender, RICH_RENDER_MAX_CHARS } = await import("../src/ui/ansi-cache.ts");
  expect(canRichRender({ id: 80001, kind: "assistant", text: "x".repeat(RICH_RENDER_MAX_CHARS) })).toBe(true);
  expect(canRichRender({ id: 80002, kind: "assistant", text: "x".repeat(RICH_RENDER_MAX_CHARS + 1) })).toBe(false);
});

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

test("ansi-cache: plain fallbacks escape OSC, CSI, BEL, and C1 controls", async () => {
  const { fallbackRows, renderLineRows, clearAnsiCache } = await import("../src/ui/ansi-cache.ts");
  const line: Line = {
    id: 90004,
    kind: "assistant",
    text: `safe\u001b]52;c;clipboard\u0007 then \u001b[31mred\u009b2J`,
  };
  const rows = fallbackRows(line);
  const output = rows.join("\n");
  expect(output).toContain("\\u001b]52");
  expect(output).toContain("\\u0007");
  expect(output).toContain("\\u009b2J");
  expect(output).not.toContain("\u001b");
  expect(output).not.toContain("\u0007");
  expect(output).not.toMatch(/[\u0080-\u009f]/);
  const richOutput = renderLineRows(line, 60, CFG).join("\n");
  expect(richOutput).not.toContain("\u001b");
  expect(richOutput).not.toContain("\u0007");
  expect(richOutput).not.toMatch(/[\u0080-\u009f]/);
  clearAnsiCache();
});

test("ansi-cache: priming a committed assistant skips the raw markdown fallback", async () => {
  const { primeAnsiCache, getCachedRows, clearAnsiCache } = await import("../src/ui/ansi-cache.ts");
  const line = { id: 90003, kind: "assistant" as const, text: "**formatted answer**" };
  clearAnsiCache();
  primeAnsiCache(line, 60, CFG);
  const rows = getCachedRows(line, 60);
  expect(rows).not.toBeNull();
  expect(rows!.join("\n")).not.toContain("**");
  expect(rows!.join("\n")).toContain("formatted answer");
  clearAnsiCache();
});

test("fullscreen history: PgUp shows the jump pill; a new turn counts; End returns to the tail", async () => {
  {
    const msgs: any[] = [];
    for (let i = 0; i < 30; i++) { msgs.push({ role: "user", content: `q ${i}` }); msgs.push({ role: "assistant", content: `a ${i}` }); }
    const s: any = { id: "pill", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={s} />);
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
  }
});

test("fullscreen history pins the nearest prompt and clicking it jumps to that exact row", async () => {
  const msgs: any[] = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: "user", content: `anchor prompt ${i}` });
    msgs.push({ role: "assistant", content: `answer ${i}` });
  }
  const s: any = { id: "anchors", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
  const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={s} />);
  try {
    expect(await until(c, (frames) => frames.includes("answer 29"), 3000)).toBe(true); // hydrate before sending navigation
    c.stdin.write("\x1b[5~"); // PageUp: leave the live tail so the fixed navigation row becomes active

    let anchor = "";
    for (let waited = 0; waited < 3000; waited += 25) {
      anchor = strip(c.lastFrame()).split("\n")[0]?.trim() ?? "";
      if (/^> anchor prompt \d+$/.test(anchor)) break;
      await tick(25);
    }
    expect(anchor).toMatch(/^> anchor prompt \d+$/);

    c.stdin.write("\x1b[<0;5;1M"); // left press on the fixed first row
    let jumped = false;
    for (let waited = 0; waited < 3000; waited += 25) {
      const rows = strip(c.lastFrame()).split("\n");
      if ((rows[0]?.trim() ?? "") === anchor) { jumped = true; break; }
      await tick(25);
    }
    expect(jumped).toBe(true); // header unmounted; the exact prompt is now the first transcript row
  } finally {
    c.unmount();
  }
}, 15000);

test("sticky prompt click stays exact while an uncommitted streaming tail extends the band", async () => {
  const msgs: any[] = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: "user", content: `stream anchor prompt ${i}` });
    msgs.push({ role: "assistant", content: `stream answer ${i}` });
  }
  const session: any = { id: "stream-anchors", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
  const provider = new StreamingAnchorHang();
  const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={provider} resumedSession={session} />);
  try {
    expect(await until(c, (frames) => frames.includes("stream answer 29"), 3000)).toBe(true);
    c.stdin.write("keep streaming");
    await tick(60);
    c.stdin.write("\r");
    expect(await until(c, (frames) => frames.includes("LIVE TAIL ROW 19"), 3000)).toBe(true);
    c.stdin.write("\x1b[5~");
    await tick(100); // first page lands exactly on a prompt, where the sticky row is correctly suppressed
    c.stdin.write("\x1b[5~"); // move deeper so the test exercises a real mounted anchor

    let anchor = "";
    for (let waited = 0; waited < 3000; waited += 25) {
      anchor = strip(c.lastFrame()).split("\n")[0]?.trim() ?? "";
      if (/^> stream anchor prompt \d+$/.test(anchor)) break;
      await tick(25);
    }
    expect(anchor).toMatch(/^> stream anchor prompt \d+$/);

    c.stdin.write("\x1b[<0;5;1M");
    let jumped = false;
    for (let waited = 0; waited < 3000; waited += 25) {
      const first = strip(c.lastFrame()).split("\n")[0]?.trim() ?? "";
      if (first === anchor) { jumped = true; break; }
      await tick(25);
    }
    expect(jumped).toBe(true);
  } finally {
    provider.cancelled = true;
    c.unmount();
    await tick(40);
  }
}, 15000);


test("TUI --continue restores session.mode (not silent reboot to config auto)", async () => {
  const prevHome = process.env.HOME;
  const prevMode = process.env.NEKO_MODE;
  const home = mkdtempSync(join(tmpdir(), "neko-mode-restore-"));
  try {
    delete process.env.NEKO_MODE;
    process.env.HOME = home;
    mkdirSync(join(home, ".neko-core"), { recursive: true });
    writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({ mode: "auto" }));
    class EchoP {
      async complete() { return { content: "hi", tool_calls: [] }; }
    }
    const resumed: any = {
      id: "mode-restore-ux3",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      cwd: process.cwd(),
      model: "m",
      mode: "plan",
      messages: [{ role: "user", content: "stay in plan" }, { role: "assistant", content: "ok" }],
    };
    // SAFETY: test-built Echo provider; complete() returns the fixed shape this resume UX probe needs.
    const c = render(<ChatApp fullscreen={false} yolo={false} provider={new EchoP() as any} resumedSession={resumed} />);
    await Bun.sleep(120);
    const frame = strip(c.lastFrame());
    expect(frame).toMatch(/mode restored:\s*plan/i);
    const status = frame.split("\n").find((line) => line.includes("shift+tab")) ?? "";
    expect(status).toContain("plan");
    c.unmount();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMode === undefined) delete process.env.NEKO_MODE; else process.env.NEKO_MODE = prevMode;
    rmSync(home, { recursive: true, force: true });
  }
});

test("explicit --yolo footer shows yolo not plain auto", async () => {
  class Echo {
    async complete() { return { content: "hi", tool_calls: [] }; }
  }
  // SAFETY: test-built Echo provider; complete() returns the fixed shape this yolo footer probe needs.
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo() as any} />);
  await Bun.sleep(80);
  const frame = strip(c.lastFrame());
  expect(frame).toContain("yolo");
  expect(frame).toMatch(/launched with --yolo/i);
  c.unmount();
});

test("input footer: the prompt is BOXED by a rule above AND below, status beneath", () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
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
  const titleDriver = createTitleDriver({ write: (title) => captured.push(title), keepIdle: false });
  const titleOf = () => captured.at(-1) ?? "";
  const pollTitle = async (pred: (t: string) => boolean, ms = 1500) => { for (let w = 0; w < ms; w += 25) { if (pred(titleOf())) return true; await tick(25); } return pred(titleOf()); };
  let c: ReturnType<typeof render> | null = null;
  try {
    c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} titleDriver={titleDriver} />);
    await tick(60);
    c.stdin.write("first message here"); await tick(20); c.stdin.write("\r");   // first turn NAMES the session
    expect(await pollTitle((t) => t.includes("first message here"))).toBe(true);
    captured.length = 0;
    c.stdin.write("second different prompt"); await tick(20); c.stdin.write("\r"); // a later turn must NOT rename it
    expect(await pollTitle((t) => t.includes("first message here"))).toBe(true); // still the session name...
    expect(titleOf()).not.toContain("second different prompt"); // ...not the new prompt
  } finally {
    c?.unmount();
    titleDriver.stop();
  }
});

test("fullscreen find: Ctrl+F opens the find bar and typing shows a match badge", async () => {
  {
    const msgs: any[] = [];
    for (let i = 0; i < 20; i++) { msgs.push({ role: "user", content: `question ${i}` }); msgs.push({ role: "assistant", content: `answer NEEDLE ${i}` }); }
    const s: any = { id: "fsf", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: msgs };
    const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={s} />);
    await tick(120);
    c.stdin.write("\x06"); // Ctrl+F -> open find
    await tick(60);
    c.stdin.write("NEEDLE");
    await tick(100);
    const f = strip(c.frames.join("\n"));
    expect(f).toContain("find:");
    expect(f).toMatch(/\d+\/\d+/); // match badge like "1/20"
    c.unmount();
  }
});

test("resize triggers a debounced full wipe + Static re-emit (ghost-frame regression guard)", async () => {
  const s: any = { id: "rz", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "m", messages: [
    { role: "user", content: "resize-marker question" },
    { role: "assistant", content: "resize-marker answer" },
  ] };
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} resumedSession={s} />);
  await tick(80);
  const before = c.frames.length;
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
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

  test("ApprovalBox keeps long edit diffs readable (no mid-string … truncation)", () => {
    const old_string = "const " + "a".repeat(200) + " = 1;";
    const new_string = "const " + "b".repeat(200) + " = 2;\nconst c = 3;";
    const f = strip(render(<ApprovalBox approval={{ toolName: "edit", args: { path: "long.ts", old_string, new_string }, resolve: () => {} }} width={80} />).lastFrame());
    // Ink wraps long lines and the round border inserts │ between visual rows.
    const compact = f.replace(/[^a-z0-9=;_+\-]/gi, "");
    expect(compact).toContain("a".repeat(200)); // full old payload, not sliced with ...
    expect(compact).toContain("b".repeat(200));
    expect(f).toContain("const c = 3;");
    expect(f).not.toMatch(/a{10}\.\.\./); // format.trunc style
  });

  test("ApprovalBox expands hard tabs in edit diffs (no raw \\t / no glyph holes)", () => {
    // Lived P1 after PR #33: tab-indented CRLF files painted as `owconst` / `peconsole` because
    // string-width treats \\t as width 0 while the TTY advances to the next tab stop and leaves
    // stale cells in the gap. Expand to spaces before Ink measures/paints.
    const old_string = "\tconst msg = \"hello, \" + name + \"!\";\r\n\tconsole.log(msg);";
    const new_string = "\tconst msg = \"hi, \" + name + \"!\";\r\n\tconsole.log(msg);";
    const f = strip(render(<ApprovalBox approval={{ toolName: "edit", args: { path: "greet_crlf.js", old_string, new_string }, resolve: () => {} }} width={80} />).lastFrame());
    expect(f).not.toContain("\t");
    expect(f).toContain("-     const msg = \"hello, \" + name + \"!\";");
    expect(f).toContain("+     const msg = \"hi, \" + name + \"!\";");
    expect(f).toContain("    console.log(msg);");
    expect(f).not.toMatch(/owconst|peconsole|—const/);
  });

  test("ApprovalBox expands hard tabs in multi_edit diffs", () => {
    const f = strip(render(<ApprovalBox approval={{
      toolName: "multi_edit",
      args: {
        path: "tabs.js",
        edits: [{ old_string: "\tfoo()", new_string: "\tbar()" }],
      },
      resolve: () => {},
    }} width={60} />).lastFrame());
    expect(f).not.toContain("\t");
    expect(f).toContain("-     foo()");
    expect(f).toContain("+     bar()");
  });

  test("ApprovalBox renders multi_edit diffs per hunk", () => {
    const f = strip(render(<ApprovalBox approval={{
      toolName: "multi_edit",
      args: {
        path: "m.ts",
        edits: [
          { old_string: "a = 1", new_string: "a = 10" },
          { old_string: "b = 2", new_string: "b = 20" },
        ],
      },
      resolve: () => {},
    }} />).lastFrame());
    expect(f).toContain("multi_edit m.ts");
    expect(f).toContain("- a = 1");
    expect(f).toContain("+ a = 10");
    expect(f).toContain("- b = 2");
    expect(f).toContain("+ b = 20");
  });

  test("ApprovalBox shows an approval confirmation state when flash is set (micro-feedback)", () => {
    const approval = { toolName: "bash", args: { command: "ls" }, resolve: () => {} };
    // No flash -> the prompt question is shown
    const idle = strip(render(<ApprovalBox approval={approval} />).lastFrame());
    expect(idle).toContain("Approve bash?");
    // Flash approved -> confirmation text replaces the question
    const ok = strip(render(<ApprovalBox approval={approval} flash={{ kind: "ok", tool: "bash" }} />).lastFrame());
    expect(ok).toContain("approved");
    expect(ok).not.toContain("Approve bash?");
    // Flash denied -> different confirmation
    const no = strip(render(<ApprovalBox approval={approval} flash={{ kind: "no", tool: "bash" }} />).lastFrame());
    expect(no).toContain("denied");
    expect(no.match(/denied/g)).toHaveLength(1); // confirmation is not repeated in both header + footer
    // Flash always -> names the tool
    const always = strip(render(<ApprovalBox approval={approval} flash={{ kind: "always", tool: "bash" }} />).lastFrame());
    expect(always).toContain("always bash (this session)");
  });


  
  test("ApprovalBox shows 1 of N when queueRemaining > 1", () => {
    const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const solo = strip(render(<ApprovalBox approval={{ toolName: "edit", args: { path: "a.ts", old_string: "x", new_string: "y" }, resolve: () => {} }} />).lastFrame());
    expect(solo).toContain("Approve edit?");
    expect(solo).not.toContain("1 of ");
    const queued = strip(render(<ApprovalBox approval={{ toolName: "edit", args: { path: "a.ts", old_string: "x", new_string: "y" }, resolve: () => {}, queueRemaining: 2 }} />).lastFrame());
    expect(queued).toContain("Approve edit? (1 of 2)");
  });

  test("ApprovalBox always-allow option names this session (not path-scoped forever)", () => {
    const f = strip(render(<ApprovalBox approval={{
      toolName: "write_file",
      args: { path: "a.txt", content: "x\n" },
      resolve: () => {},
    }} />).lastFrame());
    expect(f).toContain("[a]lways allow write_file (this session)");
    expect(f).not.toContain("[a]lways allow write_file]");
  });

  test("ApprovalBox destructive bash warns and clarifies always-allow covers destructive", () => {
    const f = strip(render(<ApprovalBox approval={{
      toolName: "bash",
      args: { command: "rm -rf build" },
      resolve: () => {},
    }} />).lastFrame());
    expect(f).toMatch(/⚠|!/);
    expect(f).toContain("recursive/force/wildcard delete (rm)");
    expect(f).toContain("[a]lways allow bash (this session — incl. destructive)");
  });

  test("ApprovalBox outside-workspace write shows host-write warning", () => {
    const f = strip(render(<ApprovalBox approval={{
      toolName: "write_file",
      args: { path: "/tmp/neko-host-write-ux.txt", content: "x\n" },
      resolve: () => {},
    }} />).lastFrame());
    expect(f).toContain("outside workspace");
    expect(f).toContain("confirm this exact host write");
  });

  test("ApprovalBox flashes a key hint when hint prop is set", () => {
    const approval = { toolName: "bash", args: { command: "ls" }, resolve: () => {} };
    const f = strip(render(<ApprovalBox approval={approval} hint="press [y]es / [a]lways this session / [n]o" />).lastFrame());
    expect(f).toContain("Approve bash?");
    expect(f).toContain("press [y]es / [a]lways this session / [n]o");
    // Option row itself names session scope (raise-bar-8 trust).
    expect(f).toContain("[a]lways allow bash (this session)");
  });

  test("ApprovalBox elides unchanged anchor lines when appending after a function", () => {
    const old_string = [
      "export function clamp(n, lo, hi) {",
      "  if (n < lo) return lo;",
      "  if (n > hi) return hi;",
      "  return n;",
      "}",
    ].join("\n");
    const new_string = old_string + "\n\nexport function range(xs) {\n  return [0, 1];\n}";
    const f = strip(render(<ApprovalBox approval={{
      toolName: "edit",
      args: { path: "src/stats.js", old_string, new_string },
      resolve: () => {},
    }} width={80} />).lastFrame());
    expect(f).toContain("Approve edit?");
    expect(f).toContain("unchanged line");
    expect(f).toContain("export function range");
    // The identical clamp body should not paint as both red and green noise.
    expect(f).not.toContain("- if (n < lo) return lo;");
    // Kept context brace must be dim once — never a false -}/+} pair (raise-bar-4 lived).
    expect(f).not.toContain("- }");
    expect(f).toContain("+ export function range");
    // Meaningful dim context (raise-bar-5): not a lone `}` — show a real anchor line.
    expect(f).toContain("return n;");
  });

  test("ApprovalBox multi_edit append elides shared line as dim context (not -/+)", () => {
    const line = 'assert(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === "[[1,2],[3,4],[5]]", "chunk");';
    const f = strip(render(<ApprovalBox approval={{
      toolName: "multi_edit",
      args: {
        path: "test/selftest.js",
        edits: [{
          old_string: line,
          new_string: line + '\nassert(JSON.stringify(groupBy([], x => x)) === "{}", "groupBy empty");',
        }],
      },
      resolve: () => {},
    }} width={80} />).lastFrame());
    expect(f).toContain("Approve multi_edit?");
    expect(f).toContain("groupBy empty");
    // Shared chunk assert must not appear as both removed and added.
    expect(f).not.toContain("- assert(JSON.stringify(chunk");
    expect(f).toContain("+ assert(JSON.stringify(groupBy");
  });


test("reasoning shows live while busy, clears when done", async () => {
  const provider = new Reasoner();
  const c = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  try {
    await tick();
    c.stdin.write("go");
    await tick(20);
    c.stdin.write("\r");
    expect(await until(c, (f) => f.includes("let me think hard"))).toBe(true); // shown mid-turn
    provider.release();
    expect(await until(c, (f) => f.includes("the answer"))).toBe(true); // final answer lands
    expect(strip(c.lastFrame())).not.toContain("let me think hard"); // thinking cleared when done
  } finally {
    provider.release();
    c.unmount();
  }
}, 15_000);

test("post-turn run-time line + placeholder drops after first turn", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  try {
    await tick();
    expect(strip(c.lastFrame())).toContain("Try:"); // placeholder before the first turn
    c.stdin.write("hi");
    await tick(20);
    c.stdin.write("\r");
    expect(await until(c, (f) => /for \d+s/.test(f))).toBe(true); // completion line appears
    const frames = strip(c.frames.join("\n"));
    // Live context uses max(provider last-prompt, local estimate). Estimate varies with
    // loaded tool schemas/config, so assert the shape + that we did NOT keep the old
    // provider-only pairing (↑1.0k with 80% cache of that tiny prompt).
    expect(frames).toMatch(/last context ↑[\d.]+k ↓10 · cache ↑800 \(\d+%\)/);
    expect(frames).not.toContain("last context ↑1.0k ↓10 · cache ↑800 (80%)");
    expect(frames).not.toMatch(/chat\s+fast path/);
    expect(strip(c.lastFrame())).not.toContain("Try:"); // placeholder gone
  } finally {
    c.unmount();
  }
}, 15_000); // keep the 1.5s semantic poll; allow slow Windows full-suite scheduling and always clean up

test("Shift+Tab cycles the permission mode (auto -> default)", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  await tick();
  expect(strip(c.lastFrame())).toContain("auto");
  c.stdin.write("\x1b[Z"); // Shift+Tab
  await tick(50);
  const after = strip(c.lastFrame());
  expect(after).toContain("default");
  // Quieter CONT-1: contract flash is ephemeral status, not a durable transcript info line.
  expect(after).toMatch(/mode:\s*(?:yolo[^\n]*—\s*)?default/);
  c.unmount();
});

test("Shift+Tab mode flash does not stack durable transcript mode lines", async () => {
  const c = render(<ChatApp fullscreen={false} yolo={false} provider={new Echo()} />);
  try {
    await tick();
    c.stdin.write("\x1b[Z"); // auto -> default
    await tick(40);
    c.stdin.write("\x1b[Z"); // default -> accept-edits
    await tick(40);
    c.stdin.write("\x1b[Z"); // accept-edits -> plan
    await tick(40);
    // Wait out the 1800ms ephemeral flash; durable transcript must not keep `mode: …` lines.
    await tick(2000);
    const after = strip(c.lastFrame() ?? "");
    expect(after).toMatch(/plan/); // footer chip
    expect(after).not.toMatch(/mode:\s+(?:yolo[^\n]*—\s*)?(?:default|accept-edits|plan|auto)\b/);
    // Boot disclosure uses "mode auto:" (no colon after mode) and must remain.
    expect(after).toMatch(/mode auto:/);
  } finally {
    c.unmount();
  }
});

test("slash menu autocompletes as you type", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/mod");
  await tick(50);
  expect(strip(c.lastFrame())).toContain("/model");
  c.unmount();
});

test("/help opens an ephemeral command overlay (not a permanent transcript dump)", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  try {
    await tick();
    c.stdin.write("/help");
    await tick(20);
    c.stdin.write("\r");
    // Overlay title + a real slash entry (searchable picker), not the old multi-line dump.
    expect(await until(c, (f) => f.includes("Commands") && f.includes("/model"))).toBe(true);
    const open = strip(c.lastFrame() ?? "");
    expect(open).toContain("show help"); // detail from SLASH
    // Esc closes without dumping the catalog into the task trail.
    c.stdin.write("\x1b");
    await tick(50);
    const after = strip(c.lastFrame() ?? "");
    expect(after).not.toContain("/mcp-prompt"); // overlay gone; catalog not burned into transcript
  } finally {
    c.unmount();
  }
}, 15_000);

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

test("failed tool_call bullet is red, success stays green", () => {
  // Lived raise-bar-10: deny painted success-green ● Update(...) above red Denied by user.
  // ink-testing-library strips SGR under NO_COLOR; assert the color helper + that both still render.
  expect(toolCallBulletColor(undefined)).toBe("green");
  expect(toolCallBulletColor(false)).toBe("green");
  expect(toolCallBulletColor(true)).toBe("red");
  const ok = strip(render(<TranscriptLine line={{ id: 1, kind: "tool_call", text: "Update(notes/x.txt)" }} cfg={CFG} />).lastFrame());
  const bad = strip(render(<TranscriptLine line={{ id: 2, kind: "tool_call", text: "Update(notes/x.txt)", failed: true }} cfg={CFG} />).lastFrame());
  expect(ok).toContain("Update(notes/x.txt)");
  expect(bad).toContain("Update(notes/x.txt)");
});

test("user prompts render as padded message blocks", () => {
  const frame = strip(render(<TranscriptLine line={{ id: 1, kind: "user", text: "clear speaker" }} cfg={CFG} cols={40} />).lastFrame());
  const row = frame.split("\n").find((line) => line.includes("clear speaker")) ?? "";
  expect(row).toStartWith(" > clear speaker");
});

test("tool results remove extractor blank gutters without changing content", () => {
  const raw = `${"\n".repeat(12)}Title\n\n\n\nBody${"\n".repeat(12)}`;
  expect(toolResultDisplayLines(raw)).toEqual(["Title", "", "Body"]);
  const frame = strip(render(<TranscriptLine line={{ id: 2, kind: "tool_result", text: raw }} cfg={CFG} cols={60} />).lastFrame());
  expect(frame.split("\n")[0]).toContain("Title");
  expect(frame).toContain("Body");
  expect(frame).not.toContain("\n\n\n");
});

test("write_file approval previews size + a '+N more lines' hint", () => {
  const content = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
  const f = strip(render(<ApprovalBox approval={{ toolName: "write_file", args: { path: "x.html", content }, resolve: () => {} }} />).lastFrame());
  expect(f).toContain("60 lines");
  expect(f).toContain("+12 more lines"); // beyond APPROVAL_DIFF_MAX_LINES (48)
  expect(f).toContain("line0");
});

test("typing '/' caps the command list with a '+N more' hint", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("/");
  await tick(50);
  expect(strip(c.lastFrame())).toMatch(/\+\d+ more/);
  c.unmount();
});

test("Ctrl+C clears a non-empty input (does not exit)", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("some draft text");
  await tick(20);
  c.stdin.write("\x03"); // Ctrl+C
  await tick(40);
  expect(strip(c.lastFrame())).not.toContain("some draft text");
  c.unmount();
});

test("Ctrl+C twice exits an idle chat", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("\x03");
  await tick(40);
  expect(strip(c.lastFrame())).toContain("press ctrl+c again to exit");
  c.stdin.write("\x03");
  await tick(100);
  const framesAfterExit = c.frames.length;
  c.stdin.write("must not reach an unmounted chat");
  await tick(100);
  expect(c.frames.length).toBe(framesAfterExit);
});

test("Alt+C copies the whole draft without changing it", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  await tick();
  c.stdin.write("draft stays here");
  await tick(20);
  c.stdin.write("\x1bc"); // Alt+C
  await tick(40);
  const frame = strip(c.lastFrame());
  expect(frame).toContain("draft stays here");
  expect(frame).toContain("copied draft (16 chars)");
  c.unmount();
});

test("Alt+C expands a collapsed multiline paste before copying", async () => {
  const c = render(<ChatApp fullscreen={false} yolo provider={new Echo()} />);
  const paste = "first line\nsecond line\nthird line";
  await tick();
  c.stdin.write(paste);
  await tick(30);
  expect(strip(c.lastFrame())).toContain("[Pasted text #1 +2 lines]");
  c.stdin.write("\x1bc");
  await tick(40);
  const frame = strip(c.lastFrame());
  expect(frame).toContain("[Pasted text #1 +2 lines]");
  expect(frame).toContain(`copied draft (${paste.length} chars)`);
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
  const provider = new MdHang();
  const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={provider} />);
  try {
    await tick(60);
    c.stdin.write("go");
    await tick(20);
    c.stdin.write("\r");
    // Wait until the complete Markdown-bearing prefix reaches the live band while the provider is still
    // hanging. The trailing plain-text sentence is irrelevant to this regression and may render later on
    // a loaded runner even after all deltas were emitted, so it must not be the readiness signal.
    // A fully loaded Linux CI worker can defer the hidden Ink flush well beyond the provider's last
    // delta. Poll the rendered postcondition rather than assuming that 15 seconds implies a commit.
    for (let i = 0; i < 1200; i++) {
      const frame = strip(c.lastFrame());
      if (provider.streamedAll && frame.includes("Trump - Putin") && !frame.includes("**")) break;
      await tick(25);
    }
    const f = strip(c.lastFrame());
    expect(provider.streamedAll).toBe(true);
    expect(provider.completed).toBe(false); // proves the assertions observe the LIVE band, not committed output
    expect(f).toContain("Nga - Ukraine"); // ## header rendered live (not blank, not committed)
    expect(f).toContain("tổng hợp");       // earlier **bold** rendered live
    expect(f).toContain("Trump - Putin"); // later **bold** pair is closed and rendered too
    expect(f).not.toContain("## ");        // header marker consumed - it is FORMATTED, not raw
    expect(f).not.toContain("**");         // all bold markers closed and rendered
  } finally {
    provider.cancelled = true;
    c.unmount();
    await tick(20); // let the provider leave its hang so no timer outlives the test
  }
}, 45000); // hidden-instance rendering reached >15s on a fully loaded Linux runner

test("interrupted turn is PERSISTED incrementally - resume shows the work, not nothing", async () => {
  // The bug: persist() ran ONLY in the turn's finally block, so killing the process mid-turn (closing
  // the terminal) lost the user's prompt AND every tool result. The fix persists at each clean
  // checkpoint (step / tool_result). Here the provider HANGS on the first call - the finally-persist
  // never runs, so only the incremental persist can save the user message. Without the fix: no file.
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), "neko-persist-home-"));
  process.env.USERPROFILE = home; process.env.HOME = home;
  let cancelled = false;
  class Hang implements Provider {
    async complete(_messages: any[], _tools?: any[], onDelta?: any): Promise<ProviderResponse> {
      onDelta?.("đã thu thập được bằng chứng quan trọng", "content");
      await new Promise<void>((r) => { const t = setInterval(() => { if (cancelled) { clearInterval(t); r(); } }, 20); });
      return { content: "", tool_calls: [] };
    }
  }
  try {
    const c = renderFullscreen(<ChatApp fullscreen={false} yolo provider={new Hang()} sessionId="persist-int" />);
    await tick(60);
    c.stdin.write("nhiem vu quan trong");
    await tick(20);
    c.stdin.write("\r");
    const { loadSession } = await import("../src/adapters/session.ts");
    let s: any = null;
    for (let i = 0; i < 80; i++) {
      s = loadSession("persist-int");
      if (s?.messages?.some((m: any) => String(m.content).includes("bằng chứng quan trọng"))) break;
      await tick(25);
    }
    // The turn is STILL hanging (never reached finally) - both the prompt AND streamed progress are
    // already on disk. The old checkpoint saved only the prompt because deltas lived in streamRef.
    expect(s).not.toBeNull();
    expect(s.messages.some((m: any) => m.role === "user" && String(m.content).includes("nhiem vu quan trong"))).toBe(true);
    expect(s.messages.some((m: any) => m.role === "assistant" && String(m.content).includes("bằng chứng quan trọng"))).toBe(true);
    c.unmount();
  } finally {
    cancelled = true;
    process.env.USERPROFILE = saved.up; process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);


test("plan exit [y] lands in auto; [e] lands in accept-edits", async () => {
  const prevMode = process.env.NEKO_MODE;
  process.env.NEKO_MODE = "plan";
  try {
    class PlanExitOnce implements Provider {
      n = 0;
      async complete(): Promise<ProviderResponse> {
        this.n++;
        if (this.n === 1) {
          return {
            content: null,
            tool_calls: [{ id: "p", name: "exit_plan_mode", arguments: { plan: "## Plan\n1. ship it" } }],
          };
        }
        return { content: "done-after-plan", tool_calls: [] };
      }
    }
    // --- y → auto ---
    const pY = new PlanExitOnce();
    const cY = render(<ChatApp fullscreen={false} yolo={false} provider={pY} />);
    cY.stdin.write("go");
    await tick(30);
    cY.stdin.write("\r");
    expect(await until(cY, (f) => f.includes("Ready to code?") && f.includes("[y] auto"), 4000)).toBe(true);
    expect(strip(cY.lastFrame())).toContain("[e] accept-edits");
    cY.stdin.write("y");
    expect(await until(cY, (f) => /approved\s*→\s*auto|>>\s*auto|mode:\s*auto/i.test(f) || f.includes("done-after-plan"), 5000)).toBe(true);
    // Footer chip should show auto after settle (flash may have cleared).
    expect(await until(cY, (f) => />>\s*auto/.test(f) || /⏵⏵\s*auto/.test(f), 3000)).toBe(true);
    cY.unmount();

    // --- e → accept-edits ---
    const pE = new PlanExitOnce();
    const cE = render(<ChatApp fullscreen={false} yolo={false} provider={pE} />);
    cE.stdin.write("go");
    await tick(30);
    cE.stdin.write("\r");
    expect(await until(cE, (f) => f.includes("Ready to code?"), 4000)).toBe(true);
    cE.stdin.write("e");
    expect(await until(cE, (f) => /accept-edits/.test(f) && (f.includes("done-after-plan") || /approved\s*→\s*accept-edits/.test(f)), 5000)).toBe(true);
    expect(await until(cE, (f) => /accept-edits/.test(f), 3000)).toBe(true);
    cE.unmount();
  } finally {
    if (prevMode === undefined) delete process.env.NEKO_MODE;
    else process.env.NEKO_MODE = prevMode;
  }
}, 25_000);
