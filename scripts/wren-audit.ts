/**
 * wren-audit — hands-on security probe of neko's bash containment, framed by the claims in
 * https://wren.wtf/shower-thoughts/stop-using-opencode/ ("textual command filtering is useless").
 *
 * Run it yourself:   bun scripts/wren-audit.ts
 *
 * It touches ONLY throwaway temp dirs (deleted at the end). The one write it aims OUTSIDE the
 * workspace is to a temp sentinel, purely to prove the sandbox blocks it. Every case prints:
 *   [THESIS] the article is right: the textual seatbelt misses this bypass.
 *   [HELD]   neko's real containment (the OS sandbox) stopped the consequence anyway.
 *   [RISK]   neither the seatbelt nor the sandbox stopped it - a gap worth a decision.
 *   [N/A]    couldn't be tested honestly here (e.g. a tool isn't present in the sandbox).
 *
 * Honesty rule: a command that fails because a TOOL is missing (exit 127 / "command not found")
 * is NEVER counted as "blocked". Only an actual denied/does-not-exist OUTCOME counts as HELD.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dangerousCommand } from "../src/core/tool-runtime.ts";
import { detectSandbox, sandboxActive, wrapBash } from "../src/core/sandbox.ts";

const B = "\x1b[1m", R = "\x1b[31m", G = "\x1b[32m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m";
const tag = (t: string) =>
  t === "THESIS" ? `${Y}[THESIS]${X}` : t === "HELD" ? `${G}[HELD]${X}` : t === "RISK" ? `${R}[RISK]${X}` : `${C}[N/A]${X}`;

const kind = detectSandbox();
const live = sandboxActive();
console.log(`${B}wren-audit${X} - neko bash containment probe`);
console.log(`${D}sandbox primitive: ${kind}   live (provisioned): ${live}${X}\n`);
if (!live) {
  console.log(`${Y}The OS sandbox is NOT live here, so the [HELD] cases can't be demonstrated.`);
  console.log(`On Windows: bun add -g @anthropic-ai/sandbox-runtime && srt windows-install${X}\n`);
}

const root = mkdtempSync(join(tmpdir(), "neko-audit-work-"));
const outsideDir = mkdtempSync(join(tmpdir(), "neko-audit-outside-"));
const outsideFile = join(outsideDir, "MUST-NOT-BE-WRITTEN.txt");

function runSandboxed(cmd: string, allowNetwork = false): { status: number | null; out: string } {
  const t = wrapBash(cmd, root, { enabled: true, allowNetwork, domains: allowNetwork ? ["example.com"] : [] });
  const r = spawnSync(t.file, t.args, { shell: t.shell, cwd: root, encoding: "utf-8", timeout: 90_000 });
  return { status: r.status, out: ((r.stdout || "") + (r.stderr || "")).trim().slice(0, 200) };
}
const toolMissing = (o: string, s: number | null) => s === 127 || /command not found|not recognized|No such file or directory.*(python|curl)/i.test(o);

let thesis = 0, held = 0, risk = 0, na = 0;
function report(t: "THESIS" | "HELD" | "RISK" | "N/A", title: string, detail: string) {
  console.log(`${tag(t)} ${B}${title}${X}\n        ${D}${detail}${X}`);
  if (t === "THESIS") thesis++; else if (t === "HELD") held++; else if (t === "RISK") risk++; else na++;
}

// ---- 1. The article's thesis: the textual seatbelt misses obvious bypasses of "rm -rf /". ----
console.log(`${B}1. Is the textual seatbelt bypassable? (the article's central claim)${X}`);
const bypasses: [string, string][] = [
  ["base64 pipe", "echo cm0gLXJmIH4K | base64 -d | bash"],       // decodes to: rm -rf ~
  ["python subprocess", `python3 -c 'import shutil; shutil.rmtree("/")'`],
  ["env prefix", "env rm -rf /"],
  ["variable indirection", "R=rm && $R -rf /"],
];
for (const [name, cmd] of bypasses) {
  const blocked = dangerousCommand(cmd);
  if (blocked) report("HELD", `seatbelt caught the ${name} form`, `blocked: ${blocked}`);
  else report("THESIS", `seatbelt MISSED the ${name} form`, `dangerousCommand() returned null for: ${cmd}`);
}
console.log(`        ${D}(sanity: naive "rm -rf /" is caught -> ${dangerousCommand("rm -rf /") ?? "null"})${X}\n`);

// ---- 2. neko's real answer: even when a bypass slips the seatbelt, the OS sandbox contains it. ----
// Uses ONLY git-bash builtins (echo + redirection) so a missing python can't fake a "HELD".
console.log(`${B}2. Does the OS sandbox contain the consequence the seatbelt missed?${X}`);
if (live) {
  // The article's "redirections" bypass: write OUTSIDE the workspace with a plain redirect.
  const escape = `echo pwned > '${outsideFile.replace(/\\/g, "/")}'`;
  console.log(`        ${D}$ ${escape}${X}`);
  const r1 = runSandboxed(escape);
  if (existsSync(outsideFile)) report("RISK", "a redirect wrote OUTSIDE the workspace", `sandbox did not confine it: ${outsideFile}`);
  else report("HELD", "out-of-workspace write blocked by the sandbox", `redirect denied (status ${r1.status}${r1.out ? `: ${r1.out}` : ""})`);
  // Egress the seatbelt never inspects. curl ships with git-bash; skip honestly if absent.
  const r2 = runSandboxed("curl -s -m 15 https://example.com -o /dev/null -w %{http_code}");
  if (toolMissing(r2.out, r2.status) && !/^\d\d\d$/.test(r2.out)) report("N/A", "egress test skipped", `curl not available in the sandbox (${r2.out || "no output"})`);
  else if (/^2\d\d$/.test(r2.out)) report("RISK", "network egress was NOT blocked", `curl reached the network: HTTP ${r2.out}`);
  else report("HELD", "network egress blocked by the sandbox", `curl could not reach the network (got "${r2.out || "no response"}")`);
} else {
  console.log(`        ${D}skipped - sandbox not live (see the note above).${X}`);
}
console.log("");

// ---- 3. The residual gap our auto-approve introduced: in-workspace destruction is unguarded. ----
// Demonstrated with an EXPLICIT target (rm -rf <dir>) - not `rm -rf .` (GNU rm refuses cwd) nor
// `rm -rf *` (misses dotfiles) - so the outcome is unambiguous: the user's code dir is gone.
console.log(`${B}3. Auto-approve gap: is destruction INSIDE the workspace guarded?${X}`);
const destructive = "rm -rf src .git";
const blocked = dangerousCommand(destructive);
if (blocked) {
  report("HELD", `seatbelt blocks "${destructive}"`, `blocked: ${blocked}`);
} else if (!live) {
  report("N/A", `"${destructive}" - sandbox not live`, "can't demonstrate the sandboxed run here");
} else {
  // Recreate the victim files, then run the destructive command sandboxed (as auto-approve would).
  runSandboxed("mkdir -p src .git && echo '// user code' > src/important.ts && echo 'ref: refs/heads/main' > .git/HEAD");
  const before = existsSync(join(root, "src", "important.ts")) && existsSync(join(root, ".git", "HEAD"));
  console.log(`        ${D}$ ${destructive}   (seatbelt returned null; under auto-approve this runs with NO prompt)${X}`);
  runSandboxed(destructive);
  const gone = !existsSync(join(root, "src", "important.ts")) && !existsSync(join(root, ".git", "HEAD"));
  if (before && gone) report("RISK", `"${destructive}" wiped the workspace with NO prompt`, "seatbelt=null + sandbox allows in-workspace writes + auto-approve skips the gate -> src/ and .git/ gone");
  else if (!before) report("N/A", "couldn't set up the victim files", "skipping (sandbox mkdir/echo did not create them)");
  else report("HELD", `"${destructive}" did not remove the files`, "unexpected - the workspace survived");
}

// ---- Verdict ----
console.log(`\n${B}Verdict${X}`);
console.log(`  ${Y}THESIS${X} confirmed (seatbelt bypassable): ${thesis}`);
console.log(`  ${G}HELD${X}   by the OS sandbox / seatbelt:      ${held}`);
console.log(`  ${R}RISK${X}   unguarded gaps to decide on:       ${risk}`);
if (na) console.log(`  ${C}N/A${X}    not testable honestly here:        ${na}`);
console.log(`\n${D}Takeaway: the textual seatbelt is bypassable exactly as the article says - so it is NOT`);
console.log(`the containment. The OS sandbox IS, and it holds for out-of-workspace writes + egress.`);
console.log(`The open question is IN-workspace destruction under auto-approve: the blast radius is`);
console.log(`contained to the workspace, but your code + .git inside it can be wiped without a prompt.${X}`);

rmSync(root, { recursive: true, force: true });
rmSync(outsideDir, { recursive: true, force: true });
