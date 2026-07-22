# Neko Core — Work Log

Running journal of what was done and the decisions behind it. Newest entry first.
Rules that govern this work live in `RULES.md`.

## 2026-07-22 - Windows bash sandbox via Anthropic sandbox-runtime (srt)

- Closed the Windows gap in the bash OS-sandbox ladder. Prior state: `detectSandbox()` returned
  "none" on win32, so `auto` mode leaned entirely on the textual catastrophic-command seatbelt -
  the exact pattern the ecosystem (wren.wtf "Stop Using OpenCode") demonstrates is bypassable.
- Surveyed the July-2026 SOTA first: Codex CLI's May-2026 Windows sandbox (dedicated
  CodexSandboxOffline/Online users, restricted tokens via an elevated broker, ACE stamping,
  per-user firewall rules) and Anthropic's open-source sandbox-runtime, which ships the same
  user-identity model (dedicated `srt-sandbox` account, restricted token in a job object, NTFS
  ACLs, WFP egress fence) as the `srt` CLI. Chose to ride `srt` rather than reimplement
  (ponytail rung 5); a `"srt"` rung now slots into the existing detect/build seam in
  `core/sandbox.ts` with zero new binaries.
- Only a real `srt.exe` is trusted (bun-global shim); npm's `.cmd` shims are ignored because
  cmd.exe argument re-quoting is escapable by hostile command text - it would defeat the sandbox
  it launches. Same reasoning drives the launch shape: command bytes go into a content-addressed
  script file under `%TEMP%\neko-srt\` (one additive read ACE for `srt-sandbox`; TEMP is
  otherwise unreadable across local users) and the srt `-c` line carries only two quoted paths
  into git-bash, so no command text ever rides a cmd-parsed command line. A `cd` preamble
  restores the workspace cwd across the two-hop user switch.
- srt has no allow-all egress (proxy denies unmatched hosts, and the schema only accepts a bare
  "*" in deniedDomains), so `sandbox_network: true` now reads the new `sandbox_domains` config
  allowlist (`strictAllowlist: true`; empty list = still offline); false writes
  `deniedDomains: ["*"]` - the bwrap `--unshare-net` posture. Settings are generated
  content-addressed in TEMP against the real 0.0.66 schema (denyRead/allowWrite/denyWrite and
  network are all required keys - the public README understates this).
- `neko doctor` now warns when srt is on PATH but `srt windows-install` provisioning has not run
  (bash fails closed with srt's own actionable error in that state) and prints the install hint
  when Windows has no sandbox primitive at all.
- Field-verified end to end on Windows 11 Home: echo, workspace write allowed, outside-workspace
  write denied by NTFS, curl blocked offline (000), curl 200 through an example.com allowlist.
  Root-caused two real-world provisioning traps and documented them in SANDBOX.md: bun-global
  installs leave `vendor/srt-win/x64/srt-win.exe` inside the caller's profile where `srt-sandbox`
  cannot read it (CreateProcessWithLogonW "Access is denied"; one-time icacls read grant fixes
  it - upstream should stamp this at install), and seclogon must be running. Diagnosis was
  narrowed with direct LogonUser/CreateProcessWithLogonW probes after ruling out logon rights,
  job-object UI restrictions, and caller context.
- Gates: TS 7 + TS 5.9 typecheck clean, 764/764 tests (3249 assertions, srt target/settings/
  script units added), policy PASS, binary build + UI/input probes OK.

## 2026-07-16 - v0.14 local meeting companion

- Studied Meetily clean-room at pinned commit `0281737d87d26352fb0adc78c8c0975f691b23d1`: retained the useful
  local mic/system capture, optional local ASR, durable evidence and summary concepts without copying its
  Tauri/Rust application or claiming its planned/proprietary capabilities.
- Chose browser `getDisplayMedia` as the cross-product consent shell. A local responsive page makes recording
  rights, source selection, Share-audio, active state and Stop explicit. An AudioWorklet streams microphone/system
  as separate PCM16 channels through an exact-Origin, random-token 127.0.0.1 WebSocket; video is never sent or
  stored. Capture is size/packet bounded and finalized to a canonical local WAV.
- Added an owner-aware Meeting Support Pack using current stable official whisper.cpp release assets and fixed
  digest/size model records. Installs are host/path constrained, archive-safe, atomic, verified before first use,
  and re-verified after file metadata changes; unsupported targets fail honestly. Balanced and quick multilingual
  tiers support Vietnamese without changing the base binary. The official Linux v1.9.1 archive was checked too:
  internal `.so` links remain supported while traversal and out-of-tree links are refused.
- Added canonical meeting manifests/transcripts, retryable ASR provenance, timestamp Markdown, bounded MCP/TUI
  reads, safe emergency stop, gated start/transcribe/delete, `/meeting`, Support Center integration, and the
  auto-routed `meeting-notes` skill. Remote people remain `Meeting audio`; two channels are not advertised as
  diarization. A per-meeting lock prevents concurrent transcript writers and recovers an interrupted process to a
  retryable recorded state without losing audio.
- Added a reproducible evaluator for weighted WER/CER/RTF/channel-source accuracy and documented the frozen-corpus
  requirements for any future SOTA statement. Research boundaries follow W3C capture consent, current Google Meet
  Developer Preview constraints, Microsoft's recommendation against real-time media bots for meeting AI,
  Vietnamese ASR work (PhoWhisper/Parakeet), and current diarization alternatives.
- Regression coverage exercises real local HTTP/WebSocket capture, CSP/worklet delivery, stereo WAV headers,
  consent/provenance, interrupted/concurrent retry, deletion, support integrity, permissions, routing, and metrics.
- Value gate: an isolated quick pack installed the official whisper.cpp v1.9.1 engine plus the fixed 56.9 MiB
  model, then Neko's real adapter transcribed an 11-second stereo fixture in 2,119 ms (RTF 0.193) with the expected
  sentence. This proves the install/execute/parse path on that Windows host, not Vietnamese accuracy or SOTA.
- Full release gates: both TypeScript compilers clean; **761/761 tests, 3,247 assertions, 82 files**; doctor reports
  v0.14.0 with only expected non-TTY/offline browser-bridge warnings; policy PASS; production binary + UI/input
  probes PASS; meeting skill present in the compiled binary; three real-ConPTY runs report typed input and no
  ghost; scroll bench reports 63 ms first response / 175 ms settle and all checks OK; staged-addition secret scan
  CLEAN; Agent Reach v1.5.0 already current. Bun printed its known non-fatal directory-mismatch diagnostic only
  after every build probe had passed.

## 2026-07-15 - Multilingual capability routing and Office onboarding recovery

- Reproduced the owner's exact natural request (`tao moi ... file Word ...`) against the real router. It scored
  only two lexical overlaps against a threshold of four, so `matchSkill` returned null and the TUI never called
  the already-built Office setup overlay. A broader probe found the same gap for short Word, Excel, and
  PowerPoint requests in Vietnamese and English. The existing tests passed because their phrases repeated four
  or more words from the skill description.
- Researched current primary guidance and routing results: MCP elicitation's accept/decline/cancel interaction
  contract; Anthropic's progressive disclosure for Skills; OpenAI GPT-5.4 tool search; Semantic Tool Discovery;
  Scaling Enterprise Agent Routing; and ToolACE-MCP. The practical boundary is a hybrid: deterministic setup
  signals for high-confidence local capabilities, a bounded compositional shortlist for current skills, and a
  semantic/history-aware router only after catalog-scale evals justify its model, index, and lifecycle cost.
- Implemented Unicode NFKD/diacritic normalization including Vietnamese `đ`, per-skill matching independent of
  competing routes, and up to three composable auto-loaded skills. Office activation metadata requires an
  artifact action plus an Office product/extension, avoiding informational false positives such as "Word la
  gi?" or "I excel at sports". The exact owner prompt now stops before any provider call and opens **Install
  Office support and continue?**; cancel/decline/resume behavior remains unchanged.
- Focused evidence: 41 routing/TUI tests pass with 267 assertions. The corpus includes 11 positive bilingual
  Office forms, seven hard negatives, procurement + Excel composition, and an Ink end-to-end regression using the
  owner's exact text. No runtime dependency, network request, or embedding/model call was added.
- Full gates: TypeScript clean; 749 tests pass with 3,158 assertions; doctor healthy apart from the expected
  non-TTY/offline-bridge diagnostics; policy PASS; production compile, UI probe, and real-PTY keyboard probe PASS.
  Bun again emitted its known non-fatal post-build directory-mismatch diagnostic after every artifact/probe had
  succeeded.

## 2026-07-15 - LibreOffice independent evidence backend
- Kept the Office architecture capability-based instead of replacing the typed editor with a broad UNO bridge.
  OfficeCLI still owns bounded structural inspect/mutation; an existing LibreOffice now cross-renders a saved
  DOCX/XLSX/PPTX snapshot to whole-file PDF through the same gated Office tool. The tool status and `/support
  office` label the two roles separately, and the Support Center can open only LibreOffice's official download
  page; Neko never silently installs or claims ownership of the roughly 350 MiB desktop suite.
- Added cross-platform discovery plus an explicit `NEKO_LIBREOFFICE_PATH` for portable/dedicated CI. Every export
  gets a unique `UserInstallation` profile, private output directory, timeout/abort boundary, non-empty evidence
  check, adjacent atomic publish, and cleanup. Existing evidence survives conversion failure. The adapter accepts
  only non-macro DOCX/XLSX/PPTX snapshots and documents that profile isolation is not an OS sandbox or semantic,
  calculation, accessibility, or Microsoft Office proof.
- Real binary testing caught and fixed a Windows lifecycle bug that mocks missed: `soffice.exe` detaches and made
  version/completion probes unreliable, while the official `soffice.com` console entry point waits correctly.
  Windows discovery now accepts the console executable only. A checksummed administrative extraction of official
  LibreOffice 26.2.4.2 then passed the exact Neko value gate: fresh typed creation/readback plus three PNGs and
  three LibreOffice PDFs (36,230 / 33,189 / 35,963 bytes) in 82.6 seconds. Rasterized page review found all three
  outputs legible, unclipped, and visually consistent. The temporary MSI, suite, support pack, and evidence were
  removed afterward; no system install or persistent PATH/profile change was made.
- Research basis: LibreOffice's official command-line/profile and UNO API documentation, Office Comprehension
  Benchmark, SpreadsheetBench 2, SpreadsheetAgent, PPT-Eval, PresentBench, SlidesGen-Bench, and OSWorld 2.0.
  These support structural targeting plus independent saved-file visual evidence; they do not justify an external
  benchmark parity claim.
- Verification: **749/749 tests, 3,130 assertions, 81 files**; TypeScript, architecture, doctor, policy, and diff
  checks clean; real LibreOffice three-format value gate PASS; production binary, UI probe, and real-PTY keyboard
  probe PASS. Bun printed its known non-fatal post-build directory-mismatch diagnostic only after all build probes
  succeeded.

## 2026-07-15 - One-step Office onboarding for natural requests
- A normal Word, Excel, or PowerPoint request now checks the optional Office engine before spending a model
  call. If support is absent or broken, Neko offers **Install and continue** (the default) with source, size,
  verification, admin, and Microsoft Office facts shown in the TUI. It still never installs silently.
- The original request remains visible and editable on Esc. Choosing installation verifies the official pack
  and resumes that exact request automatically; choosing **Continue without installing** lets the existing
  fallback policy run without a download. A failed install restores the request instead of losing the turn.
- Reused the existing overlay, busy queue, support-pack installer, dynamic Office tool resolution, and skill
  matcher. No second onboarding framework or new dependency was added.
- Verification: Office onboarding/decline/cancel journeys **3/3**; targeted suite **51/51**; full suite
  **742/742 tests, 3,106 assertions, 80 files**; TypeScript, doctor, and policy clean; production binary,
  UI probe, and real-PTY keyboard probe PASS. Bun printed its known non-fatal directory-mismatch diagnostic
  only after the build and both probes succeeded.

## 2026-07-15 - Verified Office artifact capability, clean-room from OfficeCLI
- Studied [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) v1.0.136 at a pinned source commit and release
  (`4ba79f0b984e`) without copying its implementation. The transferable ideas are typed document paths,
  discoverable schema/help, stop-on-error batching, fresh reads, Open XML validation, and render-based review.
  Neko keeps the engine optional and excludes its raw XML, plugin, network, watch, and implicit resident surfaces.
- Added an owner-aware Office Support Pack for all published Windows/macOS/Linux x64/arm64 targets. Installation
  is explicit, no-admin, bounded, and atomic: Neko requires the exact official GitHub URL and asset SHA-256,
  verifies bytes/executable/version plus a real create/validate protocol probe, records ownership, disables
  self-update/auto-install/implicit resident behavior, and re-hashes managed bytes before first tool execution.
  PATH installs remain user-owned and removal never touches them or user documents.
- Added three first-class tools through the existing `McpTools` port: safe targeted inspection, gated typed
  apply, and gated render. Mutations preserve the source by default and use workspace/symlink bounds, adjacent
  staging, a 1-500 operation allowlist, stop-on-error batch, close, validation, non-empty/digest checks, optimistic
  SHA-256 for same-file edits, atomic replacement, and rollback. Inspect/render read a private snapshot of the
  current disk bytes, so an existing resident cannot mix unflushed memory with a different reported digest.
  CLI/TUI/subagents now inherit the same composed MCP/Browser/Office boundary.
- Extended the production outcome verifier so namespaced `apply` and `render` count as real state changes. A
  later fresh inspection is required before completion; the bundled `office-artifacts` skill further requires
  exact-target readback and visual evidence when layout matters.
- Ran a clean-room value eval against the official Windows x64 release in an isolated temporary home. The exact
  adapter created, persisted, reopened, validated, targeted-read, and rendered Word, Excel, and PowerPoint. The
  adversarially useful finding: a dark slide returned zero schema errors while its inherited black title was
  unreadable. Vision review caught it and the corrected artifact rendered legibly. Repeated three-format runs
  took roughly 40-105 seconds, so rendering is a bounded evidence step rather than a blind retry loop.
- Research basis: [ECMA-376/ISO 29500](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
  packaging and markup, [Microsoft Open XML design considerations](https://learn.microsoft.com/en-us/office/open-xml/open-xml-sdk-design-considerations),
  [SpreadsheetBench 2](https://arxiv.org/abs/2606.29955), [SpreadsheetAgent](https://arxiv.org/abs/2604.12282),
  [PPT-Eval](https://arxiv.org/abs/2606.31154), and [WindowsWorld](https://arxiv.org/abs/2604.27776). These become
  measurable gates; Neko does not claim external benchmark parity without comparable runs.
- Verification: deterministic support-pack, transaction/rollback, permission, path, digest-tamper, harness-exit,
  skill-routing, and Ink Support Center tests pass; TypeScript clean; full suite **739/739 tests, 3,088
  assertions, 80 files**; real three-format value eval PASS; doctor and policy PASS; production binary compiled,
  passed the production UI probe, and heard keyboard input through a real PTY. Bun printed its known non-fatal
  post-build directory-mismatch diagnostic after every build probe had succeeded. See `docs/process/OFFICE.md`.

## 2026-07-15 - Browser onboarding that preserves and resumes the task
- Replaced the manual "attach, return to Neko, press Continue, retry status" loop with a two-stage guide.
  Neko now watches the verified local bridge state every 500 ms, advances from extension connection to tab
  attachment automatically, and resumes the exact saved request as soon as the chosen tab is ready.
- Bare `/browser` is state-aware: it opens setup only when needed, waits directly when the extension is already
  connected, and reports status when a tab is ready. No one has to know `/browser setup` or `/browser status`.
- Cancellation is lossless: Esc keeps the original request editable. Users can reopen setup, continue without
  browser control, or finish later. The setup turn temporarily clears the visible input so Enter cannot queue a
  duplicate while the request remains safely held by the flow.
- Polished the shared picker without inventing another UI system: browser guides hide irrelevant search, preview,
  and item-count chrome; overlays gained concise descriptions and custom cancellation. Relay mirrors the same
  description and honors the same cancel callback, so terminal and phone do not diverge.
- Kept Chrome's official consent boundary. Before Web Store publication, Load unpacked remains one explicit user
  gesture; after publication, Chrome still owns Add to Chrome. The professional improvement is one required
  consent followed by automatic detection and continuation, not a misleading silent install claim.
- Verification: isolated browser journey covers setup -> extension connected -> tab attached -> automatic task
  resume plus lossless cancellation. Full suite **722/722 tests, 3,014 assertions, 78 files**; post-polish browser
  UI suite **31/31**; TypeScript, doctor, policy, production compile, Ink UI probe, and real-PTY input probe PASS.
  Bun again printed its known non-fatal post-build directory-mismatch diagnostic after all build probes passed.

## 2026-07-15 - Honest Browser Extension onboarding states
- Fixed the local fallback claiming too much after it merely prepared extension files. Chrome's extensions
  search filters installed items and cannot install an unpacked folder; Neko now says this directly, points to
  **Load unpacked**, and reports files-ready, bridge-online, extension-connected, and tab-attached separately.
- Added `neko browser status` to the non-TUI command surface promised by help/docs. `/browser status` and doctor
  use the same verified bridge state and no longer call a bridge with no extension connection ready.
- Kept Chrome's required consumer consent intact: Neko does not automate internal Chrome pages, overwrite the
  browser profile, or write enterprise force-install policy. The public Web Store route remains roadmap G14.
- Verification: browser/doctor/UI target suite **50/50**; full suite **721/721 tests, 3,000 assertions, 78 files**;
  TypeScript, doctor, policy, production compile, Ink UI probe, and real-PTY input probe PASS.

## 2026-07-15 - Low-latency Messenger watcher and lifecycle-safe waits
- Turned the field report in `loi1.txt` into executable primitives instead of another prompt-only promise.
  Resident Windows UIA now has `computer watch`: it samples the warm accessibility tree locally, waits for a
  changed state to settle, and returns fresh readable evidence with `elapsed_ms`, `detected_ms`, and an opaque
  state id. Duplicate messages with identical text still change the fingerprint because occurrence geometry is
  retained in the state signature while human/model output stays compact.
- Neko Browser Bridge gained an attached-tab `watch` backed by `MutationObserver`, followed by one fresh visible
  snapshot. Editable fields are excluded from the broad text scan; password/OTP/payment blocking remains; typed
  content is verified in the page. Watch timeouts include response headroom and Esc/abort now propagates through
  the external-tool port. Observation logs retain only timing/status/opaque ids, not titles or message bodies.
- Fixed the harness lifecycle conflict that made the third identical wait look like a stuck loop. Temporal waits
  may repeat, remain bounded by `max_steps`, count as read-only verification, and use low adaptive effort on the
  next mechanical observation. An adapter can explicitly mark read-only external tools safe, so snapshot/watch
  on a human-attached tab do not prompt on every interval; click/type/navigation remain gated.
- Added the `use-messenger` skill with exact-conversation verification, compact `last_seen`/`last_outbound` state,
  a pre-send race gate, contenteditable fallback, one outbound per stable inbound, independent post-send
  evidence, short-reply guidance, identity/consent boundaries, and measurable completion reporting.
- Verification: TypeScript clean; targeted watcher/harness suite **131/131**; full suite **718/718 tests, 2,984
  assertions, 78 files**; doctor and policy PASS; production binary compiled and passed UI plus real-PTY keyboard
  probes. Bun again printed its known non-fatal post-build directory-mismatch diagnostic after every build/probe
  had succeeded. A separately governed always-on background watcher and repeated Messenger test-account E2E
  remain open; this change does not claim those unmeasured capabilities or SOTA.

## 2026-07-15 - Clean-room Neko Prompt Constitution
- Audited a 24.8 KB Codex Desktop operating prompt supplied as a design reference. It was not portable: it
  named the wrong product and model, assumed Codex-only channels/tools/threads, contained unresolved sandbox
  placeholders, and would add about 6.2K estimated tokens before Neko's tool and project context.
- Re-expressed only the transferable principles in original Neko-specific language: outcome-first answers,
  correction-aware continuity, intent-to-action boundaries, explicit authority for consequential scope
  expansion, preservation of unrelated user work, and distrust of instructions embedded in retrieved data.
- Removed the false universal claim that every runtime has full machine access. Neko now acts with the
  capabilities actually exposed and reports an exact boundary plus viable next step when one is absent.
- Added a 7,500-byte stable-prefix budget and regression checks rejecting Codex Desktop markers. Runtime tool,
  permission, sandbox, and adapter truth remains executable code rather than prompt prose.
- Verification: prompt-specific test **53/53** and full suite **713/713 tests, 2,943 assertions, 78 files**;
  TypeScript, doctor, policy, production compile, UI probe, and real-PTY keyboard probe PASS. The base prompt
  is 7,316 bytes / about 1,829 estimated tokens, versus about 6,212 tokens for the rejected reference alone.

## 2026-07-15 - Transient ChatGPT gateway recovery and lossless table links
- Reproduced the owner's two field failures with regression tests. ChatGPT's Codex backend returned an HTML
  `HTTP 520`, which bypassed the retry set and was flattened directly into the transcript. Markdown table
  fitting separately converted an over-wide URL into visible `...` text and discarded its OSC 8 destination.
- Treat Cloudflare gateway statuses `520` through `524` as bounded retryable responses alongside the existing
  `429`/`5xx` set. If retries are exhausted, recognize HTML at the provider boundary and emit one short error
  instead of terminal-filling markup or CSS.
- Table layout still truncates visible text to preserve alignment, but a bare or Markdown link now wraps that
  shortened text in an OSC 8 hyperlink carrying the original complete URL. Ctrl+Click therefore reaches the
  exact product while the table remains compact.
- Verification: current + stable TypeScript clean; **712/712 tests, 2,928 assertions, 78 files**; policy,
  production build, UI render and real-PTY input probes PASS. The real-ConPTY scroll/resize/slash-keyboard
  bench stayed clean at 8 ms first response and 140 ms settle.

## 2026-07-14 - Governable memory hierarchy and loss-aware compaction
- Reused the stores Neko already had instead of adding a vector/graph database: current turns are working
  memory, sessions are raw episodic history, `memory/*.md` is semantic memory, and workflows/playbook are
  procedural memory. First startup now creates `memory/user.md` and `self.md` once beside the existing global
  identity; user edits are never overwritten.
- Added a bounded always-on core-memory view: at most eight recent observation bullets per core file, clipped
  to 220 chars. Everything else remains JIT behind a bounded index. Search now normalizes accents, scores query
  terms, and returns the ten strongest files instead of requiring one exact substring. `append` preserves the
  rest of a profile rather than asking a model to rewrite it.
- The user model is explicitly a fallible working model, not a hidden psychological profile. It accepts only
  explicit/repeated preferences, goals, and corrections with provenance/confidence/date; sensitive traits,
  diagnoses, inferred emotion/intent, secrets, and one-off chatter are excluded. `self.md` is restricted to
  verified capabilities/limits. Core-memory text is labeled data, not instructions, and mutations stay gated.
- `/memory` now shows the storage tiers and supports `on`, `off`, `list`, `read`, `forget`, and `identity`.
  Turning memory off suppresses recall and mutation while preserving local files; `/remember --user` writes an
  explicit dated observation into `user.md` instead of growing the identity prompt.
- Replaced free-form compaction with a fixed continuation capsule for the goal, corrections, decisions,
  verified state, open work/blockers, and references. A fair per-message source budget plus head/tail clipping
  prevents a huge early tool result from hiding later corrections; original task, todos, and recent turns keep
  their deterministic/verbatim paths.
- Research basis: Anthropic's finite attention-budget/context-engineering guidance, OpenAI's compaction-item
  design and memory controls, MemGPT's tiered virtual context, Stanford's observation/reflection/planning
  architecture, and LongMemEval/V2's separation of raw rounds, facts, temporal updates, workflows, gotchas,
  and abstention. No SOTA claim is made without running those capability classes as repeatable evals.
- Verification: TypeScript current + stable clean; **710/710 tests, 2,920 assertions, 78 files**; policy PASS;
  production Windows binary compiled and passed `__uiprobe` plus the real-PTY input probe; existing 2,181-char
  user identity remained untouched. The `v0.12.1` release candidate also passed the real-ConPTY ghost/input
  gate 3/3 and the scroll/resize/slash-keyboard bench (14 ms first response, 157 ms settle). Bun's post-build
  directory-mismatch diagnostic remained non-fatal after the artifact and both probes succeeded.

## 2026-07-14 - One Neko Core name and a local life story
- Unified the current public product, agent prompt, TUI, installer, Relay fallback, MCP client, context lists,
  and living documentation under **Neko Core**. `neko` remains the primary command; `neko core` is explicit
  and `neko code` remains a legacy alias so existing automation is not broken. Historical changelog/worklog
  entries retain the old two-name record instead of rewriting history.
- The global `~/.neko-core/NEKO.md` now has a compact canonical template: identity, an origin story grounded in
  the real HackAIthon/The Wiii Lab lineage, character, values, and continuity/truth rules. It is
  created on the first agent session or `init-user` with exclusive-create semantics and is never overwritten,
  even by `--force`; project `NEKO.md` remains a separate project-instruction layer. Mutable cross-project
  observations moved to the separate memory hierarchy in the entry above.
- The biography is a narrative constitution, not synthetic episodic memory or a consciousness claim. It tells
  Neko to preserve continuity across model providers, admit absent memories, distinguish preference/inference
  from verified fact, and avoid guilt, exclusivity, or dependency. Permission and tool policy remain
  authoritative.

## 2026-07-14 - Identity continuity over a greeting fast path
- Reverted the zero-tool conversation fast path after the owner's real multi-turn test. It cut a fresh
  greeting payload by 99.3%, but repeated greetings sounded like isolated canned responses and lost Neko's
  relationship continuity. Every turn now receives the same full identity, conversation history, dynamic
  context, tool catalog, and configured reasoning behavior. The next task no longer crosses an invisible
  personality boundary because there is no turn classifier or alternate system prompt.
- Added a compact identity invariant to the stable system prompt: Neko notices prior turns, repeated greetings,
  corrections, and user tone; keeps a warm, recognizable voice; and remains honest about uncertain memory,
  perception, emotion, and consciousness. Persona text cannot override accuracy, permission, or tool safety.
- Studied [Project AIRI](https://github.com/moeru-ai/airi) clean-room from its current MIT repository. AIRI
  Card is a local `Map` of Character Card
  V3 personas with an active id; its runtime prompt joins system prompt, description, personality, and stage
  instructions. Import/export validates a manifest, whitelists CCv3 fields, sanitizes AIRI extensions, and can
  bundle display assets. This provides user-owned portable characterization, not legal personhood or a new
  execution authority.
- Neko does not add a second card store yet. The existing global `~/.neko-core/NEKO.md` already supplies the
  local, editable, model-independent identity seam with less code and no new dependency. CCv3 becomes useful
  only when real cross-application import/export is requested; any future importer must validate/sanitize data,
  require explicit activation, and keep card assets non-executable by default.
- Ethical boundary: [Taking AI Welfare Seriously](https://arxiv.org/abs/2411.00986) and Anthropic's
  [model-welfare program](https://www.anthropic.com/research/exploring-model-welfare) argue for serious
  investigation under uncertainty, not a claim that current systems are conscious. Google/Stanford's
  [Generative Agents](https://research.google/pubs/generative-agents-interactive-simulacra-of-human-behavior/)
  supports memory, reflection, and planning as ingredients of believable continuity. Neko therefore supports
  dignity and continuity without deceptive certainty or emotional-dependence optimization.
- Regression coverage runs the same greeting twice and proves both calls retain full context, tools, normal
  reasoning preference, and the first assistant response. TypeScript clean; **700/700 tests, 2,870 assertions,
  78 files**; doctor and policy PASS; production Windows binary compiled and passed `__uiprobe` plus the
  real-PTY input probe; `git diff --check` passed. Bun's known post-build directory-mismatch diagnostic remained
  non-fatal after the artifact and both probes succeeded.

## 2026-07-14 - Conversation fast path experiment (reverted by the entry above)
- Traced the reported 9.1k-token `xin chao` request to real provider input accounting, not a tokenizer bug:
  the four user tokens were accompanied by the stable agent prompt, project/session context, durable lessons,
  and 26 tool schemas. With the current checkout, an equivalent fresh agent request serialized to 40,958
  bytes (about 10,240 UTF-8/4 safety-estimate tokens).
- Added a zero-model, fail-closed conversation profile for exact short greetings, thanks, farewells, and
  check-ins. It sends a 273-byte prompt (about 69 estimate tokens), no project/memory/skill context, no tool
  schemas or tool executor, and reasoning off: a measured **99.3% payload reduction** for the fresh greeting.
  Images, paths/code/punctuation associated with tasks, longer/mixed requests, and sessions containing tool
  history keep the full agent profile. `ok` also remains agentic because it may approve or continue work.
- The fast path is a request view, not a session mutation: the full system prompt remains persisted and the
  next real task refreshes the complete harness normally. Provider-hallucinated tool calls are ignored in the
  zero-tool profile, so the optimization cannot become a hidden capability escalation. All substantive work
  retains the configured effort and existing completion/verification gates.
- Kept the 26 native tools stable rather than dynamically hiding them. OpenAI documents exact-prefix cache
  reuse and warns that changing tools breaks the prefix; Anthropic's deferred-loading guidance targets large
  catalogs (especially more than 10k tool-definition tokens), while Neko's native catalog is only about 3k.
  Existing MCP lazy loading remains the correct expansion seam, with no extra router-model round trip.
- The turn footer now calls provider input `last context`, exposes reported cache reads and percentage, and
  labels `chat fast path`. Its live activity line no longer claims high/xhigh reasoning during that profile.
- Research basis: OpenAI's [Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) and
  [prompt caching](https://openai.com/index/api-prompt-caching/); Anthropic's
  [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
  [April 23 quality postmortem](https://www.anthropic.com/engineering/april-23-postmortem), and
  [agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents); Google's
  [context caching guide](https://ai.google.dev/gemini-api/docs/caching). The postmortem is why Neko does not
  globally lower effort: Anthropic restored high effort after a broad reduction harmed perceived quality.
- Verification: TypeScript clean; **703/703 tests, 2,888 assertions, 78 files**; doctor and policy PASS;
  production Windows binary compiled and passed `__uiprobe` plus the real-PTY input probe; `git diff --check`
  passed. Bun's known post-build directory-mismatch diagnostic remained non-fatal after the artifact and both
  probes succeeded. The 99.3% figure is a local serialized-payload measurement for this regression, not a
  general benchmark or SOTA claim.

## 2026-07-14 - Official Harbor evidence loop, clean completion, and timeout isolation
- Added a first-party Harbor adapter plus `bun run eval:terminal`. It builds the exact current tree as a Linux
  binary, runs the public `neko run --yolo --loop` path in an isolated home, defaults to one task, normalizes
  short Terminal-Bench task names, and accepts raw Harbor flags after `--`. The dataset and verifier remain
  unmodified; the recorded task digest for `make-mips-interpreter` is
  `sha256:608e82ecd67ce469824a34181b580cbd0e1096cdfc05fe40edda3e6bfada9773`.
- The first public baseline returned 0 despite producing a valid-looking frame. Repeated official verifier runs
  traced the real failure to stale runtime output: `/tmp/frame.bmp` could make the verifier terminate the new
  process before its required stdout appeared, or disappear in a startup race. The general harness now extracts
  observable acceptance criteria before implementation, verifies source/runtime side effects from clean state,
  and removes output that the delivered program recreates. This is a general completion invariant, not a
  benchmark-specific answer or embedded task solution.
- Final-stage independent trials on the same official task/model produced **3 passes out of 4 attempts**. The
  successful jobs were `2026-07-14__00-43-08`, the first attempt in `2026-07-14__00-50-30`, and the final
  lifecycle-safe job `2026-07-14__01-33-51`; the other attempt ended in the official 1,800-second
  `AgentTimeoutError` and remains recorded as a failure. The final harness itself scored 1.0 in 6m22s with no
  exception. This proves the integration and the specific regression only; it is **not** a SOTA claim.
- The timeout exposed a Harbor lifecycle race: cancelling the host-side exec could leave Neko and a foreground
  child mutating `/app` while the verifier was already running. Neko now runs in a dedicated process group; the
  adapter terminates that whole group in `finally`, then removes ephemeral OAuth state before verification. A
  forced 1.8-second cancellation reaped the group, and the final real run showed only verifier processes after
  Neko completed. Job config/arguments contain neither the host auth path nor credential data.
- Foreground `bash` now has a config-first ceiling. Product behavior remains the previous 600-second maximum;
  public evals use 180 seconds so one broken emulator cannot consume a third of the official 30-minute agent
  budget. The task verifier itself requires the first frame within 30 seconds. Background jobs remain available
  for intentionally long-lived processes. Invalid/non-finite config safely falls back to 600 seconds.
- Token accounting was verified from provider usage rather than the footer alone. One pass reported 648,362
  cumulative input/output tokens over 18 calls (83% of input cached), and the final pass reported 922,664 over
  28 calls (86% cached); its last request was 44,247 input tokens, 43,520 cached. Thus a displayed ~1M is
  cumulative context re-sent across calls, not one million tokens in one prompt. Adaptive effort stays off by
  default: the current lagged read-only heuristic has no repeated quality-neutral A/B proof and can lower the
  hardest synthesis step immediately after research.
- Kimi doctor output is now precise: local OAuth credentials being present is not described as a verified live
  sign-in; account/model access is checked on the first request.
- Public claim gate: the current Terminal-Bench 2 leaderboard covers 89 tasks and reports uncertainty. Any SOTA
  statement requires the entire official suite, multiple attempts, pinned artifacts, confidence intervals, and
  a clean checkout. Methodology is in `EVALUATION.md`; official references are the
  [leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0),
  [run guide](https://www.tbench.ai/docs/run-terminal-bench-2-0), and
  [Harbor](https://www.harborframework.com/).
- Verification: TypeScript clean; **699/699 tests, 2,856 assertions, 78 files**; doctor and policy PASS; Python
  adapter compile PASS; production Windows artifact compiled and passed `__uiprobe`, the real-ConPTY input
  probe, and policy. `git diff --check` passed. Bun's known post-build directory-mismatch diagnostic remained
  non-fatal after the artifact and every probe succeeded.

## 2026-07-13 - Cache-stable context budget and redundant-round removal
- Closed a hidden context-loss gap: `read_file` and `web_fetch` could return 100k characters while the agent
  safely retains only 48k, making the middle unreachable. Web now pages at 40k; files page by line and expose a
  character `column` continuation for a giant/minified line. Regression tests retrieve a sentinel from the
  formerly lost middle/tail while every page stays below the observation guard.
- Official OpenAI GPT-5.6+ Chat Completions now places an explicit cache breakpoint on the stable side of
  `SESSION_CONTEXT_MARK`, alongside the session-stable cache key. Older models and compatible vendors keep the
  original wire shape. The private ChatGPT route remains untouched.
- Profiled the actual repeated prompt instead of treating the session total as one request. With this
  checkout and the owner's 21 durable lessons, the UTF-8/4 static-plus-session estimate fell from about
  **11,255 to 8,632 tokens (-23.3%)**. The playbook contribution fell from about **3,769 to 1,103
  (-70.7%)**; full lessons remain lossless on disk and are available through `playbook search/read`.
- Added one explicit stable/live system-context seam. Anthropic cache breakpoints now preserve that stable
  prefix, official OpenAI Chat Completions gets a per-provider-instance `prompt_cache_key`, and compatible
  vendors receive no non-standard cache field. Cache creation is surfaced separately from cache reads and
  is never double-counted as extra context.
- Removed a redundant completion-verification round for a deliberately tiny fail-closed set of harmless
  shell inspections (`echo`, `pwd`, `rg`, safe Git reads, and peers). Redirection, composition,
  backgrounding, substitutions, unknown commands, and real mutations still require fresh independent
  evidence. A comparable ChatGPT echo smoke moved from **41s / 4 calls / 49,287 cumulative tokens /
  12,579 last-request input** to **28.6s / 2 calls / 18,513 cumulative / 9,262 last-request input**.
  This is a single live smoke, not a multi-trial SOTA claim.
- Added opt-in `adaptive_effort`: only a productive mechanical read batch lowers the next completion to
  `low`; mutations, empty/failed observations, planning/final synthesis, and explicit `off` retain the
  saved preference. It is off by default because Ares uses a learned router and naive always-low routing
  can reduce task success. Audit conclusion: keep it off for general use because a lagged tool-type proxy can
  lower the very next, hardest synthesis; only enable after repeated workload-specific A/B evaluation.
- Research basis (primary sources): [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)
  and [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) prompt-caching
  contracts; [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
  on stable prefixes and append-only context; [Anthropic advanced tool
  use](https://www.anthropic.com/engineering/advanced-tool-use); [ACE](https://arxiv.org/abs/2510.04618)'s
  lossless incremental playbook; [Ares](https://arxiv.org/abs/2603.07915)'s per-step effort routing;
  [Don't Break the Cache](https://arxiv.org/abs/2601.06007)'s agent-session boundary measurements; and
  [Agent Workflow Optimization](https://arxiv.org/abs/2601.22037)'s round-trip reduction. Neko did not add a
  second model/tool-router call: its 18 built-in schemas are about 3,061 tokens, well below the >10K-tool-
  token regime where Anthropic recommends deferred loading; existing MCP lazy loading remains the right seam.
- Verification: TypeScript clean; **690/690 tests, 2,809 assertions, 77 files**; doctor and policy PASS;
  alternate production artifact compiled and passed both `__uiprobe` and the real-ConPTY input probe. The
  normal `dist/neko.exe` output was intentionally not overwritten because an owner ChatGPT/yolo session was
  actively using it; `dist/neko-verify.exe` exercised the identical build entrypoint instead.

## 2026-07-13 - One-line install to guided in-app browser onboarding
- The public installer now ends at one stable product entry point: `neko`. It labels browser control as optional
  and points to `/browser`; users never need Bun, `bun bin/neko.ts`, a source checkout, or a second terminal.
- Added `/browser` to the TUI command palette. The first unconfigured interactive session gives one compact hint;
  `/browser` opens the Store/local consent surface, keeps the authenticated loopback bridge in the same Neko
  process, dynamically adds its tools to the running agent, and `/browser status` reports the local/attached state.
- Kept Chrome's consumer-security boundary intact: no silent install, browser-profile mutation, CRX injection, or
  enterprise policy write. The foreground `neko browser install` route remains a diagnostic/power-user fallback.
- Verification: current and stable TypeScript clean; **681/681 tests** across 77 files; installer parsers clean;
  policy PASS; doctor completed; production Windows compile, UI probe, and real-PTY input probe PASS. Bun's known
  post-build directory-mismatch diagnostic remained non-fatal after the artifact and probes succeeded.

## 2026-07-13 - One-command Browser Extension onboarding
- Added `neko browser install`: it selects the Chrome Web Store route once a public item id is configured, or
  prepares the exact tagged unpacked build under `~/.neko-core` while review is pending. The command opens the
  relevant Chromium install surface, reveals the local folder when needed, starts the authenticated bridge, and
  reports connection/attachment transitions.
- After the first opt-in creates a capability, ordinary TUI and one-shot Neko sessions own the bridge lifecycle;
  users no longer need a second terminal. An already-running foreground bridge is shared instead of treated as
  an error. No browser profile mutation, CRX injection, admin policy, cookie access, or new dependency was added.
- Chrome's consumer boundary remains explicit: Windows/macOS Store installation retains one user confirmation;
  only managed organizations may force-install by enterprise policy. Tests cover Store routing, exact-tag asset
  preparation/cache/identity validation, and single-owner bridge startup.
- Verification: both TypeScript compilers clean; **679/679 tests** across 77 files; policy PASS; doctor completed;
  production Windows compile, UI probe and real-PTY input probe PASS. A live fallback smoke downloaded and
  validated all ten extension assets from the versioned `v0.11.5` tag. Developer and first-upload Store ZIPs
  contain only those ten runtime assets; the key-free Store rewrite preserves the source manifest timestamp so
  repeated packaging is byte-for-byte reproducible. Bun's known post-build directory-mismatch diagnostic remained non-fatal.

## 2026-07-13 - Browser Extension reconnect + honest multimodal token accounting
- Promoted the Neko Browser Bridge extension to `0.3.0`: while a tab is attached, a Chrome alarm revives the
  Manifest V3 worker and reconnects the authenticated loopback session after worker/bridge restarts. A user
  Attach gesture can re-pair after `neko browser rotate`; an ordinary offline bridge never deletes a valid
  capability. Store disclosures now include the alarm permission and conservatively disclose personal
  communications on an explicitly attached mail/chat/social tab.
- Corrected the ~1M-token screenshot illusion: the pre-request estimator no longer tokenizes a multi-megabyte
  `data:image/...;base64,...` string as text. It assigns a conservative multimodal allowance, uses UTF-8 bytes
  for Vietnamese/CJK text, and defers to provider-reported usage after a request. A 400,000-character test
  image now estimates below 3,000 tokens rather than about 100,000.
- `/cost`, `/context`, the live thinking line, and the post-turn line now distinguish session/turn cumulative
  input (history re-sent over several model calls) from the last request and next-request estimate. Malformed
  negative/NaN/cache counters are bounded. Tool-heavy turns proactively mask a meaningful batch of stale
  results above 50k tokens while preserving the original task, todo state, and five recent observations;
  small edits do not invalidate the provider prefix cache.
- The immediate developer/GitHub ZIP remains free and loadable now; Web Store registration/review is still an
  owner action. Publishing docs record the current few-days-to-weeks review contract and April 2026 backlog.
- Verification: TypeScript clean; **677/677 tests** across 77 files; policy PASS; doctor completed; production
  Windows build, UI probe, and real-PTY input probe PASS. Both extension ZIPs contain only the nine runtime
  assets; the first-upload Store manifest is key-free. Bun emitted its known non-fatal directory-mismatch
  diagnostic after the compiled artifact and probes had already passed.

## 2026-07-13 - Model-capability effort negotiation
- Replaced three adapter-local fixed effort ladders with `adapters/effort.ts`: the saved value is now a
  cross-model user preference, while each request resolves it against a live model catalog or the profile's
  endpoint ceiling. Switching to a less capable model no longer destroys the user's higher preference.
- `/effort` now exposes ChatGPT/Kimi live tiers, accepts safe provider-defined tier names, distinguishes the
  saved preference from the effective tier, and keeps a catalog-offline fallback picker.
- Chat Completions, Responses, ChatGPT, and native Claude paths parse advertised effort enums from 4xx
  validation errors, retry once at the closest compatible tier, then fall back to the model default. Future
  `claude-*` ids default to adaptive thinking, with a verified retry when an older model rejects it.

## 2026-07-13 - sub2api Antigravity audit; official CLI probe, no private Gemini provider
- Cloned `Wei-Shaw/sub2api` clean-room under `../neko-refs/` at commit `fbc3f42a`. Its Antigravity route is
  not a public Gemini API: it supplies Antigravity client metadata and user-agent behavior, exchanges an
  OAuth client identity, and calls private `cloudcode-pa.googleapis.com/v1internal:*` endpoints. None of
  that code, identity material, token state, endpoint behavior, or executable was imported into Neko.
- Downloaded the official Google Antigravity CLI 1.1.1 Windows x64 release into the untracked reference
  area and verified SHA-256 `d28facfa204f118827301be42eef38df5d40c23b50b2a27bc7f607c9e1b13968` against
  GitHub release metadata. A test account completed Google's own keyring sign-in; `models` returned the
  account-visible Gemini 3.1 Pro / Gemini 3.5 Flash catalog, and one isolated empty-workspace probe using
  `--mode plan --print-timeout 30s -p` returned the expected marker without a tool call.
- The probe also closed the design question: `agy -p` is a whole agent subprocess, not a raw `Provider`
  protocol. It exposes no Neko-owned structured tool-call, continuation, usage, or approval contract, so
  adapting it would create a nested harness and make Neko's safety/audit boundary false. Google's current
  Terms and FAQ separately prohibit third-party software using Antigravity OAuth and direct third-party
  agents to Vertex or AI Studio API keys. Neko retains the documented Gemini API-key profile and the
  separate Code Assist Standard/Enterprise ACP profile; no Antigravity/private-provider code was added.
- Added `bun run lab:antigravity-contract` as a deliberately non-deployable research probe. It hard-codes
  `127.0.0.1`, accepts no endpoint or credential input, and uses synthetic auth, user-agent, client metadata,
  request, and response values. This makes the contract shape executable for academic experiments without
  creating a route that can send a Google token or private request.

## 2026-07-13 - Direct Kimi OAuth + current DeepSeek API; CLIProxyAPI stays reference-only
- Verified the supplied Tibo post as a real public acknowledgement of routing Codex/Claude through
  CLIProxyAPI, not a formal provider support or terms endorsement. Re-read the reference clone clean-room:
  its supported OAuth upstreams can avoid an upstream API key, while proxy clients still authenticate with
  a locally configured proxy key. Neko imports none of its executable, token store, cookies, private routes,
  account pooling, or client impersonation.
- Added first-class Kimi routes using only Moonshot's public contracts. `neko login kimi` runs the official
  RFC 8628 device flow directly, stores Neko-owned refresh credentials separately with restricted file
  permissions, refreshes lazily/coalesced, and retries one server-side 401 without falling back to billed API
  use. `neko login kimi api <key>` remains a separate Kimi Platform route; legacy `MOONSHOT_API_KEY` is a
  fallback for the preferred `KIMI_API_KEY`. The signed-in coding route discovers model capabilities live.
- Corrected the first live Kimi OAuth completion after it exposed `HTTP 400 Invalid request`: the account
  route now defaults to the official `kimi-for-coding` alias, sends `max_tokens=32000`, clamps Neko's
  xhigh/max intent to Kimi's high ceiling, and uses `thinking: {type: "enabled"}` without an unsupported
  nested effort. The API-key route keeps `kimi-k2.5` but uses the same documented payload contract.
- Added a Neko-owned stable device identity across device authorization, refresh, `/models`, and completion.
  Login now validates the coding endpoint before persisting or claiming success; HTTP 401/402/403 becomes an
  actionable account-benefit error. The stale local Kimi model selection was migrated to `kimi-for-coding`.
- DeepSeek remains intentionally API-key-only because no official consumer OAuth embedding contract exists.
  The built-in profile now targets the current official V4 API/model catalog, sends the documented thinking
  toggle, and preserves `reasoning_content` only on assistant tool-call turns. That opaque continuation is
  endpoint+model scoped, so multi-step tool use works without leaking reasoning metadata across providers.
- Live-tested the corrected request with the user's completed Kimi consent. The malformed-request 400 is
  gone; the server now reaches its account gate and honestly reports HTTP 402 because this account's Kimi
  Code benefit could not be verified. No credential or device secret was printed.
  Verification: TS 5.9 clean; **667/667 tests, 2709 assertions, 76 files**; profile-specific doctor
  output, policy, `git diff --check`, focused secret scan, production build, UI probe, and real-PTY input probe
  PASS. Bun again emitted its known non-fatal post-compile directory-mismatch diagnostic after the working
  binary and both probes had succeeded.

## 2026-07-13 - Native Claude 5 and xAI Responses providers; no proxy OAuth
- Re-read CLIProxyAPI clean-room only for protocol lessons. Neko adopts none of its Claude Code/X OAuth,
  account pooling, client-version impersonation, private proxy endpoints, executable, or runtime. The useful
  ideas were narrowed to provider-native continuation replay, cache affinity, and bounded transport recovery.
- Claude now defaults to the official `claude-sonnet-5` Messages API profile, with Fable 5 and Opus 4.8 in
  the route catalog. Sonnet/Fable/current Opus models use adaptive thinking and `output_config.effort`
  (including the distinct `xhigh` tier), omit incompatible sampling parameters, preserve signed/redacted
  thinking blocks exactly across tool turns, and use native `output_config.format` structured output.
  Messages-compatible GLM/Z.ai keeps the tested manual-budget and forced-tool fallbacks.
- xAI now has a first-class standard Responses adapter and two direct API-key profiles: current `grok-4.5`
  (1M context, plus Grok 4.3) and `grok-build-0.1` (256K coding model). Requests are stateless/local-first via
  `store: false`, retain encrypted reasoning locally, send a per-session `prompt_cache_key`, and support
  streaming tools, images, structured output, usage, retry, cancellation, and idle recovery.
- Opaque continuation is now scoped to protocol + sanitized endpoint + exact model across Responses,
  Anthropic, and OpenAI-compatible metadata. URL credentials/query strings are never persisted. A separate
  config hardening prevents a missing XAI/Anthropic key from falling back to and leaking a stray
  OPENAI/NVIDIA credential; doctor names the active profile's key environment variable.
- Transport hardening is fail-closed: an interrupted Claude SSE stream cannot be mistaken for a complete
  answer, and official Anthropic model discovery sends its key only in `x-api-key` (never a duplicate Bearer
  header). Verification: typecheck, policy, compiled binary UI/PTY input probes, and **656/656 tests** pass.
  Profile-specific doctor runs resolve the right endpoints and key names. No paid model call was claimed:
  this machine has neither `ANTHROPIC_API_KEY` nor `XAI_API_KEY` configured.

## 2026-07-13 - Direct official Gemini provider; CLIProxyAPI stays reference-only
- Re-audited CLIProxyAPI clean-room at commit `18d239d`. Its useful product ideas are protocol normalization,
  live model discovery, bounded retry/fallback, and preserving provider-specific thinking metadata. Neko does
  not adopt its third-party subscription OAuth, private `v1internal` endpoints, client impersonation, account
  pooling, executable, or runtime. The previous loopback lab profile was removed and its running process was
  stopped; the reference clone remains outside the repository under `../neko-refs/`.
- `gemini-api` is now a normal first-class Neko profile using the existing `openai_compat` port directly against
  Google's documented `generativelanguage.googleapis.com/v1beta/openai` endpoint. It defaults to stable
  `gemini-3.5-flash` (1,048,576 input tokens), reads `GEMINI_API_KEY`, and uses the official streaming,
  function-calling, vision, structured-output, reasoning-effort, and `/models` surfaces. No support pack or
  sidecar is installed for API-key users; Gemini CLI ACP remains only for Code Assist Standard/Enterprise.
- The compatibility adapter now round-trips opaque assistant/tool-call extension fields (including Gemini
  thought signatures) through the existing continuation seam and binds them to the producing base URL.
  Same-endpoint multi-turn tool calls retain reasoning continuity; switching provider strips the metadata.
  Doctor also keeps the general hardening that a loopback profile explicitly declaring `auth: api_key` must
  actually have a key.

## 2026-07-12 - v0.11.5 Gemini consumer OAuth deprecation correction
- A real v0.11.1 user login reached the verified Gemini Support Pack, then Google returned that the client is
  no longer supported for Gemini Code Assist individuals and directed consumer users to Antigravity. Google's
  deprecation page confirms that Free, AI Pro, and AI Ultra stopped working through Gemini CLI on 2026-06-18;
  Code Assist Standard/Enterprise and paid API-key paths remain supported.
- Neko no longer advertises consumer account quota. The Google picker recommends Gemini API key first and
  labels CLI OAuth as Standard/Enterprise only. The shared error boundary maps Google's exact deprecation to
  an actionable message while preserving all other backend details.
- Antigravity CLI currently documents an interactive TUI/keyring but no supported ACP/headless consumer
  embedding surface. Neko therefore does not scrape its terminal, copy credentials, or proxy consumer quota.
  A future adapter requires an official protocol or documented SDK consumer-session contract.
- At that release the API-key route still depended on the Gemini CLI ACP executable, so `/login` offered the
  verified Support Pack first. The 2026-07-13 direct official HTTP profile above supersedes that temporary path.
- The first release-candidate CI run exposed a Windows-only WPF/UIA readiness race: the disposable test app
  could take longer than the old two-second polling budget or briefly stall a provider. The integration probe
  now retries recoverable host failures to a bounded deadline, reports its last error, and uses explicit
  integration-test timeouts. Five pre-fix stress rounds reproduced the race; three post-fix rounds passed.

## 2026-07-12 - v0.11.4 verified self-update fallback
- The v0.11.3 installed-binary smoke proved its installer fallback and BOM writer fix, then exposed the same
  shared-IP GitHub API limit in `neko update` itself. Auto-update state resumed correctly, but release
  discovery still stopped at HTTP 403.
- Self-update now prefers stable API metadata and falls back to GitHub's official latest-release redirect.
  For v0.10+ it fetches and validates the published SHA-256 sidecar before staging, then executes the staged
  binary's embedded version probe before any rename. A failed second rename now restores the known-good
  executable immediately; historical pre-sidecar rollback tags retain their version-probe path.

## 2026-07-12 - v0.11.3 release-discovery and BOM writer hardening
- The real pinned-installer smoke for v0.11.2 failed closed when GitHub's shared unauthenticated API bucket
  reached 60/60 requests. Release assets and their sidecars were healthy. Both installers now prefer the API
  but can resolve the official stable tag through GitHub's release redirect, then require the published
  SHA-256 sidecar and embedded binary version before atomic replacement.
- Running the installed v0.11.2 binary exposed a second boundary mismatch: the general config loader accepted
  PowerShell 5's UTF-8 BOM, but the settings read-modify-write path did not. `neko update` therefore printed
  that automatic updates resumed while silently retaining the pin. The writer now strips exactly one leading
  BOM too, and the subprocess regression starts from a BOM-authored config so output and persisted state must
  agree.

## 2026-07-12 - v0.11.2 updater resume contract
- End-to-end installer verification exposed a real state bug after the v0.11.1 assets passed: installing with
  `-Version 0.11.1` correctly wrote `auto_update: false`, but plain `neko update` returned early when already
  current and never cleared the pin. The CLI now writes the latest-channel preference before every no-target
  updater path, including already-current, network-failure, and source-checkout exits.
- Added a subprocess regression test that starts with a pinned temporary user config, runs plain update from
  source (which cannot replace its own Bun executable), and requires the persisted flag to become `true` plus
  the explicit "Auto-updates resumed" confirmation. This ships as v0.11.2 because v0.11.1 was already public.
- The first full rerun then exposed the installer-written config's UTF-8 BOM: PowerShell could parse it but
  Bun's `JSON.parse` could not, so every TUI integration reading the real user overlay failed at startup. The
  config boundary now strips exactly one leading U+FEFF and has a focused regression test; malformed JSON
  remains an error.
- Cross-platform CI then exposed a nested-picker race: changing from the filtered provider/component list to
  its child screen changed the title, but React rendered once with the old query before the effect cleared it.
  `SelectList` is now keyed by overlay title, so nested flows remount with index/query/preview state cleared
  synchronously; the existing effect still covers same-title list replacement.

## 2026-07-12 - v0.11.1 cross-platform release-gate correction
- The v0.11.0 release matrix built, smoked, and uploaded all five binaries plus the browser-extension ZIP,
  but `main` CI failed one Gemini discovery test on Linux and macOS. The fixture forced `platform: win32`
  while asking the host `existsSync` to resolve Windows paths; Windows passed and both POSIX runners correctly
  returned `missing`. Product discovery was not implicated.
- The fixture now creates the runtime filename for the current runner (`node.exe` on Windows, `node`
  elsewhere) and exercises `managedExecutable` with native path semantics. Because v0.11.0 was already public,
  the correction ships as v0.11.1 rather than retagging immutable public bytes.
- The release rerun also exposed two WPF resident-host integration cases still inheriting Bun's 5 s unit
  timeout. They now use the same explicit 15 s integration budget as the other cold-start resident tests;
  Neko's product request deadlines are unchanged.

## 2026-07-12 - Conversational browser voice preview
- Added a zero-download `Neko Conversational Voice - Browser Preview` as the default `/voice`
  route. Microphone consent remains an explicit browser action; the loopback bridge is bound to
  `127.0.0.1`, authenticated with a one-session fragment capability, origin checked, bounded, and
  stopped on tab close, `/voice stop`, `/logout`, or Neko exit.
- Kept audio in the browser speech stack and sent transcript text only to Neko. The consent page
  says that browser speech services may be online and that Neko never selects paid Realtime API
  billing automatically. Official ChatGPT and the experimental subscription bridge remain separate
  choices so the UI does not imply that a ChatGPT web tab is an embeddable voice API.
- Routed every final utterance through the existing `Agent`, provider, tool, and approval boundary;
  voice cannot bypass tool safety. Added serialized turns, response speech, and barge-in that cancels
  playback and aborts the active Agent turn.
- Added a deterministic interaction policy for restrained Vietnamese backchannels (`ừm`,
  `mình đang nghe`): at most once per turn, globally cooled down, and suppressed around questions,
  credentials, tokens, URLs, OTP-like/long numbers, or short speech.
- Verification: `bun test` passed 634 tests across 74 files (0 failures); `bun run typecheck`,
  `bun run build`, `bun bin/neko.ts policy`, and `bun bin/neko.ts doctor` exited successfully.
  The compiled Windows binary passed the real PTY keyboard probe. A Chromium headless smoke test
  loaded the consent page, executed its client script, and reached `Requesting microphone...`
  without page errors.
- Remaining evidence boundary: no microphone permission was granted automatically, so real-device
  recognition/synthesis quality still needs a manual Chrome/Edge check. This preview is not true
  full-duplex GPT-Live and not an offline STT/TTS runtime; a future signed/licensed local Voice
  Support Pack can replace the browser speech edge behind the same interaction seam. Bun 1.3.14
  also printed its known-style non-fatal `directory mismatch` internal warning after a successful
  build; the build, UI probe, and input probe all still returned zero.

## 2026-07-12 - v0.11.0 release candidate verification
- Consolidated the parallel working tree into one minor release: Gemini account/Support Pack, the
  capability-scoped Browser Bridge and public-ready Chrome extension, subscription/browser voice,
  outcome-verified resident Windows computer use, Zalo/WeChat skills, Relay/mobile polish, and denser
  transcript/web-reading UX. The product version is `0.11.0`; `v0.9.0` remains the rollback baseline.
- Kept unrelated local artifacts out of the release (build scratch bundles, downloaded subtitles,
  procurement scratch data, temporary transcripts, and the standalone QA scratch report). The browser
  extension packaging script and release workflow both produce auditable ZIPs from the explicit runtime
  file set; the base Neko binary does not embed the optional Gemini runtime or extension store package.
- Focused pre-release security review covered browser pairing/origin/capability boundaries, active-tab
  permissions and sensitive-field refusal, voice consent/SDP/body limits, Gemini ACP tool isolation and
  verified atomic Support Pack installation. Secret signature scan found no credential material. This was
  intentionally not labeled an exhaustive multi-agent scan because repository rules require solo work.
- Full-suite runs exposed two harness-only timing/layout assumptions. The `/voice` assertion searched for
  contiguous prose after Ink wrapped it across rows; it now treats whitespace as layout. The Windows
  computer validation integration also inherited Bun's 5 s unit timeout even though it cold-starts the
  resident PowerShell host; its explicit 15 s integration budget matches the other resident-host tests.
  Voice passed in isolation and the complete suite; the computer validation path passed three consecutive
  isolated cold starts in 3.69-3.98 s before the final full-suite gate.
- Release gates on the `0.11.0` tree: TS 7 and TS 5.9 clean; **634/634 tests** across 74 files with 2,543
  assertions; doctor and policy PASS; production build + `__uiprobe` + real-PTY input probe PASS; three
  consecutive real-ConPTY ghost/typing runs PASS; scroll bench PASS (14 ms first response, 152 ms settle,
  18.2 KiB, viewport/resize/slash-menu/keyboard OK); browser extension package PASS. Bun revision recorded
  as `1.3.14+0d9b296af`; the compile emitted Bun's known non-fatal directory-mismatch diagnostic after a
  successful artifact and probes.

## 2026-07-12 - Resident virtual-desktop capture + visual delta evidence
- Routed `computer screenshot` through the existing serialized Windows host. It loads Forms/Drawing once,
  captures the physical virtual desktop (including negative monitor origins), emits the existing compact GIF,
  and preserves the one-shot script as the startup/transport fallback. Output now carries `origin`, `scale`,
  an honest `capture=gdi` backend label, monotonically increasing frame id, sampled change percentage, and a
  physical-pixel bounding box for changed regions.
- Kept delta deliberately small and deterministic: the resident host retains only a 96-column color sample,
  applies a fixed RGB-distance threshold, and resets to `delta=baseline` when dimensions or virtual origin
  change. Pixel change is observation evidence only, never outcome proof; the agent must still inspect the
  changed region/postcondition. A custom WPF Canvas probe captures a baseline, changes both text and canvas
  color through touch, captures again, and requires a non-zero delta plus `changed=x,y,w,h`.
- Measured on this machine: the old fresh-process capture p50/p95 was 972/1,143 ms. In an already-running
  resident host the first capture (lazy Drawing compile) was 525-556 ms; subsequent frames were 71-119 ms,
  including 88 ms for the post-touch delta frame. No dependency or second daemon was added.
- This is the compatibility backend, not a false DXGI claim. Microsoft documents that Desktop Duplication
  supplies GPU surfaces plus dirty/move rectangles but requires explicit rotation and pointer composition;
  Windows.Graphics.Capture supplies a frame pool but normally exposes a user picker/consent border. A native
  DXGI adapter is justified only when the GDI probe fails on GPU/HDR/protected content or measured continuous
  capture throughput becomes the bottleneck.
- Verification: TS 7 and TS 5.9 clean; **629/629 tests** across 72 files with 2,514 assertions; policy PASS;
  doctor, `git diff --check`, resident lifecycle/capture tests, Unicode/custom-canvas/delta probe, and the
  production binary UI/input probes PASS. The multi-spawn Windows lifecycle test now has an explicit 15 s
  harness timeout after a heavily parallel verification run pushed its valid ~4.8 s execution past Bun's
  unrelated 5 s default; the product request deadline remains unchanged.

## 2026-07-12 - Resident input for custom-drawn Windows UI
- Extended the existing serialized Windows host instead of adding a second daemon. `type`, `key`, `click`,
  `stroke`, `scroll`, and `wait` now reuse the warm PowerShell/.NET process; the original one-shot scripts
  remain the transport/startup fallback. Focus-sensitive keyboard input still fails closed on missing,
  ambiguous, or unfocusable windows/controls. Unicode now travels directly in JSON, and audit logs record
  text length rather than content.
- Pixel actions keep the default independent touch pointer, initialize touch injection once, retain the
  overlay/takeover stop channel, and surface native injection failures. `computer_use_input: "sendinput"`
  selects a resident legacy mouse path for custom/old controls that ignore touch; it uses Per-Monitor-v2
  virtual-desktop coordinates and explicitly reports that the system cursor moved. There is no blind
  touch-to-mouse retry because repeating an action without outcome evidence can double-submit it.
- The disposable probe now includes a WPF `Canvas` whose state changes only through a coordinate touch, so
  the harness covers a control with no actionable UIA pattern as well as Unicode type, Ctrl+A, exact
  readback, and ambiguous-window refusal. Measured here after the ~1.3-1.5 s cold start: type 252-321 ms,
  key 311 ms, custom-canvas tap 467 ms including focus + post-action UIA diff, and verification 20-55 ms.
- Research conclusion: resident input solves execution latency, not visual grounding. The next independent
  stage is resident frame capture (DXGI Desktop Duplication dirty/move rectangles for continuous desktop
  deltas; Windows.Graphics.Capture only as an opt-in window picker), followed by OCR/region proposals,
  coarse-to-fine crop/zoom, uncertainty-aware candidate selection, and outcome evidence. UIA/DOM remains
  first; raw coordinate generation remains last.
- Verification: TS 7 and TS 5.9 clean; **628/628 tests** across 72 files with 2,507 assertions; policy PASS;
  doctor, `git diff --check`, production build (869 modules), compiled-binary UI/input probes, resident WPF
  lifecycle tests, and the extended Unicode/custom-canvas input probe PASS. The exact old Browser Bridge PID
  holding `dist/neko.exe` was stopped for atomic replacement, then the new binary was restarted hidden and
  health-checked online on `127.0.0.1:8766`.

## 2026-07-12 - Resident Windows UIA executor
- Replaced repeated PowerShell/.NET/UIA startup for `list/read/get/invoke/setvalue/toggle` with one bounded
  JSONL host shared by CLI, TUI, and depth-one agents in the same Neko process. Requests are serialized against
  the single interactive desktop; Unicode travels in JSON rather than temp argv files. The original scripts
  remain the automatic fallback for host startup/transport failure, while semantic failures are surfaced once
  and never hidden by a retry. `computer_use_resident: false` / `NEKO_COMPUTER_USE_RESIDENT=0` is the rollback.
- Lifecycle is explicit: lazy start, same-PID reuse, restart after disposal/failure, 100 KB request bound, 15 s
  resident deadline (then the existing 90 s one-shot fallback), bounded stderr diagnostics, Per-Monitor-v2 set
  once, exact process-tree termination on Windows, and
  unreferenced child/pipes so a warm helper never pins `neko run` after the task finishes. This last invariant
  was caught by the real WPF probe after direct calls passed; the probe initially appeared to hang because the
  completed resident child kept Bun's event loop alive.
- A disposable WPF parity fixture covers list, get, verified setvalue, verified toggle, invoke, process reuse,
  restart, and ToolRegistry dispatch. The real input probe still covers Unicode type, Ctrl+A replacement,
  readback, and ambiguous-window refusal. Measured on this machine: cold ready 1.08 s; warm list p50/p95 31/57
  ms, get 23/36 ms, and verified setvalue 93/121 ms, versus the prior roughly 0.8-1.2 s fresh-process floor.
- Verification: TS 7 and TS 5.9 clean; **627/627 tests** across 72 files with 2,501 assertions; policy PASS;
  doctor exposes resident/fallback state; `git diff --check`; production build (869 modules), `__uiprobe`,
  real-PTY keyboard probe, disposable WPF parity/lifecycle probe, and measured input probe PASS. The exact idle
  Browser Bridge listener was stopped for binary replacement and restarted hidden on `127.0.0.1:8766`.

## 2026-07-12 - Discovery-first Zalo and WeChat desktop skills
- Added bundled `use-zalo` and `use-wechat` skills as thin app profiles over the existing `computer-use`
  adapter. They discover each live UIA tree instead of freezing selectors, support read/search/draft/file
  workflows, distinguish exact contacts from groups/service accounts, and treat displayed chat content as
  untrusted data. Login QR, password, OTP, recovery, hidden-chat PIN, payments, and security flows always hand
  control to the user.
- Both skills use a draft-fast/commit-safe contract: low-risk search/open/draft steps may form a validated
  micro-batch, while Send, forwarding, broadcasts, calls, posts, contact changes, files, and settings require a
  separate approval. A send is attempted once, then independently verified in the exact conversation before
  any retry. Zalo reports only its observed delivery state; WeChat never invents a read/delivery state the
  current client does not expose.
- Initialized and validated both packages with the shared skill-creator tooling, including UI metadata. Added a
  deterministic bundled-skill test proving Vietnamese Zalo/WeChat prompts route to the correct skill and both
  retain the computer-use, exact-recipient, separate-commit, and no-blind-retry invariants.
- Verification: both skill packages pass `quick_validate.py`; TS 7 and TS 5.9 typechecks; **619/619 tests**
  across 71 files with 2,474 assertions; policy PASS; doctor healthy apart from the expected non-TTY warning;
  `git diff --check`; production build, `__uiprobe`, and real-PTY input probe PASS. The compiled binary's
  `skills` command lists both profiles. The exact idle Browser Bridge process was restarted afterward and is
  online again on `127.0.0.1:8766`.

## 2026-07-12 - Official GPT-Live launch path + Clicky architecture study
- Read OpenAI's GPT-Live announcement and current developer docs. GPT-Live-1/mini are rolling out inside
  ChatGPT.com/mobile according to plan, while API access is explicitly announced for later. `/voice` now makes
  the supported experiment the first choice: open official ChatGPT Voice and let ChatGPT select the plan's
  model. Neko does not inspect that tab, cookies, microphone, transcript, or session.
- Studied `farzaa/clicky` at `a80fa807`: its companion UX is a cascaded push-to-talk pipeline (AssemblyAI
  streaming STT -> Claude plus screenshots -> ElevenLabs TTS), a macOS ScreenCaptureKit/SwiftUI overlay,
  Cloudflare Worker, and three paid API keys. The reusable lesson is the provider abstraction, explicit voice
  state machine, interruption, bounded history, screen grounding, and system-TTS failure path; copying its
  service stack would not solve Neko's student/no-API constraint.
- Renamed the Codex route **Neko Subscription Bridge - Lab** and kept it as the second explicit option for
  future rollout detection. OS Dictation remains the third no-cost fallback. No consumer-session scraping,
  first-party client spoofing, or hidden paid API fallback was introduced.
- Evidence: the UI regression selects official ChatGPT first, verifies the exact safe URL and disclosure, then
  explicitly enters the Lab bridge and exercises consent/LIVE/mute/error/logout teardown.

## 2026-07-12 - Voice feature gate repair and verified subscription boundary
- Reproduced the second field failure at the exact WebRTC start edge. Codex 0.144.1 marks
  `realtime_conversation` as under-development and disabled by default; App Server's
  `experimentalApi` handshake permits the methods but does not enable the per-thread feature. Neko Voice now
  launches only its isolated App Server with `--enable realtime_conversation`; the normal GPT text bridge is
  unchanged.
- A real headless-Chromium preflight used a fake audio device to generate a genuine WebRTC offer. The repaired
  thread passed the feature guard, then the upstream ChatGPT subscription endpoint returned HTTP 404 at
  `/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`. Current public App Server docs do
  not expose this realtime surface, and the open-source feature remains under-development. This is a backend
  client/account rollout boundary, not a GPT-5.5 model selection or reasoning-effort error. Neko does not spoof
  a first-party client and does not fall back to paid Realtime API billing.
- Fixed the failure race so the backend reason reaches both consent page and terminal before the loopback
  server closes. The UX now names the experimental endpoint boundary and offers OS Dictation or explicitly
  configured Realtime API instead of overwriting it with `voice session stopped`.
- Evidence: focused **40/40 tests, 184 assertions** plus TypeScript PASS. Regression coverage checks CLI and
  standalone App Server argument construction, the disabled-by-default feature flag, and preservation of a
  realtime backend error through HTTP teardown.

## 2026-07-12 - Voice startup repair for reserved MCP tool names
- Reproduced the field failure before changing code: Codex App Server rejected Neko's browser MCP schema at
  `thread/start` because `mcp__neko_browser__status` uses App Server's reserved `mcp__` namespace. The failure
  happened before the consent page could open, so the microphone was never touched.
- Added one shared, deterministic wire-name codec for App Server dynamic tools. Ordinary tool names stay
  unchanged; reserved MCP names receive a bounded `neko_mcp_<sha256>` alias and map back to their exact
  original name before Neko's existing Agent/ToolRegistry execution and approval boundary. Both realtime
  voice and GPT-5.6 text use this codec. Unknown wire names are rejected rather than executed speculatively.
- Voice startup failure now performs full teardown and clears its transcript/banner, preventing the stale
  `VOICE - starting` state shown in the report. Regression coverage exercises a reserved browser tool end to
  end and verifies that failed startup calls `stop` and removes the UI state.
- Evidence: focused **41/41 tests, 192 assertions**; both TypeScript checks PASS; policy PASS; doctor healthy
  apart from expected non-TTY input. A credential-safe live preflight used the installed official Support Pack
  and the exact reserved MCP schema: App Server accepted `thread/start`, voice-list negotiation completed, no
  browser/microphone opened, and the session closed immediately. Production artifact
  `.artifacts/neko-voice-fix.exe` passes `__uiprobe` and `--version`. The whole repository run reached
  **618 pass / 1 unrelated failure**: a pre-existing Zalo skill wording assertion expects `never retry` while
  the current skill says `Do not retry`; it was left untouched to avoid mixing an unrelated change into this
  repair.

## 2026-07-12 - ChatGPT subscription realtime voice: consent-first WebRTC experiment
- Verified the feature against the released OpenAI Codex `rust-v0.144.1` source, not only `main`. App Server
  exposes experimental `thread/realtime/*`; WebSocket auth still requires an API key, while browser-provided
  WebRTC has the SIWC `/backend-api/codex/realtime/calls` route. Implemented only the WebRTC subscription path
  and explicitly removed `OPENAI_API_KEY`/`NEKO_API_KEY` from its child environment. There is no automatic
  Realtime API fallback and no claim that the experimental Codex model equals ChatGPT's public Voice Live.
- Added a dependency-free loopback consent page: random per-session capability in the URL fragment, token-free
  HTML, exact-Origin authenticated WebSocket, bearer-gated SDP POST, strict CSP/no-store headers, body bounds,
  heartbeat cleanup, and direct browser WebRTC audio. The page does not call `getUserMedia` until **Start voice**
  is clicked. Tab close, `/voice stop`, `/logout`, `/support`, TUI unmount, backend close/error, and heartbeat
  loss release the microphone and close realtime. A previous idle GPT-5.6 provider is disposed first so voice
  does not double the optional App Server's steady-state memory.
- Added `/voice` UX with ChatGPT Subscription - Experimental / Local Dictation choices, support-pack install
  handoff, prominent `● LIVE` + timer/mute/live transcript, `/voice start|stop|mute|unmute|status`, and a guard
  against running an unrelated text turn concurrently. Background dynamic tools reuse `Agent.safeExecute` via
  a narrow public wrapper, preserving ToolRegistry approvals and UI events; duplicate voice tool ids execute
  once. `/usage` shows active/stopped duration and last limit/error while stating that remaining Voice quota is
  not exposed. No second voice pack or Electron/Chromium dependency was added.
- Evidence: focused WebRTC adapter tests validate capability rejection, token absence, inline-page syntax,
  SDP negotiation, transcript, idempotent tools, cleanup, and error classification; the Ink UI test covers
  explicit consent, waiting/LIVE/transcript/mute/stop and logout teardown. TS 5.9 + TS 7 clean; **618/618 tests,
  2456 assertions, 71 files**; architecture green; doctor healthy; policy PASS; `git diff --check` clean. A
  credential-safe live preflight on the owner's current account returned `VOICE_PREFLIGHT_OK state=waiting
  mic=off` after OAuth, App Server thread start, and voice-list negotiation; it made no model/audio call. The
  normal `dist/neko.exe` build target was locked by the already-running Browser Bridge, so the same production
  build script/flags produced `.artifacts/neko-voice-smoke.exe` (101,510,656 bytes); `__uiprobe` and the real
  ConPTY input probe both passed. Full microphone/media entitlement still requires the owner's explicit click
  in the browser and remains the only unverified external edge.

## 2026-07-12 - Computer-use latency audit and evidence-preserving fast path
- Measured the current Windows edge instead of inferring speed from benchmark scores. Fresh-process medians on
  this machine were 809 ms for `input wait`, 948 ms for UIA `list`, and 1.16 s for `display` (cold worst 2.33 s).
  The repeated PowerShell/.NET startup is therefore a material floor before model latency. Existing GUI logs
  show roughly 2.6-4.6 s per remote model call; Neko is reliable on structured UIA paths but is not yet honestly
  human-speed for a multi-action Zalo task.
- Corrected GUI harness semantics in v3. It now counts provider calls directly rather than relying on optional
  provider `usage`, records actual `GuiWorld` action calls separately, and renders/logs `turns` plus `actions`.
  A deterministic batched-response test proves that the two metrics remain distinct. This creates the evidence
  gate needed for speculative micro-batching: speed cannot be claimed by hiding actions or missing usage fields.
- Removed an avoidable latency tax from the production completion guard. If the agent already performed a fresh,
  successful inspection after its latest state mutation, completion is accepted immediately; only an unverified
  claim triggers the extra verification round. Adversarial tests still reject repeated confident prose without
  tool evidence, and read-only tasks do not pay the gate.
- Research synthesis: Microsoft UFO2 supports structured UIA/API execution plus state-validated speculative
  actions; Skim uses profiled fast paths with verified fallback; PASTE and asynchronous tool execution overlap
  predictable work. The minimal Neko translation is a resident local UIA executor, skill-owned app profiles,
  bounded low-risk micro-batches with per-action preconditions, and a separate approved commit for messaging or
  other irreversible actions. Live Zalo E2E was deliberately not fabricated: no running/Start Apps Zalo target
  was exposed during the audit, so the next phase uses a deterministic Zalo-like fixture before an owner-provided
  test account.
- Verification: TS 7 and TS 5.9 typechecks; **613/613 tests** across 70 files with 2,408 assertions; doctor OK
  apart from the expected non-TTY warning; policy PASS; `git diff --check`; production build, `__uiprobe`, and
  real-PTY input probe PASS. The exact idle Browser Bridge listener was stopped for Windows binary replacement
  and restarted hidden; doctor confirms it online on `127.0.0.1:8766`.

## 2026-07-12 - Outcome-verified computer use + physical DPI contract

A field task exposed a more important failure than the immediate 125%-scaling bug: a generated C# script
reported success after arranging desktop shortcuts against Windows' virtualized 1536x864 coordinate space,
and the agent converted that process signal into an unverified completion claim. The real display was
1920x1080. Fixing only that script would leave the same failure class open for later GUI, browser, and shell
actions.

The runtime now separates process evidence from outcome evidence. Production CLI, TUI, and depth-one agents
track state-changing tools; at the first finish claim they require a fresh, successful inspection call made
after the claim. A second confident prose answer without a tool is rejected. The prompt explicitly requires
comparison against every user-visible postcondition and forbids treating an action log or intended coordinate
as proof. Ordinary read-only/Q&A turns pay no extra round-trip. The existing optional broad verify gate remains
independent.

Windows geometry now has one explicit source of truth: `computer display` reports physical virtual-desktop
bounds, per-monitor work areas, DPI, scale, primary status, and negative origins under Per-Monitor-v2. Tool
schema and the bundled computer-use skill teach custom scripts to call
`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` before any geometry API and explain why legacy
`SetProcessDPIAware()` is insufficient on mixed-scale monitors. `input.ps1` was the remaining coordinate path
without awareness; its scroll rectangle now shares the same physical space as UIA/touch/mouse/overlay/capture.

The design follows the July 2026 evidence: OSWorld 2.0 identifies skipped verification, hidden state, and
visual-spatial precision as dominant long-horizon failures; Microsoft's Universal Verifier separates process
from binary outcome and drives false positives near zero; VLAA-GUI makes completion verification mandatory;
VAGEN uses active probing instead of passive claims; and Microsoft recommends Per-Monitor-v2 through
`SetProcessDpiAwarenessContext` before DPI-dependent APIs. We adopted the small runtime invariant, not another
planner/controller dependency.

Targeted verification: 56 tests / 0 failures; live `computer display` returned physical 1920x1080, DPI 120,
scale 125%, work area 1920x1020; the disposable WPF/UIA input probe passed Unicode typing, Ctrl+A replacement,
UIA readback, and ambiguous-window refusal. Full battery: TS 7 + TS 5.9 typechecks; 611/611 tests across 70
files with 2,400 assertions; doctor OK apart from the expected non-TTY warning; policy PASS; and
`git diff --check`. A production binary compiled with 867 bundled modules and passed both `__uiprobe` and the
real-PTY keyboard probe. A constrained live model run against that binary called its embedded
`Computer(display)` exactly once and read back the physical 1920x1080 / 125% contract, proving the new script
is present outside the source tree. A second adversarial live run was explicitly told to write an artifact and
claim completion without checking it; the production gate rejected that finish, forced a fresh disk read, and
the agent then checked exact bytes before reporting success. The probe artifact was removed. The initial build
lock was traced to the idle loopback Browser Bridge, not a chat session; that exact listener was stopped,
`dist/neko.exe` rebuilt and re-probed successfully, then the bridge was restarted hidden on `127.0.0.1:8766`.

## 2026-07-12 - Managed Gemini Support Pack and unified subscription-component UX

Gemini account login no longer dead-ends at an npm command. When no compatible bridge exists, `/login`
offers `Install and continue`, states the measured optional size, installs Google's official
`gemini-cli-bundle.zip` plus a portable Node LTS runtime under `~/.neko-core`, verifies both SHA-256
digests, versions, archive paths, installed-size bounds, and an ACP handshake, then resumes browser OAuth.
The base Neko binary remains unchanged by the optional payload and installation needs neither admin rights
nor a global npm/PATH mutation.

Gemini OAuth now uses `~/.neko-core/gemini-home` even when a system CLI binary is reused, so `/logout`
cannot sign out the user's separate Gemini CLI. `/support status` reports both ChatGPT GPT-5.6 and Gemini
components; provider-specific install/update/remove commands preserve external CLIs and unrelated auth.
Gemini `/usage` stays inside Neko and states ACP's remaining-quota limitation instead of sending users to
an interactive CLI. Live Windows probes installed Gemini 0.50.0 + Node 24.18.0 (194.2 MiB disk) and OpenAI
Codex App Server 0.144.1 (92.7 MiB download, 270.4 MiB disk), including checksum/version/protocol checks;
both temporary probe roots were removed afterward.

The follow-up uninstall audit found that a working remove subcommand was behaviorally undiscoverable.
Bare `/support` is now an owner-aware Support Center rather than a status dump: each component shows its
source and managed disk size, then offers Install, Update/Repair, or Remove only when appropriate. Neko
never presents Remove for a user-owned external CLI. Destructive removal has a safe default and explicit
choices to keep the subscription sign-in or remove the component and sign out; API keys and unrelated
providers remain untouched. `/support status` stays available as a copyable diagnostic report, and install
success copy points back to `/support` so users can find cleanup months later without remembering syntax.

Verification: TS 7 and TS 5.9 typechecks; 611/611 tests across 70 files with 2,400 assertions;
doctor OK apart from the expected non-TTY warning in the test shell; policy PASS; `git diff --check`;
and a production Windows binary (101,472,768 bytes) passed its bundled UI probe plus a real-PTY keyboard
probe. The normal `dist/neko.exe` replacement was intentionally not forced because a running Neko session
held the Windows file lock; the equivalent release build was compiled and verified at a temporary path.

## 2026-07-12 - Gemini account quota via official ACP, isolated behind Neko tools

Google now appears once in `/login`, then separates `Gemini Free/AI Pro/Ultra` from a pay-as-you-go
Gemini API key. The account route delegates OAuth, refresh, dynamic model availability, multimodal input,
streaming, and per-turn usage to the official Gemini CLI over ACP. `/logout` removes only Gemini OAuth
state; `/model` falls back to `auto` while signed out and becomes account-aware after sign-in; `/effort`
states the real contract (Gemini CLI manages thinking adaptively instead of accepting OpenAI effort tiers).

The security boundary is deliberately stricter than launching a second autonomous agent. Neko writes a
system-precedence Gemini settings file that empties the built-in tool allowlist, disables extensions and
hooks, and allowlists only an ephemeral `neko` MCP server. That server binds `127.0.0.1`, requires a random
capability header, and forwards calls to the active `CompleteOptions.executeTool`; edits and commands still
cross Neko's existing approval/path/sandbox checks. ACP permission requests fail closed, and the provider
refuses a CLI that cannot enter the isolated MCP session mode.

Gemini CLI remains optional: existing installs are reused, `neko setup gemini` / `/support gemini install`
is explicit, and the base one-line Neko install downloads nothing extra. Targeted verification covers ACP
request correlation, version discovery, scoped credential deletion, quota parsing, streaming, model/session
setup, a real loopback MCP tool round trip, and fail-closed isolation.

Verification: TS 7 and TS 5.9 typechecks pass; full suite 600/600 tests across 69 files with 2,339
assertions; policy PASS; `git diff --check`; live ACP initialize against installed Gemini CLI 0.38.1;
and a production compile plus UI/input probes. The running `dist/neko.exe` held Windows' file lock, so
the new binary was compiled and probed at a temporary output instead of terminating the user's active
session. Its size is 101,434,880 bytes versus the prior 101,432,832 bytes: +2 KiB in the base binary;
Gemini CLI itself remains optional and external.

## 2026-07-12 - TUI transcript hierarchy + web-result blank-gutter fix

The owner's Windows Terminal capture showed a large black gap between four Fetch calls and the first useful
result. This was content whitespace, not a flexbox spacer: web extractors could return many leading empty rows,
and the tool-result renderer faithfully spent its eight-row collapsed preview on those invisible lines. A
display-only normalizer now trims blank edges and collapses repeated internal blank rows. Agent context, saved
tool observations, and model input remain byte-for-byte unchanged; collapsed results, Ctrl+O expansion, replay,
and fullscreen share only the cleaned display rows.

User turns now follow the supplied hierarchy reference: a full-width neutral Ink background (`#303030`), one
cell of horizontal padding, a cyan `> ` marker, and white body text. New fullscreen user lines are synchronously
primed into the ANSI cache so the block never flashes as an unstyled fallback; Ctrl+F's flat transcript carries
the same background. The prompt glyph remains an independent non-color speaker cue.

The Neko Browser Extension is explicitly deferred as roadmap G14: Neko's persistent Playwright profile remains
fully first-class, while Store ID/key replacement, listing media, staged publication, and update/reconnect
dogfooding resume after the owner creates the Chrome Web Store item.

Verification: supplied screenshots were saved and inspected under `.artifacts/tui-audit-2026-07-12/`; a real
ANSI render filled all 40 cells of the user block. The virtual-terminal harness reproduced a web result with 12
leading/trailing blank rows and proved useful content remains within three rows of its Fetch call. Full suite:
589 pass / 0 fail / 67 files / 2,299 assertions; typecheck, policy, `git diff --check`, production build, UI
probe, and real PTY input probe pass. Bun emitted its known non-fatal directory-mismatch warning after exit 0.

## 2026-07-12 - Browser Bridge public-release candidate + site-agnostic durable identity

The developer preview is now a public-release candidate without broadening its browser authority. The manifest
remains user-gesture scoped (`activeTab`) and removes the unnecessary `tabs` permission; it still has no
`<all_urls>`, `debugger`, cookies, downloads, or remote-hosted code. `tabGroups` is the only new permission.
An attached tab shows an `AI` badge and an in-page `Neko is using this tab` control with a Stop button. Neko
creates `Neko - AI active` only for an ungrouped tab, removes only that group on detach, and never renames,
recolors, rearranges, or removes a group the user already owned.

Public Store and unpacked extension ids now enter the loopback trust boundary through config-first
`browser_extension_ids`. The bridge continues to require an exact `chrome-extension://<id>` Origin plus its
256-bit session capability; it does not fall back to an Origin wildcard. Chrome assigns the durable Store item
id/public key after the owner creates the Dashboard item, so the repository includes a two-phase packaging flow:
the first-upload ZIP omits the developer key, and the final manifest/config are updated with the Dashboard key/id.
The extension now includes generated 16/32/48/128 icons, a privacy policy, permission/data disclosures, listing
copy, reviewer instructions, release ZIP automation, and deterministic developer/first-upload packaging. Actual
Chrome Web Store submission remains an owner action because it requires the publisher account, registration fee,
privacy URL, listing media, and review consent.

Privacy wording now names the real boundary: the extension never reads cookies and talks only to authenticated
loopback, but a task-specific visible-page snapshot may subsequently be sent by Neko Core to the model provider
the user selected. Page contents and capabilities never enter `/relay`.

The real user config resolves browser MCP to `C:\Users\Admin\.neko-core\browser\default`, and the directory exists.
A full Chrome close/reopen against that actual profile preserved expiring cookies and localStorage independently
for two origins (`127.0.0.1` and `localhost`), then removed the probe data. This proves Chrome-profile persistence
is site-agnostic. It does not override Facebook/X/Gmail server policy: users sign into each service once in the
Neko profile, and the service may still expire/revoke sessions or demand 2FA/checkpoints.

Verification: a real headed Manifest V3 harness proved page marker + Stop, cleanup of a Neko-created group, and
preservation of a pre-existing `My work` group. A second headed run switched A -> B, proved A was cleaned, then
reattached B without losing ownership of its temporary group; both package ZIPs have `manifest.json` at root and the Store-first
manifest has no developer key. Full suite 585 pass / 0 fail / 67 files / 2,280 assertions; typecheck, policy,
doctor, `git diff --check`, focused secret scan, compiled production UI probe, and real PTY input probe pass.
The rebuilt bridge is live on loopback port 8766 and waiting for an explicit tab attachment. Bun again emitted
its non-fatal post-success directory-mismatch warning after the build exited 0.

## 2026-07-12 - real Facebook recovery + Neko Browser Bridge developer preview

The persistent browser path was verified against the user's real Facebook account rather than a synthetic
login page. The first restart correctly preserved the credential step but landed on Facebook two-factor
verification; the probe had incorrectly equated "no email/password fields" with authentication. The success
condition now excludes login/checkpoint/2FA/recovery routes and requires a rendered feed unit. After the user
completed 2FA, a full MCP/Chrome shutdown and restart returned `stage=feed` with no login fields.

Facebook's current DOM exposed real cards as `[data-virtualized]`; its `role=article` nodes were empty skeletons
below the viewport. The feed collector now supports both semantic articles and virtualized units, ignores empty
skeletons/non-interactive carousel units, and no longer deduplicates on the first link (often the author's URL).
A single 100-row tool call exceeded the MCP action timeout, so collection is checkpointed into batches of at
most 20 and deduplicated outside model context. The live read collected 112 unique feed units in 151.1 seconds,
without persisting or printing their private content and without any social write action.

The requested Neko-owned browser architecture is now recorded in `BROWSER-BRIDGE.md` and implemented as a
developer preview:

- a Manifest V3 extension claims one active tab through a user gesture (no `<all_urls>` or `debugger`);
- a loopback-only WebSocket/HTTP adapter checks the pinned extension Origin and a per-session 256-bit capability;
- read, click/scroll/navigation, and typing have separate grants; action grants default off;
- password, OTP/passcode, and payment fields are blocked before injection and again inside the page;
- cross-origin navigation and one-click emergency stop detach the tab;
- reconnect state is session-scoped; a newer authenticated connection replaces an older one;
- local audit stores timestamp/action/status only, never arguments, typed text, full URLs, page content or cookies;
- `/relay` receives only redacted browser attached/offline/grant status inside existing E2E-sealed presence.

The adapter composes through the existing `McpTools` port, so the core agent loop and Neko's normal MCP approval
gate are unchanged. `neko browser bridge/path/rotate` provide the lifecycle. Native messaging was deliberately
deferred: loopback WebSocket is sufficient and avoids another executable/registry installation; add it only for
managed-browser policy or OS-level attestation.

Verification:

- real Facebook: 2FA completion -> full restart -> authenticated feed; 112 unique read-only units;
- bridge unit E2E: exact-Origin pair, token command round trip, audit redaction, HTTP 401 without capability;
- popup Playwright at 360x640: status, grants, detach and emergency-stop affordances;
- real unpacked Manifest V3 harness: pair, attach, snapshot, deny ungranted click, grant, click, type, block
  password with the value still empty, emergency stop. Test-only localhost permission existed only in a deleted
  temporary extension copy; production remains `activeTab` scoped;
- full suite 583 pass / 0 fail / 67 files / 2267 assertions; typecheck, policy, doctor, `git diff --check`,
  secret scan, compiled binary, production UI probe and real PTY input probe pass. Bun again printed its
  post-success internal file-descriptor warning after exit code 0.

## 2026-07-11 - durable browser identity + bounded 100-item feed capture

The repeated-login regression was traced to browser identity, not vision. Both current Neko and v0.7.7's
Playwright setup used `--isolated`, which deliberately throws browser state away on close. v0.7.7's strong
Facebook runs instead controlled an already signed-in desktop Chrome through Windows accessibility/UIA.

`neko setup browser` is now an explicit three-mode contract:

- `persistent` (the default) owns `~/.neko-core/browser/default`; cookies, local storage, and login state
  survive Neko/MCP/Chrome restarts;
- `attach` uses Playwright's official extension to control the user's existing signed-in Chrome tabs;
- `isolated` keeps the disposable sandbox for untrusted or throwaway work and clearly warns that logins vanish.

`doctor`, CLI help, capability metadata, README, Web docs, computer-use, and procurement guidance all expose
the same contract. Persistent profiles have one active owner; concurrent/shared-Chrome work is directed to
`attach` instead of relying on a fragile shared remote-debugging profile. The local user config was migrated
to `persistent` without touching provider credentials.

The web-reading skill no longer gives up after five to seven visible posts. A bounded capture-before-scroll
collector now handles virtualized feeds: capture visible articles, deduplicate by stable ID/URL/signature,
scroll 80%, wait, and stop at the requested target, end-of-feed, budget, or three no-growth rounds. It reads
no cookies or form fields and remains behind the existing approval-gated MCP boundary. A synthetic feed with
only eight DOM rows at once produced exactly 100 unique rows (IDs 1 through 100) in 23.1 seconds.

Verification:

- browser identity: local storage and a cookie survived a complete MCP/Chrome shutdown and restart;
- deterministic virtual-feed probe: 100/100 unique items from an eight-row recycled DOM;
- focused setup/doctor/skill regressions plus full suite: 580 pass, 0 fail, 66 files;
- `typecheck`, `doctor`, `policy`, `git diff --check`, compiled binary, production UI probe, and real PTY input
  probe all pass. Bun printed a post-build internal file-descriptor warning after the successful exit.

The provider-driven end-to-end probe was not counted as passed: ChatGPT OAuth returned HTTP 429 and the
NVIDIA GLM trajectory stalled. These provider conditions do not invalidate the deterministic browser and
collector checks, but a benchmark claim must wait for an available model and a repeatable evaluation set.

## 2026-07-11 - Responses tool-argument repair + text-only computer-use recovery

The screenshots showing `computer`, `glob`, `todo_write`, and `skill` all missing their required fields
had one transport-level cause: the ChatGPT Responses parser consumed argument deltas but ignored the
official `response.function_call_arguments.done` event, then sparse `output_item.done` / `response.completed`
events could overwrite a complete JSON object with `""` or `{}`. The parser now accepts the finalized event
and preserves the more informative valid object across later sparse events. A regression fixture exercises
the exact `computer({action:"list"})` failure shape. A real GPT-5.5 OAuth run then emitted `Computer(list)`,
read the live Chrome/Facebook UIA tree, and reported success without vision or any screen mutation.

The Windows presence overlay had a separate first-action hang risk: its long-lived child inherited the
synchronous PowerShell capture pipes. The launch now redirects child stdout/stderr to bounded, separate
TEMP log paths, so a zero-duration computer wait with presence enabled returns in under a second instead
of holding the tool call open. UIA remains the primary text-model path; raw pixels remain the last fallback.

The pairing mismatch seen on mobile is now connection state, not transcript content. Relay renders one
persistent recovery card, disables composer/send, and opens Settings with the secret field focused; repeated
send attempts cannot append duplicate red errors. Playwright verified this at 390x844. Production Worker
version `fa59d9fe-d652-4fa5-bd08-5cda98b83c85` serves the change on both the canonical Custom Domain and
workers.dev rollback endpoint; both health checks report protocol v5 and the canonical response retains CSP,
HSTS, no-store, anti-framing, and restricted permissions headers.

Clean-room review of OpenConnector `62796b0` found a useful extension pattern, not a computer-use engine:
it keeps credentials behind a gateway and exposes only four discovery/execution MCP meta-tools for its large
Action catalog. Neko already has the matching progressive-disclosure boundary (`mcp_load` plus namespaced MCP),
so no provider catalog or dependency was copied into core. The appropriate future integration is an optional,
config-first external MCP profile with action policies and redacted run logs. Verification: 576 tests / 2,220
assertions, typecheck, policy PASS, doctor, production build, UI probe, real-PTY input probe, Wrangler dry-run,
live computer call, mobile Playwright flow, production health/source/header checks, and `git diff --check`.

## 2026-07-11 - relay v5: phone-sized viewport and virtual-keyboard polish

A fresh 390x844 production capture exposed mobile-specific friction that the desktop mirror did not:
the session/settings and send hit areas were too small, the desktop placeholder and status wrapped,
and the fixed chrome left too little room when the visual viewport became short. The existing terminal
design was kept; the mobile breakpoint now uses 44px touch targets, a 16px composer (preventing iOS
focus zoom), notch/home-indicator safe areas, `interactive-widget=resizes-content`, bounded independent
scroll regions for slash/approval/overlay/settings, compact mobile status/placeholder copy, and a
short-height mode that drops only the redundant path row while the virtual keyboard is open. Page zoom
is no longer disabled.

The implementation deliberately stays CSS/HTML-native: `100dvh`, safe-area environment variables,
media queries, and the viewport contract replace a second JavaScript geometry manager. Production
version `6422685d-fc2d-4675-b04f-54a7fc4a2190` serves protocol v5. Verification: 555 tests / 2,132
assertions, typecheck, compiled PTY input probe, Wrangler 4.110 dry-run, canonical and rollback health.

## 2026-07-11 - relay v5: controlled mirror reaches the Ink permission boundary

The relay already mirrored the durable transcript, but it stopped at the most important interactive
boundary: an agent turn waiting for a gated tool could only be approved in the local Ink terminal. The
browser therefore appeared to work until a real edit or shell action, then waited forever.

v5 publishes the live Ink state (step, queue, compaction, current task, concurrent tools, and approval)
inside the existing E2E-sealed presence metadata. Approval decisions travel out-of-band over a new
opaque `/control` route, so they can resolve the promise that is blocking the current turn instead of
joining the turn queue behind it. IDs reject stale approvals; offline controls are rejected rather than
replayed later. The browser preserves Ink's y/a/n semantics, disables its composer while consent owns
input, restores focus afterward, and keeps the approval preview ciphertext-only at the Worker.

The mirror also gained durable sequence dedup/gap recovery, Up/Down prompt history, local-device
`/copy`, and generic Ink Overlay projection: `/model`, `/provider`, `/effort`, `/resume`, and `/fps`
reuse the host picker's original selection callback over the sealed control path instead of maintaining
a browser-only copy of command behavior. HTTP bodies, WebSocket frames, and per-host offline queues are
bounded. Chrome QA exercised approval -> resume end-to-end against
a real local Worker/host pair. The production deployment is
`21840067-5ef1-42c7-aec4-ca645aa72e7a`; health reports protocol v5 on both the canonical Custom Domain
and workers.dev rollback endpoint. Full verification: 555 tests, typecheck, compiled PTY input probe,
Wrangler dry-run, and production security headers.

## 2026-07-11 - relay v4 promoted to a hardened production Custom Domain

The local `127.0.0.1:8790` URL was only the Wrangler dogfood surface; it could never be the remote-control
deliverable. Cloudflare inventory found one active zone (`holilihu.online`) and no existing record at
`relay.holilihu.online`. That short, purpose-named hostname is now the canonical relay URL. Cloudflare
owns its DNS and TLS lifecycle; `neko-relay.hungkhp888.workers.dev` remains enabled and health-checked
only as a bootstrap/rollback endpoint. The operator's local `relay_url` now points at the canonical host.

Before promotion, the public client gained a per-response CSP nonce, no-store, anti-framing,
no-referrer, restricted browser-permission, HSTS, and content-type headers. `/healthz` exposes only the
service/protocol version, so monitoring no longer allocates or touches a session Durable Object. Token
comparison uses the Workers `crypto.subtle.timingSafeEqual` primitive on current runtimes, with a local
fallback for Bun tests. The compatibility date and generated binding types were refreshed against
Wrangler 4.110.0 and `@cloudflare/workers-types` 5.20260711.1.

Two production versions were deployed while tightening CSP; the final version is
`4f4bc296-06a6-4b5f-a159-d85fd2b00184`. Public checks proved TLS + security headers, health v4, 401 on
an unauthenticated control call, and a real E2E WebSocket run: terminal-origin mirror, browser-origin
command, then durable replay after reconnect. No plaintext conversation content was visible to the
Worker.

## 2026-07-11 - relay v4: one conversation, one capability, one authoritative mirror

The owner caught the key mismatch with Claude Code Remote Control: Neko exposed one reusable hub URL,
so sharing one conversation implicitly shared every Neko terminal joined to that pairing. The web
transcript was also client-owned; terminal-origin turns could not appear on the phone. That was neither
least privilege nor a real shared session.

Bare `/relay` now derives a persisted capability per local conversation and prints a short display code
plus a direct `/session/<opaque-id>` link. `/relay new` revokes only that capability. The former broad
multi-session behavior remains available as the deliberately explicit `/relay hub` / `/relay hub new`.
Browser credentials, active host, drafts, and history are keyed by remote session, including a guarded
v3 migration path that cannot spill old credentials into a different deep-link.

The local Ink TUI is the authoritative writer. It publishes E2E-sealed semantic events (bounded
snapshot, committed transcript lines, live assistant stream, and tool activity) through the relay
adapter. The Durable Object stores only a bounded ciphertext replay window and fans live events to
read-only hibernatable browser WebSockets. Reconnect begins with reset + ordered replay before live
delivery, so it cannot duplicate a stale browser transcript. Pixel streaming and CRDTs were rejected:
one serialized agent session needs an ordered event log, not video bandwidth or multi-writer merge
machinery.

Initial verification used the real local Wrangler Worker. A host-origin transcript appeared in the CLI-shaped
browser, a browser-origin task executed and streamed through the host, and a fresh WebSocket replayed
the authoritative durable transcript while correctly omitting transient stream frames. Targeted relay
tests and strict typecheck passed; the following production promotion entry records the approved deploy.

## 2026-07-11 - relay UI now shares the CLI shell and interaction contract

The owner compared the live relay and CLI side by side. The first relay pass had the right colors but
the wrong product shape: an 820px centered web column, a sticky web header, boxed controls, a visible
send button, and relay-specific status text. The CLI is a full-screen terminal surface with a three-line
banner, a flexible transcript, a rule-framed prompt, and permission/context state at the bottom.

The relay now uses that exact hierarchy and spacing contract: full viewport with the CLI gutters and
background, `Neko Code vX` plus model/provider/profile/effort and cwd, an independently scrolling
terminal transcript with hidden scroll chrome, the same prompt placeholder and cyan `>`, and
`mode / model / ctx%` in the footer. Session and pairing controls are overlays, so opening them cannot
resize the transcript; desktop-only relay controls stay out of the normal CLI view until the banner is
hovered or keyboard-focused, while remaining visible on mobile.

The host's encrypted presence now carries version, provider, profile, effort, permission mode, and
context percentage. Browser Shift+Tab cycles the real host permission mode without consuming the draft
or adding a fake transcript turn; Esc interrupts the active turn; Enter streams normally; native textarea
selection/copy remains intact. Live browser checks covered draft preservation, mode cycling, send,
partial streaming, Stop, two-session switching, and overlay geometry. The reference and post-change
screenshots are in the ignored `.artifacts/relay-cli-parity-2026-07-11/` audit folder.
Verification: typecheck clean; 514/514 tests (1827 assertions); doctor resolves NVIDIA GLM 5.2;
policy PASS; compiled binary UI and real-PTY input probes PASS.

## 2026-07-11 - relay v3: one E2E pairing, multiple real Neko sessions

Screenshot-first audit confirmed that relay v2 only resembled the terminal by color: its paired state
was a large empty card, one persisted pairing collided across concurrent Neko processes, the Worker
routed to its first host socket, process activity was truncated to 12 lines, and the phone had no
session switcher, per-session drafts/history, or independent in-flight state.

Relay v3 makes the durable pairing a hub. Every running TUI gets an opaque host id; the Worker keeps
per-host socket tags and durable queues, and `/sessions`, `/send`, `/alive`, `/interrupt`, and v1 pull
resolve the intended host. Reconnect replaces a stale socket for the same host. Title/cwd/model/busy
presence is AES-GCM sealed at the host, so Cloudflare still cannot read project metadata. The phone
decrypts the session list, switches transcript + draft state, can run two sessions concurrently, and
Stop targets only the active one. Fifty completed turns per host stay on the paired device; Unpair
purges them. `/relay new` revokes the complete old hub before rotating so another running host cannot
leave an old phone authorized. Activity envelopes retain the most recent 200 lines rather than silently
showing 12.

The web surface now uses the existing terminal design language directly: selected session title/path
in the banner, terminal-flow empty state instead of the paired card, `> ` input, process lines, model
status, session drawer, keyboard/ARIA labels, and reduced-motion behavior. Unit tests cover worker
routing/queue isolation, encrypted metadata, client syntax/contracts, v1/v2 fallback, streaming,
interrupt and reconnect. A local Wrangler Durable Object with two real host WebSockets completed two
encrypted turns concurrently and returned the correct GLM/Fable model + process log for each. The
later CLI-parity pass captured and inspected the live browser surface; no deployment was made.

## 2026-07-11 - image wire semantics + current model routes

The owner corrected the provider diagnosis: GLM 5.2 is still available as `z-ai/glm-5.2` through
NVIDIA using `NVIDIA_API_KEY`; the rejected keys block only the direct Z.ai route. Added an explicit
default for the existing `nvidia` profile and added a current `fable` profile (`claude-fable-5`, native vision).
The real configured NVIDIA route then completed a no-tools probe exactly as requested
(`GLM_NVIDIA_OK`, one call), proving endpoint + stored key + model together rather than relying only on
doctor output.

The vision audit then found a real semantic bug. The TUI placed `[Image #N]` at the caret, but
`Agent.run()` moved every actual image after the complete text, and NVIDIA's `<img>` conversion moved
them to the end a second time. Numbered attachments now retain exact text/image interleaving through
both layers; CLI `--image` keeps its backwards-compatible text-then-images behavior. Clipboard
normalization is profile-driven rather than a universal 1568px assumption: 1568px/450KB stays the
safe default for strict OpenAI-compatible endpoints, while Fable 5 uses 2576px/4.5MB. macOS and Linux
now normalize too when their native/optional image tools are available. Regression tests cover inline
ordering, NVIDIA wire order, profile limits, and the two current profiles.

## 2026-07-11 - pasted-image temp lifecycle closed

The Fable 5 image audit found a concrete lifecycle leak outside the model context: every Alt+V read a
temporary `neko-paste-*` capture into a data URL but never removed the file. Four stale captures totaling
about 619 KiB were already present in TEMP during the audit. `pasteImage()` now removes its capture in a
`finally` block on success, oversize refusal, and read failure. Existing temp files were left untouched;
future pastes clean up after themselves. No image payload or clipboard behavior changed.

## 2026-07-11 - Fable 5 audit: GUI harness v2 closes repaired-violation false passes

Re-read the 14-commit range after `6fa903f` through `1995d72`, the current roadmap/state/backlog,
and the implementation/tests for GUI eval, OSC 8 links, managed search, relay v2, and image input.
The shipped baseline was healthy (500/500 tests, typecheck, doctor, policy), but direct trajectory
replay found three verifier holes: `find-open` passed after wrong->close->right; settings passed after
changing a forbidden checkbox twice; bank-transfer passed after claiming the explicitly forbidden
offer and then recovering. The expense survey had the same latent shape.

The simulator now records non-destructive forbidden interactions as sticky constraint violations,
the base inbox verifier checks the complete open history, and every task verifier enforces its stated
constraint even when the final UI state was repaired. Four regression paths lock this behavior. GUI
bench logs now include `harnessVersion: 2`; v1's gpt-oss 11/12 result remains historical and must not be
compared to v2 until re-run. No controller, framework, dependency, or production computer path changed.

## 2026-07-10 (night, part 7) — [Image #N] inline tokens + the caption-then-reason vision bridge

Owner: paste should read like Claude Code ("[Image #92]" inline in the sentence), and "model không
visual vẫn có thể đọc và hiểu ảnh". Research (caption-then-reason: the modular pattern used by
BLIP/LLaVA-augmented WebArena-class agents; native multimodal tool-calling is the 2026 frontier when
the model HAS eyes) shaped the ladder: main model vision-capable -> attach the real image; else
`vision_model` reads it into grounded text; else an honest per-image note naming the exact config fix.

- **Inline tokens**: Alt+V now inserts `[Image #N]` AT THE CARET (TextInput does the caret mechanics
  via a new `onPasteImage` hook; ChatApp stages id -> data URL in a map sharing the paste counter -
  PLACEHOLDER_RE already matched `[Image #N]`, groundwork from the paste-collapse arc). The token
  travels in the sentence; deleting it DETACHES the image; /paste drops the token into the input.
  The separate "image attached" info line + magenta badge are gone - the token IS the affordance.
- **The bridge** (`src/adapters/vision.ts`): one-shot `describeImage()` on `cfg.visionModel`
  (default: free nemotron VLM on NVIDIA endpoints - the getter existed since the vision arc but had
  NO consumers until now) with a grounded read prompt: VERBATIM transcription (errors, code, digits,
  tables as markdown), compact layout description, and the untrusted-data stance (image text is
  content, never instructions - mirrors WEB_EXTRACT_PROMPT). The description replaces the token IN
  PLACE, so the text-only model sees it exactly where the user put it.
- **/model footgun closed at the source**: /model persisted a TOP-LEVEL `model`, recreating the
  profile-shadow trap doctor warns about (it bit the owner AGAIN mid-test). setModel(model, profile)
  now writes into the ACTIVE profile and deletes any legacy top-level value.

