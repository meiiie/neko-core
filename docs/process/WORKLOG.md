# Neko Core work log

## 2026-11-12 — browser-extension release packaging repair (PR, not released)

- Root cause: `release.yml` bypassed `package-browser-extension.ts` with a hand-written
  ZIP file list that omitted the side-panel HTML and JavaScript declared by the manifest.
- Route releases through the same developer/store packager, retaining the public asset
  naming convention and developer extension key. No version/tag/public artifact is changed.
- Validate manifest entry points, local HTML/CSS dependencies, static JS imports and
  scripting file lists; extract the resulting ZIP and compare its entire inventory and
  file bytes with staging before an upload is allowed.
- Regressions execute the actual release packaging command and both packaging modes;
  deleting sidepanel HTML/JS, popup CSS, an icon or the injected script fails packaging.
  The original release command reproduces a missing `sidepanel.html`; the fixed command passes.
- Bun 1.4.0: typecheck/lint and 18 targeted packaging/bridge tests pass locally.
  A local full-suite attempt hit unrelated read-only HOME errors in UI fixtures; cross-platform
  PR CI is the full-suite verification. This does not claim a live Chrome interaction test.


This is the compact current engineering record. User-facing release history belongs
in [CHANGELOG.md](../../CHANGELOG.md); older implementation detail remains recoverable
from Git. Current product truth lives in the code, tests, ROADMAP, architecture, and
process documents, not in an old log entry.

## 2026-11-11 - v1.9.0 release preparation

