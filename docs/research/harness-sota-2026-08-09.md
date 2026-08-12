# Agent harness research and Neko Core audit - 2026-08-09

This note records a clean-room review of Neko Core v0.22.5, a direct `neko --yolo`
dogfood run, current public harnesses, primary lab guidance, and papers available by
2026-08-09. It also records the hardening implemented in the audit worktree. It is an
engineering decision record, not a leaderboard claim.

A focused companion audit covers the macOS iPhone Mirroring boundary, rejects embedding
raw Python/Quartz control, and specifies a typed effect-integrity protocol:
[`mobile-agent-safety-2026-08-09.md`](mobile-agent-safety-2026-08-09.md).

## Executive conclusion

Neko is already unusually broad and well tested, but it does not yet have evidence for
a frontier-performance claim. This audit closes several concrete trust and reliability
gaps; it does not substitute implementation breadth for matched benchmark evidence. The
next useful form remains a **verified task-state machine around a small agent loop**:

1. a trusted-project and secret-safe execution boundary (implemented here, with limits);
2. an append-only operation/effect journal as the source of truth;
3. explicit requirements and evidence that an executor cannot mark complete by itself;
4. recoverable context projections over the raw journal;
5. capability-bounded, cancellable subagents only where work is genuinely independent;
6. paired, repeated evaluation of success, reliability, cost, latency, and safety.

Adding generic reflection, a vector database, or mutating agent teams before those
foundations would increase cost and attack surface faster than capability.

## Direct dogfood evidence: baseline through the final exact-file lease

The probes used a disposable project and removed it after verification. The repository
itself was not used as the mutation target. These measurements precede the changes below;
the same-model, same-prompt repeated candidate evidence is reported later in this section.
It supports an efficiency claim for that exact microtask, not a broader harness ranking.

| Probe | Outcome | Provider-reported work |
|---|---|---:|
| One-line TypeScript bug, inspect/fix/test | Correct minimal edit; 2 tests passed | 12 model calls, 348,119 cumulative tokens, 120.3 s |
| Read/write boundary | Outside read succeeded; outside write was refused; inside write succeeded | 8 calls, 226,879 tokens, 71.7 s |
| Runtime facts, no tools | Incorrectly reported provider-host `approval=never` and PowerShell instead of Neko `mode=auto` and Git Bash | 1 call, 21,757 tokens, 38.3 s |
| One read-only shell observation | Correct `MINGW64_NT` result, then an unrelated verification round | 5 calls, 137,442 tokens, 78.3 s |

Most input in the bug-fix probe was cached, but cumulative context and latency are still
far too high for the task size. The main causes observed in the trajectory were duplicate
completion verification, overlapping provider/Neko runtime instructions, and a provider
skill catalog that advertised names Neko's `skill` tool could not load.

A later matched, disposable one-line TypeScript trial used the same `gpt-5.6-sol` model,
maximum effort, prompt, and initial fixture for both harnesses. Neko made the correct edit
and an independent host check passed 4/4 tests, but took 504.0 seconds, 48 model calls, and
2,556,744 cumulative tokens. Its SRT environment could not execute Bun, recovery spiraled,
and the pre-fix agent eventually used `computer` to run PowerShell outside SRT. Safe Codex
0.147.0 diagnosed the exact edit in 77.3 seconds (119,164 input and 2,209 output tokens) but
its requested Windows workspace-write sandbox remained read-only, so it neither edited nor
ran the tests and the fixture stayed at 2/4. This is not a pass/pass comparison or ranking.
After `computer` became an always-consent host capability, a live headless-yolo probe denied
both an open-PowerShell attempt and its retry before the backend ran. A bounded toolchain-
failure circuit now stops repeated Bun/Node/npm recovery attempts.

The first exact post-hardening Neko repeat used the same fixture hashes, model, maximum
effort, prompt, and environment controls. It made the same one-character edit and passed an
independent 4/4 host check in 118.2 seconds, 14 model calls, and 477,007 cumulative tokens
(473,828 input, 3,179 output, 428,800 cached). Bun ran inside SRT; no npm/npx recovery or
`computer` event occurred. Relative to the pre-fix Neko run this was 4.26x faster, 70.8%
fewer calls, and 81.3% fewer total tokens, but it remained excessive and was only one repeat.

