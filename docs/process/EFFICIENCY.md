# Harness efficiency

Reduce avoidable work while preserving observable acceptance criteria, current context,
tool authority, checkpoints and truthful completion. Fewer tokens alone are not a quality
metric. This implements the portable parts of Anthropic's
[cost/performance guidance](https://claude.com/blog/reducing-cost-and-improving-performance-with-claude-platform);
it does not transfer that article's benchmark gains to Neko.

## Stable context, current state

The single canonical system message separates the base instructions, session context and
turn context. Project, identity and callable skill/memory/MCP indexes precede the changing
runtime, Wiii Computer manifest and todo state. Every section still refreshes through the
existing turn-context lifecycle; a project, policy or tool change must invalidate its prefix.
An absent capability stays absent from both context and executable schemas.

The Anthropic adapter places at most three system-prefix cache breakpoints and one rolling
conversation breakpoint. Other adapters receive the same canonical content without needing
an Anthropic-specific feature. Actual hits depend on the endpoint, model, cache minimums,
lookback and expiration; stable prefixes are not a guarantee of a cache hit.

An explicit 400/422 `cache_control` rejection disables explicit caching for that adapter's
current endpoint/model scope after one retry. A different scope can probe again. Authentication,
permission and rate-limit failures do not silently disable caching. See the official
[prompt-caching contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

No paid cache warm-up, one-hour retention, provider-native deferred tool loading or forced
model/effort downgrade is enabled. These require separate capability checks and measured
benefit on the actual workload. Existing tool discovery and permission limits remain in force.

## Evidence-driven completion

The base prompt removes compulsory workflow/playbook writes and fixed research-source counts.
Durable learning is for reusable information. Research uses current primary evidence and
cross-checks when ambiguity, conflicting claims, consequences or the task require it.
Verification follows the task and repository, not a preferred validator or extra dependency.
Already valid evidence is reusable until a relevant change, contradiction, unresolved risk
or explicit repeatability requirement justifies another check.

For a mutation without valid outcome evidence, the loop sends at most two state-verification
nudges per unchanged mutation state. Another unsupported final produces `outcome_unverified`
rather than repeated prompts or a success claim. A step limit with an unknown outcome also
stops without spending another request on a tool-less wrap-up. This is a bound on unsupported
final answers, not a deadline on reasoning or a cap on productive tool work.

New mutations invalidate evidence. Valid observations clear the missing-state gate; an
independent completion review can resolve it only when the current contract passes. Failed
required validators still retain their own debt. Tools and unknown mutation outcomes are
never replayed by this mechanism. The final status is checkpointed, headless runs exit with
failure when unverified, and the TUI shows the warning even after streaming a confident reply.
An unverified turn does not play the success alert.

## Local diagnostics

`/cost` keeps its existing provider-reported token accounting and adds an efficiency
summary for the current runtime. `CostTracker.efficiency.snapshot()` provides aggregates;
Agent's `request_metrics` event provides one safe numeric/category record per measured request.

| Signal | Meaning and limit |
|---|---|
| Requests, errors, aborts, retries | Agent-owned work, compaction and wrap-up requests; scheduled transport retries are counted separately. Hidden provider-native calls and independent-review requests are not separate entries here. |
| Request p50/p95 | Most recent 64 completed requests, including errors/aborts, provider retries and managed tool time; not end-to-end task latency. |
| First streamed event p50 | Most recent 64 requests with a nonempty delta or ready tool call; may be reasoning or a notice, not provider TTFT. Missing streaming stays `n/a`, not zero. |
| Prefix changes | Canonical base/session/turn/tools/effort-override changes and provider-instance changes; not wire-cache diagnostics or proof of a miss. |
| Identical read observations | Same read arguments and textual result within an unchanged local mutation interval. Waits and large/image results are excluded. External state may still change; reads are never skipped. |
| Verification nudges/stops | Host reminders and explicit unverified stops, not a quality score. |

The tracker keeps only aggregates, bounded samples and private SHA-256 digests in RAM. It
does not log or export prompt/tool content, paths, credentials or digests, write a new session
format, send telemetry, or make model requests. Observations reset at loop boundaries and
mutations; at most 64 read identities are retained. Existing transcript persistence is separate
and unchanged. Actual cache-read/write usage remains the provider-reported usage in `/cost`.

## Evaluation and promotion

Use the existing [evaluation contract](EVALUATION.md), not another benchmark framework.
ProgramBench remains paused until the owner explicitly resumes it. Ordinary verification
uses deterministic fixtures, not a paid campaign or `scripts/self-improve.ts`.

For an authorized comparison, freeze the task set, repository/source digests, provider/model,
tool and network policy, budgets, evaluator and price assumptions. Compare one variable at a
time: baseline vs prompt/cache changes, then effort settings. Separate cold and warm cache
runs; use multiple paired trials/seeds where supported. Report success rate and uncertainty,
tokens/cost per successful task including failures, latency distribution, retries, repeated
observations and false completion/nontermination. Keep infrastructure failures identifiable.

A nonsignificant quality difference is not proof of equivalence. Predeclare the acceptable
quality margin and compare its confidence bound before lowering effort or promoting a cheaper
configuration. Deterministic regressions prove the corrected contracts, not model quality lift
or a general percentage saving. Runtime defaults remain unchanged until such evidence exists.
