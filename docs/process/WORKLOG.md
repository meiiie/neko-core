# Neko Core work log

This is the compact current engineering record. User-facing release history belongs
in [CHANGELOG.md](../../CHANGELOG.md); older implementation detail remains recoverable
from Git. Current product truth lives in the code, tests, ROADMAP, architecture, and
process documents, not in an old log entry.

## 2026-09-09 - v1.6.1 candidate: automatic ChatGPT repair

The owner authorized release and focused testing only. Automatic preflight now
repairs Neko-owned incomplete/outdated Codex packages before the model request,
preserving credentials and terminal drafts on failure/cancel. First-time setup
still asks once; no external CLI is replaced. Metadata/downloads, extraction,
signature checks and the local protocol probe honor cancellation. A cross-process
installation lease serializes repairs; a second repair reuses the verified result.
No tools are replayed and no model is silently substituted.

Focused gate: **155 passed, zero failed** (153 in nine affected test files, one
narrow feedback viewport test, one digest fixture test). Includes failed/cancelled
preflight with zero RPC/tool calls, preserved draft + successful retry, and concurrent
repair/cancel. Typecheck/lint and production build passed (951 modules); real PTY
input, ACP v1 and startup/exit probes passed. An isolated installation of the real
OpenAI 0.153.4 Windows package also passed async extraction, signatures and one
Code Mode tool round trip against a synthetic localhost model: no paid inference.
Global support files and the original feedback report were left untouched.
The feedback Worker also passed generated types and local D1/email integration.
Doctor/policy completed with expected trust/auto-mode/non-TTY warnings; these were
not hidden or reclassified as successful confinement.

CI has an explicitly selected `codex-feedback` dispatch scope for this authorized
patch; automatic CI and the default dispatch scope still run the full suite.
Release dispatch is allowed only on version tags. The candidate uses `[skip ci]`
to avoid a duplicate automatic full run, then explicitly dispatches focused CI
before tagging and dispatching release. Publication/deploy results follow when verified.

## 2026-09-09 - Code Mode support repair and shorter feedback flow (initial checks)

The first private feedback report described a missing `codex-code-mode-host.exe`
after ordinary chat succeeded. Its attachment contained assistant text, not the
underlying process failure, so it alone did not establish the cause. Local package
inspection confirmed that the old installer kept only the App Server executable.
The official 0.153.4 package contains the host and additional runtime resources.

At this initial checkpoint there was no version bump, push, release or Worker
deployment. Normal tools, authority, ACP, provider protocols and completion logic
are unchanged; ProgramBench remains paused.

- Install the complete official `codex-app-server-package` asset, preserve its
  layout, verify archive digest, expected entries/types, metadata and applicable
  binary signatures, then atomically activate. Incomplete same-version packs are
  repairable without `force`; failed installs retain the prior pack. Discovery and
  launch reject incomplete managed packages with `CODEX_SUPPORT_INCOMPLETE` and
  `/support chatgpt install` guidance; credentials are not removed.
- Installation now exercises actual Code Mode and one dynamic-tool callback using
  a synthetic localhost model service, rather than only the initialize handshake.
  The official Windows 0.153.4 package passed this probe in an isolated home: two
  local response requests, one callback, no paid model inference. Download size was
  109.0 MiB; installed files were 314.2 MiB. This remains an optional external pack,
  not an embedded dependency in the base Neko executable. Other OS live probes and
  the reporter's account have not been verified here.
- `/feedback`: private notes, then sharing summary/send. Conversation/tool text is
  off by default; optional full JSON view, note editing and secondary exports remain.
  ChatGPT basic diagnostics identify local support state/version/component with
  fixed codes, not raw paths, credentials or stderr. Wire v1 is unchanged. Email
  copy no longer asserts that the submitter read every byte of the attachment.

