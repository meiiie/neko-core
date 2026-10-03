import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatApp } from "../src/ui/chat.tsx";
import { loadSession, setSessionsDir, type Session } from "../src/adapters/session.ts";
import { DisplayHistory } from "../src/adapters/display-history.ts";
import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";

const delay = (ms=30) => new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean, ms=5000) {
  const end=Date.now()+ms;
  while(Date.now()<end) { if(predicate()) return true; await delay(); }
  return predicate();
}
class Summarizer implements Provider {
  calls: string[]=[];
  async complete(messages: unknown[]): Promise<ProviderResponse> {
    this.calls.push(JSON.stringify(messages));
    return {content:"Checkpoint summary: continue the fixture task.",tool_calls:[]};
  }
}

test("main resume scroll reaches pre-compaction history after restart without adding it to model context", async () => {
  const home=mkdtempSync(join(tmpdir(),"neko-resume-history-"));
  const savedHome=process.env.HOME, savedProfile=process.env.USERPROFILE;
  process.env.HOME=home; process.env.USERPROFILE=home;
  setSessionsDir(join(home,"sessions"));
  const provider=new Summarizer();
  const session: Session={id:"displaycompaction",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),cwd:process.cwd(),model:"fixture",messages:Array.from({length:320},(_,i)=>[{role:"user",content:`PROMPT_${i}`},{role:"assistant",content:`ANSWER_${i}`}]).flat()};
  let c=render(<ChatApp fullscreen yolo provider={provider} resumedSession={session}/>);
  try {
    expect(await until(()=>!c.lastFrame()?.includes("Loading earlier history") && Boolean(c.lastFrame()?.includes("ANSWER_319")))).toBe(true);
    c.stdin.write("/compact"); await delay(80); c.stdin.write("\r");
    expect(await until(()=>Boolean(loadSession(session.id)?.displayHistory))).toBe(true);
    const compacted=loadSession(session.id)!;
    expect(compacted.messages.length).toBeLessThan(30);
    expect(compacted.displayHistory?.head).not.toBeNull();
    c.unmount();
    c=render(<ChatApp fullscreen yolo provider={provider} resumedSession={compacted}/>);
    expect(await until(()=>Boolean(c.lastFrame()?.includes("ANSWER_319")))).toBe(true);
    const callsBefore=provider.calls.length;
    // Home requests the actual beginning, including pages not loaded yet.
    c.stdin.write("\x1b[H");
    expect(await until(()=>Boolean(c.lastFrame()?.includes("PROMPT_0") && c.lastFrame()?.includes("Neko Core")))).toBe(true);
    expect(provider.calls.length).toBe(callsBefore);
    expect(c.lastFrame()!.indexOf("Neko Core")).toBeGreaterThanOrEqual(0);
    expect(c.lastFrame()!.indexOf("Neko Core")).toBeLessThan(c.lastFrame()!.indexOf("PROMPT_0"));
    expect(compacted.messages.some(m=>String(m.content).includes("PROMPT_123"))).toBe(false);
    const archive=new DisplayHistory(home,{sessionId:session.id,root:session.cwd},compacted.displayHistory);
    let page=await archive.page(); const entries=[...page.entries];
    while(page.older) { page=await archive.page(page.older); entries.unshift(...page.entries); }
    expect(entries.some(e=>e.text==="PROMPT_123")).toBe(true);
    expect(entries.filter(e=>e.text==="PROMPT_0")).toHaveLength(1);
  } finally {
    c.unmount(); setSessionsDir(null);
    if(savedHome===undefined) delete process.env.HOME; else process.env.HOME=savedHome;
    if(savedProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=savedProfile;
  }
},20_000);

