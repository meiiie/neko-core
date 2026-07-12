import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Provider, ProviderResponse } from "../src/adapters/providers.ts";
import { VERSION } from "../src/shared/version.ts";
import { ApprovalBox, ChatApp } from "../src/ui/chat.tsx";
import { buildReplayLines, clampToRows, contentToText, recoverTodos, renderTail } from "../src/ui/chat-lines.ts";
import { saveChatGptCredentials } from "../src/adapters/chatgpt-auth.ts";
import { setModel } from "../src/adapters/project.ts";
import type { ChatGptVoiceControl, ChatGptVoiceOptions, VoiceSnapshot } from "../src/adapters/chatgpt-voice.ts";
import type { BrowserVoiceOptions } from "../src/adapters/browser-voice.ts";

test("multimodal tool observations render as metadata + [image], never object coercion", () => {
  const content = [{ type: "text", text: "captured screen\n" }, { type: "image_url", image_url: { url: "data:image/gif;base64,AA" } }];
  expect(contentToText(content)).toBe("captured screen\n[image]");
  const lines = buildReplayLines([{ role: "tool", tool_call_id: "shot", content }], () => 1);
  expect(lines[0].text).toBe("captured screen\n[image]");
  expect(lines[0].text).not.toContain("[object Object]");
});

test("clampToRows bounds the live stream to the viewport height (fixes streaming scroll-jump)", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const out = clampToRows(text, 10, 80);
  expect(out.split("\n").length).toBeLessThanOrEqual(11); // ~10 rows + the "..." marker
  expect(out).toContain("line 99"); // keeps the latest (tail)
  expect(out.startsWith("...")).toBe(true); // marks truncation
  const wide = "x".repeat(240) + "\nshort"; // 240/80 = 3 wrapped rows
  expect(clampToRows(wide, 2, 80).includes("x".repeat(240))).toBe(false); // 3 rows > 2 budget -> dropped
});

test("renderTail bounds live-stream rendering to O(1) so the event loop can't stall on huge output", () => {
  expect(renderTail("short text")).toBe("short text"); // under cap -> unchanged
  const huge = Array.from({ length: 100000 }, (_, i) => `line ${i}`).join("\n"); // ~> 4000 chars
  const out = renderTail(huge, 4000);
  expect(out.length).toBeLessThan(4200); // capped regardless of input size
  expect(out.startsWith("...")).toBe(true); // truncation marker
  expect(out).toContain("line 99999"); // the latest content is kept (the tail)
  expect(out).not.toContain("line 0\n"); // the old head is dropped
});

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
// Poll until a predicate holds (or the budget runs out). Async tool tests must NOT hinge on a fixed
// tick: git-bash spawn + the follow-up provider call vary a lot with machine load, so a fixed wait
// flakes. Budget is per-call; keep (#calls * budget) under each test's jest timeout.
const until = async (pred: () => boolean, ms = 8000) => { for (let w = 0; w < ms && !pred(); w += 20) await tick(20); return pred(); };

/** Scripted provider: step responses in order; streams content via onDelta. */
class MockProvider implements Provider {
  index = 0;
  constructor(private script: ProviderResponse[]) {}
  async complete(_messages: any[], _tools?: any[], onDelta?: (t: string) => void): Promise<ProviderResponse> {
    const res = this.script[Math.min(this.index, this.script.length - 1)];
    this.index++;
    if (res.content && onDelta) onDelta(res.content);
    return res;
  }
}

test("resume re-renders the prior conversation", () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const resumed = {
    id: "s1", createdAt: "", updatedAt: "", cwd: process.cwd(), model: "m",
    messages: [{ role: "user", content: "hello before" }, { role: "assistant", content: "earlier reply" }],
  };
  const { lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} resumedSession={resumed as any} sessionId="s1" />);
  const out = lastFrame() ?? "";
  expect(out).toContain("hello before"); // prior user turn replayed
  expect(out).toContain("earlier reply"); // prior assistant turn replayed
  unmount();
});

test("header + input + status bar render on start", () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  const out = lastFrame() ?? "";
  expect(out).toContain(VERSION); // version line under the logo
  expect(out).toContain("auto"); // mode shown in the bottom status bar
  expect(out).toContain("shift+tab"); // status bar hint
  unmount();
});

