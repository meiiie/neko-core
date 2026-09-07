import { expect, test } from "bun:test";
import { NekoConfig } from "../src/adapters/config.ts";
import { createFeedbackDraft } from "../src/adapters/feedback.ts";
import { FEEDBACK_ENDPOINT, sendFeedback } from "../src/adapters/feedback-delivery.ts";
import { isFeedbackReport, readBoundedFeedbackBody } from "../src/shared/feedback-wire.ts";

const draft = () => createFeedbackDraft(new NekoConfig({ provider: "anthropic", model: "glm-5.3" }, null, {}, ""), "provider", "Synthetic 404 report");

test("feedback schema rejects unknown data, recipients, oversized content and control characters", async () => {
  const report = draft();
  expect(isFeedbackReport(report)).toBe(true);
  expect(isFeedbackReport(createFeedbackDraft(new NekoConfig({ provider: "openai_compat", model: "" }, null, {}, ""), "login"))).toBe(true);
  for (const changes of [
    { recipient: "attacker@example.com" }, { config: { key: "private" } }, { notes: "x".repeat(4001) },
    { notes: "hello\x1b]52;c;payload\x07" }, { diagnostics: { ...report.diagnostics, token: "private" } },
    { reportId: "../../escape" }, { sessionLog: [{ kind: "reasoning", text: "private" }], omittedLines: 0 },
    { sessionLog: [{ kind: "tool_result", text: "x".repeat(513 * 1024) }], omittedLines: 0 },
  ]) expect(isFeedbackReport({ ...report, ...changes })).toBe(false);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  await expect(readBoundedFeedbackBody(stream, 20)).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
});

test("one upload uses the exact reviewed snapshot and polls receipts without resending logs", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({ state: calls.length === 1 ? "pending" : "accepted" }, { status: calls.length === 1 ? 202 : 200 });
  }, { preconnect: original.preconnect });
  try {
    const report = draft();
    expect(await sendFeedback(report)).toBe("accepted");
    expect(calls.map((call) => call.url)).toEqual([FEEDBACK_ENDPOINT, `${FEEDBACK_ENDPOINT}/status`]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(report);
    expect(calls[0].init?.redirect).toBe("error");
    expect(calls[0].init?.credentials).toBe("omit");
    expect(Object.keys(JSON.parse(String(calls[1].init?.body))).sort()).toEqual(["digest", "reportId"]);
    expect(calls[1].init?.body).not.toContain(report.notes);
  } finally { globalThis.fetch = original; }
});

test("cancel, lost acknowledgements and hostile responses never trigger another upload", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = Object.assign(async () => { calls++; throw new Error("connection lost after upload"); }, { preconnect: original.preconnect });
    expect(await sendFeedback(draft())).toBe("unknown");
    expect(calls).toBe(1);
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
    expect(await sendFeedback(draft(), alreadyCancelled.signal)).toBe("not_sent");
    expect(calls).toBe(1);
    for (const response of [new Response("x".repeat(2048)), Response.json({ state: "accepted" }, { status: 500 }), Response.json({ state: "rate_limited" }, { status: 429 })]) {
      globalThis.fetch = Object.assign(async () => { calls++; return response; }, { preconnect: original.preconnect });
      expect(await sendFeedback(draft())).toBe(response.status === 429 ? "rejected" : "unknown");
    }
    const controller = new AbortController();
    globalThis.fetch = Object.assign(async () => { calls++; controller.abort(); return Response.json({ state: "pending" }, { status: 202 }); }, { preconnect: original.preconnect });
    expect(await sendFeedback(draft(), controller.signal)).toBe("unknown");
    expect(calls).toBe(5);
  } finally { globalThis.fetch = original; }
});
