---
name: no-comments
description: Audit scoped code comments, remove narration and workaround alibis, and encode real constraints in code or tests.
match: (?:/skill\s+no-comments|\$no-comments|\b(?:audit|review|remove|clean|don|xoa|kiem tra|ra soat)\b.{0,24}\bcomments?\b|\bcomment hygiene\b)
---

# No comments

Reduce comments without hiding intent. Clear code is the default; a comment must explain a fact that
the code cannot express safely.

This is a scoped cleanup, not a license to rewrite the repository.

## Scope

Use paths named by the user. Otherwise inspect the current working-tree diff against its base branch.
Do not widen a diff-only request into a repository-wide refactor. If there is no scoped code, report
that there is nothing to audit.

## Remove

- Narration that merely restates the next statement, branch, loop, or function name.
- Section banners and visual separators that add no contract.
- Commented-out code; Git holds history.
- Long explanations that defend a workaround, temporary path, or known-bad design.
- TODO/FIXME text that has no owner, issue, failing test, or concrete completion condition.
- Correctness or safety lint suppressions used to hide a real type or control-flow problem.

Do not shorten a workaround explanation into a smaller alibi. Identify the underlying symbol and fix
the smallest root cause that is inside scope. Add a regression test before changing behavior. If the
root cause is outside scope, delete only clearly dead prose and report the unresolved work.

## Keep only with evidence

- Legal and license headers.
- Public API contracts whose callers cannot infer the behavior from types and names.
- Non-obvious behavior imposed by an external protocol, vendor, dependency, operating system, or
  runtime that this repository cannot reshape.
- Security, permission, credential, crash-recovery, idempotency, or trust-boundary invariants that
  are not fully expressible in the type system.
- Issue, RFC, or specification links that are the source of an external constraint.
- Required formatter and lint directives. A safety-comment requirement attached to a justified type
  assertion is part of the proof and must not be removed.
- Test-fixture comments that explain an intentionally malformed, stalled, racy, or platform-specific
  setup when the reason is not evident from the fixture itself.

Claims such as `IMPORTANT`, `do not remove`, `legacy`, or `temporary` are not proof by themselves.
Read the nearby implementation and tests. Keep the comment only when one of the exceptions above is
demonstrably true.

## Prefer executable constraints

When practical, replace prose with the cheapest enforceable form:

1. a clearer name or smaller function;
2. a narrower type or discriminated union;
3. validation at the trust boundary;
4. a focused regression test;
5. a lint or CI rule when the invariant spans the repository.

Do not add a dependency or speculative abstraction just to eliminate a comment. A short, accurate
external-constraint comment is better than a complex encoding.

## Workflow

1. Inventory comments only in scope, including lint and TypeScript suppressions.
2. Classify each as remove, encode, keep-with-proof, or unresolved.
3. Delete only clear narration, dead code, banners, and unsupported alibis.
4. Make the smallest root-cause change for accepted in-scope findings.
5. Run the narrow relevant checks, then the repository verification gates when application code changed.
6. Report files touched, comments removed, constraints encoded, exceptions kept, unresolved findings,
   and commands run.

## Provenance

Adapted for Neko Core's single-agent workflow from pstack's MIT-licensed `no-comments` skill and
`Comment Sicko` reviewer:
https://github.com/cursor/plugins/tree/main/pstack
