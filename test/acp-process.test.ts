import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { terminateProcessTree } from "../src/core/tool-runtime.ts";

const fixture = join(import.meta.dir, "fixtures", "acp-durable-child.ts");

interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: any;
  error?: any;
  params?: any;
}

function startChild(mode: "mutate" | "resume", root: string, store: string, home: string) {
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEKO_TEST_ACP_CHILD_MODE: mode,
      NEKO_TEST_ACP_ROOT: root,
      NEKO_TEST_ACP_STORE: store,
      NEKO_TEST_ACP_HOME: home,
    },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages: JsonRpcMessage[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  return { child, messages };
}

function send(child: ChildProcessWithoutNullStreams, id: number, method: string, params: unknown): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function until<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for ACP child");
}

async function response(messages: JsonRpcMessage[], id: number): Promise<JsonRpcMessage> {
  return until(() => messages.find((message) => message.id === id));
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await terminateProcessTree(child);
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

test("ACP survives a forced mid-mutation process kill and does not execute the mutation twice", async () => {
  const base = mkdtempSync(join(tmpdir(), "neko-acp-process-"));
  const root = join(base, "project");
  const store = join(base, "sessions");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  let first: ReturnType<typeof startChild> | undefined;
  let second: ReturnType<typeof startChild> | undefined;
  try {
    first = startChild("mutate", root, store, home);
    send(first.child, 1, "initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    expect((await response(first.messages, 1)).error).toBeUndefined();
    send(first.child, 2, "session/new", { cwd: root, mcpServers: [] });
    const sessionId = (await response(first.messages, 2)).result.sessionId as string;
    send(first.child, 3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "perform the mutation once" }],
    });
    await until(() => existsSync(join(root, "mutation-started")) ? true : undefined);
    expect(readFileSync(join(root, "mutation-count.txt"), "utf8")).toBe("x");
    await stop(first.child);

    second = startChild("resume", root, store, home);
    send(second.child, 10, "initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    expect((await response(second.messages, 10)).result.agentCapabilities.loadSession).toBe(true);
    send(second.child, 11, "session/list", { cwd: root });
    expect((await response(second.messages, 11)).result.sessions.map((session: any) => session.sessionId)).toContain(sessionId);
    send(second.child, 12, "session/load", { sessionId, cwd: root, mcpServers: [] });
    expect((await response(second.messages, 12)).error).toBeUndefined();
    expect(second.messages.some((message) => message.method === "session/update"
      && message.params?.update?.sessionUpdate === "tool_call_update"
      && message.params.update.toolCallId === "mutation-once"
      && message.params.update.status === "failed"
      && /outcome unknown/i.test(JSON.stringify(message.params.update)))).toBe(true);
    send(second.child, 13, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "continue only after checking the unknown outcome" }],
    });
    expect((await response(second.messages, 13)).result.stopReason).toBe("end_turn");
    const resumedMessages = await until(() => existsSync(join(root, "resumed-messages.json"))
      ? readFileSync(join(root, "resumed-messages.json"), "utf8")
      : undefined);
    expect(resumedMessages).toMatch(/outcome unknown/i);
    expect(readFileSync(join(root, "mutation-count.txt"), "utf8")).toBe("x");
    send(second.child, 14, "session/close", { sessionId });
    expect((await response(second.messages, 14)).error).toBeUndefined();
    await stop(second.child);
  } finally {
    if (first) await stop(first.child);
    if (second) await stop(second.child);
    rmSync(base, { recursive: true, force: true });
  }
}, { timeout: 30_000 });
