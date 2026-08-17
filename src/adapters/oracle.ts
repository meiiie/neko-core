/**
 * The oracle: a second opinion from a stronger model, deliberately kept OUTSIDE the agent loop.
 *
 * The pattern (Peter Steinberger's `oracle`, and the "big model plans, executor builds" loop people
 * run around Codex) is not "call a better model instead". It is a division of labour: the executing
 * agent has the tools, the machine, and the short leash; the oracle has one very expensive shot at
 * reading a curated slice of the project and saying what it thinks. So the oracle here is given NO
 * tools. It cannot read, write, or run anything. It receives exactly the bytes this module packs and
 * returns judgement - a diagnosis, a plan keyed to real paths, and what would falsify it.
 *
 * Two properties are load-bearing, and both exist because this is the one Neko feature whose whole
 * job is to send your source code to somebody else's computer:
 *
 *   1. Nothing leaves silently. The bundle is a manifest: every file that went, every file that was
 *      skipped, and why. `--dry-run` prints the exact payload without a network call. The tool form
 *      is approval-gated (MCP tools default to gated) so an agent cannot consult on its own.
 *   2. Credentials are refused, not trimmed. A file that looks like a secret store is dropped whole;
 *      a credential-shaped literal inside an ordinary source file is masked in place. Precision
 *      matters here - masking `key = process.env.OPENAI_API_KEY` would corrupt the code the oracle is
 *      being asked to reason about - so only string LITERALS and known key shapes are touched.
 *
 * Which model answers is config, not code: `oracle.profile` names any profile Neko already has
 * (a ChatGPT subscription, Claude, Gemini, Grok, or a local server). There is no hardcoded vendor.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Provider } from "../core/ports.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";
import { loadConfig, type NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";

/** Directories never worth sending, and expensive to walk. Mirrors tool-runtime's ignore set. */
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "dist", "build", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", "target", "vendor",
]);

/**
 * Files refused whole. A secret store has no legitimate reason to be in a bundle, and unlike a stray
 * literal there is nothing left worth reading once you mask it.
 */
const SECRET_FILES = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /(^|\/)(credentials|secrets?|token|tokens|auth)\.(json|ya?ml|toml|ini|txt)$/i,
  /(^|\/)\.neko-core\//i,
];

/** A private key block means the whole file is key material regardless of its name. */
const PRIVATE_KEY_BLOCK = /-----BEGIN[A-Z ]*PRIVATE KEY-----/;

/**
 * Credential-shaped STRING LITERALS. The literal must be long enough to be a real value, which is what
 * keeps `token: ""` and `apiKey: key` (a variable) intact.
 */
const CREDENTIAL_LITERAL =
  /((?:api[_-]?key|secret|password|passwd|token|credential|authorization|private[_-]?key)["']?\s*[:=]\s*["'`])([^"'`\n]{12,})(["'`])/gi;

/** Published key patterns, which are unmistakable wherever they appear. */
const KEY_PATTERNS =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|nvapi-[A-Za-z0-9_-]{16,})\b/g;

const ID_RE = /^orc_\d{8}T\d{6}_[a-z0-9]{6}$/;

export interface OracleLimits {
  /** Total bundle budget. Roughly four bytes per token for source text. */
  maxBytes: number;
  /** One file's share, so a single generated monster cannot eat the whole budget. */
  maxFileBytes: number;
  maxFiles: number;
}

export const DEFAULT_ORACLE_LIMITS: OracleLimits = {
  maxBytes: 400_000,
  maxFileBytes: 128_000,
  maxFiles: 80,
};

