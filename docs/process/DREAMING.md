# Task memory dreaming

Neko consolidates eligible completed sessions automatically by default, while retaining the explicit reviewed workflow. The design is inspired by [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) (Anthropic, 2026-11-06): original transcripts, fallible notes, linked representations, and a small injected navigation layer. This is not compaction, model training, or an autonomous background agent.

## Use

## Default automatic mode

`dream_mode` defaults to `auto`. After a successful ordinary CLI, TUI, or standard
ACP turn, the host makes one bounded, tool-free request to the configured model,
validates the candidate and automatically applies it. No `prepare`/`apply` command
is required. This can add latency and normal provider charges; the host announces
the pass and includes received usage reports, even for rejected candidates, in the session's cost counters.
There is no timer or overnight daemon. Failed/interrupted turns, plan mode,
memory-off, unavailable memory tools, MoA profiles, restricted ACP hosts and
caller-injected runtimes without an explicit Dream provider do not automatically
consolidate.

Ordinary sessions keep their existing transcript format, profile changes, skills,
and shared-memory behavior. A separate Dream sidecar is bound to the trusted
session ID, physical root and host authority. It is not a project-wide shared
bucket and does not put legacy sessions into task mode. Resuming the same session
recalls its note; a new session has a different sidecar. One-shot `neko run` prints
its Dream session/candidate identifiers. Scoped task sessions reuse their original
store, original-evidence journal/display history and task isolation.

Set `"dream_mode": "manual"` in config to stop additional automatic requests and
keep reading previously activated notes. Set `"dream_mode": "off"` to stop the
automatic sidecar as well. `/memory off` disables all memory, including existing
scoped task recall. No option deletes original transcripts or audit records.

Automatic activation uses the same citation validation, memory revision checks,
atomic publication and rollback as explicit apply. Validation proves source
provenance, **not truth**. A failed or stale pass leaves the old note intact. The
same evidence is claimed before requesting the model, so a failure, crash or
rollback does not silently repeat spending for identical evidence. A new completed
turn can produce a new candidate. There are no automatic repair calls.

The completion notice gives the exact command selector:

```sh
neko dream show session:<ordinary-session-id> <candidate-id>
neko dream rollback session:<ordinary-session-id> <candidate-id>
# For standard ACP sidecars, use acp-session:<session-id> instead.
```

Run these in the original root and home. These legacy selectors support only
inspection and rollback; they do not migrate a legacy transcript into a task
session. For explicit scoped tasks, the original commands below remain available.

## Explicit task workflow

The explicit workflow requires an opt-in **task session**, the same configured
profile/context mode, and its original root. It operates on the active task and
cannot read another task or change an ACP host's authority.

```sh
neko task-session new "My project"
neko run --task-session <session-id> "Work on this project"
neko dream preview <session-id>
neko dream prepare <session-id>
neko dream show <session-id> <candidate-id>
neko dream apply <session-id> <candidate-id>
neko dream rollback <session-id> <candidate-id>
```

- **preview:** print the selected evidence and memory locally. No model call.
- **prepare:** send the bounded selected data to the configured provider, request one structured proposal without tools, validate it, and save a candidate. This can incur normal provider charges. It does **not** activate memory. Use preview first when the data is sensitive.
- **show:** inspect the proposed note, prior note, source coverage, provider/model, and activation status.
- **apply:** activate that exact candidate locally after rechecking evidence and memory revisions. No model call.
- **rollback:** restore the prior note only if this candidate's output is still current. No model call. Newer edits are never overwritten.

There is no timer or overnight service. Explicit `prepare` still never automatically applies; only the post-turn automatic host path does. `prepare` caps output at 4,096 tokens, disables configured retries/offline retries, checks the input against the configured model context with a response reserve, and has a 120-second cancellation deadline. Mixture-of-agents profiles are rejected because a single logical request could fan out. A provider may still implement its own transport behavior; this is not a precise monetary spending cap.

## Research alignment and implementation limits

The cited article is design evidence, not a published specification of Anthropic's internal memory system. Neko implements a task-scoped, reviewed consolidation pass, not a reproduction of Anthropic's agent, benchmark results, unrestricted transcript search, or multi-page wiki maintenance. The article favors useful model-selected memories, correction against originals, and a small injected index; it does not prescribe a 120-character summary limit.

Summary text therefore has **no separate character cap** and is preserved verbatim after validation. It remains a nonempty single line, outside the automatic recall index. Neko retains its own resource controls: 32 KB complete response, 4,096 provider output tokens, bounded inputs/citations/claims, and the cancellation deadline. These are Neko engineering budgets, not limits attributed to Anthropic. They fail explicitly rather than silently truncating factual summaries. Claim titles/text still have their existing 80/600-character caps; this change removes the summary cap specifically.

