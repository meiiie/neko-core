import { expect, test } from "bun:test";

import { startRemoteControl } from "../src/adapters/remote-control.ts";

test("remote control: token-gated message round-trip, loopback only", async () => {
  const rc = startRemoteControl(async (m) => `echo: ${m}`, 4601);
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(rc.url).toContain("127.0.0.1");

    const bad = await fetch(`${rc.url}/message?token=wrong`, { method: "POST", body: '{"message":"hi"}' });
    expect(bad.status).toBe(403);

    const ok = await fetch(`${rc.url}/message?token=${rc.token}`, { method: "POST", body: '{"message":"hello"}' });
    expect((await ok.json()).reply).toBe("echo: hello");
  } finally {
    rc.stop();
  }
});
