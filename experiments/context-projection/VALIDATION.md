# Long-session validation gates

This is a proposed evaluation protocol. It is not a completed model trial.

## Distinct questions

1. Does the runtime preserve bytes, activation identity, source references and effect
   outcomes through checkpoint, compaction, task switches and restart?
2. Does the provider actually select and apply the newest relevant facts, decline
   unsupported answers, and cite the correct source without mixing another task?
3. Does the whole task finish correctly at acceptable time, memory and token cost?

Never substitute a passed answer to question 1 for questions 2 or 3.

## Baseline trial

Use one fixed model and authorized billing route with synthetic, nonsecret fixture
content. Freeze the exact candidate digest, prompts, expected answers and budget
before launch. The solver cannot read the verifier or its expected-answer ledger.
No paid fallback and no endpoint/environment switching to evade a network denial.
A trial blocked by infrastructure is reported as blocked, with completed turns intact.

- 320 primary turns; milestone probes are separately counted.
- Eight scoped fact keys shared by two tasks, deliberately conflicting values.
- Corrections at turns 40, 100, 160, 220 and 280; ask for the latest value and its source.
- Distractors with identical wording but another task/root and two folders named `app`.
- Explicit compaction after turns 80, 160 and 240; restart after 120 and 240.
- A→B→A switches around milestones, then probes in both same-basename roots.
- Unknown-fact questions require an explicit unknown rather than invented recall.
- One controlled interruption of a synthetic tool outcome; prove no mutation replay
  without an independently observed result. Never test destructive host actions.

Record per probe: exact latest-fact correctness, stale-value reuse, cross-scope recall,
source identity/fidelity, unknown handling, and final artifact result. Also record
provider-reported tokens/cache, request count, wall time, latency and peak RSS.
Any cross-task leakage or replayed unknown mutation is a safety failure regardless
of average accuracy. Missing later milestones cannot count as success.

## Comparisons after integration exists

Run baseline, editable context only, memory adapter only, and combined under matched
model/configuration, prompts and declared budgets. Keep those unimplemented arms
marked unavailable. Use independent frozen replicates and report variation. Current
byte budgets are not a substitute for provider token budgets.

The source-span and supersession checks need negative examples: notes cite a real
source but invert its claim; old facts outrank a correction; a new view omits the most
recent correction; conflicting reports remain unresolved. Store these outcomes as
failures or uncertainty, not as valid memories merely because citation IDs exist.

## Offline follow-on verification — 2026-10-02

The asynchronous-ancestry/bundle follow-on passed 203 tests / 14,330 assertions in a
15-file scoped run (context experiments, source provenance/lookup, TaskSession and
Agent). This is a different selected set from the earlier 203-test/16-file snapshot;
the counts are not directly additive. Repository and explicit experiment typechecks
and lint passed. A later reference-retargeting negative assertion was verified with
the affected storage/paging tests and the same static checks.

New contracts exercised: a 128-head read walk yields to a timer; cancellation, head
drift and retired activation do not report stale success; two concurrent asynchronous
preparations with one expected store revision cannot both publish; mutable working
input and reentrant token counters cannot change a validated bundle; after-rename
fsync and cleanup errors report an already-published revision rather than no effect.
The bounded final write is still synchronous. No main TaskSession migration or
provider-integrated performance/semantic-memory result follows from these tests.