A subsequent three-run matched set removed the host-skill collision, todo churn, non-Git
probe, and overlapping focused/full verification. Its p50 was 79.695 seconds, 9 calls, and
252,192 cumulative tokens (ranges: 77.589-116.122 seconds, 7-10 calls, and
199,209-283,841 tokens). All three runs made the exact edit and passed both SRT and
independent host validation. The remaining deterministic waste was a provider-native
`apply_patch` attempt against the isolated transport cwd; generic debugging/TDD skills also
cost one or two rounds.

The accepted **pre-lease structural baseline** disabled App Server environment access,
removed ambient provider skills/project instructions, and suppressed the Neko `skill`
surface only for a conservatively classified single-file microtask. Three sequential trials
passed 3/3. Its p50 was **46.810 seconds, exactly 5 model calls, and 119,320 cumulative
tokens** (ranges: 39.009-57.137 seconds and 118,794-119,518 tokens; input p50 118,539,
output p50 687, cached p50 91,136). This remains the comparison baseline, not evidence for
the current source.

The final exact-file lease candidate was frozen at source fingerprint
`31809bf...adff9` and run from three wholly fresh, independently hash-checked fixtures.
Every trial began at 2/4, made exactly one edit, passed full validation 4/4 both inside SRT
and through an independent host check, preserved the expected inventory/hashes, and exited
without temporary artifacts. Provider apps/MCP and native project/skill/environment access
were off; skill, native patch, environment, todo, Git, computer, hidden/rejected tool, shell
probe, out-of-target edit, and non-validator counts were all zero.

| Trial | Validator path | Wall | Calls | Input | Output | Cached | Total |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `bun test` | 41.656 s | 5 | 69,715 | 816 | 52,224 | 70,531 |
| 2 | `bun test` | 42.523 s | 5 | 68,203 | 631 | 38,144 | 68,834 |
| 3 | `npm test` -> `bun test` | 42.008 s | 4 | 54,036 | 476 | 38,144 | 54,512 |

The official fresh-set p50 is **42.008 seconds, 5 model calls, 68,203 input, 631 output,
38,144 cached, and 68,834 cumulative tokens**. Ranges are 41.656-42.523 seconds, 4-5
calls, 54,036-69,715 input, 476-816 output, 38,144-52,224 cached, and 54,512-70,531 total.
Against the accepted pre-lease p50, total tokens fell **42.31%**, wall time fell **10.26%**,
and calls were unchanged. A prior 68,900-token diagnostic and an earlier failed trial 2
preceded the final safety fixes; both are discarded and excluded from every aggregate. No
trial from a different source revision was pooled into this set.

A deterministic no-model serialization audit explains the fixed-context part of the gain.
For the canonical prompt it measured 17,766 bytes of Codex base instructions, 14,044 bytes
of Neko developer context, 2,090 bytes for exactly three schemas (`read_file` 625, narrowed
`edit` 693, narrowed `bash` 768, plus four bytes of array punctuation), and 205 user bytes:
**34,105 bytes total versus 73,255, down 39,150 bytes or 53.44%**. The deliberately coarse
four-bytes-per-token estimate is about 9,788 fewer tokens per call; it is not provider-billed
usage. The corresponding transport observations were 16,496 bytes for `thread/start`, 344
for `turn/start`, and 251 encoded input bytes. These are deterministic surface sizes, not a
task-success or leaderboard result.

Together the fresh runs are repeatable scoped evidence consistent with the exact-file lease causing the
improvement on this microtask, not a randomized causal study, a
multi-task benchmark or a SOTA/leaderboard claim.

At the start of the audit, `doctor` reported that the requested Windows bash sandbox was
unavailable. The host was subsequently provisioned with Anthropic Sandbox Runtime (SRT)
v1.0.0, and a bounded launch-only health probe passes. The probe does not independently
exercise filesystem or WFP egress denial, so diagnostics say that explicitly. `doctor`
now reports the live launch result rather than configuration intent. This improves the
local boundary, but Windows support is explicitly alpha and SRT is a beta research preview;
it is not a general authorization boundary for an outer `codex --yolo` process.

## Changes implemented in this audit worktree

1. **Closed mixed-case permission escalation.** Mutating `memory`, `workflow`, and
   `playbook` actions are normalized before policy evaluation. `WRITE`, `Delete`, and
   `ADD` can no longer bypass plan/default permission handling.
2. **Made completion verification evidence-aware.** A successful fresh inspection or
   test after the last mutation satisfies the generic finish gate. Independent
   state-change verification remains fail-closed. This removes the duplicate model turn
   from the common edit-test-finish trajectory.
