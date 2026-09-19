/**
 * Required-artifact gates for long-horizon harness completion.
 *
 * Inspired by harness-design findings (Fan et al. arXiv:2609.20804): cheap rule-based
 * checks before LLM "I'm done" claims; StateM (arXiv:2608.15089) checked transitions /
 * anti-premature-stop; AutoSaddler offline failure-trace practices; openJiuwen
 * (arXiv:2608.27969) runtime adaptivity from execution evidence.
 *
 * Deliberately task-id-free: extract explicit paths and verifier mentions from the
 * instruction text only — never bake Terminal-Bench canaries or golden solutions.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

const ABS_WORKSPACE_PATH =
  /(?:^|[\s"'`=(])(\/(?:app|home|workspace|data|opt|var\/tmp)\/[A-Za-z0-9._\/+\-]+(?:\.[A-Za-z0-9]{1,12})?)/g;

const CREATE_FILE_PATH =
  /\b(?:write|create|produce|generate|save|emit|output|build|make|put)\b[^.\n]{0,100}?((?:\/(?:app|home|workspace)\/)?[A-Za-z0-9._\/\-]+\.(?:comp|html?|json|toml|ya?ml|cpp|hpp|cc|rs|txt|py|md|csv|xml|bin|out|sh|js|ts|c|h))/gi;

const REDIRECT_OUT =
  /(?:(?:>{1,2})\s*)((?:\/(?:app|home|workspace)\/)?[A-Za-z0-9._\/\-]+\.(?:html?|txt|json|csv|out|log|comp))/gi;

const CURL_FILE =
  /\bcurl\b[^\n]{0,120}?\/((?:[A-Za-z0-9._\-]+\.(?:html?|json|txt|csv)))/gi;

const PROVIDED_WINDOW =
  /\b(?:provided|already(?:\s+exists)?|existing|i have|look at|given|starter|template|reference|decompressor in|simulator[:\s]|file\s+\/app\/\w+\.(?:c|py|h)\s+is)\b/i;

const VERIFIER_MENTION =
  /\b((?:\/(?:app|home|workspace)\/)?(?:check|verify|validate|test|run_tests?|pytest|cargo\s+test|npm\s+test|bun\s+test)(?:\.(?:py|sh|bash|js|ts))?)\b/gi;

const DELIVERABLE_SIGNAL =
  /(?:\/(?:app|home|workspace)\/|\b(?:write|create|produce|generate)\b[^.\n]{0,80}\.(?:rs|json|html?|txt|comp)\b|\bcurl\b[^\n]{0,80}\.(?:html?|json))/i;

function cleanPath(raw: string): string {
  return String(raw ?? "")
    .replace(/[),.;:]+$/g, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();
}

function nearProvided(text: string, path: string): boolean {
  const i = text.indexOf(path);
  if (i < 0) return false;
  // Only inspect context BEFORE the path so a later "look at the provided helper"
  // cannot mark an earlier create/write deliverable as provided input.
  const window = text.slice(Math.max(0, i - 120), i);
  return PROVIDED_WINDOW.test(window);
}

/** Explicit deliverable paths named by the instruction (rule-based elision; no LLM). */
export function extractRequiredArtifactPaths(instruction: string): string[] {
  const text = String(instruction ?? "");
  if (!text.trim()) return [];
  const found = new Set<string>();

  const consider = (raw: string) => {
    const path = cleanPath(raw);
    if (!path || path.length < 3 || path.length > 240) return;
    if (path.includes("://")) return;
    if (nearProvided(text, path)) return;
    // Skip bare language/tool names mistaken for files
    if (/^(?:json|html|text|python|rust|bash|curl|git)$/i.test(path)) return;
    found.add(path);
  };

  for (const re of [CREATE_FILE_PATH, REDIRECT_OUT, CURL_FILE, ABS_WORKSPACE_PATH]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const raw = match[1] ?? match[0];
      consider(raw);
    }
  }

  // Prefer create/redirect/curl hits; if we only have abs paths, keep those that look like files
  // (have an extension or a final path segment with a dot).
  return [...found].filter((path) => {
    const base = path.split("/").pop() ?? path;
    return base.includes(".") || path.startsWith("/app/") || path.startsWith("/workspace/");
  }).sort();
}

/** Resolve an instruction path against the agent workspace root. */
export function resolveArtifactPath(root: string, artifactPath: string): string {
  const cleaned = cleanPath(artifactPath);
  if (!cleaned) return normalize(root);
  if (isAbsolute(cleaned)) return normalize(cleaned);
  return normalize(join(root, cleaned));
}

