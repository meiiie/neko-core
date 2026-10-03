> Status update: CLI/TUI/ACP integration is now implemented behind explicit opt-in.
> This document preserves the design acceptance checklist; it is not a claim that
> every performance, fault-injection or live-model gate has passed. See
> [current behavior and limits](../STRUCTURED-CONTEXT.md).

# Scoped context integration: acceptance before production activation

Status: proposed host integration contract, not a shipped mode. The main candidate
and experimental context worktree remain separate. Tests of the experiment do not
establish main TUI or provider behavior.

## Current boundaries that must remain visible

- Production task-session schema 2 checkpoints working messages and an inline
  read-file source ledger together. The ledger is bounded to 256 events / 8 MiB;
  overflow preserves the tool result and blocks unsafe compaction. Raising or removing
  this limit is not a durable long-session design.
- The experimental journal pages immutable source groups, while the working projection
  remains bounded. Async ancestry preflight avoids blocking the event loop for the
  entire historical walk, but construction, bounded parsing and publication still have
  synchronous work. A bounded source cache is not a total-process RSS guarantee.
- `commitStagedContextEdit` changes the in-memory view/messages. Calling it and then
  saving asynchronously is not an atomic production transaction: a disk failure could
  leave a new active view without its durable parent record.

## Required publication order

1. A host-owned exclusive commit lease admits only a quiescent runtime. Keep keyboard
   input/cancellation responsive; queue new provider requests, task switches and tool
   execution until the lease is released. An idle snapshot alone is not a lease.
2. Freeze task activation, canonical root, effective provider/safety config digest,
   original working digest, projection revision, journal head and parent store revision.
   The model cannot choose or refresh these identities.
3. Prepare a separate bounded candidate view and provider context. Preserve the active
   view unchanged. Validate original source membership, complete native tool pairs,
   unknown effects, protected prefix, host facts and actual provider request budget.
   Derived notes cannot create execution evidence or change authority.
4. Perform cancellable ancestry/source preflight. At the final synchronous publication
   boundary recheck the host lease and every frozen identity; do not merely check that
   the candidate's own copied state is unchanged.
5. Atomically publish working messages + candidate projection + immutable journal head
   as one revision-CAS record. Before rename, failure/cancellation leaves the old parent.
   After rename, explicitly report a published revision if fsync/cleanup fails. Do not
   interpret such an error as no effect, automatically replay, or clear a stale lock.
6. After confirmed publication, install the candidate view and Agent messages together
   under the same host lease, then consume its proposal token. No provider/tool action
   may occur between publication and installation. If the process dies there, a fresh
   activation resumes the durable candidate; it never reconstructs state from a UI label.
7. Release the lease and drain queued user work once. A later cancellation cannot undo
   an already published checkpoint. Clearly distinguish preparation, cancellation before
   commit, committed state and durability uncertainty in the UI.

## Compatibility and rollout

Use explicit opt-in and a versioned store/protocol boundary. Do not add optional source
references to schema 2 and hope old writers preserve them. A migration creates a new
context-enabled record from a validated old record and leaves the original untouched;
older clients must report unsupported/unavailable rather than open an incomplete view.
The effective config digest includes the context mode/format. Disabling the feature
must not reinterpret a context-enabled checkpoint as legacy working history.

Do not silently migrate the existing production test sessions or credentials. Keep the
current provider-neutral compact path available for old sessions. UI display archives
are separate from model evidence and cannot be promoted to executed-tool truth.

## Tests required before enabling the path

- Pause preparation, then attempt a new user turn, task switch, provider/config change,
  permission change, close and cancellation. Either the lease queues/rejects them or the
  candidate is discarded; no stale candidate reaches a provider request.
- Inject failure before file write, during file sync, immediately before/after rename,
  during directory sync and during lease cleanup. Distinguish old intact, new published,
  durability uncertain and writer lock retained. Verify in a fresh process.
- Race two host writers at one expected revision. Exactly one publishes. Retained
  activation or proposal objects cannot outlive their runtime lease.
- Restart between durable publication and in-memory installation. Preserve the current
  task/root, unknown outcomes, native tool pairs, original user corrections and queued
  input semantics; never replay a mutation based only on a summary.
- Exceed the production ledger's 256-event boundary using real local read_file tools
  and a scripted provider, then exceed the small working-window source limit using the
  paged path. Report these as mechanism tests, not real-model memory accuracy.
- Measure event-loop delay, visible keystroke/scroll response, RSS, disk growth and
  checkpoint latency at increasing archive sizes. A responsive timer alone is not UX
  acceptance; a lower token count alone is not lower total latency or billed cost.
- Run matched-budget live model trials only when the authorized Coding Plan route is
  available again. Preserve the blocked 200/320 run as partial evidence; do not relabel
  it as validating later code or the unimplemented integration.

No SOTA, unlimited-session, all-platform, automatic-recovery or release claim follows
from this design. Main TaskSession lifecycle integration and cross-platform acceptance
remain explicit gates.
