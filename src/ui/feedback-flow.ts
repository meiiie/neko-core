import { createFeedbackDraft, FEEDBACK_CATEGORIES, FEEDBACK_RECIPIENT, saveFeedbackDraft, saveFeedbackEmail } from "../adapters/feedback.ts";
import type { FeedbackCategory, FeedbackReport } from "../shared/feedback-wire.ts";
import type { CommandCtx } from "./commands.ts";

export function openFeedback(ctx: CommandCtx): void {
  let notes = "";
  let category: FeedbackCategory = "other";
  let includeConversation = false;
  let report: FeedbackReport;
  let finished = false;
  const cancel = () => { finished = true; ctx.setOverlay(null); };
  const refresh = () => {
    const diagnostics = ctx.feedbackDiagnostics?.() ?? [];
    report = createFeedbackDraft(ctx.cfg, category, notes,
      includeConversation ? [...(ctx.feedbackLog?.() ?? []), ...diagnostics] : diagnostics.length ? diagnostics : undefined);
  };
  const save = async (kind: "send" | "email" | "save") => {
    if (finished || (kind === "send" && !ctx.submitFeedback)) return;
    finished = true;
    ctx.setOverlay(null);
    let path: string;
    try { path = kind === "email" ? saveFeedbackEmail(ctx.cfg.resolvedHome, report) : saveFeedbackDraft(ctx.cfg.resolvedHome, report); }
    catch { ctx.addLine("error", "Could not save the feedback draft. Nothing was sent."); return; }
    if (kind === "send") {
      try { await ctx.submitFeedback!(report, path); }
      catch { ctx.addLine("error", `Feedback delivery is unconfirmed. Do not resend automatically. Local copy: ${path}`); }
    } else ctx.addLine("info", `Feedback saved: ${path}\nNOT sent. Recipient: ${FEEDBACK_RECIPIENT}.`);
  };
  const edit = () => ctx.setOverlay({
    title: "Feedback 1/2 - describe the problem",
    description: "Private notes, never sent to the model. No conversation is shared unless you include it on the next screen.",
    items: [], onSelect: () => {}, onCancel: cancel,
    textInput: { initialValue: notes, placeholder: "What went wrong? What did you expect?", maxChars: 4000,
      onSubmit: (text) => { notes = text; refresh(); review(); } },
  });
  const more = () => ctx.setOverlay({
    title: "Feedback - more options", search: false, showCount: false, onCancel: review,
    items: [
      { id: "category", label: `Category: ${category}` },
      { id: "email", label: "Save email draft (.eml)" },
      { id: "save", label: "Save report (.json)" },
      { id: "back", label: "Back to review" },
    ],
    onSelect: (item) => {
      if (item.id === "category") ctx.setOverlay({
        title: "Feedback - optional category", search: false, showCount: false, onCancel: review,
        items: FEEDBACK_CATEGORIES.map((value) => ({ id: value, label: value })),
        onSelect: (choice) => {
          const value = FEEDBACK_CATEGORIES.find((value) => value === choice.id);
          if (value) { category = value; refresh(); review(); }
        },
      });
      else if (item.id === "email" || item.id === "save") void save(item.id);
      else review();
    },
  });
  const review = () => ctx.setOverlay({
    title: "Feedback 2/2 - review and send", search: false, showCount: false, onCancel: cancel,
    description: [
      `To: ${FEEDBACK_RECIPIENT} (private, via Cloudflare).`,
      `Notes: ${report.notes ? report.notes.replace(/\s+/g, " ").slice(0, 240) : "(none)"}${report.notes.length > 240 ? "… [full text in View data]" : ""}`,
      `Neko ${report.diagnostics.version} · ${report.diagnostics.platform}/${report.diagnostics.arch} · ${report.diagnostics.provider}/${report.diagnostics.model}`,
      `Basic diagnostics included; conversation ${includeConversation ? "ON" : "OFF"}. ${report.sessionLog?.length ?? 0} entries; ${report.omittedLines ?? 0} omitted.`,
      "Secret masking is best-effort. Check View data if needed. Sending shares this report only.",
    ].join("\n"),
    items: [
      ...(ctx.submitFeedback ? [{ id: "send", label: "Send feedback" }] : []),
      { id: "logs", label: `[${includeConversation ? "x" : " "}] Include conversation and tool logs`, detail: "May include source code or personal data" },
      { id: "preview", label: "View data to be sent" },
      { id: "edit", label: "Edit description" },
      { id: "more", label: "More options" },
      { id: "cancel", label: "Cancel" },
    ],
    onSelect: (item) => {
      if (finished) return;
      if (item.id === "send") void save("send");
      else if (item.id === "logs") { includeConversation = !includeConversation; refresh(); review(); }
      else if (item.id === "edit") edit();
      else if (item.id === "more") more();
      else if (item.id === "preview") {
        if (!ctx.previewFeedback) return ctx.addLine("error", "This client cannot display the attachment. Nothing was sent.");
        ctx.setOverlay(null);
        ctx.previewFeedback(JSON.stringify(report, null, 2), review);
      } else cancel();
    },
  });
  edit();
}
