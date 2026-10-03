# Scoped editable-context experiment

These paths are compatibility re-exports of the shared core/context and
adapters/context modules. The bounded projection and storage experiments remain
research utilities. A separate opt-in runtime integration now uses the same source
journal through TaskSessionCoordinator in CLI/TUI/ACP; see
[structured context](../../docs/STRUCTURED-CONTEXT.md). This is not a CLM
reproduction or a replacement for Hindsight. Legacy context remains unchanged.

## Implemented contracts

- `projection.ts`: runtime-branded activation, immutable evidence/protected prefix,
  source references, explicitly unverified derived notes, revision CAS, quiescence,
  bounded undo and resource budgets. Candidate validation is atomic and cannot reenter
  mutations or checkpoint an uncommitted archive.
- `storage.ts`: host-only atomic checkpoint publication, file/directory safety checks,
  working-checkpoint digest binding, separate storage CAS, payload integrity, preserved
  view revisions/undo, and read-only recovery while an existing writer lock remains.
  Stale locks are never automatically removed. The bundled path atomically stores
  provider messages, projection revision and an immutable journal head together, verifies
  selected-source ancestry, and rejects a downgrade to a detached projection. This experimental bundle format is distinct from the schema 3
  TaskSessionCoordinator parent used by the runtime integration.
- `paged-sources.ts`: content-addressed immutable groups and journal heads, bounded
  backward pages, stable branch cursors, exact source lookup and a 2-MiB/64-object source
  cache. Only active fact revisions remain in the head; old source bodies stay on disk.
  A parent checkpoint selects the frozen head. No global mutable tip can retarget it.
- `structured-sources.ts`: complete native user-turn groups; tool calls and results
  remain paired and byte-preserved. Original turns cannot be reordered. Derived notes
  cannot become system/user messages or tool outcomes. Unknown outcomes stay marked.
  Host-supplied provider token counting gates the complete rendered candidate before
  commit, without truncating a tool pair.
- Explicit host-selected user-source spans may carry fact keys and supersession links.
  Newest active spans are pinned independently of editable notes; stale/foreign
  supersession is rejected, and unresolved contradictions remain alternatives.
  This is NOT automatic natural-language extraction or factual/entailment verification.
- `staged-edit.ts`: one host-minted pending proposal per view; a proposal may be staged
  during a turn but cannot commit until quiescent. Exact working-prefix/tail checks
  preserve newly completed source groups. Unarchived tail, unrelated edits, stale
  working digests, foreign/replayed tokens and budget overflow reject without view commit.
  The host bridge assigns the validated provider messages without an asynchronous gap.
  The host must supply the previously sealed working prefix; a new tail must exactly
  match newly archived complete groups before it can survive the commit.

The storage hash detects inconsistent bytes; it is not authentication against an
attacker who can rewrite both payload and hash. Runtime scope, protected prefix,
execution authority and working-checkpoint binding are independently checked.

## Verification

Run the context tests, repository typecheck/lint and the explicit experiment tsconfig.
Tests include fresh-process recovery, interruption immediately before/after atomic
rename, native tool-pair rendering, a real Agent/read_file path with an injected
provider, 1,280 adversarial projection edits, and 320 explicit fact-correction/view-
compaction cycles with four disk recoveries. A 1,024-turn journal exceeding the small
in-memory archive is paged and reopened with a two-source working view; disk-full
injection preserves the previous head. These are deterministic mechanism tests,
NOT 320 LLM conversations or measured semantic-memory accuracy.

A deliberate negative characterization remains: a model note can contradict a valid
citation. Generic citations do not establish semantic truth. The typed host-selected
fact path keeps the accepted correction available despite such a note; it does not
prove that an arbitrary model will obey it.

## Remaining before live integration

1. Production integration of the bounded working window and paged journal. The
   editable view still caps 512 in-memory sources/8 MiB, while the disk journal is not
   capped by turn count. Individual turns cap at 2 MiB, the active fact index at 512
   alternatives, and parent checkpoints at 32 MiB. Source cache limits are NOT a total
   process RSS bound. Limits and disk errors fail closed without silently dropping history.
2. Wire the atomic bundle into the main task-session lifecycle and normal/automatic
   compaction under an explicit opt-in. Default compaction and TUI remain unchanged.
   Storage operations in this experiment are synchronous; production integration must
   keep large I/O and historical ancestry walks off the terminal input/render path.
3. A trusted user-confirmation/runtime path for fact annotation, including provenance
   and ambiguity handling. Model extraction must not self-authorize a user fact.
4. A provider-aware token counter/budget including native continuation and response
   reserve; tests use deterministic synthetic counters, not billing-token evidence.
5. Matched-budget real-model evaluation of latest corrections, source fidelity,
   contradictions, unknown facts, task/root isolation and final artifact outcomes.
   See [VALIDATION.md](VALIDATION.md). The prior real-model trial remains blocked;
   no endpoint or environment workaround is attempted to evade that denial.

The motivation and sources are in [the improvement directions](../../docs/IMPROVEMENT-DIRECTIONS.vi.md).
No research implementation was copied into this prototype.

## Local acceptance snapshot — 2026-10-02

The latest focused gate passed 203 tests / 14,308 assertions across context, Agent,
source provenance/lookup and task scope/persistence paths. Repository and experiment
TypeScript checks and lint passed. Linux only; this is not Windows/macOS CI acceptance,
a shipped mode, a default migration, or a real-model memory-quality result.


## Asynchronous ancestry preflight (local prototype)

`PagedSources.assertContainsAsync` performs the potentially long backwards membership
walk with asynchronous filesystem reads and cancellation. It reuses the synchronous
head decoder and integrity/descriptor checks, rejects a changed journal head or
retired runtime activation across awaits, and never publishes a checkpoint. A
128-head regression verifies that a timer can run before the walk finishes; negative
checks cover cancellation, append races, revocation and tampered disk bytes.

`saveContextBundleAsync` uses this preflight and rejects changed view revisions,
working messages, protected prefix or source references across awaits. Final
publication remains synchronous, quiescent and storage-CAS protected. Tests preserve
the old checkpoint after cancellation, resumed runtime activity or changed input, and
allow only one of two competing writers with the same expected revision to commit.
The rendered-context token-counter boundary also rejects reentrant view edits or
mutation of the rendered request rather than publishing an inconsistent bundle.

Construction, writes, fact checks, parsing and hashing still have bounded synchronous
work, and the existing load path still walks ancestry synchronously. A successful
read-only walk is not permission to commit a later changed state. No production
default, main TaskSession format, provider routing or live-model result is changed by
this prototype step. Production integration remains open.

Post-publication failures are also explicit: if the atomic rename succeeded but a
subsequent directory fsync or lease cleanup fails, the store throws
`ContextCheckpointPublishedError` carrying the published revision. The caller must
inspect before retrying; this is not proof of power-loss durability. Subprocess fault
injection verifies that revision 2 is readable, a stale revision cannot overwrite it,
and a failed lease cleanup leaves the lock in place rather than taking it over.
