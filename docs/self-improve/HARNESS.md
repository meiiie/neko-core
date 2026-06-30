# Harness — how Neko works + the levers to improve it

The **harness** is everything around the model that turns it into a capable agent. Neko's thesis (see
`docs/process/`): the harness is the biggest quality lever after model choice. This file maps the harness so a
self-improving pass knows WHERE the levers are.

## The pieces (where to look)
- **Agent loop** — `src/core/agent.ts`: `complete -> tool_calls -> observe`, `maxSteps`, the loop guard
  (3x-same-call nudge), `safeExecute` (a throwing tool becomes a recoverable observation), `runUntilDone`
  (closed loop: work + self-review until DONE), `compact()` + `shrinkOldObservations()` (context relief).
- **Tools** — `src/core/tools.ts` + `tool-runtime.ts`: the contracts (safe vs gated), `describeToolCall`,
  path-escape guard, the executable registry. Tool *descriptions* are prompt tokens AND steer behavior.
- **Providers** — `src/adapters/providers.ts` (openai_compat) + `anthropic.ts`: retry/offline/abort, streaming,
  effort mapping, structured-output self-heal.
- **Context** — `src/adapters/context.ts` + skills + memory: what's injected each turn.
- **System prompt** — `src/core/agent.ts` `DEFAULT_SYSTEM_PROMPT`: fixed token cost every call; high leverage.

## The levers (what to tune), each measurable by the bench dev-log
1. **Token efficiency** — system prompt size, tool-schema verbosity, observation clipping, compaction policy.
   *Measure:* bench `in`/`out` tokens. (See ACON/Focus in RESEARCH.md — failure-aware + relevance-based.)
2. **Speed** — fewer/cheaper steps, less over-reasoning, right effort per task. *Measure:* tok/s, steps, seconds.
3. **Accuracy / reliability** — better tool contracts, the loop guard, act→verify, self-review. *Measure:*
   pass-rate (add harder tasks since the current set is saturated).
4. **Robustness** — graceful tool errors (`safeExecute`), bad-input guards, atomic writes, timeouts.
   *Measure:* targeted tests + no new flakes.
5. **Security** — the safe/gated boundary (`neko policy`), path-escape/symlink guard, bash seatbelt, no key
   leakage. *Measure:* `neko policy` PASS + the security tests.

## Rules for a harness change (so it's safe to automate)
- One lever at a time; small, self-contained.
- Must pass the **verify gate** (typecheck + 0-fail tests + policy) — non-negotiable.
- Prefer changes the **bench can measure** (token/speed/pass) so improvement is provable, not vibes.
- Never weaken a guard (policy/path-escape/seatbelt) to "pass" something — that's a regression, not a win.