test("main resume exposes summarized tool output directly through its scrollback", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-resume-tool-"));
  const savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  setSessionsDir(join(home, "sessions"));
  const provider = new Summarizer();
  const session: Session = {
    id: "displaytool", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "fixture",
    messages: [
      {role: "user", content: "Read the fixture"},
      {role: "assistant", content: "", tool_calls: [{id: "read", type: "function", function: {name: "read_file", arguments: '{"path":"fixture.txt"}'}}]},
      {role: "tool", tool_call_id: "read", content: Array.from({length: 600}, (_, i) => `TOOL_ROW_${i}`).join("\n")},
    ],
  };
  const c = render(<ChatApp fullscreen yolo provider={provider} resumedSession={session}/>);
  try {
    expect(await until(() => Boolean(c.lastFrame()?.includes("TOOL_ROW_599")))).toBe(true);
    c.stdin.write("\x1b[H");
    expect(await until(() => Boolean(c.lastFrame()?.includes("TOOL_ROW_0")))).toBe(true);
    c.stdin.write("\x1b[F");
    expect(await until(() => Boolean(c.lastFrame()?.includes("TOOL_ROW_599")))).toBe(true);
    expect(provider.calls).toHaveLength(0);
  } finally {
    c.unmount(); setSessionsDir(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
}, 20_000);


test("startup resume keeps the welcome before restored conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-resume-welcome-"));
  const savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  setSessionsDir(join(home, "sessions"));
  const c = render(<ChatApp fullscreen yolo provider={new Summarizer()} resumedSession={{
    id: "welcomefirst", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "fixture",
    messages: [{role: "user", content: "SAVED_PROMPT"}, {role: "assistant", content: "SAVED_ANSWER"}],
  }}/>);
  try {
    expect(await until(() => Boolean(c.lastFrame()?.includes("SAVED_ANSWER")))).toBe(true);
    c.stdin.write("\x1b[H");
    expect(await until(() => Boolean(c.lastFrame()?.includes("Neko Core")))).toBe(true);
    const frame = c.lastFrame()!;
    expect(frame.indexOf("Neko Core")).toBeGreaterThanOrEqual(0);
    expect(frame.indexOf("Neko Core")).toBeLessThan(frame.indexOf("SAVED_PROMPT"));
    expect(frame.indexOf("SAVED_PROMPT")).toBeLessThan(frame.indexOf("SAVED_ANSWER"));
    expect(frame).not.toContain('Try: "explain src/agent.ts"');
  } finally {
    c.unmount(); setSessionsDir(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
}, 20_000);

test("main find reaches deep tool rows and archived pages before Home is used", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-resume-find-"));
  const savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  setSessionsDir(join(home, "sessions"));
  const provider = new Summarizer();
  const session: Session = {
    id: "findallhistory", createdAt: new Date().toISOString(), updatedAt: "", cwd: process.cwd(), model: "fixture",
    messages: [
      ...Array.from({length: 320}, (_, i) => [{role: "user", content: `FIND_PROMPT_${i}_END`}, {role: "assistant", content: `FIND_ANSWER_${i}_END`}]).flat(),
      {role: "tool", tool_call_id: "fixture", content: Array.from({length: 600}, (_, i) => `DEEP_TOOL_ROW_${i}_END`).join("\n")},
    ],
  };
  const c = render(<ChatApp fullscreen yolo provider={provider} resumedSession={session}/>);
  try {
    expect(await until(() => Boolean(c.lastFrame()?.includes("DEEP_TOOL_ROW_599_END")))).toBe(true);
    c.stdin.write("\x06"); await delay(); c.stdin.write("DEEP_TOOL_ROW_450_END");
    expect(await until(() => Boolean(c.lastFrame()?.includes("1/1")))).toBe(true);
    expect(await until(() => Boolean(c.lastFrame()?.includes("DEEP_TOOL_ROW_451_END")))).toBe(true);
    c.stdin.write("\x1b"); await delay(); c.stdin.write("\x06"); await delay(); c.stdin.write("FIND_PROMPT_0_END");
    expect(await until(() => Boolean(c.lastFrame()?.includes("1/1")))).toBe(true);
    expect(await until(() => Boolean(c.lastFrame()?.includes("FIND_ANSWER_0_END")))).toBe(true);
    expect(provider.calls).toHaveLength(0);
    c.stdin.write("x".repeat(5000));
    expect(await until(() => Boolean(c.lastFrame()?.includes("Search too long")))).toBe(true);
    expect(c.lastFrame()).toContain("FIND_PROMPT_0_END");
    c.stdin.write("\x1b"); await delay(); c.stdin.write("still typing");
    expect(await until(() => Boolean(c.lastFrame()?.includes("still typing")))).toBe(true);
  } finally {
    c.unmount(); setSessionsDir(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
}, 20_000);

test("a stopped model turn keeps its interruption marker after resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-interrupt-display-"));
  const savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home; setSessionsDir(join(home, "sessions"));
  let entered = false;
  const provider: Provider = {async complete(_m, _t, _d, signal) {
    entered = true;
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason); else signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
    });
    return {content: "", tool_calls: []};
  }};
  let c = render(<ChatApp fullscreen yolo={false} provider={provider} sessionId="interrupted-marker" />);
  try {
    await delay(80); c.stdin.write("interruption fixture"); await delay(50); c.stdin.write("\r");
    expect(await until(() => entered && Boolean(c.lastFrame()?.includes("esc to interrupt")))).toBe(true);
    const headBefore = loadSession("interrupted-marker")?.displayHistory?.head;
    c.stdin.write("\x1b");
    expect(await until(() => Boolean(c.lastFrame()?.includes("(interrupted)")))).toBe(true);
    // Wait for the final checkpoint rather than unmounting at the first painted frame.
    let saved: Session | null = null;
    expect(await until(() => { saved = loadSession("interrupted-marker"); return Boolean(saved?.displayHistory?.head && saved.displayHistory.head !== headBefore && !saved?.displayPending?.length); })).toBe(true);
    c.unmount();
    c = render(<ChatApp fullscreen yolo={false} provider={new Summarizer()} resumedSession={saved!} />);
    expect(await until(() => Boolean(c.lastFrame()?.includes("(interrupted)")))).toBe(true);
  } finally {
    c.stdin.write("\x1b"); c.unmount(); setSessionsDir(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
}, 15_000);

