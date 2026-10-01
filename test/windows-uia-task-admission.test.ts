import { expect, test } from "bun:test";

import { COMPUTER_INPUT_POLICY_CAPABILITY, ComputerInputPolicyCapabilityError, computerNeedsInteraction, type ComputerInputPolicy } from "../src/core/computer-input-policy.ts";
import { ResidentUiaAdmissionError, ResidentUiaHost } from "../src/core/windows-uia-host.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeHost(options: { onStart?: () => void; onPing?: (id: number) => void; capability?: string } = {}) {
  const host = new ResidentUiaHost("never-executed-by-task-admission-fake");
  const writes: { id: number; action: string; inputPolicy?: string }[] = [];
  let starts = 0;
  const reply = (id: number, output = "synthetic action") => {
    host["onLine"](JSON.stringify({ id, ok: true, output }));
  };
  const child = {
    killed: false, exitCode: null, signalCode: null,
    stdin: {
      write(payload: string, _encoding: string, done: (error?: Error) => void) {
        // SAFETY: the product's JSON payload is captured by a test-only stdin object.
        const request = JSON.parse(payload) as { id: number; action: string; inputPolicy?: string };
        writes.push(request);
        if (request.action === "ping" && options.onPing) options.onPing(request.id);
        else reply(request.id, request.action === "ping"
          ? options.capability ?? COMPUTER_INPUT_POLICY_CAPABILITY : "synthetic action");
        done();
        return true;
      },
    },
  };
  // Both process edges are test-owned; no native child, UIA, desktop or stdin exists.
  Reflect.set(host, "child", child);
  Reflect.set(host, "ensureChild", () => { starts++; options.onStart?.(); return child; });
  return { host, writes, reply, get starts() { return starts; },
    pendingCount: () => host["pending"].size };
}

test("retirement while queued blocks resident process startup and action writes", async () => {
  const f = fakeHost();
  const queue = deferred<void>();
  Reflect.set(f.host, "queue", queue.promise);
  let retired = false;
  const pending = f.host.request({ action: "invoke", name: "control" }, 1_000, undefined,
    () => { if (retired) throw new Error("Task activation is retired"); });
  retired = true;
  queue.resolve();
  await expect(pending).rejects.toMatchObject({ name: "ResidentUiaAdmissionError", message: "Task activation is retired" });
  expect(f.starts).toBe(0);
  expect(f.writes).toEqual([]);
});

test("queued caller mutation cannot bypass the captured action's helper capability check", async () => {
  const f = fakeHost({ capability: "legacy helper ready" });
  const queue = deferred<void>();
  Reflect.set(f.host, "queue", queue.promise);
  const request = { action: "invoke", name: "control" };
  const pending = f.host.request(request, 1_000, undefined, () => {});
  request.action = "ping";
  queue.resolve();
  const failure = await pending.then(() => undefined, (error: Error) => error);
  expect(f.writes.map((written) => written.action)).toEqual(["ping"]);
  expect(failure).toBeInstanceOf(ComputerInputPolicyCapabilityError);
  expect(f.pendingCount()).toBe(0);
});

test("input policy drift during teardown is rechecked before a foreground action", async () => {
  const f = fakeHost();
  const teardown = deferred<void>();
  const entered = deferred<void>();
  const barrier = { then(done: () => void) { entered.resolve(); return teardown.promise.then(done); } };
  Reflect.set(f.host, "teardown", barrier);
  let policy: ComputerInputPolicy = "foreground";
  const pending = f.host.request({ action: "type", text: "never typed", inputPolicy: "foreground" }, 1_000, undefined,
    () => { const refusal = computerNeedsInteraction("type", policy); if (refusal) throw new Error(refusal); });
  await entered.promise;
  policy = "background";
  teardown.resolve();
  await expect(pending).rejects.toMatchObject({ name: "ResidentUiaAdmissionError" });
  await expect(pending).rejects.toThrow("needs_interaction:");
  expect(f.starts).toBe(0);
  expect(f.writes).toEqual([]);
});

