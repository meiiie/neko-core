import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "../src/shared/wire.ts";

const protocol = { version: 1, mode: "fixed-active-task" };
interface FixtureDelta { role?: string; content?: string }

function client(home: string) {
  const child = spawn(process.execPath, [join(import.meta.dir, "../bin/neko.ts"), "acp"], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "production",
      NEKO_AUTO_UPDATE: "0", NEKO_DREAM_MODE: "manual" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: any[] = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => frames.push(JSON.parse(line)));
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let nextId = 0;
  async function request(method: string, params: JsonObject) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const deadline = Date.now() + 10_000;
    while (!frames.some(frame => frame.id === id)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`ACP timeout: ${method}: ${stderr}`);
      await Bun.sleep(10);
    }
    return frames.find(frame => frame.id === id);
  }
  return { child, exited, request };
}

for (const shutdown of ["EOF", "SIGTERM", "SIGINT", "SIGHUP", "close", "SIGKILL"] as const) {
  for (const inFlight of [false, true]) {
    test.skipIf(process.platform === "win32" && shutdown !== "EOF" && shutdown !== "close")(
      `ACP ${shutdown} ${inFlight ? "in-flight" : "idle"} task writer lifecycle`, async () => {
        const home = mkdtempSync(join(tmpdir(), "neko-acp-shutdown-"));
        mkdirSync(join(home, ".neko-core"));
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
          // SAFETY: this loopback fixture only receives the spawned Neko provider's completion requests.
          const body = await request.json() as { messages: unknown[] };
          const slow = JSON.stringify(body.messages).includes("SLOW");
          const chunk = (delta: FixtureDelta, finish: string | null) => `data: ${JSON.stringify({
            id: "fixture", object: "chat.completion.chunk", model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: "OK" }, null)));
            started();
            if (!slow) {
              controller.enqueue(new TextEncoder().encode(chunk({}, "stop") + "data: [DONE]\n\n"));
              controller.close();
            }
          } }), { headers: { "Content-Type": "text/event-stream" } });
        } });
        writeFileSync(join(home, ".neko-core/config.json"), JSON.stringify({ provider: "openai_compat",
          base_url: `http://127.0.0.1:${server.port}/v1`, model: "fixture", api_key: "fixture-not-a-secret",
          mode: "auto", dream_mode: "off", auto_update: false, verify_before_exit: false, max_retries: 0 }));
        const children: ReturnType<typeof client>[] = [];
        async function start() {
          const c = client(home);
          children.push(c);
          expect((await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} })).error).toBeUndefined();
          return c;
        }
        try {
          const owner = await start();
          const created = await owner.request("session/new", { cwd: home, mcpServers: [],
            _meta: { "neko.taskProtocol": protocol, "neko.taskLabel": "shutdown" } });
          expect(created.error).toBeUndefined();
          const sessionId = created.result.sessionId;
          const receipt = created.result._meta["neko.task"];
          const meta = { "neko.task": { version: 1, id: receipt.id,
            activationEpoch: receipt.activationEpoch, activationId: receipt.activationId } };
          const load = { sessionId, cwd: home, mcpServers: [], _meta: { "neko.taskProtocol": protocol,
            "neko.taskExpected": { id: receipt.id, root: receipt.root,
              activationEpoch: receipt.activationEpoch, activationId: receipt.activationId } } };
          const lock = join(home, ".neko-core/task-sessions", `${sessionId}.lock`);
          expect(existsSync(lock)).toBe(true);
          const contender = await start();
          expect((await contender.request("session/load", load)).error).toMatchObject({ code: -32002,
            data: { "neko.taskError": { kind: "writer_unavailable" } } });
          const turn = owner.request("session/prompt", { sessionId, _meta: meta,
            prompt: [{ type: "text", text: inFlight ? "SLOW" : "hello" }] });
          void turn.catch(() => {});
          if (inFlight) await ready;
          else expect((await turn).result.stopReason).toBe("end_turn");
          if (shutdown === "close") expect((await owner.request("session/close", { sessionId, _meta: meta })).error).toBeUndefined();
          if (shutdown === "EOF" || shutdown === "close") owner.child.stdin.end();
          else owner.child.kill(shutdown);
          await Promise.race([owner.exited, Bun.sleep(5000).then(() => { throw new Error("shutdown did not exit promptly"); })]);
          const remains = existsSync(lock);
          const loaded = await contender.request("session/load", load);
          expect(remains).toBe(shutdown === "SIGKILL");
          if (shutdown === "SIGKILL") expect(loaded.error).toMatchObject({ code: -32002,
            data: { "neko.taskError": { kind: "writer_unavailable" } } });
          else expect(loaded.error).toBeUndefined();
        } finally {
          for (const c of children) { c.child.kill("SIGKILL"); c.child.stdin.destroy(); }
          await Promise.all(children.map(c => c.exited));
          server.stop(true);
          rmSync(home, { recursive: true, force: true });
        }
      }, 30_000);
  }
}
