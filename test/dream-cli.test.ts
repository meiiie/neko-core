import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isText } from "../src/shared/wire.ts";
import { parseDreamInput } from "../src/core/dream.ts";

const entry = join(import.meta.dir, "../bin/neko.ts");
async function cli(home: string, root: string, args: string[]) {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "ComSpec"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry, ...args], { cwd: root,
    env: { ...env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, NEKO_AUTO_UPDATE: "0", NEKO_AUTO_UPDATE_CHECK: "0", NO_PROXY: "127.0.0.1,localhost" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 12_000);
  try {
    const code = await child.exited;
    const out = await stdout, err = await stderr;
    return { code, out, err };
  } finally { clearTimeout(timer); }
}
function json(result: Awaited<ReturnType<typeof cli>>) {
  expect(result.code, result.err).toBe(0);
  const value = JSON.parse(result.out.trim().split("\n").findLast(line => line.startsWith("{")) ?? "null");
  if (!isJsonObject(value)) throw new Error("CLI did not return a JSON result");
  return value;
}

test.each(["legacy", "structured"] as const)("CLI dream preview/prepare/show/apply/rollback is real, isolated and one-call (%s)", async contextMode => {
  const home = mkdtempSync(join(tmpdir(), "neko-dream-cli-")), root = join(home, "repo"), other = join(home, "other");
  mkdirSync(root); mkdirSync(other); mkdirSync(join(home, ".neko-core"));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    const payload = await request.json();
    if (!isJsonObject(payload) || !Array.isArray(payload.messages)) return new Response("bad request", { status: 400 });
    expect(payload.tools ?? []).toEqual([]);
    expect(payload.max_tokens).toBe(4096);
    const message = payload.messages.find(item => isJsonObject(item) && item.role === "user");
    if (!isJsonObject(message) || !isText(message.content)) return new Response("no input", { status: 400 });
    const input = parseDreamInput(JSON.parse(message.content));
    const source = input.sources.find(item => item.kind === "user")!;
    const answer = JSON.stringify({ summary: "Tests", claims: [{ title: "Use Bun", text: "Use bun to run tests.", status: "observed",
      citations: [{ sourceId: source.id, quote: "Use bun to run tests." }], related: [], corrects: [] }] });
    if (!payload.stream) return Response.json({ choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    writeFileSync(join(home, ".neko-core/config.json"), JSON.stringify({ active_profile: "fixture", context_mode: contextMode,
      profiles: { fixture: { provider: "openai_compat", auth: "none", base_url: `http://127.0.0.1:${server.port}/v1`, model: "synthetic-local-model" } },
      max_retries: 0, offline_retry_seconds: 0, completion_sound: false }));
    const created = json(await cli(home, root, ["task-session", "new", "Dream test"]));
    const id = String(created.sessionId), path = join(home, ".neko-core/task-sessions", `${id}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.tasks[0].messages = [{ role: "user", content: "Use bun to run tests." }, { role: "assistant", content: "Noted." }];
    writeFileSync(path, JSON.stringify(saved));
    const preview = json(await cli(home, root, ["dream", "preview", id]));
    expect(preview.modelCalls).toBe(0); expect(requests).toBe(0);
    const wrongRoot = await cli(home, other, ["dream", "prepare", id]);
    expect(wrongRoot.code).not.toBe(0); expect(requests).toBe(0);
    const prepared = json(await cli(home, root, ["dream", "prepare", id]));
    expect(prepared.status).toBe("prepared"); expect(requests).toBe(1);
    const candidate = String(prepared.id);
    expect(json(await cli(home, root, ["dream", "show", id, candidate])).status).toBe("prepared");
    expect(json(await cli(home, root, ["dream", "apply", id, candidate])).status).toBe("applied");
    expect(json(await cli(home, root, ["dream", "apply", id, candidate])).status).toBe("already_applied");
    expect(json(await cli(home, root, ["dream", "rollback", id, candidate])).status).toBe("rolled_back");
    expect(requests).toBe(1);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.tasks[0].messages).toEqual(saved.tasks[0].messages);
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
