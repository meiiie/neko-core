import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFileLease, LEASE_STALE_MS } from "../src/adapters/session-lease.ts";
import type { WireObject } from "../src/shared/wire.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "neko-lease-"));
  dirs.push(dir);
  const path = join(dir, "session.lock");
  let now = Date.now();
  const timers = new Set<() => void>();
  let exit = () => {};
  let stopped = false;
  const stat = (start: string) => `1 (name with ) spaces) S ${Array(18).fill("0").join(" ")} ${start}`;
  const env = {
    linux: true, now: () => now, alive: () => true,
    readlink: () => "pid:[ours]",
    read: (path: string) => path.endsWith("boot_id") ? "boot" : path === "/proc/stat" ? "btime 1000\n" : stat("200"),
    interval: (callback: () => void) => {
      timers.add(callback);
      return () => { stopped = true; timers.delete(callback); };
    },
    onExit: (callback: () => void) => { exit = callback; return () => { exit = () => {}; }; },
  };
  const write = (body: WireObject = {}) => writeFileSync(path, JSON.stringify({ pid: 1, token: "old", acquiredAt: new Date(now).toISOString(), ...body }));
  return { path, env, write, acquire: () => acquireFileLease(path, "test", env),
    advance: () => { now += LEASE_STALE_MS + 1000; }, beat: () => { for (const callback of [...timers]) callback(); },
    exit: () => exit(), timerCount: () => timers.size, stopped: () => stopped };
}

test("dead owners and different boots are recovered", () => {
  for (const body of [{}, { bootId: "previous" }]) {
    const f = fixture(); f.write(body);
    if (!body.bootId) f.env.alive = () => false;
    f.acquire().release();
    expect(existsSync(f.path)).toBe(false);
  }
});

test("foreign namespace requires an expired heartbeat", () => {
  const f = fixture(); f.write({ pidNamespace: "pid:[foreign]" });
  f.env.alive = () => { throw new Error("must not probe foreign pid"); };
  expect(f.acquire).toThrow("active writer");
  f.advance();
  f.acquire().release();
  expect(existsSync(f.path)).toBe(false);
});

test("heartbeat preserves a live writer and stops on release", () => {
  const f = fixture(); const lease = f.acquire();
  const body = JSON.parse(readFileSync(f.path, "utf8"));
  expect(body).toMatchObject({ bootId: "boot", pidNamespace: "pid:[ours]", startTime: "200" });
  f.advance(); f.beat();
  expect(f.env.now() - lstatSync(f.path).mtimeMs).toBeLessThan(2);
  expect(f.acquire).toThrow("active writer");
  lease.release(); expect(f.stopped()).toBe(true);
  f.write({ token: "replacement" });
  const before = lstatSync(f.path).mtimeMs;
  f.advance(); f.beat(); lease.release();
  expect(lstatSync(f.path).mtimeMs).toBe(before);
});

test("replacement tokens are neither refreshed nor removed", () => {
  const f = fixture(); const lease = f.acquire();
  lease.assertOwnership();
  f.write({ token: "replacement" });
  const before = lstatSync(f.path).mtimeMs;
  f.advance(); f.beat(); lease.release();
  expect(() => lease.assertOwnership()).toThrow("lost its writer lock");
  expect(lstatSync(f.path).mtimeMs).toBe(before);
  expect(JSON.parse(readFileSync(f.path, "utf8")).token).toBe("replacement");
});

test("ownership checks fence a lost lease even before its next heartbeat", () => {
  const f = fixture(); const lease = f.acquire();
  f.write({ token: "new-writer" });
  expect(() => lease.assertOwnership()).toThrow("lost its writer lock");
  lease.release();
  expect(JSON.parse(readFileSync(f.path, "utf8")).token).toBe("new-writer");
});

test("start identity detects reused pids conservatively", () => {
  const f = fixture(); f.write({ startTime: "199" }); f.acquire().release();
  expect(existsSync(f.path)).toBe(false);
  f.write({ startTime: "200" });
  expect(f.acquire).toThrow("active writer");
  f.env.read = () => { throw new Error("proc unavailable"); };
  expect(f.acquire).toThrow("active writer");
  f.env.linux = false; f.write({ bootId: "other", startTime: "199" });
  expect(f.acquire).toThrow("active writer");
});