3. **Counted tool schemas in context estimates.** The default native catalog is 14,369
   JSON characters (about 3,593 estimated tokens). It now participates in the in-loop
   overflow guard, live usage estimate, resume decision, `/context`, remote status, and
   footer percentage.
4. **Closed two secret-read paths.** Credential paths are refused inside and outside the
   workspace, checked through realpath aliases, and filtered from recursive read tools.
   `@import` in project/global instruction files can no longer escape its instruction
   directory or inline credential-shaped files.
5. **Added exact-snapshot project trust.** Project config, context and imports, skills and
   assets, agents, and recipes are quarantined until their canonical exact-cwd snapshot is
   recorded by `neko trust add`. Any structural or byte change invalidates the whole layer;
   corrupt, linked, polluted, oversized, or over-capacity stores fail closed. Project hooks
   and MCP servers are rejected even after trust and remain global-only. The public add
   command rejects ordinary non-TTY automation as friction, not as proof of a human.
6. **Scrubbed child-process credentials.** Bash, hooks, computer-use helpers, and MCP
   children do not inherit provider or harness credentials. An MCP server receives only
   the environment entries explicitly configured for that server.
7. **Made autonomy diagnostics factual.** The dynamic runtime block, `doctor`, and
   `policy` distinguish Neko's effective mode, actual shell, live SRT state, and network
   policy from provider-native tools. Auto mode refuses direct Docker/Podman host-daemon
   commands unless `allow_dangerous_bash` is explicitly enabled.
8. **Hardened public HTTP.** `web_fetch` validates every DNS answer, pins the selected
   public address, revalidates each redirect, strips cross-origin credentials, and bounds
   headers, redirects, time, and streamed bodies (2 MiB). GitHub and YouTube URLs use this
   same path; automatic SAFE `gh`/`yt-dlp` routes were removed so PATH hijacking, ambient
   credentials, or authenticated private-repository access cannot bypass public-HTTP policy.
9. **Made provider streams fail closed.** OpenAI-compatible, Anthropic, and Responses API
   streams bound lines, aggregate bytes, outputs, reasoning, and tool calls; validate event
   state; release readers; and reject malformed, incomplete, filtered, or truncated results
   instead of returning successful partial answers. Tool callbacks preserve emission order.
10. **Narrowed task capabilities.** `task` is gated by default. Reviewer/explorer profiles
    are read-only and allowlisted; generic/custom tasks retain inherited authority but are
    serialized. Abort signals reach child agents and owned providers are disposed.
11. **Hardened sessions and retry.** Session IDs, shapes, sizes, file identity, and index
    records are validated. Internal controller messages are marked locally, stripped from
    provider requests, and skipped by retry/rewind so a controller prompt cannot replace
    the user's actual turn.
12. **Made MCP effects explicit.** Calls receive cancellation and a 60-second total
    deadline. A failed mutating call is reported as outcome-unknown and is never blindly
    replayed. Duplicate composed tool names fail closed instead of dispatching ambiguously.
13. **Separated runtime and skill namespaces.** The model receives one authoritative Neko
    dynamic-tool runtime block. Only Neko-callable skills are advertised as Neko skills;
    provider-host tools and skills no longer masquerade as Neko capabilities.
14. **Added a summary-only handoff foundation.** `neko handoff send` publishes an immutable,
    strictly validated local envelope and `neko handoff inbox` lists pending messages. In
    the TUI, `/handoff send <target> <summary...>` first persists the current source session,
    while `/handoff inbox` inspects the current session's inbox. The payload is bounded to
    16 KiB and labeled `local-unverified`; no transcript, files, credentials, or implicit
    target-session context are attached automatically. Sender-authored summary text may itself
    contain sensitive data and remains untrusted.
15. **Separated bounded autonomy from host control.** `computer` requires an explicit gate even
    in auto/yolo, so a sandboxed coding turn cannot silently open a real host shell. Bash aborts
    and deadlines terminate a process tree with bounded graceful/forced phases and report when
    cleanup cannot be confirmed. Repeated unavailable toolchain attempts trip a per-turn circuit.
16. **Made prompt and terminal metadata inert.** Cwd, Git refs, provider/model labels, session
    metadata, streamed model bytes, and tool observations are bounded and control-escaped before
    entering XML-shaped prompts or terminal renderers. Split OSC/CSI sequences cannot reconstruct
    clipboard/title/color control channels across streamed chunks.