export interface MissingArtifact {
  path: string;
  resolved: string;
  reason: "missing" | "empty";
}

/** Paths the instruction requires that are absent (or empty when requireNonEmpty). */
export function missingRequiredArtifacts(
  root: string,
  instruction: string,
  opts: { requireNonEmpty?: boolean } = {},
): MissingArtifact[] {
  const requireNonEmpty = opts.requireNonEmpty !== false;
  const missing: MissingArtifact[] = [];
  for (const path of extractRequiredArtifactPaths(instruction)) {
    const resolved = resolveArtifactPath(root, path);
    if (!existsSync(resolved)) {
      missing.push({ path, resolved, reason: "missing" });
      continue;
    }
    if (requireNonEmpty) {
      try {
        const st = statSync(resolved);
        if (st.isFile() && st.size <= 0) missing.push({ path, resolved, reason: "empty" });
      } catch {
        missing.push({ path, resolved, reason: "missing" });
      }
    }
  }
  return missing;
}

/** Verifier-like commands/scripts mentioned in the instruction (for practice nudges). */
export function extractMentionedVerifierCommands(instruction: string): string[] {
  const text = String(instruction ?? "");
  const found = new Set<string>();
  VERIFIER_MENTION.lastIndex = 0;
  for (const match of text.matchAll(VERIFIER_MENTION)) {
    const raw = cleanPath(match[1] ?? "");
    if (raw) found.add(raw.replace(/\s+/g, " "));
  }
  // Example invocations often look like: `python check.py`, `/app/sim 208`, `curl http://...`
  for (const match of text.matchAll(/`([^`\n]{3,120})`/g)) {
    const cmd = match[1].trim();
    if (/\b(?:check|verify|test|curl|pytest|\/app\/sim)\b/i.test(cmd)) found.add(cmd);
  }
  return [...found].sort();
}

/** Soft guidance: before DONE, re-check named artifacts / verifiers (AutoSaddler-style practice). */
export function failureTracePracticeGuidance(rawText: string): string {
  const text = String(rawText ?? "");
  if (!DELIVERABLE_SIGNAL.test(text)) return "";
  const artifacts = extractRequiredArtifactPaths(text);
  const verifiers = extractMentionedVerifierCommands(text);
  const lines = [
    "# Completion verification practice",
    "Before claiming DONE on a deliverable task:",
    "1. Confirm every explicit path the instruction asks you to create exists on disk (and is non-empty when content is required).",
    "2. Re-run verification commands or checks named in the task against the current files — not only the check you remember passing.",
    "3. If bash/tests failed earlier this run, treat that as unresolved debt: fix, then re-verify; do not stop while failures remain.",
  ];
  if (artifacts.length) {
    lines.push("Named deliverable paths to confirm:");
    for (const path of artifacts.slice(0, 12)) lines.push(`- ${path}`);
  }
  if (verifiers.length) {
    lines.push("Verifier mentions to re-run when applicable:");
    for (const cmd of verifiers.slice(0, 8)) lines.push(`- ${cmd}`);
  }
  return lines.join("\n");
}

/** Short closed-loop nudge when artifacts are still missing (StateM anti-premature-stop). */
export function missingArtifactReviewNudge(missing: MissingArtifact[]): string {
  if (!missing.length) return "";
  const list = missing.slice(0, 8).map((row) => `- ${row.path} (${row.reason})`).join("\n");
  return (
    `REQUIRED ARTIFACTS MISSING: do not claim DONE yet. Create or restore these paths, then re-verify:\n${list}`
  );
}

/** Short closed-loop nudge when recent bash/tests failed (openJiuwen execution-evidence adaptivity). */
export function failedVerificationReviewNudge(failures: string[]): string {
  if (!failures.length) return "";
  const list = failures.slice(-4).map((row) => `- ${row}`).join("\n");
  return (
    `UNRESOLVED FAILED CHECKS: recent bash/tests exited non-zero. Re-run the verifier commands named in the goal and fix failures before DONE:\n${list}`
  );
}

/** True when path stays inside root (or is an absolute workspace path we still allow checking). */
export function artifactPathIsPlausible(root: string, resolved: string): boolean {
  const rootNorm = normalize(root.endsWith(sep) ? root : root + sep);
  const resolvedNorm = normalize(resolved);
  if (resolvedNorm.startsWith(normalize(root))) return true;
  // Absolute /app paths in containers where registry.root may also be /app
  if (resolvedNorm.startsWith("/app/") || resolvedNorm === "/app") return true;
  void rootNorm;
  return false;
}
