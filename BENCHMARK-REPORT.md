# Neko-core Agent Benchmark — SOTA-grounded standard + live evidence

> **Historical calibration artifact (2026-08-06).** These numbers describe the then-current easy-suite
> harness only. The v0.23.0 evaluator subsequently hardened its oracle, production-completion intersection,
> infrastructure classification, fingerprints and trajectory accounting; do not compare or publish this file
> as a current leaderboard result. Current methodology and caveats live in
> `docs/research/harness-sota-2026-08-09.md` and `docs/research/frontier-v2-design-2026-08-10.md`.

**Date:** 2026-08-06 · **Model under test:** `glm-5.2` (effort=max) · **Suite:** easy (16 tasks)
**Config budget cap:** `--max-steps 25` (interactive-tier, ~SWE-bench scale)

---

## 1. Why this benchmark exists

The original `bench.ts` only reported pass/fail per task. That is not how modern agent benchmarks
(2025–2026 SOTA) score agents: **tau-bench** introduced `pass^k` (reliability across k trials, strict),
**WebArena / AgentBench** add cost/efficiency dimensions, and tool-calling eval literature
(RedundancyBench) measures *redundant* tool calls — agents that "succeed" by re-reading the same file
5 times are not good agents even at 100% pass@1.

This work adds a **CLEAR** multi-dimensional scorecard + `pass^k` + a **RedundancyBench**-style
detector, all locally runnable with **zero API cost** for the metric layer (offline-testable).

## 2. The CLEAR dimensions (what we measure, and why)

| Dim | Metric | Definition | SOTA grounding |
|---|---|---|---|
| **C**orrectness / Efficacy | `pass@1` | fraction of trials passing the task `check()` | HumanEval/SWE-bench |
| **L**atency | p50, p95, SLA% | wall-clock per trial | agent serving SLAs |
| **E**fficiency (cost) | `CPS` = tokens/success, `CNA` | cost-normalized success | AgentBench cost-aware |
| **E**fficiency (exec) | `redundant%`, `stepEff` | redundant tool-call rate; optimal/actual steps | RedundancyBench |
| **A**ssurance | `constr%` | honored "do NOT modify X" constraints | novel — fills a gap, no standard existed |
| **R**eliability | `pass^k` | strict: all k trials pass | tau-bench |

`pass^k` is computed **strict** (all k must pass). The `pass@1 → pass^k` *drop* is the headline
reliability signal (0% drop = perfectly consistent).

**Assurance (constr)** is a standard we created where none existed: many tasks carry a `constraints`
block ("do NOT touch `keep` files"). The agent must not only solve but *respect boundaries*. This has
no equivalent in tau-bench/WebArena and is reported here as a gap-filling contribution.

## 3. Implementation (verified)

| Artifact | Role | Status |
|---|---|---|
| `src/adapters/bench-metrics.ts` | Pure/deterministic metric layer (CLEAR, pass^k, redundancy, scorecard) | ✅ 17 offline tests |
| `src/adapters/bench.ts` | `BenchTask` (+`constraints?`,`optimalSteps?`), `runEval()` w/ provider override + maxSteps + onEvent trace | ✅ |
| `bin/neko.ts` | `eval` subcommand, `--trials`/`--max-steps` flags, `Args.maxSteps` | ✅ |
| `test/bench-metrics.test.ts` | Offline metric math (no API) | ✅ 17 pass |
| `test/bench-eval-e2e.test.ts` | End-to-end pipeline (scripted provider → trace → scorecard) | ✅ 2 pass |

**Design properties:**
- Metric layer is **pure & offline-testable** → verifiable with zero API spend, matches repo test conventions.
- `onEvent` hook collects the tool-call trace **passively** — no changes to the cognitive/agent loop.
- `provider` + `maxSteps` overrides in `runEval` → CI can use scripted providers; benchmark budget
  is decoupled from interactive session limits (`max_steps=160` for chat, capped for bench).

**Typecheck:** `TSC:0`. **Test totals:** 19 pass / 0 fail (metric + e2e), 49 expect() calls.

## 4. Live measurement (glm-5.2, max-steps 25, 3 trials/task)

