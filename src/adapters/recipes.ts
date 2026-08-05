/**
 * Recipes: runnable prompt templates (Goose recipes / Claude custom-commands). A `*.md` file in
 * ~/.neko-core/recipes/ or ./.neko-core/recipes/ becomes `/recipe <name> [args]`; its body is a
 * prompt run as a turn, with $ARGUMENTS and $1..$n substituted. Save a workflow once, replay it.
 *
 * A small set of high-value recipes (review, verify, code-review, security-review) ships built-in
 * as defaults, so the verify-first review workflow is available out of the box. A user or project
 * `*.md` file of the same name always overrides the bundled default.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

export interface Recipe {
  name: string;
  description: string;
  body: string;
}

/** Built-in recipes that ship with Neko at the LOWEST priority: a user or project recipe of the
 *  same name always wins (see mergeRecipes). These package Neko's verify-first discipline and the
 *  review family into one-word commands available out of the box, so the workflow does not have to
 *  be re-created in ~/.neko-core/recipes on every machine. Bodies are plain prompts and use
 *  $ARGUMENTS (and may use $1..$n) just like on-disk recipes. */
export const BUNDLED_RECIPES: Recipe[] = [
  {
    name: "code-review",
    description: "Review file(s) or a diff for correctness, security, performance, and maintainability - deeper than review.",
    body: `Review $ARGUMENTS across four axes. Read the actual code first (plus related callers, types, and tests) - never review from memory or a snippet. List only REAL issues, each with a file:line reference and a concrete fix, sorted by severity. Do not invent issues to seem thorough.

1. Correctness - logic errors, off-by-one, wrong null/empty handling, race conditions, error paths that swallow or misreport, broken invariants.
2. Security - injection, auth/authz gaps, secrets in logs or code, unsafe deserialization, SSRF, path traversal, vulnerable dependencies.
3. Performance - N+1 queries, redundant work in hot paths, missing indexes, unbounded growth, sync I/O on async paths, accidental quadratic blowups.
4. Maintainability - misleading names, duplicated logic, dead code, unclear control flow, missing tests for risky branches, surprising side effects.

Output:
- Critical (must fix before merge)
- Important (should fix)
- Minor / nit
- What is good (1-2 lines)

If the code is already sound, say so plainly and name the one or two things you checked hardest. An empty list with honest confirmation beats a padded one.`,
  },
  {
    name: "review",
    description: "Review the given file(s) for bugs, clarity, and edge cases.",
    body: `Review $ARGUMENTS for correctness, clarity, and missed edge cases. Read the file(s) first, then give a short prioritized list of concrete issues (file:line) and suggested fixes. Be specific.`,
  },
  {
    name: "security-review",
    description: "Security-focused review of file(s) or a surface - auth, injection, secrets, data exposure, dependencies.",
    body: `Security-review $ARGUMENTS. Map the attack surface first (entry points, auth boundaries, data stores, external calls, deserialization points), then check each threat class with evidence (file:line).

- Authentication & authorization: missing or bypassable checks, IDOR, privilege escalation, broken session/token handling, missing CSRF, trust-the-client assumptions.
- Injection: SQL / OS-command / LDAP / XPath / template / XSS; unsanitized input reaching a sink; dynamic eval.
- Secrets & data exposure: hardcoded keys or passwords, secrets in logs/errors/responses, PII leakage, verbose errors, insecure defaults, mass-assignment.
- Transport & storage: TLS gaps, cert validation disabled, insecure deserialization, weak or hand-rolled crypto, world-readable files, missing integrity checks, plaintext at rest.
- Dependencies & config: known-vulnerable versions, unsafe flags, debug/admin features in prod, permissive CORS, overly broad file/network permissions.

Output a severity-ranked list (Critical / High / Medium / Low), each with a concrete fix. End with a short "Not verified" note for anything needing runtime or dynamic testing. Never claim the code is secure - state the strongest verified claim the evidence supports.`,
  },
  {
    name: "verify",
    description: "Prove a change works by building, running, and observing the real result - not by reasoning alone.",
    body: `Verify the change in $ARGUMENTS by observing real behavior - inspection and reasoning are NOT verification.

1. State the exact acceptance criteria first (from the request, tests, or reference output) before touching anything.
2. Build and test from a CLEAN state: remove stale generated outputs so they cannot short-circuit the check. Run the build/test command and read the exit code AND the full output.
3. On any non-zero exit or error, diagnose the root cause, fix it, and re-run until green. Never assume success or move on with a broken result.
4. For a runtime or feature change, actually run it (start the app, hit the endpoint, open the page) and observe real behavior, not just that it compiles.
5. Report PASS or FAIL per criterion, backed by the concrete command and its result. If anything could not be verified, say so explicitly. Do not claim done.

Do not narrate the plan to verify - just verify, then report the verdict with evidence.`,
  },
];

/** The built-in recipes, as a fresh array (callers may reorder or filter without mutating the source). */
export function bundledRecipes(): Recipe[] {
  return BUNDLED_RECIPES.map((r) => ({ ...r }));
}

/** Merge bundled defaults (lowest priority) with filesystem recipes, preserving the original
 *  precedence where the FIRST filesystem occurrence of a name wins (home overrides cwd). Pure
 *  function - it takes the already-loaded filesystem recipes so it stays unit-testable without a disk. */
export function mergeRecipes(filesystemRecipes: Recipe[]): Recipe[] {
  const merged = new Map<string, Recipe>();
  for (const r of filesystemRecipes) if (!merged.has(r.name)) merged.set(r.name, r);
  for (const r of BUNDLED_RECIPES) if (!merged.has(r.name)) merged.set(r.name, r);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function recipeDirs(): string[] {
  return [join(homeDir(), ".neko-core", "recipes"), join(process.cwd(), ".neko-core", "recipes")];
}

function parse(file: string): Recipe | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const name = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
  let description = "";
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim();
  }
  return { name, description: description.replace(/\s+/g, " ").slice(0, 120), body: body.trim() };
}

export function listRecipes(): Recipe[] {
  // Load filesystem recipes in dir order ([home, cwd]); mergeRecipes keeps the first occurrence
  // of a name (home overrides cwd) and layers the bundled defaults underneath.
  const filesystem: Recipe[] = [];
  for (const dir of recipeDirs()) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const p = join(dir, entry);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      const r = parse(p);
      if (r) filesystem.push(r);
    }
  }
  return mergeRecipes(filesystem);
}

export function loadRecipe(name: string): Recipe | null {
  return listRecipes().find((r) => r.name === name) ?? null;
}

/** Substitute $ARGUMENTS (all args) and $1..$n (positional) into a recipe body. */
export function fillRecipe(body: string, args: string): string {
  const all = args.trim();
  const argv = all ? all.split(/\s+/) : [];
  return body.replace(/\$ARGUMENTS\b/g, all).replace(/\$(\d+)/g, (_, n) => argv[Number(n) - 1] ?? "");
}

export function renderRecipes(): string {
  const list = listRecipes();
  if (!list.length) {
    return "No recipes. Add *.md to ~/.neko-core/recipes/ or ./.neko-core/recipes/ (body = the prompt; use $ARGUMENTS).";
  }
  return ["Neko Core recipes:", ...list.map((r) => `- ${r.name}${r.description ? "  " + r.description : ""}`)].join("\n");
}
