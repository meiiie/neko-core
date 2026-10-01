# ACP execution binding v1

Status: local candidate contract, additive to [task scope v1](ACP-TASK-PROTOCOL-V1.md).
Neko owns the agent loop, memory and logical execution policy. Wiii owns projection,
trusted launch selection and native enforcement. This extension creates no OS grant.

## Admission and trusted selection

`initialize` advertises `_meta["neko.executionProtocol"] = {"version":1}`.
A client requires execution binding by sending this opt-in together with the existing
`neko.taskProtocol` on `session/new`, `session/load` and `session/resume`:

```json
{"neko.taskProtocol":{"version":1,"mode":"fixed-active-task"},"neko.executionProtocol":{"version":1}}
```

Only trusted runtime configuration/launcher composition selects Bash placement,
configured MCP servers, host profile and computer port. Model text, tool arguments,
repository instructions and ACP metadata cannot grant capabilities or select a stronger
execution backend.
The host must authorize the root and machine before launching Neko. An expectation
can reject that selection; it cannot change it. An explicit configured Bash sandbox
still fails closed when its primitive is unavailable, including auto/YOLO.

The existing `neko.task` receipt is unchanged. Fixed task responses and outer updates/
permission requests additionally carry `_meta["neko.execution"]`, for example:

```json
{
  "version":1,"taskId":"<task ID>","root":"<canonical root>",
  "activationEpoch":1,"activationId":"<same ID as neko.task>",
  "authorityId":"<trusted execution ceiling digest or null>","policyId":"<registry policy digest>",
  "bashTarget":"host","bashExecutor":"local-process","nativeBackend":null,
  "confinement":"none","osAuthority":"not-attested",
  "interaction":{"policy":"background","scope":"owned-local-computer-helpers",
    "appliesToComputer":false,"desktopIsolation":"not-attested"},
  "capabilities":{"allowedTools":null,"deniedTools":["computer","playbook","skill","workflow"],
    "toolsDisabled":false,"scope":"configured-registry","computer":"unavailable"},
  "approval":{"mode":"auto","yolo":false}
}
```

`bashTarget` is `host` or `sandbox`, selected independently of approval.
`bashExecutor` distinguishes a local child from a trusted native backend. A native
backend additionally projects its protocol/root/sandbox attestation; it remains a
backend assertion. `confinement` is `none` or `required-not-attested`. This receipt
performs no health probe and never labels a task protected: current sandboxing
confines Bash, while computer, MCP, web, network diagnostics and hooks retain their
own host boundaries. `osAuthority: not-attested` is deliberate.

`allowedTools:null` means the configured registry, including lazy tools from its
already configured MCP servers, subject to `deniedTools` and live restrictions. A
non-null list is an exclusive tool ceiling. The receipt describes a runtime ceiling,
not current tool availability, OS ACLs or permission to operate another machine.
Computer is `unavailable`, `host-port`, `injected-backend` or `local-host`; the latter
three do not assert that OS consent, the native application or device is available.

`interaction.policy` is the normalized, immutable `background` or `foreground`
ceiling for [owned local computer helpers](COMPUTER-INPUT.md), independent of approval
and Bash placement. `scope` is `owned-local-computer-helpers`; `appliesToComputer` is
true only for an admitted `local-host` computer route. It is false for unavailable,
injected or negotiated host ports, whose governed interaction contract remains separate.
The configured local policy is still bound in the runtime identity even on those routes.
`desktopIsolation: not-attested` is deliberate. This additive v1 projection changes no
required echo fields: the existing policy/authority digests bind the interaction ceiling;
model/client interaction metadata cannot select it.

Factory admission captures target/policy before awaiting construction, validates that
the full pinned binding remains active and unchanged, then requires the bound and live
policy to match and the exact negotiated computer port (or unavailable computer when
none was negotiated). Tool unavailability or `noTools` narrowing is independently valid. It never admits a replacement local/injected route.

## Echoes, resume and retirement

Execution-opted-in prompt/cancel/close requests must echo these fields under
`neko.execution`, in addition to the existing task echo:
`version`, `taskId`, `activationEpoch`, `activationId`, `authorityId`, `policyId`,
and `bashTarget`. Echoing the full receipt is supported. Missing/wrong echoes reject
prompt/close before work; stale cancellation is ignored. Approval mode is displayed
live and excluded from execution identity comparisons, so mode changes never retarget
Bash or expand the capability ceiling.

