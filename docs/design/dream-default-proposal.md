# Automatic Dream: implementation design

## User intent

Dream should run by default, including automatic activation, without requiring
`prepare` and `apply` after each task. Preserve the user's existing sessions,
provider choice, authority, and rollback. No scheduled autonomous service is requested.

## Verified baseline

At 04cd1be, Dream is available as a command, not disabled by a feature flag.
`dream prepare` makes one bounded tool-free model request; `apply` activates an
exact evidence-bound receipt. Recall is already automatic after activation, but
only in scoped task sessions. Ordinary CLI/TUI/ACP sessions remain legacy sessions.

Forcing all sessions into task-session mode is rejected: it locks config identity,
removes legacy resume/handoff, and restricts shared skills/playbooks and model changes.
Enabling automatic preparation only is also rejected as not satisfying the request.

## Recommended approach

Add a Dream sidecar identity for ordinary sessions, distinct from tool/task authority.
Bind it to trusted session ID, canonical root, runtime authority, and memory home.
Do not bind its TaskScope to the main ToolRegistry or migrate legacy transcript files.
Explicit task sessions reuse their existing scoped Dream store.

One shared AutomaticDream lifecycle adapter accepts immutable post-turn evidence.
The host calls it only after a successful settled turn and durable checkpoint; it
skips canceled/interrupted turns, memory-off, plan-only or restricted ACP hosts.
It must not run inside the ordinary agent's tool loop or allow tools in its request.
It prepares and activates using the existing evidence checks, locks, atomic write,
receipts and rollback. A failed pass preserves prior active memory and is surfaced.
No hidden retry, background service, or mutation of original transcripts.

The normal default is automatic. Explicit `dream_mode: off` disables extra model work and legacy sidecar recall;
existing task-scoped recall follows `/memory off`. `manual` keeps the existing
reviewed flow. Display a
clear first-use notice and account for usage. Use the selected provider, no MoA
fan-out, existing bounded response/deadline, and a per-evidence digest to avoid
repeated spending for an unchanged turn. A deliberate rollback must not be undone
by the automatic scheduler unless genuinely new original evidence arrives.

## Host seams

- CLI: post-run quiescent checkpoint in `bin/neko.ts:cmdRun`; persistent explicit
  task sessions reuse IDs. Ordinary one-shot runs need a durable advertised ID,
  not an implicit root-wide memory bucket shared between unrelated tasks.
- TUI: stable session ID, resume/fork/switch boundaries and post-run finalization in
  `src/ui/chat.tsx`. Do not launch in render or incremental checkpoint callbacks.
- ACP: session-owned identity and authority in `src/adapters/acp.ts`; never activate
  under an exclusive host profile without an explicit supported host capability.
- Recall: title-only observation layer stays fallible. Add a dedicated Dream read
  surface or trusted routing so legacy `memory read dream.md` never reads global
  memory while the injected index points to a private sidecar. No broad global
  promotion or authority expansion.
- Commands: inspect/status/off/manual/rollback must work for automatic legacy
  sidecars, not falsely direct users to the existing task-session-only command.

## Acceptance tests before declaring default

1. Ordinary CLI, TUI and standard ACP automatically prepare, apply and recall with
   a deterministic fake provider, without task-mode capability regressions.
2. Resume retains only that session's Dream; fork policy is explicit; two roots,
   homes, task IDs and ACP authority identities cannot cross-recall.
3. No-source, secret-bearing, malformed, tool-calling, truncated and deadline
   responses preserve old memory and never retry secretly.
4. Concurrent turn, memory write, switch, cancellation and close invalidate stale
   publication; no orphan background work after shutdown.
5. Same evidence is not charged twice; a rollback is not immediately re-applied.
6. All default opt-out controls and usage/notice reporting are real, tested host paths.
7. Explicit preview/prepare/show/apply/rollback remain compatible.

## Release boundary

This is a multi-client lifecycle feature, not a configuration boolean. The browser
work remains independent. Deterministic CLI/TUI/ACP host tests exercise automatic
prepare/apply and the normal session path. Live model quality and actual billing
have not been evaluated. No overnight/background scheduler is implemented.
