# ACP task scope v1 for Neko clients

Status: **candidate integration contract**, local branch only. ACP negotiates `protocolVersion: 1` with `@agentclientprotocol/sdk` 1.3.0. This `neko.taskProtocol` extension has its own version. The fixed task lane is opt-in; existing ACP clients keep their current wire behavior. A client that requires isolation must stop before its first prompt if any required field is missing or unsupported.

## Capability and admission

`initialize` response advertises:

```json
{"_meta":{"neko.taskProtocol":{"version":1,"mode":"fixed-active-task"}}}
```

An explicit host work item starts `session/new` with its host-authorized absolute `cwd`, normal ACP fields, and:

```json
{"_meta":{"neko.taskProtocol":{"version":1,"mode":"fixed-active-task"},"neko.taskLabel":"<display label>"}}
```

Neko canonicalizes the physical root and mints the coordinator/session ID and task ID. The response has normal `sessionId` and this full receipt:

```json
{"_meta":{"neko.task":{"version":1,"mode":"fixed-active-task","id":"<task ID>","label":"<display label>","root":"<canonical physical root>","activationEpoch":1,"activationId":"<opaque ID>"}}}
```

`id`, `activationId`, and the ACP `sessionId` are distinct. Receipt and label are correlation data, **not host permission grants**. Wiii must bind its trusted work item/environment, authorized effective root, native process generation, ACP session ID, and returned receipt before admitting any prompt or permission. It must compare `root` to its own canonical authorized root; Neko does not authorize Wiii's environment or filesystem access.

## Resume, turns, and events

`session/load` and `session/resume` send the same `neko.taskProtocol` plus:

```json
{"_meta":{"neko.taskExpected":{"id":"<saved task ID>","root":"<saved root>","activationEpoch":1,"activationId":"<saved activation ID>"}}}
```

Neko requires the saved root, task, authority, configuration, protocol opt-in, and writer lease to match before constructing a runtime. Every successful load returns a **fresh** full receipt with incremented epoch and a new activation ID; checkpoints do not rotate either field. An exact immediately preceding receipt can select one bounded retry after a lost load response, but the retry also mints a fresh activation. Older/future/wrong receipts fail. Two consecutive lost responses have no automatic recovery in v1.

Every v1 `session/prompt`, `session/cancel`, and `session/close` carries an echo:

```json
{"_meta":{"neko.task":{"version":1,"id":"<task ID>","activationEpoch":1,"activationId":"<current activation ID>"}}}
```

Neko rejects missing/stale prompt or close echoes before work; stale cancel is ignored. Successful prompt and close results, outer `session/update` params, and outer `session/request_permission` params carry the **full current receipt** under `_meta["neko.task"]`. Wiii must verify both outer `sessionId` and receipt/process generation. Updates emitted before the new/load response are buffered without projection until Wiii validates that response; mismatches are discarded. A v1 close is confirmed only by a successful receipt-bearing close response. A timeout or lost response is uncertain, not an ACK.

The fixed lane has one active task. `/task new` and `/task use` are rejected; `/task status` and `/task list` are read-only. A Wiii work-item change closes/quiesces the old ACP coordinator, then creates or loads the target session with a newly checked receipt. Existing CLI/TUI task switching and unversioned ACP task sessions retain their prior behavior.

The machine-readable v1 load failures use JSON-RPC error code `-32002` with `data["neko.taskError"] = {"version":1,"kind":"writer_unavailable"|"recovery_required","action":"retain_mapping_and_request_recovery"}`. A writer lock is never auto-deleted. Wiii keeps its mapping and blocks a replacement session or legacy fallback. Other malformed/mismatched requests fail with ACP errors and likewise never authorize a first prompt.

The additive [execution binding v1](ACP-EXECUTION-BINDING-V1.md) is separately opt-in. Its runtime-policy receipt is correlation and a capability ceiling, not an OS grant or sandbox health assertion.

## Compatibility and open points

- **Subset for Wiii implementation after review:** capability discovery; explicit new/load metadata; exact receipt and authorized-root validation; receipt echo on prompt/cancel/close; outer session-ID/receipt checks on updates and permissions; fixed-task command denial; and fail-closed typed recovery errors. Do not present the lane as active until those seams pass adapter and native tests. Unsupported versions/modes and missing receipts stop admission before the first prompt.
- A versioned task load never selects a colliding legacy session. A versioned task session cannot be resumed through an unversioned request. Existing legacy bytes and memory are preserved; importing them requires a separate explicit operation.
- Wiii currently does **not** send this opt-in or validate the receipt. Until its adapter and native root binding pass conformance tests, GUI task isolation is not active. Wiii owns host grants, UI routing, permission handling, and process lifecycle; Neko owns task/session/memory/compaction semantics.
- Recovery after a forced kill with a stale writer lock, two lost load responses, or a lost `session/new` response is **unsettled**. V1 fails closed and retains checkpoint bytes; it does not promise automatic recovery or orphan cleanup.
- Optional `_meta["neko.taskRecovery"]={"version":1,"kind":"prior_receipt_retry"}` on a bounded retry is diagnostic only; it never replaces receipt validation. Its display policy in Wiii is **unsettled**.
- Wiii's work-item/effective-root membership validation, pre-response update buffer bound, global Knowledge admission, and persisted receipt mapping are **unsettled on the Wiii side**. They must be tested before presenting scoped status in the GUI.
- Cancellation follows [ACP schema-v1.24.1 at `1761180eeddf0828d4ecc367106a632c61be06d9`](https://github.com/agentclientprotocol/agent-client-protocol/blob/1761180eeddf0828d4ecc367106a632c61be06d9/docs/protocol/v1/prompt-turn.mdx#L302-L332): client provisional cancelled tool markers may be followed by agent updates before the prompt's `stopReason: "cancelled"`. Turn termination does not prove a provider/tool effect was rolled back; unknown mutation outcomes are not replayed automatically.

Acceptance requires SDK transport tests for capability, new/load/receipt, event and permission correlation, wrong/missing echoes, collision and legacy compatibility, cancellation ordering, and close/recovery errors; plus Wiii adapter/native tests for authorized root, pre-admission buffering, session ID checks, timeout/kill recovery, and other provider preservation. No source test alone establishes GUI integration.
