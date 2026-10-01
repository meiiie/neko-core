import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "bin", "neko.ts");

for (const status of [429, 503]) {
  test(`CLI reports HTTP ${status} retry on stderr and recovers without leaking provider body`, async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-cli-retry-"));
    let calls = 0;
    const sentinel = "synthetic-private-provider-body";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      if (calls === 1) return Response.json({ error: { message: sentinel } }, { status, headers: { "retry-after": "0" } });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "LOCAL_RETRY_OK" }, finish_reason: "stop" }] })}\n\n` + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    } });
    mkdirSync(join(home, ".neko-core"));
    writeFileSync(join(home, ".neko-core", "config.json"), JSON.stringify({
      active_profile: "fixture", profiles: { fixture: { provider: "openai_compat", auth: "none", base_url: `http://127.0.0.1:${server.port}/v1`, model: "synthetic" } },
      max_retries: 1, retry_base_delay_seconds: 0.001, retry_max_delay_seconds: 0.001, offline_retry_seconds: 0,
      verify_before_exit: false, completion_sound: false,
    }));
    const child = Bun.spawn([process.execPath, entry, "run", "--once", "--no-tools", "--max-steps", "2", "Reply with the marker"], {
      cwd: home, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? "", NEKO_AUTO_UPDATE: "0", NEKO_COMPLETION_SOUND: "0" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).toBe(0);
      expect(calls).toBe(2);
      expect(stdout).toContain("LOCAL_RETRY_OK");
      expect(stdout).not.toContain("[provider:");
      expect(stderr).toContain(status === 429 ? "rate limited" : "server error");
      expect(stderr).toContain("retrying");
      expect(stdout + stderr).not.toContain(sentinel);
    } finally {
      clearTimeout(timer); child.kill(); await child.exited; server.stop(true); rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
}
