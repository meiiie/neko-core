import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { resolveWindowsSystemExecutable } from "../shared/windows-system.ts";

const WINDOWS_POWERSHELL = process.platform === "win32"
  ? resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe")
  : null;
const WINDOWS_TASKKILL = process.platform === "win32" ? resolveWindowsSystemExecutable("taskkill.exe") : null;

export interface UiaRequest {
  action: string;
  window?: string;
  name?: string;
  value?: string;
  max?: number;
  text?: string;
  keys?: string;
  direction?: string;
  amount?: number;
  durationMs?: number;
  settleMs?: number;
  x?: number;
  y?: number;
  mark?: number; // Set-of-Marks: click target = an [N] from the last ocr (resolved in the resident host)
  points?: number[];
  presence?: boolean;
  inputBackend?: string;
  capturePath?: string;
  width?: number;
}

export interface UiaResponse {
  id: number;
  ok: boolean;
  output?: string;
  error?: string;
  pid?: number;
}

type PendingRequest = {
  resolve: (response: UiaResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** One warm PowerShell Windows-desktop process. Requests are serialized against one interactive desktop. */
export class ResidentUiaHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 0;
  private queue: Promise<void> = Promise.resolve();
  private stderrTail = "";
  private pending = new Map<number, PendingRequest>();

  constructor(private readonly script: string) {}

  request(request: UiaRequest, timeoutMs = 90_000, signal?: AbortSignal): Promise<UiaResponse> {
    const run = () => this.requestNow(request, timeoutMs, signal);
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    const settled = !child || child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          child.removeListener("close", done);
          resolve();
        };
        child.once("close", done);
        timer = setTimeout(done, 5_000);
        timer.unref?.();
      });
    try {
      if (child?.pid && process.platform === "win32" && WINDOWS_TASKKILL) {
        spawnSync(WINDOWS_TASKKILL, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      } else {
        child?.kill();
      }
    } catch {}
    this.failPending(new Error("resident Windows host stopped"));
    return settled;
  }

  private requestNow(request: UiaRequest, timeoutMs: number, signal?: AbortSignal): Promise<UiaResponse> {
    if (signal?.aborted) return Promise.reject(new Error("resident Windows request interrupted"));
    const child = this.ensureChild();
    const id = ++this.nextId;
    const payload = JSON.stringify({ id, ...request });
    if (payload.length > 100_000) return Promise.reject(new Error("resident Windows request is too large"));
    return new Promise<UiaResponse>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        void this.dispose();
        reject(new Error("resident Windows request interrupted"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        void this.dispose();
        const detail = this.stderrTail.trim().slice(-1000);
        reject(new Error(`resident Windows request timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      // Close the small race between the early aborted check and listener registration.
      if (signal?.aborted) { onAbort(); return; }
      child.stdin.write(payload + "\n", "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    if (!existsSync(this.script)) throw new Error(`resident Windows script not found: ${this.script}`);
    if (!WINDOWS_POWERSHELL) throw new Error("trusted Windows PowerShell was not found under System32");
    const child = spawn(WINDOWS_POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script], {
      cwd: dirname(this.script),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending(error);
    });
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending(new Error(`resident Windows host exited (${code ?? "?"})`));
    });
    // The pending request timer keeps short-lived `neko run` alive while work is in flight. Once idle,
    // the resident helper must not pin the parent process forever.
    child.unref();
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (child.stdin as any).unref?.();
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (child.stdout as any).unref?.();
    // SAFETY: bridge to an untyped JS/DOM API surface; use is guarded by the surrounding checks.
    (child.stderr as any).unref?.();
    return child;
  }

  private onLine(line: string): void {
    let response: UiaResponse;
    try { response = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(Number(response.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(Number(response.id));
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    pending.resolve(response);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const hosts = new Map<string, ResidentUiaHost>();
let cleanupInstalled = false;

/** Shared per script tree: CLI, TUI, and depth-one agents reuse one local desktop process. */
export function residentUiaHost(script: string): ResidentUiaHost {
  // ponytail: one serialized host matches Windows' one interactive desktop; split when isolated desktops ship.
  let host = hosts.get(script);
  if (!host) {
    host = new ResidentUiaHost(script);
    hosts.set(script, host);
  }
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.once("exit", () => {
      for (const active of hosts.values()) void active.dispose();
      hosts.clear();
    });
  }
  return host;
}
