# Local computer input policy

Neko's built-in Windows computer executor defaults to `background`. Supported UIA
`list`, `read`, `get`, `watch`, `setvalue`, `toggle` and `invoke` remain available.
If a control has no supported semantic pattern, the tool returns `needs_interaction`
instead of clicking with the system cursor. Invoke also supports ExpandCollapse.

`activate`, `type`, `key`, `click`, `stroke`, `scroll`, `ocr` and `open` require
`foreground`. Background refuses them before approval, executable hooks, helper
startup or any input. Auto and yolo retain their approval meaning; they cannot
enable foreground input. `display`, `wait` and screenshot do not inject input.

The user can explicitly select foreground in global config:

```json
{ "computer_use_input_policy": "foreground" }
```

Alternatively set `NEKO_COMPUTER_USE_INPUT_POLICY=foreground` for Neko's launch.
Use `background` to restore the default. Invalid values fail closed. This setting
is read at runtime construction; restart the session after changing it. Project
configuration, including project profiles, cannot grant this policy. The model's
tool arguments cannot override it. Child registries inherit the trusted value.
Resident requests and one-shot helper environments carry that value explicitly.
Before background dispatch the resident transport verifies the helper's input-policy
capability with a harmless ping, cached for that exact child process. Reconnection
checks a new child again. A missing capability returns `unsupported_helper` without
falling back. One-shot semantic/input helpers must carry the trusted policy-version
marker before they can be launched; transport retries preserve the original policy.
Read-only display and screenshot helpers do not require an input-policy marker.

This policy restricts Neko's owned local computer helpers, not arbitrary host
Bash, third-party MCP, executable hooks, or an injected host computer backend.
Helpers receive `NEKO_COMPUTER_INPUT_POLICY`; directly invoked owned input helpers
also default to background. Host Bash is still host-command authority and can run
other programs. No sandbox or second agent harness is introduced.

Background semantic UIA is not independent desktop ownership. Application
providers can open dialogs or change focus as a consequence of a semantic action.
Screenshot reads the shared visible desktop; it is not hidden-app capture.
Clipboard and signed-in browser tabs remain shared resources. Touch has a separate
pointer channel but still acts on the visible desktop and can change focus.
Foreground input retains target/focus verification to avoid typing into another
app. Neko's ACP host port keeps its own governed contract; Wiii's existing isolated
Computer backend is unchanged.

Verification uses deterministic fake UIA controls, captured helper requests and
safe print-only subprocess fixtures. Live Windows native acceptance requires its
separate desktop owner. These checks do not reproduce the reported user incident.


## Task-bound projection

The combined [ACP execution binding v1](ACP-EXECUTION-BINDING-V1.md) snapshots normalized
input policy before activation and includes it in policy and persisted authority digests.
Receipts project its owned-local-helper scope and explicitly leave desktop isolation and
OS authority unattested. Resume rejects changed policy or older unbound configuration
hashes before factory construction. Resident action admission rechecks task activation
and policy after queue/handshake waits; admission/capability refusal cannot authorize a
one-shot retry. The approved same-policy transport fallback remains available.
