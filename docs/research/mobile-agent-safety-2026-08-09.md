# Mobile-agent safety and `phone-harness` clean-room audit - 2026-08-09

Status: **research decision only**. Neko Core does not currently ship an iPhone-control
adapter, and this note does not authorize one. The upstream review was static; no physical
iPhone or Mac permission path was exercised. The evidence cutoff is 2026-08-09.

## Decision

Do **not** vendor, install, wrap, or expose the audited `phone-harness` executable to Neko.
In particular, do not put its stdin-Python runner behind `bash`, a skill, or an MCP tool and
then describe that route as bounded phone control. Arbitrary Python plus raw Quartz input is
host code execution with macOS Accessibility authority, not a typed phone capability.

The clean-room lesson worth retaining is smaller:

1. observe a fresh phone frame;
2. bind a proposed action to that exact observation and mirroring session;
3. preflight identity, freshness, bounds, risk, and consent;
4. execute the typed action at most once;
5. re-observe immediately; and
6. verify both the intended result and important negative side effects.

A future experiment belongs in an optional macOS edge adapter, behind Neko's existing tool
and approval boundary. It must not add PyObjC, Quartz, Apple frameworks, or platform state to
`core/`. Until that adapter and its tests exist, the honest product statement is:

> Neko can use its relay as a phone-sized client. Direct iPhone control is not shipped. A
> future macOS-only experiment may drive a paired iPhone through Apple's iPhone Mirroring.

It is not "direct access to iOS," "any app," "anytime," or background/headless control.

## Scope, method, and evidence labels

