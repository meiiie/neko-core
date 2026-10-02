# Scoped editable-context transaction prototype

This is an in-memory experiment, not a shipped Agent/TUI feature, not a CLM
reproduction, and not a replacement for Hindsight. No provider calls or background
services are started. Existing Neko context construction is unchanged.

## Contract under test

- The host supplies a branded task activation, a protected prefix and original evidence.
- A model supplies only parsed JSON view parts: original source references or derived
  notes with source references. It cannot submit a task/root identity or new authority role.
- Original evidence and the protected prefix are copied and frozen. View edits do not
  rewrite original evidence. A citation validates identity, not the truth of a model note.
- An edit is synchronous, requires a matching view revision and a quiescent runtime,
  and is rejected atomically if it names unknown sources or exceeds the byte budget.
- Undo creates a new revision. Admitting new evidence clears older undo states so an
  old undo cannot silently hide the new observation. Retired activations cannot read/edit.
- The prototype bounds archive bytes, view bytes, source count, view parts and undo depth.
  Byte budgets are not token budgets; an eventual provider adapter must also count tokens.

## Run

```sh
bun test test/context-projection-experiment.test.ts
bun node_modules/typescript/bin/tsc --noEmit -p experiments/context-projection/tsconfig.json
bun run lint
```

The test includes 320 local projection edits. These are deterministic state transitions,
not 320 LLM conversations. They do not fulfill the separate live Bunny endurance request.

## Missing before real integration

1. Durable original-history storage and atomic checkpoint binding to projection revisions.
2. A provider-message renderer preserving native tool-call/result groups, protected
   instructions and the active turn. Derived notes must never become new user authority.
3. An opt-in request/stage/commit path at a safe agent-loop boundary. The model may
   propose an edit during a turn; it must not bypass the quiescence/CAS contract to apply it.
4. Real-model evaluation of corrections, omitted facts, source accuracy, adversarial
   instructions and cross-task/folder isolation under fixed model and cost budgets.
5. Comparison with the current harness, an external-memory adapter, and their combination.

The original motivation and references are in
[the contributed improvement directions](../../docs/IMPROVEMENT-DIRECTIONS.vi.md).
No research implementation was copied into this prototype.
