import { createHash } from "node:crypto";
import { abortableDelay, requestSignal } from "../shared/abort.ts";
import { FEEDBACK_MAX_REPORT_BYTES, isFeedbackAcknowledgement, isFeedbackReport, readBoundedFeedbackBody, type FeedbackReport } from "../shared/feedback-wire.ts";

export const FEEDBACK_ENDPOINT = "https://neko-feedback.holilihu.online/v1/feedback";
export type FeedbackDelivery = "accepted" | "unknown" | "rejected" | "not_sent";

export async function sendFeedback(report: FeedbackReport, signal?: AbortSignal): Promise<FeedbackDelivery> {
  if (signal?.aborted || !isFeedbackReport(report)) return "not_sent";
  const body = JSON.stringify(report);
  if (Buffer.byteLength(body) > FEEDBACK_MAX_REPORT_BYTES) return "not_sent";
  const deadline = requestSignal(signal, 30_000);
  const receipt = JSON.stringify({ reportId: report.reportId, digest: createHash("sha256").update(body).digest("hex") });
  const request = async (url: string, payload: string) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, redirect: "error", signal: deadline, credentials: "omit" });
    const data: unknown = JSON.parse(await readBoundedFeedbackBody(response.body, 1024));
    const state = isFeedbackAcknowledgement(data) ? data.state : "unknown";
    return { status: response.status, state };
  };
  try {
    let result = await request(FEEDBACK_ENDPOINT, body);
    if ([400, 413, 415, 429].includes(result.status)) return "rejected";
    for (let attempt = 0; attempt < 12; attempt++) {
      if (result.status === 200 && result.state === "accepted") return "accepted";
      if (![200, 202].includes(result.status) || result.state !== "pending") return "unknown";
      await abortableDelay(1500, deadline);
      result = await request(`${FEEDBACK_ENDPOINT}/status`, receipt);
    }
  } catch { return "unknown"; }
  return "unknown";
}
