import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NekoConfig } from "../src/adapters/config.ts";
import { createFeedbackDraft, feedbackRuntimeDiagnostics, feedbackSessionLog, FEEDBACK_MAX_LOG_BYTES, FEEDBACK_RECIPIENT, saveFeedbackDraft, saveFeedbackEmail, scrubFeedbackText } from "../src/adapters/feedback.ts";
import { writeCodexPackageFixture } from "./fixtures/codex-package.ts";
import type { FeedbackReport } from "../src/shared/feedback-wire.ts";
import { flattenLines } from "../src/ui/scroll.tsx";
import { runSlashCommand } from "../src/ui/commands.ts";
import type { Overlay } from "../src/ui/select-list.tsx";

interface FeedbackUIState { overlay: Overlay | null; preview: string; finishPreview?: () => void }

test("support diagnostics identify a missing code-mode host without reading credentials or exposing paths", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "neko-feedback-diagnostic-"));
  const originalPath = process.env.PATH;
  const originalCodexPath = process.env.NEKO_CODEX_PATH;
  process.env.PATH = "";
  delete process.env.NEKO_CODEX_PATH;
  try {
    const root = join(taskHome, ".neko-core", "codex-support");
    writeCodexPackageFixture(root, "0.153.4");
    rmSync(join(root, "bin", `codex-code-mode-host${process.platform === "win32" ? ".exe" : ""}`));
    const cfg = new NekoConfig({ provider: "chatgpt", model: "gpt-6-astra" }, "private-profile", {}, "", null, [], undefined, taskHome);
    Object.defineProperty(cfg, "apiKey", { get: () => { throw new Error("must not access credentials"); } });
    const diagnostics = feedbackRuntimeDiagnostics(cfg);
    expect(JSON.parse(diagnostics[0].text)).toMatchObject({ state: "invalid", code: "CODEX_SUPPORT_INCOMPLETE", component: "codex-code-mode-host", version: "0.153.4" });
    expect(JSON.stringify(diagnostics)).not.toMatch(/neko-feedback-diagnostic-|private-profile|\.exe|[A-Z]:/);
    expect(feedbackRuntimeDiagnostics(new NekoConfig({ provider: "anthropic", model: "glm-5.3" }, null, {}, ""))).toEqual([]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalCodexPath === undefined) delete process.env.NEKO_CODEX_PATH; else process.env.NEKO_CODEX_PATH = originalCodexPath;
    rmSync(taskHome, { recursive: true, force: true });
  }
});

test("feedback opt-in can be revoked, edits refresh the exact snapshot, and duplicate send clicks are ignored", async () => {
  const taskHome = mkdtempSync(join(tmpdir(), "neko-feedback-consent-"));
  try {
    const state: FeedbackUIState = { overlay: null, preview: "" };
    let logReads = 0;
    const submitted: FeedbackReport[] = [];
    const ctx: any = {
      cfg: new NekoConfig({ provider: "anthropic", model: "glm-5.3" }, null, {}, "", null, [], undefined, taskHome),
      setOverlay: (value: Overlay | null) => { state.overlay = value; },
      feedbackLog: () => { logReads++; return [{ kind: "user", text: "private conversation" }]; },
      feedbackDiagnostics: () => [{ kind: "error", text: "CODEX_SUPPORT_INCOMPLETE" }],
      previewFeedback: (text: string, onClose: () => void) => { state.preview = text; state.finishPreview = onClose; },
      submitFeedback: async (report: FeedbackReport) => { submitted.push(report); },
      addLine: () => {},
    };
    const overlay = () => { if (!state.overlay) throw new Error("Missing feedback screen"); return state.overlay; };
    const choose = (id: string) => overlay().onSelect({ id, label: id });
    await runSlashCommand("/feedback", ctx);
    overlay().textInput!.onSubmit("original description");
    expect(logReads).toBe(0);
    choose("logs"); choose("preview");
    expect(JSON.parse(state.preview).sessionLog).toContainEqual({ kind: "user", text: "private conversation" });
    state.finishPreview!(); choose("logs");
    expect(logReads).toBe(1);
    choose("edit");
    expect(overlay().textInput!.initialValue).toBe("original description");
    overlay().textInput!.onSubmit("updated description");
    choose("preview");
    const report = JSON.parse(state.preview);
    expect(report.notes).toBe("updated description");
    expect(report.sessionLog).toEqual([{ kind: "error", text: "CODEX_SUPPORT_INCOMPLETE" }]);
    state.finishPreview!();
    const send = overlay().onSelect;
    send({ id: "send", label: "Send" }); send({ id: "send", label: "Send" });
    expect(submitted).toEqual([report]);
    const dir = join(taskHome, ".neko-core", "feedback");
    expect(readdirSync(dir)).toEqual([`${report.reportId}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${report.reportId}.json`), "utf8"))).toEqual(report);
  } finally { rmSync(taskHome, { recursive: true, force: true }); }
});

