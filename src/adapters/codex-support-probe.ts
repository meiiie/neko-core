import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCodexAppServer } from "./codex-app-server.ts";
import { isJsonObject, isText } from "../shared/wire.ts";
import { throwIfAborted, userAbortError } from "../shared/abort.ts";

export async function verifyCodexToolRoundTrip(path: string, version: string, probeHome: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let requests = 0;
  let callbacks = 0;
  const marker = "neko-support-probe-ok";
  const server = createServer((req, res) => {
    req.resume();
    if (req.method !== "POST" || !req.url?.endsWith("/responses") || ++requests > 2) {
      res.writeHead(404); res.end(); return;
    }
    const id = `probe-${requests}`;
    const item = requests === 1
      ? { type: "custom_tool_call", call_id: "probe-call", name: "exec", input: `text(await tools.neko_support_probe({value:"${marker}"}));` }
      : { id: "probe-answer", type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] };
    const events = [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || isText(address)) throw new Error("Could not start local support probe");
  let client: ReturnType<typeof startCodexAppServer> | undefined;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  void completed.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { fail(userAbortError()); client?.close(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    throwIfAborted(signal);
    mkdirSync(probeHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(probeHome, "config.toml"), [
      'model_provider = "neko_probe"', 'model = "gpt-5.5"',
      '[features]', 'code_mode_only = true',
      '[model_providers.neko_probe]', 'name = "Neko local support probe"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    client = startCodexAppServer({ path, kind: "app-server", source: "managed", version }, {
      onRequest: async (method, params) => {
        if (method !== "item/tool/call" || !isJsonObject(params) || params.tool !== "neko_support_probe"
          || !isJsonObject(params.arguments) || params.arguments.value !== marker) {
          throw new Error("Unexpected support probe callback");
        }
        callbacks++;
        return { contentItems: [{ type: "inputText", text: marker }], success: true };
      },
      onNotification: (method, params) => {
        if (method === "turn/completed") {
          if (isJsonObject(params) && isJsonObject(params.turn) && params.turn.status === "completed") finish();
          else fail(new Error("Codex support probe turn failed"));
        }
        if (method === "error") fail(new Error("Codex support probe reported a transport error"));
      },
    }, { codexHome: probeHome });
    await client.initialize(20_000);
    const thread = await client.request("thread/start", {
      model: "gpt-5.5", modelProvider: "neko_probe", ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      cwd: probeHome, environments: [],
      dynamicTools: [{ name: "neko_support_probe", description: "Local in-memory diagnostic echo", inputSchema: {
        type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
      } }],
    });
    if (!isJsonObject(thread) || !isJsonObject(thread.thread) || !isText(thread.thread.id)) throw new Error("Invalid support probe thread response");
    timeout = setTimeout(() => fail(new Error("Codex support tool probe timed out")), 20_000);
    await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Run the local diagnostic echo." }] });
    await completed;
    if (requests !== 2 || callbacks !== 1) throw new Error("Codex support probe did not execute the dynamic tool exactly once");
  } finally {
    signal?.removeEventListener("abort", cancel);
    clearTimeout(timeout);
    await client?.closeAndWait();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
