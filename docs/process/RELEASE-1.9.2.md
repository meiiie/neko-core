# 1.9.2 release candidate record

This technical record accompanies the Dream background patch. Existing WORKLOG
history is unchanged; no private session data or provider response is included.

- Base: main `5e3a59e6f96ace2f2d43bea744dd2addda87a06c`, merged PR #99.
- TUI and ACP release foreground turn ownership before automatic Dream finishes.
  Jobs use immutable snapshots, cancellation, a latest-pending queue, memory
  revision checks and a cross-process lease. The next turn can read the last
  committed memory without waiting for the new candidate.
- Safe diagnostic receipts and `neko dream status` describe an attempt, not
  process liveness. No raw evidence, exception text or provider response is logged.
- One-shot CLI still drains after the answer. No detached daemon is promised.
  Non-cooperative provider cancellation can hold a Dream slot until settlement
  or restart. Simultaneous legacy hosts do not promise the freshest transcript.
- Previous generic failures cannot be attributed retrospectively without evidence.
- The release version and baked site fallback are prepared together. A source
  fallback change is not proof of a deployed Cloudflare build.
- Final candidate gates, Windows ConPTY evidence, publication status and asset
  verification must be reported from actual runs; this record does not claim
  that a bumped version or prepared tag has been published.