test("Esc cancels standalone compaction without erasing a draft or installing a late summary", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-cancel-compact-"));
  const savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home; setSessionsDir(join(home, "sessions"));
  let receivedSignal: AbortSignal | undefined;
  const provider: Provider = {async complete(_m, _t, _d, signal) {
    receivedSignal = signal;
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason); else signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
    });
    return {content: "unused summary", tool_calls: []};
  }};
  const now = new Date().toISOString();
  const session: Session = {id: "cancel-compaction", createdAt: now, updatedAt: now, cwd: process.cwd(), model: "fixture",
    messages: Array.from({length: 12}, (_, i) => [{role: "user", content: `request_${i}`}, {role: "assistant", content: `answer_${i} ` + "observed detail ".repeat(100) + `\nEND_answer_${i}`}]).flat()};
  const c = render(<ChatApp fullscreen yolo={false} provider={provider} resumedSession={session} />);
  try {
    // Rich wrapping can move the start of this long reply above the viewport; its tail stays visible.
    expect(await until(() => Boolean(c.lastFrame()?.includes("END_answer_11"))
      && !c.lastFrame()?.includes("Loading earlier history"))).toBe(true);
    expect(c.lastFrame()).toContain("answer_11");
    c.stdin.write("/compact"); await delay(50); c.stdin.write("\r");
    expect(await until(() => Boolean(receivedSignal && c.lastFrame()?.includes("completion time is unknown")))).toBe(true);
    c.stdin.write("draft stays"); await delay(50); c.stdin.write("\x1b");
    expect(await until(() => Boolean(c.lastFrame()?.includes("Compaction cancelled; original context retained.")))).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(c.lastFrame()).toContain("draft stays");
    expect(c.lastFrame()).not.toContain("unused summary");
    const cancelledSignal = receivedSignal;
    c.stdin.write("\x15"); await delay(30);
    c.stdin.write("/compact"); await delay(40); c.stdin.write("\r");
    expect(await until(() => Boolean(receivedSignal && receivedSignal !== cancelledSignal))).toBe(true);
    c.unmount(); await delay(30);
    expect(receivedSignal?.aborted).toBe(true); // unmount owns the pending provider request too
  } finally {
    c.unmount(); setSessionsDir(null);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
}, 15_000);
