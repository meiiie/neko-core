# Crash-safe resume, reasoning privacy, and viewport hydration

Research checkpoint: 2026-07-30

Scope: Neko Core `/resume` after a process/network interruption. This ledger separates durable model context from the terminal projection and records the evidence behind the implementation. The local `claude-code` checkout was inspected read-only as a clean-room behavioral reference; no source was copied.

## Checkpoint 2026-07-30

Current best model:

1. Persist the canonical user/assistant/tool trajectory before awaiting more provider work.
2. Preserve opaque reasoning continuation items exactly when a provider needs them, but never infer that provider context belongs in the user transcript.
3. Resume the model from the canonical trajectory while rendering a bounded screen projection.
4. Hydrate rich terminal rows only near the viewport. Any single synchronous render also needs a byte/character circuit breaker because an async scheduler cannot pre-empt one oversized render.
5. Keep the complete source trajectory available through an explicit transcript/history surface.

## Findings

- [verified] Reasoning and user-visible assistant text are separate protocol items, not two names for the same display stream.
  confidence: high · 2026-07-30
  sources:
  - OpenAI Codex app-server `ThreadItem`: distinct `agentMessage` and `reasoning` variants (https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md, checked 2026-07-30)
  - Anthropic Thinking docs: thinking blocks precede and remain separate from canonical text blocks (https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models, checked 2026-07-30)
  consequence: Neko's replay renderer must use public message content only. `reasoning`, `reasoning_content`, encrypted signatures, and provider continuation data are context, not transcript text.

- [verified] Hidden reasoning may need durable round-trip even when it is omitted from the UI.
  confidence: high · 2026-07-30
  sources:
  - OpenAI model guidance: manually managed history must preserve response output items and encrypted reasoning items when applicable (https://developers.openai.com/api/docs/guides/latest-model, checked 2026-07-30)
  - Anthropic extended thinking: `display: "omitted"` keeps an opaque signature for continuity and requires unmodified preservation around tool use (https://platform.claude.com/docs/en/build-with-claude/extended-thinking, checked 2026-07-30)
  tradeoff: storage fidelity and display privacy are separate invariants. Deleting reasoning to fix the UI would damage provider continuity.

- [verified] A tool-heavy agent turn contains many intermediate events but terminates in a final assistant message.
  confidence: high · 2026-07-30
  sources:
  - OpenAI, “Unrolling the Codex agent loop,” 2026-01-23 (https://openai.com/index/unrolling-the-codex-agent-loop/)
  - Anthropic Thinking docs describe thinking/tool-use iterations as one assistant turn ending in canonical text (https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models, checked 2026-07-30)
  consequence: persisted assistant commentary attached to a tool call is useful machine trajectory, but replaying every progress paragraph as ordinary final prose creates the appearance of leaked chain-of-thought.

- [verified] Durable resume requires a persistent checkpoint/cursor and completed-step writes, not only a final save.
  confidence: high · 2026-07-30
  sources:
  - LangGraph interrupts: persistent checkpointer plus `thread_id` restores exact state after interruption (https://langchain-ai.github.io/langgraph/concepts/breakpoints/, checked 2026-07-30)
  - LangGraph checkpoint reference: pending writes from completed nodes survive a sibling failure and are reused on resume (https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-checkpoint.html, checked 2026-07-30)
  consequence: Neko's incremental, atomic session journal remains the source of truth; the UI fix must not compact or rewrite it merely to make resume look shorter.

- [verified] Context-bearing handoffs reduce rediscovery, but raw trace is an expensive default human handoff surface.
  confidence: medium-high · 2026-07-30
  source: KC and Budathoki, “Handoff Debt,” arXiv:2606.02875, 2026-06-01 (https://arxiv.org/abs/2606.02875)
  evidence: 75 source tasks, 181 handoff points, 724 takeover runs per successor model; context-bearing handoffs reduced median agent events by 20–59% and cumulative prompt tokens by 42–63% versus repository-only takeover.
  limitation: this paper evaluates successor-agent efficiency, not terminal rendering. It supports retaining trajectory, not dumping it verbatim into a viewport.

- [verified] Neko's observed resume lag was eager rich rendering, not JSON parsing or token estimation.
  confidence: high · 2026-07-30
  local evidence:
  - real session `20260730-102152-775`, initially 1.63 MB: load/replay micro-steps were about 15 ms total
  - eager rich-ANSI warm: 51,554 ms for 144 lines / 1,530 rows
  - after viewport projection and hydration: the same evolving session at 2.04 MB built its resume projection in 6.2 ms; fullscreen mounted in 230 ms; 48-line hydration completed in 1,033 ms across yielding chunks
  consequence: parsing optimizations alone would not address the freeze. Work must be bounded both by viewport scope and by maximum indivisible render size.

- [verified] `/resume` performed two immediate metadata scans before opening the picker.
  confidence: high · 2026-07-30
  local evidence: `runSlashCommand` checked `listSessionMetas()` and `openResumePicker` called it again. Synthetic 1,501-session runs showed the redundant warm scan materially contributing to picker latency.
  consequence: make the picker the single owner of the metadata snapshot and reuse it while switching scope.

## Refuted hypotheses

- [refuted] “Raw provider thinking is being replayed from `provider_data`.”
  reason: all 5,328 messages in the inspected store had no public `reasoning` key; 78 opaque reasoning continuation records lived under provider data. `buildReplayLines` never reads those fields. The screenshot-like flood came from large persisted public assistant progress content.

- [refuted] “The 1–2 MB session JSON is intrinsically too large to resume quickly.”
  reason: real parsing and projection took single-digit milliseconds. The 51.55 s cost appeared only when lines entered the hidden Ink rich renderer.

- [refuted] “A 12 ms async chunk budget guarantees responsiveness.”
  reason: the scheduler checks its budget only after a complete line render. A single 45k-character line can block for tens of seconds, so an explicit per-item circuit breaker is required.

## Implemented decision

- Canonical messages remain unchanged for provider continuation and crash recovery.
- Resume mode omits assistant progress text attached to tool calls, bounds oversized user/final-assistant prose by wrapped rows, and discloses `/transcript` as the history surface.
- Full transcript construction keeps source content and still ignores reasoning/provider fields.
- ANSI warming covers 48 tail lines and 24 lines around a scrolled center instead of 300/160.
- Lines above 8,000 display characters use a bounded plain tail rather than entering the indivisible rich renderer.
- One metadata snapshot opens `/resume` and is reused for Ctrl+A scope changes.

## Open questions

- [open] Replace synchronous cold index construction with a worker/progressive picker if stores with thousands of previously unindexed sessions become a common production case.
  confidence: medium · evidence needed: real cold-start telemetry, not the synthetic antivirus-sensitive benchmark.

- [open] Add a first-class “show intermediate progress” toggle inside `/transcript` instead of relying only on the full history viewer.
  confidence: low-medium · evidence needed: user demand and a privacy/UX review across providers.
