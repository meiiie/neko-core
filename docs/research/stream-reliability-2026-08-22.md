# Stream Reliability Contract v1 (2026-08-22)

Status: implemented for the user-facing Agent path. This note records the evidence and the boundary so
future provider work extends one design instead of adding provider-specific catch/retry patches.

## Evidence from current systems

- OpenAI Responses exposes typed lifecycle events (`response.created`, deltas, `response.completed`,
  `error`). A typed terminal event is stronger than an optional transport sentinel.
  <https://developers.openai.com/api/docs/guides/streaming-responses>
- Anthropic streams have an explicit `message_start` -> blocks -> `message_stop` lifecycle, allow `ping`
  events, and can carry an error inside an HTTP-200 stream. Anthropic's documented recovery preserves the
  partial response and opens a continuation request; partial tool/thinking blocks are not blindly replayed.
  <https://platform.claude.com/docs/en/build-with-claude/streaming>
- DeepSeek Harness keeps an adapter call as one provider attempt and records retry scheduling before
  cancellable backoff. Its adapter contract separates transport/protocol throws from in-band provider
  failure and requires usage before finish with no events after finish.
  <https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-retry/README.md>
  <https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cookbook/adding-an-llm-adapter.md>
- OpenCode classifies stream/API failures into typed retryable errors and owns retry scheduling at the
  session layer with `Retry-After`, bounded exponential delay, and jitter.
  <https://github.com/anomalyco/opencode/blob/1b937c860b6fd8a83e69f916b1236515aa17ea0d/packages/opencode/src/provider/error.ts>
  <https://github.com/anomalyco/opencode/blob/1b937c860b6fd8a83e69f916b1236515aa17ea0d/packages/opencode/src/session/retry.ts>
- gRPC defines the key safety idea precisely: transparent retry is allowed before the call is committed;
  after commit the application owns recovery. It also requires attempt limits, backoff, jitter, and retry
  observability.
  <https://grpc.io/docs/guides/retry/>
- True stream resumption requires a producer that continues independently plus a stream identity and
  offset/checkpoint. Reissuing an arbitrary POST is retry or continuation, not resumption.
  <https://github.com/vercel/resumable-stream>

## Neko contract

### 1. Protocol lifecycle, not one magic string

Each adapter validates its native terminal record:

| Wire | Success terminal | Optional compatibility envelope |
| --- | --- | --- |
| OpenAI Chat Completions | successful `finish_reason` | `[DONE]` |
| OpenAI Responses | `response.completed` with completed status | `[DONE]` |
| Anthropic Messages | `message_stop` after closed blocks | none required |

EOF after the native success terminal is success. EOF before it is a typed interruption. Malformed data,
invalid roles/indexes, unsupported finish reasons, and safety-limit breaches remain protocol failures and
are never hidden by retry.

### 2. Semantic commit barrier

`ProviderAttemptError.recovery` is the cross-layer decision:

- `replay`: no content, reasoning, or tool-call material crossed the adapter boundary. The adapter may
  replay the identical request within its configured retry budget.
- `continue`: model-authored activity crossed the boundary. The adapter must not replay invisibly. The
  Agent preserves its in-flight assistant journal, checkpoints it, and adds one internal continuation turn.
- `none`: automatic recovery is unsafe.

This is stricter than checking whether HTTP headers arrived and directly matches Neko's observable side
effects. A completed eager read is harmless; a mutating tool is never eager and all provider-managed tools
are journaled before execution.

### 3. Split ownership without overlapping retries

- Adapter owns wire parsing, `Retry-After`, and bounded same-request replay before semantic commit.
- Agent owns bounded post-commit continuation from durable history.
- Host owns cancellation, session persistence, UI/ACP reporting, and long-running task policy.

These domains do not retry the same failure. An adapter that exhausts a pre-commit replay budget surfaces
the failure; the Agent does not convert it into extra requests. User abort always wins.

### 4. Retry discipline and observability

OpenAI-compatible attempts emit payload-free `attempt_started` / `retry_scheduled` metadata. Retry
scheduling is awaited before cancellable backoff. Backoff is bounded exponential with symmetric jitter;
valid `Retry-After` remains authoritative within the configured cap. Events contain no prompt, response,
URL, header, key, or tool arguments.

### 5. Watchdog semantics

The request timeout is an inactivity watchdog, not a total generation deadline. Any received bytes reset
transport idle time; protocol keepalives (`ping`/heartbeat) count as transport health but not semantic
completion. A typed terminal event is still mandatory.

### 6. Recovery is not true resume

Neko calls the general mechanism `continue from checkpoint`. It must not claim byte-exact resume. Native
resume can be added only when a provider supplies a stable response/stream id plus an offset or documented
continuation token. Provider continuation metadata remains opaque, scope-bound, and losslessly persisted.

## Required regression matrix

1. Native terminal at EOF succeeds without `[DONE]` where that sentinel is optional.
2. EOF/read failure before semantic activity is replayable only within the adapter budget.
3. EOF/read failure after text/reasoning/tool activity is never transparently replayed.
4. Post-commit interruption produces one durable Agent continuation and preserves partial output.
5. Exhausted pre-commit replay never expands into Agent continuation.
6. User abort cancels request/backoff/recovery and never retries.
7. Malformed frames, invalid finish status, and size limits fail closed.
8. Attempt telemetry is ordered, bounded, and contains no request/response payload.

## Deliberate non-goals

- Infinite retry (`always`) is not a default; it can burn unbounded money and hide permanent failures.
- Hedging model generations is unsafe without provider idempotency because two successful generations can
  produce different output and tool intent.
- A generic reconnect cannot reconstruct server KV cache, RNG state, or undisclosed provider state.
