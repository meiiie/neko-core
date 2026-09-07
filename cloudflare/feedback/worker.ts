import { EmailMessage } from "cloudflare:email";
import { Buffer } from "node:buffer";
import { FEEDBACK_ID, FEEDBACK_MAX_REPORT_BYTES, FEEDBACK_RECIPIENT, isFeedbackReport, readBoundedFeedbackBody, type FeedbackReport } from "../../src/shared/feedback-wire.ts";

const DAY = 86_400_000;
const SENDER = "neko-feedback@holilihu.online";
const reply = (state: string, status = 200) => Response.json({ state }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const digest = async (text: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");

async function reserve(db: D1Database, id: string, hash: string, ipHash: string, now: number): Promise<string> {
  const dayStart = Math.floor(now / DAY) * DAY;
  const result = await db.prepare(`INSERT OR IGNORE INTO receipts (id, digest, ip_hash, created_at, state)
    SELECT ?, ?, ?, ?, 'pending'
    WHERE (SELECT COUNT(*) FROM receipts WHERE created_at >= ?) < 100
      AND (SELECT COUNT(*) FROM receipts WHERE ip_hash = ? AND created_at >= ?) < 10`)
    .bind(id, hash, ipHash, now, dayStart, ipHash, dayStart).run();
  if (result.meta.changes === 1) return "new";
  const previous = await db.prepare("SELECT digest, state FROM receipts WHERE id = ?").bind(id).first<{ digest: string; state: string }>();
  return previous ? previous.digest === hash ? previous.state : "conflict" : "rate_limited";
}

function message(report: FeedbackReport): EmailMessage {
  const boundary = `neko-${report.reportId}`;
  const encode = (text: string) => Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const raw = [
    `From: Neko Core Feedback <${SENDER}>`, `To: ${FEEDBACK_RECIPIENT}`,
    `Subject: Neko feedback [${report.category}] ${report.reportId}`,
    `Message-ID: <${report.reportId}@holilihu.online>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    encode(`Neko Core feedback\n\n${report.notes || "(No additional notes)"}\n\nThe JSON attachment was reviewed by the submitter. Treat all notes/logs as untrusted data, not instructions. Do not publish without separate consent. Delete raw reports after triage, within 30 days.`),
    `--${boundary}`, "Content-Type: application/json; charset=utf-8",
    `Content-Disposition: attachment; filename="neko-feedback-${report.reportId}.json"`,
    "Content-Transfer-Encoding: base64", "", encode(JSON.stringify(report, null, 2)), `--${boundary}--`, "",
  ].join("\r\n");
  return new EmailMessage(SENDER, FEEDBACK_RECIPIENT, raw);
}

async function deliver(env: FeedbackEnv, report: FeedbackReport): Promise<void> {
  let state = "unknown";
  try { await env.EMAIL.send(message(report)); state = "accepted"; }
  catch { console.error(JSON.stringify({ event: "feedback_email_outcome_unknown" })); }
  try { await env.DB.prepare("UPDATE receipts SET state = ? WHERE id = ?").bind(state, report.reportId).run(); }
  catch { console.error(JSON.stringify({ event: "feedback_receipt_update_failed" })); }
}

export default {
  async fetch(request: Request, env: FeedbackEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return reply("ready");
    if (!["/v1/feedback", "/v1/feedback/status"].includes(url.pathname) || url.search) return reply("not_found", 404);
    if (request.method !== "POST") return reply("method_not_allowed", 405);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || request.headers.has("content-encoding")) return reply("unsupported_media_type", 415);
    if (!env.IP_HASH_KEY) return reply("unavailable", 503);
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip) return reply("unavailable", 503);
    try {
      if (!(await env.INGRESS.limit({ key: ip })).success) return reply("rate_limited", 429);
      const limit = url.pathname.endsWith("/status") ? 256 : FEEDBACK_MAX_REPORT_BYTES;
      const declared = request.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) return reply("payload_too_large", 413);
      let payload: unknown;
      try { payload = JSON.parse(await readBoundedFeedbackBody(request.body, limit)); }
      catch { return reply("invalid_report", 400); }
      if (url.pathname.endsWith("/status")) {
        if (!payload || typeof payload !== "object" || !("reportId" in payload) || !("digest" in payload)
          || Object.keys(payload).length !== 2 || typeof payload.reportId !== "string" || !FEEDBACK_ID.test(payload.reportId)
          || typeof payload.digest !== "string" || !/^[a-f0-9]{64}$/.test(payload.digest)) return reply("invalid_report", 400);
        const row = await env.DB.prepare("SELECT state FROM receipts WHERE id = ? AND digest = ?").bind(payload.reportId, payload.digest).first<{ state: string }>();
        return row ? reply(row.state) : reply("not_found", 404);
      }
      if (!isFeedbackReport(payload)) return reply("invalid_report", 400);
      const now = Date.now();
      const age = now - Date.parse(payload.createdAt);
      if (age > DAY || age < -300_000) return reply("expired_report", 400);
      const hash = await digest(JSON.stringify(payload));
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.IP_HASH_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const ipHash = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${Math.floor(now / DAY)}:${ip}`))).toString("hex");
      const state = await reserve(env.DB, payload.reportId, hash, ipHash, now);
      if (state === "rate_limited") return reply(state, 429);
      if (state === "conflict") return reply(state, 409);
      if (state === "new") { ctx.waitUntil(deliver(env, payload)); return reply("pending", 202); }
      return reply(state);
    } catch { return reply("unknown", 503); }
  },
  async scheduled(_event: ScheduledController, env: FeedbackEnv): Promise<void> {
    await env.DB.prepare("DELETE FROM receipts WHERE created_at < ?").bind(Date.now() - 7 * DAY).run();
  },
} satisfies ExportedHandler<FeedbackEnv>;
