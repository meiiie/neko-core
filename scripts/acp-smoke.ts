/** No-model smoke for the compiled `neko acp` stdio boundary. */
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";

const executable = resolve(process.argv[2] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko"));
const child = spawn(executable, ["acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const output = Writable.toWeb(child.stdin);
// SAFETY: Node's toWeb stream and the SDK's web ReadableStream are the same runtime object;
// their generic variance differs only in type-argument defaults.
const input = webReadable(Readable.toWeb(child.stdout));

function webReadable(stream: any): ReadableStream<Uint8Array> { return stream; }

try {
  const initialized = await acp.client({ name: "neko-acp-smoke" }).connectWith(
    acp.ndJsonStream(output, input),
    (ctx) => ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        terminal: true,
        _meta: { "terminal-auth": true },
      },
      clientInfo: { name: "neko-acp-smoke", version: "1" },
    }),
  );
  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION || initialized.agentInfo?.name !== "neko-core") {
    throw new Error("compiled ACP initialize response is invalid");
  }
  if (!initialized.authMethods?.some((method) => method.type === "terminal")) {
    throw new Error("compiled ACP server does not advertise Registry-compatible terminal authentication");
  }
  console.log(`acp-smoke: OK - protocol v${initialized.protocolVersion}, ${initialized.agentInfo.name} ${initialized.agentInfo.version}`);
} finally {
  child.stdin.end();
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  setTimeout(() => child.kill(), 2_000).unref();
  await exited;
  if (stderr.trim()) process.stderr.write(stderr);
}