Focused checks passed for archive safety/repair, discovery, feedback consent and
revocation, exact preview/upload matching, duplicate clicks, cancel/disconnect,
ChatGPT voice and digest-pinned discovery. A real Ink/virtual-terminal 80x24 test
keeps feedback consent/actions visible with long notes. Full local gate: typecheck
and lint passed; **1,612 tests passed, 14 skipped, zero failed** across 150 files.
Doctor and policy exited successfully with the expected local trust, auto-mode,
bridge and non-TTY warnings. Production build bundled 949 modules; real PTY input,
ACP smoke and first-frame/exit lifecycle probes passed. The feedback Worker passed
generated-type checking and local Miniflare D1/email integration; dry-run only,
no deployment. Raw user feedback was not copied into the repository or resent.

Reference: [official package layout](https://github.com/openai/codex/blob/rust-v0.153.4/scripts/codex_package/layout.py).

## 2026-09-08 - v1.6.0 released

Published [v1.6.0](https://github.com/meiiie/neko-core/releases/tag/v1.6.0) at
2026-09-07 18:05:14 UTC from `adbb74cd518ce60d85bb8d80b186066c9b529420`.
[CI](https://github.com/meiiie/neko-core/actions/runs/34149740541) and the
[release workflow](https://github.com/meiiie/neko-core/actions/runs/34150128559)
completed successfully, including Linux/macOS/Windows, the feedback Worker,
native input/ACP probes and both startup renderers. All 17 assets are public and
`releases/latest` resolves to v1.6.0. The Windows gzip was downloaded, decompressed,
verified against its SHA-256 sidecar and executed: `neko-core 1.6.0`.

Final local UI checks: 27 pass, 185 assertions; production build: 946 modules;
real ConPTY ghost/typing: three passes using three synthetic localhost requests,
no external model calls. Final scroll probe: 12 ms first response / 189 ms settle,
with startup, resize, slash menu and keyboard checks passing. Doctor/policy retain
the expected local untrusted-project, unconfined-auto, offline-bridge and non-TTY
warnings. No new root runtime dependency was added.

Local aggregate runs also reproduced benchmark-supervisor timeouts during heavy
host load (94% total CPU observed). All three supervisor cases later passed in a
fresh targeted process, but this does not establish the full cause of their
combined-run variability. Failed logs were retained alongside passing runs;
cross-platform CI on the tagged commit is the complete clean-suite record.
ProgramBench remains paused, and none of these test runs is a benchmark score.

Deployed the website fallback with Worker version
`308c76e7-7a8f-4944-bca6-301d16046805`; its HTML and `/__release` both report 1.6.0.
The feedback backend remains the previously verified deployment below. Inbox
placement of feedback emails is still not independently verified.

### Candidate investigation

Owner authorized release of the provider repairs, dynamic ChatGPT catalog, private
feedback flow and repository-documentation refresh. No completion-controller,
authority or session-schema changes; ProgramBench remains paused.

Reproduced the remaining completed-turn resize failure before resize was even
attempted: the fixture depended on personal configuration and a fixed 450 ms
turn-completion delay. The fixture now uses an isolated home, waits for the final
answer and idle frame with a bounded deadline, and always unmounts/restores its
environment. Its original resize/Ctrl+Up no-ghost assertions remain intact and pass.
The previous meeting/handoff timeouts passed again in full sequential shards,
without changing those tests. A separate supervisor fixture sometimes terminated
before the child's signal handler was installed. Its existing termination seam now
waits for a bounded ready marker before invoking the real process-tree terminator;
the supervisor's 750 ms timeout, dead-PID assertion and 10-second overall bound stay
intact. The output-cap fixture yields between writes instead of saturating the
event loop, and temporary-directory cleanup retries short Windows handle-release
delays. These are fixture changes, not production timing or benchmark-score changes.

The initial candidate passed all 1,606 local tests (14 existing skips), typecheck,
lint, doctor/policy and production build. Its real ConPTY fallback-renderer gate
then reproduced a missing first header row. `wrapStdoutForSync` returned the raw TTY
when both sync support and the differ were disabled, bypassing its own filtering
of Ink's sync brackets and the internal caret sentinel. The wrapper now applies
that filtering to all TTY renderers; non-TTY streams remain unchanged. Added a
targeted regression, first-frame diagnostic output, and a fallback-renderer gate
in CI and every native release build. The source lifecycle probe passes after
the fix; the complete candidate gate must be rerun before tagging.

The subsequent full rerun exposed the known handoff-spool fixture timeout. A
separate timing probe measured 10,443 ms creating 1,025 files versus 711 ms listing
the spool. Moved mass file preparation into a separately bounded 30-second setup
hook and a distinct fixture directory. The actual scan still has its original
5-second test timeout and all 1,024-entry/truncation assertions; no store code or
production limit changed. Temporary timing instrumentation was removed.

The real scroll probe then found a narrow-window slash menu overflowing the
viewport: multiline descriptions exceeded the fixed ten-item height estimate.
Suggestions and their footer now truncate to single rows, and item count respects
terminal height. Extended the existing short-window simulation to 72x20 and 40x10,
including keyboard selection/completion. Updated the probe's stale second-item
expectation from `/cost` to the newly added `/feedback`; it only completes the
command and never submits a report. The normal scroll metric itself was
27 ms first response / 180 ms settle; this is a workstation observation, not a
compute-matched performance claim.

The Worker typecheck and local real D1/email-binding integration pass. Added a
dedicated Linux CI job for them, without credentials or live email. Full local,
cross-platform CI and release artifact results are authoritative in the release
workflow; do not equate the candidate version string with successful publication.

## 2026-09-07 - Private feedback email service deployed (pre-release checkpoint)

After owner sign-in, verified the destination `meiiiekhp888@gmail.com`. Dashboard
general Email Sending requires Workers Paid, but the official verified-destination
Email Routing binding works on Free. No plan upgrade or website/general routing
change was made. An initial D1 creation returned auth error 10000; a later explicit
APAC creation succeeded without changing credentials/scopes. Its precise cause was
not established.

Deployed the dedicated `neko-feedback.holilihu.online` Worker, version
`c3da976c-c51b-4884-8d81-ba17e2e230e9`, with restricted sender/receiver, server-only
IP hash secret, D1 receipts, atomic daily admission limits, and scheduled retention.
Report bodies stay out of D1 and application logs. There is no public report listing,
SMTP secret in the CLI, paid model call, or durable raw-payload retry queue.

The real email binding accepted synthetic reports of 454 and 500,512 bytes. Both
duplicate submissions returned their existing receipts; D1 contains two accepted
rows. Gmail Inbox placement remains unconfirmed. No real user logs were sent.

CLI flow: separate notes editor, optional text/tool log, exact scrubbed preview,
explicit send or local export. Save first, send once, then poll status; uncertain
outcomes preserve the local copy and never auto-resend. Real Ink regressions verify
Esc/Ctrl+C/unmount cancellation, queued command drainage and no model calls. Fixed
an uncovered edge case: reports made before choosing a model now use `unconfigured`.

Typecheck/lint pass; 13 targeted feedback tests pass (147 assertions), plus local
workerd/D1/email integration for deduplication, conflict, unknown outcome, quota and
privacy boundaries. Production build includes 946 modules and passes keyboard PTY,
ACP smoke, and startup/exit lifecycle probes. Doctor/policy complete with the same
local trust, unconfined-auto, offline bridge and non-TTY warnings. All 23 checked
relative links resolve; `git diff --check` passes. The API sender adds no root
dependency. Cloudflare development dependencies are isolated in their own package.
See [deployment instructions](../../cloudflare/feedback/README.md).

No version bump, installed-binary replacement, commit, push, release or ProgramBench
run. The broader suite's previously recorded failures below are not resolved by this
targeted work; a new CLI release still requires its full gate.

## 2026-09-07 - Cloudflare prerequisite check (historical; resolved above)

Owner approved Cloudflare. Created only the Email Routing destination for
`meiiiekhp888@gmail.com`; Cloudflare sent its verification message. Last observed
state at this checkpoint was pending owner confirmation. No session/report data was uploaded.

Email Sending list, domain inspection and enable for `holilihu.online` fail with
Unauthorized (2036), despite the CLI advertising both email write scopes. Cause
is not established; the Dashboard is at the existing-account sign-in screen and
has been left open for owner handoff. No DNS mutation was confirmed and no Worker
or sender was activated. Automatic `/feedback` sending remains unimplemented and
undeployed; local reviewed drafts remain available. No source/dependency changes,
paid calls, benchmarks, commit, push or release in this prerequisite check.

This checkpoint's blockers were resolved by the deployment entry above. Retained
here to distinguish its failed prerequisite calls from the later verified send.

## 2026-09-07 - Dynamic ChatGPT catalog and private feedback workflow (unreleased)

Removed the live model-name allowlist. Account metadata selects direct/native
transport and minimum Codex version; installed newer clients determine the catalog
compatibility query. Routing snapshots expire after five minutes and are scoped to
both bearer and selected account. Known direct bootstrap models retain their fast
first-turn path. Unknown future model fixtures cover discovery/routing/version gating;
this is not a promise that arbitrary future protocols or account entitlements work.

The owner selected `meiiiekhp888@gmail.com`. `/feedback` now provides a separate
notes editor, explicit optional current-session text/tool logs, bounded scrubbing,
an unabridged exact-attachment preview, and `.eml`/JSON export. No notes are sent to
the model. Tool arguments are scrubbed before an extra JSON encoding can hide key
patterns. No background telemetry, hidden provider state, images or credential-store
dump. Scrubbing remains best-effort; source/business content may remain.

Codex CLI 0.153.4's real feedback menu was inspected using an isolated home without
a model request and cancelled before upload. Cloudflare Email Sending returned
Unauthorized; Email Routing was readable but the requested receiver was unverified.
No email/address/domain/sender change occurred. Automatic sending is **not implemented
or deployed**; exported drafts say NOT sent. See [feedback contract](FEEDBACK.md).

Final targeted checks: 53 pass / 0 fail across five files, including real Ink notes,
preview and cancellation, account-switch invalidation and shared-refresh cancellation.
Typecheck, lint, doctor/policy, production build (944 modules), PTY keyboard, ACP and
startup/exit lifecycle pass. Doctor/policy retain expected local configuration warnings.
39 relative documentation links resolve and `git diff --check` passes.

The broader four-shard Windows run was **not green**: 1,596 pass / 14 skip / 3 fail
across 149 files. Meeting permission inspection and CLI handoff hit the default 5s
test limit; each passed when isolated, with unchanged assertions/timeouts. Fullscreen
`resize after a completed turn keeps the input row empty` still failed in isolation
at line 122: its fixed 450ms wait expired before `final answer`, before resize runs.
The screenshot showed a busy first turn, not a demonstrated geometry defect. The
cause is not established; do not dismiss it as unrelated or claim a full green gate.
Logs remain in the local `neko-feedback-gate-4853af44a45e43aca113489a408625b9` temp
directory. Later catalog account-scope and tool-argument scrubbing adjustments are
covered by the final targeted checks and build, not by a repeated full-suite claim.

No `src/core`, dependency, permission/sandbox, version, installed binary or benchmark
changes. No commit, push or release. Next: resolve the first-turn fixture failure,
then obtain the owner's email-service choice and verify sender/receiver before
implementing automatic submission. Do not ship a sender credential in the CLI.

## 2026-09-07 - Provider incident fixes and local feedback drafts (unreleased)

Fixed connection-override ownership when switching profiles, normalized the known
legacy built-in Z.AI Coding Plan endpoint, and added a preflight failure for explicit
Messages/OpenAI endpoint mismatches. ChatGPT transport now accepts its canonical Neko
control directory when launched exactly from user home, retaining project/junction/root
guards and all native-tool restrictions. GPT-6 Astra uses the shared native route,
live account catalog and a Codex 0.153.4 compatibility floor; other routes keep their
existing behavior. `/feedback` previews an allowlisted diagnostic draft and saves it
locally only. No hosted inbox, email delivery, or automatic telemetry was deployed.

Evidence: typecheck and lint pass. The Windows CI-equivalent four sequential shards
pass 1,592 tests, skip 14 environment-dependent tests, and fail none across 148 files.
An initial single-process run hit the existing fullscreen fixture's fixed 450 ms
completion assertion; its assertions/timeouts were not changed. The canonical shard
run retained and passed that test. Doctor/policy finish with the expected untrusted
project, unconfined auto, offline bridge and non-TTY warnings. Production build,
keyboard PTY probe, ACP smoke and startup/exit lifecycle pass.

A real Codex 0.145.0 App Server initialized successfully from the user-home cwd and
closed cleanly, without sending a model prompt. The local account-catalog probe was
unavailable; Astra entitlement and a live model response on the friend's account are
not claimed. No `src/core` or dependency changes, no ProgramBench run, no version bump,
commit, push or release. See [incident analysis](../research/provider-incidents-2026-09-07.md)
and [feedback privacy/hosted-phase proposal](FEEDBACK.md).

## 2026-09-07 - Working-instruction and state cleanup

Read the official GPT-6 Astra prompting and Codex AGENTS.md guides, then audited the
repository instructions against current code and release metadata. AGENTS.md now
routes to shared rules and scoped verification; CLAUDE.md is a short compatibility
entry. The Claude verify command now checks TypeScript/Bun instead of the frozen
Python port, and secret-scan uses redacted gitleaks. The obsolete Python port command
and unreferenced remote-sandbox sketch were removed; both remain recoverable in Git.

ROADMAP now records published v1.5.1 at `c03012a`. The duplicated self-improve state
and campaign narrative were reduced to canonical links. R6's local manifest and summary
were inspected and hashed: ten terminal results, two interrupted, six pending, and no
eligible improvement claim. EVALUATION holds the snapshot; execution remains paused.
The old self-improve runner is explicitly identified as a legacy unbounded, auto-commit/
revert workflow, not an approved maintenance command. Its implementation was not changed.

This is repository guidance/documentation work. Product sources, provider defaults,
runtime permissions, dependency versions, and benchmark artifacts are untouched.
The dated [Astra review](../research/codex-astra-instructions-2026-09-07.md) records
sources, applied decisions, and the verification scope.

## 2026-09-04 - v1.5.1 resumable compressed release transport

A field upgrade from v0.19.0 to v1.5.0 repeatedly timed out on a route delivering the 89.5 MiB Windows binary at
roughly 0.1-0.2 MiB/s. The old updater applied a total deadline and did not preserve a cross-process checkpoint;
the one-line installers also used process-specific staging and deleted partial data on exit. Increasing the
deadline would still discard progress after a later interruption.

The release transport now follows the same primitives used by current package installers: gzip archives reduce
the measured Windows transfer to 39.1 MiB, downloads stream to tag-stable partial files, HTTP Range and
Content-Range resume only from a validated offset, transient connection/HTTP failures receive bounded exponential
backoff, and a 60-second idle watchdog replaces the total wall-clock cutoff. The official raw-binary SHA-256 and
embedded version remain the trust boundary after decompression; activation remains atomic. A live probe against
the v1.5.0 GitHub asset returned 206 for an end-of-file range and the production downloader completed the exact
93,849,088-byte length without fetching the prefix again. The website's Windows button now serves a conventional
ZIP of the same binary, so manual downloads receive the same transfer reduction without requiring PowerShell.

The targeted updater and installer tests cover slow continuous progress, stalled reads, early EOF recovery,
range resume, a server ignoring Range, archive expansion bounds, persistent cleanup, and release asset accounting.
The exact release candidate subsequently passed the full suite: 1,581 tests, 16 explicit skips, and zero failures
across 147 files. The tracked Git history and working diff also passed the gitleaks gate.

Published as [v1.5.1](https://github.com/meiiie/neko-core/releases/tag/v1.5.1)
on 2026-09-04 at commit `c03012af31b81d04b13b8f65757f0f23d3cafe51`.

## 2026-09-04 - v1.5.0 host-shell routing and stabilization

Ordinary `neko` and `neko --yolo` sessions now route Bash directly to the same host and identity as Neko by
default. The model receives the exact execution target, current working directory, detected CLI toolchain, and
network behavior before acting. Computer Use remains a visible-GUI capability and is never a terminal, package,
download, build, test, or network fallback. Windows child consoles remain hidden, and long-lived processes use the
existing background-process path so they do not take over the user's desktop.

This is an explicit authority change, not a claim that host execution is sandboxed. Project trust, credentials,
permission gates, catastrophic-command seatbelts, and policy reporting remain in force. Users who select
`sandbox: true` keep the fail-closed OS sandbox with no silent host fallback. Independent completion review remains
read-only and sandboxed; ProgramBench remains isolated in its pinned networkless cleanroom.

The provider-agnostic completion contract, evidence receipts, bounded validation, and ProgramBench adapter are
included in the v1.5.0 source. The owner paused further ProgramBench campaigns until after the 1.5.0 release, so
the existing results remain diagnostic and no general controller-lift or SOTA claim is made.

The exact v1.5.0 release source passed typecheck, anti-slop lint, 1,579 Bun tests with 14 explicit skips and zero
failures, and 44 Python tests with three platform skips plus 33 subtests. Production compile, UI render, real-PTY
input, ACP handshake, startup/exit lifecycle, and three real-ConPTY ghost/typing runs passed. The scroll probe
measured 11 ms first response and 141 ms settling after a 15-event wheel flick. The ghost probe previously used
an 800 ms fixed wait and produced a false dead-input verdict under load; it now waits for the observable echo
under a five-second ceiling and reports measured latency. A SHA-256-verified official Gitleaks 8.30.1 portable
binary found no secret in the complete staged diff. Hosted Windows CI then exposed a cold CLI subprocess that
crossed Bun's generic five-second test deadline under shard load; a subprocess-specific 15-second allowance keeps
the exact policy assertions intact without changing production behavior.

## 2026-08-30 - Completion-system campaign

Neko gained an experimental provider-agnostic completion contract for explicit
closed-loop work. A separate supervisor builds the completion instrument before
implementation and reviews the artifact through a restricted read-only registry.
Criteria are observable outcomes, existing criteria cannot be weakened, new coverage
gaps cannot pass in the review that introduced them, and raw validator cases do not
cross to the implementer.

The ProgramBench 1.2.4 adapter keeps credentials and provider traffic on the host,
executes native tools in the official networkless cleanroom, records a privacy-bounded
trajectory, enforces one aggregate provider-call budget, and optionally scores through
the pinned Linux evaluator. Campaign manifests freeze task/profile/controller/replicate
cells and resume atomically.

Two one-replicate route/evaluator smokes scored 97/100 on `cmatrix` and 76/100 on
`bat`. They validate the adapter, not controller lift. `yj` repetitions exposed high
controller variance: one local-equivalent artifact scored 58/100, another 2/100, and
several valid runs ended without the required executable. Docker/preflight failures
are recorded separately. See [EVALUATION.md](EVALUATION.md) for the canonical ledger
and claim boundary.

R15 showed the current root problem. The model produced substantial source, but it did
not establish a buildable offline artifact early and exhausted the work window after a
dependency lookup tried to reach the network. ProgramBench correctly denied egress.
The contract controller now yields after a frozen number of implementation steps so an
independent review can expose a missing artifact or offline build path before the final
window. This treatment is opt-in for ProgramBench; ordinary `run()` behavior is
unchanged. The campaign measures time-to-runnable artifact, not merely edit count.

Live campaign telemetry now reports phase, coarse tool state, artifact checkpoints,
mutation epoch, validation state, and remaining work-window time every 30 seconds.
It excludes prompt/model text, arguments, commands, paths, observations, continuation
data, and credentials.

## 2026-08-31 - ProgramBench evaluator and frozen pilot

Frozen R2 completed five valid paired cells before infrastructure invalidated the
rest. The valid pairs showed a +43.67 point mean contract lift with exact one-sided
`p=0.0625`, which is promising but below the decision threshold. Contract delivered
all five artifacts while the matched single controller delivered none. One later
contract artifact lacked the required executable and remains a controller zero.

A transient DNS outage then exposed a mutable package-index lookup in the host
launcher. ProgramBench is now invoked from its primed cache with `uv --offline`.
Invalid-deliverable evaluator metadata is scored as a model/controller zero, while
network, evaluator, and Docker failures remain excluded. Campaign execution also
stops at the first infrastructure-invalid cell and preserves later work instead of
repeating the same outage. R3 then failed its first preflight before a model call
because the scrubbed launcher could not see the host-global cache. The launcher now
receives one canonical cache path outside the workspace while remaining offline; a
one-call smoke produced a valid trajectory in the networkless cleanroom. The frozen
R2 and R3 evidence was not rewritten; R4 starts from a new source snapshot. The R4
gate passed 1,579 Bun tests, 14 platform skips, Python protocol tests, typecheck, lint,
doctor, policy, and the production lifecycle build.

R4 stopped at its fourth cell and is infrastructure-invalid. Its first matched `fx`
pair scored 0 for `single` versus 28.77/100 for `contract`; the next contract replicate
failed to deliver an executable. The fourth single replicate reached the host deadline
with 73 provider admissions, 77 settled tools, and 25 artifact checkpoints, but a Z.AI
request did not settle after abort. The outer runner then entered remote-state teardown,
where cleanup created a new containment token and reused a ten-second transport window.
That cleanup timed out, so no terminal trajectory was written. The campaign correctly
stopped rather than converting the infrastructure fault into a controller zero.

The lifecycle boundary now races every provider call against the host abort signal,
ignores late deltas and usage, removes remote state without creating a new task token,
uses a separate thirty-second cleanup budget, and writes the terminal trajectory before
propagating teardown failure. Regression tests cover an abort-ignoring provider, direct
close semantics, and trajectory persistence under teardown failure. A live one-call
Docker smoke emitted a valid `artifact_missing` trajectory and left no owned process or
container. R4 remains immutable; the next full matrix is R5.

R5 produced one valid `fx` pair before the benchmark host was power-cycled for an
unrelated NVMe failure. The single arm delivered no executable and scored zero after
81 provider calls and about 3.53 million tokens. The contract arm delivered an
executable, passed its internal validator, and scored 15.11/100 after 68 calls and about
1.12 million tokens. This is a diagnostic +15.11 point, +1 artifact, -13 call, and
-2.41 million token delta; one pair has exact `p=0.5` and supports no promotion claim.

The interrupted R5 cell also exposed that the candidate cleanroom itself was not owned
by the Docker-daemon cleanup guard used for evaluator branches. A Windows process-tree
kill could therefore leave its seven-hour sleep container alive. The cleanroom now
receives the same random run label as a cell-scoped heartbeat guard that starts before
model work. A live `taskkill /T /F` probe removed the cleanroom, guard, and heartbeat
without host `finally` execution. R5 remains immutable and infrastructure-invalid; R6
restarts the full matrix with the repaired ownership boundary.

The repaired R6 candidate passed the complete pre-campaign gate: 1,579 Bun tests with
14 explicit platform skips and zero failures, 47 Python tests with three platform
skips, typecheck, lint, diff hygiene, doctor, policy, production build, PTY input, ACP,
and startup lifecycle probes. Docker ownership was empty; E: was healthy with no new
Disk/NTFS fault event since boot. Source is frozen for the 18-cell R6 comparison.

The first frozen `fx` pilot separated controller behavior from evaluator behavior. A
single-controller replicate used 93 provider calls and about 4.94 million tokens but
ended `artifact_missing`. Two contract-controller replicates produced artifacts; the
official ProgramBench 1.2.4 scoring path measured 24/100 and 35/100. The first used 51
provider calls and about 1.18 million tokens. These are diagnostic pairs, not evidence
of general lift.

The official evaluator's post-compile `docker commit` hangs on the current Docker
Desktop Windows backend. A pinned workspace-snapshot transport now restores the one
compiled workspace into each clean task container while leaving tests and scoring
unchanged. Calibration reproduced the known `cmatrix` 97/100 result and all 769 test
rows. Structured run records preserve model telemetry for missing artifacts, reject
evaluator summaries with top-level errors, and keep infrastructure failures out of
controller scores. Campaign manifests now freeze source and image provenance, emit a
paired aggregate report, and refuse resume after drift.

Windows Terminal can terminate Bun and all of its descendants before an in-process
`finally` block runs. The evaluator therefore has a Docker-daemon cleanup guard that
watches a credential-free heartbeat and removes only containers with the run's exact
label. A live Ctrl+C probe confirmed that both the evaluator process set and the guard
were absent six seconds after interruption.

The managed success path then reproduced `cmatrix` at 97/100 with the expected 506
scored tests and exact run ID, and exited with no owned evaluator, branch, guard, or
heartbeat left behind.

## 2026-08-28 - Stable 1.x platform

The stable 1.x platform includes the CLI and
Ink TUI, provider/account routing, durable sessions, ACP v1, governed native/MCP tools,
browser and Office integrations, OS sandboxing, global skills, verified updater and
rollback, and compiled Windows/Linux/macOS artifacts.

Wiii Workstation Awareness v1 is session-scoped ACP authority. Neko exposes the
Computer tool and dynamic workstation context only after strict capability
negotiation. Wiii owns provisioning, project binding, credentials, native identifiers,
and leases; Neko owns semantic preconditions, stable operation IDs, redaction, stale
state recovery, and best-effort release. Capability absence never falls back to local
Windows control.

ACP host profiles provide a separate exclusive tool surface for embedding products,
beginning with NekoCut. They do not narrow or alter normal Neko sessions.

## Historical verification snapshot (2026-08-31)

The completion/ProgramBench changes pass focused Agent/Harbor and Python protocol
tests. After the R4 lifecycle repair, a clean full Bun run on 2026-08-31 reported
1,579 passes, 14 explicit platform skips, and zero failures across 147 files in 238.40
seconds. The Python Harbor suites reported 47 passes and three platform skips. Windows Bash abort/timeout
teardown was stabilized at the product boundary: termination first waits for the
trusted `taskkill /T` result and scans CIM only if the leader is still alive. Five
stress rounds killed every grandchild without widening a production execution
deadline. Typecheck, lint, diff hygiene, doctor, policy, production compile, real-PTY
input, ACP handshake, and startup/exit lifecycle probes all passed before campaign
freeze. An earlier full-suite attempt with the Windows user TEMP on a nearly full C:
drive produced one `ENOSPC` fixture failure and three load timeouts; all four passed in
isolation, and the complete clean run used an outside-repository TEMP on E:.

## Objective and execution state

The harness objective and stopping rules are in [HARNESS-GOAL.md](HARNESS-GOAL.md).
Execution is paused; current progress belongs in ROADMAP and EVALUATION. No SOTA or
general-lift statement is allowed before the public claim gate is met.