export interface BundleFile {
  path: string;
  bytes: number;
  text: string;
  masked: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface OracleBundle {
  question: string;
  files: BundleFile[];
  skipped: SkippedFile[];
  bytes: number;
  text: string;
}

export interface OracleSession {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  question: string;
  profile: string;
  model: string;
  files: string[];
  skipped: SkippedFile[];
  bytes: number;
  parent?: string;
}

/**
 * The oracle's role. It is told to be refutable rather than agreeable: a hedged answer is worthless to
 * an executor that has to choose, and an invented file path costs more than an admitted gap.
 */
export const ORACLE_SYSTEM_PROMPT = [
  "You are the Oracle. A terminal coding agent is stuck, or is about to commit to an expensive direction,",
  "and has sent you a curated slice of its project for a second opinion.",
  "",
  "You have no tools. You cannot read, run, or change anything. Everything you know about this project is",
  "in the bundle below. Answer from it.",
  "",
  "Structure your answer as:",
  "1. Diagnosis - what is actually going on, stated so it could be proven wrong.",
  "2. Plan - concrete steps keyed to real paths and symbols FROM THE BUNDLE, in the order to do them.",
  "3. Verification - what the executor should run or observe to know each step worked.",
  "4. Unknowns - what you could not determine, and the exact file or command that would settle it.",
  "",
  "Rules: never invent a file, symbol, flag, or API that is not in the bundle - say you need it instead.",
  "Prefer one specific recommendation over a survey of options. If the premise of the question looks wrong,",
  "say so first. Be brief where you are confident and explicit where you are not.",
].join("\n");

export function oracleRoot(home = homeDir()): string {
  return join(home, ".neko-core", "oracle");
}

export function newOracleId(now = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}T${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `orc_${stamp}_${randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(6, "0").slice(0, 6)}`;
}

/** Mask credential-shaped values in place. Returns the text and how many values were masked. */
export function maskCredentials(text: string) {
  let masked = 0;
  const literals = text.replace(CREDENTIAL_LITERAL, (_match, head: string, value: string, tail: string) => {
    // A reference is not a value. An ALL_CAPS env name, a shell/template expansion, or a template
    // literal that interpolates something (`Bearer ${token}`) is code the oracle needs to read intact.
    const literal = value.trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(literal) || literal.includes("${")) return `${head}${value}${tail}`;
    masked++;
    return `${head}<redacted>${tail}`;
  });
  return {
    text: literals.replace(KEY_PATTERNS, () => { masked++; return "<redacted>"; }),
    masked,
  };
}

export function looksLikeSecretFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return SECRET_FILES.some((pattern) => pattern.test(normalized));
}

/** Binary content has no business in a text bundle and wrecks the token budget. */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  // A NUL byte is decisive; a high share of replacement characters means a failed UTF-8 decode.
  if (sample.includes("\u0000")) return true;
  const replacements = (sample.match(/\uFFFD/g) ?? []).length;
  return replacements > sample.length * 0.02;
}

function ignored(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((part) => IGNORE_DIRS.has(part));
}

/**
 * Resolve glob patterns against the project root. A `!` prefix excludes. Paths that escape the root are
 * refused rather than silently dropped, matching the tool boundary in core.
 */
export function selectFiles(root: string, patterns: string[]) {
  const skipped: SkippedFile[] = [];
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const excluders = excludes.map((pattern) => new Bun.Glob(pattern));
  const found = new Set<string>();

  for (const pattern of includes) {
    // A drive-letter prefix is checked by hand: POSIX isAbsolute() calls "C:/Windows/win.ini"
    // relative, so on Linux/macOS that pattern sailed past this guard into the glob scan and came
    // back "matched no files" instead of "refused" (the Unix-only CI failure of 2026-07-27). A
    // Windows-absolute pattern is never a valid project-relative glob on ANY platform.
    if (isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern) || pattern.includes("..")) {
      skipped.push({ path: pattern, reason: "refused: pattern escapes the project root" });
      continue;
    }
    let matches: string[];
    try {
      matches = [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })];
    } catch (error) {
      // SAFETY: caught value comes from the typed API calls in this try block; a non-Error throw would surface as undefined message text.
      skipped.push({ path: pattern, reason: `invalid pattern: ${(error as Error).message}` });
      continue;
    }
    if (!matches.length) skipped.push({ path: pattern, reason: "matched no files" });
    for (const match of matches) {
      const rel = match.replace(/\\/g, "/");
      if (ignored(rel)) continue;
      const absolute = resolve(root, match);
      if (relative(root, absolute).startsWith(`..${sep}`) || isAbsolute(relative(root, absolute))) {
        skipped.push({ path: rel, reason: "refused: resolves outside the project root" });
        continue;
      }
      if (excluders.some((glob) => glob.match(rel))) continue;
      found.add(rel);
    }
  }
  return { paths: [...found].sort(), skipped };
}

/**
 * Read the selected files into a bundle under budget.
 *
 * When the budget runs out we drop WHOLE files from the end of a deterministic order and name each one.
 * Truncating file bodies would be the quiet option and the wrong one: the oracle would reason about
 * half a module without knowing it was half.
 */