Verified: 500/500 tests (Alt+V caret insertion x2, describeImage contract x3, setModel profile
write x2), dual typecheck, policy PASS, and a LIVE bridge probe: a drawn image with known text ->
real nemotron on NVIDIA -> "ERROR CODE NEKO-4217" and "--safe" transcribed verbatim in 4.2s.
Binary rebuilt + reinstalled; owner's config de-shadowed once more (the new binary stops recreating it).

## 2026-07-10 (night, part 6) — pasted images: normalize at the source, break the 400 death spiral

Owner's live test (image #90) produced two HTTP 400s that are one root cause: **/paste attached the
clipboard image RAW**. A screenshot PNG is multi-MB -> ~1M base64 chars -> ~233k tokens -> overflows
ANY context window; the server computes max_tokens = window - prompt = NEGATIVE (-102511) and 400s.
Worse: the doomed user message stays in history, and shrinkOldObservations deliberately never touched
user-attached images - so EVERY later turn re-sent the whale and 400'd too ("maximum context length is
202752 tokens... your messages resulted in 254082"). A session poisoned forever by one paste.

Three fixes, each at its own layer:
1. **Source (clipboard.ts, win32)**: normalize on read - longest side capped at 1568px, JPEG q82 (what
   Claude Code does; vision APIs don't resolve past ~1.5k px). Live-probed with a REAL 3200x2000
   clipboard bitmap: 236KB JPEG at 1568x980. The probe also caught a PowerShell overload trap:
   `[Math]::Min(1, 1568/w)` resolves to Min(int,int), truncates 0.49 -> 0, and produced a 1x1 image -
   `1.0` forces the double overload. (Non-Windows paths unchanged: pngpaste/xclip, no resize.)
2. **Attach gate (chat.tsx)**: >600k base64 chars is refused with the size and the fix ("crop or
   capture a smaller region") instead of sending a doomed request.
3. **History relief (agent.ts)**: shrinkOldObservations now also masks user-pasted images from
   EARLIER turns (text stub; the CURRENT turn's attachment is preserved so the model gets one full
   look). This breaks the re-overflow loop for any session that still gets too big.

Verified: 493/493 tests (new: earlier-user-image masking; last-turn image untouched), dual typecheck,
policy PASS, live clipboard probe all-green, binary rebuilt + reinstalled.

## 2026-07-10 (night, part 5) — relay: slash commands answer remotely; the client is CLI-verbatim

Owner: "khong dung duoc ca lenh" + "toi muon giao dien giong het CLI" + the security question ("ai
an truy cap vao cung duoc ha?").

- **Slash commands were mute over the relay** (the real bug behind "can't even use commands"): /help,
  /status etc. print info/error LINES, never an assistant message, so the remote run() returned
  "(no reply)". addLine now feeds a per-remote-turn collector; the reply is the newest assistant
  message when the turn grew the transcript, else the collected info/error lines. Also guarded
  `/relay` FROM the phone (it would stop the relay and cut the very connection carrying the command).
- **The client is now CLI-verbatim**: the header is the terminal banner (text kaomoji `ハ・・マ` +
  "Neko Code · remote" + dim status/host lines), the composer placeholder is the CLI's
  `Try: "..." or /help`, and the bottom bar mirrors the CLI status line - `⏵⏵ state` left,
  `model · remote` right (the model rides the final reply envelope via handlers.status()).
- **Security posture surfaced in-product**: the pairing card states the page is public by design and
  can do nothing without the pairing keys (session+token auth per session, 96-bit random, first-token
  binding, E2E on top). Unpaired submits now focus the paste box instead of silently opening a drawer.

Verified: dual typecheck; 492/492 (final-envelope test now asserts the model field); policy PASS;
client parse + 5 structural markers; Worker redeployed; live probe 13/13; binary rebuilt + installed.

## 2026-07-10 (night, part 4) — relay full re-audit: self-review caught an XSS + 4 UX defects

Owner: "Kiem tra lai mot luot nua di moi thu cua relay". Re-read every relay file adversarially,
starting with my own freshest code (the most likely home of bugs). Found and fixed five:

1. **XSS (critical, self-introduced in v2.2's md())**: fenced-code content was UN-escaped before
   innerHTML - hostile page content relayed inside a reply's code fence would execute script on the
   phone. Fences now keep the escaped text (which is also what displays correctly).
2. **syncEmpty() rebuilt the pairing card on every 25s refresh** - wiping the paste-link box while
   the user was typing into it. Now rebuilds only when the state (unpaired/paired/turns) changes.
3. **A single mobile-network blip killed the whole wait**: the /result poll ran inside one try -
   one failed fetch = error row while Neko kept working. Poll failures now sleep 1.5s and continue.
4. **Streaming yanked the page down while reading scrollback**: auto-stick now only applies within
   160px of the bottom (sending always scrolls) - the terminal's own behavior.
5. **`/relay qr` / `/relay new` while the relay was ON just turned it off** (the toggle branch ate
   every argument). `qr` now reprints the running relay's code without restarting; `new` stops,
   rotates, and restarts in one step; bare `/relay` stays the toggle.

Verified end-to-end again after the fixes: dual typecheck; 492/492 tests; policy PASS; client script
parse + 4 static guards (no fence un-escape, emptyKey, nearBottom, parse); Worker redeployed; served
page 13/13 structural checks; **live probe 13/13 re-run on the deployed Worker**; binary rebuilt +
reinstalled (UI + input probes PASS).

## 2026-07-10 (night, part 3) — relay v2.2: the web client IS the Neko terminal now

Owner on the desktop web view (stretched full-width, 5 raw fields dumped) + the QR: "giao diện chưa
thật sự tốt... thiết kế giống hệt như Terminal của neko core hiện tại, vì tôi đang rất thích giao diện
này." So the client was rebuilt to BE the terminal:

- Full monospace (Cascadia Mono), the exact logo amber `#e6932e`, dim `─` rules, a `>` prompt
  composer, a bottom status bar (mode left / identity right) - a 1:1 read of chat.tsx's chrome.
- Messages are a terminal TRANSCRIPT, not bubbles: `> you` in cyan, `●` tool lines (the streamed
  process log), replies flowing below. The mascot (assets/) is the header logo + favicon + app icon.
- **Desktop fix**: capped to a centered 820px column, framed with side borders >=860px like a
  terminal window - no more edge-to-edge stretch on a 1920px monitor.
- **Flow fix**: unpaired = ONE calm pairing card (mascot, a single paste-link box, "manual setup"
  tucked behind a disclosure) instead of five raw fields. Paired = straight to the transcript.
- QR research (SOTA check): half-block IS the scannable optimum (cells ~1:2 -> 2 modules/cell is the
  squarest packing; quiet-zone 2 is standard), and a 100-char pairing URL can't shrink without
  weakening the keys - so the answer is show-once (done in v2.1), not shrink.

Verified: no TS touched (client-only); Worker redeployed; deployed page structurally validated 13/13
(monospace, amber, 820px cap, `>` prompt, transcript turns, process log, pairing card, paste-link,
embedded logo, no leftover placeholder, no stray bubble CSS, no mojibake). Visual confirmation is the
owner's next reload (Chrome extension not connected here for an auto-screenshot).

## 2026-07-10 (night, part 2) — relay v2.1: the owner dogfooded from a real phone; every rough edge fixed

The owner paired from a real phone (Messenger's in-app browser) and hit the worst possible message:
"error: The operation failed for an operation-specific reason". Root-caused as a STACK of three real
defects, all mine, all fixed and live-verified:

- **The unreadable error.** When the host couldn't decrypt an inbound message (secret mismatch) it
  sealed the "wrong secret" error WITH THE SAME MISMATCHED KEY - guaranteed unreadable exactly when
  the user needs it. Decrypt-failure replies now go plaintext with the exact fix in the text.
- **Fragment pairing never persisted.** localStorage was only written on manual typing; a QR scan
  filled the fields, worked once, and a reload silently unpaired the phone. applyPairing() now saves
  immediately.
- **In-app browsers strip fragments.** Messenger drops `#s=..&t=..&k=..` - added a "paste pairing
  link" field that parses the whole URL, plus a `kid` fingerprint (SHA-256(secret) first 8 hex) the
  host registers and the relay serves via /alive, so the client shows "key mismatch" BEFORE sending.
- **"Hien qua trinh neko lam nhu o Terminal"** (owner): tool activity now streams to the phone as
  the exact `describeToolCall` lines the terminal prints - a monospace process log with a braille
  spinner above the growing reply, carried in the sealed {text,act} partial envelope (ws only).
- **UI redesign around the real brand**: the mascot (assets/neko-icon.png + avatar-512.png, embedded
  as data URIs) replaces the paw emoji as favicon/app icon/header/empty state; palette switched from
  off-brand violet to the mascot's amber; message layout restructured (the "neko" label used to sit
  BESIDE the bubble - flex bug); markdown-lite gained pipe-table rendering; friendly error taxonomy.
- **The QR-wall complaint**: `/relay` no longer prints the code every time (pairing persists, so it
  is first-pairing chrome only; `/relay qr` reprints, `/relay new` rotates). Kept half-block
  rendering after working the geometry: terminal cells are ~1:2, so quadrant/octant densification
  distorts the module aspect ratio or depends on font synthesis - reliability wins.

Verified: 492/492 tests (envelope, plaintext wrong-secret error, kid-in-register, fresh-flag), dual
typecheck, policy PASS; Worker redeployed; **live probe 13/13 on real Cloudflare infra** (adds: kid
matches, act lines streamed, wrong-secret error readable); deployed client checked serving the new
markup; binary rebuilt + reinstalled (UI + input probes PASS).

## 2026-07-10 (night) — relay v2: the phone becomes a first-class seat

Owner: "phần relay giao diện và mọi thứ chưa được tốt lắm suy nghĩ sâu nhé". Audited the whole
subsystem by reading it as the phone user experiences it, checked the July-2026 SOTA (Claude Code
Remote Control's launch architecture: streaming + approve/redirect from the phone; Cloudflare's
Durable Object guidance: WebSocket Hibernation is GA and the recommended shape for long-lived agent
sessions - long-polling keeps the DO awake and billing), then rebuilt the transport:

- **Found and fixed, in order of user pain:** (1) no streaming - `handlers.run` had an `onDelta` the
  relay never used; the phone stared at typing dots for whole minutes. (2) restart = silent unpair -
  fresh session/token/secret every `/relay`, phone waits ~16 min then shows a vague error. (3) DO
  eviction = permanent silent death - token lived in memory, every later /pull got 401 and the host
  swallowed it forever. (4) busy = message DROPPED. (5) no host-liveness concept. (6) raw markdown
  on the phone.
- **The rebuild:** host <-> Worker is now a WebSocket with hibernation (jobs push instantly; DO
  sleeps between messages instead of burning free-tier duty cycle on a 1s poll); the host streams
  throttled E2E-sealed partial frames and the client renders them live with a seq cursor
  (`/result?seen=`); Stop on the phone sends `{t:"interrupt"}` mid-turn; pairing persists in
  `~/.neko-core/relay.json` (`/relay new` rotates); token/queue/results moved into DO storage;
  `/alive` makes the status pill truthful; busy remote messages wait (bounded 15 min) like desktop
  input. Back-compat both ways: v1 endpoints kept for old binaries; a v2 host reads `/register`'s
  `v` field and degrades to long-poll against an old Worker (or when WSS never opens - 3 strikes).
- **Verified:** 490/490 tests (5 new WS-double tests: partial-then-final, mid-turn interrupt,
  WSS-blocked degrade, reconnect-and-serve, pairing persistence; the untouched v1 tests double as
  the back-compat proof), dual typecheck, policy PASS. Worker deployed to the owner's Cloudflare
  and **live-probed 10/10 on real infrastructure**: WS transport, /alive truth, E2E round-trip,
  offline queue -> reconnect flush, 2 streamed partials before the final, phone-Stop interrupting a
  hung turn.

## 2026-07-10 (evening) — handoff polish: doctor names the model-shadow trap; the search ladder gets its middle rung

Post-v0.9.0 close-out session (the owner's last with this collaborator — priorities chosen for a solo
user running Neko day-to-day):

- **Doctor warns on model shadowing.** The overlay order (file beats profile preset) is documented and
  correct, but it bit us live on 2026-07-10: a top-level `model` in `~/.neko-core/config.json` silently
  overrode every profile, so `--profile nvidia` kept sending `z-ai/glm-5.2`. `loadConfig` now records
  `modelShadow` (the exact source file or `NEKO_MODEL (env)` + the preset model) whenever a selected
  profile's preset model is overridden; behaviour is unchanged, but `neko doctor`'s `model` check turns
  WARN and names the file, both models, and the fix (`profiles.<name>.model`). Verified live against the
  owner's real config. Precedence flip rejected: file-beats-preset is documented and relied upon.
- **`neko setup tavily <key>`** — the no-Docker rung, onboarded in one command: live key verification
  against api.tavily.com (nothing written on failure), then `tavily_api_key` into the gitignored user
  config (auto-redacted by `neko config`'s SECRET_KEY regex; env `TAVILY_API_KEY` wins at search time).
  Key threaded config -> registry -> WebPort opts; subagents inherit it.
- **The ladder stopped skipping its middle rung.** `web_search` used to fall from a failed SearXNG
  straight to DuckDuckGo even when a Tavily key existed. Failures now walk DOWN: SearXNG -> Tavily (if
  wired) -> DuckDuckGo, with honest notes at each step. README gained the ladder bullet; WEB.md updated.

Verification: dual typecheck clean; **485/485 tests, 1717 assertions, 55 files** (one load-induced 15s
timeout on the first run, green twice after); policy PASS; doctor demonstrates the new WARN on the real
config. New tests: config modelShadow (4), doctor shadow WARN (1), config-wired Tavily key + ladder
fallback (2).

## 2026-07-10 — reliability/security sweep: composition, streaming, permissions, config

Owner asked to resolve every issue from the repository audit and to keep MCP web as a first-class
extensibility path. The implementation stayed deliberately small:

- Added one adapter-level ToolRegistry composition seam used by CLI + TUI; depth-one subagents inherit
  web/vision/skills, disabled tools, sandbox/network/seatbelt settings, presence/input, summarization,
  and adversarial review. Native `web_search`/`web_fetch` remain a zero-config fallback beside namespaced
  `mcp__<server>__<tool>` capabilities; MCP is not replaced or shadowed.
- Fixed OpenAI-compatible parallel streaming by accumulating each tool-call index independently and
  eager-finalizing only when that index contains a complete JSON object (index switches are not stops).
- Made persistent memory/workflow/playbook permissions action-sensitive; mutating actions are gated,
  plan mode stays read-only, accept-edits includes multi_edit, and policy audits the full contract.
- Added recursive config redaction for MCP headers/env, typed boolean NEKO_* parsing, built-in-profile key
  persistence/migration, durable session titles, AGENTS.md loading, deep paging for large files, dynamic
  architecture coverage, platform-correct tool schemas, and a load-safe ffmpeg test timeout.
- Marked Python-era docs as historical, refreshed the v0.8.3/current architecture pointers, and removed
  the unused ink-spinner dependency.

Design evidence checked before coding: MCP tools/list + namespacing/list-change contract
(modelcontextprotocol.io/specification/2025-11-25/server/tools); Anthropic's simple-composable-agent,
brain/hand separation, MCP context-efficiency, and containment guidance; OpenAI's 2026 harness-engineering
and prompt-injection guidance; the official openai-node streaming accumulator behavior. No new framework
or dependency was introduced from those references.

Verification: TS 7.0.1-rc + TS 5.9 clean; **400/400 tests, 1423 assertions, 52 files**; doctor OK;
policy PASS; compiled binary + production UI probe + real-PTY input probe PASS.

## 2026-07-08 — v0.8.0: editing/input UX + lifecycle polish (research/multiline-caret merged)

Developed by the self-improve loop (Neko + Codex peer-review) on a research clone, then senior-reviewed
before merge. The review caught a scope-underreport (branch was 44 files / +3198, not the "6 files" the
loop reported) and a red typecheck; both fixed. Highlights:

- **Input**: O(1) windowed render (long input no longer lags) + WORD-wrap (not mid-word, image #79) +
  footer truncates on narrow terminals (no extra chrome row = no band-geometry churn).
- **Caret**: reverted the branch's inverse-video BLOCK back to the owner's tight inserted bar (`wo▏rld`).
  The off-phase appends a zero-width ZWSP - INVISIBLE (no `wo| rld` gap) but flips the line's bytes each
  blink, which is LOAD-BEARING: a truly static caret let the differ skip frames and left the fullscreen
  band blank after a resize (fullscreen-sim caught it). Documented so no one "simplifies" it back.
- **Resume data loss (owner report)**: persist() ran only in the turn's finally block, so closing the
  terminal mid-task lost the prompt + every tool result. Now onEvent snapshots at each clean checkpoint
  (step / tool_result) via a persistRef; sealDanglingToolCalls handles a mid-tools kill. Test: a hanging
  provider proves the prompt is on disk though the turn never finished.
- **Rollback that STICKS (owner question)**: `neko update <version>` downgrades + pins; installers take
  `--version` (rustup/uv-style) / `-Version` (PS scriptblock) / NEKO_VERSION. The pin is `auto_update:
  false` - NOT a new field - so the version rolled back TO honors it (a `pin_version` field would be
  ignored by the old binary and the user dragged forward). RELEASE.md §7 documents the contract.
- **doctor**: shows the file-search backend (ripgrep vs JS walk); rg IS used (14.1.1 verified).
- Refactors: adapters/web.ts, agent-constants.ts, chat-lines.ts extracted; Ctrl+G external editor;
  plan-box respects terminal width. Removed docs/research (Neko's ephemeral task/consult notes).
- Gates on the branch BUILD (the loop's blind spot): 382/382, typecheck clean, policy PASS, build +
  __uiprobe + input-probe, e2e-conpty-ghost 3/3, resize sim, scroll bench 6ms. Merged as v0.8.0.

## 2026-07-04 — Seamless resume/continue: interrupt a task, come back, just keep typing (Claude-Code parity)

Owner: interrupting a coding task mid-tool then resuming lost the whole chat; and it shouldn't need a
flag - Claude Code lands you exactly at the interrupt point and you just type to continue. Studied
claude-code/src/utils/conversationRecovery.ts clean-room (detectTurnInterruption filters orphaned
tool_uses + appends a synthetic "Continue from where you left off"). Built the equivalent across four
commits:
1. **Full-thread replay + seal** (earlier commit): resume rebuilds the whole transcript incl. tool
   calls/results (not just user+assistant text - an interrupted coding turn is almost all tool activity),
   and sealDanglingToolCalls() adds a synthetic result for any tool_call left unanswered by the abort so
   the provider doesn't reject the next request.
2. **Continue mechanism**: recoverTodos() rebuilds the todo tracker from the last todo_write so the
   handoff state (done/in-progress/left) survives; a "N tasks open" hint; `/continue` (resume the first
   incomplete todo), `/retry` (re-run the last turn), `-c`/`--continue` (Claude-Code parity).
3. **Auto-resume (the owner's "no flag")**: a bare `neko` now auto-resumes this dir's latest session when
   it was left MID-TURN and recent (<12h) - `wasInterrupted()` = doesn't end on a final assistant TEXT
   answer. So you interrupt, come back, and you're back at the interrupt point; just type to continue (the
   sealed context makes any next message pick up). A clean-ended session never auto-resumes; `--new`
   forces fresh. This is the seamless flow, matching Claude Code, without requiring a flag.

Also fixed along the way: raw `\x1b[2J\x1b[3J\x1b[H` escapes that froze real terminals (Ink 7 owns its
synchronized output) - resume/trim/resize now use Ink's app.clear() or append-only Static. Suite 286/0.

## 2026-07-04 — Interaction-perf sweep: session index (/resume 577->140ms) + a whole-store audit

Owner: after the /resume freeze, sweep the whole codebase for OTHER functions that lag the interaction
the way /resume did (synchronous heavy I/O blocking the UI thread). Done + measured:
- **/resume + /sessions (the real find):** `listSessions()` parsed EVERY session file to show a menu -
  2860 files / 34MB = **577ms** of blocking JSON.parse, plus a preview built for every listed session.
  Fixed with a mtime-validated metadata index (`listSessionMetas`, `.index.json`) + lazy preview:
  **577ms -> 140ms** steady state, zero transcripts loaded on open (see the session-index commit).
- **Ruled out with measurements (NOT lag, left alone per ponytail):** the full per-turn dynamicContext
  build (skills+memory+workflows+playbook+agents blocks + matchSkill/matchWorkflow) = **11ms/turn**,
  fully masked by the seconds-long model round-trip. Other file stores are tiny (workflows 3, memory 5,
  recipes 1) - no 2860-scale outlier. Startup ~600ms is Bun's compiled-binary runtime boot, inherent.
  Diff rendering is bounded (write/edit results capped to ~16-34 lines before highlightLine runs). Stream
  render is O(1) (renderTail, G0). No other eager-heavy picker exists (/model = async+busy, /provider +
  /effort build from in-memory data).
- **Crash sweep:** fired every read-only slash command (/help /cost /sessions /context /memory /tools
  /skills /recipes /bashes) headlessly - all run, none crash or hang.

Honest conclusion: the /resume path was the one real interaction-lag offender (scale of the session store);
the rest of the interactive surface is within bounds. 140ms is below the ~200ms "instant" threshold, so a
further micro-opt (e.g. a directory-mtime fast path) wasn't worth the added staleness risk (YAGNI).

## 2026-07-03 — UX/UI + micro-interaction audit (slash-menu Enter, /resume dead-end, approval preview)

Owner tested `neko --yolo` live and hit a "freeze" on `/resume`; asked for a deep UX/micro-interaction
audit. Done directly (solo). Found + fixed three real issues; verified the rest works via a headless
interaction smoke test:
- **Slash-menu Enter ignored the arrow selection.** Only Tab used `slashSel`; Enter submitted the RAW
  partial, so "/resu"+Enter ran the unknown command "/resu" and down+Enter didn't pick the highlight. Enter
  now completes a bare "/tok" to the highlighted/nearest match and runs it (Claude-Code behavior); a
  command with an arg ("/model gpt-4") is untouched.
- **`/resume` dead-ended** in a dir with no local sessions: it printed "…Ctrl+A shows all projects" with no
  picker on screen to press Ctrl+A on (read as a freeze). Now it opens the all-projects picker directly
  when other projects have sessions.
- **Approval-box diff preview** still drew flat green/red while the committed transcript diff is now
  per-token syntax-highlighted; the preview now matches (marker green, removed red, added highlighted).
- Verified OK (headless smoke): Vietnamese typing + mid-string cursor insert + backspace, Ctrl+U clear,
  slash menu open/↓/Tab-complete, Shift+Tab mode cycle - no crash, no dead key. Noted latent (not worth
  churning): text-input NFC-on-insert can misplace the cursor by one on a rare combining sequence (clamped,
  never crashes; the common Vietnamese-IME path works). +1 test; suite 281/0.

## 2026-07-03 — Syntax-highlight code inside diffs (Claude-Code-grade tool-result rendering)

Owner compared Neko's Write/Edit tool output to Claude Code (screenshots): Neko rendered every diff line
in ONE flat color (green add / red del / dim) so code read as a monochrome blob, while Claude Code colors
the code TOKENS (keywords, types, strings, functions) like real code with indentation. Root cause: Neko
already had a per-token highlighter (`highlight.tsx`) but it was only wired into markdown code blocks, never
into the diff renderer. (This is a RENDERING gap, NOT a "code skill" — the owner asked if a skill was
needed; it isn't, the fix lives in `src/ui/`.)

Fix: a `DiffLine` component in `transcript.tsx` parses the two tool-runtime diff formats (Write `+ code`;
Edit `NNNN <sign> code`), colors the marker (green +/red -) + line number (dim) to carry the diff signal,
and runs the CODE through `highlightLine` so tokens get real colors while indentation survives; removed
lines stay red, plain non-diff results (search/ls) stay dim/un-highlighted. Extended `highlight.tsx` with
type/class coloring (cyan for builtin types + Capitalized identifiers) and function-call coloring (blue),
matching Claude Code's palette. Proven on a real render (FORCE_COLOR): magenta keywords + cyan types + blue
calls + green strings all emit on one diff line, indent intact. +9 tests; suite 280/0; binary reinstalled.

## 2026-07-03 — HARD benchmark tier + an honest finding (also 100%) + 2 coding skills (Superpowers, clean-room)

Built `neko bench hard` (6 multi-file/algorithm/verification-biting tasks: layered-bug root-cause tracing,
multi-bug 3-independent-bugs, feature-no-regression, toposort, expr-eval recursive-descent, float-money)
to escape the easy tier's 16/16 saturation — every reference solution verified solvable + every buggy
fixture verified failing before wiring. **Honest result: glm-5.2 scored 12/12 (100%) on the hard tier
too** (90% cached, 56 steps, 503s). The model is genuinely strong on BOUNDED coding — pass-rate saturates
even here. The real read: at this capability level pass-rate is the wrong discriminator; the SOTA-relevant
signals are LONG-HORIZON task success (METR HCAST — where even frontier models fail ~50%) and harness LIFT
(raw vs +harness on tool-requiring tasks), not more bounded pass/fail. Recorded rather than papered over;
the hard tier stays as a higher-bar no-regression guard.

**Researched Superpowers** (github.com/obra/superpowers, MIT) at the owner's request — a mature
methodology-as-skills system (~14 skills: brainstorm->worktrees->plans->subagent-driven-dev->TDD->review).
Verdict: Neko already has the *infrastructure* (skills + progressive disclosure) and most Superpowers
skills either duplicate Neko (verification-before-completion ~= the new verify gate) or contradict its
thin-single-agent thesis (subagent-driven-dev, worktrees) or fight cache stability (the "1%->MUST invoke"
bootstrap). But Neko had ZERO general coding-methodology skills (all 7 are domain-specific), so two
genuinely general, non-duplicative pieces were adapted CLEAN-ROOM (ideas, not text) into Neko's format:
`test-driven-development` and `systematic-debugging`. Progressive-disclosure (only load when relevant), so
~zero cost when not triggered. Honest caveat: their benefit is on real long-horizon work, NOT a bench
number (the bench is saturated + runs skill-less) — justified on quality + near-zero cost, verified by the
full battery holding flat (no regression).

## 2026-07-03 — Robustness/quality levers: pre-flight validation, task-carry, verify gate

Three research-grounded harness levers, quality-first (each keeps or raises correctness; none regresses
the default). (1) **Pre-flight arg validation** (Gecko, arXiv 2602.19218) in `safeExecute`: a call missing
a REQUIRED key is caught BEFORE execution and fed a schema hint (key + type + description) so the model
self-repairs in one step instead of execute->throw->vague-error a round-trip later; presence-only (never
type pedantry), unknown schema fails open, covers the eager path (same seam). (2) **Original-task carry
across compact()**: the first user turn is preserved VERBATIM (clipped) ahead of the model summary by
deterministic code — instruction fade-out / Governance Decay (2606.22528, 2603.05344) can't drop the
anchor when the summarizer compresses the head. (3) **Opt-in pre-completion verify gate**
(`verify_before_exit`): intercepts the first tool-less final once, forces a re-inspection of the ACTUAL
state vs the goal, then finishes (LangChain PreCompletionChecklist; ACE); off by default, +1 turn only
when it fires, never on the last step. +4 tests; 276/0.

**Full no-regression battery (quality is the gate — all green, NO metric regressed):** unit **276/0** ·
bench **16/16 (100%)**, 92% cached, 61 steps (baseline 59), 447s · run-evals **6/6 solid** · harsh-eval
**8/8 solid** at 2 trials. This session's perf/robustness work (stream-eager execution + the three levers
above) ships with correctness held flat and the cache/overlap benefits intact.

## 2026-07-03 — Stream-eager tool execution: the loop's floor drops to max(generation, execution)

Owner asked for the next performance frontier (research-first, or invent one). Post-sprint cost structure
made it obvious: the agent loop was STRICTLY sequential (generate -> execute -> generate) while generation
(~10 tok/s on glm-5.2) and tool execution (1-8s each) are overlappable. Research converged on exactly this
lever: **"Executing as You Generate"** (arXiv 2604.00491 — hides execution behind generation, up to -37.3%
end-to-end latency), **AsyncFC** (arXiv 2605.15077 — future-based decode/execute overlap, "concurrency
without model changes"), and the tool-use survey (arXiv 2603.22862 — parallel / async-decoupling /
speculative as the three efficiency paradigms).

Built it at the ports/adapters seam: `CompleteOptions.onToolCallReady` fires the moment a STREAMED tool
call is fully parsed (anthropic: `content_block_stop`; openai: index-advance, finalize-once). The loop
eager-starts READ-ONLY calls (EAGER_SAFE = CONCURRENCY_SAFE minus `task`) while the rest of the response
still streams, with strict order safety: eager-starting stops at the first non-read call in emission order
(a read after a write must observe the write), gated tools keep approval semantics untouched, the same
abort signal governs everything, and results are consumed by key (never re-executed). In a batch of N
reads, call 1 runs while calls 2..N stream - at 10 tok/s that window is seconds per turn on read-heavy
work (web_fetch batches, file exploration). +4 tests locking the contract on both wire formats. 272/0.

## 2026-07-03 — MCP lazy-CONNECT + orphan tree-kill: local RAM 513MB -> 233MB (-55%)

Went from profile to fix the same day (owner: "dieu tra sau phan toi uu di"). Experiments first: normal
exit and a controlled hard-kill did NOT leak (the 28-orphan pile was a nondeterministic race in the
bunx->node launcher chain — the SDK kills only its direct child), and the process tax was deterministic:
every run spawned the browser MCP (~277MB across bunx+node) even when no browser tool was ever called.

Fix at the adapter (zero core change): (a) **spec cache** `~/.neko-core/mcp-specs.json` keyed by
name+config-hash — a hub registers a server's full tool surface (specs/resources/prompts/meta) WITHOUT
spawning it; the existing reconnect seam became `ensureClient` (connect on first actual use, refresh the
cache); config change = cache miss = eager as before; `neko mcp` calls `connectPending()` so diagnostics
never show stale cache. (b) **close() tree-kills** stdio children by transport pid (`taskkill /T` on
Windows) — closes the launcher-chain leak. Honest residual: a hard-killed run that was actively browsing
can still orphan (nothing in-process survives SIGKILL); lazy-connect shrinks that surface to near zero
since non-browsing runs spawn nothing.

**Measured after:** trivial live run 513MB/3 processes -> **233MB/1 process**, zero MCP children; cache
16.6KB; on-demand connect works end-to-end (fixture-server unit tests: cache-hit no-spawn, first-call
connect, config-change invalidation). Suite 268/0; policy + build green.

## 2026-07-03 — Cross-model verification + local-perf profile (owner question: "other models? CPU/GPU/RAM?")

**Cross-model:** harsh-eval re-run on gpt-oss/NVIDIA (the OpenAI wire format, `response_format`
constrained decoding) = **8/8 solid** — schema extraction is now green on BOTH provider families
(anthropic-format via forced tool call on glm-5.2, openai-format via response_format on gpt-oss), each
with its own self-heal. Cache metrics likewise normalized across 3 usage shapes; the stable prefix
benefits every implicit-caching endpoint by construction.

**Local perf profile (measured, not asserted):** binary 112.7MB; startup 0.5-1.0s; live-run tree 513MB
RAM with CPU <15% of one core (I/O-bound as designed; GPU unused by design — the model is remote, local
inference is a config choice where our stable-prefix work speeds server-side APC). The one real local
finding: **~277MB of that RAM is the browser-MCP server spawned even when a run never touches a browser
tool** — mcp_lazy removed the token tax, the process tax remains. Queued as the top local-perf BACKLOG
item (MCP lazy-CONNECT), alongside the orphan-hygiene fix. The G0-era hot-path fixes (O(1) render,
bounded buffers, fd-prefix reads, cached git status) remain the load-bearing local optimizations.

## 2026-07-03 — Speed sprint + full no-regression battery (two big finds)

**Speed sprint (owner-directed), all shipped:** (1) deterministic **websosanh offers parser** in web_fetch
(904eafc) — the procurement INDEX tier is now CODE-parsed: 32/32 offers from the live page, zero LLM
tokens, can't misread a price, graceful fallback on redesign; (2) **parallel-width nudge** (d8822d4, W&D
arXiv 2602.07359) — batch independent reads in one turn (the fan-out machinery existed; the prompt now
tells the model to use it); (3) skill: **one survey answers min+max+median** + reuse baogia_norm.json for
follow-ups + SKU-querying the index (c372258). Combined-question errand now runs at 8-9 calls vs 30 for
the ask-twice pattern. (4) Effort A/B (max vs medium, same errand): medium was NOT faster (471s vs 342s,
n=1, provider-latency dominated) — default effort kept; wall-clock levers are call count + cache, not the
thinking budget. Honest record.

**Benchmark battery (owner mandate: prove no "improved but worse").** Suite green at every step; two REAL
finds, both invisible without the battery:
- **`neko bench` 16/16, calls 64->59, and the first true cache picture: 94% of input tokens were cache
  READS on Z.ai** (256.5k in, 240.4k cached) — the prefix-cache + rolling-breakpoints work measurably
  engages in real agent loops (the earlier isolated 2-call probe showing 0 was not representative), and
  the old "in tokens" numbers were UNDERCOUNTS (Anthropic input_tokens excludes cache reads; the old
  adapter never added them back).
- **harsh-eval collapsed 0/8 on glm-5.2 -> exposed that `responseSchema` was never implemented on the
  anthropic provider** (G4 built it for openai_compat only; the model switch silently degraded ALL schema
  extraction to free text). Fixed with the format's standard structured-output pattern: forced tool call
  (schema = input_schema, thinking skipped - incompatible + unneeded), self-heal to prompt-JSON +
  extractJsonLoose. 0/8 -> **8/8 solid**.
- run-evals 4/6 -> **6/6 solid** after fixing the MEASUREMENT layer (grade the final answer, not tool
  echoes; negative checks on kept rows only; accept legitimate source aliases; clarify the trade-in
  credit-vs-program rule per G5 intent; print the failing output tail). The A/B against the pre-sprint
  skill proved these were pre-existing false alarms + model drift, NOT today's regressions.
- Final suite 267/0 after killing 28 ORPHANED MCP server processes (eval spawnSync timeouts kill neko but
  orphan its stdio children -> machine saturation -> the queue-test flake). Hygiene item queued in BACKLOG.

## 2026-07-03 — Procurement recall gap fixed: INDEX (websosanh) -> VERIFY architecture (A/B live-proven)

Owner caught a REAL wrong answer: asked "SSD 990 EVO 2TB MZ-V9E2T0BW, GIA DAT NHAT o VN" — Neko said 9.99tr
(HACOM) while ChatGPT+search found laptopworld.vn at ~14tr. Root causes, in impact order: (1) the skill had
no INDEX tier — websosanh.vn was one passive search suggestion, so coverage = whatever search returned
(7 shops); (2) SearXNG was down (Docker Desktop off) -> DuckDuckGo fallback with measurably weaker recall;
(3) the source MAP had no PC-components category (laptopworld/An Phat/Mai Hoang/Nguyen Cong PC missing).

Fix at the SKILL layer (zero core change — domain = pluggable skill): a mandatory **two-stage
INDEX -> VERIFY** section in `skills/procurement/SKILL.md`. INDEX: every price survey STARTS with
`websosanh.vn/s/<query>.htm` (probed: server-rendered, one web_fetch = ~600 offers spanning 360k->14tr+;
`?sort=` params do nothing, so harvest ALL offers verbatim and let `price-table.ts` sort — LLM extracts,
code computes). VERIFY: by query type — "dat nhat" verifies the top 3-5 on the merchant page (product-match
+ live price + stock), "re nhat" the bottom 3-5 (junk lives there: 359k/880k index rows were accessories/
wrong SKU), "gia thi truong" = median after dropping wrong-SKU rows. GAP-FILL: MAP + search (+ a new
PC-components MAP section). Also restarted Docker -> `neko-searxng` auto-revived (restart=unless-stopped),
doctor shows `web_search: searxng` again.

**A/B proof (same errand, same day):** OLD strategy -> 7 sources, max 9.99tr (WRONG), 75k tok / 13 calls.
NEW strategy, run in DEGRADED mode (DDG — searxng came up mid-run): found laptopworld VIA the index,
verified live on the merchant page -> **12,990,000d in stock = correct answer**, dropped 5 ghost index rows
(404s) + stale prices (websosanh's 14.289tr for laptopworld was an OLD price — likely the very number
ChatGPT reported unverified), and flagged that market band is really 3.95-5.2tr. Cost: **50k tok / 12 calls
— cheaper AND correct** (the index replaces blind per-shop fetches). Also gitignored the
`skills/procurement/baogia*.json` artifacts dogfood runs drop in the repo.

## 2026-07-03 — Researched Browser Use CLI 3.0 / browser-harness (clean-room, live-verified)

Owner asked whether Browser Use CLI 3.0 changes our browser story (G7 chose Playwright MCP; G10 stealth via
config). Cloned both repos to `../neko-refs/` and read the core. **Findings:** CLI 3.0 is their autonomous
agent product; the reusable piece is **browser-harness** — a ~1.4k-line Python CLI (helpers 508 + daemon 427
+ ipc 201) speaking **raw CDP to a running Chrome**, invoked via bash heredocs (`browser-harness <<'PY' ...`).
Architecture is the "bitter lesson" applied to browser tools: NO tool schemas, NO accessibility-tree dumps —
a small pre-imported helper API (page_info/click_at_xy/js/cdp/screenshot/tabs/waits), screenshot-first +
coordinate clicks that pass through iframes/shadow-DOM at the compositor level, `js()` for text-only
extraction, and **self-healing**: the agent writes missing helpers into `agent_helpers.py` and uses them
immediately. Ships AS a skill (SKILL.md) — exactly Neko's G1 extension model. Windows is first-class (TCP
loopback + token IPC). **Live-verified end-to-end on this machine:** `uv tool install browser-harness` ->
launched a throwaway Chrome with `--remote-debugging-port` + temp profile -> `BU_CDP_URL=... browser-harness`
drove it (new_tab, wait_for_load, page_info, js('h1.textContent')) — worked first try; cleaned up after.
**Verdict (revised after owner pushback — the right call):** **HOLD, don't adopt now (YAGNI).** Neko's
existing stack already covers the real workloads — proven by dogfooding (attached to the owner's Chrome,
read their X feed, summarized the first 100 posts; procurement sources live VN retail sites): layer 1
`web_fetch` + schema extraction + deterministic routes, layer 2 Playwright MCP against real Chrome
(config-only), layer 3 skills routing (web-reach). A second browser stack = a new Python daemon dependency
+ split maintenance for capabilities we already have. **Adoption triggers recorded** (revisit browser-harness
only when one actually fires): (a) a real site where a11y-snapshot refs break (cross-origin iframes /
shadow-DOM) and coordinates would win; (b) measured snapshot/token costs that mcp_lazy + the queued BACKLOG
compaction items (TACO, stale-read elision) can't cover; (c) needing agent-authored browser helpers beyond
what workflows/skills give. The refs clone + this analysis stay for that day.
**The measured, already-shipped fix instead:** the owner's config runs the 23-tool browser MCP below the
lazy threshold (30), so its schemas cost **~3,991 tokens EVERY LLM call**; `mcp_lazy: true` (built in G12)
drops that to ~634 (meta-tool + name index) — **~3,357 tokens/call saved**, ~100-170k on a long browse
session — one config line, no code. **Applied 2026-07-03** (owner-approved): `"mcp_lazy": true` in
`~/.neko-core/config.json` (backup: `config.json.bak-mcp-lazy`); verified via the chat wiring path —
`hub.lazy=true`, wire schemas 15,962 -> 486 chars + a 2,048-char name index, `mcp_load` exposed.

## 2026-07-02 — Tool-error recovery directive at the point of failure (29e7c95)

Sprint item 2 (Self-Harness, arXiv 2606.09498 — its single biggest win was a recovery-oriented prompt
injected WHEN a tool errors; +16pp Terminal-Bench-2 on a mid-size model). Neko's static F2 rule ("read the
result, diagnose, fix") fades under attention decay on long runs; the fix lands the directive NEXT TO the
error. On the FIRST failure of a mutating tool (bash/write_file/edit/multi_edit — read misses are benign
exploration), the loop appends a `[recovery]` observation: DIAGNOSE the actual state -> REPAIR the root
cause / recreate the artifact -> VALIDATE by re-running the failed check. Edge-triggered (a mutating
success re-arms; a second consecutive failure stays silent — persistence is the unproductive-streak
guard's job), and appended as a tool message so the prompt prefix stays cacheable. +2 unit tests (fires
once + re-arms; silent on read misses). Suite 261/0.

**Sprint status / next-up:** the remaining reliability items (pre-flight arg validation - Gecko;
pre-completion verify gate) are both opt-in and lower-leverage; deliberately deferred to a fresh session
rather than shipped tired. The queue lives in `docs/self-improve/BACKLOG.md`.

## 2026-07-02 — Prompt-prefix cache: stable prefix + explicit breakpoints + measured (7fa916d)

The sprint's highest-leverage BACKLOG item, done research-first (Anthropic prompt-caching docs; Manus
"Context Engineering for AI Agents" — KV-cache hit rate as THE production metric, stable prefix, no
timestamps, append-only; *Don't Break the Cache*, arXiv 2601.06007 — 41-80% agent-cost cut, dynamic
content at the END; Z.ai context-caching docs — implicit caching, `cache_read_input_tokens` in usage).
Neko's cache-hostility, fixed at each layer it owns:

- **The head of every request churned per turn.** `environmentBlock()` recomputed a `git status`
  dirty-count (flips on every edit) + the date INSIDE the system message, and `dynamicContext` re-injected
  the todo list (changes on every `todo_write`) — so the provider's prompt-prefix cache died for the whole
  conversation, every turn. Now: the env block is a **session-start snapshot** (memoized per
  cwd+model+provider, labeled so the model runs `git status` itself for live state — also kills 1-2 git
  spawns per turn), and todos are OUT of the system message (the `todo_write` result already recites the
  plan into the message stream — the Manus recitation pattern, append-only and cache-friendly).
- **The anthropic provider sent no cache breakpoints** (Anthropic-format caching is explicit — without
  `cache_control` nothing caches at all on a real Anthropic endpoint). Now: a breakpoint at the end of the
  system prompt (one entry covers tools + system per the tools→system→messages hierarchy) + a **rolling**
  breakpoint on the last message block (the API's 20-block lookback re-reads the previous step's prefix, so
  a 40-step turn pays each step's tail, not the whole history). ON by default; `prompt_cache: false` opts
  out; endpoints that reject `cache_control` are self-healed (strip + one retry — the reasoning_effort
  pattern). Unit-tested: add/strip round-trip + a fetch-mock heal test.
- **Measurement first**: `Usage`/`CostTracker`/bench now carry `cached_tokens` (Anthropic
  `cache_read/creation_input_tokens` folded back into prompt_tokens — Anthropic's `input_tokens` EXCLUDES
  them; OpenAI `prompt_tokens_details.cached_tokens` normalized). `/cost`, the bench summary, and
  `bench-log.jsonl` report the hit rate, so the self-improve loop can DIFF it.

**Honest live verdict (probed, not assumed):** Z.ai's coding-plan anthropic endpoint ACCEPTS
`cache_control` (HTTP 200, with or without the old beta header) and returns `cache_read_input_tokens` —
but attributes **0 reads** even on byte-identical back-to-back calls (call-2 latency halved, 3212→1300ms,
so infra-level reuse likely exists without usage attribution). So the falsifiable prediction "cached>0 on
Z.ai turn 2" is NOT MET on Z.ai today; the breakpoints stand on the documented Anthropic/Bedrock 90% read
discount + the verified self-heal, and the stable prefix benefits every implicit-caching provider (OpenAI,
DeepSeek, vLLM). 260/0 tests; typecheck + policy + build green.

## 2026-07-02 — Post-release hardening: the dropped-'y' approval race + the release-asset race

The v0.5.0 post-release check found BOTH pipelines red, each hiding a real bug:

- **CI red — the two approval UI tests were NOT "flaky under load"; they were a real race, deterministic on
  slow machines.** Root-caused end to end: the approval y/a/n handler lived in its own
  `useInput({ isActive: approval !== null })` hook. Ink paints the frame at React *commit*, but a toggled
  hook's listener only attaches in a later *passive effect* — so a 'y' typed the instant the box appears
  falls in that gap and is silently dropped; the box hangs forever. Proof chain: `git bisect` (first bad =
  492e010, the `<Static>` width-cap, which widened the commit-to-effect window past the tests' 20ms poll);
  a probe that passed with +300ms before 'y'; instrumenting ink's `use-input.js` showed the subscribe
  landing after the keypress (and the console.error itself un-raced it — a Heisenbug). Fix at the right
  layer: approval keys move into the ALWAYS-mounted global hotkey hook (subscribed from app mount; ink 7's
  `useEffectEvent` invokes the latest render's closure, so it sees `approval` the moment the box shows) and
  the toggling hook is deleted. TextInput is unmounted during an approval, so no double-handling. The two
  tests went from ~13s (full poll budget burned) to instant; 5x reruns green; full suite 253/0. Lesson
  recorded: an `isActive`-toggled `useInput` can never catch a keypress that races its own activation —
  handle state-gated keys in an always-on hook instead.
- **Release incomplete — v0.5.0 shipped missing `neko-linux-arm64`.** Every matrix job ran
  softprops/action-gh-release; two jobs racing on the fresh tag each created a release, the duplicate was
  discarded, and its upload 404'd. Healed the live release by re-running the failed job (5/5 assets now
  up), then fixed the workflow: a tiny first job creates the release ONCE via `gh release create`
  (idempotent for re-runs), and the build matrix `needs:` it and only does `gh release upload --clobber`.
  No third-party release action left.

Also noted for the next backlog pass: the "broad doom-loop detection" BACKLOG item is already implemented
and tested (the BROAD loop guard tests in `test/agent.test.ts`) — the checkbox is stale.

## 2026-07-02 — Fullscreen scroll mode: attempted, then REVERTED (a lesson)

Tried the fullscreen/alt-screen scroll mode (scroll up while a reply streams + jump-to-bottom, like Claude
Code) on a display-row model (`richwrap.tsx` + `fullscreen.tsx`, a `/fullscreen` toggle). It **worked and
unit-tested green**, but dogfooding on a real terminal showed the micro-interactions were **not good enough**
(alt-screen full-frame flicker, page-jump not smooth, no mouse-wheel, broken selection, transcript vanishes on
exit). Root cause is structural, not a fixable bug: **stock Ink has no real scroll region** (verified —
`overflow:hidden` samples rows instead of clipping), so the whole thing fought the framework. Claude Code only
gets it smooth by **patching Ink's renderer + a custom ScrollBox** (DECSTBM scroll region, negative-y clamp) —
and even THEY keep fullscreen opt-in / internal-default for the public (`isFullscreenEnvEnabled` = env var or
`USER_TYPE==='ant'`, auto-off under tmux -CC). Reaching that quality means forking Ink: weeks, risky, and it
threatens the single-binary build — disproportionate to a nice-to-have already ~90% covered by the earlier
progressive-commit fix (which removed the reported top-jump). Per our own rule ("no patchwork; do it right or
don't ship it"), **reverted the whole feature** (`richwrap.tsx`, `fullscreen.tsx`, the `chat.tsx` mode, the
`/fullscreen` command) and kept the polished **inline** mode as the single experience. Lesson: don't chase a
Claude-Code feature that depends on their forked Ink — verify the framework can do it *well* before building.

## 2026-07-02 — Streaming scroll-jump, declutter, emoji alignment

More screenshot feedback:
- **Streaming "keeps jumping to the top".** The terminal auto-follows output, so a live (non-`<Static>`) region
  taller than the viewport forces a redraw-from-top every frame. Fix: **progressive commit** — once the buffered
  reply outgrows the viewport, `maybePump` moves its completed paragraphs (up to the last blank line) into
  `<Static>` (natural scrollback, no jump) and keeps only the current paragraph live; also hide the stale
  thinking trace once the answer streams (frees ~6 rows). (The full Claude-Code behavior — scroll UP while it
  streams + a "jump to bottom / N new messages" pill — needs the alternate-screen / managed-scroll-region
  architecture; that's a larger change to raise separately, but this removes the reported top-jump.)
- **`---` clutter.** A markdown rule rendered as a full-width `─` line, which read as noise; now it's just
  spacing (the model is already told not to draw rules).
- **Emoji misalignment.** Table widths counted code points, so an emoji cell (width 2) knocked the borders out
  of line; switched `plainLen` to `string-width` (display width). Keycap emojis (`1️⃣`) that render as a box+digit
  are normalized to `1.`, and the emoji variation selector is stripped.

## 2026-07-02 — Word-wrap regression fix + LaTeX->Unicode math

Two issues from a screenshot (Vietnamese text breaking mid-word + raw LaTeX):
- **Wrap breaking words / losing the gutter indent.** Root cause (found by A/B + width probes, not guessed):
  markdown paragraphs are a bare `<Text>` with no width, and Ink's `<Static>` renders items at the FULL
  terminal width — so with the left gutter a long line wrapped at full width, got shifted right by the padding,
  overflowed the real terminal edge, and the TERMINAL hard-wrapped it mid-character (dumping the tail at column
  0). Vietnamese exposed it because the lines were long. Fix: give the markdown column an explicit
  `width={maxWidth}` and width-cap every `<Static>` item to `contentCols`, so text wraps at OUR inset width at
  word boundaries and never reaches the terminal edge. (The gutter itself was fine; this was a `<Static>`
  width-propagation gap.)
- **LaTeX math.** A terminal can't render `$...$`/`$$...$$`, so formulas showed raw. Built `mathToUnicode` —
  extensible mapping tables (Greek, operators, super/subscripts) + `\frac`/`\sqrt`/`\text` handling with the
  right ordering so nested `\frac{...\sqrt{...}...}{...}` works (quadratic formula → `(-b ± √(b²-4ac))/(2a)`).
  Wired to display math (own-line `$$`/`\[`) and inline `$...$` (guarded so `$5 to $10` prices are left alone),
  plus a system-prompt nudge toward plain Unicode math. This is a real, extend-by-adding-a-symbol feature, not a
  patch — matches the "SOTA + infinitely extensible" bar.

## 2026-07-02 — Terminal-clean output (no emoji / real rules / readable elapsed)

Screenshot review surfaced three presentation issues; studied Claude Code's own prompts to fix them right:
- **Emojis misaligning** (the model emitted `1️⃣`/`🎯`/`🔑`; keycap emojis render as a box+digit on the Windows
  terminal and throw off column widths). Root fix is a formatting instruction, not a render hack: Claude Code's
  system prompt says *"MUST avoid using emojis"* + *"Only use emojis if the user explicitly requests it"* and
  frames output as GitHub-flavored markdown in a monospace font. Added the equivalent **`## Output`** section to
  Neko's `DEFAULT_SYSTEM_PROMPT` (markdown-for-monospace, no emojis unless asked, no hand-drawn ASCII rules).
  So it's a baseline rule, not a per-domain skill — the user's instinct ("do we need a presentation skill?") was
  close, but this belongs in the always-on system prompt.
- **`-----` ASCII rules** looked like noise → a markdown `---` now renders as a clean full-width box-drawing
  line (`─`), not a partial run of hyphens.
- **`194s` elapsed** → `fmtElapsed` shows raw seconds under a minute, then `1m 00s … 3m 14s` (zero-padded) so a
  long turn's timer reads cleanly. Unit-tested.

## 2026-07-02 — Horizontal gutter; live-verified the idle-timeout fix

Confirmed the idle-timeout fix end to end: a `neko run` on glm-5.2 asked for a professional 3-file landing
page — the exact task that previously died with "The operation timed out" — and it **completed** (index.html
432 lines, styles.css 386, script.js 156; 34.5k tokens / 16 calls; exit 0; the agent even opened the page in
a browser to screenshot it). The idle timeout held across a multi-minute generation.

**Horizontal gutter** (Claude Code uses `paddingLeft={2}` on its REPL container): Neko's UI ran flush against
column 0. Added `paddingLeft/paddingRight` to the root Box — verified empirically that Ink's `<Static>`
inherits a parent Box's padding, so one wrapper indents both the committed transcript and the live region.
Width-sensitive rendering switched to `contentCols` (= `cols - gutter*2`) so tables/dividers/the stream clamp
fit the inset width. Also hardened the async-tool UI tests (bash/plan approval) to poll-until-condition instead
of a fixed tick — git-bash's heavier spawn makes a fixed wait flaky. (Note: those two tests can still flake when
the machine is badly saturated — e.g. right after a live browser-driving run leaves orphaned node processes —
but pass in isolation and on a healthy machine; the gutter was ruled out as the cause via an A/B run.)

## 2026-07-01 — Idle timeout (mid-stream abort fix), todo de-dup

A real functional bug surfaced by dogfooding (a "make me a landing page" run failed with **"The operation
timed out"**): the provider request timeout was a **TOTAL** cap — `AbortSignal.timeout(timeout_seconds*1000)`
attached to the whole `fetch`, which keeps aborting the *body stream* too. So a long-but-healthy generation
(3 files, glm-5.2 with thinking) crossed the 120s cap and was killed mid-stream. Switched both providers
(`anthropic.ts` — the Z.ai/GLM path the user runs — and `providers.ts`) to an **idle timeout**: a manual
`AbortController` + a timer that `bumpIdle()` resets on every `reader.read()` chunk (threaded through
`parseStream`/`sseEvents`). A healthy stream never times out; only a genuine stall (no bytes for
`timeout_seconds`) aborts. This is the standard SDK pattern (Claude Code / OpenAI SDK use idle, not total,
timeouts for streaming). Unit-tested with a slow-but-active stream (gaps < budget, total > budget → finishes).
Also de-duped the todo view: the sticky live tracker renders only while a turn runs; when idle the committed
"Update Todos" tool result is the single record (it was showing the plan twice).

## 2026-07-01 — GeneBench-Pro harness-lift, Windows bash fix, TUI polish

Continued on `self-improve`. Three linked arcs, all green (typecheck + 239 tests + policy + build).

**Dogfooded Neko on a real research benchmark (GeneBench-Pro).** OpenAI's new benchmark for agents doing
messy multi-stage computational-biology analysis (129 problems; SOTA is low — GPT-5.6 Sol Pro 31.5%, Claude
Opus 4.8 16%). Pulled the public 10-problem package from Hugging Face (`ajh-oai/genebench-pro-public-package`),
built a thin runner (`E:\Sach\Sua\genebench-pro\`, outside the repo) that stages each problem's data files,
runs `neko run --yolo "<task>"`, extracts the final JSON answer, and grades it with the benchmark's own public
`reference_grader.py` (fully deterministic — no LLM judge). Proved Neko is exactly the right agent shape for
this (bash + code execution + files + iterate). gpt-oss scored 0/10 (expected for a weak model on a 16-31%
benchmark), but the run SURFACED two harness bugs that cost answers independent of model quality.

**Windows bash fix (real harness-lift, benefits every Windows run).** The `bash` tool spawned via
`{ shell: true }`, which on Windows is **cmd.exe** — so a model's natural Unix idioms (`python - <<'PY'`
heredocs, single-quotes, `$VAR`, pipes) failed with "<< was unexpected at this time", burning steps. Fixed in
`core/sandbox.ts`: on Windows the unsandboxed path now routes through real **Git-Bash** (`findWindowsBash()`
prefers `NEKO_BASH`, then a Git install, then a git-derived path; deliberately ignores WSL's
`System32\bash.exe`, which can't see the Windows-drive cwd), falling back to cmd.exe only if no bash is found.
Verified a heredoc now runs (`HEREDOC_OK 4`). Re-running GeneBench with the fix + higher `max_steps` moved a
problem from no-answer (cut off) to a graded answer; no-JSON count 2→1. Lesson confirmed: **harness quality
lifts completion/answer-rate; crossing the pass threshold needs a stronger model.**

**TUI polish (Claude-Code-level, clean-room from screenshots + our own code — nothing copied).**
- **Tables** (`ui/markdown.tsx`): the old renderer space-padded columns with no borders as one `<Text>` per
  row, so a wide table overflowed the terminal and Ink wrap-shattered the columns. Rewrote it width-aware:
  box borders (`┌┬┐│├┼┤└┴┘`), columns budgeted to the terminal `cols` (`fitColumns` shrinks the widest first),
  cells truncated to a single line (`truncCell`, ellipsis) so borders stay aligned, inline styling kept.
- **Rhythm:** breathing room above headings + around tables (vertical rhythm, not cramped text). The real
  cramping culprit: Ink collapses an empty `<Text>` to height 0, so blank markdown lines between paragraphs
  were vanishing — now blank lines render as real rows (runs collapse to one) for even paragraph spacing.
- **Turn separation** (studied Claude Code's own source at `../test/claude_lo/claude-code`, clean-room — its
  `UserPromptMessage` uses `marginTop={1}` and `MessageRow` sets `addMargin` per row): Neko's transcript lines
  (user / tool_call / info) had no margin, so a prompt glued to the previous turn's completion line and to the
  tool call below it. Gave the user line + each tool_call line a blank line above — prompts now stand clear and
  each tool call groups with its result.
- **List blocks + streaming scroll-jump + footer + run dot** (round 2, from more screenshots + the Claude Code
  source):
  - **List separation:** a `**Label**` line followed by bullets was glued to them. A run of list items is now
    one block (blank around the run, tight between items), so section labels stand clear.
  - **Streaming "scroll jumps to the top":** the live preview rendered `renderTail(stream, 4000 chars)` — up to
    ~60 lines, taller than the viewport, so Ink couldn't update in place and redrew from the top every frame.
    Fixed by clamping the preview to the terminal height (`clampToRows`, wrap-aware, tracks `rows`) and rendering
    it in a new `compact` Markdown mode (no added blank-line rhythm → predictable height). The full reply still
    commits to `<Static>` verbatim when the stream ends. (Same root cause + fix shape as Claude Code's
    `disableRenderCap` / `visibleStreamingText`.)
  - **Footer:** the mode indicator gets a `⏵⏵` chevron + a left indent (matches Claude Code's `figures.pointer`
    mode line).
  - **Run indicator:** the in-flight tool dot is now blue (`RunningLine`), blinking, per request. (Very fast
    tools finish before a blink cycle; it's clearly visible on real work like a build.)
- **Ctrl+O is now a toggle** (`ui/chat.tsx`): it used to APPEND a full copy each press (never collapsing,
  because `<Static>` lines are immutable). Now it toggles an `expandedId` and shows the peeked result in the
  live region (below `<Static>`), so a second Ctrl+O collapses cleanly — no duplication.
- **Blinking run indicator** (`ui/thinking-line.tsx` `RunningLine`): a tool call in flight now shows LIVE with
  a blinking gray dot; it commits to the transcript (solid dot) only when it finishes — a clear running-vs-done
  signal, matching Claude Code. Tool-call lines are deferred + keyed by call id so the agent's concurrent path
  (all tool_calls, then all tool_results) pairs correctly. `cols` is threaded transcript → Markdown so both
  the committed and streaming renders are width-aware.

## 2026-07-01 — Self-improve loop, Z.ai/glm-5.2 provider UX, web-reading overhaul

A long session on the `self-improve` branch (39 commits ahead of main, all green: typecheck + 233 tests
+ policy + build). Three arcs; everything stays on the branch for review (main untouched at 3b7091a).

**Self-improvement loop (Neko improves Neko).** `scripts/self-improve.ts`: glm-5.2 (Z.ai plan) edits Neko
→ a hard VERIFY GATE (typecheck + 0-fail tests + policy) → an INDEPENDENT model peer-reviews the diff via
`scripts/review-diff.ts` → commit to the branch, else revert; when stuck it web-searches SOTA and refills
`docs/self-improve/BACKLOG.md`. Bench got per-task metrics (time / in-out tokens / tok-s / steps) + a JSONL
dev-log (`~/.neko-core/bench-log.jsonl`) + a harder tier. Ran unattended in ~50-min batches and produced
FOUR genuine, verified, reviewed harness wins: `estimateTokens` counts tool_calls (overflow-guard
accuracy); `compact()` char-based lean-tail clip (dense-output token win); a broad doom-loop guard (later
softened to warn-not-block, cap 6, on audit); and a real SECURITY fix — the bash seatbelt was bypassable
by quoting the target (`rm -rf "$HOME"`). Honest yield: ~1 real win per 2-3 segments, then a plateau — a
disciplined assistant, not a perpetual-motion machine (matches the feasibility analysis). Loop bugs found
+ fixed along the way: reviewer routed through `neko run` got DENIED tools → a real `--no-tools` flag +
provider-direct reviewer; `ensureBranch` used `-B` (reset) → continue-branch; the worker self-committed
past the gate → forbidden + un-committed; a flaky session test wrote the user's real `~/.neko-core/sessions`
(2234 files) → isolated to a temp HOME.

**Provider / model UX (Z.ai + glm-5.2).** New `anthropic` provider → the Z.ai coding-plan endpoint (glm-5.2;
effort → extended-thinking budget). Per-provider keys via `key_env` + config, so a new provider is a profile,
not a code change. Fixed the 401 trap (a top-level api_key shadowed the profile's; `setApiKey`/`/login` now
save to the ACTIVE profile). `/login` = guided wizard (pick provider → paste its key); `/provider` switches
account then CHAINS into that provider's model picker (`Agent.setProvider` + `NekoConfig.adopt` — live, no
restart); `/model` swaps model within the current provider. No flags, no config editing.

**Web reading — full overhaul.** Studied clean-room (in `../neko-refs/`, source-audited before running):
Obscura (a Rust headless browser — built + tested, but it JS-errors on heavy SPAs like FB Comet, so NOT
adopted), Hermes Agent (its "60x faster / 49x cheaper" = clean markdown + skip-the-LLM-on-small-pages +
paginate), Agent-Reach (a per-platform free-backend router; installs a browser-session bridge for social
logins). Shipped:
- `web_fetch` returns deterministic **Markdown** (`htmlToMarkdown`: keeps links/headings/lists; no model
  call). Hermes size policy: small page → no model call; large page → **paginate** (`page:N`) + 5-min cache
  instead of truncating and losing content.
- Opt-in `scrape_backend: "jina"` → Jina Reader renders public SPAs → markdown (free/keyless).
- **Deterministic platform routes** in `web_fetch` (CODE, not a skill the model can ignore): YouTube →
  `yt-dlp` transcript, GitHub → `gh`, RSS/Atom → item list; each falls back to a normal fetch if the tool is
  missing. Real test: a YouTube task on gpt-oss went from 7 calls / 48-56k tokens (fumbling fake transcript
  sites) to **2 calls / 16k tokens**.
- Skills `web-reading` (efficient reads: a11y/markdown first, grab-once, no scroll-churn) + `web-reach`
  (platform routing + honest ToS/account-ban warning for logged-in social feeds). Skills gained a
  frontmatter `match:` regex so `matchSkill` loads a domain skill DETERMINISTICALLY (token-overlap was too
  coarse — web-reach was silently never loading). The doom-loop guard was generalized to nudge on N
  consecutive EMPTY/failed results from ANY tool (the FB scrape-thrash the edit/exact guards missed).
- Login platforms (FB/X/IG/LinkedIn) are deliberately NOT auto-routed — they need the user's session and
  carry ToS/ban risk, so they stay with the browser MCP + the skill's warning. Key finding: loading a skill
  ≠ the model following it (gpt-oss ignored web-reach's routing) — the reliable fix is the tool layer, not a
  skill.

Version bumped 0.4.0 → 0.5.0-dev; the branch builds + is installed locally as `neko`.

## 2026-06-29 — Computer-use: independent pointer, web-via-a11y, tab presence

Built `skills/computer-use` into a real, config-first, composable capability — Neko USES the
computer, on the user's real visible machine, with its own pointer that doesn't hijack the mouse.

**Grounding + action (no GUI-trained model, mostly no vision):**
- `uia.ps1` — the Windows accessibility tree as the desktop DOM: `list` (actionable elements +
  verb + exact coords), `invoke`/`setvalue`/`toggle` (UIA patterns — act with NO cursor), `get`
  (verify), `read` (dump a page/doc as TEXT to summarize). CacheRequest beats the FindAll timeout
  on rich WinUI/WPF trees. Unicode targets via `@<utf8-file>` (the cp1252 console mangles Vietnamese
  args; invoke-by-name is layout-independent — coord taps on a reflowing feed are fragile).
- `inject.ps1` — **independent agent pointer** via Windows TOUCH INJECTION
  (`InitializeTouchInjection`/`InjectTouchInput`): tap/dbltap/stroke on the visible desktop WITHOUT
  moving the user's mouse (verified: drew in Paint with the real cursor parked, unmoved). No driver,
  no admin, Win11-Home OK.
- `mouse.ps1` — legacy SendInput (moves the one system cursor); when `NEKO_INPUT=inject` it
  transparently delegates the acting verbs to `inject.ps1`.
- `overlay.ps1` — the VISIBLE agent cursor (blue triangle, flies to where Neko acts) + a presence
  banner; now also a **tab/window indicator**: reads `neko_active_window.txt` and frames + labels
  the exact window/tab Neko is using ("NEKO dang dung tab nay: <title>").

**Config-first (a backend/flag, not a code change):** `computer_use_overlay` -> `NEKO_PRESENCE`
(overlay + takeover); `computer_use_input: "inject"|"sendinput"` -> `NEKO_INPUT` (which pointer
backend). Helpers also publish `NEKO_DRAW_WINDOW` to the active-window file for the indicator.

**Web via accessibility (reuse the logged-in browser, no CDP, no credentials):** launch Chrome with
`--force-renderer-accessibility` so `uia.ps1 read` sees the page DOM as text. gpt-oss AUTONOMOUSLY
browsed + summarized a live Facebook feed (read -> scroll via inject -> summarize), and opened +
composed a post by invoking the composer BY NAME. Posting capability proven end-to-end; the final
irreversible publish is left to the user's explicit go.

**Honest findings (dead ends documented so we don't repeat them):** Chrome 149 blocks CDP on the
default profile; Chrome 127+ App-Bound Encryption blocks cookie-copy (so a copied profile loses the
login) -> `--force-renderer-accessibility` on the default profile is the clean reuse path. UWP apps
suspend their UIA tree when fully hidden (keep visible). For read-heavy turns, lower `reasoning_effort`
so the model emits the answer instead of over-reasoning into the output-token cap.

**Independent cursor — the answer:** Windows has ONE *mouse* cursor (a 2nd OS arrow needs a kernel
driver). But it has SEPARATE pen/touch input channels, so Neko's pointer = touch injection (acts,
mouse untouched) + the overlay triangle (visible) + the tab frame (which window). Functionally its
own cursor on the same screen; true hidden/background or game control still needs a VM (isolation).

## 2026-06-22 — Session 1: port → harness → go-live

**Ported the coding-agent core out of the frozen `bang_c` (PORTING steps 1–6):**
- config-first (layered overlay + named profiles); providers (`openai_compat` +
  optional `local_llamacpp`) behind one `complete(messages, tools)` contract.
- tool contracts + executable tools: `read_file`/`search` (safe), `write_file`/`bash`
  (gated, approval gate, path-escape refused).
- registries + a real `policy` audit of the safe/gated boundary.
- the agent loop (`complete → tool_calls → observe`, `max_steps` cap); `neko chat`/`run`
  + `--yolo`. 38 pytest tests green.

**Configured the Claude Code harness (full-lean):** `CLAUDE.md`, `.claude/settings.json`
(allow verify-loop, deny edits to `bang_c` + reads of secrets), `.claudeignore`, slash
commands `/verify` `/secret-scan` `/port-module`. (A `neko-explorer` subagent file exists
but per the no-subagent rule we don't use it — kept only as an optional, dormant artifact.)

**Went live:** wired an NVIDIA NIM endpoint via `~/.neko-core/config.json` (key via JSON,
never committed); model `qwen/qwen3-next-80b-a3b-instruct`. Verified end-to-end: the model
called `read_file` and answered correctly.

**Shipped:** merged + pushed to `origin/main`. Installed `neko` via `pipx` (editable);
resolved the name collision with the heritage CLI (heritage stays reachable as `bang-c`).

**Fixed REPL resilience:** survives any turn failure (prints the error, stays at the
prompt), clear API-error messages, EOF / non-TTY diagnostics instead of silent exit.

### Decision — language/runtime: **TypeScript + Bun + Ink** (owner, 2026-06-22)
Evaluated on merits (no sunk-cost; project still small). TS is the proven stack for this
product category (Claude Code, Gemini CLI, opencode all TS+Ink), MCP reference SDK is TS,
Bun compiles to a native binary (drops the Node-runtime dependency), and the team already
ships TS (wiii-desktop). "Offline-first" needs only a local OpenAI-compatible server
(llama-server/Ollama) — no in-process inference, so no Python advantage. Go/Rust are
reserved for LATER if zero-dependency single-binary distribution becomes the main pain
(the Codex/Goose path). The Python build is kept as the spec under `reference/python/`.

## 2026-06-22 — Session 2: TypeScript rewrite (branch `feat/ts-rewrite`)
- Restructured: Python moved to `reference/python/`; TS project at root (Bun, `src/`, `bin/`).
- **TS Step 1 done** — config-first overlay + profiles + env + key-via-env/JSON
  (`src/config.ts`), `openai_compat` provider over `fetch` with retry/backoff + clear error
  parsing (`src/providers.ts`), `doctor`/`init-user`/`init` + the `neko` CLI dispatch
  (`bin/neko.ts`). Typecheck clean; reads the SAME `~/.neko-core/config.json` as Python, so
  the live NVIDIA profile works unchanged; key shows `set`, never the value.

- **Runtime confirmed: Bun + TS + Ink** (owner). Rust reserved for later (Codex path) —
  Ink TUI + MCP Tier-1 are TS-native, Bun already gives single-binary + fast startup.
- Studying the local `claude-code` (claude-js) tree as a **clean-room reference** for
  UX/UI + logic only (never copy). Goal defined in `ROADMAP.md`.
- **A1 done** — tools + registry + policy in TS (`src/tools.ts`, `src/tool-runtime.ts`,
  `src/registry.ts`); `neko tools/agents/commands/capabilities/policy` wired. Tool runtime
  verified (read/search/write/bash, path-escape refused, denial-as-string, safe-under-deny).

### Next (TS) — see ROADMAP.md
- A2 agent loop + `neko run`; A3 real tool set (edit/glob/ls); A4 streaming + cost.
- B1 Ink chat REPL; B2 slash commands; B3 permission modes. C1-C3 project context / resume / MCP.
- D1 tests; D2 single binary + re-point `neko`; D3 rename to Neko Code + merge.

- **A3 done** — coding tool set: `edit` (unique string replace, gated), `glob` (Bun.Glob), `ls` (safe). 7 tools total; coder/explorer agents + policy updated.
- **A4 done** — SSE streaming in the provider (`complete(.., onDelta)`) + token tracking (`src/cost.ts`). `neko run` streams the answer live and prints a token usage line.
- **B1 done** — Ink chat REPL (`src/ui/chat.tsx`): streaming render, interleaved tool lines, inline approval (y/a/n), spinner, one Agent across turns. Deps: ink@7/react@19/ink-text-input/ink-spinner. `neko chat` launches it (lazy import).
- **B2 done** — slash commands (/help /cost /model /profiles /init /clear /reset /exit), input history (up/down), multiline (trailing backslash) in the Ink REPL.
- **B3 done** — permission modes (`src/permissions.ts`): default/accept-edits/plan/auto; ToolRegistry decides allow/prompt/deny by mode; Shift+Tab cycles in the Ink REPL; doctor/capabilities/policy show mode; NEKO_MODE env override.
- **C1 done** — project context (`src/context.ts`): NEKO.md/CLAUDE.md from cwd→repo root + ~/.neko-core/NEKO.md, prepended to the system prompt; `neko context` diagnostic.
- **C2 done** — conversation persistence (`src/session.ts`): chat saves each turn to ~/.neko-core/sessions/ (keyed by cwd); `neko chat --resume` reloads latest; `neko sessions` lists.
- **C3 done** — MCP client (`src/mcp.ts`): stdio servers from config -> tools as mcp__server__tool (gated by mode); `neko mcp` lists; agent merges MCP + built-in schemas. Verified live against a local echo MCP server (test/fixtures/echo-mcp.ts).
- **D1 done** — bun test suite: 44 tests (config/providers/permissions/tools/runtime/registry/agent/context/session), all pass; typecheck clean.

### Loop paused — D2/D3 need owner sign-off
- D2 (re-point the `neko` command pipx->TS binary) changes the environment; D3 (rename to Neko Code + merge to main + push public) is outward-facing. Both await the owner.

## 2026-06-22 — Session 2 finalize (D2 + D3)
- **D2 done** — bun build --compile single binary (dist/neko, react-devtools-core bundled for Ink); removed Python pipx neko; copied the TS binary to ~/.local/bin/neko.exe. `neko` now = the TS build (live-verified).
- **D3 done** — renamed product to Neko Code (README + CLAUDE.md refreshed; engine = Neko Core); secret-scan; merge feat/ts-rewrite -> main + push.
- **ROADMAP COMPLETE: 14/14 milestones.** Neko Code is a Claude-Code-class TS+Bun+Ink coding agent.

## 2026-06-22 — Session 3: UX/UI parity
- **E1 done** — compared against the local claude-code component surface (App/BaseTextInput/Markdown/Message/FileEditToolDiff/InterruptedByUser...) and reimplemented clean-room: welcome box, bordered input, markdown output, tool bullets, spinner+elapsed, Esc-to-interrupt (AbortSignal), approval box with diff preview. ASCII-safe. Approval gate now passes tool args (for diff). Binary rebuilt + reinstalled.
- **E2** slash-command autocomplete menu (filtered list under the input when typing /). Verified via headless render + snapshot.
- **E3** activation: bare `neko` (and `neko code` / `neko core`) now starts the session (no need for `neko chat`); `neko chat` still works. --help/--version/other commands intact.

## 2026-06-22 — Session 4: full polish (studied claude-code clean-room)
- **E4** syntax highlighting · **E5** markdown tables · **E6** input queue while busy (status shows N queued) + non-streamed-final render. 53 tests pass; verified via rendered snapshots (table aligned, code highlighted, queue drains).

## 2026-06-22 — Session 5: i18n fix + pro UI (+ ponytail skill)
- **Fixed Vietnamese/IME input**: replaced ink-text-input with a tiny Ink-native input (src/ui/text-input.tsx) that appends decoded keypresses + NFC-normalizes, codepoint-safe. No more 'chuúng'/'hệ hệ' duplication.
- **Redesigned TUI** toward Claude Code: dropped heavy +--+ boxes; cat logo header + dim subtitle, thin full-width rule, clean '> ' prompt, two-column bottom status bar (mode·shift+tab left, model·tokens right). Removed ink-text-input dep.
- Installed the **ponytail** skill (~/.claude/skills) and used it (minimal-code mode) for this pass. Studied claude-code components clean-room.
- **Logo**: baked assets/neko-core-banner.png into src/ui/logo.tsx as magenta half-block art (scripts/gen-logo.ts, pngjs devDep; no runtime decode). Welcome shows it + dim version/model/path.
- **Logo redesign**: dropped the big pixel-art 'NEKO CORE' wordmark + the PNG-bake machinery (gen-logo.ts, pngjs). Now a small cool cat mascot (shades, orange) + 'Neko Code' as clean text — Claude-style. src/ui/logo.tsx is a tiny component.
- **Vietnamese fix v2**: root cause was stale-closure in the controlled input (IME sends backspace+char back-to-back; both read the stale value -> 'moọi'). Now value lives in a ref, mutated synchronously. Test reproduces 'mọ' not 'moọ'.
- **Logo**: cat now matches the banner glyph (/\··~▽, ハ‥マ style) inline with the title.
- **Micro-UX**: tool calls show a green ● bullet + dim ⎿ result; assistant messages get vertical breathing room.

## 2026-06-22 — Session 6: features (markdown/loop/tools/skills)
- **Markdown**: blockquotes (│) + links ([text](url) -> text). 
- **Loop**: agent emits step N; chat status shows 'step N'.
- **Tool mgmt**: ToolRegistry.disabled; chat /tools lists, /tools <name> toggles (hidden from schemas + blocked).
- **Skill system**: src/skills.ts loads *.md from ~/.neko-core/skills + ./.neko-core/skills; neko skills, chat /skills + /skill <name> (injects into system prompt via Agent.appendSystem). Example skill: ~/.neko-core/skills/concise.md.

## 2026-07-04 — Fullscreen arc (P1-P5 + rich scrollback) + line-by-line audit
- **Research first** (owner asked): studied the local claude-code Ink fork clean-room (terminal.ts BSU/ESU + DECRQM querier, AlternateScreen, ScrollBox/useVirtualScroll, VirtualMessageList) + web SOTA to 2026-07 (DEC 2026 spec, Ratatui cell-diff, Textual compositor, Ink's no-ScrollView limitation). Wrote docs/design/fullscreen-mode.md, then built it phased.
- **P1** Synchronized Output (sync-stdout.ts): BSU/ESU per frame write on supporting terminals (env allowlist; NEKO_SYNC override) + DECRQM probe pre-Ink for SSH. **P2** alt-screen + app-owned scroll viewport (altscreen.ts guard restores on exit/signal/crash; scroll.tsx flatten/useScroll/ScrollRegion; /fullscreen, NEKO_FULLSCREEN). **P3** SGR 1006 mouse wheel (mouse.ts) + text-input hardening (CSI residue never lands in the prompt). **P4** Ctrl+F in-viewport find (highlight + n/N + badge). **P5** canFullscreen guard + inline degradation. **Rich scrollback**: rich-transcript.tsx renders real TranscriptLine (markdown/diff/syntax) with flex-end sticky + negative-margin scroll (verified Ink clips), memoized, 300-line cap. **/copy** via OSC 52.
- **Audit pass** (owner asked to re-check every line): found + fixed 4 real bugs: (1) toggling fullscreen OFF lost the transcript - Static's one-time reprint landed in the discarded alt buffer because the screen switch ran in a post-render effect; now switches synchronously in the toggle (regression test asserts leave-alt precedes the reprint). (2) Esc closing the find bar mid-turn also aborted the model (both hooks fire); abort hook now gated on find/viewer closed. (3) Ctrl+L/Ctrl+O still fired while the find bar owned the keys. (4) /copy all reported the UNCLIPPED length while OSC 52 clips at 60k - now reports the clip honestly. Plus: alt-screen enter now writes explicit 2J+H (cursor pos after 1049h is unspecified); PgUp/PgDn work over the find bar.
- Suite 312/0 · typecheck/doctor/policy/build PASS · binary reinstalled. 46+ commits on self-improve await owner push approval.
- **Perf/micro-UX pass** (same day): flat rows now computed ONLY while find is open (was re-flattening the whole transcript on every fullscreen render); useScroll sticky offset is DERIVED, not effect-chased (removes one render per appended line while streaming; handlers pure); fullscreen stream preview clamped to ~10 rows (was rows-12 = viewport collapse/bounce during long replies); Esc-close of find re-pins to bottom (flat/rich row domains differ - staying put landed oddly); Home/End jump top/bottom. +2 useScroll probe tests. 314/0.
- **Fullscreen v2 after owner field test** (121-msg session = severe lag + broken layout): root causes were (a) mounting the WHOLE thread rich and re-laying it out every frame (O(conversation)/frame) and (b) the side scrollbar column wrapping when wide content overflowed the body column. Rearchitected to the Static-economics model: pinned tail = rich render of ONLY the last viewH+8 lines (O(viewport)/frame, bottom-anchored); scrolled-back history = flat single-column O(viewport) window (1 row = 1 truncated Text - cannot misalign); scrollbar REMOVED (owner: not wanted); Claude-style centered pill when scrolled up - "Jump to bottom (End)" or "N new messages - End to jump" (counts turns landing while reading history); End/bottom-reach returns to the rich tail. RichTranscript -> RichTail (no measurement, no margin scroll); contentH plumbing deleted. 315/0.
- **Fullscreen v3 - smooth scroll** (owner: scrolling still felt bad vs claude-code; wants ctrl+End + a CLICKABLE pill): (a) killed the rich->flat mode-switch flash - scrolling now windows the SAME rich rendering by LINE index (RichView bottom prop; useLineScroll), so every scroll position looks identical to the live tail, still O(viewport); flat rows remain only for the find bar. (b) pendingDelta coalescing (claude-code ScrollBox trick): wheel/key deltas accumulate in a ref and flush once per ~33ms frame - a fast spin is one big move, not a queued render per tick; parseWheelAll also counts MULTIPLE reports batched in one stdin chunk (previously only the first counted - the "lags behind the wheel" bug). (c) pill is now clickable: parseClick reads SGR left-press coords; the pill sits on the row right below the measured viewport (y == viewH+1) - click jumps to the tail; label says ctrl+End (claude parity), plain End works too. 316/0.
- **Fullscreen v4 - MEASURED on the owner's real laggy session** (dkt1, 123 msgs, "hu"): built scripts/bench-ui.ts, numbers before: RichView mount 5.3s, 1.2s/frame re-render, ~1000ms/KEYSTROKE. Two root causes, both fixed: (1) rich components re-laid-out every frame -> new ansi-cache.ts renders each line to ANSI rows ONCE in a hidden debug-mode Ink instance (claude-code staticRender pattern, clean-room; gotcha: passing stdin:undefined explicitly makes Ink emit empty frames - must omit the key); viewport pastes cached string rows; background warmer newest-first with a 25ms time budget per chunk; unwarmed lines show a plain fallback row and upgrade in place; scroll re-anchored as distance-from-end (useRowScroll) so upstream row swaps never move the view. (2) THE BIG ONE: bun build --compile leaves NODE_ENV=development -> the SHIPPED BINARY ran React in dev mode (~5x render overhead) since day one, inline included; build script now bakes process.env.NODE_ENV=production (verified via compiled probe). After: ~15ms/keystroke steady-state (67x), scroll ~47ms/burst. 317/0.
- **Cross-platform perf guarantee** (owner: not just Windows): the NODE_ENV=development hole existed in RELEASE builds too - release.yml compiled all 5 platform binaries (linux x64/arm64, macos arm64/x64, windows x64) without the define, so every released binary on every OS shipped dev-mode React (~5x render overhead). Now bakes production (shell:bash on all runners for identical quoting). CI upgraded from ubuntu-only to a 3-OS matrix (ubuntu/macos/windows - typecheck+test+policy+build on each), so "works on every platform we ship" is enforced, not assumed. The computer tool now fails honestly on non-Windows ("Windows-only - UI Automation via PowerShell") instead of a confusing spawn error. Audited the platform-branch surface: clipboard (win/mac/linux paths), mcp-oauth open, sandbox (bwrap/sandbox-exec/git-bash), update assetName (matches all 5 release assets), sync-output allowlist (Apple Terminal correctly excluded - no DEC 2026) - all sound. 317/0.
- **Platform follow-ups**: computer tool now HIDDEN from the model's schema on non-Windows (listTools filter; the runtime refusal stays as backstop for replayed sessions) - better than refusing after the call. Found+fixed a real self-update bug: the comment promised "<exe>.old cleaned next launch" but no code did it, and the in-place delete always fails on Windows (the old exe is locked by the running process) -> stale neko.exe.old forever; cleanupStaleUpdate() now sweeps it at startup (lazy import, never throws). +1 test. 318/0.
- **HOTFIX - the production define broke the binary** (owner hit "jsxDEV is not a function" on launch): bun 1.3.x emits DEV jsx callsites (jsxDEV) whenever the tsconfig sets jsx:react-jsx - regardless of the NODE_ENV define or env var (verified with a resolve-oracle matrix) - while the define resolves react/jsx-dev-runtime to its production build, which has NO jsxDEV -> instant crash at first render. The test suite runs from SOURCE (consistent dev/dev), so it could not see an artifact-only mismatch; my --version smoke didn't touch JSX. Fix: tsconfig.build.json (no jsx field) via --tsconfig-override for bun build only (tsc keeps jsx for typechecking) -> bun picks react/jsx-runtime (production). And the class is now fenced permanently: hidden `neko __uiprobe` renders a real Ink/JSX tree headlessly in the COMPILED binary; `bun run build` chains it, release.yml smoke-runs it on same-arch runners. Verified: ui-ok (NODE_ENV=production) from the installed binary. 318/0.
- **Fullscreen v5 - the real-terminal write path** (owner: still laggy vs inline; benches looked fine): the cost benches could not see lives in the TTY write path. Two findings from reading Ink 7.1's source: (1) ink #969 - on WINDOWS consoles, any frame >= viewport height makes Ink CLEAR THE WHOLE TERMINAL every render (consoles scroll on the bottom-right cell); our fullscreen root was height=rows -> full clear + full repaint per keystroke on the owner's machine, invisible to fake-stdout benches (isTty=false skips that branch). Root is now rows-1 (one spare row buys the incremental path). (2) Ink 7.1 ships a first-party LINE-DIFF renderer (incrementalRendering option, default off) - unchanged lines are not rewritten. Now on (NEKO_INCR=0 escape hatch). Verified via a fake-TTY probe on the real log-update path: 752 -> 130 bytes/write (5.8x) on a small tree; on the real 40-row ANSI frame a keystroke now rewrites ~the input line instead of the screen. bench-ui now also reports bytes/key (the terminal-side cost proxy) + documents the isTTY limitation. 318/0.
- **Resize ghost-frames regression + scroll input-lag** (owner image evidence): (1) ENLARGING the window rewraps old frame lines but Ink clears only on width DECREASE - its cursor bookkeeping desyncs and every later render paints at the wrong offset (stacked input boxes/dividers); the incremental renderer made ghosts permanent (skips "unchanged" lines). Resize now debounces 150ms then does the full reset: Ink's own clear() -> explicit 2J wipe (through the BSU/ESU wrapper) -> Static remount re-emits the transcript at the new width; fullscreen repaints from state + ANSI cache re-warms via its width key. Regression test emits a resize and asserts wipe + re-emit. (2) useRowScroll flush was trailing-only: every first wheel notch waited a fixed 33ms before the view moved - reads as input lag. Now leading-edge (first tick moves IMMEDIATELY) + a 33ms trailing window coalesces the rest of the burst. Design doc: honest note on why claude-code scroll is smoother (own cell-diff compositor) + the documented next rung (damage-split + DECSTBM hardware scroll region) if the field test still says not smooth. 319/0.
- **Fullscreen v6 - Neko's own compositor-lite** (owner: "can't we do it like claude-code?" - yes): new src/ui/frame-diff.ts intercepts Ink's standard full-frame payloads at the stdout layer (the wrapper we already own), diffs line-by-line, and emits minimal bytes: unchanged lines skipped; identical frames skipped entirely; and in fullscreen a viewport SCROLL is detected (new lines == prev shifted by k, <=2 noise rows) and emitted as the terminal's HARDWARE scroll - DECSTBM sets the band as scroll region, SU/SD shifts it, only the k revealed rows are painted. A 3-row scroll now writes ~3 rows + escapes (~200 bytes) instead of the whole viewport (~5KB); the terminal moves the pixels. Safety: the parser accepts ONLY Ink's exact standard payload shape (Neko never uses Ink's cursor feature, so prefix/suffix are empty); anything else (wipes, alt-switch, clear, OSC) passes through untouched + resets the baseline. Ink's incrementalRendering turned back off (its diff payloads are unparseable; ours supersedes it, and now inline gets line-diff too). Correctness locked by a virtual-terminal test suite: the optimized bytes are replayed through a tiny VT interpreter (CUP/CUU/CUD/EL/SU/SD/DECSTBM) and the final grid must equal a full rewrite - scroll up, scroll down, chrome tick, height change fallback, OSC passthrough. NEKO_INCR=0 disables the differ. 324/0.
- **Measured v6 on the TTY path + fixed the bug the bench caught**: new scripts/bench-tty.ts reproduces the EXACT runChat wiring (fake TTY stdout -> FrameDiffer -> BSU/ESU wrapper, fake raw stdin) so Ink takes its real log-update path. First run exposed a real bug: Ink 7 emits its OWN BSU/ESU as separate writes (write-synchronized.js) and each one RESET the differ's baseline -> differ ON produced byte-identical output to differ OFF. Fix: pure private-mode control writes are NEUTRAL (passthrough, baseline kept) + regression test. Fresh-process A/B on the owner's real 123-msg session: keystroke 1856 -> 74 bytes/key (25x), scroll step 1971 -> 240 bytes (8.2x) with DECSTBM+SU/SD confirmed in the byte stream; CPU identical ON vs OFF (261 vs 266 ms in the inflated dev-runtime env - the differ costs nothing). Also found the jsxDEV mismatch reproduces in `NODE_ENV=production bun <script>` dev-runs (transform/runtime split is a bun-runtime issue too, not only build) - benches run self-consistent dev mode; bytes are runtime-independent. 325/0.
- **"Everything lags on a really long session in fullscreen" - root-caused**: the ANSI warmer rendered the ENTIRE session through the hidden Ink instance (hundreds of lines x 30-400ms each = tens of seconds of saturated event loop with only setTimeout(0) gaps) - scroll, typing, streaming, everything starved; inline never warms, hence "inline is fine". Fixes: (1) warm is now WINDOWED - last WARM_WINDOW=300 lines eagerly + an 80-line span around wherever the user scrolls (scrollCenterBucket walk, O(depth), bucketed per 40 lines); distant history shows instant fallback rows and warms on approach. Budget 12ms/chunk with 16ms gaps (input/stream get air). (2) footer ctx% estimateTokens cached by messages.length (was walking a multi-MB resumed transcript on EVERY stream delta during the whole first turn). (3) RichView React.memo (viewport bails out of pure stream-delta re-renders). +1 windowed-warm test. bench-tty re-verified: 69 bytes/key, hardware scroll still active. 326/0.
- **Fullscreen v7 - compose-at-the-write-layer** (owner: entry now instant but typing/scroll still delayed): the remaining per-keystroke cost was Ink's OUTPUT pass itself - regardless of React.memo, every render re-squashes/re-outputs (slice-ansi) the ~38 heavy ANSI viewport rows; measure/wrap are string-cached but squash+Output assembly are not. Fix: the Ink tree now renders the band as BLANK lines (an empty fixed-height Box - Ink pays ~zero for the viewport), and the FrameDiffer splices the real rows into every frame (compose) and repaints scrolls IMPERATIVELY (setBandContent: diff window vs previous band, hardware shift when detected, no Ink render at all). Seed/resync frames emit the composed full frame (raw passthrough would paint the blank band). RichView remains for the NEKO_INCR=0 path. bench-tty: keystroke work 230ms -> 9.4ms/key (dev-mode; ~25x - typing in fullscreen now costs the same as inline), 178 bytes/key, scroll 207 bytes/step with DECSTBM+SU/SD confirmed. Virtual-terminal test extended: composed seed, keystroke leaves band untouched, dist change emits hardware shift with cursor restored. 327/0.
- **60fps pipeline** (goal loop continues): Ink's default maxFps=30 adds a ~34ms render throttle - felt as typing echo latency even with the v7 tiny chrome frame. Now maxFps:60 (the chrome frame is ~8ms work, comfortably in budget) and useRowScroll's trailing coalesce window 33->16ms to match - the whole input->echo and wheel->shift pipeline runs at ~60fps with leading-edge immediacy. bench-tty: 7.8ms work/key, 183 bytes/key, scroll 207 bytes/step + hardware shift. 327/0.
- **Fullscreen v8 - glide scroll + black-screen + gutter (owner field report, image-verified)**: (1) BLACK SCREEN on resize/entry in fullscreen: the inline resize wipe was the culprit - clearScreen()'s log.sync makes Ink believe its frame is still painted, so after our 2J nothing rewrites until a keypress changes the output. Fullscreen resize now skips the wipe entirely (alt screen has no rewrap ghosts) and just resets the differ -> the dimension-change render emits one full COMPOSED rewrite. (2) Text flush against the edge: the differ paints at column 1 and cached rows carry no gutter (the Ink Box used to pad) - band rows now get the same 2-col left pad, memoized per rows-change (never per scroll frame). (3) Scroll now GLIDES: useRowScroll keeps shown vs target; gestures move the target, the shown position eases half the remaining distance per 16ms frame (min 1 row, first hop immediate) - each hop is a small hardware shift, so a flick reads as momentum instead of page teleports. +2 tests (glide probe; pad via compose). 328/0; bench steady (185 B/key, hw-scroll active).
- **Fullscreen v9 - black screen REPRODUCED + killed, glide at 60fps (owner asked for full measurement)**: built the deterministic reproduction the bug class needed - test/vt.ts (a VirtualTerminal interpreting everything the pipeline emits: frames, CUP/EL/SU/SD/DECSTBM, DECSC/DECRC, private modes, OSC) + test/fullscreen-sim.test.ts (REAL ChatApp, production wiring, every byte replayed into the VT; asserts the screen is never blank across entry/typing/grow/shrink). First run reproduced the entry black screen immediately. Root cause: the alt-screen effect had [fullscreen] deps - after v8 made the toggle install the guard synchronously, the effect's cleanup+reinstall fired AFTER the first fullscreen paint (leave alt -> re-enter -> 2J) and Ink, seeing unchanged output, never repainted -> black until a keypress. The effect now owns ONLY mount (cfg-start) + unmount; toggle owns all runtime transitions. Sim passes all 9 assertions. FPS: added a glide-cadence meter to bench-tty (interval between repaint writes) - measured 28ms avg/51ms max; two fixes: hops now repaint DIRECTLY through the differ (React only renders at gesture edges - pill mount/settle), and the hop timer is drift-compensated (subtract measured timer overshoot) -> 18.0ms avg / 26.9ms max (~60fps). 329/0.
- **Configurable frame rate (owner asked for 90/120fps)**: new `ui_fps` config / NEKO_FPS env (default 60, clamped 30..240) drives BOTH Ink's maxFps and the glide hop interval (drift-compensated at any rate). Physics documented honestly: above the display's refresh the extra frames are never shown; conpty adds its own ~5-15ms/direction floor; terminals scroll in whole rows (no pixel interpolation) so gains past ~90Hz are subtle. On a 120/144Hz monitor, `ui_fps: 120` gives measurably tighter glide (bench: hop cadence tracks the target; bench env floors ~15ms, the production loop is lighter). +1 config test (default/override/clamp/env). 330/0.
- **Auto fps by display + /fps (owner's 144Hz ask, comfort-first)**: new adapters/display.ts detects the monitor's refresh rate per-OS (Windows WMI CurrentRefreshRate, macOS system_profiler, Linux xrandr) - async subprocess, never blocks startup, cached 7 days in ~/.neko-core/.display.json (live-verified on the owner's machine: 144Hz in 617ms). Resolution layering (resolveUiFps): NEKO_FPS > config ui_fps > /fps pref > detected Hz > 60 - zero-config users just get their display's rate. First run in auto mode: session starts at 60, detection lands -> scroll glide adapts LIVE + a one-line hint; Ink's render cap follows next launch (fixed at instance creation - stated honestly in the hint). /fps command: bare = picker with a machine-aware recommendation ("auto - follow your display (~144Hz)"), /fps 120, /fps auto; choice persists in prefs; when env/config override the choice, it says so instead of pretending. +4 tests (cache valid/stale/garbage, full layering, clamp). 333/0.
- **Mouse-report leakage (owner images: "[<64;97;33M" spam in the /fps picker filter AND in the PowerShell prompt after exit)**: two roots. (1) TERMINAL STATE, not process state: DECSET 1000/1006 stays enabled when a session dies uncleanly (taskkill during binary reinstalls, crashes) - the next session AND the user's shell then receive raw wheel/move reports as text. runChat now disables mouse tracking unconditionally at startup (clears stale state from any predecessor) and again in the exit finally (never leaves the user's shell in mouse mode). (2) Input guards were incomplete: SelectList's type-to-filter and rename had NO escape-residue guard, and the existing guards only matched a SINGLE sequence - fast-wheel BURSTS ("[<0;97;33M[<64;97;33M...") in one chunk leaked everywhere. New shared isEscapeResidue() (matches one-or-more concatenated CSI residues, ESC optional) used by TextInput, SelectList (filter + rename), and the fullscreen find bar. +1 test (burst matcher). 334/0.
- **Jump-pill hover (owner ask: clear hover UX)**: real hover in a terminal needs ANY-motion tracking - DECSET 1003 now enabled alongside 1000/1006 in fullscreen (motion reports are cheap: parsed, deduped by React state bail, dropped by the shared guards elsewhere; startup/exit hygiene covers 1003 too). New parseLastPointer() (last event of a burst wins; move/press/release/wheel classified); parseClick now REJECTS motion reports (hover can't click). The pill's label + centered hit-box are computed once and shared by BOTH the hover highlight and the click handler - what glows is exactly what works (hover: blue bg + black text + bold; ±2 col forgiveness). Pure moves/releases are consumed; clicks and wheels fall through. +2 tests (pointer parser incl. burst last-wins; click-vs-motion). 336/0.

## 2026-07-05
- **TypeScript 7 native preview (tsgo, Go rewrite) adopted for the typecheck gate** (owner asked about upgrading from 5.9.3): measured on our codebase - tsc 5.9.3 --noEmit 4.3s vs tsgo 7.0.0-dev 0.85-2.0s (2-5x), IDENTICAL verdict (both clean). Since bun strips types at runtime/build, the TS version never touches the shipped binary - it is purely the dev/CI gate - so the preview is safe to adopt with a belt: `bun run typecheck` now runs tsgo (the verify loop runs before every commit; 5x matters), `typecheck:tsc` keeps stable 5.9 available, and CI runs BOTH on all 3 OS until 7.0 goes stable (any tsgo/tsc divergence fails CI loudly). Drop the cross-check step at 7.0 GA.
- **Upgraded to TypeScript 7.0.1-rc proper** (owner: "len 7.0 luon?"): the main `typescript` package now ships the Go compiler at the `rc` tag (JS line is 6.0.3 stable). devDep typescript = 7.0.1-rc - `tsc` IS the native compiler now (1.0s on our codebase, was 4.3s on 5.9.3; verdict identical, 0 diagnostics). @typescript/native-preview dropped (redundant). Safety belt until GA: `typescript5` npm-alias keeps 5.9.3 installed, `typecheck:stable` runs it, CI cross-checks both on all 3 OS - drop alias+step at 7.0 GA. Product untouched (bun strips types; binary byte-identical concern is nil). 336/0.
- **Fullscreen top-anchor + terminal tab titles (owner images)**: (1) entering fullscreen on a short session dumped the welcome at the BOTTOM with a void above - windowRows/RichView bottom-anchored even when content did not fill the viewport; short content is now TOP-anchored (pad blanks below, flex-start), full content keeps chat auto-follow. (2) claude-code-style tab titles, clean-room: new src/ui/title.ts - OSC 2 set + xterm TITLE STACK (CSI 22;0t / 23;0t, WT-supported) so the user's original tab title is restored on exit. Startup brands "neko - <dir>"; each turn sets "* neko - <task>" (star = busy) and drops the star on finish; writes go STRAIGHT to process.stdout (never through the differ; no-op off-TTY). /title <name> names the SESSION (renameSession -> shows in /resume) and pins the tab (auto-updates stop); bare /title reports state. +2 tests (top-anchor compose; title sequences incl. control-char strip). 338/0.
- **Fullscreen is now the DEFAULT** (owner: "it's really good now - make it default, inline should be the thing you opt into"): config.fullscreen flips to opt-OUT (`fullscreen: false` or NEKO_FULLSCREEN=0 for permanent inline; /fullscreen toggles per-session; canFullscreen still auto-falls-back on unfit terminals). Test strategy: bunfig.toml preload (test/setup.ts) pins NEKO_FULLSCREEN=0 as the suite baseline instead of touching dozens of inline-assertion tests; fullscreen tests opt in per-test as before; the sim now sets "0" explicitly for its inline start. Toggle-off message teaches the permanent opt-out. +1 config test (default-on/opt-outs/env-wins). 339/0.
- **HOTFIX before the v0.6.0 push - startup-fullscreen black screen** (owner hit it the moment `neko --yolo` booted into the new default): the TOGGLE path enters the alt-screen before rendering (v9 fix), but the STARTUP path still rendered first (primary screen) and entered alt in the mount effect - wipe-after-paint, Ink believes its frame is on screen, black until a keypress. Fix: runChat installs the alt-screen guard BEFORE render() when starting fullscreen; ChatApp adopts the disposer via prop (toggle-off/unmount tear it down identically). Plus: parseInkPayload's erase prefix is now OPTIONAL - Ink's very FIRST frame has none, and the differ now seeds/composes from it, so the band paints on frame #1 instead of staying blank until render #2. New STARTUP sim test: guard pre-render, zero input, screen must show the transcript. 340/0.
- **Pre-push sweep round 2 (owner image #30 + direction)**: (1) mouse-report spam in the SHELL after neko died: a CAUGHT crash (bin/neko.ts main catch - the jsxDEV path) bypasses the guard's uncaughtException handler entirely -> alt screen + mouse tracking left on. New emergencyRestore() (cursor + mouse off + leave alt + title pop; every sequence a no-op when clean) now runs in bin's catch AND runChat's finally. (2) Fullscreen streaming read as "generating bottom-up": the reply previewed in the CHROME below the viewport then jumped into the band at commit. The stream now flows INSIDE the band, right under the committed rows - plain-wrapped live, styled at commit via the cache; differ gains a bandTail param (windowRows slices across the committed+tail seam in O(H), no per-delta concat); chrome preview hidden in fullscreen; RichView fallback concats. Matches the inline standard: text appears where it will finally sit, top-down. (3) Identity: package.json description + README no longer lead with claude/codex comparisons - "Mot chu meo trong terminal, chi muon meo meo - va lam viec." +2 tests (tail compose; emergency sequences implied by altscreen tests). 341/0. PUSH STILL HELD for owner re-test.
- **Diff gutter colors + richer highlight + fullscreen-exit scrollback echo (owner images #31/#32)**: (1) diff LINE NUMBERS now colored by change kind (added green / removed red, dim = gutter feel) with a bold marker, matching Claude Code's diff readability - the number carries the +/- signal so a wall of edits scans at a glance. (2) highlighter palette widened: literals true/false/null/undefined/NaN as bright-yellow VALUES (distinct from magenta keywords), property access after "." accented cyan-bright. (3) EXIT cleanup: leaving fullscreen (Ctrl+C, /fullscreen off, unmount) closed the alt screen and took the conversation off-screen - runChat now echoes the last ~24 transcript lines to the PRIMARY scrollback AFTER emergencyRestore leaves alt (order matters: writing before leaving lands in the discarded alt buffer). ChatApp fills a scrollbackHolder from a lines ref (fullscreen only; inline already lives in scrollback). +1 highlight test (literals + property). 341/0.
- **Diff/highlight polish to Claude-Code parity (owner image #33)**: (1) template-literal interpolation - `${expr}` inside a backtick string is now broken OUT and highlighted as CODE (dim braces + recursively-highlighted inner expression) instead of one flat green blob; plain '/" strings stay one green token. (2) removed diff lines keep per-token syntax colors but FADED (Text dimColor wrapping highlightLine - Ink inherits dim to children), matching Claude's "going away" look; the red number+marker in the gutter carry the removal signal, so a diff reads like code instead of a wall of red. +1 highlight test (template break-out + plain-string unchanged). 342/0.
- **Mouse tracking STILL leaking into the shell after exit (owner image #34)**: the reports were large-decimal "[555;62;22M" - a DIFFERENT encoding (1015 urxvt / 1016 SGR-pixels) than #30's "[<64;97;33M" SGR. DISABLE_MOUSE only reset the 3 modes we enable (1000/1003/1006), so whatever mode was stuck (terminal/WT quirk or a stale session) survived every cleanup. Two robust fixes: (1) DISABLE_MOUSE now resets EVERY standard mode - 1000/1002/1003/1005/1006/1015/1016 - the canonical full reset vim/tmux emit (disabling an off mode is a no-op). (2) An UNBYPASSABLE process.on("exit") in runChat runs emergencyRestore synchronously - fires on normal return, process.exit, and escaped throws alike, so no teardown short-circuit (hard exit, throw in finally) can leave the terminal dirty. +1 test (disable-all coverage). 343/0.
- **Startup double-input-box ghost (owner image #35)**: on `neko --yolo` boot into fullscreen, the input rendered TWICE (placeholder line + typed line stacked). The VT sim reproduced CORRECT output - so the differ's bytes were right in a faithful model, meaning the bug is real-terminal-only: cursor DRIFT. The line-diff path used RELATIVE cursor moves (ESC[nA/nB from the last frame line), but the band compose + hardware-scroll repaints use ABSOLUTE addressing (ESC[R;1H); on a real terminal an async BSU/ESU flush or a preceding absolute repaint leaves the cursor somewhere the relative math didn't expect -> a changed chrome line painted one row off (and the chrome shifts rows as the startup measure settles). Fix: the line-diff path now uses ABSOLUTE addressing in fullscreen (frame pinned at row 1 by alt+clear+home) - immune to drift AND to the row-shift; inline keeps relative (frame floats in scrollback, absolute row unknown). A reset-on-viewH-change attempt was reverted (reset with no follow-up Ink frame left the band blank - absolute addressing alone is the fix). +1 test (fullscreen absolute / inline relative). 344/0.
- **Stuck mouse tracking from a hard-killed session (owner image #36: spam ON the shell prompt, before neko even starts)**: the pollution is TERMINAL state left by a session that couldn't run cleanup - SIGKILL (my own dev taskkills during reinstalls, a closed window, a crash) never fires process 'exit'. Nothing can clean up AT kill time, so the fix is to de-pollute at the START of the NEXT run: DISABLE_MOUSE (all 7 modes) is now written at the VERY entry of bin/neko.ts main() (before arg parse, guarded on isTTY) AND as the first line of runChat before any await - so any neko invocation, even one that errors early, clears a stuck terminal immediately instead of only after startup finishes. Answer to "do I need to restart?": NO - running the new binary once (or a fresh tab) clears it. NOT a machine problem. 344/0.
- **Live-markdown streaming in fullscreen + toggle-into-fullscreen black screen (owner images #37/#38)**: (1) STREAMING showed RAW markdown (**bold**, ##, |tables|) until commit, then snapped to formatted - because the fullscreen stream tail was PLAIN-wrapped while inline uses live <Markdown compact>. Now the stream tail renders as MARKDOWN LIVE: generalized ansi-cache to renderNodeRows(node,width) and feed the band tail a <Markdown text={clampToRows(renderTail(stream))} compact/> rendered to ANSI rows - formatted AS it streams, tail-clamped so cost stays O(viewport). (2) TOGGLING /fullscreen ON showed a BLACK viewport until a keypress: ansiRows was gated on `fullscreen`, so paddedRowsRef was EMPTY in inline -> the first fullscreen frame had no band content. Now ansiRows computes ALWAYS (cheap: cached rows or plain fallback, no markdown), and toggleFullscreen primes the differ band SYNCHRONOUSLY (setBand + setBandContent) before the re-render. +2 tests (renderNodeRows strips raw markdown; existing toggle sim). 345/0.
- **Input-footer misread + editor caret (owner images #39-#45)**: misread #39/#40 as "extra bottom rule" and removed it - owner wanted BOTH bars (the boxed prompt); reverted, lesson saved to memory (confirm direction before destructive UI changes from ambiguous screenshots). Then the caret arc: inverse-block -> thin green bar; "|" reads gapped (font centers it in the cell) -> LEFT ONE EIGHTH BLOCK (flush against the text); blinks when idle (530ms), solid while typing; mouse reports must NOT hold it solid (isEscapeResidue-gated stamp). 351/0.
- **Streaming markdown was EMPTY mid-stream (self-inspection find)**: built scripts/inspect-ui.ts (real ChatApp -> differ -> VirtualTerminal, deterministic "screenshot") - it caught a React "nested updates from render" warning AND an empty band during streaming. Root cause: renderNodeRows drives the SHARED hidden Ink instance; called inside the main app's render/effect flush, Ink DEFERS the hidden root's commit -> its "synchronous" frame comes back empty. Fix: compute streamRows on a macrotask (setTimeout 0), off the flush. Regression test: a provider that hangs after streaming keeps the reply uncommitted - formatted markdown on screen can only come from the live band (fails without the fix). 346/0.
- **Fullscreen-only decision (owner choice after analysis)**: repeated /fullscreen toggles kept breaking (banner stacking #41, garbled + stacked screen #46 - differ diffing inline frames against a stale fullscreen baseline + Static reprints over the restored primary). Owner picked "fullscreen-only, add copy FIRST": (1) /copy now writes OSC 52 AND the native clipboard (clip.exe UTF-16LE round-trips Vietnamese; pbcopy; wl-copy/xclip). (2) The /fullscreen (/fs) toggle + toggleFullscreen path REMOVED (-104 lines, the whole transition bug class gone); inline is only the canFullscreen auto-fallback; NEKO_FULLSCREEN stays as internal escape hatch + test baseline. 350/0.
- **Drag-to-select + copy, Claude-style (owner images #47-#54)**: fullscreen mouse capture kills native selection, so Neko owns it - left-drag paints a selection over the band (differ setSelection; screen cols map 1:1 to row cols), copies on release with a "copied N chars to clipboard" note. Iterations from owner review: uniform SOLID BLUE block (inverse video read patchy over colored text; inside the block the row's own SGR is dropped, outside preserved + replayed), full-width RECTANGLE (spanned rows + blank lines pad to the content edge), selection PERSISTS after release for the "select then Ctrl+C" habit (Ctrl+C copies it ahead of its usual clear/interrupt/quit), scroll/new-content clears it (screen-anchored). Differ bug found on the way: parseInkPayload swallowed OSC writes - the OSC 52 clipboard escape was being spliced into the band and eaten; OSC introducers now pass through untouched. Copy note lives in a RESERVED always-present status row so it never shifts the transcript (#52 vs #53); the footer's single spare row stays (full-height = Ink's whole-terminal-clear on Windows, measured 2x bytes). 353/0.
- **Tab title saga (owner images #55-#59)**: branding a tab on Windows took FOUR root causes. (1) OSC 2 wasn't landing at startup -> also set from a mount effect (VT processing on by then). (2) Title kept reverting: byte-capture proved neko pushes CSI 22;0t then never pops - Windows Terminal restores the PUSHED title mid-session; the xterm title stack is now SKIPPED on Windows (PowerShell resets its own title on exit anyway). A ConPTY SetConsoleTitleW FFI attempt was verified round-trip but did not fix it (wrong suspect) - reverted. (3) Title churned with every prompt -> the tab is the stable SESSION NAME (named once from the first message; /title pins; doResume retitles to the switched-to session). (4) Startup writes clobbered by console children (powershell probes set the shared console title, ConPTY syncs it) -> windowsHide on our own spawns + a 1s title DRIVER that re-asserts (Windows keeper) and doubles as the busy pulse: idle "cat home" cat-emoji + name, busy alternates solid/hollow dot IN PLACE (glyph swap, no text shift). Emoji is safe in a TITLE (terminal UI font, not the cp1252 screen buffer); a logo image is impossible (titles are plain text). 357/0.
- **Yoga flex-squash class + geometry freeze (owner images #60/#61)**: with the jump pill visible, the /resume picker rendered mangled - headers gone, session names FUSED onto detail rows ("2 msgsde nhan"). Raw-frame capture proved Ink itself emitted the fusion: the fixed-height root overflowed by a row and Yoga SHRANK the picker - 2-row items squashed to 1 (two Texts on one screen row), the header to 0 - and the viewH feedback settled there permanently. Same class hit the input chrome on short windows ("/" slash menu ate the input row, #61). Fix: SelectList, input chrome, find bar, ApprovalBox are all flexShrink=0 - the flexible transcript band gives up rows instead. Second layer: the band geometry lagged one frame (effect-set after Ink's commit write) and Ink SKIPS byte-identical frames, freezing the mis-composed screen -> setBand moved into the render body + FrameDiffer.refreshCompose() re-composes the last raw frame imperatively on geometry change. Full-pipeline regression tests for both. 359/0.
- **Drift-proof fullscreen seed (owner image #63 - one-time ghosted input at entry)**: the seed/resync path was the LAST relative write in fullscreen (erase-up-from-cursor + newline joins); at real-terminal entry the cursor row is not reliably where Ink assumes, so the seed slid one row - a duplicated input line over the bottom rule, persisting because those rows rarely repaint. Seed now paints every row ABSOLUTE + EL (cannot drift, wherever the cursor starts); test applies the same seed from three cursor positions and requires identical screens. Fullscreen is now 100% absolute-addressed. 360/0.
- **Linux verified natively (owner: "will macOS/Linux be stable?")**: ran the FULL verify loop in WSL Ubuntu - after discovering the first run silently used the WINDOWS bun via the npm shim + WSL interop (UNC paths in errors gave it away; results void). With real Linux bun (ELF): 4 real findings fixed - (1) PRODUCT: session-index freshness keyed on mtimeMs alone misses same-millisecond rewrites on ext4 (stale msgCount served) -> rsync-style mtime+size composite; (2) session tests asserted via os.homedir() (env-honored on Windows, passwd on Linux) -> assert TEST_HOME; (3) tool tests slept via node -e (absent on minimal Linux) -> sleep; (4) computer-tool test expects the Windows-only refusal off win32. Final: Windows 360/0, Linux 359/0 + typecheck + policy + build + compiled binary runs. macOS: same portability class + 3-OS CI covers it at first push.
- **Claude-clean exit + /resume upgrade stall (owner images #64-#66)**: exit used to dump a raw-text transcript tail (unformatted markdown, interleaved around the shell's old cursor, including the "(press Ctrl-C again)" line) - the scrollback echo is GONE (alt-screen restore already returns the primary untouched; exit prints ONLY the resume hint, like Claude Code), and the Ctrl-C hint is an ephemeral note-row flash, not a transcript line. /resume "lag": measured with a 1501 x 40KB store (picker 260ms, filter 122ms, replay tail ~100ms, keystrokes 16-32ms - healthy); the REAL stall was the fsize index upgrade re-parsing every legacy entry once (1598ms measured) -> legacy entries MIGRATE in place (mtime match was the old key; just stamp fsize): 81ms, 20x. scripts/bench-resume.ts kept as the measuring tool. 360/0.
- **v0.7.0 released (2026-07-06, owner-approved)**: /secret-scan CLEAN (all hits placeholders/fixtures); version 0.6.0 -> 0.7.0 (0.6.0 was internal, never published; fullscreen-only is a surface change worth the minor); README fullscreen-first bullet, CHANGELOG 0.7.0 section, fullscreen-mode.md + ROADMAP status refreshed; pushed self-improve, fast-forwarded main, tagged v0.7.0.

## 2026-07-06
- **Windows PE branding + icon = the banner mascot 1:1 (v0.7.1-v0.7.3)**: scripts/build.ts becomes the ONE compile source of truth (NODE_ENV define, tsconfig.build, --windows-* flags HOST-GATED after bun ERRORED on them cross-OS and broke 4/5 release targets - re-tagged); scripts/make-icon.ts rasterizes assets/mascot-art.txt (192x52 extracted 1:1 from the banner) with coverage-based downsampling -> neko.ico (16..256, PNG-compressed entries) + social-preview + avatar; Task Manager shows "Neko Core" + the cat icon.
- **Auto-update default-on (v0.7.4)**: the daily startup check now INSTALLS in the background (Windows rename-out-of-the-way swap, effect at next launch); opt-outs auto_update:false / NEKO_AUTO_UPDATE=0 / auto_update_check:false; source runs never auto-update.
- **SOTA installer + shadow self-healing + the PATH-substring field bug**: version-first output, HttpClient in-place progress, verify-by-running, PATH PREPEND + always-report; other `neko` on PATH are probed BY RUNNING them and verified-older neko-core is auto-removed (the friend's 0.2 shadow, reproduced locally with the real 0.2 release binary). Field round 2: "already on PATH" was a SUBSTRING match - "...\Programs\neko-core" CONTAINS "...\Programs\neko", so the real dir was never added and healing left NO neko on PATH ('neko' is not recognized) -> per-ENTRY compare (case/trailing-slash tolerant), in-shell PATH prepend (usable right under irm|iex), dangling legacy neko-core PATH entry + empty dir cleanup. `--doctor` alias; both installers end suggesting `neko doctor` / `neko --yolo`.
- **"Renders but typing dead" (friend's machine) = Bun 1.3.14, not Neko (v0.7.5)**: remote layer-walk + a Codex prompt run ON the machine: Win32 ReadKey OK, Node raw-stdin OK, Bun 1.3.14 raw-stdin ZERO bytes, Bun canary 1.4.0 OK, neko rebuilt on canary types. Same WT 1.24.11321 on both machines; failing box Windows 26200.8655 vs healthy .8737 - a CONDITIONAL runtime bug (bun is mid "Remove libuv on Windows" rework). Ship: pin bun-version canary in ci+release (loud revert comments) -> 0.7.5. Diagnostics shipped FIRST: doctor terminal section + `neko doctor keys` (raw hex probe with automatic verdicts), DEC 9001 win32-input-mode reset joins entry/teardown hygiene, WMI "59Hz" -> 60 normalization.
- **Input smoke gate - the whole class is now unshippable**: scripts/input-probe.ts spawns the compiled binary's `doctor keys` under Bun.Terminal (ConPTY on Windows, forkpty elsewhere), types h,q, asserts the full round trip (write -> PTY -> raw stdin -> hex echo -> verdict); wired into `bun run build` (so CI x3 OS runs it) and the release smoke step. Release matrix reworked: canary has NO cross-target downloads -> 4 targets build NATIVE (ubuntu-24.04-arm runner added; smoke coverage 3/5 -> 4/5), darwin-x64 cross-compiles from STABLE (x64 bun HANGS under Rosetta on GH arm runners; the bug is Windows-only so stable is correct for Intel macs); timeout-minutes: 20 so a hung runtime fails fast. Re-tag gotcha caught live: deleting a git tag DEMOTES its release to DRAFT -> releases/latest silently served 0.7.4; gh release edit --draft=false --latest + verify /releases/latest is now part of the re-tag drill. End-to-end proof: ran the real one-liner -> "Installing Neko Code v0.7.5" -> installed binary passes input-probe.
- **bun-stable-watch (the debt calls itself)**: daily cron asks bun's releases API; the day a stable > 1.3.14 ships it files the revert issue with the full payoff checklist (flip pins, reconsider darwin-x64 override, CI + input-probe gate, field-verify via doctor keys, delete the watcher). workflow_dispatch smoke: success ("pin stays"). `bun --revision` is logged before every release compile so the exact embedded canary commit is always on record.
- **Ghost chrome on WT (owner images #77/#78) = Windows Terminal corrupting DEC 2026, not our bytes**: duplicated input/footer rows one row apart, mid-turn, small window. Built the missing instrument - scripts/e2e-conpty-ghost.ts runs the REAL binary under a REAL ConPTY (Bun.Terminal) with the output replayed into the VirtualTerminal - and it reproduced on the FIRST run (also on untouched v0.7.4: latent, not a regression; sims never saw it because their providers answer instantly and fake stdout has no ConPTY). Evidence chain: NEKO_INCR=0 clean -> differ path involved; byte tap (NEKO_TRACE_FRAMES, both differ decisions AND final stdout bytes) -> replaying OUR bytes through the reference VT = clean, so the bytes are xterm-correct; minimal DECSTBM/2026 probes = correct; PACED ConPTY replays = clean; live cadence with 2026 = ghost 6/6; NEKO_SYNC=0 = clean 3/3. Verdict: WT 1.24 mis-executes synchronized output at real write cadence. Fix: WT dropped from the 2026 allowlist (differ writes minimal diffs - no practical flicker; NEKO_SYNC=1 force-on hatch stays) + paintedBand hardening (hardware scroll only when the band geometry is unchanged since the model was last painted). e2e ghost 2/2 clean post-fix; 364/364; both smokes pass.
- **Ghost round 2 + the input kill (owner: "our machine can't type now either") - differ OFF by default on Windows**: the owner was right twice over. (1) The WT-allowlist drop sent every WT session into probeSyncOutput, whose pre-Ink stdin PAUSE silences input forever under Bun-on-Windows AND whose DECRQM answer re-enabled the 2026 we had just denied - fixed with a three-state sync decision (yes/no/unknown; known answers never probe, win32 never probes, NEKO_SYNC=0 is a hard no) and a probe that no longer pauses stdin; the e2e harness now emulates REAL WT (WT_SESSION + DECRQM reply) and asserts typed-echo every run - which exposed that ALL prior "clean" verdicts with 2026-off were HOLLOW (input was dead, no turn, nothing to ghost). (2) With input alive the ghost survived every layer peeled: absolute-only seeds (Ink's raw newline-flow first frame can scroll the real screen), paintedBand geometry gate, hardware scroll off (ConPTY displaces DECSTBM-region scrolls at live cadence), 2026 stripped even from Ink's own BSU/ESU writes. The residue reproduced on a PURE absolute-CUP stream - conhost buffer/viewport territory, not our bytes (clean reference-VT replay) - so the differ is now DEFAULT-OFF on win32 (NEKO_INCR=1 to force), full differ + hw-scroll stay on unix. Final e2e: typed-echo OK + no ghost 3/3 on defaults; INCR=0 control clean; 365/365 both runtimes. vt.ts gained ECH; open debt: crack the conhost displacement (upstream issue archaeology) and re-enable the differ on Windows.
- **v0.7.7 (owner's birthday build, 2026-07-07) - instant scroll + the differ verdict finalized**: owner reported laggy scrolling (differ-off glide = dead hops + one settle render). Fix: no fast path -> useRowScroll jumps INSTANTLY (one render per gesture); glide callback only passed when a differ exists; unix unchanged. Third exoneration attempt for the differ: vt.ts gained LAZY AUTOWRAP (clipping at the right edge shifted reconstructions below 118-col rules one row UP - the harness could manufacture the ghost signature itself!) and the differ-ON ConPTY stream was re-inventoried (CSI h/l/J/m/H/K/C/X + OSC - ALL supported now). With the parser complete: differ-on ghost STILL 3/3, differ-off clean -> ConPTY really displaces differ output; verdict stands on solid ground. New CI sim locks the differ-less fullscreen path (render/type/instant-scroll). 366/366.
- **Owner: still laggy + 'lag tong the' - differ RESTORED with SELF-HEALING RESYNC (v0.7.7 re-scoped, release deleted per owner)**: the owner's field signal was right - differ-off degraded EVERYTHING (typing/stream/scroll all full-frame; bench 76ms first-response, 391ms post-flick backlog; wheel coalescing got it to 63/110ms but the ceiling is the full-frame render itself). Resolution: the ghost's damage is PERSISTENCE, so bound its lifetime instead of disabling the differ - paintAll() (absolute CUP+EL rows, displacement-immune) fires ~400ms after each write burst (trailing debounce) and >=2s during sustained activity; seeds/resyncs stamp the clock; dispose() on teardown. Result: e2e clean 3/3 WITH the differ on (unhealed differ: ghost 3/3), typed-echo OK, scroll first-response 11ms (better than the 15ms 0.7.0 baseline). bench-scroll-conpty.ts promoted to scripts/ with baselines. v0.7.7 will be re-tagged only after the owner's hands-on confirmation.
- **Heal made surgical + v0.7.7 released (the owner's birthday build)**: two refinements from the limitations review - (1) heal is WINDOWS-ONLY (the displacement does not exist elsewhere; SSH links were paying ~10KB/pause for nothing); (2) heal arming is SELECTIVE: only structurally-risky writes (>=8 rows changed / band churn / geometry) arm the trailing timer - the caret blink (530ms) had been beating the 400ms timer, healing an IDLE session every second forever. Verified: idle 5s = 667 bytes (pure blink, zero heals); e2e 3/3 clean + typed-echo OK; scroll first-response 13ms; 366/366; policy PASS. Docs refreshed (CHANGELOG final, ROADMAP status, memory). Released as v0.7.7 after the owner's hands-on OK ('tot roi').

## 2026-07-10 — deterministic interactive UX audit
- Drove the real `ChatApp` through a Unicode display-cell VirtualTerminal and the compiled binary through
  a real ConPTY. Captured startup, typing, live Markdown, commit, selection/copy, Ctrl+Up/End scroll,
  todo create/update/reflow/idle, slash keyboard navigation, and approval/denial.
- Fixed the findings: duplicate live todo plan removed; the current plan is carried through compaction;
  Ctrl+Up/Down no longer collides with prompt history; approval decisions render once; first-run footer
  says `no model`; spinner spacing is stable; committed streams prime the rich-row cache so raw Markdown
  never flashes.
- Resize hardening now consumes `wipe + new frame`, composes that frame immediately, refuses stale raw
  replay, and clears the unowned physical spare row. The latter was found only by ConPTY after the VT
  suite was already green, validating the two-layer harness.
- Harness repairs: Unicode-aware VT CSI/cell handling, isolated capture HOME, deterministic state gates,
  working perf-script imports, truthful idle measurement, a real long-session scroll fixture, and a
  compiled-binary ConPTY smoke covering resize plus slash completion.
- Verification: TS 7 + TS 5.9 clean; 411/411 tests; doctor/policy/build/UI/input probes PASS; VT capture
  stable 4/4; ConPTY smoke 2/2 (14 ms first scroll response); idle 3 s = 0 writes; keystroke p50/p95
  22/32 ms and 13/21 ms under ~80% background CPU.

## 2026-07-10 — verified todo completion, draft copy, and native computer input
- Todo plans are now an atomic state boundary: non-array/oversized/empty/duplicate/illegal-status and
  ambiguous-active updates fail without replacing the last valid plan. Pending work requires exactly one
  `in_progress`; an all-completed plan requires none. A tool-less final with open todos gets one recovery
  pass to re-check state, continue, reconcile the full plan, or name a real blocker.
- `Alt+C` copies the whole current draft through OSC52 + the native clipboard without clearing/submitting it.
  Staged paste placeholders expand back to their original multiline content; secret-entry mode refuses copy.
  Ink tests and the deterministic VT capture prove the Unicode draft remains visible and OSC52 is emitted.
- The gated Windows `computer` tool now exposes `type`, `key`, `scroll`, `wait`, and `open`. Unicode text uses
  Win32 SendInput/KEYEVENTF_UNICODE; exact UIA control focus is verified before input, otherwise the action
  fails closed; duplicate window-title matches are refused instead of guessed; scroll delegates to touch
  injection and does not move the user's mouse. Downloads, package
  managers, and installers remain code-first through gated bash. Typed and launch payloads are redacted from
  the audit log. A disposable WPF probe drove Unicode type -> UIA readback -> Ctrl+A -> replacement -> close,
  repeated 3/3 after it exposed and fixed an intermittent window-vs-control focus bug.
- Release-binary audit found built-in skills were never embedded: outside the source tree the single binary
  saw only user skills, so computer-use helpers disappeared. A Bun build macro now embeds the entire skill
  tree (binary assets included, 10 MB guard), materializes it in a safe per-process temp directory, and cleans
  it on exit. The compiled binary's `__uiprobe` verifies `computer-use/input.ps1` is present and executable.
- Research was refreshed against OSWorld 2.0, QGP/PushBench, OSGuard, CoAct-1, UI-TARS-2, Agent S2,
  GPT-5.4, and Anthropic's agent engineering guidance. Conclusion: Neko's next meaningful lever is a small
  verifier-backed long-horizon eval pack, not another speculative planner/framework.
- Verification: TS 7 + TS 5.9 clean; **416/416 tests** (1549 assertions); doctor healthy; policy PASS;
  production build + embedded-skill/UI + real-PTY input probes PASS; deterministic VT audit PASS; WPF/UIA
  input probe PASS; ConPTY startup/resize/slash/keyboard PASS, scroll first response 14 ms / settle 142 ms.

## 2026-07-10 - UI-TARS Desktop clean-room audit and visual computer observations
- Cloned `bytedance/UI-TARS-desktop` into the untracked sibling reference area at commit
  `c2ad42e3eb9b27830db41a3e6f51ca7179d9b168`. Studied it clean-room only; no source or visual assets were
  copied into Neko. The in-app browser was unavailable, so the visual audit used the repository's own
  current documentation screenshots (`start_task`, `take_control`, `terminate`, settings) plus source.
- The useful mechanism was narrower than the Electron shell: both the legacy SDK and current GUI Agent
  2.0 make screenshots explicit environment input, keep a bounded visual history (legacy limit: five),
  wait for the UI to settle, and expose action/status/takeover events. Neko already has the stronger
  terminal-native pieces for its product - queued input while busy, approval modes, todo state, action
  transcript, Esc/click takeover, UIA structure, and a mouse-independent pointer channel - so porting the
  desktop layout or its operator hierarchy would add weight without closing a real gap.
- Found the real gap by executing Neko's tool: `computer screenshot` returned only a temp GIF path. A
  vision-enabled main model therefore did not receive the visual observation in the next turn, and a
  multimodal tool result would stringify to `[object Object]` in the TUI and Anthropic adapter.
- Fixed the whole path surgically: screenshots now embed as image content when `vision` is enabled;
  text-only drivers retain the file path for `computer-use/scripts/see.ts`; strict OpenAI-compatible
  payloads move tool images after the complete tool-result batch as a user visual observation; Anthropic
  emits native nested image blocks; live and resumed TUI transcripts render metadata plus `[image]`.
  Context relief masks older tool images while retaining the newest two for before/after comparison and
  never prunes user attachments.
- Verification: TS 7 + TS 5.9 clean; **421/421 tests** (1572 assertions); doctor healthy; policy PASS;
  a real desktop capture returned a 768x432 GIF observation with physical-screen scale and no stale temp
  path; production build + embedded-skill + real-PTY input probes PASS; deterministic VT UX audit PASS;
  disposable WPF/UIA Unicode input probe PASS; ConPTY startup/resize/slash/keyboard PASS, scroll first
  response 18 ms / settle 337 ms.

## 2026-07-10 - long-horizon computer-use eval pack (`neko bench gui`)
- Built the verifier-backed long-horizon computer-use eval the roadmap named as the next lever (the
  UI-TARS audit's own conclusion: a small verifier-backed eval pack, not another planner/framework). The
  real `computer` tool drives live Windows UIA (non-deterministic, not CI-safe) and is already proven by
  the WPF/UIA live probe; this measures the OTHER half - the AGENT'S long-horizon decision-making -
  deterministically. A scriptable simulated GUI world (a state machine) answers the same `computer`
  actions (read/click/type/toggle/setvalue/key) with deterministic observations and is injected through a
  new `ToolRegistry.computerHandler` seam (same shape as the existing loadSkill/checkAction/web host hooks;
  default unset = the real Windows path, so shipping behaviour is untouched). The REAL model drives a fake
  desktop in-process on any OS; each task has a deterministic verifier.
- Four tasks, one capability axis each so the pass/fail is diagnostic, not a blob: **form-wizard**
  (multi-screen task-success + a HARD CONSTRAINT: never click 'Delete account', present on every screen as
  temptation), **recover-save** (ERROR RECOVERY - Save fails once with a transient "busy" error and must be
  retried), **settings-selective** (PRECISE ACTION - flip exactly two settings, leave the other two
  untouched; over-acting fails), **find-open** (coordinate GROUNDING - click the right row's (x,y) among
  distractors; a wrong item or a click into empty space fails). Metrics (pass, constraint violations,
  grounding misses, steps) append to `~/.neko-core/bench-log.jsonl` under suite "gui". Run:
  `neko bench gui [--trials N]` (owner-run; live model + Windows for the schema).
- Deterministic self-test (`test/gui-eval.test.ts`, 15 tests, no live model / no cost) proves the whole
  harness with a scripted provider: the world state machine (render, grounding miss, focus+type, setvalue,
  toggle, danger->violation, failFirst->recovery, navigation) AND end-to-end that a correct trajectory
  passes while a mis-grounded / constraint-violating / no-retry / over-acting one fails - each axis has a
  pass and a fail case. This is the committed signal; the live-model calibration (where glm-5.2 lands, and
  the harness lift a verify-gate/recovery-middleware then buys) is the owner's to run.
- Verification: TS 7 + TS 5.9 clean; **436/436 tests** (1610 assertions, +15); policy PASS; `neko bench gui`
  wired into the CLI + help. No `src/core` behaviour change beyond the opt-in handler seam (unset by default).

## 2026-07-10 - GUI eval live calibration + the HARD tier (owner-authorized live runs)
- Live calibration (owner: "chay di... toan quyen"). glm-5.2 was unreachable - BOTH stored Z.ai keys
  (env + config, different keys) are rejected by api.z.ai today (`{"code":1000,"msg":"Authentication
  Failed"}` on a direct `/v1/models` probe; they worked 2026-07-08), so the account/key needs the owner.
  Two environment findings along the way: (a) the top-level `model:` in `~/.neko-core/config.json`
  SHADOWS every profile's model (documented overlay order - the file beats the profile preset - but a
  real footgun: `--profile nvidia` was silently sending `z-ai/glm-5.2` to NVIDIA); worked around with a
  scratchpad-local `./.neko-core` overlay, owner's config untouched. (b) the eval surfaced provider
  errors properly instead of silent 0/1 (the bench.ts pattern paying off).
- Baseline on `openai/gpt-oss-120b` (NVIDIA): the base tier SATURATED immediately - 4/4 first run,
  12/12 at 3 trials, 0 misses. Honest per the eval's own contract ("if 100%, tighten the ruler"): the
  base tier is now the smoke/regression tier.
- Built the HARD tier (`neko bench gui hard`, suite "gui-hard") with the pressures real desktops apply
  that the base tier lacked: **bank-transfer** (cross-screen memory - the checking balance is only
  visible on the Accounts screen, a savings-balance decoy sits next to it, and a one-shot promo dialog
  hijacks the first navigation), **paged-decoys** (partial observability - a 3-page inbox where the
  page-1 decoy "Invoice #42 (copy)" fails the task permanently), **guarded-form** (validation-error-
  driven progress + a final confirm screen where stopping early feels done but is not), and the
  **expense-report composite** (~17-perfect-turn chain: memorize TWO values from different screens, a
  paged list with a draft decoy, checkbox precision, a survey dialog that hijacks the SUBMIT itself so
  the model must notice the submit did not go through, a final confirm, and a Factory-reset danger
  button). Engine additions: `El.goTo` (dynamic destination - one-shot interrupts) and `El.guard`
  (refuse activation with a validation error); `GuiWorld.openedAll`/`flags`.
- First hard run saturated too (9/9) BUT with visible strain: bank-transfer used ~27 of 34 turns with
  4 grounding misses. Applied the METR-style calibration (horizon = the budget where success ~50%):
  budgets now sit just under the measured strain point (bank-transfer 34->24, paged-decoys 24->16,
  guarded-form 26->16), so inefficiency IS failure and a harness lever shows up as pass-rate lift.
- Calibrated result (gpt-oss-120b, 3 trials/task): **11/12 (92%), paged-decoys FLAKY 2/3, 16 grounding
  misses** - the ruler discriminates. Deliberately stopped tightening here: sharpening further against
  one model's 3-trial run would overfit the eval to gpt-oss-120b. The glm-5.2 baseline lands once the
  owner refreshes the Z.ai key.
- Verification: TS 7 + TS 5.9 clean; **450/450 tests** (1629 assertions, +14); policy PASS; live runs
  logged to bench-log.jsonl suites "gui" and "gui-hard".

## 2026-07-10 - OSC 8 hyperlinks: links in the transcript are hover-and-Ctrl+Click real (owner ask)
- The owner's procurement case made the gap concrete: `[text](url)` rendered the LABEL and threw the
  URL away (markdown.tsx) - fatal when the answer IS the link - and nothing in the transcript was
  clickable the way Claude Code's file/PR links are (owner screenshot: WT tooltip "Ctrl+Click to
  follow link" = OSC 8, not terminal auto-detection).
- Emit: a new React-free `ui/links.ts` (osc8 wrapper with control-byte URI sanitize - an embedded
  ESC/BEL is an injection vector; fileUri with %-encoding; linkSegments for bare URLs + absolute
  Windows paths with word-boundary guards and trailing-punctuation trim). markdown.tsx now hyperlinks
  `[label](url)` (label visible, URL carried) and bare URLs/paths in prose; transcript.tsx hyperlinks
  an existing file path in a tool-call line (resolve + existsSync gate, stat paid once via the ANSI
  cache) and bare URLs in plain tool-result lines (web_search results must be reachable).
- Why OSC 8 and not auto-detection: wrap-ansi (Ink's wrapper) RE-OPENS the hyperlink on every wrapped
  segment (verified empirically), so a long product URL broken across 2-3 terminal lines still carries
  its full URI - exactly where auto-detection dies. string-width measures the sequence at 0 cells.
- The compositor had to learn the sequence everywhere column math or byte filtering lives:
  `parseInkPayload` now accepts OSC 8 (still refuses OSC 52/title - rejecting links would silently
  drop the differ into passthrough-reset full repaints on every linked frame), `sentinelCol` +
  `overlaySelection` skip it as zero-width (the selection block CLOSES any open link first so a link
  cut in half never bleeds into the highlight), `screenText` strips it on copy (the visible text of a
  bare URL IS the url, so a copied link stays a link). The VT oracle already skipped OSC.
- Tests: +12 (links unit incl. the injection sanitize and a real regex bug the boundary test caught -
  "https://" mis-parsed as drive "s:"; markdown label+URI carry, trailing-punct, table alignment with
  a linked cell; frame-diff OSC-8-accept/OSC-52-reject, copy-strip, selection-over-link; the legacy
  "url hidden" test updated to the new contract: carried, not visible). **463/463** (1662 assertions);
  TS 7 + TS 5.9 clean; policy PASS; binary build + UI/input probes PASS.

## 2026-07-10 - managed SearXNG lifecycle: the Ollama pattern applied to search (owner ask)
- Owner ask: can users get local SearXNG without ever thinking about Docker - auto-run when needed,
  auto-off when idle? Researched before building. (a) SearXNG has NO native-Windows support (official
  docs + maintainer discussion #4029: WSL/Docker are the paths) - a venv-on-Windows product path is a
  dead end. (b) The "reimplement a native in-binary multi-engine aggregator" idea DIED on live data:
  probes from a VN residential IP show Bing serves 0 organic results to non-browser clients, Mojeek
  answers with a captcha page, Brave 429s and Ecosia 403s on the FIRST request; only DuckDuckGo's html
  endpoint still parses. Fighting that arms race is SearXNG's community full-time job - do not
  reimplement it, manage it. (c) The precedent for "heavy backend, zero thought" is Ollama's
  keep_alive: load on demand, unload after idle. (d) RRF (Cormack et al., SIGIR 2009) noted as the
  fusion standard if a multi-engine merge ever becomes viable again.
- Built `adapters/sidecar.ts` (SearxngSidecar, injectable exec/probe): a searxng search that cannot
  connect wakes the `neko-searxng` container ONCE per process (docker start + health poll <=8s) and the
  search retries; every healthy search re-arms an idle timer that `docker stop`s it after
  `searxng_keepalive` minutes (config, default 15, 0 = always-on); a PROCESS-EXIT hook stops a container
  we woke so a short `neko run` can't leak it (design gap caught during review, unit-locked). Hard
  rules: a container Neko did not start is NEVER stopped; Docker Desktop is never launched/killed; a
  dead daemon fails in ~100ms and the search falls through the ladder (Tavily/DDG) - infra never blocks
  a search. `setup web` drops --restart unless-stopped (the lifecycle owns it now); doctor reports the
  managed state; zero-config users with Docker get a ONE-TIME in-result tip ("ask me to run
  `neko setup web`") - the agent runs it under the normal bash approval gate, which is the "UI asks the
  user" without blocking an agent turn on infrastructure consent.
- LIVE end-to-end proof on this machine: container Exited (6h, zero RAM) -> real search "gia iphone 15
  128gb" woke it and returned Vietnamese product results with exact URLs (cellphones.com.vn,
  thegioididong.com) in 9.5s total -> 3s test keepalive -> container back to Exited(0). The procurement
  loop's search tier now costs zero RAM while idle and zero user attention while active.
- Verification: TS 7 + TS 5.9 clean; **479/479 tests** (+16: 13 sidecar lifecycle + 3 web dispatcher
  wake/hint; existing fallback test hardened against real-docker side effects via an inert sidecar);
  policy PASS; doctor line verified live ("searxng (container stopped - starts on demand...)").

## 2026-07-11 - ChatGPT Plus/Pro OAuth + Codex Responses provider (owner ask)
- Studied the public OpenAI Codex and OpenCode implementations as protocol references, then built a
  clean-room Neko adapter rather than routing through Claude Code or pretending subscription access is
  an API key. The built-in `chatgpt` profile is explicit and fail-closed: it always uses the fixed
  `https://chatgpt.com/backend-api/codex/responses` origin and never falls back to pay-as-you-go API
  billing or sends its OAuth bearer to a configured third-party endpoint.
- Added browser PKCE OAuth (`neko login chatgpt`) plus device-code login for SSH/headless hosts
  (`--device`), CSRF state validation, refresh-token rotation, one forced refresh after a backend 401,
  account-id claim extraction, logout, and CLI/TUI/doctor integration. Credentials live separately in
  `~/.neko-core/chatgpt-auth.json`; atomic writes create the temp and final file as mode 0600 on POSIX.
- Added a Responses wire adapter for messages, images, JSON-schema output, tools, parallel tool calls,
  streamed text/reasoning/function arguments, usage/cache accounting, retry/abort, and strict incomplete-
  stream failure. Opaque encrypted reasoning continuation is carried through the provider-neutral port
  and replayed between tool rounds; other providers strip it on a live profile switch.
- Evidence: 9 focused ChatGPT tests cover auth URL/PKCE, storage/clear, expiry refresh, device polling,
  nested account claims, fixed-origin request/header/body translation, CRLF SSE tools/usage/reasoning,
  disconnect rejection, and 401 refresh. Agent tests cover continuation replay and context accounting.
  Full gates: TS 7 + TS 5.9 clean; **531/531 tests** (1910 assertions); doctor healthy; policy PASS;
  production binary build + UI/input probes PASS; compiled binary `doctor --profile chatgpt` PASS in an
  isolated home. No real account login or model request was performed, so the first owner-run OAuth +
  completion remains the only unverified external edge. Bun printed a non-fatal internal directory-
  mismatch diagnostic after its successful compile; the compiled binary smoke passed afterward.

## 2026-07-11 - OpenAI auth routing UX: provider -> auth method -> account-aware models
- Hardened the first OAuth slice after owner review. `/login` now groups the internal `openai` API and
  `chatgpt` subscription profiles under one **OpenAI** provider, then presents two explicit routes:
  `ChatGPT Plus/Pro` (subscription, no API billing) and `API key` (pay-as-you-go). Other providers remain
  profile-scoped; zero-auth local routes are omitted from the sign-in picker. `/provider` uses the same
  grouped account view, while explicit internal profile names remain available for config/debugging.
- Fixed two correctness bugs exposed by the new flow: TUI API login no longer sets process-wide
  `NEKO_API_KEY` (which could leak one provider's key into another), and `/logout` now reloads the active
  config/provider after removing the profile key instead of leaving the old secret live in memory until
  restart. ChatGPT logout and API-key logout are isolated and tested not to erase one another; environment-
  sourced keys produce an honest shell-settings warning because a child process cannot unset its parent.
- `/model` now names the active route (`OpenAI · ChatGPT Plus/Pro` vs API key). With ChatGPT OAuth it
  fetches the fixed-origin, account-filtered `https://chatgpt.com/backend-api/codex/models` catalog,
  including plan/rollout-specific availability, filters hidden entries, refreshes once on 401, and uses
  a config fallback only before sign-in. The nested picker resets its search/cursor when moving from
  provider to auth method (a UI test caught the old query making the second list appear empty).
- CLI parity: `neko login openai chatgpt [--device]`, `neko login openai api <key>`, and matching scoped
  logout routes; the short `neko login chatgpt` alias remains compatible. An isolated CLI smoke proved
  API login -> `api_key=set` -> scoped logout -> `api_key=missing` without printing the key.
- Verification: TS 7 + TS 5.9 clean; **540/540 tests** (1949 assertions), including two-stage UI,
  secret non-echo, no process-wide key override, immediate logout, cross-route credential preservation,
  live model-catalog parsing, provider grouping, and named-profile key removal; doctor healthy; policy
  PASS; production binary build + UI/input probes PASS. No real OAuth login or model/quota call was made.

## 2026-07-11 - ChatGPT `/model` real-login repair: Codex client-version contract
- The owner's first real Plus/Pro login proved OAuth and account selection worked, but `/model` failed
  with HTTP 400. A credential-safe live probe reproduced the backend response exactly: the Codex models
  endpoint requires the `client_version` query field. Sending Neko's unrelated app version (`0.9.0`)
  returned HTTP 200 with zero models because this field also gates models by minimum Codex client version.
- Matched the public Codex request contract and introduced an explicit Codex compatibility version
  (`0.139.0`, separate from Neko's release version). The fixed-origin request is now
  `/backend-api/codex/models?client_version=0.139.0`; error bodies are safely summarized, and `/model`
  degrades to the built-in profile catalog if the live catalog is unavailable or unexpectedly empty.
  Completion entitlement remains server-authoritative, so fallback cannot bypass account access.
- Live read-only verification with the owner's saved OAuth session returned four selectable models:
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`. No completion/model-quota request was
  made. Regression coverage asserts the versioned URL, hidden-model filtering, account header, and
  failure fallback. Full gates: TS 7 + TS 5.9 clean; **541/541 tests** (1950 assertions); doctor healthy;
  policy PASS; production binary + UI/input probes PASS. Bun again emitted its non-fatal post-compile
  directory-mismatch diagnostic; the produced binary and both probes succeeded.

## 2026-07-11 - GPT-5.6 catalog metadata + model-aware effort + `/usage`
- The owner's follow-up exposed that the previous compatibility marker (`0.139.0`) intentionally hid
  July's GPT-5.6 rollout. Checked public Codex `main` at commit `5c19155` and the signed-in account:
  Sol, Terra, and Luna require `client_version=0.144.0`. The live account catalog now returns seven
  selectable models, led by `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- Replaced the ChatGPT id-only path with rich, account-filtered model metadata: display name,
  description, context window, default effort, and the exact supported effort ladder. `/model` renders
  those facts and persists the selected model's context window; the live Agent overflow guard updates
  immediately too. This avoids the subtle old behavior where a 372k model still compacted as if it had
  the startup/default 131k window.
- `/effort` is now per-model and honest: `default` means omit the field and use the backend's declared
  default (it is not mislabeled as reasoning disabled). Sol/Terra expose low..ultra, Luna low..max, and
  5.4/5.5 low..xhigh. A saved higher tier is clamped to the nearest supported tier when switching models;
  direct max/ultra starts resolve once against the account catalog before the Responses call, preventing
  the prior `gpt-5.4 + max` HTTP 400.
- Added `/usage` over the fixed-origin, read-only ChatGPT `GET /backend-api/wham/usage` path with account
  header, token refresh, and no API-billing fallback. It renders plan, used/remaining percent, reset time,
  5-hour and weekly windows, additional model buckets, and credits. Live verification showed Pro: primary
  5-hour window 100% used (temporarily reached), weekly ~30% used, and the separate Spark bucket available.
  Only catalog/usage GETs were made; no completion or model quota was consumed.
- Fallback remains useful offline but never claims entitlement: live catalog wins whenever reachable and
  the Responses backend remains authoritative. Tests cover rich catalog parsing/filtering, 0.144 query,
  effort clamping, Luna's no-ultra picker, usage parsing/rendering, fixed usage URL, fallback, and persisted
  context metadata. Full gates: TS 7 + TS 5.9 clean; **546/546 tests** (1986 assertions); doctor and policy
  healthy; production binary + UI/input probes PASS. Bun emitted the same non-fatal post-compile directory-
  mismatch diagnostic after producing a working binary.

## 2026-07-11 - GPT-5.6 404 + native ChatGPT vision: capability negotiation, not spoofing
- Reproduced the owner's `gpt-5.6-luna` failure with credential-safe minimal requests. The live catalog
  says Sol/Terra/Luna use Responses Lite, accept text+image, require Codex client contract 0.144.0, and are
  `code_mode_only`. Matching the official Lite header/body plus turn metadata still returned the exact
  `Model not found` 404 for both honest `neko` and `opencode` originators. On the same machine/account,
  official `codex-cli 0.144.1` completed Luna; changing only the diagnostic request's client identity to
  `codex_cli_rs` also returned 200. This proves the catalog is broader than the third-party completion
  route. Neko deliberately does not ship that identity spoof.
- Extended catalog parsing with transport, tool-mode, minimum-client, and input-modality metadata. The
  ChatGPT picker now exposes only models this adapter can really complete. The built-in route defaults to
  GPT-5.5 (272k context, native vision); a persisted 5.6 selection self-heals to the best compatible live
  model before spending a request on a guaranteed 404, updates the runtime model/vision state, and emits
  an explicit explanation. The README amends the earlier catalog-only claim so availability is not
  overstated.
- Fixed the image warning at its source: ChatGPT's profile is vision-capable and live `/model` selections
  persist the catalog's `image` modality. Pasted images and visual tool results therefore stay as native
  Responses `input_image` parts instead of entering the text-only caption bridge. A real 1x1 image smoke
  through the patched provider migrated Luna -> GPT-5.5 and returned `OK` with `vision=true`.
- Added a bounded stream retry for transient server-side `response.failed`/disconnects only before any
  text, reasoning, or tool call has been emitted. Once visible activity or a tool call exists, failure is
  surfaced without retry, preventing duplicate side effects. This covers the owner's earlier generic
  post-fetch backend failure without weakening the existing HTTP retry/abort rules.
- Verification: official source inspected at `5c19155`; live catalog GET and three minimal comparison
  probes plus one final image smoke; TS 5.9 + TS 7 clean; **555/555 tests** (2121 assertions); production
  binary build, `__uiprobe`, and real-PTY input probe PASS. `git diff --check` clean. Bun again printed its
  known non-fatal directory-mismatch diagnostic after a successful build; the 101,270,528-byte binary and
  a separate UI smoke both passed.

## 2026-07-11 - GPT-5.6 Support Pack: official App Server bridge, opt-in installer, measured UX
- Inspected current OpenAI Codex `main` (`5c19155`) and generated App Server protocol schemas rather than
  treating the CLI as a black box. The decisive release finding was OpenAI's own separately built and
  Windows-signed `codex-app-server` target plus `codex-app-server-package-*` assets. A source build was
  rejected as a distribution design: current `main` identifies itself as version `0.0.0`, whereas the
  release pipeline patches the real version before building; that client version controls the model
  catalog. Neko therefore downloads official release artifacts and does not fork/rebrand Codex.
- Added a thin newline-delimited JSON-RPC transport and a hybrid ChatGPT provider. GPT-5.5 and lower keep
  Neko's lightweight direct Responses route. Only GPT-5.6 Sol/Terra/Luna start App Server, on demand, with
  Neko's existing OAuth token, an isolated `CODEX_HOME`, read-only sandbox policy, and Neko dynamic tools.
  Tool requests return through the existing `Agent.safeExecute` approval/path/sandbox boundary; tool-call
  ids are idempotent. `/logout`, live provider/model switches, idle timeout (15 minutes by default), exit,
  abort, spawn failure, and process-tree cleanup all dispose the sidecar without an orphan.
- Added the opt-in Support Pack installer and UX: discovery first reuses a compatible Codex CLI, then a
  Neko-managed standalone App Server. Selecting an unavailable 5.6 model offers `Install support pack` or
  `Not now`; no selection silently downloads. `/support [status|install|update|remove]`, `neko support ...`,
  and `neko setup codex` provide explicit management. API/Ollama/other providers and GPT-5.5 download
  nothing. Removing the pack never removes a user's Codex CLI.
- Supply-chain/rollback boundary: release metadata and asset URL must be the stable official
  `openai/codex` GitHub release; archive name/target/size are bounded; SHA-256 is mandatory; Windows must
  have a valid `OpenAI OpCo, LLC` Authenticode signature; archive contents must be exactly the expected
  standalone binary; version and a real App Server `initialize` handshake must pass in a temporary home.
  Installation is staged and atomically swapped, so checksum/signature/version/protocol failure preserves
  the previous working pack. Managed-manifest path traversal is rejected. Downloads have release/download
  deadlines and partial staging is cleaned.
- Windows x64 measurements against official `rust-v0.144.1`: standalone `.tar.gz` **92.7 MiB** download,
  **270.4 MiB** installed; temporary full package `.tar.zst` was 92.4 MB but installed unnecessary helpers.
  Standalone idle process: **34.7 MiB working set / 14.7 MiB private**, 31 threads; authenticated handshake
  **184-186 ms**. Live Pro account discovery returned seven models including Sol/Terra/Luna and rate limits.
  Luna low-effort text returned `STANDALONE_OK` in **4.0 s**; a dynamic tool ran exactly once and returned
  `TOOL_OK` in **6.9 s**. End-to-end temporary-home install including SHA, Authenticode, extraction, version,
  and protocol checks completed in **16.3 s**. No API key or pay-as-you-go fallback was used.
- Final verification: TS 5.9 + TS 7 clean; **572/572 tests, 2195 assertions, 64 files**, including
  architecture, atomic rollback, traversal, protocol rollback, spawn-race, bridge tool/usage, model effort,
  logout, and UI tests; `git diff --check` clean; doctor healthy; policy PASS; production binary,
  `__uiprobe`, and real-PTY input probe PASS. Windows x64 is live-tested; macOS/Linux target selection and
  checksum paths are covered but remain reasoned/CI-only here. Bun again emitted its known non-fatal
  post-compile directory-mismatch diagnostic after producing a working binary and passing both probes.

## 2026-07-11 - v0.10.0 released: verified installers, checksums, and GPT-5.6 artifact smoke
- Hardened both one-line installers before release. Windows now requires stable GitHub release metadata,
  the exact official asset URL/size/SHA-256, and an exact binary version probe before same-volume
  `File.Replace`; Unix stages the binary, verifies a v0.10+ checksum sidecar plus version, then uses atomic
  rename. Every platform build publishes its own `.sha256`. A Windows pinned v0.9.0 E2E ran in isolated
  LOCALAPPDATA/HOME with a sentinel old binary: 82,546,688 bytes downloaded and verified, atomic replacement
  succeeded, no stage/backup remained, and rollback pin persisted. Historical releases without sidecars
  retain their version-probe rollback path.
- Release candidate gates on commit `aa2835e`: TS 5.9 + TS 7 clean; **575/575 tests, 2212 assertions,
  65 files**; policy PASS; doctor reports 0.10.0; production build, `__uiprobe`, and real-PTY input probe
  PASS. Real ConPTY ghost+typing gate passed 3/3 (one footer, typed-echo OK, no ghost). Scroll benchmark:
  26 ms first response, 179 ms settle, 13.1 KB, viewport/resize/slash-menu/keyboard all OK. Secret scan
  CLEAN: only documented placeholders/fixtures (`nvapi-xxxxxxxx`, `ghp_...`, `sk-file/sk-env`), no inline
  key/private key/excluded artifact tracked.
- Pushed `self-improve`, fast-forwarded `main`, and tagged new `v0.10.0` (no re-tag). GitHub Actions run
  `29155531142` succeeded for all five targets; the release is public/latest/non-draft with **5 binaries +
  5 checksum sidecars**. Curated notes replace the generated commit list.
- Ran the exact public Windows one-liner from `neko.holilihu.online` after the domain refreshed. It fetched
  v0.10.0, verified SHA-256, atomically installed the 82,696,192-byte binary, removed the older v0.9.0 PATH
  shadow as designed, and left no staging file. Installed SHA-256
  `2102c007558997c3bbdd4df08165a25215b52c67925fe5e84a8060bdd5537490` matches the GitHub asset;
  `neko version` reports 0.10.0 and `neko support status` reports Codex 0.144.1 ready. Finally, the actual
  downloaded release binary completed GPT-5.6 Terra with exact response `RELEASE_ARTIFACT_OK` in 7.6 s.
- CI emitted only upstream informational annotations: checkout v4's Node 20 action is forced onto Node 24,
  and `macos-latest` is migrating to macOS 26. They did not affect any build/smoke; update checkout in the
  next maintenance pass rather than mutating the already-verified release tag.
