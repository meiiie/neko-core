import { randomUUID } from "node:crypto";
import { FEEDBACK_ENDPOINT, sendFeedback } from "../../src/adapters/feedback-delivery.ts";
import { FEEDBACK_RECIPIENT, type FeedbackReport } from "../../src/shared/feedback-wire.ts";

if (!process.argv.includes("--send-synthetic")) throw new Error("Explicit --send-synthetic required: this sends one synthetic email to the fixed feedback inbox.");
const health = await fetch(new URL("/health", FEEDBACK_ENDPOINT), { signal: AbortSignal.timeout(15_000), redirect: "error" });
if (!health.ok || (await health.json()).state !== "ready") throw new Error("Feedback endpoint is not ready");
const report: FeedbackReport = {
  schemaVersion: "neko-feedback.v1", reportId: randomUUID(), createdAt: new Date().toISOString(),
  recipient: FEEDBACK_RECIPIENT, category: "other",
  notes: "NEKO FEEDBACK DELIVERY TEST. Synthetic data only: no user conversation, files or credentials. Please confirm that this email and JSON attachment arrived.",
  diagnostics: { version: "synthetic-smoke", platform: "test", arch: "test", provider: "test", model: "test" },
};
if (process.argv.includes("--large")) {
  report.sessionLog = [{ kind: "info", text: "Synthetic boundary test. ".repeat(20_000) }];
  report.omittedLines = 0;
}
console.log(JSON.stringify({ reportId: report.reportId, bytes: Buffer.byteLength(JSON.stringify(report)) }));
const outcome = await sendFeedback(report);
console.log(JSON.stringify({ outcome }));
if (outcome !== "accepted") throw new Error("Email acceptance unconfirmed. Do not automatically rerun this smoke test.");
const duplicate = await sendFeedback(report);
if (duplicate !== "accepted") throw new Error("Duplicate receipt was not preserved");
console.log("Synthetic email accepted; identical submission returns the existing receipt. Inbox delivery still requires mailbox confirmation.");