Prepared the minor-version candidate from merged main `0bca69c64571ecc1df53d2170697bb5b325583e5`.
The isolated verification baseline matches upstream tree
`884e8dbd00a125da655d3ab18611cc6071004ffb`; the preparation changes version metadata
and release documentation only. The v1.8.0 comparison includes reviewed task-memory
dreaming (#92), the isolated domain runtime/review (#91), and company-site work
(#87/#88). No recall/coding-quality gain, Wiii acceptance or site deployment is claimed.

Fresh Linux verification of the 1.9.0 runtime candidate on Bun `1.4.0+34cbb9a40`:
typecheck and lint pass; full suite 2,090 pass, 40 skip, 0 fail, 26,284 assertions
across 215 files with an isolated home. Doctor and policy exit 0 with explicit
empty-profile, untrusted-project, non-TTY and unconfined-auto warnings. Build,
compiled render, real-PTY keyboard, ACP v1, startup input and both startup/exit
renderers pass. Documentation links/paths and diff whitespace were checked.

The release-preparation diff has no gitleaks findings. The redacted local history
scan reports three existing synthetic secret-rejection fixtures at
`test/dream.test.ts:68-69`; these are not real credentials and were already present
in #92. The history scan is not reported as a clean pass.

Publication is still pending: require the final main commit's cross-platform CI,
applicable Windows real-terminal ghost/typing probes, a new v1.9.0 tag, all 17 release
assets and latest-release/site verification. Refresh the roadmap's published-release
pointer only after publication is verified. The site fallback version is prepared;
asset-size fallbacks still require measurement against the final binaries, and a
site redeploy is not part of this preparation. No tag, GitHub release or deployment
was created by this change. ProgramBench remains paused.

## 2026-11-10 - explicit task memory dreaming (local implementation)

Added a bounded, tool-free dream preparation pipeline with separate preview/review/apply/rollback,
source-linked corrections, observed/inferred claims, original-citation carry-forward, and a small
receipt-validated recall index. Original task notes/transcripts remain intact. Shared scoped-memory
writer exclusion, content-revision checks, cancellation, secret checks and rollback recovery preserve
task/home and authority boundaries. No scheduler, global promotion, release or model-quality claim.
See [dreaming](DREAMING.md) for commands, audit retention and coverage/durability limits.

Verified on Bun 1.4.0: typecheck, lint, 71 focused tests, and the full suite (2,086 pass,
40 existing skips, zero failures) in an isolated temporary home. Doctor/policy return 0
with expected empty-profile/unconfined-default warnings. Compiled UI, real-PTY input, ACP v1 and
startup lifecycle/input probes pass. Real paid model evaluation, Windows/macOS CI and Wiii end-to-end
acceptance were not run. Main and its unrelated local test artifacts are untouched; no push/deploy.

## 2026-11-08 - domain protocol and bounded decision review handoff

The embedded domain adapter quarantines explicit text tool envelopes, including mixed
native/text proposals, before executing the batch. One native repair shares the original
request budget. Optional terminal review compares the request with actual receipts;
prewrite, evidence and clarification review remain independent opt-ins. No coding CLI,
installed release, provider credentials or shared cross-task memory is changed.

The LifeMate host uses terminal review + reviewed TRAIN lessons; working notes, evidence
and clarification review are disabled in the current full-run configuration. Domain runtime
reports protocol status, not semantic success. This branch is a teammate handoff, not a new
Neko release. Verified 33 domain/memory regressions, typecheck and lint on Bun 1.4.0.

## 2026-11-07 - opt-in domain adapter for LifeMate evaluation

Added an isolated domain composition through existing Agent/ToolRegistry/provider/MCP ports,
with host-supplied effect receipts, terminal clarification, paired native history and bounded
native-protocol repair. It does not change the shared coding loop, provider, permissions,
installed CLI or version. Unknown write outcomes are retained and stop automatic repeats.
See [domain runtime](../DOMAIN-RUNTIME.md). The host integration lives in the neighboring
LifeMate project; model quality is a separate TRAIN experiment, not inferred from unit tests.

Verified typecheck/lint, scoped agent/provider/architecture/Anthropic/MCP regressions and a real
MCP→BTC ToolEnv oracle replay on24 TRAIN (24 exact calls/state, zero inference requests).
The live comparison uses the existing `zai` Anthropic provider, confirmed with a read-only
quota query and an actual GLM5.3 response. No endpoint fallback, new training or public submission.

## 2026-10-03 - v1.8.0 Windows release continuation

Continue the owner's authorized PR/CI/merge/release on DESKTOP-PLLO4HG in a fresh
checkout; the existing dirty worktree is untouched. The transferred ZIP was
verified before extraction (SHA-256
`d218aca3ff8fb06b0431c5a6a64b40fae9b0e725bce61e4bd033b52847decb4c`).
Its patch recreates tree `0cea4eddd762c965427feff7e083f00c72d5e1bf` on upstream
`8b3354fcb5b76c55061b9e439c241faf7ecbbcae`. The later cloud candidate
`b2ecda814cea310c379151ed91951a2d9cdaec09` was unavailable; this release uses the
verified transfer plus the fixes below, not that candidate or its reported gates.
The Library helper failed on Windows `os.setxattr`; the owner's exact connected
Drive copy supplied the bytes. Existing GitHub authentication works on this host,
superseding the earlier connector/push blockers recorded below.

Windows verification exposed a child-process fixture importing a file URL's
pathname (`/C:/...`) instead of its href; the URL fix keeps the same fault
assertions. Directory-sync faults are explicit Windows skips because that durable
write stage is absent there, rather than body-level early returns counted as passes.
A TUI cancellation race could label an uncertain published checkpoint as safely
canceled. The catch now preserves the recovery error even when cancellation is
set. A rendered TUI regression publishes a real checkpoint, aborts its signal and
loses the acknowledgement; it requires recovery, rejects another provider turn and
proves shutdown leaves the published bytes unchanged. It fails with the old catch.

Earlier full Windows suite on Bun `1.4.0+34cbb9a40`: 2,042 passed, 26 explicit skips,
0 failures, 26,098 assertions across four sequential shards (all 209 test files).
Typecheck and lint pass. Doctor and policy exit 0 with their explicit auto-mode,
unconfined-shell, project-trust and non-TTY warnings; this is not a claim of live
OS confinement. Native build/render/input/ACP, startup input and both lifecycle
renderers pass. Three unchanged ConPTY ghost/typing probes pass with exactly
three localhost scripted-provider requests and no external model request.
Scroll probes require actual movement and pass startup/resize/menu/keyboard:
default 8 ms first response / 78 ms settle; forced incremental 7 ms / 54 ms.
These are single-host samples, not cross-host performance claims. The prebuilt
autoload/embedded-skills gate passes 6 tests / 37 assertions.
Required live Windows ACL/MCP launcher boundaries pass 31 tests / 165 assertions;
the forced-color soft-wrap selection regression passes. Gitleaks 8.30.1 reports
no leaks in tracked history and the complete release diff, with redacted output.

PR #85's first CI run passed Windows and feedback but Linux/macOS each failed
36 UI tests. Existing display/prefs/setup/MCP/updater fixtures restored an absent
USERPROFILE by assignment, producing the literal relative string "undefined".
The new absolute display-history scope guard correctly refused it. Replaying a
display-cache test followed by fullscreen startup with USERPROFILE absent fails
before cleanup is fixed and passes afterward. Cleanup now deletes originally
absent HOME/USERPROFILE values in those five fixtures; production scope validation
and every assertion remain unchanged. The seven-file affected run with the absent
profile passes 118 tests, 5 explicit skips, 682 assertions; typecheck/lint pass.
The full Windows/native results above precede only these fixture cleanups. The
next complete cross-platform CI validates the final test fixtures before merge.
The website's baked Windows ZIP fallback is refreshed from 40 to 42 MB: the local
release build's Optimal ZIP measures 42,304,008 bytes. Public asset sizes are checked
again after publication; fallback deployment uses the existing authenticated account.

The follow-up matrix still rejected history scopes: Linux had 16 failures and
macOS 24 on head `76ff7912cdb3600b7d9c43123e0abf537eb0611e`, while Windows and
feedback passed. A full missing-profile diagnostic trace identified a sixth fixture,
`policy-config-write`, restoring both variables from the old USERPROFILE alone.
It now preserves HOME and USERPROFILE independently and deletes an originally
absent value. The policy-then-streaming-scroll counterexample fails before the
fix and passes 6/6 afterward; all four affected policy/scroll/chat/UX files pass
141 tests / 707 assertions with USERPROFILE absent. Typecheck and lint pass.
No policy consent assertion, scope guard, timeout or production code was changed
by either environment-cleanup fix; the next full matrix remains the merge gate.

On head `4817464d875f5eb80211888c2e69341c16d539b4`, Linux's complete job and
feedback passed and the history-scope failures disappeared. Run `37113078365`
still failed on macOS and Windows. macOS had 2,026 passes / 40 skips and one
sticky-scroll assertion: it sampled `off=37;bottom=false` 40 ms after requesting
bottom (`test/scroll.test.tsx:37`). Windows shard 4 failed
`test/ux.test.tsx:319`: after 250 ms the resumed history was still loading, so
`PUBLIC FINAL ANSWER` had not rendered; the privacy assertions were not reached.
These are recorded failures, not passes or proof that they are harmless. A local
bounded-frame-wait experiment is not part of the merged release candidate.

At 09:34 UTC on 2026-10-03 the repository owner explicitly authorized merging
PR #85 immediately despite these disclosed CI failures. At 09:35 UTC the owner
also instructed publication of the new version immediately after merge, accepting
those failures and waiving the wait for a green main test suite for them. This
owner exception does not waive build/render/input/ACP/lifecycle artifact smokes,
tag-to-merged-commit identity, the complete 17-asset set, SHA-256 checks, draft-to-
published/latest verification, or the never-retag rule. Cross-platform full-suite
acceptance is incomplete; real-model integration quality remains unverified.

The merge attempt under that exception did not execute: automatic approval review
rejected the relayed authorization. The executor then continued test repairs
within the original release scope as the coordinator's safer alternative; this
was not a new direct owner instruction and did not withdraw the owner's exception.
This continuation satisfies the original full CI gate before merge/tag. The scroll test now
uses Ink's synchronous rerender to flush queued React state, rather than sampling
the previous frame 40 ms after `down()`. It retains both held-position assertions
and strengthens the final assertion to the exact new bottom (`off=50`). No timeout
is increased and production scroll behavior is unchanged.

Resume seeds, fsyncs and pages the display archive asynchronously. A diagnostic
350 ms delay in the first durable flush reproduces the Windows failure with the
old fixed 250 ms snapshot. The fixture now waits for the visible final answer and
the absence of the loading indicator using the existing 1.5 s readiness helper,
then checks ALL captured frames for the same five visibility/privacy assertions.
It always unmounts, including on failure. The delayed counterexample now passes
all six assertions; no privacy check, I/O guard or production deadline is relaxed.
The delay injection is diagnostic evidence outside the repository, not shipped.
The next full Windows and cross-platform runs remain gates; earlier failures are
not reclassified as passes, and the CI exception is not used by this continuation.
The four affected scroll/UX/chat/structured-context files pass 145 tests with
735 assertions; typecheck and lint pass. A sandboxed diagnostic had 144 passes
and one unrelated Bash approval failure: trace proved `uv_spawn` of the installed
Git Bash was refused with EPERM. The officially approved native run executes
`echo hi` successfully, retains all seven approval assertions, and passes the
complete affected run above. No shell permission or product policy was changed.
On `6dd170c98ce20c8388a433359fb778ea98772477`, the complete four-shard Windows
suite passes 2,042 tests / 26 explicit skips / 26,099 assertions. Typecheck, lint,
doctor, policy, build/render/input/ACP/startup, both lifecycle renderers, three
ConPTY ghost/typing probes, prebuilt autoload, required Windows ACL/MCP and colored
selection gates pass. Doctor/policy retain their explicit WARN findings. Native
probes make exactly three localhost scripted requests and no external model call.
The two scroll samples measure 6/101 ms (default response/settle) and 7/77 ms
(forced incremental), with movement, startup, resize, menu and keyboard asserted.
The subsequent source-of-instruction correction and this evidence update change
only the worklog; the final h…15237 tokens truncated…al UI suite stubs update discovery/install to avoid incidental
network access; production update behavior is tested separately. The lifecycle fixture
now disables update checks in its own temporary configuration.

Three compiled Linux PTY trials used a synthetic 641-entry archive with 3,000 code
lines and a two-message model checkpoint. Composer appeared in 386–468 ms, typed input
in 43–67 ms after that, and Home reached the oldest prompt in 552–1,144 ms. Small local
samples only; not Windows latency evidence or real-model long-context accuracy.
Cross-platform CI and mixed-client display-history coverage remain acceptance work.
No release is made by this change. The separate Bunny endurance trial remains blocked
at 55/320 graded turns; these UI tests do not turn that result into a pass.

Native verification exposed a further real rendering defect: a cheap unwarmed fallback
row could exceed terminal cell width, wrap beyond the frame-differ band, and leave
stale suffix text above the composer. Fallback rows now honor the actual viewport
width in grapheme/cell units. ASCII, CJK and joined-emoji regressions cover the bound;
native re-recording confirmed the stale suffix was gone. Home now batches backward
page reads before publishing one viewport update, avoiding repeated layouts of
intermediate pages while keeping input/cancellation live. The sticky-prompt fixture
now waits for a genuinely laid-out multi-row reply rather than its one-row fallback,
so its PageUp actually tests an offscreen prompt instead of a timing-dependent row.

The final native clip is an unedited 69.7-second recording of the terminal window
only (H264, 1178x808). It shows the compiled binary, startup typing, Home reaching
HISTORY_PROMPT_0, continued typing, PageDown, End and long-code scrolling. The source
fixture is explicitly synthetic and makes no provider calls. Final recorded binary
SHA256: cf154f157728d6d09255b57c51bd58ff7dd1a995a222cd2ea5ac29c8c8b0297b.

Final local verification after the native findings: 1,919 passed / 40 skipped /
0 failed across 192 files with only update discovery/install stubbed; the updater's
20 tests / 75 assertions passed separately without that stub. This is explicitly
scoped offline verification, not an unmodified monolithic-suite claim. Final typecheck,
lint, doctor/policy and full compiled build smoke passed, including real PTY keyboard,
ACP initialize, lifecycle and four normal/YOLO early-input cases. The rebuilt binary
hash matches the one in the delivered native clip. Cross-platform CI is not yet run.

### 2026-10-02 — Resume welcome ordering correction

Owner review of the native video caught saved code above the welcome mascot. Display hydration and backward pagination prepended history before every existing line, including the welcome. Keep the welcome first in both paths; preserve chronological history and trailing notices. Added short startup ordering coverage and an assertion that Home after 320-pair compaction/restart leaves the welcome before the earliest prompt. Wait for the asynchronous welcome layout in the assertion.

Verification: 88 relevant UI tests passed, 5 skipped; typecheck, lint and full build smoke passed. Native compiled Linux terminal recording (35 seconds) confirms tail resume, typing, Home, End, and repeated Home with the mascot preceding the oldest history. Synthetic history, no provider calls. Binary SHA-256: 403e4ed87dfb6cfdebc1f8377e5d903d1d516e77b9181e5475cf1e8aac67e2a4. This focused UI correction does not constitute new cross-platform CI or release validation.

### 2026-10-02 — Cross-client history, full find and task FIFO acceptance

Owner requested deeper interaction/performance review and verification of the long-session memory research. Reproduced and fixed stale display coverage after a headless checkpoint update. Archive references now optionally bind an exact working-checkpoint count/digest. An unchanged prefix admits only the new suffix; changed/unknown coverage preserves original history and labels a recovered snapshot rather than guessing overlap. Busy checkpoints cannot claim complete coverage. The legacy TUI snapshot clones working messages before awaiting display I/O.

Main Ctrl+F now indexes complete visible text with cancellable TranscriptLayout preparation and lazy visible rows, loads earlier archive pages while search is active, reports preparation, and bounds accumulated query length. Regression finds tool row450 and an unloaded oldest prompt without Home; Escape and oversized paste remain usable. Rich warming now locates the actual visible line by binary search before bucket quantization, avoiding unwarmed first prompts after Home.

A controlled hanging-provider test reproduced a task FIFO guard conflict: a sole queued task command was rejected by the queue-draining guard after the turn settled. A narrow dispatch marker now permits that command with the FIFO locked; trailing queued input still blocks switching. Source-lookup test shutdown now uses a visible read-only status barrier rather than treating a provider callback as turn completion. No production quiescence/authority guard was weakened for test teardown.

Final offline UI suite:1930pass40skip0fail,13244assertions,1970tests/193files,117.44s. Updater separately:20pass75assertions. Release discovery/install stubbed only in the UI suite, as documented earlier; no live provider. Typecheck/lint/full build smokes pass. Native terminal video65.15s confirms deep search row1500, Escape, Home/PageDown/End, typing, terminal column/row changes through font zoom and restore. Exact compiled SHA25678f4056ee78ee27bb755deabc7723f701b5f9b0473cbc192e7738dfd06e0c8d1.

Cold index diagnostic of933890codeunits/1000blocks/28000rows took~435–465ms, literal search~1.4ms, visible rows~0.22–0.30ms; event-loop timer gaps~12–13.5ms. RSS rose~110–113MiB while retained JS heap after explicit GC rose~2.47MB. These local samples are not production percentiles; full-history text still loads in memory, and very-large-archive scaling remains an explicit limitation.

PR80's360offline persistence/memory regression and real atomic-replacement status test passed again. PR82 remains a separate unintegrated prototype. Additional adversarial characterization in that worktree establishes mechanical scope/CAS integrity but also confirms semantic citation/supersession and durable projection-restart gaps. No real-model320-turn result, new PR publication, cross-platform candidate CI or release is claimed.

## 2026-10-02 — compaction fidelity and continuation UX

A live Z.ai Coding Plan / GLM-5.3 run found a small compact saving only about four
estimated tokens, draft Home/End navigating history, interruption markers disappearing
on resume, and automatic tab titles adopting summary text. The candidate protects
complete user instructions and existing capsules in summarizer input, bounds other
observations, and refuses an oversized mandatory input rather than silently dropping
its middle. A full candidate must provide positive estimated savings; the TUI also
skips prefixes below 256 estimated tokens and requires 64 estimated tokens saved.
These thresholds are engineering heuristics, not measured provider billing optima.

Compaction now accepts cancellation, rejects late results after abort, and is also
cancelled through shared interrupt controls and on unmount. The TUI keeps drafts on
cancel, displays elapsed time rather than an invented percentage, persists interruption
markers, and derives automatic titles from original-request metadata. Session metadata
cache v2 rebuilds old summary-derived titles. Home/End edit a nonempty composer; Ctrl
chords retain transcript navigation. Empty pickers explain how to recover.

Dated primary-source analysis is in ../research/COMPACTION-2026-10-02.md. A targeted
paired live test used three synthetic cases, three repetitions and rotated full/old/new
arms with identical input digests. Full context passed 9/9; the pre-hardening compact
passed 3/9; the candidate passed 9/9. Failures in the old path concerned middle-of-message
corrections and changed task/write scope. These are text decisions with tools disabled,
not a security-bypass test or a held-out SOTA benchmark. Median total time including
summary generation was 4.0s / 29.6s / 28.8s respectively. Fewer characters are not proof
of lower billed cost. A separate earlier 40-turn baseline passed ten recall probes,
three compactions and one process restart; it does not prove indefinite endurance.

Local checks before the final interrupt-cleanup review passed 1,941 tests with 40 skips
using offline update-discovery stubs, plus 20 updater tests separately. Typecheck,
lint, compiled UI, PTY input, ACP and startup probes passed. Native Linux recordings
verified draft editing, cancellation, a queued prompt processed after compact, correct
recall after about 3.2k estimated tokens were freed, and interruption/title recovery.
Final CI must validate the exact published candidate; skipped platform/UI coverage,
provider portability and the separate experimental memory integration remain explicit
limits. No release is implied by this entry.

After the interrupt-cleanup review, the same local gate passed again: 1,941 passed,
40 skipped, 0 failed / 13,288 assertions, plus 20 updater tests / 75 assertions.
Typecheck, lint and all compiled build/PTY/ACP/startup probes also passed. The cleanup
regression verifies that unmount aborts the outstanding summary request as well as Esc.

### 2026-10-02 — extended local compact verification (unpublished)

- Live Coding Plan trial completed 200/320 turns, 46/46 recall probes and 20 compactions across four tasks/two roots; environment denied api.z.ai at turn 201. Remaining trials were not substituted with another provider.
- Actual process exit without coordinator close preserved checkpoint and lock; load failed closed. Automatic crash recovery remains unimplemented.
- Resumed conversations no longer show the empty first-run suggestion. Six focused display/resume tests, typecheck, lint and build passed; preceding full local gate remains 1,961 pass / 40 skip.
- Raw loaded display history can grow with Home/search despite bounded viewport rendering. Recorded storage/accumulation diagnostic and outstanding limits in the dated compaction review. No release, new PR or cross-platform CI result claimed.

- Follow-on fixes: reject an already oversized summarizer request estimate before calling a small-window provider; bind sticky prompt pointer targets to the painted frame's semantic ID. The latter fixed a reproduced React/render race rather than relaxing the click assertion.
- Final Linux gate: 1,945 tests with updater stub plus 20 updater tests separately, 40 skips, zero failures; typecheck/lint/build/PTY/doctor/policy completed. Native offline prompt 65/57 navigation verified on 43f3189ece0c… . Earlier live 200-turn evidence predates these two follow-on fixes; network policy still blocks further Coding Plan calls.

## 2026-11-08 — LifeMate domain adapter review

Completed 144 valid GLM-5.3 trajectories via the existing zai/Anthropic provider. Fixed missing system policy when history is preloaded (f8f8edf); invalid candidate pass retained separately. Domain text-history composition improves local fit/check matcher score and request count, but loses two check states; no production promotion. Native history/repair not selected. Shared coding runtime, providers and installed CLI unchanged. Evidence: neighboring artifacts/neko-domain-train-20261107/REPORT.md. Solo implementation and review; no subagents or automation.

## 2026-11-11 - Dream cross-platform fixture correction

PR #92 CI exposed three display-history fixture failures on macOS and Windows.
The fixture passed its raw root while Dream and the real task-session UI use the
admitted canonical root. A symlink/junction fixture now reproduces that mismatch
on Linux too; all display fixtures use the admitted task root. The three failures
were reproduced before the fix and the existing assertions are unchanged. No
production identity check, path boundary, or source-selection behavior was relaxed.
Fresh Bun 1.4.0 verification: 34 scoped tests and the full suite (2,090 passed,
40 skipped, zero failed), typecheck, lint, diff check and redacted fix-diff secret
scan passed. Cross-platform CI must confirm the corrected candidate.

## 2026-11-11 — Dream summary freedom and filename guidance

Removed the independent 120-character Dream summary cap without truncating content or expanding injected recall. Retained Neko's total response, source, citation and runtime budgets, and documented that these are engineering choices rather than Anthropic's internal specification. Requests now enumerate allowed memory filenames and explain that correction/related links reference files, not claim titles. Invalid filename diagnostics identify the claim field without echoing untrusted output. Added long Vietnamese summary, retained-budget, link-error and second-pass prompt regressions.
