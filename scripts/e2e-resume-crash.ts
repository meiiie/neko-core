/**
 * Manual crash-resume E2E. Uses a local OpenAI-compatible SSE fixture, a real compiled Neko binary,
 * and a real PTY. No model/API credentials or network access are used.
 *
 * Flow: stream a write_file call -> return its result -> stream assistant progress forever (simulated
 * dead link) -> hard-kill Neko -> reopen the session in a fresh process -> prove prompt, tool result,
 * and partial assistant progress all survived on disk and are visible after resume.
 *
 *   bun scripts/e2e-resume-crash.ts [path-to-neko-binary]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { isText } from "../src/shared/wire.ts";

// SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
const Terminal = (Bun as any).Terminal;
if (!(Terminal instanceof Function)) throw new Error("Bun.Terminal is required for the crash-resume E2E");

const arg = process.argv[2] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko");
const exe = isAbsolute(arg) ? arg : resolve(arg);
if (!existsSync(exe)) throw new Error(`compiled Neko binary not found: ${exe}`);

const root = mkdtempSync(join(tmpdir(), "neko-resume-crash-e2e-"));
const home = join(root, "home");
const work = join(root, "work");
mkdirSync(work, { recursive: true });

const encoder = new TextEncoder();
const sse = (value: any) => encoder.encode(`data: ${isText(value) ? value : JSON.stringify(value)}\n\n`);
let requestCount = 0;
let partialObserved = false;
let heldController: ReadableStreamDefaultController<Uint8Array> | null = null;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (!request.url.endsWith("/v1/chat/completions")) return new Response("not found", { status: 404 });
    await request.text(); // consume the body so the client can reuse/close the connection cleanly
    requestCount++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (requestCount === 1) {
          controller.enqueue(sse({
            id: "resume-e2e-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {
              tool_calls: [{ index: 0, id: "resume-write-1", type: "function", function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "resume-e2e-output.txt",
                  content: "durable tool accomplishment",
                }),
              } }],
            }, finish_reason: null }],
          }));
          controller.enqueue(sse({
            id: "resume-e2e-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }));
          controller.enqueue(sse("[DONE]"));
          controller.close();
          return;
        }
        if (requestCount === 2) {
          controller.enqueue(sse({
            id: "resume-e2e-2",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {
              content: "Đã tạo tệp và xác minh thành quả; phần tiến độ này phải sống sót sau khi mất kết nối.",
            }, finish_reason: null }],
          }));
          heldController = controller; // intentionally never DONE/close: a dead Wi-Fi link that stalls forever
          partialObserved = true;
          return;
        }
        controller.error(new Error(`unexpected completion request ${requestCount}`));
      },
      cancel() { heldController = null; },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});

// Preserve only ordinary process/runtime variables. The child must never inherit a real provider key,
// token, password, or NEKO_* route that could bypass the loopback fixture.
const inheritedEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || key.startsWith("NEKO_") || /API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
  inheritedEnv[key] = value;
}
const childEnv = {
  ...inheritedEnv,
  USERPROFILE: home,
  HOME: home,
  NEKO_PROFILE: "local",
  NEKO_API_KEY: "resume-e2e-fixture-key",
  OPENAI_API_KEY: "",
  NVIDIA_API_KEY: "",
  NEKO_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
  NEKO_MODEL: "resume-e2e-model",
  NEKO_FULLSCREEN: "false",
  NEKO_AUTO_UPDATE: "false",
  NEKO_VERIFY_BEFORE_EXIT: "false",
  NEKO_OFFLINE_RETRY_SECONDS: "600",
  NEKO_TIMEOUT_SECONDS: "600",
  NEKO_MAX_RETRIES: "0",
};

function pty(command: string[]) {
  let raw = "";
  const term = new Terminal({
    cols: 120,
    rows: 34,
    data(_terminal: any, chunk: Uint8Array) { raw += new TextDecoder().decode(chunk); },
  });
  // SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
  const proc = Bun.spawn({ cmd: command, cwd: work, terminal: term, env: childEnv } as any);
  return { term, proc, raw: () => raw };
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sessionFile(): string | null {
  const dir = join(home, ".neko-core", "sessions");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== ".index.json")
    .map((name) => join(dir, name));
  if (!files.length) return null;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

let first: ReturnType<typeof pty> | null = null;
let resumed: ReturnType<typeof pty> | null = null;
try {
  first = pty([exe, "--yolo"]);
  await waitFor("interactive prompt", () => first!.raw().includes("shift+tab to cycle"));
  first.term.write("hãy tạo bằng chứng để kiểm tra resume");
  await Bun.sleep(100);
  first.term.write("\r");
  await waitFor("streamed partial response", () => partialObserved);

  await waitFor("durable in-flight checkpoint", () => {
    const file = sessionFile();
    if (!file) return false;
    try {
      const session = JSON.parse(readFileSync(file, "utf8"));
      return session.messages.some((message: any) => message.role === "tool" && String(message.content).includes("resume-e2e-output.txt"))
        && session.messages.some((message: any) => message.role === "assistant" && String(message.content).includes("phải sống sót"));
    } catch { return false; }
  });

  // The response stream is still open and the turn cannot reach its finally block. Terminate the binary
  // as closing Windows Terminal would; only incremental atomic checkpoints can preserve this state.
  first.proc.kill();
  await Promise.race([first.proc.exited, Bun.sleep(3000)]);
  first.term.close();
  first = null;
  server.stop(true);

  const file = sessionFile();
  if (!file) throw new Error("session file disappeared after hard kill");
  const session = JSON.parse(readFileSync(file, "utf8"));
  const id = String(session.id);
  if (!session.messages.some((message: any) => message.role === "user" && String(message.content).includes("kiểm tra resume"))) {
    throw new Error("user prompt was not recovered");
  }
  if (!session.messages.some((message: any) => message.role === "tool" && String(message.content).includes("resume-e2e-output.txt"))) {
    throw new Error("completed tool result was not recovered");
  }
  if (!session.messages.some((message: any) => message.role === "assistant" && String(message.content).includes("phải sống sót"))) {
    throw new Error("partial assistant progress was not recovered");
  }
  if (!existsSync(join(work, "resume-e2e-output.txt"))) throw new Error("tool accomplishment is missing on disk");

  resumed = pty([exe, "resume", id]);
  await waitFor("resumed partial progress on screen", () => resumed!.raw().includes("phải sống sót"));
  if (!resumed.raw().includes("resume-e2e-output.txt")) throw new Error("resumed UI omitted the completed tool result");
  resumed.term.write("\x03");
  await Bun.sleep(100);
  resumed.term.write("\x03");
  await Promise.race([resumed.proc.exited, Bun.sleep(3000)]);
  resumed.term.close();
  resumed = null;

  console.log(`resume-crash-e2e: PASS - ${session.messages.length} durable messages; prompt + tool result + partial stream recovered after hard kill and visible in a fresh resume process.`);
} finally {
  try { first?.proc.kill(); } catch {}
  try { first?.term.close(); } catch {}
  try { resumed?.proc.kill(); } catch {}
  try { resumed?.term.close(); } catch {}
  try { server.stop(true); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch { /* killed Windows children can retain handles; never mask the real test result */ }
}
