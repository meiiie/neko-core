import { afterEach, expect, test } from "bun:test";

import { BrowserVoiceSession } from "../src/adapters/browser-voice.ts";
import { VoiceInteractionPolicy } from "../src/adapters/voice-interaction.ts";

let active: BrowserVoiceSession | null = null;

afterEach(async () => {
  await active?.stop("test cleanup");
  active = null;
});

function messageQueue(ws: WebSocket): () => Promise<any> {
  const queued: any[] = [];
  const waiters: Array<(message: any) => void> = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) waiter(message); else queued.push(message);
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiters.push(resolve));
}

test("browser voice keeps consent in the page and routes transcript through Neko", async () => {
  let opened = "";
  let now = 1_000;
  let interrupted = 0;
  active = new BrowserVoiceSession({
    openUrl: (url) => { opened = url; },
    now: () => now,
    policy: new VoiceInteractionPolicy({ minSpeechMs: 0, cooldownMs: 1_000 }),
    onInterrupt: () => { interrupted++; },
    onUtterance: async (text) => `Neko heard: ${text}`,
  });
  const { url } = await active.start();
  expect(url).toBe(opened);
  const parsed = new URL(url);
  const token = parsed.hash.slice(1);
  const page = await fetch(parsed.origin);
  const html = await page.text();
  expect(html).toContain("Conversational Voice - Browser Preview");
  expect(html).toContain("may use its online service");
  expect(html).not.toContain(token);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(() => new Function(html.match(/<script>([\s\S]+)<\/script>/)?.[1] ?? "")).not.toThrow();

  const ws = new WebSocket(`${parsed.origin.replace("http:", "ws:")}/bridge`, { headers: { origin: parsed.origin } } as any);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const nextMessage = messageQueue(ws);
  ws.send(JSON.stringify({ type: "hello", token }));
  expect(await nextMessage()).toEqual({ type: "ready" });
  ws.send(JSON.stringify({ type: "live" }));
  ws.send(JSON.stringify({ type: "speech-start" }));
  now = 1_100;
  ws.send(JSON.stringify({ type: "partial", text: "mình đang kể một câu chuyện đủ dài" }));
  expect(await nextMessage()).toEqual({ type: "backchannel", text: "ừm" });

  ws.send(JSON.stringify({ type: "utterance", text: "xin chào neko" }));
  expect(await nextMessage()).toEqual({ type: "thinking" });
  expect(await nextMessage()).toEqual({ type: "response", text: "Neko heard: xin chào neko" });
  ws.send(JSON.stringify({ type: "speech-start" }));
  expect(await nextMessage()).toEqual({ type: "cancel-speech" });
  expect(interrupted).toBe(1);
  ws.close();
});

test("browser voice survives a control-socket drop and accepts a reconnect", async () => {
  let now = 1_000;
  active = new BrowserVoiceSession({ onUtterance: async (text) => `ok: ${text}`, openUrl: () => {}, now: () => now });
  const { url } = await active.start();
  const parsed = new URL(url);
  const token = parsed.hash.slice(1);
  const open = async () => {
    const ws = new WebSocket(`${parsed.origin.replace("http:", "ws:")}/bridge`, { headers: { origin: parsed.origin } } as any);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return ws;
  };

  const first = await open();
  const firstMessages = messageQueue(first);
  first.send(JSON.stringify({ type: "hello", token }));
  expect(await firstMessages()).toEqual({ type: "ready" });
  first.send(JSON.stringify({ type: "live" }));
  await Bun.sleep(10);
  expect(active.snapshot().state).toBe("live");

  // A throttled/blipped control socket must not end the session (this used to stop immediately).
  first.close();
  await Bun.sleep(20);
  expect(active.snapshot().state).toBe("live");

  const second = await open();
  const secondMessages = messageQueue(second);
  second.send(JSON.stringify({ type: "hello", token }));
  expect(await secondMessages()).toEqual({ type: "ready" });
  second.send(JSON.stringify({ type: "live" }));
  second.send(JSON.stringify({ type: "utterance", text: "vẫn nghe" }));
  expect(await secondMessages()).toEqual({ type: "thinking" });
  expect(await secondMessages()).toEqual({ type: "response", text: "ok: vẫn nghe" });

  // An explicit page Stop still ends the session at once - consent is unchanged.
  second.send(JSON.stringify({ type: "stop" }));
  await Bun.sleep(20);
  expect(active.snapshot().state).toBe("stopped");
  second.close();
});

test("browser voice rejects a websocket without the fragment capability", async () => {
  active = new BrowserVoiceSession({ onUtterance: async () => "ok", openUrl: () => {} });
  const { url } = await active.start();
  const parsed = new URL(url);
  const ws = new WebSocket(`${parsed.origin.replace("http:", "ws:")}/bridge`, { headers: { origin: parsed.origin } } as any);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.send(JSON.stringify({ type: "hello", token: "wrong" }));
  const code = await new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
  expect(code).toBe(1008);
});