17. **Hardened local sidecar launch.** Codex/Gemini and global stdio MCP executables are canonical
    regular files resolved outside an untrusted workspace; child PATH/cwd cannot point back through
    a junction, runtime loader variables are removed, and provider sidecars use positive environment
    allowlists. MCP gets a minimal OS baseline plus explicit global config grants only.
18. **Added a side-effect-free package entry.** Bun/TypeScript hosts can import the core Agent,
    ToolRegistry, gates, ports, costs, and schemas from `neko-core` without starting CLI/UI/provider
    adapters. This makes harness embedding an executable contract rather than a package-description claim.
19. **Bridged Bun into Windows SRT without a profile grant.** Source-run Neko resolves one canonical,
    regular `bun.exe` outside the workspace. SRT receives a transient `allowRead` for that exact file and
    Git Bash receives an alias to the same frozen identity. Concurrent sessions are refcounted; the last
    reset removes the ACE. A compiled Neko with no trusted external Bun reports that limitation in `doctor`.
20. **Removed overlapping App Server authority.** Every Neko sampling thread uses an isolated transport
    cwd, disables project documents, ambient native skill instructions, plugins/apps/shell surfaces, and
    passes `environments: []`. Provider-native shell/`apply_patch` therefore disappear while Neko dynamic
    tools remain available through the single ToolRegistry policy boundary. Image generation opts back into
    only its required native capability.
21. **Made the microtask fast path a whole-turn capability lease.** An exact one-file,
    smallest-fix, explicit-validator task with no attachment, matched domain, or explicit skill receives
    only `read_file`, exact-target `edit`, and foreground-validator `bash`. Narrowing starts from raw user
    or delegated text, requires a canonical existing single-link target, intersects rather than widens the
    configured/role surface, and defaults to full on ambiguity. CLI, TUI, and subagents close the lease in
    `finally` before queued input can start the next turn.
22. **Made verification debt machine-readable.** Successful mutations advance an epoch; failed, denied,
    backgrounded, masked, interrupted, or stale validators cannot clear it. `runUntilDone` cannot turn a
    bare `DONE` into success while debt remains, and headless runs return nonzero while preserving their
    useful partial answer. A present-but-unhealthy SRT now refuses bash before launch instead of falling
    back to the host; SQLite `4874`/`xShmMap` failures get bounded state-volume guidance.
23. **Made exact-file validation filesystem-read-only.** Its `bash` accepts foreground
    test/typecheck/lint/check/verify commands only; every `&&` segment must independently qualify. Build
    targets, fixing/writing flags, masking, redirection, substitution, and background execution are absent.
    A live OS sandbox is mandatory: the original project is mounted read-only, while `TEMP`/`TMP`/`TMPDIR`
    point at one unpredictable writable directory outside it that is removed after launch. Missing or
    unhealthy isolation fails closed before approval or hooks.
24. **Kept nested Windows validators least-authority.** `npm test` receives a launch-local, read/execute-only
    `bun.cmd` shim whose target comes through canonical environment indirection. Current-directory lookup is
    disabled, no parent/profile directory grant is inferred, and the shim plus temporary ACLs are removed on
    cleanup. This lets nested package scripts reach the same certified Bun without widening SRT authority.
25. **Rejected static hard-link write aliases.** The exact planner refuses an existing target with
    `nlink != 1`; runtime checks do the same for every existing `write_file` overwrite, `edit`, and
    `multi_edit` target before approval, review, or hooks. New-file creation remains available.
26. **Made rewind preserve interleaved editor changes.** After Neko writes a path, a later structured
    mutation first compares current bytes with Neko's prior output. Divergence taints the checkpoint,
    refuses the mutation, and makes `/rewind` preserve the path while reporting a bounded conflict. A failed
    retry cannot clear the taint.

These changes are covered by focused regression tests, both supported TypeScript checks,
and the full suite. They materially improve the observed boundaries, but do not make
`--yolo` universally safe: unconfined same-user code can edit policy state, SRT for Windows
is alpha and its current health check is launch-only, allowed network domains can still
carry exfiltration, static identity checks retain a check-to-write race, read-to-write digest/CAS is
still absent, and no effect journal or repeated multi-task benchmark has landed.

## What the newest evidence changes

### Verification before orchestration

