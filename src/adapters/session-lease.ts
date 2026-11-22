import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, futimesSync, lstatSync, openSync, readFileSync, readlinkSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { execFileSync } from "node:child_process";
import { isJsonObject, isText } from "../shared/wire.ts";
import type { SessionLease } from "./session.ts";

export const LEASE_STALE_MS = 60_000;
export const LEASE_HEARTBEAT_MS = 10_000;

interface LeaseEnvironment {
  now(): number;
  read(path: string): string;
  readlink(path: string): string;
  alive(pid: number): boolean;
  ticks(): number;
  linux: boolean;
  interval(callback: () => void, ms: number): () => void;
}

let clockTicks: number | undefined;
const environment: LeaseEnvironment = {
  now: Date.now,
  read: (path) => readFileSync(path, "utf8"),
  readlink: readlinkSync,
  alive: (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error: unknown) { return isJsonObject(error) && error.code === "EPERM"; }
  },
  ticks: () => clockTicks ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000 })),
  linux: process.platform === "linux",
  interval: (callback, ms) => {
    const timer = setInterval(callback, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

function optional(read: () => string): string | undefined {
  try { return read().trim() || undefined; } catch { return undefined; }
}

function startTime(stat: string): string {
  const value = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!value || !/^\d+$/.test(value)) throw new Error("Invalid process stat");
  return value;
}

function snapshot(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096) throw new Error("unsafe lock");
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isJsonObject(body)) throw new Error("unsafe lock");
  return { stat, body };
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/** All cooperating writers serialize creation and recovery through the same short-lived guard. */
export function acquireFileLease(path: string, id: string, overrides: Partial<LeaseEnvironment> = {}): SessionLease {
  const env = { ...environment, ...overrides };
  const token = randomBytes(16).toString("hex");
  const identity = env.linux ? {
    bootId: optional(() => env.read("/proc/sys/kernel/random/boot_id")),
    pidNamespace: optional(() => env.readlink("/proc/self/ns/pid")),
    startTime: optional(() => startTime(env.read("/proc/self/stat"))),
  } : {};
  const busy = () => new Error(`Session '${id}' already has an active writer`);
  const stale = ({ stat, body }: ReturnType<typeof snapshot>) => {
    if (env.linux && body.bootId && identity.bootId && body.bootId !== identity.bootId) return true;
    if (env.linux && body.pidNamespace && identity.pidNamespace && body.pidNamespace !== identity.pidNamespace) {
      return env.now() - stat.mtimeMs > LEASE_STALE_MS;
    }
    const pid = Number(body.pid);
    if (!env.alive(pid)) return true;
    if (!env.linux) return false;
    try {
      const started = startTime(env.read(`/proc/${pid}/stat`));
      if (isText(body.startTime)) return started !== body.startTime;
      const boot = /^btime\s+(\d+)$/m.exec(env.read("/proc/stat"));
      const ticks = env.ticks();
      if (!boot || !Number.isFinite(ticks) || ticks <= 0) return false;
      const acquired = isText(body.acquiredAt) ? Date.parse(body.acquiredAt) : NaN;
      const lockTime = Number.isFinite(acquired) ? Math.min(acquired, stat.mtimeMs) : stat.mtimeMs;
      return (Number(boot[1]) + Number(started) / ticks) * 1000 > lockTime + 5000;
    } catch { return false; }
  };
  const guardPath = `${path}.recovery`;
  const guarded = (action: () => void) => {
    let fd: number | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fd = openSync(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); break; }
      catch (error: unknown) {
        if (!isJsonObject(error) || error.code !== "EEXIST") throw error;
        try {
          const old = lstatSync(guardPath);
          if (!old.isFile() || old.size > 4096 || env.now() - old.mtimeMs <= LEASE_STALE_MS) throw busy();
          if (old.size > 0 && !stale(snapshot(guardPath))) throw busy();
          if (sameFile(old, lstatSync(guardPath))) unlinkSync(guardPath);
        } catch (guardError: unknown) {
          if (!isJsonObject(guardError) || guardError.code !== "ENOENT") throw guardError;
        }
      }
    }
    if (fd === undefined) throw busy();
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, token, ...identity }));
      action();
    } finally {
      try { if (sameFile(fstatSync(fd), lstatSync(guardPath))) unlinkSync(guardPath); }
      finally { closeSync(fd); }
    }
  };
  guarded(() => {
    try {
      const previous = snapshot(path);
      if (!stale(previous)) throw busy();
      const current = snapshot(path);
      if (current.body.token !== previous.body.token || !sameFile(current.stat, previous.stat)) throw busy();
      unlinkSync(path);
    } catch (error: unknown) {
      if (!isJsonObject(error) || error.code !== "ENOENT") {
        if (error instanceof Error && error.message.includes("active writer")) throw error;
        throw new Error(`Session '${id}' is already active or has an unsafe lock`);
      }
    }
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date(env.now()).toISOString(), ...identity })); }
    finally { closeSync(fd); }
  });
  let released = false;
  const stop = env.interval(() => {
    if (released) return;
    try {
      guarded(() => {
        if (snapshot(path).body.token !== token) return;
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const time = new Date(env.now()); futimesSync(fd, time, time); }
        finally { closeSync(fd); }
      });
    } catch { /* Missing, replaced, or recovering locks are not ours to refresh. */ }
  }, LEASE_HEARTBEAT_MS);
  return { release: () => {
    if (released) return;
    released = true;
    stop();
    try { guarded(() => { if (snapshot(path).body.token === token) unlinkSync(path); }); }
    catch { /* A replaced/missing lock is not ours to remove. */ }
  } };
}