test("a live legacy pid is refused even when its process started after acquisition", () => {
  const f = fixture(); f.write({ acquiredAt: new Date(0).toISOString() });
  const before = readFileSync(f.path, "utf8");
  expect(f.acquire).toThrow("already has an active writer");
  expect(f.acquire).toThrow(`lock written by an older Neko: ${f.path}; remove it only if no other Neko is running`);
  expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("a legacy lock with a dead pid is taken over", () => {
  const f = fixture(); f.write({ acquiredAt: new Date(0).toISOString() });
  f.env.alive = () => false;
  const lease = f.acquire();
  expect(JSON.parse(readFileSync(f.path, "utf8")).token).not.toBe("old");
  lease.release();
  expect(existsSync(f.path)).toBe(false);
});

test("unsafe locks and fresh recovery guards are preserved", () => {
  const f = fixture(); writeFileSync(f.path, "");
  expect(f.acquire).toThrow("unsafe lock");
  rmSync(f.path); symlinkSync(join(f.path, "missing"), f.path);
  expect(f.acquire).toThrow("unsafe lock");
  rmSync(f.path); writeFileSync(`${f.path}.recovery`, "");
  expect(f.acquire).toThrow("active writer");
  utimesSync(`${f.path}.recovery`, new Date(0), new Date(0));
  f.acquire().release();
});

test("an old recovery guard owned by a live same-namespace process is not broken", () => {
  const f = fixture();
  writeFileSync(`${f.path}.recovery`, JSON.stringify({ pid: 1, token: "guard", startTime: "200", pidNamespace: "pid:[ours]" }));
  utimesSync(`${f.path}.recovery`, new Date(0), new Date(0));
  expect(f.acquire).toThrow("active writer");
});

test("release retries under the guard and preserves replacements made during contention", () => {
  for (const replacement of ["none", "before-release", "during-contention"]) {
    const f = fixture(); const lease = f.acquire();
    if (replacement === "before-release") f.write({ token: "replacement" });
    writeFileSync(`${f.path}.recovery`, JSON.stringify({ pid: 1, token: "other-guard", startTime: "200", pidNamespace: "pid:[ours]" }));
    lease.release();
    expect(f.stopped()).toBe(true);
    expect(existsSync(f.path)).toBe(true);
    if (replacement === "during-contention") f.write({ token: "replacement" });
    f.beat();
    expect(existsSync(f.path)).toBe(true);
    expect(JSON.parse(readFileSync(`${f.path}.recovery`, "utf8")).token).toBe("other-guard");
    rmSync(`${f.path}.recovery`);
    f.beat();
    expect(existsSync(f.path)).toBe(replacement !== "none");
    if (replacement !== "none") expect(JSON.parse(readFileSync(f.path, "utf8")).token).toBe("replacement");
    expect(f.timerCount()).toBe(0);
    lease.release();
    f.exit();
  }
});

test("release retries are bounded and process exit makes one final guarded attempt", () => {
  const f = fixture(); const lease = f.acquire();
  writeFileSync(`${f.path}.recovery`, JSON.stringify({ pid: 1, token: "other-guard", startTime: "200", pidNamespace: "pid:[ours]" }));
  lease.release();
  for (let attempt = 0; attempt < 20; attempt++) f.beat();
  expect(f.timerCount()).toBe(0);
  expect(existsSync(f.path)).toBe(true);
  rmSync(`${f.path}.recovery`);
  f.exit();
  expect(existsSync(f.path)).toBe(false);
});

test("a stale-check replacement is not unlinked", () => {
  const f = fixture(); f.write();
  f.env.alive = () => { f.write({ token: "new-writer" }); return false; };
  expect(f.acquire).toThrow("active writer");
  expect(JSON.parse(readFileSync(f.path, "utf8")).token).toBe("new-writer");
});