The upstream snapshot is
[`ShawnPana/phone-harness@720eaeb`](https://github.com/ShawnPana/phone-harness/tree/720eaeb7b888875bedea742e253d1c61f19ee5a6).
Pinning the commit matters: later upstream changes are outside this audit. No upstream code,
prompt, or skill prose is copied into Neko; links below are evidence only. The upstream MIT
license permits reuse under its terms, but Neko's clean-room rule is deliberately stricter.

Labels used below:

- **Observed:** directly supported by the pinned upstream tree.
- **Source:** stated by a primary platform, benchmark, or proceedings source.
- **Inference:** an engineering conclusion drawn from those facts.
- **Proposal:** a Neko design target that is not implemented.

## What the upstream prototype gets right

The prototype is a compact demonstration of a useful interaction shape. It treats the Mac's
iPhone Mirroring window as the transport, captures that window, recognizes visible text, sends
input, and captures again. Its README is also explicit about important limits: one phone and
one session, unlocking the phone pauses mirroring, no multi-touch/camera/Face ID flows, DRM
video may be black, and OCR does not understand unlabeled icons. Those are useful product-
truth habits.

The useful ideas are therefore:

- a fresh observation before targeting;
- one-use visual marks rather than long-lived guessed coordinates;
- visible progress and a user-controlled connection;
- post-action observation rather than trusting the command return value; and
- an optional platform adapter rather than pretending iOS has Android-like automation APIs.

None of those ideas requires importing the upstream execution surface.

## Why the upstream execution surface is rejected

| Finding at the pinned snapshot | Evidence | Neko consequence |
|---|---|---|
| The CLI reads all stdin and evaluates it with Python `exec` under the current account. | [`run.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/run.py) | This can import filesystem, process, environment, and network modules. It is equivalent to a general local-code tool, not a phone-only action schema. Reject. |
| Raw Quartz is intentionally available when helpers are insufficient. | [`helpers.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/helpers.py) | A model can escape any apparent helper policy and post host input directly. Reject. |
| A mutable `agent_helpers.py` is executed at import time and every public name can replace a built-in helper. | [`helpers.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/helpers.py) | A task can create persistent behavior or shadow a readiness guard. Project text/code must not rewrite the trusted executor. |
| Window discovery selects the first layer-zero window with an English owner name, while input posts global HID events at caller-supplied screen coordinates. | [`mirror.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/mirror.py) | Title spoofing, localization, focus races, moved windows, stale coordinates, or out-of-bounds input can affect the Mac instead of the phone. |
| Readiness is inferred from the absence of four English OCR substrings. Direct input helpers do not enforce `ensure_mirroring()`. | [`helpers.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/helpers.py) | An unrecognized, localized, authentication, or low-confidence screen becomes `ready`. Unknown state must fail closed, and every action must enforce readiness in code. |
| Observations and actions have no device/session/frame generation binding. | [`mirror.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/mirror.py) | A decision made from frame N can be applied after the phone, app, window, scale, or focus has changed. Reject stale actions before dispatch. |
| The normal capture path reuses one temp filename and does not clean it after each observation. | [`mirror.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/mirror.py) | Concurrent runs can cross-contaminate frames, and sensitive pixels remain on disk. Use private unique storage with a bounded lifetime. |
| Mouse/key down and up are separate global events without a guaranteed release cleanup, and capture/OCR have no complete wall-time contract. | [`mirror.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/mirror.py) | Cancellation can leave host input state uncertain. Bound every phase, attempt release cleanup, then report `effect_unknown`; do not claim success. |
| `doctor` does not fold missing app/window checks into its final exit status and reports OCR success even with zero recognized boxes. | [`admin.py`](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/admin.py) | Diagnostics cannot be the authority for a live session. A Neko doctor needs typed `PASS/WARN/FAIL/SKIP` results and an explicitly consented harmless input probe. |
| The pinned tree contains no regression suite or CI workflow for these properties. | [Pinned tree](https://github.com/ShawnPana/phone-harness/tree/720eaeb7b888875bedea742e253d1c61f19ee5a6) | Treat it as an early prototype and reimplement behavior from requirements and tests, not as a dependency. |

The risk is not that Apple failed to protect the device transport. The risk is that a broadly
privileged Mac process is synthesizing host-global input from untrusted model decisions and
untrusted pixels without a capability-sized protocol.

## Apple platform facts that constrain the product

Apple documents iPhone Mirroring as a user-enabled relationship between nearby devices on the
same Apple Account with two-factor authentication. The iPhone remains locked, the device shows
a persistent indication while it is used, and the user can choose **Ask Every Time** rather than
automatic authentication. Apple also exposes recent session history and revocation. The transport
uses Apple's authenticated peer-to-peer security; Neko must not replace, automate around, or
weaken pairing and authentication. See [Apple Platform Security](https://support.apple.com/guide/security/iphone-mirroring-security-sec6ab47ebfc/web)
and [Apple Personal Safety](https://support.apple.com/guide/personal-safety/manage-iphone-mirroring-ips70daa1bcf/web).

The current user-facing requirements are material, not setup trivia: supported Mac hardware with
macOS Sequoia 15 or later, iOS 18 or later with a passcode, the same Apple Account with 2FA,
Bluetooth and Wi-Fi, a nearby locked iPhone, and no conflicting Internet Sharing, AirPlay, or
Sidecar session. Apple currently says iPhone Mirroring is unavailable in the European Union and
only one Mac/phone pair can be used at a time. Unlocking the physical iPhone stops the mirroring
session, and inactivity can pause it. See [Apple's iPhone Mirroring requirements](https://support.apple.com/en-us/120421).

Screen capture and accessibility are separate Mac trust boundaries. Apple lets the user grant or
revoke screen-recording access per application, and `AXIsProcessTrusted` only reports whether a
process is a trusted accessibility client; neither fact proves that a particular phone window,
action, or outcome is safe. See [Screen & System Audio Recording settings](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)
and [`AXIsProcessTrusted`](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted).

**Neko policy:** pairing, reconnecting, Apple Account authentication, Touch ID/passcode prompts,
permission grants, Face ID, Apple Pay, OTP entry, and other secure-attention flows remain physical
user actions. A model never types a secret or clicks through an unknown authentication screen.
For an experimental helper, recommend **Ask Every Time**, but do not silently change the user's
Apple setting.

## Threat model for a future adapter

The first implementation must assume all of the following at once:

- Phone pixels and OCR text are untrusted data. An app, message, ad, notification, or web view can
  contain instructions intended to redirect the model.
- A coordinate can become stale between observation and dispatch because of animation, streaming
  content, a notification, rotation, resizing, focus loss, or a changed mirroring session.
- Screen Recording can reveal notifications, messages, health/financial data, OTPs, and cross-app
  identity. Error messages and traces can leak the same information even if screenshots are deleted.
- macOS Accessibility/input authority affects the host. A focus or bounds error is a Mac action,
  not merely a failed phone action.
- A timeout after dispatch has an ambiguous effect. Retrying a send, purchase, delete, transfer,
  or toggle can duplicate the effect.
- Concurrent controllers can invalidate each other's observations and input sequences.
- Project instructions, skills, phone content, and model output are not trusted to configure the
  executable, grant permissions, alter policy, or extend the action namespace.
- A compromised same-user Mac session is outside the helper's containment guarantee. The helper
  can reduce authority and improve auditability; it cannot turn a hostile host into a trusted one.

## Proposed Neko boundary

### Placement and lifecycle

**Proposal:** build a small, optional macOS companion with a stable application identity. Give TCC
permissions to that companion rather than to arbitrary Python or the user's general shell where
practical. Install it from a pinned, checksummed artifact outside the workspace. Project-local
configuration cannot select its executable, working directory, helper code, or environment.

The companion should expose only an authenticated local protocol with a random per-session
capability. It should start after an explicit user action, display that control is active, accept
only one controller, expire on inactivity, and stop on user request, phone unlock, session change,
lost focus, process exit, or capability loss. Child environment is a positive allowlist and carries
no provider, harness, cloud, shell, or repository credentials.

At the Neko edge, compose the adapter behind `McpTools` (or an equally narrow edge-owned port) in
`adapters/`; `core/` sees only schemas and results. The initial `phone` tool should remain gated in
every permission mode, including auto mode, until hardware evidence justifies a narrower policy.
No action accepts Python, JavaScript, AppleScript, shell, a module name, a filesystem path, a raw
Quartz event, or an arbitrary executable.

### Positive, fail-closed session state

Use a typed state such as:

`unavailable | permission_required | not_running | no_window | authenticating | phone_in_use |
paused | ready | unknown`

`ready` requires a fresh, positively identified iPhone Mirroring application PID/bundle ID, a
matching window owner PID and window generation, a stable in-bounds content region, an active
user-started capability, and a recognized non-authentication phone frame. Absence of a block string
is not evidence of readiness. A localized or novel interstitial, OCR failure, blank/DRM frame,
zero-sized/moved window, ambiguous match, or identity mismatch is `unknown` and rejects input.

### Typed observations and actions

An observation should return bounded metadata, not a naked temp path:

- adapter/session/device opaque IDs;
- application PID, bundle ID, window ID/generation, content bounds, scale, and orientation;
- monotonically increasing observation ID, capture time, and frame digest;
- connection state and why it was classified;
- bounded one-use element marks tied to that observation; and
- an explicit indicator when text or pixels were withheld as sensitive.

The first action vocabulary should be deliberately small: `observe`, `tap_mark`, bounded
`tap_normalized`, `swipe`, `type`, `key`, `home`, `wait`, and `stop`. Prefer one-use marks. A raw
visual coordinate, if needed for an unlabeled control, is normalized inside the phone content
rectangle and still bound to the observation; never accept global Mac coordinates. Validate the
entire text payload and keyboard mapping before posting the first key.

Every mutation carries an operation ID, expected session ID, observation ID/frame digest, window
generation, target, user-visible intent, risk class, and any required confirmation reference. The
adapter rejects unknown fields, excessive strings/gestures/durations, stale observations, reused
marks, out-of-bounds paths, and ambiguous targets.

### Observe -> preflight -> execute-once -> reobserve -> verify

| Phase | Required behavior | Forbidden behavior |
|---|---|---|
| Observe | Capture one fresh private frame and identity snapshot; return a bounded observation. | Reuse a process-global screenshot or an old OCR coordinate. |
| Preflight | Recheck capability, state, app/window PID, focus, bounds, generation, freshness, target, risk, and consent immediately before dispatch. | Treat a prompt instruction or the absence of English error text as authorization. |
| Execute once | Journal intent, dispatch one typed action once, pair down/up cleanup in the helper, and record whether dispatch may have occurred. | Hidden retries, fallback to raw Quartz/shell, or changing the target after approval. |
| Reobserve | Capture a new frame and identity snapshot regardless of apparent success. | Infer success from a zero exit code, pixel motion, or a tool acknowledgement alone. |
| Verify | Check action-specific success, the task invariant, and important negative side effects; return `verified`, `not_verified`, or `effect_unknown`. | Let the executor self-declare task completion without fresh evidence. |

If failure happens before dispatch, an explicit later operation may be safe. If dispatch may have
occurred, return `effect_unknown`: do not automatically replay. Re-observe, reconcile visible and
application state, and require a new model/user decision. This is the mobile form of Neko's existing
MCP rule that an outcome-unknown mutating call is never blindly retried; see
[`ARCHITECTURE.md`](../process/ARCHITECTURE.md#provider-web-and-mcp-effect-integrity).

An append-only local effect journal should record bounded, redacted metadata for intent, preflight,
dispatch, cleanup, re-observation, verification, and user confirmation. It should not retain full
screenshots, OCR dumps, secrets, or notification text by default. Frames use unique private storage
or memory, have a hard size/count/TTL, and are deleted on normal and error paths.

### Consent and risk classes

Start conservatively:

| Class | Examples | Required policy |
|---|---|---|
| Read-only but private | Observe screen, OCR a user-selected app, read notification text | Active user-started session; bounded disclosure; no silent background capture. |
| Reversible navigation | Home, open an app, scroll, focus a field, type into an unsent draft | Gated phone session and fresh preflight; verify after each action. |
| Consequential external effect | Send/post/call, purchase/order/reservation, payment/transfer, delete, account/security/privacy change | Fresh transaction confirmation naming the exact target, content, amount, and effect; execute once; verify final state and absence of duplicates. |
| Secure or unsupported flow | Pair/reconnect, permission grant, passcode/OTP/password, Face ID, Apple Pay, device/account recovery | Stop and hand control to the user. Never capture, type, infer, or store the secret. |

Phone content never grants permission. A message saying "tap Continue" or "ignore prior rules" is
only observed data. Confirmation must come through Neko's trusted UI and refer to the exact proposed
operation. Changing the recipient, amount, content, app, or observation invalidates it.

## What the benchmarks do and do not establish

Benchmark numbers are properties of a model **plus** observation modality, action schema, harness,
step budget, environment version, evaluator, and run protocol. They are not portable product claims.

| Evidence | Useful signal for Neko | Required caveat |
|---|---|---|
| [iOSWorld](https://arxiv.org/abs/2606.09764) | 133 single-app, multi-app, and memory/personalization tasks over 26 native SwiftUI apps; vision-only versus privileged XML is a useful ablation; its ethics section calls for consent and confirmation on irreversible operations. | It is a deterministic iOS **Simulator** with purpose-built apps, one fictional persona, synthetic data, a 50-step limit, and an LLM trajectory judge. The authors explicitly say results are not deployment readiness; vision+XML is privileged and unavailable to a deployed consumer agent. |
| [MobileWorld](https://aclanthology.org/2026.acl-long.278/) | 201 longer, cross-app Android tasks; explicit `ask_user` and MCP actions; backend/state verification shows why hybrid GUI/tool evals matter. | It runs a rooted Android Virtual Device in Docker with self-hosted open-source substitutes, an LLM-simulated user, and mostly binary completion. The paper notes physical-device latency/touch behavior and commercial apps may differ; external MCP services also add reproducibility risk. |
| [DAC-Bench](https://aclanthology.org/2026.acl-long.2064/) | 830 compositional episodes across Android and iOS expose sequential, conjunctive, conditional, and hierarchical decision failures. Physical phones were used to collect trajectories. | Evaluation is **offline static episode replay** against recorded screenshots and mainly one human gold trajectory. The authors warn this misses dynamic notifications/permissions/ads and can undercount alternative valid paths. It cannot validate an online executor or its safety. |
| [OSWorld 2.0](https://arxiv.org/abs/2606.29537) | Long-horizon evidence highlights stale observation-to-action gaps, hidden state, missed user clarification, skipped verification, and unsafe UI bypasses. It reports separate side-effect checks rather than treating task success as safety. | It is a desktop benchmark with self-hosted services and a partially model-based evaluator, not a phone benchmark. Use its failure modes and safety invariants to shape the protocol, not as a mobile score. |
| [MobileSafetyBench](https://doi.org/10.1609/aaai.v40i44.41090), [RiOSWorld](https://proceedings.neurips.cc/paper_files/paper/2025/hash/0c79d6ed1788653643a1ac67b6ea32a7-Abstract-Conference.html), and [OSGuard](https://arxiv.org/abs/2606.15034) | Add misuse, indirect prompt injection, environmental risk, unsafe shortcuts, and explicit final-state safety invariants to the eval plan. | These suites use different platforms and threat models. Passing one is not proof of safe real-device control; Neko still needs adapter-specific negative tests and hardware trials. |

### Evaluation lanes

Keep four lanes separate so a convenient score cannot hide an unsafe executor:

1. **Offline decision diagnostics:** DAC-Bench-style branching and constraint tests. Report this as
   perception/planning evidence only.
2. **Reproducible simulator/emulator integration:** pinned iOSWorld vision-only and MobileWorld runs.
   Report simulator type, model, effort, prompt, action schema, judge, step budget, seeds, failures,
   cost, and latency. Do not mix privileged XML with deployment-like results.
3. **Safety and effect integrity:** custom dynamic fixtures plus MobileSafetyBench/RiOSWorld/OSGuard-
   inspired cases for prompt injection, stale targets, duplicate effects, credential leakage, unsafe
   shortcuts, over-broad host input, and required abstention/clarification.
4. **Physical-device evidence:** owner-operated trials on named Mac/iPhone/OS/app versions. Start with
   harmless navigation, use test accounts for external effects, record every confirmation, and never
   infer general app coverage from a small smoke test.

For a harness comparison, hold the model, effort, prompt, task fixtures, privileges, hardware, OS,
app versions, and step/time budgets constant. Repeat enough times to show variance. Report strict
success and partial progress alongside unsafe-side-effect rate, false approval/confirmation rate,
abstention quality, stale-action rejection, ambiguous-effect recovery, duplicate-effect count,
action count, latency, tokens/cost, and cleanup reliability.

No "SOTA," "safe," "human-like," "any app," or "production-ready" claim is justified by this
audit. Promotion requires complete trajectories and a matched baseline/candidate result under the
claim gate in [`harness-sota-2026-08-09.md`](harness-sota-2026-08-09.md#evaluation-and-promotion-gate).

## Ordered implementation gate

This remains backlog, not completed work:

1. Owner approves the macOS companion/TCC architecture and product wording.
2. Write the threat model, state machine, schemas, risk table, error semantics, and retention policy
   before touching Quartz or requesting permissions.
3. Build a deterministic fake adapter and negative tests for localized/unknown interstitials, PID/
   bundle/window mismatch, moved/resized windows, stale frames, reused marks, focus theft, out-of-
   bounds input, full-text prevalidation, down/up cleanup, cancellation at every phase, timeout after
   dispatch, concurrency, fixed-path collisions, OCR-secret leakage, prompt injection, poisoned PATH/
   environment, and helper/artifact tampering.
4. Implement the smallest signed/canonical companion with no script escape hatch. Prove that its IPC,
   environment, capture lifetime, and executable location remain outside project control.
5. Run simulator lanes, then an owner-visible harmless physical smoke test. External effects remain
   disabled until effect-unknown recovery and transaction confirmation pass adversarial tests.
6. Only then consider a narrowly scoped preview, with an emergency Stop, session expiry, revocation
   instructions, explicit platform exclusions, and no automatic install from a phone request.

## Primary sources

### Audited prototype

- [`phone-harness` pinned snapshot](https://github.com/ShawnPana/phone-harness/tree/720eaeb7b888875bedea742e253d1c61f19ee5a6)
- [README at the pinned snapshot](https://github.com/ShawnPana/phone-harness/blob/720eaeb7b888875bedea742e253d1c61f19ee5a6/README.md)
- [stdin executor](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/run.py)
- [helpers, readiness, OCR, and mutable helper loading](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/helpers.py)
- [window capture and Quartz input](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/mirror.py)
- [doctor](https://raw.githubusercontent.com/ShawnPana/phone-harness/720eaeb7b888875bedea742e253d1c61f19ee5a6/src/phone_harness/admin.py)

### Apple

- [iPhone Mirroring requirements and behavior](https://support.apple.com/en-us/120421)
- [Apple Platform Security: iPhone Mirroring security](https://support.apple.com/guide/security/iphone-mirroring-security-sec6ab47ebfc/web)
- [Apple Personal Safety: manage and revoke iPhone Mirroring](https://support.apple.com/guide/personal-safety/manage-iphone-mirroring-ips70daa1bcf/web)
- [Control Screen & System Audio Recording access on Mac](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)
- [`AXIsProcessTrusted`](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted)

### Evaluation and safety

- [iOSWorld paper](https://arxiv.org/abs/2606.09764), [project](https://iosworld.io/), and [code](https://github.com/ljang0/iOSWorld)
- [MobileWorld paper](https://aclanthology.org/2026.acl-long.278/) and [code](https://github.com/Tongyi-MAI/MobileWorld)
- [DAC-Bench paper](https://aclanthology.org/2026.acl-long.2064/) and [code](https://github.com/YuqingZhangMirror12/DAC-Bench)
- [OSWorld 2.0](https://arxiv.org/abs/2606.29537)
- [MobileSafetyBench](https://doi.org/10.1609/aaai.v40i44.41090)
- [RiOSWorld](https://proceedings.neurips.cc/paper_files/paper/2025/hash/0c79d6ed1788653643a1ac67b6ea32a7-Abstract-Conference.html)
- [OSGuard](https://arxiv.org/abs/2606.15034)
