import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type RemoteHandlers, startRemoteControl } from "../src/adapters/remote-control.ts";

// The server writes a discovery file under ~/.neko-core; isolate HOME so tests don't touch the real one.
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  const tmp = mkdtempSync(join(tmpdir(), "nk-rc-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
});
afterAll(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

function handlers(run: RemoteHandlers["run"], extra: Partial<RemoteHandlers> = {}): RemoteHandlers {
  return { run, status: () => ({ busy: false, model: "m", messages: 0 }), interrupt: () => true, ...extra };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("Bearer-gated round-trip, loopback only; bad token -> 401", async () => {
  const rc = await startRemoteControl(handlers(async (m) => ({ reply: `echo: ${m}` })), 4601);
  try {
    expect(rc.url).toContain("127.0.0.1");
    const bad = await fetch(`${rc.url}/message`, { method: "POST", headers: bearer("wrong"), body: '{"message":"hi"}' });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${rc.url}/message`, { method: "POST", headers: bearer(rc.token), body: '{"message":"hello"}' });
    expect((await ok.json()).reply).toBe("echo: hello");
  } finally { rc.stop(); }
});

test("token in the URL is NOT accepted (must be the Authorization header)", async () => {
  const rc = await startRemoteControl(handlers(async (m) => ({ reply: m })), 4602);
  try {
    const res = await fetch(`${rc.url}/message?token=${rc.token}`, { method: "POST", body: '{"message":"hi"}' });
    expect(res.status).toBe(401);
  } finally { rc.stop(); }
});

test("GET /status reports busy/model/messages", async () => {
  const rc = await startRemoteControl(handlers(async (m) => ({ reply: m }), { status: () => ({ busy: true, model: "gpt-oss", messages: 5 }) }), 4603);
  try {
    const s = await (await fetch(`${rc.url}/status`, { headers: bearer(rc.token) })).json();
    expect(s.busy).toBe(true);
    expect(s.model).toBe("gpt-oss");
    expect(s.messages).toBe(5);
  } finally { rc.stop(); }
});

test("POST /interrupt invokes the interrupt handler", async () => {
  let called = false;
  const rc = await startRemoteControl(handlers(async (m) => ({ reply: m }), { interrupt: () => { called = true; return true; } }), 4604);
  try {
    const r = await (await fetch(`${rc.url}/interrupt`, { method: "POST", headers: bearer(rc.token) })).json();
    expect(r.interrupted).toBe(true);
    expect(called).toBe(true);
  } finally { rc.stop(); }
});

test("SSE streaming: delta events then a done event with the final result", async () => {
  const rc = await startRemoteControl(handlers(async (_m, onDelta) => { onDelta?.("Hel"); onDelta?.("lo"); return { reply: "Hello", tokens: 2 }; }), 4605);
  try {
    const res = await fetch(`${rc.url}/message`, { method: "POST", headers: { ...bearer(rc.token), Accept: "text/event-stream" }, body: '{"message":"hi"}' });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('data: {"delta":"Hel"}');
    expect(text).toContain('data: {"delta":"lo"}');
    expect(text).toContain("event: done");
    expect(text).toContain('"reply":"Hello"');
  } finally { rc.stop(); }
});

test("body over the 1 MB cap -> 413", async () => {
  const rc = await startRemoteControl(handlers(async (m) => ({ reply: m })), 4606);
  try {
    const res = await fetch(`${rc.url}/message`, { method: "POST", headers: bearer(rc.token), body: JSON.stringify({ message: "x".repeat(1_100_000) }) });
    expect(res.status).toBe(413);
  } finally { rc.stop(); }
});

test("hops to a free port when one is busy (no crash)", async () => {
  const a = await startRemoteControl(handlers(async (m) => ({ reply: m })), 4611);
  try {
    const b = await startRemoteControl(handlers(async (m) => ({ reply: m })), 4611);
    try { expect(a.url).not.toBe(b.url); } finally { b.stop(); }
  } finally { a.stop(); }
});

test("concurrent messages are serialized - no overlapping turns", async () => {
  let active = 0;
  let maxActive = 0;
  const rc = await startRemoteControl(handlers(async (m) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 150));
    active--;
    return { reply: `ok:${m}` };
  }), 4631);
  try {
    const [a, b] = await Promise.all([
      fetch(`${rc.url}/message`, { method: "POST", headers: bearer(rc.token), body: '{"message":"1"}' }),
      fetch(`${rc.url}/message`, { method: "POST", headers: bearer(rc.token), body: '{"message":"2"}' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(maxActive).toBe(1);
  } finally { rc.stop(); }
});

test("a handler error returns 500 instead of hanging the client", async () => {
  const rc = await startRemoteControl(handlers(async () => { throw new Error("boom"); }), 4621);
  try {
    const res = await fetch(`${rc.url}/message`, { method: "POST", headers: bearer(rc.token), body: '{"message":"x"}' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("boom");
  } finally { rc.stop(); }
});