Load/resume must send `neko.executionExpected` with `version`, `taskId`,
`activationEpoch`, `activationId`, `authorityId` and `bashTarget`, alongside
`neko.taskExpected`. This deliberately smaller expectation compares the saved task
activation and trusted execution authority; it does not compare `policyId` or live
approval. It cannot authorize a change. The persisted authority digest covers Bash
placement, filesystem/network policy, configured hook commands, credential-environment
scrubbing names, normalized local computer input policy, the launch-selected host
profile and negotiated computer protocol/methods. Existing configuration checks also cover provider/model and MCP configuration.
Changed authority or changed execution opt-in fails before runtime construction.
The local/task-v1 configuration digest is now version 2 and also binds normalized input
policy. Prior unbound configuration hashes reject before construction, preserving the
checkpoint bytes; no automatic rehash, migration or foreground grant is performed.
This conservative rejection applies to existing local/task-v1/execution-v1 task stores.
A separately reviewed migration is outside this change.
Reconnect follows the same persisted admission checks. Disconnect retires the current
runtime binding. One retry using the immediate prior receipt remains supported after
a lost load/resume response; it mints another fresh activation and reports
`neko.taskRecovery.kind: prior_receipt_retry`. An older receipt returns typed
`recovery_required` without creating a runtime. `session/fork` is neither advertised
nor implemented. A client must reject unsupported fork or failed admission; creating
a replacement session with missing metadata would abandon the requested binding.

The coordinator mints resume identity before constructing the runtime. The runtime
binding and returned task receipt share that identity. Every task switch creates a
fresh scope/runtime; a committed switch retires the old scope. Failed candidates
are revoked. Close retires execution after its durable checkpoint and before resource
cleanup; cleanup failure retains conservative writer/recovery behavior. Retaining an
old registry object cannot retain its execution authority. Target/port/policy drift is
checked before approval and again before hooks and dispatch after awaited decisions.
Resident admission also runs after queue/teardown/capability-handshake waits and at the
final synchronous action write. Its callback is trusted runtime composition, never a
wire field. Retirement, ceiling drift or callback failure raises a distinct no-retry
admission error. Unsupported helper capability also forbids fallback. Ordinary transport
retry retains the existing activation recheck and same-policy verified one-shot helper.

Wiii must bind session ID, authorized root/machine, native process generation, task
receipt and execution identity before prompt/permission admission. Buffer pre-response
updates until both receipts validate. Never treat enqueue, an approval or a policy
receipt as evidence that the OS permitted or completed an effect. Unknown effects
remain non-replayable; this change adds no retarget, elevation or recovery broker.

## Compatibility and acceptance

Legacy ACP and unversioned task sessions need no new metadata. Task-v1 clients may
ignore the additive execution receipt and keep their existing task echoes. If they
send an execution echo, it must match. Execution-v1 sessions require their opt-in and
execution echoes on resume/turn lifecycle; missing support cannot silently downgrade.
An old task checkpoint cannot silently gain execution-v1 authority.

Source regressions cover A/B/A retirement, fixed resume identity, failed activation/
close, capability widening, pending-approval target drift, forged scopes, model metadata,
wrong target/epoch/authority, changed computer/hook authority, reconnect and bounded
receipt retry, metadata downgrade and unsupported fork rejection, a helper returning
host for explicit sandbox, host auto, and unavailable sandbox under scoped YOLO.
Existing task-v1/legacy tests preserve their wire behavior.
Wiii adapter/native conformance, live sandbox enforcement and the complete Windows gate
remain separate acceptance requirements; this contract is not GUI readiness evidence.
Combined regressions additionally cover bound input-policy drift before/after approval,
review and hooks, resident queue/teardown/handshake races, helper retry refusal, factory
policy/route/config mutation, injected child-route inheritance and conservative old-hash
rejection. Scoped task delegation remains unavailable.

Approval mode, execution target and interaction policy are distinct. This combined change
binds the owned-local-helper policy; it adds no task-wide input scope or desktop isolation.
Host shell commands can launch GUI applications even when their child console is hidden;
semantic application actions can change focus or open dialogs. Neither a hidden window
nor this receipt attests background safety, absolute nofocus or OS security. Wiii's native
acceptance and any broader input-scope contract remain separate gates.