test("slash menu: Down navigates suggestions instead of rewinding the prompt; Tab completes", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { lastFrame, stdin, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  await tick();
  stdin.write("/"); // open the slash menu
  await tick();
  expect(lastFrame() ?? "").toContain("up/down to select, tab to complete"); // menu open
  stdin.write("[B"); // Down arrow — must move the highlight, NOT clear/rewind the input
  await tick();
  // If Down had fallen through to history it would have cleared the input -> menu (and its hint) gone.
  expect(lastFrame() ?? "").toContain("up/down to select, tab to complete"); // still open => prompt intact
  stdin.write("h"); // narrow to /help-ish, then complete with Tab
  await tick();
  stdin.write("\t");
  await tick();
  expect(lastFrame() ?? "").toMatch(/\/h\w+/); // a full command name was filled into the prompt
  unmount();
});

test("auto mode: a safe tool call + markdown answer render end-to-end", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "c1", name: "ls", arguments: {} }] },
    { content: "Done **listing**.", tool_calls: [] },
  ]);
  const { stdin, frames, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  stdin.write("look around");
  await tick(20);
  stdin.write("\r"); // Enter
  await tick(250);
  const all = frames.join("\n");
  expect(all).toContain("> look around"); // user line
  expect(all).toContain("List"); // tool-call line (Claude-style label for ls)
  expect(all).toContain("Done listing"); // markdown-rendered assistant answer
  unmount();
});

test("default mode: gated bash shows the approval box, 'y' approves", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "c1", name: "bash", arguments: { command: "echo hi" } }] },
    { content: "Finished.", tool_calls: [] },
  ]);
  const { stdin, lastFrame, frames, unmount } = render(<ChatApp fullscreen={false} yolo={false} provider={provider} />);
  const seen = (s: string) => frames.join("\n").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  stdin.write("run echo");
  await tick(20);
  stdin.write("\r"); // Enter
  expect(await until(() => (lastFrame() ?? "").includes("Approve bash?"))).toBe(true); // approval box appeared
  expect(lastFrame() ?? "").toContain("$ echo hi"); // command preview
  stdin.write("y"); // approve
  expect(await until(() => seen("(exit 0)"))).toBe(true); // tool ran after approval (git-bash spawn can be slow)
  expect(await until(() => seen("Finished"))).toBe(true); // final answer
  expect(lastFrame() ?? "").not.toMatch(/^\s*>\s*y\s*$/m); // approval key must not leak into the prompt
  unmount();
}, 40000);

test("plan mode: exit_plan_mode shows the plan, 'y' proceeds", async () => {
  const provider = new MockProvider([
    { content: null, tool_calls: [{ id: "p", name: "exit_plan_mode", arguments: { plan: "## Plan\n1. do X" } }] },
    { content: "Implemented.", tool_calls: [] },
  ]);
  const { stdin, lastFrame, frames, unmount } = render(<ChatApp fullscreen={false} yolo={false} provider={provider} />);
  const seen = (s: string) => frames.join("\n").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  stdin.write("plan it");
  await tick(20);
  stdin.write("\r");
  expect(await until(() => (lastFrame() ?? "").includes("Ready to code?"))).toBe(true); // plan review box
  expect(lastFrame() ?? "").toContain("do X"); // plan content rendered
  stdin.write("y"); // approve -> proceed
  expect(await until(() => seen("Implemented."))).toBe(true); // agent continued after approval
  unmount();
}, 40000);

test("typing '/' shows a slash-command autocomplete menu", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  stdin.write("/c");
  await tick(60);
  const out = lastFrame() ?? "";
  expect(out).toContain("/cost");
  expect(out).toContain("/clear");
  expect(out).not.toContain("/exit"); // filtered: doesn't start with /c
  unmount();
});

test("/login groups OpenAI first, then offers subscription OAuth or API key", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  stdin.write("/login");
  await tick(30);
  stdin.write("\r");
  expect(await until(() => (lastFrame() ?? "").includes("Sign in - choose a provider"))).toBe(true);
  stdin.write("openai"); // filter the grouped provider list to OpenAI
  await tick(50);
  stdin.write("\r");
  expect(await until(() => (lastFrame() ?? "").includes("OpenAI - choose how to sign in"))).toBe(true);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("ChatGPT Plus/Pro");
  expect(frame).toContain("API key (pay-as-you-go)");
  expect(frame).toContain("subscription, no API billing");
  unmount();
}, 15000);