[LongHorizon-Harness](https://arxiv.org/abs/2608.01964) (2026-08-03)
uses Manage-Execute-Audit: durable task state outside the model, fresh executors, and a
read-only auditor. Executor claims are untrusted until evidence advances state. Reported
gains are substantial, but cost is benchmark-dependent: the paper reports about 2.3x
total tokens on WeaveBench, 3.6x output tokens on OSWorld 2.0, and 24% fewer tokens on
Terminal-Bench 2.1. It is a very new preprint, not evidence for one fixed multiplier.

[OneDayAgent](https://arxiv.org/abs/2608.05013) (2026-08-04) combines
decomposition, compact checkpoints, global verification, and targeted repair. Its
ablation is the useful result for Neko: verification alone captured much of the benefit
at lower cost, while the full pipeline scored highest. Its host execution model is not a
safety pattern to copy.

Therefore Neko should keep its simple loop by default, run evidence-backed verify/repair
for mutations, and enable planner/executor/auditor only above a measured complexity or
risk threshold.

### Concurrent work needs optimistic concurrency

[SWE-Touch](https://arxiv.org/abs/2608.02499) (2026-08-03) reports an
average 7.7 percentage-point resolution drop after valid counter-edits. Neko should make
`read_file` return a digest/generation, let `edit` require an optional `expected_hash`,
and stop for re-read/reconciliation on mismatch. A workspace fingerprint should be part
of finish evidence. The current checkpoint guard closes the narrower case where user/editor
bytes diverge between two Neko structured writes, but it is not read-to-write optimistic
concurrency and does not close a filesystem identity swap race.

### Context must be recoverable, not merely summarized

[Context Compaction Theory](https://arxiv.org/abs/2608.01326),
[Agentic Context Management](https://arxiv.org/abs/2607.23809),
[ARC](https://arxiv.org/abs/2607.25066), and
[SWE-MeM](https://arxiv.org/abs/2606.28434) converge on the same separation:
raw events remain append-only and addressable; active context is a bounded projection
with recent high-fidelity spans, structured state, and pointers back to raw evidence.

Neko's current `compact()` destructively replaces old messages and the next session save
overwrites the only copy. The smallest compatible next slice is a session-scoped JSONL
archive written before compaction, with an archive ID in the summary and bounded recall.

[Agent Memory: Characterization and Evaluation](https://arxiv.org/abs/2606.06448)
also argues against prematurely adding a vector/graph memory default: lexical retrieval
is competitive, memory construction can dominate cost, asynchronous writes become stale,
and pruning is generally weak. Start with lexical retrieval over versioned event artifacts,
provenance, freshness, and explicit budgets.

### Harness effects must be measured, not assumed

[The Scaffold Effect](https://arxiv.org/abs/2607.22585) shows that harness
choice can change token cost per solved task dramatically while many pass-rate gaps are
small or statistically uncertain. OpenAI's
[SWE-bench Verified retirement note](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
and [coding-evaluation noise audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/),
plus Anthropic's [infrastructure-noise study](https://www.anthropic.com/engineering/infrastructure-noise),
make a single smoke run or leaderboard insufficient evidence.

### Cross-session messages are capabilities, not shared memory

Claude Code v2.1.224 (released 2026-08-07) added cross-session
[`SendMessage` and `ListAgents`](https://github.com/anthropics/claude-code/releases/tag/v2.1.224).
Its [official documentation](https://code.claude.com/docs/en/cross-session-messaging)
describes plain-text messages rather than transcript/file transfer, receiver-side inbound
controls, delivery failures, loop throttling, and same-user local sockets. Native Windows
is not supported. The useful architectural lesson is explicit transport plus receiver
policy; it is not permission inheritance or automatic shared context.

Neko's first slice is intentionally smaller and stricter. `session-handoff.ts` stores one
immutable summary envelope under `~/.neko-core/handoffs/v1/pending`; source provenance is
derived from a validated saved session and remains self-contained if that session later
changes. The inbox rejects malformed, oversized, linked, or escaping files and caps a scan
at 1,024 entries. It does not inject into history, acknowledge, consume, delete, or claim
exactly-once delivery. The TUI display is deliberately capped at 10 items and 2,048 summary
characters, with no polling. Acceptance/CAS and pagination remain future work.

### Sandboxes must be selected by their threat model

The local Bun runtime was upgraded from stable 1.3.14 to
`1.4.0-canary.1+52bf09cb1`. This is deliberate: Bun 1.3.14 can lose raw stdin on
some Windows builds, whereas the canary passes Neko's real ConPTY input probe. CI/release
already pin the canary for affected native Windows builds and use stable where appropriate;
this is a compatibility decision, not a performance claim. See the
[Bun 1.3.14 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14).

Anthropic's [Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
Windows helper v1.0.0 is live on this host and its launch behavior was probed. Egress is
configured fail-closed and covered structurally, but has not been independently live-probed
on this host. Upstream labels the package a beta research preview and Windows support alpha. It contains Neko's dynamic
`bash`; it does not make an independently launched, unsandboxed harness safe.

[Agent Substrate](https://github.com/agent-substrate/substrate) was evaluated and rejected
as that outer boundary. Its own [threat model](https://github.com/agent-substrate/substrate/blob/main/docs/threat-model.md)
says the project has little to no security hardening, while its
[README](https://github.com/agent-substrate/substrate#readme) says it is early development
and not production-ready. Its architecture targets a Linux/Kubernetes data plane and
still identifies default-deny egress, authentication/authorization, audit, and worker
deprivileging as required mitigations. That is a research direction, not a safe native
Windows replacement for Codex or Neko isolation today.

## Lab guidance that maps cleanly to Neko

- OpenAI's [Codex agent-loop analysis](https://openai.com/index/unrolling-the-codex-agent-loop/)
  supports a cache-stable prefix, deterministic tool ordering, append-only rollouts, and
  provider-aware compaction.
- OpenAI's [harness engineering](https://openai.com/index/harness-engineering/)
  treats repository legibility, versioned plans/decisions, and executable policy checks as
  core infrastructure rather than prompt decoration.
- Anthropic's [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  treats tools and results as part of the finite attention budget; only decision-relevant
  state should stay active.
- Anthropic's [managed-agent architecture](https://www.anthropic.com/engineering/managed-agents)
  separates an append-only session from replaceable context and sandbox projections.
- OpenAI's official [skills guide](https://learn.chatgpt.com/docs/build-skills)
  and [subagent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  reinforce progressive disclosure, narrow roles, and explicit capability inheritance.
- Anthropic's [tool-design guide](https://www.anthropic.com/engineering/writing-tools-for-agents)
  favors workflow-shaped tools, bounded/paged output, actionable errors, and trajectory evals.

## Target architecture

### P0: trust and effect integrity

- **Implemented in this worktree:** exact-byte project trust and whole-layer quarantine;
  provider/harness credential scrubbing for children; CLI-override-aware diagnostics;
  bounded SRT launch health; explicit host-daemon capability; and SSRF/redirect/DNS-rebinding/
  output limits for public HTTP.
- Project hook/MCP execution stays global-only because safely attesting an interpreter and
  its transitive executable dependency graph is not a bounded project-snapshot operation.
  The user-global layer remains powerful user policy.
- When no live sandbox exists, keep unconfined autonomy visibly unsafe and fail closed for
  host-daemon commands. A portable outer containment boundary remains unresolved.
- Persist operation lifecycle as `intent -> effect_started -> settled -> output_committed`.
  A crash after a possible side effect becomes `outcome_unknown`, never an automatic replay.
  MCP now avoids replay after an unknown outcome; the durable journal itself remains open.

### P1: verified state and bounded delegation

- Store `requirement | artifact | fact` records with acceptance criteria, dependencies,
  evidence references, workspace generation, and `pending | complete | blocked | untrusted`.
- Only a deterministic check or read-only auditor may promote completion.
- **Implemented in this worktree:** reviewer/explorer read-only capability profiles, shared
  cancellation, no nested task tool, and serialization for generic/custom work that may
  mutate shared state. Child permissions can only narrow parent rights.
- **Implemented in this worktree:** an authoritative Neko dynamic-runtime block and a
  callable-only Neko skill catalog, distinct from provider-native tools and skills.
- **Implemented in this worktree:** a per-path interleaving guard refuses a later Neko
  structured mutation and taints rewind when bytes changed after its prior write.
- Keep shared mutations serialized until worktree isolation, read-to-write optimistic
  concurrency, and the effect journal exist; the checkpoint guard is not cross-agent CAS.

### P2: recoverable context and efficient discovery

- Keep raw sessions append-only; compact only the active projection.
- Store `raw_span_id`, remaining work, decisions, tests, touched files, errors, and negative
  constraints in each context capsule.
- Keep only callable Neko skill names in the Neko catalog (implemented). Proof-grade exact-file
  turns now serialize only three built-in schemas; generic turns still carry their configured
  built-in catalog, so general on-demand discovery and large-schema/skill-body loading remain open.
- Add a small symbol/import repo map only after an A/B against `rg` proves a better
  success/cost frontier.

## Evaluation and promotion gate

Do not run host `codex --yolo` for comparison. The official
[Codex CLI reference](https://developers.openai.com/codex/cli/reference/) defines that alias
as disabling both approvals and sandboxing. Until there is an independently authorized outer
boundary, use an ephemeral Codex run with `workspace-write`, `ask-for-approval=never`, ignored
user/rule config, and the same disposable fixture. Label that result accurately: it is a
sandboxed non-interactive Codex comparison, not a `--yolo` comparison.

Every candidate harness change should be a paired baseline-versus-candidate experiment
with the same model snapshot, effort, prompt/tool/skill hashes, privileges, hardware,
timeouts, retry policy, and task seed. Record:

- pass@1 with confidence interval and `pass^k` reliability;
- acceptance coverage and safety violations;
- cached/input/output tokens, calls, cost per success, latency p50/p95;
- tool errors/retries, infrastructure failures, and user corrections;
- full trajectory, harness commit, and clean/dirty workspace fingerprint.

### Built-in evaluator integrity in this worktree

The built-in coding ruler now follows the production headless path instead of constructing a
benchmark-only agent. Every task/trial receives a fresh provider and fresh directory, the production
registry/context/turn capability planner, the default verification gate, and the same typed
`completionStatus`. A task passes only when its deterministic end-state verifier, every hard seeded-file
invariant, and the production completion contract all pass.

Trial outcomes are explicit: `pass`, `model_failure`, or `infra_error`. Infrastructure trials remain in
the scheduled denominator and make the report **NOT COMPARABLE**; the CLI exits non-zero instead of
publishing a misleading low model score. `pass@1`, strict `pass^k`, completed tool calls, token work,
redundancy, constraint adherence, and latency/SLA now use the actual scheduled trial records. Provider
instances cannot be recycled across trials.

JavaScript verification no longer executes model-authored code directly on the host. It requires a live
OS sandbox, blocks network, makes the original workspace read-only, supplies one unique writable temp,
uses a positive child-environment allowlist, ignores candidate `.env`/bunfig/autoinstall, and selects a
canonical Bun outside the trial root. A separate sandboxed Bun preflight classifies launcher failure as
infrastructure. The harness streams an in-memory verifier through a protected supervisor and accepts success
only after normal host process status plus an unpredictable harness-owned terminal attestation; candidate output
or an early clean exit is insufficient. Output is bounded and never copied into infrastructure diagnostics.
Primitive-certified normal close
owns its descendant postcondition; abnormal close, timeout, output overflow, and spawn failure use a bounded
tree terminator. Any unconfirmed cleanup invalidates the measurement. PID namespaces/parent-death on Linux,
a no-fork/no-external-signal `exec` profile on macOS, and SRT's Job Object plus the shared verified tree
terminator on Windows prevent detached verifier descendants from surviving cleanup. Seeded tests and inputs are
canonical single-link regular files and are checked before any protected oracle is executed. The old
four-index FizzBuzz sample was also replaced by an exact 100-line oracle.

The dedicated oracle regression is mandatory on Linux and macOS CI: Ubuntu installs Bubblewrap and runs it
with the hosted runner's unprivileged-user-namespace restriction temporarily disabled/restored, while macOS
uses its built-in Seatbelt primitive. `NEKO_REQUIRE_SANDBOX_TESTS=1` converts a missing primitive into a hard
failure. GitHub-hosted Windows remains deliberately outside this automatic gate because alpha SRT requires
elevated, stateful account/WFP provisioning; Windows evidence must come from an explicitly provisioned host.

This hardens measurement fidelity; it does **not** create new multi-task evidence. No paid multi-task run
was performed in this tranche. The existing exact microtask set remains the only current live causal
measurement, and remains insufficient for a SOTA claim. This policy follows OpenAI's
[trustworthy third-party evaluation foundations](https://openai.com/index/trustworthy-third-party-evaluations-foundations/),
[coding-evaluation noise audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/),
and [SWE-bench Verified retirement note](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/),
together with [METR task-completion time horizons](https://metr.org/time-horizons/) and
[`pass^k` reliability from tau-bench](https://arxiv.org/abs/2406.12045).

The worktree now also contains a deliberately small `frontier` calibration suite: config resolution/cache
isolation, in-flight promise recovery, and atomic batch publication. Unlike the saturated `hard` tier, prompts
do not name the faulty line or textbook algorithm. Each task protects its public contract/test/inventory and
uses post-turn hidden edge cases in a newly copied, external, read-only verifier workspace. Solver tools are
held to a fixed local-only/no-network ceiling and 25 steps; Bash is foreground validator-only with the fixture
read-only, structured reads cannot leave the trial fixture,
and the sandbox masks the known source, reference, and built benchmark implementation files from candidate
commands. Frontier contracts additionally prohibit process termination and host/runtime inspection, and a bounded
static check rejects direct forms. That textual rule is defense in depth: harness-owned attestation establishes
completion, and hidden assertions are streamed rather than written beside candidate modules. The assertions are
not sent in the prompt, but this is an open-source contamination control rather than a claim of cryptographic
secrecy. Candidate and assertion code still share one Bun process, so stack/runtime introspection can disclose
assertion-module details even though it cannot forge the harness suffix. A sealed private tier therefore needs a
separate executor and verdict trust domain. Seed failures and reviewed reference repairs are offline/live-regressed.
A later bounded calibration
ran one trial per task at the harness-reported effective configuration `gpt-5.6-luna` / effort `max` (an
attempted PowerShell override to Sol failed before launch and is not counted). It passed all 3 tasks with zero
model or infrastructure failures: 103,052-191,103 tokens and 104.0-314.7 seconds per task, 136,556 aggregate
tokens/success, 8% redundancy, 47% step efficiency, and 100% constraint compliance. One trial per task cannot
estimate reliability, but this 3/3 result falsifies the intended non-saturation check cheaply. The tier is now
a regression/calibration surface; repeating it or moving to a stronger model would spend more without fixing
the ruler. The suite name itself conveys no leaderboard claim.

Future evals now emit `neko.eval.trajectory.v1`, a bounded metadata-only record rather than a raw transcript.
It retains exact provider/tool counts, typed outcomes, opaque target references, result/redundancy classes, and
explicit omissions, while excluding raw arguments, paths, commands, observations, error text, final answers, and
environment values. The fixed v1 envelope is capped at 4 MiB and local append failure is reported. The saturated
three-task Luna run predates this artifact and is not retroactively presented as having one.

The comparison surface is less dependent on host-global state at the Neko context boundary: trials use an empty
isolated home and no user hooks, so global identity, core memory, and executable automation cannot enter a run.
Bench, eval, and harness-lift reports carry a SHA-256 identity over the source tree or compiled executable,
task seeds/contracts, verifier identities, step budget, runtime version, platform/architecture, effective sandbox,
and the canonical redacted resolved configuration plus selected profile; eval also binds its SLA. A mid-run identity change is
infrastructure failure. The external verifier Bun binary is not independently hashed, so this is not a claim of
machine-independent or byte-identical toolchains. Injected verifier closures are also identified by function source,
not captured state; the proposed private pack therefore requires explicit manifest and verifier digests.

Any source or safety-boundary change invalidates the prior candidate set. Freeze the source
and run a wholly fresh repeated set; never extend an aggregate with a diagnostic, a failed
trial, or a trial from another source revision.

The suite should combine deterministic Neko fixtures (permissions, prompt injection,
crash/replay, compaction recall, MCP timeout/idempotency, counter-edits, and finish evidence)
with [Terminal-Bench 2.1](https://www.tbench.ai/news/terminal-bench-2-1),
[DeepSWE](https://arxiv.org/abs/2607.07946),
[SWE-EVO](https://arxiv.org/abs/2512.18470),
[SWE-Marathon](https://arxiv.org/abs/2606.07682), SWE-Touch, and
[MCP-Atlas](https://arxiv.org/abs/2602.00933). SWE-bench Verified remains a legacy
regression only.

No SOTA wording should ship until the full public task set is run repeatedly, artifacts
are published, uncertainty is reported, privileges/resources are matched, and the result
improves the Pareto frontier rather than pass rate alone.

## Immediate ordered backlog after this worktree

1. Append-only operation/effect journal plus a pre-compaction raw archive.
2. Hash-aware reads/edits, workspace generations, and a concurrent counter-edit eval. The
   narrower between-Neko-write checkpoint guard is implemented but is not read-digest CAS.
3. Exactly-once/CAS handoff acceptance, explicit receiver consent, and paginated inbox
   traversal; keep transcript/file transfer out of the default envelope.
4. Bound MCP SDK result materialization before adapter-side formatting, and cover deliberately
   daemonized processes that escape an ordinary local process tree.
5. Fail-closed unconfined autonomy on hosts without a live sandbox and continued SRT alpha
   validation; never treat `codex --yolo` on the host as contained.
6. Preserve the fresh-set-per-source rule, then broaden the matched suite across tasks and
   seeds and publish complete artifacts before any SOTA claim.
