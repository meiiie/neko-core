#!/usr/bin/env bun
/**
 * Independent diff reviewer for the self-improvement loop. Reads the STAGED diff itself and asks a model
 * (clean reviewer system prompt, no tools, the diff in the message BODY) for a verdict. This replaces routing
 * the review through `neko run`, which failed two ways on Windows: the coding-agent system prompt made the
 * reviewer ask for the diff instead of reading it, and a big diff as a CLI argument blew the command-line
 * length limit. Here the diff never touches the command line and the system prompt is purely "review this".
 *
 * Usage:  bun scripts/review-diff.ts [--profile nvidia]    (prints a final 'VERDICT: APPROVE|REJECT' line)
 */
import { spawnSync } from "node:child_process";

import { loadConfig } from "../src/adapters/config.ts";
import { getProvider } from "../src/adapters/providers.ts";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const profile = arg("--profile", "nvidia");

const diff = (spawnSync("git", ["diff", "--cached"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "").trim();
if (!diff) { console.log("reason: empty diff\nVERDICT: REJECT"); process.exit(0); }

const system =
  "You are a strict, independent code reviewer. You are given a unified diff and nothing else; judge ONLY from " +
  "it (you have no tools and cannot ask for more). REJECT if it: adds complexity without clear benefit, weakens " +
  "a guard / security check / test, games a metric (e.g. drops useful prompt text just to cut tokens), or is " +
  "cosmetic / no-op churn. APPROVE only a genuine, focused improvement a careful maintainer would keep. Give a " +
  "one-line reason, then a final line that is EXACTLY 'VERDICT: APPROVE' or 'VERDICT: REJECT'.";

const cfg = loadConfig({ profile });
try {
  const res = await getProvider(cfg).complete(
    [{ role: "system", content: system }, { role: "user", content: "Review this diff:\n\n" + diff.slice(0, 80000) }],
    [],
  );
  console.log((res.content ?? "").trim() || "reason: empty reply\nVERDICT: REJECT");
} catch (e) {
  console.log("reason: reviewer error " + (e instanceof Error ? e.message : String(e)) + "\nVERDICT: REJECT");
}
