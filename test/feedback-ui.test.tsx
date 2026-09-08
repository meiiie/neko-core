import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatApp } from "../src/ui/chat.tsx";
import { FEEDBACK_ENDPOINT } from "../src/adapters/feedback-delivery.ts";

test("feedback takes two screens, keeps notes editable, and previews data without calling the model", async () => {
  const taskHome = mkdtempSync(join(tmpdir(), "neko-feedback-ui-"));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = Object.assign(async (url: string | URL | Request) => {
    if (String(url) === FEEDBACK_ENDPOINT) uploads++;
    throw new Error("Network disabled in feedback UI test");
  }, { preconnect: originalFetch.preconnect });
  process.env.HOME = taskHome;
  process.env.USERPROFILE = taskHome;
  let calls = 0;
  const app = render(<ChatApp yolo={true} sessionId="feedback-ui" provider={{ complete: async () => { calls++; return { content: "should not run", tool_calls: [] }; } }} />);
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 5000;
    while (!app.lastFrame()?.includes(text) && Date.now() < deadline) await Bun.sleep(20);
    expect(app.lastFrame()).toContain(text);
  };
  const enter = async () => { app.stdin.write("\r"); await Bun.sleep(50); };
  try {
    await waitFor("/help");
    app.stdin.write("/feedback");
    await enter();
    await waitFor("Feedback 1/2");
    app.stdin.write("Lỗi kết nối riêng tư");
    await enter();
    await waitFor("Feedback 2/2");
    expect(app.lastFrame()).toContain("conversation OFF");
    expect(app.lastFrame()).toContain("Send feedback");
    for (let i = 0; i < 3; i++) { app.stdin.write("\x1b[B"); await Bun.sleep(20); }
    await waitFor("> Edit description");
    await enter();
    await waitFor("Feedback 1/2");
    expect(app.lastFrame()).toContain("Lỗi kết nối riêng tư");
    await enter(); await waitFor("Feedback 2/2");
    for (let i = 0; i < 2; i++) { app.stdin.write("\x1b[B"); await Bun.sleep(20); }
    await waitFor("> View data"); await enter();
    await waitFor("Feedback attachment");
    expect(app.lastFrame()).toContain("Lỗi kết nối riêng tư");
    app.stdin.write("\x1b");
    await waitFor("Feedback 2/2");
    app.stdin.write("\x1b");
    await waitFor("/help");
    expect(calls).toBe(0);
    expect(uploads).toBe(0);
  } finally {
    app.unmount();
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
    rmSync(taskHome, { recursive: true, force: true });
  }
});

for (const cancel of ["escape", "ctrl-c", "unmount"] as const) {
  test(`feedback confirmation sends once and ${cancel} cancels waiting without resending or calling the model`, async () => {
    const taskHome = mkdtempSync(join(tmpdir(), "neko-feedback-cancel-"));
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    const originalFetch = globalThis.fetch;
    process.env.HOME = taskHome;
    process.env.USERPROFILE = taskHome;
    let calls = 0;
    let uploads = 0;
    let uploaded = "";
    let aborted = false;
    globalThis.fetch = Object.assign((url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe(FEEDBACK_ENDPOINT);
      uploads++;
      uploaded = String(init?.body);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(new Error("cancelled")); };
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }, { preconnect: originalFetch.preconnect });
    const app = render(<ChatApp yolo={true} sessionId={`feedback-${cancel}`} provider={{ complete: async () => { calls++; return { content: "should not run", tool_calls: [] }; } }} />);
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 5000;
      while (!app.lastFrame()?.includes(text) && Date.now() < deadline) await Bun.sleep(20);
      expect(app.lastFrame()).toContain(text);
    };
    const enter = async () => { app.stdin.write("\r"); await Bun.sleep(50); };
    try {
      await waitFor("/help");
      app.stdin.write("/feedback"); await enter();
      await waitFor("Feedback 1/2");
      app.stdin.write("Synthetic cancellation report"); await enter();
      await waitFor("Feedback 2/2");
      expect(app.lastFrame()).toContain("conversation OFF");
      expect(uploads).toBe(0);
      await enter();
      await waitFor("Sending reviewed feedback");
      expect(uploads).toBe(1);
      const files = readdirSync(join(taskHome, ".neko-core", "feedback"));
      expect(files).toHaveLength(1);
      const saved = JSON.parse(readFileSync(join(taskHome, ".neko-core", "feedback", files[0]), "utf8"));
      expect(saved).toEqual(JSON.parse(uploaded));
      expect(saved.notes).toBe("Synthetic cancellation report");
      expect(saved.sessionLog).toBeUndefined();
      if (cancel !== "unmount") {
        app.stdin.write("/help"); await enter(); await waitFor("queued: /help");
      }
      if (cancel === "unmount") app.unmount(); else app.stdin.write(cancel === "escape" ? "\x1b" : "\x03");
      if (cancel !== "unmount") {
        await waitFor("Feedback delivery is unconfirmed");
        await waitFor("Input: @path adds a file");
      }
      for (let i = 0; i < 50 && !aborted; i++) await Bun.sleep(20);
      expect(aborted).toBe(true);
      expect(uploads).toBe(1);
      expect(calls).toBe(0);
    } finally {
      app.unmount();
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
      rmSync(taskHome, { recursive: true, force: true });
    }
  });
}
