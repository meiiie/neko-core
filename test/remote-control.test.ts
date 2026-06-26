import { expect, test } from "bun:test";

import { startRemoteControl } from "../src/adapters/remote-control.ts";

test("remote control: token-gated message round-trip, loopback only", async () => {
  const rc = await startRemoteControl(async (m) => `echo: ${m}`, 4601);
  try {
    expect(rc.url).toContain("127.0.0.1");

    const bad = await fetch(`${rc.url}/message?token=wrong`, { method: "POST", body: '{"message":"hi"}' });
    expect(bad.status).toBe(403);

    const ok = await fetch(`${rc.url}/message?token=${rc.token}`, { method: "POST", body: '{"message":"hello"}' });
    expect((await ok.json()).reply).toBe("echo: hello");
  } finally {
    rc.stop();
  }
});

test("remote control: hops to a free port when one is busy (no crash)", async () => {
  const a = await startRemoteControl(async (m) => m, 4611);
  try {
    const b = await startRemoteControl(async (m) => m, 4611); // same port -> must hop, not throw
    try {
      expect(a.url).not.toBe(b.url); // bound to a different, free port
    } finally {
      b.stop();
    }
  } finally {
    a.stop();
  }
});

test("remote control: concurrent messages are serialized - no overlapping turns", async () => {
  let active = 0;
  let maxActive = 0;
  const rc = await startRemoteControl(async (m) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 150));
    active--;
    return `ok:${m}`;
  }, 4631);
  try {
    const [a, b] = await Promise.all([
      fetch(`${rc.url}/message?token=${rc.token}`, { method: "POST", body: '{"message":"1"}' }),
      fetch(`${rc.url}/message?token=${rc.token}`, { method: "POST", body: '{"message":"2"}' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]); // one ran, the other was rejected as busy
    expect(maxActive).toBe(1); // the agent never ran two turns at once
  } finally {
    rc.stop();
  }
});

test("remote control: an agent error returns 500 instead of hanging the client", async () => {
  const rc = await startRemoteControl(async () => { throw new Error("boom"); }, 4621);
  try {
    const res = await fetch(`${rc.url}/message?token=${rc.token}`, { method: "POST", body: '{"message":"x"}' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("boom");
  } finally {
    rc.stop();
  }
});