test("feedback is an allowlisted projection, not a redacted dump of config or sessions", () => {
  const cfg = new NekoConfig({ provider: "anthropic", model: "glm-5.3", base_url: "https://secret.example/?token=SECRET", cookie: "SECRET" }, "private-company-account", {}, "SECRET");
  Object.defineProperty(cfg, "apiKey", { get: () => { throw new Error("must not access credentials"); } });
  const report = createFeedbackDraft(cfg, "provider");
  expect(report.diagnostics).toMatchObject({ provider: "anthropic", model: "glm-5.3" });
  expect(Object.keys(JSON.parse(JSON.stringify(report))).sort()).toEqual(["category", "createdAt", "diagnostics", "notes", "recipient", "reportId", "schemaVersion"]);
  expect(JSON.stringify(report)).not.toMatch(/SECRET|private-company|secret\.example/);
  const custom = createFeedbackDraft(new NekoConfig({ provider: "private-provider", model: "user@example.com" }, null, {}, ""), "other");
  expect(custom.diagnostics).toMatchObject({ provider: "custom", model: "custom" });
});

test("feedback defaults to no conversation, preserves the preview snapshot, and exports through more options", async () => {
  const taskHome = mkdtempSync(join(tmpdir(), "neko-feedback-"));
  try {
    const state: FeedbackUIState = { overlay: null, preview: "" };
    const lines: string[] = [];
    const cfg = new NekoConfig({ provider: "chatgpt", model: "gpt-6-astra" }, "chatgpt", {}, "", null, [], undefined, taskHome);
    const ctx: any = {
      cfg,
      agent: { get messages() { throw new Error("must not read session messages"); } },
      setOverlay: (value: Overlay | null) => { state.overlay = value; },
      feedbackLog: () => { throw new Error("no consent to read session logs"); },
      previewFeedback: (text: string, onClose: () => void) => { state.preview = text; state.finishPreview = onClose; },
      addLine: (_kind: string, text: string) => lines.push(text),
    };
    const selected = () => {
      if (!state.overlay) throw new Error("Expected a feedback overlay");
      return state.overlay;
    };
    await runSlashCommand("/feedback", ctx);
    selected().textInput!.onSubmit("Login stops at an error");
    expect(selected().items.some((item) => item.id === "save")).toBe(false);
    selected()!.onSelect({ id: "cancel", label: "Cancel" });
    expect(existsSync(join(taskHome, ".neko-core", "feedback"))).toBe(false);
    await runSlashCommand("/feedback", ctx);
    selected().textInput!.onSubmit("API returned 404");
    selected().onSelect({ id: "preview", label: "Review" });
    const preview = JSON.parse(state.preview);
    expect(preview.notes).toBe("API returned 404");
    expect(preview.sessionLog).toBeUndefined();
    expect(preview.recipient).toBe(FEEDBACK_RECIPIENT);
    state.finishPreview!();
    selected().onSelect({ id: "more", label: "More options" });
    selected()!.onSelect({ id: "save", label: "Save" });
    const dir = join(taskHome, ".neko-core", "feedback");
    expect(readdirSync(dir)).toEqual([`${preview.reportId}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${preview.reportId}.json`), "utf8"))).toEqual(preview);
    expect(lines.join("\n")).toContain("NOT sent");
    expect(() => saveFeedbackDraft(taskHome, preview)).toThrow();
    expect(readdirSync(dir)).toHaveLength(1);
    await runSlashCommand("/feedback secret text", ctx);
    expect(lines.at(-1)).not.toContain("secret text");
  } finally { rmSync(taskHome, { recursive: true, force: true }); }
});