test("/login groups Google, then separates Gemini account quota from API billing", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  stdin.write("/login"); await tick(30); stdin.write("\r");
  expect(await until(() => (lastFrame() ?? "").includes("Sign in - choose a provider"))).toBe(true);
  stdin.write("google"); await tick(40); stdin.write("\r");
  expect(await until(() => (lastFrame() ?? "").includes("Google - choose how to sign in"))).toBe(true);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Gemini Free/AI Pro/Ultra");
  expect(frame).toContain("Gemini API key (pay-as-you-go)");
  expect(frame).toContain("Google account quota, no API billing");
  unmount();
}, 15000);

test("/model on signed-out Gemini remains useful without starting the CLI", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldGeminiHome = process.env.NEKO_GEMINI_HOME;
  const home = mkdtempSync(join(tmpdir(), "neko-gemini-model-"));
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.NEKO_GEMINI_HOME = home;
  try {
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo profile="gemini" provider={provider} />);
    stdin.write("/model"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Google · Gemini Free/AI Pro/Ultra"))).toBe(true);
    expect(lastFrame() ?? "").toContain("auto");
    unmount();
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldGeminiHome === undefined) delete process.env.NEKO_GEMINI_HOME; else process.env.NEKO_GEMINI_HOME = oldGeminiHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/logout on Gemini removes only Gemini OAuth state immediately", async () => {
  const oldGeminiHome = process.env.NEKO_GEMINI_HOME;
  const home = mkdtempSync(join(tmpdir(), "neko-gemini-logout-"));
  process.env.NEKO_GEMINI_HOME = home;
  const geminiDir = home;
  mkdirSync(geminiDir, { recursive: true });
  writeFileSync(join(geminiDir, "oauth_creds.json"), "{}\n");
  try {
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, frames, unmount } = render(<ChatApp fullscreen={false} yolo profile="gemini" provider={provider} />);
    stdin.write("/logout"); await tick(30); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("Gemini CLI signed out"))).toBe(true);
    expect(existsSync(join(geminiDir, "oauth_creds.json"))).toBe(false);
    expect(frames.join("\n")).toContain("API keys were left untouched");
    unmount();
  } finally {
    if (oldGeminiHome === undefined) delete process.env.NEKO_GEMINI_HOME; else process.env.NEKO_GEMINI_HOME = oldGeminiHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/login offers one-step Gemini Support Pack setup when the bridge is missing", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldPath = process.env.PATH;
  const home = mkdtempSync(join(tmpdir(), "neko-gemini-first-run-"));
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = "";
  try {
    const { clearGeminiCliCache } = await import("../src/adapters/gemini-cli.ts");
    clearGeminiCliCache();
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
    stdin.write("/login"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Sign in - choose a provider"))).toBe(true);
    stdin.write("google"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Google - choose how to sign in"))).toBe(true);
    stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Gemini Support Pack"))).toBe(true);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Install and continue");
    expect(frame).toContain("No admin");
    unmount();
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/support opens a management center and confirms managed-pack removal", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldPath = process.env.PATH;
  const home = mkdtempSync(join(tmpdir(), "neko-support-center-"));
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = "";
  const codexRoot = join(home, ".neko-core", "codex-support");
  const geminiRoot = join(home, ".neko-core", "gemini-support");
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(join(codexRoot, "codex-app-server.exe"), "codex");
  writeFileSync(join(codexRoot, "support-pack.json"), JSON.stringify({
    protocolVersion: "0.144.1", executable: "codex-app-server.exe", installedBytes: 283_537_712,
    releaseTag: "rust-v0.144.1", assetName: "fixture", assetDigest: `sha256:${"1".repeat(64)}`,
    archiveBytes: 1, installedAt: new Date().toISOString(), sourceUrl: "https://github.com/openai/codex/releases",
  }));
  mkdirSync(join(geminiRoot, "gemini"), { recursive: true });
  mkdirSync(join(geminiRoot, "node"), { recursive: true });
  const geminiAuth = join(home, ".neko-core", "gemini-home", "oauth_creds.json");
  mkdirSync(join(home, ".neko-core", "gemini-home"), { recursive: true });
  writeFileSync(geminiAuth, "{}\n");
  writeFileSync(join(geminiRoot, "gemini", "gemini.js"), "gemini");
  writeFileSync(join(geminiRoot, "node", "node.exe"), "node");
  writeFileSync(join(geminiRoot, "support-pack.json"), JSON.stringify({
    protocolVersion: "1", geminiVersion: "0.50.0", nodeVersion: "24.18.0", entry: "gemini/gemini.js", runtime: "node/node.exe",
    installedBytes: 203_630_624, releaseTag: "v0.50.0", bundleAsset: "fixture", bundleDigest: `sha256:${"2".repeat(64)}`,
    bundleArchiveBytes: 1, nodeAsset: "fixture", nodeDigest: `sha256:${"3".repeat(64)}`, nodeArchiveBytes: 1,
    installedAt: new Date().toISOString(), sourceUrl: "https://github.com/google-gemini/gemini-cli/releases", nodeSourceUrl: "https://nodejs.org",
  }));
  try {
    const { clearCodexSupportCache } = await import("../src/adapters/codex-app-server.ts");
    const { clearGeminiCliCache } = await import("../src/adapters/gemini-cli.ts");
    clearCodexSupportCache(); clearGeminiCliCache();
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, frames, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
    stdin.write("/support"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Manage optional support components"))).toBe(true);
    expect(lastFrame() ?? "").toContain("ChatGPT GPT-5.6 Support Pack");
    expect(lastFrame() ?? "").toContain("270.4 MiB");
    stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Manage ChatGPT GPT-5.6 Support Pack"))).toBe(true);
    expect(lastFrame() ?? "").toContain("Remove support pack");
    expect(lastFrame() ?? "").toContain("ChatGPT sign-in stays");
    stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Remove ChatGPT GPT-5.6 Support Pack?"))).toBe(true);
    expect(lastFrame() ?? "").toContain("Keep installed");
    expect(lastFrame() ?? "").toContain("Remove and sign out");
    expect(existsSync(join(codexRoot, "codex-app-server.exe"))).toBe(true);
    stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("freed 270.4 MiB"))).toBe(true);
    expect(existsSync(codexRoot)).toBe(false);
    expect(existsSync(geminiRoot)).toBe(true);
    stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Manage Gemini account Support Pack"))).toBe(true);
    stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Remove Gemini account Support Pack?"))).toBe(true);
    stdin.write("\x1b[B"); await tick(20); stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("Neko also signed this account out"))).toBe(true);
    expect(existsSync(geminiRoot)).toBe(false);
    expect(existsSync(geminiAuth)).toBe(false);
    unmount();
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/voice defaults to conversational browser voice and keeps official/lab routes explicit", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldPath = process.env.PATH;
  const home = mkdtempSync(join(tmpdir(), "neko-voice-ui-"));
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = "";
  const codexRoot = join(home, ".neko-core", "codex-support");
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(join(codexRoot, "codex-app-server.exe"), "codex");
  writeFileSync(join(codexRoot, "support-pack.json"), JSON.stringify({
    protocolVersion: "0.144.1", executable: "codex-app-server.exe", installedBytes: 283_537_712,
  }));
  saveChatGptCredentials({
    accessToken: "header.payload.signature", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, accountId: "acct-ui",
  });
  try {
    const { clearCodexSupportCache } = await import("../src/adapters/codex-app-server.ts");
    clearCodexSupportCache();
    let options!: ChatGptVoiceOptions | BrowserVoiceOptions;
    let snapshot: VoiceSnapshot = { state: "starting", muted: false };
    let stops = 0, muteCalls = 0, failStart = false;
    const control: ChatGptVoiceControl = {
      snapshot: () => snapshot,
      start: async () => {
        if (failStart) throw new Error("dynamic tool name is reserved");
        snapshot = { state: "waiting", muted: false };
        options.onEvent?.({ type: "state", snapshot });
        return { url: "http://127.0.0.1:1/#hidden" };
      },
      setMuted: (muted) => {
        muteCalls++;
        snapshot = { ...snapshot, state: muted ? "muted" : "live", muted };
        options.onEvent?.({ type: "state", snapshot });
      },
      stop: async () => {
        stops++;
        snapshot = { ...snapshot, state: "stopped" };
        options.onEvent?.({ type: "state", snapshot });
      },
    };
    const provider = new MockProvider([{ content: "xin chào từ Neko", tool_calls: [] }]);
    let officialVoiceUrl = "";
    const { stdin, lastFrame, frames, unmount } = render(
      <ChatApp
        fullscreen={false}
        yolo
        profile="chatgpt"
        provider={provider}
        voiceFactory={(next) => { options = next; return control; }}
        browserVoiceFactory={(next) => { options = next; return control; }}
        openUrl={(url) => { officialVoiceUrl = url; }}
      />,
    );
    stdin.write("/voice"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Voice - choose a mode"))).toBe(true);
    expect(lastFrame() ?? "").toContain("Neko Conversational Voice");
    stdin.write("\r");
    const browserStarted = await until(() => /services\s+may\s+process\s+audio\s+online/.test(frames.join("\n")));
    if (!browserStarted) throw new Error(`browser voice did not start:\n${frames.slice(-8).join("\n---\n")}`);
    expect(await (options as BrowserVoiceOptions).onUtterance("xin chào bằng giọng nói")).toBe("xin chào từ Neko");
    expect(await until(() => frames.join("\n").includes("xin chào bằng giọng nói"))).toBe(true);
    stdin.write("/voice stop"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("Neko conversational voice stopped"))).toBe(true);

    stdin.write("/voice"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Voice - choose a mode"))).toBe(true);
    stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => officialVoiceUrl === "https://chatgpt.com/")).toBe(true);
    expect(frames.join("\n")).toContain("runs separately from Neko");

    stdin.write("/voice"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Voice - choose a mode"))).toBe(true);
    stdin.write("\x1b[B"); await tick(20); stdin.write("\x1b[B"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("Voice page opened in your browser"))).toBe(true);
    expect(lastFrame() ?? "").toContain("microphone off - press Start voice in the browser");

    snapshot = { state: "live", muted: false, startedAt: Date.now() };
    options.onEvent?.({ type: "state", snapshot });
    options.onEvent?.({ type: "transcript-delta", role: "user", delta: "xin chao Neko" });
    expect(await until(() => (lastFrame() ?? "").includes("● LIVE"))).toBe(true);
    expect(lastFrame() ?? "").toContain("> xin chao Neko");
    options.onEvent?.({ type: "transcript-done", role: "user", text: "xin chao Neko" });
    expect(await until(() => frames.join("\n").includes("xin chao Neko"))).toBe(true);

    stdin.write("/voice mute"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("muted"))).toBe(true);
    expect(muteCalls).toBe(1);
    stdin.write("/voice stop"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("microphone released"))).toBe(true);
    expect(stops).toBe(2);
    failStart = true;
    stdin.write("/voice start"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("dynamic tool name is reserved"))).toBe(true);
    expect(lastFrame() ?? "").not.toContain("VOICE  ·  starting");
    expect(stops).toBe(3); // a failed startup is torn down instead of leaving stale UI state
    failStart = false;
    stdin.write("/voice start"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("microphone off - press Start voice"))).toBe(true);
    stdin.write("/logout"); await tick(20); stdin.write("\r");
    expect(await until(() => frames.join("\n").includes("OpenAI API keys were left untouched"))).toBe(true);
    expect(stops).toBe(4); // logout releases microphone before deleting the ChatGPT session
    unmount();
  } finally {
    const { clearCodexSupportCache } = await import("../src/adapters/codex-app-server.ts");
    clearCodexSupportCache();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/support status keeps a copyable text report for diagnostics", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, frames, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  stdin.write("/support status"); await tick(30); stdin.write("\r");
  expect(await until(() => frames.join("\n").includes("ChatGPT GPT-5.6 support:"))).toBe(true);
  expect(frames.join("\n")).toContain("Gemini account support:");
  unmount();
}, 15000);

