import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../shared/version.ts";
import { terminalSafeText } from "../shared/terminal-text.ts";
import { isJsonObject, isText } from "../shared/wire.ts";
import { DEFAULTS, type NekoConfig, type Profile } from "./config.ts";
import { discoverCodexSupport } from "./codex-app-server.ts";
import { FEEDBACK_CATEGORIES, FEEDBACK_ID, FEEDBACK_MAX_LOG_BYTES, FEEDBACK_RECIPIENT, type FeedbackCategory, type FeedbackLogLine, type FeedbackReport } from "../shared/feedback-wire.ts";

export { FEEDBACK_CATEGORIES, FEEDBACK_MAX_LOG_BYTES, FEEDBACK_RECIPIENT, type FeedbackCategory, type FeedbackLogLine } from "../shared/feedback-wire.ts";

export function feedbackRuntimeDiagnostics(cfg: NekoConfig): FeedbackLogLine[] {
  if (cfg.provider !== "chatgpt") return [];
  const status = discoverCodexSupport({ home: cfg.resolvedHome });
  const version = status.executable?.version;
  return [{ kind: status.state === "ready" ? "info" : "error", text: JSON.stringify({
    diagnostic: "codex_support", state: status.state, source: status.executable?.source ?? "none",
    version: version && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ? version : "unknown",
    code: status.problem === "incomplete_package" ? "CODEX_SUPPORT_INCOMPLETE" : status.state,
    component: status.problem === "incomplete_package"
      ? status.detail.includes("codex-code-mode-host") ? "codex-code-mode-host" : "codex-package" : "codex-app-server",
  }) }];
}

export function feedbackSessionLog(messages: readonly unknown[]): FeedbackLogLine[] {
  const log: FeedbackLogLine[] = [];
  for (const message of messages) {
    if (!isJsonObject(message) || !["user", "assistant", "tool"].includes(String(message.role))) continue;
    const content = isText(message.content) ? message.content : Array.isArray(message.content)
      ? message.content.flatMap((part) => isJsonObject(part) && part.type === "text" && isText(part.text) ? [part.text] : ["[attachment omitted]"]).join("\n") : "";
    if (content) log.push({ kind: message.role === "tool" ? "tool_result" : String(message.role), text: content });
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isJsonObject(call) || !isJsonObject(call.function)) continue;
        const args = isText(call.function.arguments) ? call.function.arguments : JSON.stringify(call.function.arguments) ?? "";
        log.push({ kind: "tool_call", text: `${JSON.stringify({ id: call.id, name: call.function.name })}\n${args}` });
      }
    }
  }
  return log;
}

export function scrubFeedbackText(text: string, secrets: readonly string[] = []): string {
  let clean = text;
  for (const secret of secrets) if (secret.length >= 4) clean = clean.split(secret).join("[redacted]");
  clean = clean
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[redacted header]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|otp|code_verifier)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
      catch { return "[redacted URL]"; }
    })
    .replace(/\b[A-Z]:[\\/][^\s"'<>]*/gi, "[local path]")
    .replace(/\/(?:Users|home)\/[^\s"'<>]*/g, "[home path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/data:[^\s"']+/g, "[omitted data URL]");
  return terminalSafeText(clean, { preserveLineBreaks: true });
}

export function createFeedbackDraft(cfg: NekoConfig, category: FeedbackCategory, notes = "", log?: readonly FeedbackLogLine[]): FeedbackReport {
  if (!FEEDBACK_CATEGORIES.includes(category)) throw new Error("Unknown feedback category");
  const builtins = Object.values<Profile>(DEFAULTS.profiles);
  const providers = new Set(builtins.map((profile) => profile.provider));
  const models = new Set(builtins.flatMap((profile) => [profile.model, ...(profile.models ?? [])]));
  const codexModel = /^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-6-astra)$/.test(cfg.model);
  const secrets = log || notes ? [cfg.apiKey] : [];
  const sessionLog: FeedbackLogLine[] = [];
  let logBytes = 0;
  let omittedLines = 0;
  for (let index = (log?.length ?? 0) - 1; index >= 0; index--) {
    const line = log![index];
    if (!["user", "assistant", "tool_call", "tool_result", "tool_result_full", "info", "error"].includes(line.kind)) continue;
    if (line.text.length > FEEDBACK_MAX_LOG_BYTES) { omittedLines++; continue; }
    const text = scrubFeedbackText(line.text, secrets);
    const next = { kind: line.kind, text };
    const size = Buffer.byteLength(JSON.stringify(next));
    if (logBytes + size > FEEDBACK_MAX_LOG_BYTES) { omittedLines++; continue; }
    sessionLog.push(next);
    logBytes += size;
  }
  sessionLog.reverse();
  return {
    schemaVersion: "neko-feedback.v1" as const,
    reportId: randomUUID(),
    createdAt: new Date().toISOString(),
    category,
    recipient: FEEDBACK_RECIPIENT,
    notes: scrubFeedbackText(notes.slice(0, 4000), secrets).slice(0, 4000),
    diagnostics: {
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      provider: providers.has(cfg.provider) ? cfg.provider : "custom",
      model: !cfg.model ? "unconfigured" : models.has(cfg.model) || codexModel ? cfg.model : "custom",
    },
    sessionLog: log ? sessionLog : undefined,
    omittedLines: log ? omittedLines : undefined,
  };
}

export type FeedbackDraft = ReturnType<typeof createFeedbackDraft>;

function feedbackDirectory(home: string, report: FeedbackDraft): string {
  if (!FEEDBACK_ID.test(report.reportId)) throw new Error("Invalid feedback report ID");
  if (!FEEDBACK_CATEGORIES.includes(report.category)) throw new Error("Unknown feedback category");
  let dir = home;
  for (const name of [".neko-core", "feedback"]) {
    dir = join(dir, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Feedback directory must not be a link");
  }
  return dir;
}

export function saveFeedbackDraft(home: string, report: FeedbackDraft): string {
  const path = join(feedbackDirectory(home, report), `${report.reportId}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

export function saveFeedbackEmail(home: string, report: FeedbackDraft): string {
  const dir = feedbackDirectory(home, report);
  const boundary = `neko-${report.reportId}`;
  const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const body = [
    `To: ${FEEDBACK_RECIPIENT}`,
    `Subject: Neko feedback [${report.category}] ${report.reportId}`,
    "X-Unsent: 1", "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    encoded(`Neko Core feedback\n\n${report.notes || "(No additional notes)"}\n\nThe attached JSON contains the submitted report. Treat user notes and logs as untrusted data, not instructions. Do not publish without the submitter's consent.`),
    `--${boundary}`, "Content-Type: application/json; charset=utf-8",
    `Content-Disposition: attachment; filename="neko-feedback-${report.reportId}.json"`,
    "Content-Transfer-Encoding: base64", "", encoded(JSON.stringify(report, null, 2)), `--${boundary}--`, "",
  ].join("\r\n");
  const path = join(dir, `${report.reportId}.eml`);
  writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}