test("retirement during capability handshake permits ping but never the semantic action", async () => {
  const ping = deferred<number>();
  const f = fakeHost({ onPing: ping.resolve });
  let retired = false;
  const pending = f.host.request({ action: "invoke", name: "control" }, 1_000, undefined,
    () => { if (retired) throw new Error("Task activation is retired"); });
  const pingId = await ping.promise;
  retired = true;
  f.reply(pingId, COMPUTER_INPUT_POLICY_CAPABILITY);
  await expect(pending).rejects.toMatchObject({ name: "ResidentUiaAdmissionError", message: "Task activation is retired" });
  expect(f.writes.map((request) => request.action)).toEqual(["ping"]);
  expect(f.pendingCount()).toBe(0);
});

test("startup drift is rejected at the final synchronous stdin write boundary", async () => {
  let retired = false;
  const f = fakeHost({ onStart: () => { retired = true; } });
  const abort = new AbortController();
  let removals = 0;
  let disposals = 0;
  const removeListener = abort.signal.removeEventListener.bind(abort.signal);
  Reflect.set(abort.signal, "removeEventListener", (...args: Parameters<typeof removeListener>) => {
    removals++;
    removeListener(...args);
  });
  Reflect.set(f.host, "dispose", async () => { disposals++; });
  await expect(f.host.request({ action: "type", text: "never typed", inputPolicy: "foreground" }, 10, abort.signal,
    () => { if (retired) throw new Error("Task target changed"); }))
    .rejects.toMatchObject({ name: "ResidentUiaAdmissionError", message: "Task target changed" });
  expect(f.starts).toBe(1);
  expect(f.writes).toEqual([]);
  expect(f.pendingCount()).toBe(0);
  expect(removals).toBe(1);
  abort.abort();
  expect(f.pendingCount()).toBe(0);
  await Bun.sleep(20);
  expect(disposals).toBe(0);
});

test("generic callback failures are typed admission denials before native startup", async () => {
  const f = fakeHost();
  const failure = new Error("Synthetic runtime admission failure");
  const pending = f.host.request({ action: "invoke", name: "control" }, 1_000, undefined, () => { throw failure; });
  await expect(pending).rejects.toMatchObject({ name: "ResidentUiaAdmissionError",
    message: failure.message, cause: failure });
  await expect(pending).rejects.toBeInstanceOf(ResidentUiaAdmissionError);
  expect(f.starts).toBe(0);
  expect(f.writes).toEqual([]);
  expect((await f.host.request({ action: "read" }, 1_000, undefined, () => {})).ok).toBe(true);
  expect(f.writes.map((request) => request.action)).toEqual(["ping", "read"]);
});

test("an unprintable thrown value cannot escape typed runtime admission denial", async () => {
  const f = fakeHost();
  await expect(f.host.request({ action: "invoke", name: "control" }, 1_000, undefined,
    () => { throw Object.create(null); })).rejects.toBeInstanceOf(ResidentUiaAdmissionError);
  expect(f.starts).toBe(0);
  expect(f.writes).toEqual([]);
});

test("trusted admission stays outside the wire payload and the resident queue remains usable", async () => {
  const f = fakeHost();
  let admissions = 0;
  expect((await f.host.request({ action: "invoke", name: "control" }, 1_000, undefined,
    () => { admissions++; })).output).toBe("synthetic action");
  expect(admissions).toBeGreaterThan(0);
  expect(f.writes.map((request) => request.action)).toEqual(["ping", "invoke"]);
  expect(f.writes.every((request) => !Object.hasOwn(request, "admit"))).toBe(true);
  expect((await f.host.request({ action: "read" }, 1_000, undefined, () => {})).ok).toBe(true);
});

test("unsupported background helper retains its typed capability failure", async () => {
  const f = fakeHost({ capability: "legacy helper ready" });
  await expect(f.host.request({ action: "invoke", name: "control" }, 1_000, undefined, () => {}))
    .rejects.toBeInstanceOf(ComputerInputPolicyCapabilityError);
  expect(f.writes.map((request) => request.action)).toEqual(["ping"]);
});
