# Neko Core work log

This is the compact current engineering record. User-facing release history belongs
in [CHANGELOG.md](../../CHANGELOG.md); older implementation detail remains recoverable
from Git. Current product truth lives in the code, tests, ROADMAP, architecture, and
process documents, not in an old log entry.

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

Neko Core 1.5.0 is the current release candidate. The 1.x baseline includes the stable CLI and
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

## Current verification state

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

## Active objective

The active harness objective and stopping rules are in
[HARNESS-GOAL.md](HARNESS-GOAL.md). Work proceeds from deterministic correctness to a
frozen multi-task, multi-replicate, compute-matched ProgramBench campaign. No SOTA or
general-lift statement is allowed before the public claim gate in EVALUATION is met.
