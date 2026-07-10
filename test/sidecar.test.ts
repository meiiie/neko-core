import { expect, test } from "bun:test";

import { dockerAvailable, SearxngSidecar, type Exec } from "../src/adapters/sidecar.ts";

/** A scriptable docker CLI: state -> inspect answer; records every call. */
function fakeExec(world: { state: string; startFails?: boolean }): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "inspect") return world.state ? { status: 0, stdout: world.state + "\n", stderr: "" } : { status: 1, stdout: "", stderr: "no such container" };
    if (args[0] === "start") {
      if (world.startFails) return { status: 1, stdout: "", stderr: "cannot start" };
      world.state = "running";
      return { status: 0, stdout: "neko-searxng", stderr: "" };
    }
    if (args[0] === "stop") { world.state = "exited"; return { status: 0, stdout: "", stderr: "" }; }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const fastOpts = { pollMs: 1, pollTries: 3 };

test("ensureUp wakes a stopped managed container and health-polls it (caller retries once)", async () => {
  const { exec, calls } = fakeExec({ state: "exited" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 0 });
  const r = await s.ensureUp("http://localhost:8888");
  expect(r.ok).toBe(true);
  expect(calls.some((c) => c[1] === "start")).toBe(true);
});

test("ensureUp is honest and FAST when there is no daemon/container (search never blocks on infra)", async () => {
  const { exec, calls } = fakeExec({ state: "" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true });
  const r = await s.ensureUp("http://localhost:8888");
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/daemon unreachable|no managed container/);
  expect(calls.some((c) => c[1] === "start")).toBe(false); // never tries to start what it can't see
});

test("ensureUp never restarts a container that is ALREADY running (the failure is elsewhere)", async () => {
  const { exec, calls } = fakeExec({ state: "running" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true });
  const r = await s.ensureUp("http://localhost:8888");
  expect(r.ok).toBe(false);
  expect(calls.some((c) => c[1] === "start")).toBe(false);
});

test("only ONE wake attempt per process - a dead daemon must not tax every later search", async () => {
  const { exec, calls } = fakeExec({ state: "" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true });
  await s.ensureUp("http://x");
  const before = calls.length;
  await s.ensureUp("http://x");
  expect(calls.length).toBe(before); // second call did not touch docker at all
});

test("idle keepalive stops a container WE started - and only then", async () => {
  const world = { state: "exited" };
  const { exec, calls } = fakeExec(world);
  // keepaliveMin is minutes; use a tiny fraction (0.0005min = 30ms) to observe expiry.
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 0.0005 });
  const r = await s.ensureUp("http://x");
  expect(r.ok).toBe(true); // ensureUp arms the timer via touch()
  await new Promise((res) => setTimeout(res, 80));
  expect(calls.some((c) => c[1] === "stop")).toBe(true);
  expect(world.state).toBe("exited");
  expect(s.stops).toBe(1);
});

test("touch never arms auto-stop for a container Neko did NOT start (user's container is sacred)", async () => {
  const { exec, calls } = fakeExec({ state: "running" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 0.0005 });
  s.touch(); // healthy searches against a user-run container
  await new Promise((res) => setTimeout(res, 60));
  expect(calls.some((c) => c[1] === "stop")).toBe(false);
  expect(s.stops).toBe(0);
});

test("keepalive 0 = keep running: no auto-stop after a wake", async () => {
  const { exec, calls } = fakeExec({ state: "exited" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 0 });
  expect((await s.ensureUp("http://x")).ok).toBe(true);
  await new Promise((res) => setTimeout(res, 60));
  expect(calls.some((c) => c[1] === "stop")).toBe(false);
});

test("a failing docker start reports the reason instead of pretending", async () => {
  const { exec } = fakeExec({ state: "exited", startFails: true });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true });
  const r = await s.ensureUp("http://x");
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("docker start failed");
});

test("a wake whose health probe never comes up is a clean failure (fall through the ladder)", async () => {
  const { exec } = fakeExec({ state: "exited" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => false });
  const r = await s.ensureUp("http://x");
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("did not come up");
});

test("describe reports the managed lifecycle state for doctor", async () => {
  const world = { state: "exited" };
  const { exec } = fakeExec(world);
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 15 });
  expect(s.describe()).toContain("starts on demand");
  await s.ensureUp("http://x");
  expect(s.describe()).toContain("stops after 15m idle");
  expect(new SearxngSidecar({ exec: fakeExec({ state: "" }).exec }).describe()).toBe("");
});

test("dockerAvailable is a fast boolean probe", () => {
  expect(dockerAvailable(((_c: string, _a: string[]) => ({ status: 0, stdout: "27.0", stderr: "" })) as Exec)).toBe(true);
  expect(dockerAvailable(((_c: string, _a: string[]) => ({ status: null, stdout: "", stderr: "not found" })) as Exec)).toBe(false);
});

test("a wake registers a process-exit cleanup (a short-lived run must not leak a running container)", async () => {
  const before = process.listeners("exit").length;
  const { exec } = fakeExec({ state: "exited" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 15 });
  await s.ensureUp("http://x");
  expect(process.listeners("exit").length).toBe(before + 1);
  s.stopNow(); // idempotent: the exit hook firing later is a no-op after this
  expect(s.stops).toBe(1);
});

test("keepalive 0 (keep running) registers NO exit cleanup - the user asked for always-on", async () => {
  const before = process.listeners("exit").length;
  const { exec } = fakeExec({ state: "exited" });
  const s = new SearxngSidecar({ ...fastOpts, exec, probe: async () => true, keepaliveMin: 0 });
  await s.ensureUp("http://x");
  expect(process.listeners("exit").length).toBe(before);
});