test("/usage keeps Gemini quota guidance inside Neko", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, frames, unmount } = render(<ChatApp fullscreen={false} yolo profile="gemini" provider={provider} />);
  stdin.write("/usage"); await tick(30); stdin.write("\r");
  expect(await until(() => frames.join("\n").includes("Google does not expose remaining requests"))).toBe(true);
  expect(frames.join("\n")).not.toContain("/stats model");
  unmount();
}, 15000);

test("OpenAI API login is profile-scoped and /logout takes effect immediately", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const oldNekoKey = process.env.NEKO_API_KEY, oldOpenAiKey = process.env.OPENAI_API_KEY;
  const home = mkdtempSync(join(tmpdir(), "neko-api-login-"));
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.NEKO_API_KEY; delete process.env.OPENAI_API_KEY;
  try {
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, frames, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
    stdin.write("/login"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Sign in - choose a provider"))).toBe(true);
    stdin.write("openai"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("OpenAI - choose how to sign in"))).toBe(true);
    stdin.write("\x1b[B"); // ChatGPT is first; choose the API-key route
    await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("paste the API key"))).toBe(true);
    stdin.write("TEST-KEY-NOT-REAL"); await tick(20); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("profile \"openai\""))).toBe(true);
    const configPath = join(home, ".neko-core", "config.json");
    expect(JSON.parse(readFileSync(configPath, "utf8")).profiles.openai.api_key).toBe("TEST-KEY-NOT-REAL");
    expect(process.env.NEKO_API_KEY).toBeUndefined(); // no cross-provider process-wide override
    expect(frames.join("\n")).not.toContain("TEST-KEY-NOT-REAL"); // secret never echoed

    await tick(100); // let the masked-key capture fully hand focus back to the normal composer
    stdin.write("/logout"); await tick(30); stdin.write("\r");
    expect(await until(() => /other\s+provider keys were left untouched/.test(frames.join("\n")))).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8")).profiles.openai.api_key).toBeUndefined();
    unmount();
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    if (oldNekoKey === undefined) delete process.env.NEKO_API_KEY; else process.env.NEKO_API_KEY = oldNekoKey;
    if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAiKey;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/model on ChatGPT lists only completion-usable subscription models while signed out", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "neko-model-picker-"));
  process.env.HOME = home; process.env.USERPROFILE = home; // guarantee no credential -> no network
  try {
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo profile="chatgpt" provider={provider} />);
    stdin.write("/model");
    await tick(30);
    stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("OpenAI · ChatGPT Plus/Pro"))).toBe(true);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("gpt-5.6-sol");
    expect(frame).not.toContain("gpt-5.6-terra");
    expect(frame).not.toContain("gpt-5.6-luna");
    expect(frame).toContain("gpt-5.4");
    expect(frame).toContain("gpt-5.5");
    unmount();
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/usage shows ChatGPT subscription windows and credits without making a model call", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "neko-usage-"));
  process.env.HOME = home; process.env.USERPROFILE = home;
  saveChatGptCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, accountId: "acct" });
  let requested = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return Response.json({ plan_type: "pro", rate_limit: { allowed: false, limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 2000 },
      secondary_window: { used_percent: 29, limit_window_seconds: 604800, reset_at: 9000 } },
      credits: { has_credits: false, unlimited: false, balance: "0" } });
  }) as typeof fetch;
  try {
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo profile="chatgpt" provider={provider} />);
    stdin.write("/usage"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("ChatGPT usage (pro)"))).toBe(true);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5h: 100% used, 0% left");
    expect(frame).toContain("7d: 29% used, 71% left");
    expect(frame).toContain("credits: none");
    expect(requested).toBe("https://chatgpt.com/backend-api/wham/usage");
    unmount();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("/effort uses the selected compatible model catalog", async () => {
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "neko-effort-"));
  process.env.HOME = home; process.env.USERPROFILE = home;
  saveChatGptCredentials({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, accountId: "acct" });
  setModel("gpt-5.5", "chatgpt");
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ models: [{
    slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", default_reasoning_level: "medium", use_responses_lite: false,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort, description: `${effort} level` })),
  }] })) as typeof fetch;
  try {
    const provider = new MockProvider([{ content: "", tool_calls: [] }]);
    const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo profile="chatgpt" provider={provider} />);
    stdin.write("/effort"); await tick(30); stdin.write("\r");
    expect(await until(() => (lastFrame() ?? "").includes("Reasoning effort for gpt-5.5"))).toBe(true);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("default");
    expect(frame).toContain("xhigh");
    expect(frame).not.toContain("max");
    expect(frame).not.toContain("ultra");
    unmount();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

