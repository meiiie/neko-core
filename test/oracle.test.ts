import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Provider, ProviderResponse } from "../src/core/ports.ts";
import {
  buildBundle,
  consultMessages,
  consultOracle,
  describeBundle,
  listOracleSessions,
  looksLikeSecretFile,
  maskCredentials,
  readOracleSession,
  renderBundle,
  selectFiles,
  type OracleLimits,
} from "../src/adapters/oracle.ts";

const LIMITS: OracleLimits = { maxBytes: 400_000, maxFileBytes: 128_000, maxFiles: 80 };

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "neko-oracle-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

class StubProvider implements Provider {
  seen: any[][] = [];
  constructor(private readonly answer: string) {}
  async complete(messages: any[]): Promise<ProviderResponse> {
    this.seen.push(messages);
    return { content: this.answer, tool_calls: [] };
  }
}

test("globs select files, '!' excludes, and ignored trees never appear", () => {
  const root = workspace({
    "src/a.ts": "a",
    "src/b.test.ts": "b",
    "src/deep/c.ts": "c",
    "node_modules/pkg/index.ts": "vendored",
    "README.md": "readme",
  });
  try {
    const { paths } = selectFiles(root, ["src/**/*.ts", "!**/*.test.ts"]);
    expect(paths).toEqual(["src/a.ts", "src/deep/c.ts"]);
    // A pattern that matches nothing is reported rather than silently ignored - a typo'd glob would
    // otherwise look exactly like "the oracle read my code and had no comment".
    const empty = selectFiles(root, ["src/**/*.rs"]);
    expect(empty.paths).toEqual([]);
    expect(empty.skipped[0].reason).toContain("matched no files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patterns that leave the project root are refused, not resolved", () => {
  const root = workspace({ "a.ts": "a" });
  try {
    for (const pattern of ["../**/*.ts", "/etc/passwd", "C:/Windows/win.ini"]) {
      const result = selectFiles(root, [pattern]);
      expect(result.paths).toEqual([]);
      expect(result.skipped[0].reason).toContain("refused");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential-shaped literals are masked, but code that merely names a key is left intact", () => {
  const masked = maskCredentials([
    'const apiKey = "sk-live-EXAMPLE-not-a-real-key";',
    "const key = process.env.OPENAI_API_KEY;",
    'password: "hunter2hunter2hunter2"',
    'token: ""',
    'const authorization = `Bearer ${token}`;',
    "aws = AKIAIOSFODNN7EXAMPLE",
  ].join("\n"));
  // The real values are gone.
  expect(masked.text).not.toContain("sk-live-EXAMPLE-not-a-real-key");
  expect(masked.text).not.toContain("hunter2hunter2hunter2");
  expect(masked.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  // The code stays readable: an env reference and an empty string are not credentials.
  expect(masked.text).toContain("process.env.OPENAI_API_KEY");
  expect(masked.text).toContain('token: ""');
  // A template literal that interpolates is code, not a value - masking it would corrupt the very
  // source the oracle is being asked to reason about.
  expect(masked.text).toContain("Bearer ${token}");
  expect(masked.masked).toBe(3);
  expect(maskCredentials("nothing to see").masked).toBe(0);
});

test("secret stores are recognised by name", () => {
  for (const path of [".env", "app/.env.local", "certs/server.pem", "keys/id_rsa", ".neko-core/config.json", "deploy/credentials.json"]) {
    expect(looksLikeSecretFile(path)).toBe(true);
  }
  for (const path of ["src/env.ts", "docs/environment.md", "src/adapters/config.ts"]) {
    expect(looksLikeSecretFile(path)).toBe(false);
  }
});

test("a bundle refuses secret files and key material, and says so", () => {
  const root = workspace({
    "src/a.ts": "export const a = 1;\n",
    ".env": "OPENAI_API_KEY=sk-live-EXAMPLE-not-a-real-key\n",
    "certs/key.txt": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n",
  });
  try {
    const bundle = buildBundle(root, "why?", ["src/a.ts", ".env", "certs/key.txt"], LIMITS);
    expect(bundle.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(bundle.skipped.find((item) => item.path === ".env")!.reason).toContain("credential store");
    expect(bundle.skipped.find((item) => item.path === "certs/key.txt")!.reason).toContain("private key");
    // Refused content never reaches the payload, and the refusal is visible in it.
    expect(bundle.text).not.toContain("sk-live-EXAMPLE-not-a-real-key");
    expect(bundle.text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(bundle.text).toContain("<not-included>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the budget drops WHOLE files and names each one, rather than truncating a body", () => {
  const root = workspace({ "a.ts": "a".repeat(600), "b.ts": "b".repeat(600), "c.ts": "c".repeat(600) });
  try {
    const bundle = buildBundle(root, "q", ["a.ts", "b.ts", "c.ts"], { maxBytes: 1_300, maxFileBytes: 128_000, maxFiles: 80 });
    expect(bundle.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(bundle.files.every((file) => file.text.length === 600)).toBe(true); // no half-read module
    expect(bundle.skipped).toEqual([{ path: "c.ts", reason: "over the 1 KB bundle budget" }]);
    // Per-file and per-count ceilings are reported the same way.
    const perFile = buildBundle(root, "q", ["a.ts"], { maxBytes: 400_000, maxFileBytes: 100, maxFiles: 80 });
    expect(perFile.files).toEqual([]);
    expect(perFile.skipped[0].reason).toContain("per-file limit");
    const perCount = buildBundle(root, "q", ["a.ts", "b.ts"], { maxBytes: 400_000, maxFileBytes: 128_000, maxFiles: 1 });
    expect(perCount.files.length).toBe(1);
    expect(perCount.skipped[0].reason).toContain("1-file limit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary and unreadable files are skipped instead of poisoning the payload", () => {
  const root = workspace({ "logo.bin": `PNG${String.fromCharCode(0)}\u0001\u0002data` });
  try {
    const bundle = buildBundle(root, "q", ["logo.bin", "missing.ts"], LIMITS);
    expect(bundle.files).toEqual([]);
    expect(bundle.skipped.map((item) => item.reason)).toEqual(["binary", "unreadable"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manifest reports size, masking, and every exclusion", () => {
  const bundle = {
    question: "q",
    files: [{ path: "src/a.ts", bytes: 2_048, text: "x", masked: 2 }],
    skipped: [{ path: ".env", reason: "refused: looks like a credential store" }],
    bytes: 2_048,
    text: "",
  };
  const description = describeBundle(bundle);
  expect(description).toContain("1 file(s)");
  expect(description).toContain("+ src/a.ts (2 KB, 2 masked)");
  expect(description).toContain("- .env: refused");
  expect(description).toContain("2 credential-shaped value(s) were masked");
});

test("the payload carries the question, the files, and the exclusions", () => {
  const text = renderBundle("why is it slow?", [{ path: "src/a.ts", bytes: 3, text: "let a", masked: 0 }], [{ path: "b.ts", reason: "binary" }]);
  expect(text).toContain("<question>\nwhy is it slow?\n</question>");
  expect(text).toContain('<file path="src/a.ts" bytes="3">\nlet a\n</file>');
  expect(text).toContain("- b.ts: binary");
});

test("a follow-up replays the earlier bundle and answer as prior turns", () => {
  const messages = consultMessages("second question", { bundle: "first bundle", answer: "first answer" });
  expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(messages[1].content).toBe("first bundle");
  expect(messages[2].content).toBe("first answer");
  expect(messages[3].content).toBe("second question");
  expect(consultMessages("only").map((message) => message.role)).toEqual(["system", "user"]);
});

test("a consultation is saved, readable, and continuable", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-oracle-home-"));
  const root = workspace({ "src/a.ts": "export const a = 1;\n" });
  try {
    const provider = new StubProvider("Diagnosis: the loop never releases.");
    const first = await consultOracle(provider, { profile: "claude", model: "claude-opus-4-8" }, {
      root,
      question: "why does it stall?",
      files: ["src/**/*.ts"],
      home,
    });
    expect(first.answer).toContain("never releases");
    expect(first.bundle.files.map((file) => file.path)).toEqual(["src/a.ts"]);

    const saved = readOracleSession(first.id, home);
    expect(saved!.meta.profile).toBe("claude");
    expect(saved!.meta.files).toEqual(["src/a.ts"]);
    expect(saved!.answer).toBe(first.answer);
    expect(listOracleSessions(home).map((session) => session.id)).toEqual([first.id]);

    const second = await consultOracle(provider, { profile: "claude", model: "claude-opus-4-8" }, {
      root,
      question: "I tried that and it still stalls.",
      followup: first.id,
      home,
    });
    expect(readOracleSession(second.id, home)!.meta.parent).toBe(first.id);
    // The second call carried the first exchange, so the oracle is answering a thread, not a fresh prompt.
    expect(provider.seen[1].map((message: any) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(provider.seen[1][2].content).toBe(first.answer);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty question or a missing thread fails loudly instead of consulting", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-oracle-home-"));
  const root = workspace({ "a.ts": "a" });
  try {
    const provider = new StubProvider("ignored");
    expect(consultOracle(provider, { profile: "p", model: "m" }, { root, question: "   ", home })).rejects.toThrow("needs a question");
    expect(consultOracle(provider, { profile: "p", model: "m" }, { root, question: "q", followup: "orc_20260101T000000_aaaaaa", home }))
      .rejects.toThrow("no oracle session");
    // An empty answer is a failure, not an empty session on disk.
    expect(consultOracle(new StubProvider("  "), { profile: "p", model: "m" }, { root, question: "q", home })).rejects.toThrow("returned nothing");
    expect(listOracleSessions(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
