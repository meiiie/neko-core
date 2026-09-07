import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";

const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: fileURLToPath(new URL("./.wrangler/build/worker.js", import.meta.url)),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  d1Databases: ["DB"], bindings: { IP_HASH_KEY: "synthetic-test-only-key" },
  email: { send_email: config.send_email },
  ratelimits: { INGRESS: { namespace_id: config.ratelimits[0].namespace_id, simple: { limit: 1000, period: 60 } } },
  log: new Log(LogLevel.ERROR),
}));
const report = () => ({
  schemaVersion: "neko-feedback.v1", reportId: randomUUID(), createdAt: new Date().toISOString(),
  category: "provider", recipient: "meiiiekhp888@gmail.com", notes: "Synthetic report, not a user session",
  diagnostics: { version: "1.5.1", platform: "win32", arch: "x64", provider: "anthropic", model: "glm-5.3" },
});
const post = (path, value, ip = "192.0.2.1") => mf.dispatchFetch(`https://feedback.test${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(value),
});
try {
  const db = await mf.getD1Database("DB");
  const schema = await readFile(new URL("./migrations/0001_receipts.sql", import.meta.url), "utf8");
  await db.batch(schema.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  const first = report();
  const uploads = await Promise.all(Array.from({ length: 8 }, () => post("/v1/feedback", first)));
  assert.equal(uploads.filter((result) => result.status === 202).length, 1, "concurrent duplicates admitted more than once");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM receipts").first()).n, 1);
  const receipt = { reportId: first.reportId, digest: createHash("sha256").update(JSON.stringify(first)).digest("hex") };
  let status;
  for (let i = 0; i < 30; i++) {
    status = await (await post("/v1/feedback/status", receipt)).json();
    if (status.state !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status.state, "accepted", "local email binding did not accept valid MIME");
  assert.equal((await post("/v1/feedback", { ...first, notes: "changed" })).status, 409);
  assert.equal((await post("/v1/feedback/status", { ...receipt, digest: "0".repeat(64) })).status, 404);
  await db.prepare("UPDATE receipts SET state = 'unknown' WHERE id = ?").bind(first.reportId).run();
  assert.equal((await (await post("/v1/feedback", first)).json()).state, "unknown", "unknown outcomes must not be sent again");
  for (const change of [{ recipient: "attacker@example.com" }, { token: "not-allowed" }, { notes: "x".repeat(4001) }, { createdAt: "2020-01-01T00:00:00.000Z" }]) {
    assert.equal((await post("/v1/feedback", { ...report(), ...change })).status, 400);
  }
  assert.equal((await mf.dispatchFetch("https://feedback.test/v1/feedback")).status, 405);
  assert.equal((await mf.dispatchFetch("https://feedback.test/v1/feedback", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1", "Content-Length": String(700 * 1024) }, body: "x".repeat(700 * 1024),
  })).status, 413);
  assert.equal((await mf.dispatchFetch("https://feedback.test/v1/feedback", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" }, body: "{invalid",
  })).status, 400);
  assert.equal((await post("/v1/feedback/status", { ...receipt, token: "not-an-allowed-field" })).status, 400);
  const before = await db.prepare("SELECT COUNT(*) AS n FROM receipts").first();
  assert.equal(before.n, 1, "rejected requests reached storage");
  const many = await Promise.all(Array.from({ length: 12 }, () => post("/v1/feedback", report())));
  assert.equal(many.filter((result) => result.status === 202).length, 9, "per-IP daily quota must be atomic");
  assert.equal(many.filter((result) => result.status === 429).length, 3);
  const rows = (await db.prepare("SELECT * FROM receipts").all()).results;
  assert.equal(rows.length, 10);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["created_at", "digest", "id", "ip_hash", "state"]);
  assert.ok(!JSON.stringify(rows).includes("Synthetic report"));
  assert.ok(!JSON.stringify(rows).includes("192.0.2.1"));
  const now = Date.now();
  await db.batch(Array.from({ length: 90 }, () => db.prepare("INSERT INTO receipts VALUES (?, ?, ?, ?, 'pending')").bind(randomUUID(), "hash", "other-ip", now)));
  assert.equal((await post("/v1/feedback", report(), "192.0.2.2")).status, 429, "global daily cap must cover other IPs");
  console.log("Worker integration passed: real D1 + email binding, concurrent dedup, conflicts, unknown outcomes, quotas, privacy and validation.");
} finally { await mf.dispose(); }