test("input typed while busy is queued, then drained", async () => {
  // First turn takes a moment; a second submit during it should queue.
  class SlowMock implements Provider {
    i = 0;
    async complete(): Promise<ProviderResponse> {
      this.i++;
      if (this.i === 1) {
        // Hold turn 1 busy for a wide window: the test must observe "busy" and submit task two WHILE the
        // first turn is still running. A tight 250ms window can close under a load spike before the second
        // submit lands, so task two runs immediately instead of queuing (the flake). 1500ms is ample.
        await new Promise((r) => setTimeout(r, 1500));
        return { content: "first", tool_calls: [] };
      }
      return { content: "second", tool_calls: [] };
    }
  }
  const { stdin, frames, unmount } = render(<ChatApp fullscreen={false} yolo provider={new SlowMock()} />);
  const seen = (s: string) => frames.join("\n").replace(/\x1b\[[0-9;]*m/g, "").includes(s);
  const until = async (pred: () => boolean, ms = 2500) => { for (let w = 0; w < ms && !pred(); w += 20) await tick(20); return pred(); };

  stdin.write("task one");
  await tick(20);
  stdin.write("\r");
  expect(await until(() => seen("esc to interrupt"))).toBe(true); // turn 1 is in flight (busy) — deterministic
  stdin.write("task two");
  await tick(20);
  stdin.write("\r"); // submitted while busy -> must queue
  expect(await until(() => seen("queued:"))).toBe(true); // queue indicator appeared
  expect(await until(() => seen("second"))).toBe(true); // queued task drained + ran after the first
  unmount();
}, 15000); // generous wall-clock: three poll-loops can be slow when the machine is under heavy load

test("ApprovalBox shows an edit diff preview", () => {
  const approval = { toolName: "edit", args: { path: "a.ts", old_string: "const x = 1", new_string: "const x = 2" }, resolve: () => {} };
  const { lastFrame, unmount } = render(<ApprovalBox approval={approval} />);
  const out = lastFrame() ?? "";
  expect(out).toContain("Approve edit?");
  expect(out).toContain("- const x = 1");
  expect(out).toContain("+ const x = 2");
  unmount();
});

test("slash menu: Enter completes a PARTIAL command to the highlighted match and runs it", async () => {
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { stdin, lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} />);
  await tick();
  stdin.write("/hel"); // partial - the menu highlights /help
  await tick();
  expect(lastFrame() ?? "").toContain("up/down to select, tab to complete"); // menu open on the partial
  stdin.write("\r"); // Enter: before the fix this submitted the raw "/hel" (unknown); now it runs /help
  await tick(120);
  const out = (lastFrame() ?? "");
  expect(out).not.toContain("up/down to select"); // menu closed - a command ran
  // /help prints the help text; its header line proves the completed command executed, not "/hel".
  expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/help|commands|\/model|\/resume/i);
  unmount();
}, 15000);