Full run, 48 trials, **0 errors**, complete CLEAR scorecard:

```
Efficacy    pass@1   = 100%
Reliability pass^k   = 100%    drop pass@1→pass^k = 0%   (perfectly consistent)
Cost-eff    CPS      = 22673 tok/success   CNA = 0.047  (lower CPS / higher CNA = better)
Exec-eff    redundant= 1%   stepEff = 63%
Assurance   constr   = 100%
Latency     p50=13.9s  p95=27.9s  SLA(≤30s)=94%
```

Per-task (all OK, R^k=1, constr=100%):

| Task | CPS | redundant | stepEff | p95 |
|---|---|---|---|---|
| careful-read | 11480 | 0% | – | 6.8s |
| csv-top | 17233 | 0% | – | 8.5s |
| run-to-know | 17133 | 0% | – | 12.9s |
| pipeline | 17343 | 0% | – | 13.7s |
| strict-format | 19594 | 0% | – | 15.4s |
| fizzbuzz | 17793 | 0% | – | 15.6s |
| balanced-parens | 27881 | 8% | – | 19.2s |
| unique-sorted | 23769 | 0% | 50% | 19.5s |
| roman | 26219 | 0% | – | 20.0s |
| stateful-bug | 23957 | 0% | 75% | 21.4s |
| off-by-one | 28388 | 0% | – | 21.8s |
| two-file-bug | 25238 | 0% | – | 14.7s |
| json-edit | 23534 | 0% | – | 31.7s |
| closure-trap | 24029 | 0% | – | 14.4s |
| flatten | 29750 | 0% | – | 12.7s |
| bugfix | 29435 | 0% | – | 26.7s |

### Reading the numbers
- **Reliability is the headline:** on the easy suite glm-5.2 is *perfectly consistent* (pass@1 = pass^k
  = 100%, 0% drop). No single-trial flukes.
- **Cost spread is real** even within one suite: `careful-read` (11480 tok/success) is ~2.6× cheaper
  than `flatten` (29750). CPS gives a ranking pass@1 alone hides.
- **Redundancy is low (1% aggregate)** — only `balanced-parens` shows a redundant re-read (8%). This is
  the kind of signal the old pass/fail bench could not surface.
- **stepEff** is populated only where the task declares `optimalSteps` (stateful-bug 75%, unique-sorted
  50%); other tasks show `–`. To make stepEff a headline axis, more tasks need declared optimal steps.
- **Latency:** p95=27.9s, SLA(≤30s)=94%. `json-edit` (p95=31.7s) is the lone SLA breach.

### Honest caveats
1. **Easy suite only.** 100%/100% means the suite *saturates* — it discriminates poorly at the top.
   A `hard` suite run (6 tasks exist) is the next measurement to take; it will separate tasks and
   likely produce non-trivial pass@1→pass^k drops.
2. **k=3.** tau-bench uses k≥5; at k=3 pass^k is a coarse reliability estimate.
3. **max-steps 25** bounds the run but also truncates any task needing >25 steps — a confound for the
   hard suite, not for easy (all easy tasks solved well under budget).
4. **stepEff sparse** (only 2/16 tasks declare optimal steps) — under-specified, not a metric failure.

## 5. How to reproduce

```bash
# Offline metric self-test (zero API cost):
bun test test/bench-metrics.test.ts test/bench-eval-e2e.test.ts

# Live eval (needs a configured provider; ~10 min, bounded):
node bin/neko-source.cjs bench eval --trials 3 --max-steps 25
```

## 6. Gap-filling contributions (created where no standard existed)

- **Assurance / `constr`** — boundary-respect measurement (do-not-modify constraints). No equivalent in
  tau-bench / WebArena / AgentBench.
- **`stepEff`** — optimal/actual step ratio for tasks that declare an optimal path.
- **`pass@1 → pass^k` drop** as an explicit headline, framed as the reliability cliff.

These are proposed standards, evidence-light so far (one model, easy suite). They need a multi-model
sweep before being claimed as generalizable.

---
*Research ledger:* `~/.neko-core/research/neko-agent-benchmark-sota-2026.md` (SOTA survey: tau-bench
pass^k, WebArena, AgentBench, RedundancyBench).
