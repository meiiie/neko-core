import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");
const ok = [
  { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "QUOTA_WINDOW_OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

async function run(rateLimitRetrySeconds: number) {
  const home = mkdtempSync(join(tmpdir(), "neko-rl-"));
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    if (calls <= 6) return Response.json({ type: "error", error: { type: "rate_limit_error", code: "1302" } }, { status: 429 });
    return new Response(ok, { headers: { "content-type": "text/event-stream" } });
  } });
  mkdirSync(join(home, ".neko-core"));
  writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({
    active_profile: "fixture", profiles: { fixture: { provider: "anthropic", auth: "none", base_url: `http://127.0.0.1:${server.port}`, model: "synthetic" } },
    max_retries: 2, retry_base_delay_seconds: 0.001, retry_max_delay_seconds: 0.001, offline_retry_seconds: 0,
    rate_limit_retry_seconds: rateLimitRetrySeconds, verify_before_exit: false, completion_sound: false,
  }));
  const child = Bun.spawn([process.execPath, entry, "run", "--once", "--no-tools", "--max-steps", "2", "Reply"], {
    cwd: home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NEKO_AUTO_UPDATE: "0", NEKO_COMPLETION_SOUND: "0" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { exit, stdout, calls };
  } finally { clearTimeout(timer); server.stop(true); rmSync(home, { recursive: true, force: true }); }
}

test("anthropic: sustained 429 beyond max_retries recovers inside rate_limit_retry_seconds", async () => {
  const r = await run(30);
  expect(r.exit).toBe(0);
  expect(r.calls).toBe(7);
  expect(r.stdout).toContain("QUOTA_WINDOW_OK");
}, 20_000);

test("anthropic: rate_limit_retry_seconds=0 keeps legacy fail-fast after max_retries", async () => {
  const r = await run(0);
  expect(r.exit).not.toBe(0);
  expect(r.calls).toBe(3);
}, 20_000);