test("recoverTodos: rebuilds the todo tracker from the last todo_write in saved messages", () => {
  const msgs = [
    { role: "user", content: "build X" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }) } }] },
    { role: "tool", tool_call_id: "1", content: "Update Todos" },
    // a LATER todo_write supersedes the earlier one
    { role: "assistant", content: "", tool_calls: [{ function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] }) } }] },
  ];
  const todos = recoverTodos(msgs);
  expect(todos.length).toBe(3); // the LATEST plan
  expect(todos.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
  expect(recoverTodos([{ role: "user", content: "no todos here" }])).toEqual([]); // none -> empty
});

test("resumed session: ctx% reflects loaded context (not a misleading 0%) + display is bounded", async () => {
  const msgs: any[] = [{ role: "system", content: "s".repeat(4000) }];
  for (let i = 0; i < 90; i++) {
    msgs.push({ role: "user", content: "task " + i });
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: "c" + i, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "f" + i, content: "x".repeat(300) }) } }] });
    msgs.push({ role: "tool", tool_call_id: "c" + i, content: "Wrote f" + i });
  }
  const sess = { id: "s-long", createdAt: "", updatedAt: new Date().toISOString(), cwd: process.cwd(), model: "glm-5.2", messages: msgs };
  const provider = new MockProvider([{ content: "", tool_calls: [] }]);
  const { lastFrame, unmount } = render(<ChatApp fullscreen={false} yolo provider={provider} resumedSession={sess as any} sessionId="s-long" />);
  await tick(120);
  const f = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const pct = Number(f.match(/(\d+)% ctx/)?.[1] ?? "0");
  expect(pct).toBeGreaterThan(0); // estimated from the loaded messages, not 0 before the first API call
  expect(f).toMatch(/earlier line.*in context.*\/transcript/); // display bounded, rest in context + how to view it all
  unmount();
}, 15000);
