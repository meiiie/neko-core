# Neko Core — Work Log

Running journal of what was done and the decisions behind it. Newest entry first.
Rules that govern this work live in `RULES.md`.

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
post-change browser screenshot is still pending because the selected browser connection disappeared
during the audit; no deployment was made.

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
