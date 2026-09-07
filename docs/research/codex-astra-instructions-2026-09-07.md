# Codex / GPT-6 Astra working-instruction review

Reviewed: 2026-09-07. Scope: this repository's development instructions and documentation.
This is a dated source review, not a runtime provider migration or benchmark result.

## Official guidance applied

The [GPT-6 Astra prompting guide](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)
recommends auditing conflicting skills/instructions, making autonomy expectations explicit,
and calibrating verification to the change. The [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
explains layered instruction discovery and its default 32 KiB aggregate project budget.

Applied decisions:

- One shared AGENTS.md entry, a small CLAUDE.md pointer, and task-specific document links.
  A plain pointer avoids embedding a second full copy when Neko loads both files.
- Proceed through authorized work; ask only for consequential missing choices. Skill
  guidelines do not supersede explicit user direction or higher-priority constraints.
- Retain owner-directed solo work; the guide's optional multi-agent prompting is not
  a requirement to launch workers or raise workstation load.
- Use scoped verification for docs and focused code changes. Keep all release, authority,
  lifecycle, and benchmark eligibility gates intact; avoid repeated passing checks.
- Keep communication concise and state observable results. Verify current release/run
  state from metadata rather than a previous assistant summary.

## Repository findings resolved

AGENTS.md and CLAUDE.md duplicated drifting permission/tool maps. Claude's verify command
still targeted the Python reference, and port-module referred to a retired porting plan.
Working docs claimed credentials were never stored, Windows always used cp1252, normal
Bash needed sandbox egress grants, v1.5.1 was unpublished, and R6 was about to start.
These statements were corrected against source, release metadata, and local run records.
The obsolete port command and unreferenced remote-sandbox sketch were removed; their
history remains in Git. Dated research and benchmark artifacts were preserved.

The legacy self-improve runner still has unlimited/auto-commit/revert behavior and stale
queue references. Its docs now flag that limitation; the runner was neither executed nor
repaired in this docs-only change. Such a repair requires its own scoped implementation.

## Validation and limits

Verification inspected 61 Markdown documents and resolved 111 relative links with no
missing targets. Referenced entry points/commands, stale active guidance, UTF-8/diff
hygiene, and the recorded R6 snapshot were also checked. AGENTS.md, CLAUDE.md, RULES.md,
STATE.md, and HARNESS.md together decreased from 19,987 to 12,281 bytes (about 39%).
No live model call, benchmark, runtime build, provider-default change, or release is
part of this refresh. Instruction quality and reduced duplication do not establish
Neko performance lift; that requires the separate frozen evaluation contract.

Codex rebuilds its instruction chain at session startup. Start a new session to verify
automatic loading of the revised files. This review does not alter global Codex settings.