The model receives the exact allowed memory filenames for `corrects` and `related`, with an explicit example. Claim titles and unknown filenames remain invalid; a rejected result is not silently rewritten or retried. The prior active note remains unchanged after preparation failure, so inspect it before relying on a correction that did not activate.

## Evidence and uncertainty

A pass prefers original structured source groups, otherwise immutable display history plus its newer native tail, otherwise available non-internal native messages and descriptor-bound read-file evidence. Existing compaction capsules and legacy controller summaries are excluded. Display-only tool results lack native tool/path binding and are excluded. Memory/workflow/playbook tool output and identified memory-file reads cannot become original evidence.

The pass reads a bounded recent window, up to 128 sources and 96 KB of serialized input. Coverage reports the origin, included/omitted counts, whether older evidence remains, and original citations retained from the previously activated dream. Original cited sources are carried forward from an intact prior receipt; old model summary text is not promoted to proof. Candidate creation checks that its cited evidence plus the resulting memory can fit a subsequent pass, leaving room for new evidence. If this bound cannot be met, it fails before activation rather than creating a note that blocks the next pass. Later unrelated memory growth may still require explicit pruning; already-applied retries are resolved before rebuilding evidence.

This is **not a complete-history sweep** or an incremental backlog processor. No watermark is advanced. `hasOlder` and `omitted` must not be interpreted as a successfully processed backlog. A long source that cannot fit is omitted whole and reported, not clipped into an apparently complete quote. Information absent from the available original stores cannot be reconstructed. The model can still prune older claims it judges unhelpful, so this is not a lossless archive.

Claims have an `observed` or `inferred` status and exact source quotations. Assistant-only claims cannot be `observed`. Exact matching verifies provenance, **not semantic entailment, truth, freshness, or successful execution**. Tool output, user quotations, and old notes remain untrusted data; none grants permission or becomes system policy. Model judgment can still be wrong. Choose manual mode when every proposed consolidation requires review before activation.

## Storage and recall

The candidate records live in the selected task memory's `.dreams` directory, outside ordinary memory admission. The activated representation is a single `dream.md`. Original notes and transcripts are not rewritten. Corrections name earlier notes, preserve their history, and link to original evidence; readers should check the cited correction before relying on the older note.

The existing `memory read` and `memory search` tools expose the note. Shared runtime context injects only up to six bounded observed-claim **titles**, with a pointer to the complete note. Full statements are not sliced in a way that can drop an exception or negation; hypotheses stay out of this top layer. The generated index is admitted only when it matches the intact candidate receipt and exact published bytes. Modified or rolled-back content is flagged as needing review.

Ordinary scoped memory writes/appends/imports cannot fabricate `dream.md`. Users may still inspect it, turn memory off, or delete the note. Deleting the note disables its automatic recall but **does not erase audit records or original transcripts**. Candidates intentionally retain selected evidence and prior bytes for review and rollback. Manage those local files separately when complete erasure is required. There is no hidden global promotion or fallback to another home/task.

## Conflicts and recovery

A shared scoped-memory writer lock excludes cooperative foreground writes while preparing a candidate or applying it. The candidate binds the task/root, source snapshot and all memory content hashes. A changed source or note rejects activation. Source bytes remain stable under the task-session writer lease during the CLI command.

Each activation publishes exactly one complete note with atomic rename. The candidate exists before publication; exact before/after bytes distinguish a prepared, applied, conflicting, or rollback state after process interruption. A repeated apply of the same current bytes is idempotent. Rollback intent is recorded first; `rollback_pending` can be finished by repeating the explicit rollback command. A changed or stale writer lock fails closed and is never automatically removed.

The guarantee covers **process interruption**, not uniform power-loss durability. Staged files are synced, but directory/rollback-marker ordering is not an fsync-backed cross-platform transaction. A separate OS user or process with direct write access can edit local files; content hashes detect accidental edits, not authenticated provenance against a malicious account owner.

## Verification boundary

Deterministic tests use temporary homes and fake/loopback providers. They cover source correction lineage, repeated-compaction originals, cross-client tail reconciliation, inferred/observed separation, input/output secret patterns, scope/home isolation, context bounds, cancellation, stale writes, link rejection, activation retry, rollback interruption, and recall integrity.

These tests establish implementation behavior. They do not establish a model-quality gain, actual provider charges, long-running overnight operation, or Wiii end-to-end acceptance. Automatic host tests additionally cover ordinary CLI/TUI/ACP, same-evidence deduplication, rollback, source changes, cancellation and opt-out. Live quality/cost evaluation and any overnight scheduler remain separate work. ProgramBench remains paused.
