# Embedded domain runtime (experimental)

`src/adapters/domain-runtime.ts` composes the existing `Agent`, `ToolRegistry` and provider/MCP ports for one isolated transactional task. It follows [EXTENDING](EXTENDING.md); LifeMate-specific schemas, prompts, receipt interpretation and evaluation stay in the embedding application. The installed CLI and shared coding composition are unchanged.

The host supplies an exact capability/effect map (`read`, `write`, `ask`) and classifies authoritative tool observations. The registry still enforces permissions. This adapter exposes no file, shell, computer, memory or delegation tools. A runtime is single-use and owns its provider/transport lifetime.

Coding verification gates are disabled **only in this composition**. The host-owned receipt ledger records mutations accurately without requiring unrelated reads after every transaction. Core coding heuristics and cost telemetry are unchanged; use `runtime.receipts` for domain effects. A successful receipt means execution succeeded, not that the chosen recipient/amount was correct. `semanticSuccess` is always null; a separate task evaluator must decide it.

A successful `ask` receipt stops further execution, including later actions in the same batch. Failed asks remain repairable. Plain-text questions are not counted as executed asks. Legitimate no-op answers finish without compulsory verification reads.

Explicit tool-call JSON/XML in a final text response can trigger **one** native-protocol repair. No text is executed or treated as tool evidence. The repair shares the original request budget and deadline, keeps already-executed calls, and does not infer missing parameters. Persistent malformed output remains `unresolved_tool_text`.

`nativeDomainHistory` accepts only host-supplied paired calls/results, preserves them as native assistant/tool messages, and never executes them. Missing results fail rather than manufacturing evidence. Historical entity IDs remain scoped to their task.

Verification: `bun test test/domain-runtime.test.ts test/architecture.test.ts test/agent.test.ts test/providers.test.ts`, `bun run typecheck`, `bun run lint`. The new adapter is opt-in and does not modify shared loop, transport, authority or persistence implementation. No CLI release/build is claimed.

LifeMate integration and TRAIN executor proof live in the neighboring `zaic2026-lifemate/integrations/neko` and `artifacts/neko-domain-train-20261107`. Oracle replay verifies wiring only; no model-quality gain has been measured. Remaining risks include natural-language questions without native asks, wrong entity selection and invented values. Do not promote based on executor tests alone.