export function buildBundle(
  root: string,
  question: string,
  paths: string[],
  limits: OracleLimits = DEFAULT_ORACLE_LIMITS,
  preSkipped: SkippedFile[] = [],
): OracleBundle {
  const files: BundleFile[] = [];
  const skipped: SkippedFile[] = [...preSkipped];
  let bytes = 0;

  for (const rel of paths) {
    if (files.length >= limits.maxFiles) {
      skipped.push({ path: rel, reason: `over the ${limits.maxFiles}-file limit` });
      continue;
    }
    if (looksLikeSecretFile(rel)) {
      skipped.push({ path: rel, reason: "refused: looks like a credential store" });
      continue;
    }
    const absolute = join(root, rel);
    let size: number;
    try {
      size = statSync(absolute).size;
    } catch {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    if (size > limits.maxFileBytes) {
      skipped.push({ path: rel, reason: `${Math.round(size / 1024)} KB is over the ${Math.round(limits.maxFileBytes / 1024)} KB per-file limit` });
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    if (looksBinary(raw)) {
      skipped.push({ path: rel, reason: "binary" });
      continue;
    }
    if (PRIVATE_KEY_BLOCK.test(raw)) {
      skipped.push({ path: rel, reason: "refused: contains a private key block" });
      continue;
    }
    const { text, masked } = maskCredentials(raw);
    const cost = Buffer.byteLength(text, "utf8");
    if (bytes + cost > limits.maxBytes) {
      skipped.push({ path: rel, reason: `over the ${Math.round(limits.maxBytes / 1024)} KB bundle budget` });
      continue;
    }
    bytes += cost;
    files.push({ path: rel, bytes: cost, text, masked });
  }

  return { question, files, skipped, bytes, text: renderBundle(question, files, skipped) };
}

/** The payload the oracle actually reads. Tags rather than fences: source contains fences. */
export function renderBundle(question: string, files: BundleFile[], skipped: SkippedFile[]): string {
  const parts = [`<question>\n${question.trim()}\n</question>`];
  if (files.length) {
    parts.push(`<files count="${files.length}">`);
    for (const file of files) {
      parts.push(`<file path="${file.path}" bytes="${file.bytes}">\n${file.text}\n</file>`);
    }
    parts.push("</files>");
  }
  if (skipped.length) {
    parts.push(
      "<not-included>",
      "These files were deliberately left out. If your answer depends on one, say so instead of guessing.",
      ...skipped.map((item) => `- ${item.path}: ${item.reason}`),
      "</not-included>",
    );
  }
  return parts.join("\n\n");
}

/** A human-readable manifest of what would leave this machine. Printed by --dry-run and by the tool. */
export function describeBundle(bundle: OracleBundle): string {
  const masked = bundle.files.reduce((total, file) => total + file.masked, 0);
  const lines = [
    `Bundle: ${bundle.files.length} file(s), ${Math.round(bundle.bytes / 1024)} KB, about ${Math.round(bundle.bytes / 4000)}k tokens.`,
  ];
  for (const file of bundle.files) lines.push(`  + ${file.path} (${Math.round(file.bytes / 1024)} KB${file.masked ? `, ${file.masked} masked` : ""})`);
  for (const item of bundle.skipped) lines.push(`  - ${item.path}: ${item.reason}`);
  if (masked) lines.push(`${masked} credential-shaped value(s) were masked before sending.`);
  return lines.join("\n");
}

export function readOracleSession(id: string, home = homeDir()): { meta: OracleSession; bundle: string; answer: string } | null {
  if (!ID_RE.test(id)) return null;
  const dir = join(oracleRoot(home), id);
  try {
    // SAFETY: session file was just loaded and ID-verified by the oracle store.
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as OracleSession;
    if (meta.schemaVersion !== 1 || meta.id !== id) return null;
    return {
      meta,
      bundle: readFileSync(join(dir, "bundle.md"), "utf8"),
      answer: readFileSync(join(dir, "answer.md"), "utf8"),
    };
  } catch {
    return null;
  }
}

export function listOracleSessions(home = homeDir()): OracleSession[] {
  const root = oracleRoot(home);
  if (!existsSync(root)) return [];
  const sessions: OracleSession[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const session = readOracleSession(entry.name, home);
    if (session) sessions.push(session.meta);
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function saveOracleSession(meta: OracleSession, bundle: string, answer: string, home = homeDir()): void {
  const dir = join(oracleRoot(home), meta.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
  atomicWriteFileSync(join(dir, "bundle.md"), bundle, 0o600);
  atomicWriteFileSync(join(dir, "answer.md"), answer, 0o600);
}

export interface ResolvedOracle {
  provider: Provider;
  profile: string;
  model: string;
  limits: OracleLimits;
}

export function oracleSetupHint(cfg: NekoConfig): string {
  const names = Object.keys(cfg.profiles).sort().join(", ");
  return [
    "No oracle is configured. Pick the profile you want as the second opinion - it should be a STRONGER",
    "or simply DIFFERENT model than the one you code with, or it has nothing to add.",
    '  Persist it: add {"oracle": {"profile": "<name>"}} to ~/.neko-core/config.json (or ./neko.json).',
    "  Just this once: neko oracle --profile <name> -p \"...\"",
    `Profiles available: ${names}`,
  ].join("\n");
}

/**
 * Build the oracle's provider from its own profile.
 *
 * The subtlety: a top-level `model` in a config file legitimately overrides every profile's preset, which
 * is the documented config trap. For the oracle that override is always wrong - you asked for THAT
 * profile's model - so when the loader reports a shadow we take the profile's own preset back.
 */
export function resolveOracle(cfg: NekoConfig): ResolvedOracle {
  const settings = cfg.oracle;
  if (!settings.profile) throw new Error(oracleSetupHint(cfg));
  let oracleCfg = loadConfig({ profile: settings.profile });
  const model = settings.model || oracleCfg.modelShadow?.profileModel || oracleCfg.model;
  if (model !== oracleCfg.model) oracleCfg = oracleCfg.withModel(model);
  // One expensive question is the whole idea, so the oracle may run hotter than the coding loop.
  if (settings.effort) oracleCfg = oracleCfg.withEffort(settings.effort);
  return {
    provider: getProvider(oracleCfg),
    profile: settings.profile,
    model: oracleCfg.model,
    limits: { maxBytes: settings.maxBytes, maxFileBytes: settings.maxFileBytes, maxFiles: settings.maxFiles },
  };
}

export interface ConsultOptions {
  root: string;
  question: string;
  files?: string[];
  limits?: OracleLimits;
  /** Continue an earlier consultation: its bundle and answer become prior turns. */
  followup?: string;
  home?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface Consultation {
  id: string;
  answer: string;
  bundle: OracleBundle;
  profile: string;
  model: string;
}

/** Compose the message list for one consultation, including a follow-up's prior turns. */
export function consultMessages(bundleText: string, prior?: { bundle: string; answer: string }): any[] {
  const messages: any[] = [{ role: "system", content: ORACLE_SYSTEM_PROMPT }];
  if (prior) {
    messages.push({ role: "user", content: prior.bundle });
    messages.push({ role: "assistant", content: prior.answer });
  }
  messages.push({ role: "user", content: bundleText });
  return messages;
}

/**
 * Run one consultation. The provider comes from the caller so this module never decides which model is
 * "the strong one" - that is a profile, and the CLI resolves it.
 */
export async function consultOracle(
  provider: Provider,
  identity: { profile: string; model: string },
  options: ConsultOptions,
): Promise<Consultation> {
  const question = options.question.trim();
  if (!question) throw new Error("the oracle needs a question");
  const home = options.home ?? homeDir();
  const limits = options.limits ?? DEFAULT_ORACLE_LIMITS;
  const { paths, skipped } = options.files?.length ? selectFiles(options.root, options.files) : { paths: [], skipped: [] };
  const bundle = buildBundle(options.root, question, paths, limits, skipped);

  const prior = options.followup ? readOracleSession(options.followup, home) : null;
  if (options.followup && !prior) throw new Error(`no oracle session '${options.followup}'`);

  const response = await provider.complete(
    consultMessages(bundle.text, prior ? { bundle: prior.bundle, answer: prior.answer } : undefined),
    undefined,
    options.onDelta ? (text, kind) => { if (kind !== "reasoning" && kind !== "tool") options.onDelta!(text); } : undefined,
    options.signal,
  );
  const answer = (response.content ?? "").trim();
  if (!answer) throw new Error("the oracle returned nothing");

  const id = newOracleId();
  saveOracleSession(
    {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      question,
      profile: identity.profile,
      model: identity.model,
      files: bundle.files.map((file) => file.path),
      skipped: bundle.skipped,
      bytes: bundle.bytes,
      ...(prior ? { parent: prior.meta.id } : undefined),
    },
    bundle.text,
    answer,
    home,
  );
  return { id, answer, bundle, profile: identity.profile, model: identity.model };
}