test("the email attachment is the reviewed report, headers cannot redirect it, and secret-bearing stores are absent", () => {
  const taskHome = mkdtempSync(join(tmpdir(), "neko-feedback-email-"));
  try {
    const cfg = new NekoConfig({ provider: "anthropic", model: "glm-5.3" }, "zai", {}, "known-credential-value");
    const report = createFeedbackDraft(cfg, "provider", "Lỗi đăng nhập known-credential-value", [
      { kind: "user", text: "Xem giúp C:\\Users\\Alice\\private.txt" },
      { kind: "tool_call", text: 'Authorization: Bearer hidden-token\n{"password":"my pass phrase","api_key":"123456"}' },
      { kind: "error", text: 'HTTP 404 https://api.z.ai/api/paas/v4/v1/messages?token=secret-value\ncontact: user@example.com' },
      { kind: "reasoning", text: "opaque provider data" },
      { kind: "tool_result", text: "x".repeat(FEEDBACK_MAX_LOG_BYTES + 1) },
    ]);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/known-credential|hidden-token|my pass phrase|123456|secret-value|user@example|Alice|opaque provider/);
    expect(json).toContain("/api/paas/v4/v1/messages");
    expect(report.sessionLog).toHaveLength(3);
    expect(report.omittedLines).toBe(1);
    const path = saveFeedbackEmail(taskHome, report);
    const email = readFileSync(path, "utf8");
    expect(email).toContain(`To: ${FEEDBACK_RECIPIENT}\r\n`);
    expect(email).toContain("X-Unsent: 1");
    expect(email).not.toContain("Bcc:");
    const attachment = email.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split(`\r\n--neko-${report.reportId}--`)[0];
    expect(JSON.parse(Buffer.from(attachment, "base64").toString("utf8"))).toEqual(report);
    expect(() => saveFeedbackEmail(taskHome, report)).toThrow();
    // SAFETY: deliberately malformed wire input exercises the runtime header-injection guard.
    expect(() => saveFeedbackEmail(taskHome, { ...report, category: "other\r\nBcc: attacker@example.com" as never })).toThrow();
  } finally { rmSync(taskHome, { recursive: true, force: true }); }
});

test("feedback scrubs opaque tokens, PEM keys, signed links, cookies, and terminal escapes", () => {
  const clean = scrubFeedbackText('sk-ant-oat-super-secret-value eyJab.eyJcd.signature\nCookie: sid=abc; auth=def\nhttps://user:pass@example.com/path?code=private#token\n-----BEGIN RSA PRIVATE KEY-----\nsecret bytes\n-----END RSA PRIVATE KEY-----\n\x1b]52;c;BASE64\x07');
  expect(clean).not.toMatch(/super-secret|eyJab|sid=abc|auth=def|user:pass|code=private|secret bytes|\x1b|\x07/);
});

test("feedback keeps full tool evidence without UI folding and omits hidden provider state", () => {
  const toolOutput = Array.from({ length: 450 }, (_, index) => `output-${index}`).join("\n");
  const log = feedbackSessionLog([
    { role: "system", content: "private system instructions" },
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,private-image" } }] },
    { role: "assistant", content: "Checking", reasoning_content: "hidden thoughts", provider_data: [{ encrypted_content: "opaque-data" }], tool_calls: [{ id: "call-1", function: { name: "bash", arguments: '{"command":"echo hello"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: toolOutput },
  ]);
  expect(log.at(-1)?.text).toBe(toolOutput);
  expect(log.find((line) => line.kind === "tool_call")?.text).toContain("call-1");
  expect(JSON.stringify(log)).not.toMatch(/private system|private-image|hidden thoughts|opaque-data/);
  const preview = [{ id: 1, kind: "info" as const, text: toolOutput }];
  expect(flattenLines(preview, 80, true).at(-2)?.text).toContain("output-449");
  expect(flattenLines(preview, 80).some((line) => line.text.includes("more lines"))).toBe(true);
});

test("canonical tool arguments are scrubbed before report JSON encoding", () => {
  const log = feedbackSessionLog([{ role: "assistant", tool_calls: [{ id: "call-1", function: {
    name: "integration", arguments: JSON.stringify({ api_key: "synthetic-credential-value", password: "synthetic pass phrase", project: "example" }),
  } }] }]);
  const report = createFeedbackDraft(new NekoConfig({ provider: "anthropic", model: "glm-5.3" }, null, {}, ""), "other", "", log);
  expect(JSON.stringify(report)).not.toMatch(/synthetic-credential-value|synthetic pass phrase/);
  expect(report.sessionLog?.[0]?.text).toContain("call-1");
  expect(report.sessionLog?.[0]?.text).toContain("example");
});
