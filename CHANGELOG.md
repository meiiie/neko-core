# Changelog

All notable changes to Neko Core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

## [Unreleased]

## [0.13.0] — 2026-07-16

### Added
- Word, Excel, and PowerPoint tasks now use typed inspect, mutation, and render tools through the existing
  approval boundary. The optional Office Support Pack is installed without administrator rights only after
  explicit consent, verifies its source, digest, executable, version, and protocol, and preserves source files
  through staged, validated, atomic replacement.
- An existing LibreOffice installation can provide independent whole-file PDF render evidence from an isolated
  temporary profile. Neko does not silently install LibreOffice or treat a successful render as semantic proof.
- Resident Windows UIA and the attached browser bridge can wait for a stable visible change locally. The bundled
  Messenger workflow uses those bounded watchers, fresh readback, and one-send-per-stable-message guards instead
  of repeatedly spending model turns on unchanged screens.
- Neko's compact prompt constitution now defines continuity, authority, evidence, retrieved-data distrust, and
  preservation of unrelated user work without importing product-specific assumptions from another agent.

### Changed
- Browser and Office requests now have state-aware guided setup. Neko keeps the original request, detects when
  setup becomes ready, and resumes it automatically; cancellation restores the request for editing.
- Natural bilingual Office artifact requests are routed before the provider call using high-confidence skill
  metadata, while up to three relevant skills may compose for mixed tasks. This adds no model call, embedding
  service, network route, or runtime dependency.
- Browser setup reports files-ready, bridge-online, extension-connected, and tab-attached as separate states
  instead of implying that opening Chrome's extensions page installed an unpacked extension.

### Fixed
- ChatGPT gateway `520`-`524` responses are retried as transient failures, and an exhausted HTML error page
  is reduced to a short upstream-error message instead of dumping markup and CSS into the transcript.
- Markdown tables may shorten a long link's visible label to fit the terminal, but its OSC 8 target now keeps
  the complete URL so Ctrl+Click opens the exact product page.

## [0.12.1] — 2026-07-14

### Added
- The first agent session now creates `~/.neko-core/NEKO.md` once with a compact, editable origin story,
  character, values, and truth boundary. Existing identity files are never
  overwritten, including by forced config initialization.
- Zero-setup memory bootstrap creates separate `memory/user.md` and `self.md` core profiles once. `/memory`
  exposes status, list/read/forget, identity, and non-destructive on/off controls.

### Changed
- Product, agent, TUI, installer, Relay, MCP, and documentation naming is unified under **Neko Core**.
  The `neko code` command remains as a compatibility alias for existing scripts.
- Global `NEKO.md` is explicitly the cross-project identity/life-story layer, while project `NEKO.md` files
  remain project-specific instructions and memory. Mutable cross-project observations stay in bounded core
  profiles instead of growing the identity prompt. Narrative history cannot grant permissions or substitute
  invented memories for evidence.
- Compaction now emits a structured continuation capsule and fairly clips every old message, preserving goals,
  corrections, decisions, verification evidence, open work, and references without letting one huge tool result
  consume the summarizer input. Archival search uses token/accent matching instead of exact-substring-only recall.

## [0.12.0] — 2026-07-14

### Added
- Claude and xAI now have direct first-party adapters for their official Messages and Responses APIs,
  including streaming tools, vision, structured output, provider-native reasoning continuation, live model
  capabilities, and bounded recovery. Kimi Code adds an official device-OAuth route alongside Kimi Platform;
  DeepSeek V4 and Gemini API remain direct API-key routes. No local subscription proxy is involved.
- Browser control now has an in-app `/browser` setup flow. After the user explicitly opts in and attaches a
  tab, ordinary Neko sessions own the authenticated loopback bridge lifecycle. Extension 0.3.0 reconnects
  after Manifest V3 worker or bridge restarts while preserving separate read, click, and typing grants.
- `bun run eval:terminal` runs the exact working-tree binary through the public Harbor/Terminal-Bench 2
  runner with isolated homes, bounded defaults, unmodified task verifiers, and ephemeral OAuth transfer.

### Changed
- Reasoning effort is a durable user preference negotiated against each model's advertised vocabulary or
  endpoint ceiling. Unknown future tiers pass through unchanged; the experimental read-heavy adaptive
  heuristic remains opt-in because it has not yet shown workload-neutral quality.
- Token UX separates cumulative multi-call traffic, the last request's actual context, cache reads, and the
  next estimate. Image estimates count decoded multimodal content instead of base64 transport text. Stable
  prompt seams and a compact playbook index reduced the measured repeated fresh-session estimate by 23.3%,
  while full lessons remain available on demand.
- Neko keeps one continuous identity and normal reasoning path across greetings and task turns. Repeated
  greetings retain conversation history and tone instead of entering a context-free fast path.

### Fixed
- Long file and web observations are paged below the retention guard, so formerly unreachable middle or tail
  content can be retrieved without a blank transcript gap.
- Kimi Code requests now use the official coding model and thinking contract, validate account access before
  claiming sign-in success, and refresh one Neko-owned device session without importing another CLI's tokens.
- Provider-native reasoning data is replayed only to the exact protocol, sanitized endpoint, and model that
  produced it. Missing Anthropic/xAI credentials can no longer fall back to an unrelated provider key.
- Completion verification now checks clean-state acceptance criteria and terminates an evaluation process
  group before the external verifier runs, preventing stale output and timeout races from becoming false
  completion evidence.

## [0.11.5] — 2026-07-12

### Changed
- Google sign-in now reflects Google's 18 June 2026 product change: Gemini CLI consumer OAuth no longer
  serves Free, AI Pro, or AI Ultra. Neko recommends the supported Gemini API-key route first and labels CLI
  OAuth as Code Assist Standard/Enterprise only. Antigravity remains a separate official product; Neko does
  not reuse its credentials or scrape its TUI.
- The optional Gemini CLI Support Pack is now offered for both supported Neko routes. Previously the API-key
  picker accepted a key without ensuring that its required ACP executable existed.

### Fixed
- Gemini's consumer-deprecation response is converted into an actionable migration message instead of a raw
  ACP backend error, while unrelated authentication failures remain unchanged.

## [0.11.4] — 2026-07-12

### Fixed
- The in-binary self-updater now uses the same official latest-release redirect fallback as the one-line
  installers when GitHub's unauthenticated API is rate-limited. It also requires the published SHA-256
  sidecar, runs the downloaded binary's version probe before replacing Neko, and restores the original if
  activation fails after the backup rename.

## [0.11.3] — 2026-07-12

### Fixed
- Windows and Unix installers now fall back from GitHub's unauthenticated API quota to the official latest-
  release redirect and published SHA-256 sidecar. Installation remains fail-closed and still verifies the
  checksum plus the binary's embedded version before atomic replacement.
- Settings writers now accept the same single UTF-8 BOM as the config loader. This lets plain `neko update`
  actually clear a pinned installer's `auto_update: false` instead of only printing that updates resumed.

## [0.11.2] — 2026-07-12

### Fixed
- Running plain `neko update` now resumes automatic updates even when Neko is already on the latest release
  (or a source checkout cannot replace itself). Previously the updater's no-download early return left
  `auto_update: false` behind after a pinned installer/update, despite telling users that plain update returns
  them to the latest channel.
- Config loading now accepts the single UTF-8 BOM that Windows PowerShell 5 may write before otherwise valid
  JSON. This prevents the TUI from failing at startup after a pinned installer updates `config.json`.

## [0.11.1] — 2026-07-12

### Fixed
- The Gemini managed-runtime discovery fixture now uses the runner's native path semantics. The v0.11.0
  product binaries were healthy, but the fixture simulated a Windows manifest using real filesystem checks
  on Linux/macOS, leaving `main` CI red after the tag. Windows, Linux, and macOS now exercise the same
  managed Support Pack behavior using each host's actual runtime filename and separators.

## [0.11.0] — 2026-07-12

### Added
- **Google-account Gemini is a first-class subscription route.** `/login` can use Free, AI Pro, or Ultra
  quota through the official Gemini CLI ACP protocol, while Gemini API keys remain a separate billing
  route. The optional Support Pack verifies Google's published bundle plus a private Node LTS runtime,
  installs atomically without admin/global npm, and does not enlarge the base Neko binary.
- **Neko Browser Bridge and a public-ready Chrome extension.** Users can attach exactly one chosen tab,
  keep existing website sessions, grant click/navigation and non-sensitive typing separately, see an
  always-visible AI indicator, inspect a redacted audit trail, and emergency-detach. The bridge is
  loopback-only and capability-scoped; cookies and typed text never travel through Relay.
- **Subscription voice with local consent.** ChatGPT realtime voice is negotiated through the official
  App Server route, starts the microphone only after an explicit browser click, keeps terminal tool
  approvals authoritative, and stops on tab close, heartbeat loss, or the local Stop control. A local
  browser speech path remains available without silently falling back to paid API billing.
- **Application skills for Zalo and WeChat.** Both use the shared computer-use primitives and require
  fresh inspection after state-changing actions instead of claiming completion from an input event alone.

### Changed
- **Computer use is resident, DPI-aware, and outcome-verified.** UIA, Unicode keyboard input, touch,
  optional SendInput, scroll, wait, and virtual-desktop screenshots now share one serialized Windows host.
  On the measured Windows machine, warm screenshots fell from 972/1,143 ms p50/p95 in the one-shot path to
  71–119 ms and include frame id, sampled delta, and changed-region evidence. A tool returning success no
  longer permits a completion claim until a fresh inspection confirms the postcondition.
- **Relay and terminal UX stay in sync more closely.** Mobile layouts, approvals, focus recovery, slash
  suggestions, transcript hierarchy, user-message contrast, tool-output spacing, and scroll behavior were
  polished while preserving encrypted multi-session routing and remote Stop.
- **Web reading handles long feeds more deliberately.** Feed collection and page-to-Markdown paths preserve
  useful structure while reducing blank transcript space and oversized intermediate output.

### Fixed
- Windows actions no longer confuse the DPI-virtualized `1536x864` desktop with a physical `1920x1080`
  display at 125% scaling; display, capture, UIA, and coordinate input now share physical virtual-desktop
  bounds, origins, and scale metadata.
- Computer, glob, todo, and skill calls now recover from malformed model arguments more reliably, and
  completion verification prevents repeated false-success reports after an unverified desktop mutation.
- Browser sessions can persist across Facebook, X, and other sites in Neko's dedicated profile, while the
  extension path can reuse an already signed-in selected tab without uploading browser cookies.

## [0.10.0] — 2026-07-11

### Added
- **ChatGPT Plus/Pro is a first-class OpenAI account route.** `/login` now guides users through
  OpenAI -> ChatGPT subscription or API key without mixing credentials or silently falling back to
  API billing. `/model` uses the signed-in account catalog, `/effort` follows each model's declared
  reasoning tiers, `/usage` reports quota windows/credits, and `/logout` removes only the selected
  authentication route and releases its provider process.
- **GPT-5.6 Sol, Terra, and Luna work through the official Codex App Server protocol.** Neko reuses a
  compatible Codex CLI when present; otherwise the model picker offers an optional standalone Support
  Pack. GPT-5.5, API providers, Ollama, and local models download nothing. The bridge starts on demand,
  uses the existing ChatGPT OAuth session, keeps Neko's approval/sandbox boundary authoritative, and
  stops on logout/model switch/exit or after 15 idle minutes. Windows x64 measurements: 92.7 MiB
  Support Pack download, 270.4 MiB installed, 34.7 MiB idle working set, 184-186 ms handshake.
- **One-line installers are transactional and release-verifying.** Windows checks official GitHub
  release metadata, exact asset size, SHA-256, and the binary version before atomic replacement.
  macOS/Linux v0.10+ downloads a published SHA-256 sidecar, verifies it and the version in staging,
  then atomically renames. Failed downloads or checks never destroy the previous working Neko binary;
  historical pinned rollback releases remain supported.
- **Relay v3 is a real multi-session remote terminal.** One persistent pairing is now a hub for every
  running Neko process: the phone lists/switches sessions, routes Send/Stop/offline queues independently,
  runs different sessions concurrently, and preserves a bounded transcript plus draft per session.
  Session title, cwd, model, and busy state are E2E-encrypted metadata; the Worker routes only opaque
  host ids. The old centered paired card is gone in favor of the terminal transcript, with the same
  `> ` prompt/process lines/status model and accessible control labels. `/relay new` now revokes the
  entire old hub before rotating, while v1/v2 compatibility remains.
- **Images are inline `[Image #N]` tokens now.** Alt+V drops the token at the caret — it travels
  inside your sentence, and deleting the token detaches the image (the Claude Code affordance).
  The separate "image attached" banner and badge are gone.
- **Text-only models can read images.** The caption-then-reason bridge: when the active model can't
  see (`vision` off), a vision model (`vision_model`, defaulting to a free NVIDIA VLM on NVIDIA
  endpoints) transcribes the image — verbatim text/code/errors, tables as markdown, compact layout —
  and the description replaces the token in place. Vision-capable mains still get the real image;
  with neither, the note says exactly what to configure. Image content is treated as untrusted data,
  never as instructions.
- `/model` now saves the model into the **active profile** instead of a top-level `model` that
  silently shadowed every profile (the footgun `neko doctor` warns about — /model itself was
  recreating it).
- **Current frontier routes are explicit profiles.** `--profile nvidia` defaults to `z-ai/glm-5.2`
  with `NVIDIA_API_KEY`; `--profile fable` runs `claude-fable-5` with native vision and a
  profile-specific 2576px / 4.5MB clipboard-image budget.

### Fixed
- **GUI eval v2 no longer grants false passes for repaired constraint violations.** Opening a wrong
  item before the target, changing a forbidden setting and changing it back, claiming the banking
  offer, or taking the interrupting survey now remains a verifier-visible violation. GUI bench-log
  records carry `harnessVersion: 2`, so stricter scores are not silently compared with v1 runs.
- **A pasted screenshot no longer poisons the session.** `/paste` (Alt+V) used to attach the clipboard
  image raw — a multi-MB PNG became ~1M base64 characters, overflowed any model's context window
  (`max_tokens must be at least 1, got -102511`), and then kept re-overflowing from history on every
  later turn. Images are now normalized at the source on all supported desktop OSes (JPEG q82;
  longest edge and byte ceiling are profile data, with a conservative 1568px default), oversized
  attachments are refused with the size and the fix, and the in-loop
  context relief can now free pasted images from earlier turns (the current turn's attachment always
  survives). The temporary clipboard capture is removed after its bytes are embedded instead of leaking
  one `neko-paste-*` file per Alt+V.
- **`[Image #N]` is now truly inline on the model wire.** Multiple pasted images keep their exact
  text/image ordering through the core content parts and NVIDIA's `<img>` conversion instead of being
  silently moved after the whole prompt.

### Added
- **Relay v2 — the phone experience, rebuilt** (host + Worker + web client, deployed and live-verified
  end-to-end 10/10 on real Cloudflare infrastructure):
  - **Live streaming to the phone.** The host now holds a hibernation-friendly WebSocket to the Worker
    and streams the growing reply as throttled, still-E2E-sealed partial frames — the phone watches
    Neko type instead of staring at dots for minutes. The web client renders markdown-lite (code,
    bold, links, bullets).
  - **Stop from the phone.** The send button becomes a Stop button while a turn runs; the interrupt
    reaches the host mid-turn over the socket.
  - **Pairing that survives restarts.** `/relay` persists the pairing in `~/.neko-core/relay.json` —
    restart Neko and an already-paired phone reconnects by itself; `/relay new` rotates it.
  - **No more silent death.** Session state (token binding, queued jobs, results) moved into Durable
    Object storage: an eviction (laptop asleep) no longer kills the session, a message sent while the
    host is offline queues durably and runs on reconnect, and the phone's status pill now asks the
    relay whether Neko is actually online (`/alive`) instead of guessing.
  - **Cheaper to keep on.** The old 1-second long-poll kept the Durable Object awake 24/7; with
    WebSocket hibernation it sleeps between messages (free-plan friendly). Messages from the phone
    now WAIT for a busy turn (like the desktop input queue) instead of being dropped.
  - Fully backward compatible: an old binary works against the new Worker (v1 long-poll endpoints
    kept), and a new binary degrades to long-poll against an old Worker or where WSS is blocked.
  - **The phone shows the terminal experience.** Tool activity streams live as the same
    `Read(src/agent.ts)`-style lines the terminal shows (a monospace process log with a braille
    spinner), above the growing reply. The web client was redesigned around the actual Neko mascot
    and its amber palette (real logo as favicon/app icon/header), with a cleaner message layout.
  - **Wrong-secret pairing is now diagnosable instead of cryptic.** The host answers a message it
    cannot decrypt in plaintext with the exact fix (v1 sealed that error with the same mismatched
    key — guaranteed unreadable); the relay stores a public fingerprint of the secret so the phone
    flags "key mismatch" before sending; pairing from the QR fragment now persists immediately
    (v1 only saved it if you typed manually — a reload unpaired you); and a "paste pairing link"
    field pairs even in in-app browsers that strip URL fragments (Messenger).
  - **The QR is a first-pairing affordance, not daily chrome.** `/relay` prints a compact status
    (the pairing persists anyway); the code appears only on first pairing, `/relay new`, or
    `/relay qr`. (The half-block QR renderer is already the scannable optimum — terminal cells are
    ~1:2, so two modules per cell is the squarest packing; you can't shrink a 100-char pairing URL
    further without weakening the keys. So the fix is showing it once, not shrinking it.)
  - **The web client is now the Neko terminal, on your phone.** Rebuilt to match the CLI the owner
    likes: full monospace, the exact terminal amber (`#e6932e`), dim `─`-style rules, a `>` prompt
    composer, and a bottom status bar — messages render as a terminal transcript (`> you` in cyan,
    `●` tool lines, flowing replies) instead of chat bubbles. The layout is capped to a centered
    820px column framed like a terminal window, which fixes the desktop view stretching edge-to-edge
    on wide screens. Unpaired devices get a single calm pairing card (mascot, one paste-link box,
    "manual setup" tucked away) instead of five raw fields dumped on screen.
- Plain info lines in the transcript (relay pairing URLs, update notes) are now OSC 8 hyperlinks too.
- **`neko setup tavily <key>`** — the no-Docker rung of the search ladder: verifies the key against the
  live Tavily API, then wires it into the gitignored user config (`tavily_api_key`, redacted by
  `neko config`; `TAVILY_API_KEY` env still wins). `web_search` failures now walk DOWN the ladder —
  SearXNG down falls back to Tavily when a key is wired, then DuckDuckGo — instead of jumping straight
  to the free floor.
- **`neko doctor` names the model-shadowing footgun.** When a top-level `model` in a config file (or
  `NEKO_MODEL`) overrides the selected profile's preset model — documented overlay order, but a real
  trap: `--profile x` silently keeps the file's model — the `model` check turns into a WARN naming the
  exact file, both models, and the fix.

## [0.9.0] — 2026-07-10

### Added
- **Links in the transcript are real terminal hyperlinks (OSC 8).** `[label](url)` now carries its URL
  (it used to be dropped entirely), bare URLs and existing file paths are Ctrl+Click-able with a hover
  tooltip in Windows Terminal (and WezTerm/iTerm2/kitty), and a long product URL wrapped across 2–3
  terminal lines still opens as one link — where plain terminal auto-detection gives up. Selection,
  copy, and the renderer's column math are all hyperlink-aware; copying a bare URL still yields the URL.
- **SearXNG is now a managed, on-demand sidecar (the Ollama keep_alive pattern).** After a one-time
  `neko setup web`, the container costs zero RAM while idle: `web_search` wakes it automatically when a
  search needs it (one `docker start` + health check, ~5–10s on the first search) and stops it again
  after `searxng_keepalive` idle minutes (default 15; `0` = keep running), including on process exit.
  A container Neko didn't start is never touched, Docker Desktop is never launched or killed, and a
  stopped daemon just means the search falls through to Tavily/DuckDuckGo instantly. `neko doctor`
  reports the lifecycle state; zero-config users with Docker installed get a one-time tip.
- **`neko bench gui` — a long-horizon computer-use eval on a deterministic simulated desktop.** The
  configured model drives a scripted GUI world through the real `computer` tool; verifiers measure task
  success, constraint-holding, error recovery, precise action, and coordinate grounding. `neko bench
  gui hard` adds cross-screen memory, paged lists with decoys, interrupt dialogs, and guarded submits,
  with budgets calibrated from live runs (gpt-oss-120b: base tier 12/12, hard tier 11/12).
- Added `Alt+C` to copy the complete current draft without clearing it, including the expanded contents
  behind collapsed paste placeholders.
- Made `computer screenshot` a first-class multimodal observation: vision-enabled models receive the
  captured screen directly, strict OpenAI-compatible and Anthropic transports preserve the image, and
  the TUI renders `[image]` instead of object-coercion noise. Text-only drivers keep the saved path for
  the separate vision helper, and context relief retains the two most recent tool images under pressure.
- Extended the gated Windows `computer` tool with Unicode `type`, shortcuts via `key`, mouse-independent
  `scroll`, bounded `wait`, and `open` for apps/files/URLs. Exact-control focus is verified before typing,
  with a disposable WPF/UIA probe covering the real input path.

### Fixed
- Embedded built-in skills and their helper assets into standalone executables; release binaries now expose
  the same skill catalog as source runs and materialize executable helpers into a per-process temp directory.
- Validate todo plans atomically and preserve the prior plan on malformed updates; an agent with open todos
  now gets a persistence/verification pass before it can finish without reconciling the plan or naming a blocker.
- Hardened the interactive fullscreen UX: todo plans render once and survive compaction, Ctrl+Up/Down
  no longer recalls prompt history, approval feedback is not repeated, and first-run status names a
  missing model clearly.
- Removed one-frame raw-Markdown flashes when a streamed answer commits, and made resize repainting
  compose the new frame while clearing the physical spare row instead of replaying stale content.
- Unified CLI/TUI/subagent tool wiring: native web fallback, vision, skills, sandbox, disabled-tool and
  adversarial boundaries now compose consistently while namespaced MCP tools remain first-class.
- Correctly accumulate interleaved parallel OpenAI-compatible tool-call streams by index.
- Redact nested MCP secrets, parse boolean `NEKO_*` values by type, and retain keys per built-in profile.
- Gate mutating memory/workflow/playbook actions, persist pinned session titles, page deep into large files,
  load `AGENTS.md`, and hide the Windows-only computer schema on other platforms.

### Changed
- Architecture tests now cover every core/adapter source file; the unused `ink-spinner` dependency is gone.

## [0.8.3] — 2026-07-08

### Fixed
- **Arrow keys move the caret again.** With the hardware-cursor caret (0.8.2), moving the cursor left/
  right leaves the visible text identical (only the zero-width marker shifts), so the renderer treated
  the frame as unchanged and skipped repositioning the cursor. It now detects a caret-only move and
  re-places the hardware cursor even when the text is byte-for-byte the same.

## [0.8.2] — 2026-07-08

### Fixed
- **The input caret is now the terminal's real cursor — a thin bar BETWEEN cells (like Claude Code's
  "khả|o"), never a drawn glyph.** A glyph caret always occupied a full cell, so the cursor before a
  character read as a gap ("chà▏o") and the blink toggled a space in and out of that cell. TextInput
  now draws no glyph and marks the caret with a zero-width sentinel; the renderer strips it and places
  the real hardware cursor (a bar, blinked natively by the terminal) at that column — tight text, no
  gap, no blink flicker. `NEKO_CARET` picks the shape (bar/block/underline). Removing the old blink
  timer also surfaced and fixed a latent bug where the transcript could go blank after a window resize.

## [0.8.1] — 2026-07-08

### Fixed
- **Drag-select can now run past the fold.** The mouse drag-to-copy selection was anchored to the
  visible screen and cleared on any scroll, so you couldn't drag UP past the top edge to select text
  above the viewport. It's now anchored to CONTENT rows: dragging at/above the top (or at/below the
  bottom) auto-scrolls the transcript and the highlight keeps extending over the revealed text; the
  highlight follows the text as you scroll (no longer dropped), and copy captures the whole selection
  even the part that's off-screen.

## [0.8.0] — 2026-07-08

Editing, input UX, and lifecycle polish — with a professional version-rollback path.

### Added
- **Version rollback that STICKS.** `neko update 0.7.7` downloads an EXACT version (up or down — a
  real downgrade) and pauses auto-update so the daily updater can't drag you forward again; `neko
  update` (no version) returns to latest and resumes auto-updates. Installers take the version as an
  argument (rustup/uv-style): `sh -s -- --version 0.7.7` (unix) / `-Version 0.7.7` via a scriptblock
  (Windows), with `NEKO_VERSION` as a fallback. The hold is written as `auto_update: false` (NOT a new
  config field) precisely so the version you roll back TO honors it — the pin actually holds instead
  of being auto-upgraded on the next launch.
- **Ctrl+G opens the prompt in `$EDITOR`.** Edit a long prompt in your real editor (suspends the TUI,
  restores the alt-screen/mouse around it), pastes collapse to `[Pasted #N]` placeholders and expand
  back for editing.
- **`neko doctor` shows the file-search backend** (ripgrep vs the built-in JS walk) so you can confirm
  the fast path (ripgrep IS used when installed — verified 14.1.1).

### Fixed
- **Long input no longer lags** (O(1) windowed input render) and **wraps by WORD**, not mid-word
  ("đã đấ|m" → the word carries whole to the next line); the footer truncates on narrow terminals
  instead of wrapping into an extra chrome row.
- **The caret is a tight inserted bar** (`wo▏rld`), never a block, and stays tight through the blink
  (the off-phase is invisible, so no `wo| rld` gap); `caret_glyph` / `NEKO_CARET` is honored.
- **An interrupted turn survives a resume.** The session is now persisted incrementally at each clean
  checkpoint (step / completed tool result), so closing the terminal mid-task no longer loses the
  prompt and the work Neko did — resume shows the interrupted state instead of nothing.
- **The exit-plan-mode box respects terminal width** (down to very narrow terminals) instead of
  overflowing at a fixed 80 columns.

### Changed
- Internal refactors toward the Ports & Adapters boundary: `adapters/web.ts`, `agent-constants.ts`,
  and `chat-lines.ts` extracted; approval flow gains a committed-visual micro-feedback before resolve.

## [0.7.7] — 2026-07-07

### Fixed
- **Overall Windows lag (typing, streaming, scrolling): the frame differ is BACK ON, paired with a
  self-healing resync.** 0.7.6 cured the duplicated-chrome ghost by disabling the differ on Windows,
  but that traded away the whole render economy - every keystroke, stream delta and scroll step fell
  back to full Ink frames (bench: scroll first-response 15ms -> 63-76ms, with a 391ms render backlog
  after a flick). The ghost's real damage was PERSISTENCE, so instead of disabling the differ the
  displacement's lifetime is now bounded: a full ABSOLUTE repaint of the model (CUP+EL per row -
  immune to conhost's displacement, erases anything stale) lands ~400ms after every write burst and
  at least every 2s during sustained activity - a curses-style ^L, automated. Measured through a
  real ConPTY: scroll first-response 11ms (0.7.0-class), typed-echo OK, and the e2e ghost harness is
  clean 3/3 where the unhealed differ ghosted 3/3. `NEKO_INCR=0` still disables the differ entirely;
  that fallback path keeps instant coalesced scrolling and stays sim-locked in CI.
  The heal is surgical about WHEN it runs: Windows-only (elsewhere the displacement does not exist -
  an SSH link should not pay ~10KB per pause for nothing), and only structurally-risky writes arm it
  (many rows changing at once); the caret blink and spinner ticks do not, so an idle session is
  byte-silent (measured: 667 bytes over 5 idle seconds - pure blink, zero heals).

### Added
- **`scripts/bench-scroll-conpty.ts`**: scroll-latency bench through a real ConPTY (first-response /
  settle / bytes), with baselines recorded in the header - scroll feel is now measurable, not
  debatable.
- **Reference-terminal fidelity**: the harness VT gained lazy autowrap (DECAWM) and ECH, and the
  differ-on ConPTY stream was sequence-inventoried against it - verdicts no longer rest on a parser
  with blind spots.

## [0.7.6] — 2026-07-07

### Fixed
- **Duplicated footer/prompt rows on Windows (ghost chrome): the frame differ is now OFF by default
  on Windows.** Mid-turn, a one-row-shifted copy of the input line and status footer stayed on
  screen next to the live ones (latent since at least v0.7.4 - reproduced deterministically on a
  new REAL-ConPTY e2e harness). The investigation peeled four real hazards, each fixed and each
  insufficient alone: Ink's raw newline-flow first frame could scroll the real screen (seeds/resyncs
  now paint ABSOLUTE rows, always); hardware scrolls could fire across a band-geometry change
  (`paintedBand` gate) and displace content outside the DECSTBM region on ConPTY (now off by default
  on Windows, `NEKO_HWSCROLL` overrides); DEC 2026 brackets reached terminals we had denied because
  Ink emits its own BSU/ESU (now stripped whenever 2026 is denied). The residual displacement still
  reproduced with a pure absolute-CUP stream - it lives in conhost's buffer/viewport handling, not
  in our bytes (they replay clean through the reference VT) - so Windows now takes Ink's plain
  full-frame writes: with the differ off the same e2e runs are clean 100% (typing verified live in
  every run). Unix keeps the full differ + hardware scroll. `NEKO_INCR=1` force-enables on Windows
  for experiments.
- **Typing dead on Windows Terminal (dev-only regression, never released).** Dropping WT from the
  2026 allowlist sent every WT session into the DECRQM probe, whose pre-Ink stdin pause left input
  permanently silent under Bun on Windows - AND the probe re-enabled 2026 (WT answers "supported").
  The support decision is now three-state (`yes`/`no`/`unknown`): known answers never probe, Windows
  never probes, `NEKO_SYNC=0` is a hard no, and the probe no longer pauses stdin. The e2e harness
  now emulates real WT (WT_SESSION + DECRQM reply) and asserts typed keys ECHO in every run - both
  failure modes are locked.

### Added
- **Render forensics.** `NEKO_TRACE_FRAMES=<file>` taps every differ decision AND every byte that
  reaches stdout (base64 NDJSON), and `scripts/e2e-conpty-ghost.ts` runs a real binary under a real
  ConPTY and counts duplicated chrome rows over a live turn - together they separate "our bytes are
  wrong" from "the terminal executed correct bytes wrongly" in minutes.
- **`bun-stable-watch` workflow.** The canary pin is deliberate, temporary debt - and now the repo
  calls it in itself: a daily cron checks Bun's releases and files a revert issue (with the full
  payoff checklist) the day the first stable after 1.3.14 ships. No human memory involved.
- **Runtime forensics.** Every release compile logs `bun --revision` first, so the exact
  version+commit of the embedded (rolling-canary) runtime is on record for every shipped binary.

## [0.7.5] — 2026-07-06

### Added
- **Input smoke gate: the whole "renders but can't type" class is now caught before shipping.**
  `scripts/input-probe.ts` spawns the compiled binary's `doctor keys` under a REAL pseudo-terminal
  (Bun.Terminal: ConPTY on Windows, forkpty elsewhere), types into the master side, and asserts the
  byte makes the full round trip (write -> PTY -> raw stdin -> hex echo -> verdict). Wired into
  `bun run build` (so CI runs it on all three OSes) and into the release smoke step right next to
  `__uiprobe` - a runtime that drops stdin renders perfectly and fails ONLY here. Verified on
  Windows (ConPTY) and Linux (WSL) against real binaries.

### Fixed
- **Typing dead on some Windows machines: the Bun 1.3.14 runtime, not Neko.** Field report (with an
  agent-driven on-machine diagnosis): the session renders perfectly but no keypress ever arrives -
  Ctrl+C included. A minimal `stdin.setRawMode(true)` probe under stable Bun 1.3.14 receives ZERO
  bytes on the affected machine while Node in the same terminal receives them all, and the same
  probe under Bun canary 1.4.0 works; a Neko rebuilt on the canary runtime takes input again
  (`doctor keys` shows the bytes). Releases are now compiled on the canary runtime until the first
  stable after 1.3.14 ships (pinned + documented in the workflows). Machine-dependent: many Windows
  boxes are fine on 1.3.14 - if yours types, nothing changes.
- **Installer: PATH is now compared per ENTRY, never by substring.** The old wildcard check saw the
  pre-v0.3 `...\Programs\neko-core` entry, decided `...\Programs\neko` was "already on PATH", and never
  added the real install dir - so after shadow healing removed the old exe, `neko` was not recognized
  at all. The installer now matches exact PATH entries (case/trailing-slash tolerant), prepends the
  install dir into the CURRENT shell as well (works immediately under `irm ... | iex`), and cleans the
  dangling `Programs\neko-core` PATH entry + empty dir left behind by the pre-v0.3 installer.

### Added
- **`neko --doctor`** as an alias of `neko doctor` (previously the flag was silently ignored and
  dropped you into chat). Both installers now end by suggesting `neko doctor` and `neko --yolo`.
- **Terminal/input diagnostics.** `neko doctor` now reports the hosting terminal, stdin/stdout TTY +
  raw-mode capability, and the effective UI fps (+ detected display Hz). New `neko doctor keys`: a raw
  key probe OUTSIDE the UI stack - it prints every byte the terminal delivers (hex + printable) for 10s
  and issues a verdict. This is the triage for "the session renders but typing does nothing": zero
  bytes = the keyboard never reaches neko (terminal/ConPTY/antivirus level); `CSI ..._` bytes =
  win32-input-mode was stuck on; plain bytes = the input layer is fine.

### Fixed
- **Stuck win32-input-mode heals at startup.** DEC private mode 9001 (Windows Terminal's
  win32-input-mode) left ON by a previous app makes every keypress arrive as `CSI Vk;Sc;Uc;Kd;Cs;Rc _`
  - the UI renders fine but typing looks completely dead. The terminal-hygiene reset every neko run
  performs at entry (and teardown) now turns it off alongside the mouse modes.
- **"display detected at 59Hz" confusion.** Windows WMI reports the floor of fractional refresh
  timings (59.94Hz panels read "59"). Detection now snaps floor-reported rates to the marketing rate
  (59->60, 119->120, 143->144), so a plain 60Hz monitor no longer prints a mysterious 59Hz/59fps line
  (it prints nothing at all - 60 is already the default).

### Changed
- **Installer polish (grok-class) + shadow diagnosis.** Both installers now fetch and SHOW the version
  being installed, draw a clean single-line progress bar, run the installed binary and report its real
  version, always state the PATH situation (Windows now PREPENDS to the User PATH), and - the important
  one - detect OTHER `neko` executables on PATH that would shadow the fresh install and print the exact
  removal commands. That shadow was exactly the "installed the new version but `neko --version` still
  says 0.2" trap. Served live from `main`; no release required.

## [0.7.4] — 2026-07-06

### Added
- **Auto-update, on by default (Claude-Code style).** The daily startup check now INSTALLS a newer
  release in the background instead of only notifying: the download stages next to the running binary
  and swaps in atomically (Windows uses the rename-out-of-the-way trick), taking effect on the next
  launch - the session in progress is never touched. Opt out with `auto_update: false` or
  `NEKO_AUTO_UPDATE=0` (notify-only), or silence checks entirely with `auto_update_check: false`.
  `neko update` remains for manual runs. Source (bun) runs are never auto-updated, and the updater only
  moves forward - a dev build can't be clobbered by an older release.

## [0.7.3] — 2026-07-06

### Changed
- The executable icon is now the mascot EXACTLY as it appears in the banner: the ハ・・マ pixels are
  extracted 1:1 from `neko-core-banner.png` (`assets/mascot-art.txt`) and rendered in brand orange -
  no redrawn approximation. Downscaling uses coverage sampling so thin strokes survive at 16px.
- New `assets/social-preview.png` (1280x640, dark) for the GitHub social card: the banner recolored -
  orange mascot + white NEKO CORE (upload via Settings -> Social preview).

## [0.7.2] — 2026-07-06

### Changed
- The executable icon is now the mascot itself — the kaomoji ハ・・マ in brand orange, thin strokes and
  negative space, exactly as it appears in the banner and the in-app logo (owner call: the kaomoji IS the
  brand; the interim filled cat face is gone).

## [0.7.1] — 2026-07-06

### Added
- **Branded Windows executable** — the compiled `neko.exe` now carries proper PE metadata: Task Manager
  shows **Neko Core** (was "Bun"), Explorer shows the pixel-cat icon, and file properties list The Wiii
  Lab, the version, and the MIT copyright. The icon is *generated from code*
  (`scripts/make-icon.ts` → `assets/neko.ico`, 16-256px) — reviewable pixel art in the brand orange, no
  opaque binary blobs.

### Fixed
- Ink is told `interactive: true` explicitly: a shell that exports `CI=true` (or any CI-ish env var) no
  longer freezes the UI — Ink's is-in-ci detection used to stop frame writes even on a real TTY. The same
  detection made every UI test silently blank on GitHub runners; the suite now forces interactive in its
  render harnesses and passes identically with and without CI env vars.
- UI tests pass the mode explicitly (a tests-only `fullscreen` prop) — bun ≥1.3.14 test scheduling made
  cross-file env mutation and even the bunfig preload unreliable.

## [0.7.0] — 2026-07-06

The fullscreen release: Neko's terminal UI became an app-owned, flicker-free viewport — built through
nine measured optimization rounds and a week of daily dogfooding on a real 144Hz Windows terminal, then
verified natively on Linux. (0.6.0 was an internal milestone on the way and was never published.)

### Added
- **Fullscreen UI as THE interface** (alt-screen, like vim/htop). The transcript is an app-owned
  scrollable viewport: mouse wheel + PgUp/PgDn + Ctrl+arrows scroll with an ease-out glide, Ctrl+F finds
  in-transcript, a clickable "jump to bottom" pill (with a real hover state) appears when scrolled away,
  and markdown formats **live as it streams** (bold/headers/tables render mid-stream, not on commit).
  Terminals that can't host it (non-TTY / tiny) fall back to inline automatically.
- **FrameDiffer — a compositor-lite at the stdout layer.** Ink's full-frame rerenders are intercepted and
  shrunk to the changed lines, or to a real hardware scroll (DECSTBM + SU/SD: the terminal shifts the
  region; only revealed rows are painted). Keystrokes cost ~178 bytes instead of whole-screen rewrites;
  every emitted byte sequence is verified against a virtual terminal in tests. All fullscreen writes use
  absolute addressing — immune to real-terminal cursor drift (the class of "ghost input row" bugs).
- **ANSI row cache** — each transcript line renders to styled rows ONCE (hidden Ink instance), giving the
  viewport `<Static>`-like economics; a windowed background warmer (newest-first, time-budgeted chunks)
  keeps long sessions responsive.
- **Refresh-rate-aware rendering** — the display's Hz is auto-detected (Windows/macOS/Linux, cached) and
  drives the UI frame cap; `/fps [auto|30..240]` overrides.
- **Drag-to-select + copy** (fullscreen captures the mouse, so native selection can't reach the alt
  screen): a left-drag paints a solid selection rectangle, copies on release, persists for the habitual
  Ctrl+C, and confirms with a reserved-row "copied N chars" note that never shifts the layout. `/copy`
  (last reply) and `/copy all` write BOTH OSC 52 and the native clipboard (clip.exe UTF-16LE / pbcopy /
  wl-copy / xclip) — works on terminals that ignore OSC 52.
- **Session-aware tab title** — `🐱 <session>` (named once from the first message, stable across turns;
  `/title` pins), a pulsing `●`/`○` dot while a turn runs, restored on exit. Windows quirks defeated:
  the title stack is skipped (WT restores it mid-session) and a 1s keeper heals SetConsoleTitle clobbers
  from console children.
- **Editor-style input caret** — a thin green `▏` flush against the text, blinking when idle, solid while
  typing (mouse traffic doesn't hold it solid).

### Changed
- **Fullscreen is the sole interactive mode** — the `/fullscreen` toggle is gone (an entire class of
  alt-screen↔inline transition bugs went with it); `NEKO_FULLSCREEN=0` remains as an internal escape
  hatch, not a user-facing option.
- **Claude-clean exit** — leaving Neko restores the shell exactly as it was and prints only the
  `Resume this session with: neko --resume <id>` hint; the raw transcript echo is gone, and the
  "press ctrl+c again to exit" hint is an ephemeral status, not a transcript line.
- **Input chrome is layout-stable** — a reserved status row (paste hint / copy note), and the prompt box,
  find bar, pickers and approval boxes can never be flex-squashed on short windows.
- **TypeScript 7.0.1-rc (native Go compiler)** is the typecheck gate (~4x faster); CI cross-checks
  against 5.9 on all three OSes until 7.0 GA.
- **NODE_ENV=production baked into the compiled binary** (React dev-mode overhead was shipping — ~5x per
  frame) with a `__uiprobe` smoke test in CI so it can't regress.

### Fixed
- Session-index freshness key is now mtime+size (same-millisecond rewrites were served stale on ext4),
  with in-place migration for legacy indexes (no full re-parse stall on first `/resume` after upgrade).
- The `/resume` picker renders intact when scrolled (flex-squash mangled names) and the band re-composes
  on geometry changes (stale transcript rows could freeze over the picker).
- Mouse tracking can no longer leak into the shell: all 7 DEC mouse modes reset on exit, at process
  entry (self-heal after a hard kill), and via an unbypassable `process.on("exit")` restore.
- Verified natively on Linux (full suite + compiled binary); three Windows-centric tests made portable.

## [0.5.1] — 2026-07-03

Reliability + efficiency patch, driven by real dogfooding (every fix traces to a live failure).

### Fixed
- **Approval box no longer swallows a fast `y`** — the y/a/n handler lived in a `useInput` hook that only
  activated *with* the approval box; Ink paints the frame at React commit but attaches a toggled hook's
  listener in a later passive effect, so a key pressed the instant the box appeared fell into that gap and
  the box hung forever (this was also why two "flaky" CI tests failed deterministically on slow runners —
  root-caused via `git bisect` + instrumenting Ink). Approval keys now live in the always-mounted global
  hotkey hook: no activation window, no dropped keys.
- **Release builds can't lose an asset anymore** — every matrix job used to create the GitHub release
  concurrently; two jobs racing on a fresh tag each created one, the duplicate was discarded and its upload
  404'd (v0.5.0 shipped without `neko-linux-arm64` until a manual re-run). The release is now created ONCE
  by a first job (`gh release create`, idempotent) and the build matrix only uploads (`--clobber`).
- **HTTP 529 (`overloaded_error`) is retried, not fatal** — Z.ai returned Anthropic's documented overload
  status and the run died instantly; 529 joined the retryable set in both providers (with backoff), locked
  by a fetch-mock test.

### Added / Changed
- **Prompt-prefix cache stability + measurement** (research-grounded: Anthropic prompt-caching docs, Manus
  context engineering, *Don't Break the Cache* arXiv 2601.06007) — the `<env>` block is now a session-start
  SNAPSHOT (the per-turn `git status` dirty-count that invalidated the provider's prefix cache on every
  edit is gone; the model runs `git status` itself for live state), todos moved out of the system message
  (the `todo_write` result already recites the plan in-stream), and the anthropic provider sends explicit
  `cache_control` breakpoints (system-end + rolling last-message; ON by default, `prompt_cache: false`
  opts out, strip-and-retry self-heal for endpoints that reject them). Cache reads/writes are now measured:
  `/cost`, the bench summary and `bench-log.jsonl` report `cached` tokens across provider shapes
  (Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
  `prompt_cache_hit_tokens`).
- **Tool-error recovery directive** (Self-Harness, arXiv 2606.09498) — the FIRST failure of a mutating tool
  (bash/write_file/edit) injects a `[recovery]` observation at the point of error: DIAGNOSE the actual
  state → REPAIR the root cause → VALIDATE by re-running the failed check. Edge-triggered (a success
  re-arms it; persistent failure stays the unproductive-streak guard's job), append-only so the prompt
  prefix stays cacheable.
- **Procurement skill: two-stage INDEX → VERIFY sourcing** — price surveys now START from a comparison
  aggregator (websosanh.vn; one server-rendered fetch ≈ hundreds of offers), then verify the offers that
  answer the question (top-N for "most expensive", bottom-N for "cheapest", median band for "market
  price") on the merchant page (product-match + live price + stock), then gap-fill via the source MAP +
  search — with a new PC-components MAP section (HACOM, Phong Vũ, GearVN, An Phát, laptopworld…). A/B on a
  real errand: the old strategy answered a "highest price" query wrong (9.99M₫) at 75k tokens; the new one
  found the true answer (12.99M₫, verified live) at 50k tokens — cheaper and correct, even with the search
  backend degraded.

## [0.5.0] — 2026-07-02

- **Streaming stops jumping to the top; declutter + emoji alignment** — (1) **scroll jump** — a live region
  taller than the viewport made the terminal redraw from the top every frame while a long reply streamed. The
  reply now **progressively commits** its completed paragraphs to scrollback (via `<Static>`) once it outgrows
  the viewport, keeping the live region to the current paragraph, and the (stale) thinking trace is hidden once
  the answer starts streaming — so the live area stays within the terminal and no longer jumps. (2) a markdown
  horizontal rule (`---`) now renders as **plain spacing** instead of a full-width line (it read as clutter).
  (3) **emoji alignment** — table column widths use terminal display width (`string-width`, emoji = 2 cells)
  so a cell with an emoji no longer knocks the borders out of line, and keycap emojis (`1️⃣`) normalize to `1.`
  (they render as a misaligned box otherwise). Unit-tested (keycap normalize, wide-char table alignment, rule).

- **Wrapping no longer breaks words mid-character; LaTeX math renders as Unicode** — two fixes to how replies
  render: (1) **word-wrap** — markdown paragraphs were a `<Text>` with no width, so inside `<Static>` (+ the left
  gutter) they wrapped at the FULL terminal width and then spilled past the edge, and the terminal hard-wrapped
  them mid-character (Vietnamese "tương ứ" / "ng", the continuation dumped at column 0). Every transcript item is
  now width-capped to the inset content width, so text wraps at word boundaries within the gutter and never
  overflows. (2) **math** — a terminal can't render LaTeX, so `$...$` / `$$...$$` showed raw. A `mathToUnicode`
  converter now maps the common constructs to readable Unicode: `\frac{a}{b}` → `(a)/(b)`, `x^2` → `x²`,
  `\sqrt{...}` → `√(...)`, `\sum_{i=1}^{n}` → `∑ᵢ₌₁ⁿ`, Greek + operators (`\theta`→θ, `\times`→×, `\leq`→≤) —
  handling nested `\frac`/`\sqrt` (the quadratic formula renders as `(-b ± √(b²-4ac))/(2a)`). Inline `$...$`
  converts only when it actually looks like LaTeX, so a price like `$5 to $10` is left alone; the system prompt
  also nudges the model toward plain Unicode math. Unit-tested (`mathToUnicode`, width-capped wrap, display/inline).

- **Terminal-clean output: no emoji, real rules, readable elapsed** — three presentation fixes so replies
  look right in a monospace terminal: (1) the system prompt now tells the model to format for a monospace
  terminal and **avoid emojis** (decorative/keycap emojis like a digit-in-a-box misalign the columns — the same
  rule Claude Code uses); (2) a markdown horizontal rule (`---`) renders as a clean full-width box-drawing line
  instead of a partial run of ASCII dashes; (3) the live spinner's elapsed time reads `1m 00s` … `3m 14s` past a
  minute instead of an ever-growing bare `194s`. Unit-tested (`fmtElapsed`, box-rule render).

- **Horizontal gutter — the UI is inset from the terminal edges** — the whole REPL (transcript + live region)
  now sits inside a left/right padding instead of running flush against column 0, matching Claude Code's
  `paddingLeft={2}`. `<Static>` inherits the wrapper Box's padding, so one change indents both the committed
  history and the live area; width-sensitive rendering (markdown tables, dividers, the stream clamp) uses the
  padded inner width.

- **Long generations no longer time out mid-stream ("The operation timed out")** — the request timeout was a
  TOTAL cap (`AbortSignal.timeout(timeout_seconds)`) applied to the whole streamed response, so a legitimately
  long generation (e.g. a landing page across 3 files) was aborted once it crossed `timeout_seconds` (120s) even
  while tokens were still streaming in. It's now an **idle timeout**: the timer resets on every streamed chunk,
  so a healthy stream never times out and only a genuine STALL (no bytes for `timeout_seconds`) aborts. Fixed in
  both providers (`anthropic` — the Z.ai/GLM path — and `openai_compat`). Unit-tested with a slow-but-active
  stream (total time > budget, gaps < budget → completes). Also: the live **todo tracker** only shows while a
  turn runs (the committed "Update Todos" result is the record) — it no longer prints the plan twice.

- **Streaming no longer scroll-jumps to the top; list/footer/run-indicator polish** — the live streaming
  preview used to render the whole growing reply (up to ~60 lines), which overflows the terminal so Ink can't
  update it in place and **redraws from the top every frame** — the classic "it keeps scrolling to the top
  while generating" bug. The preview is now **clamped to the viewport height** (wrap-aware, tracks terminal
  rows) and rendered in a `compact` markdown mode (predictable height); the full reply still commits to the
  scrollback verbatim when it finishes. Also: a **`**Label**` line followed by bullets** is no longer glued to
  them (a list is treated as one block with a blank line around it); the **footer mode indicator** gets a `⏵⏵`
  chevron + indent; and the **in-flight tool dot** is blue and blinking. Unit-tested (`clampToRows`, list-block
  separation, compact-vs-normal height).

- **The `bash` tool runs real bash on Windows (not cmd.exe)** — an unsandboxed bash command used to spawn
  through `cmd.exe` on Windows, so the Unix idioms a model naturally emits (heredocs like `python - <<'PY'`,
  single-quoting, `$VAR`, pipelines) failed with `"<< was unexpected at this time"` and wasted agent steps.
  Neko now routes the tool through **Git-Bash** if present (`NEKO_BASH` override, then a Git install, then a
  git-derived path; WSL's `System32\bash.exe` is deliberately skipped because it can't see the Windows-drive
  workspace), falling back to the platform shell only when no bash is found. Dogfooded on OpenAI's GeneBench-Pro
  benchmark, where the old behavior cost answers; unit-tested (`plainTarget` / git-bash detection).

- **Terminal UI polish — bordered tables, vertical rhythm, a real Ctrl+O toggle, a live run indicator** —
  markdown **tables** now draw aligned box borders and are budgeted to the terminal width (the widest column
  shrinks, cells truncate to a single line) instead of overflowing and wrap-shattering their columns.
  **Paragraph spacing** is fixed: Ink collapses an empty `<Text>` to zero height, so blank markdown lines were
  disappearing and paragraphs ran together — blank lines now render as real rows (runs collapse to one), with a
  blank line above headings and around tables, for even vertical rhythm. **Turn separation:** each user prompt
  and each tool call now gets a blank line above it (matching Claude Code's per-message `marginTop`), so a prompt
  no longer glues to the previous turn's output or the tool call below it. **Ctrl+O** is now a proper expand/collapse **toggle** (it used to append a
  duplicate full copy every press and never collapse); the peeked output shows in the live region so a second
  press closes it. A tool call **in flight** shows live with a **blinking dot** and commits to the transcript
  with a solid dot when it finishes — a clear running-vs-done signal (deferred + keyed by call id so parallel
  tool calls pair correctly). Table layout is unit-tested (`fitColumns` / `truncCell` / bordered render).

- **`web_fetch` reads the web as Markdown, with deterministic per-platform routing** — a fetch now returns
  clean **Markdown** (`htmlToMarkdown`: keeps headings/links/lists, drops nav/scripts — the old flat strip
  threw links away). A **small page comes back whole with NO model call** (the markdown is the answer); a
  **large page paginates** (`page:N`) instead of truncating; results cache ~5 min. Known platforms route in
  **code, not a skill the model can ignore**: a **YouTube** URL → its **transcript** via `yt-dlp`, **GitHub**
  → `gh`, an **RSS/Atom** feed → a compact item list; each falls back to a normal fetch if the tool is missing.
  Opt-in `scrape_backend: "jina"` renders public JS/SPAs via Jina Reader (keyless). Measured: a YouTube ask on
  gpt-oss dropped from 7 calls / ~48k tokens (chasing fake-transcript sites) to **2 calls / ~16k**, and the
  same on glm-5.2 answered in 2 calls / ~9k. Size policy + compact reads learned from Hermes Agent; our own
  implementation. Unit-tested (`htmlToMarkdown` / `paginateWeb` / `vttToText` / `rssToMarkdown`).

- **Skills load deterministically by a `match:` trigger, not just fuzzy keyword overlap** — a skill's
  frontmatter may declare a `match:` regex (e.g. a platform URL for the new `web-reach` skill), checked FIRST
  so a clearly-matching domain skill loads even for short or non-English asks that token-overlap missed (a
  Vietnamese "lay transcript youtube ..." shared only ~3 English tokens and silently loaded nothing). Adds two
  skills: `web-reading` (efficient reads — a11y/markdown first, grab-once, no scroll-churn) and `web-reach`
  (route each platform to its best free backend). The doom-loop guard was generalized to nudge after N
  unproductive tool results (empty/duplicate), not just repeated identical calls.

- **Interactive provider/model switching in the REPL** — `/provider` picks a provider then chains into a
  model picker; `/login` runs a guided provider-picker wizard before capturing the key; both swap the live
  provider in place (`NekoConfig.adopt` + `agent.setProvider`) so a switch takes effect mid-session without
  restart. Keys still resolve on demand and are never stored or printed.

- **Provider extensibility — any provider is a profile + an env var (no config editing)** — built-in presets
  now declare a `key_env` (the env var holding that provider's key, e.g. `ZAI_API_KEY`, `DEEPSEEK_API_KEY`),
  resolved with the right precedence (a profile's own key beats a stray `OPENAI_/NVIDIA_API_KEY`; `NEKO_API_KEY`
  still overrides). So a multi-provider setup just means setting per-provider env vars and `--profile <name>` —
  no JSON surgery. New presets ride the Anthropic provider: `zai` (GLM Coding Plan, quota endpoint),
  `zai-openai` (Z.ai pay-as-you-go), `claude` (real Anthropic), plus `moonshot` (Kimi); `key_env` added to
  openai/groq/deepseek/mistral/together/fireworks/xai/openrouter/nvidia. Adding a new provider stays a one-line
  data edit. Unit-tested (key_env resolution + no cross-provider hijack).

- **Anthropic Messages API provider — run on Claude or a Z.ai GLM coding plan** — `provider: "anthropic"`
  speaks `POST {base_url}/v1/messages` (the Claude format, and the format Z.ai's GLM Coding Plan / OpenCode
  endpoint `https://api.z.ai/api/anthropic` expects). It's a config choice, not a core change — same Provider
  port as openai_compat. So Neko can run on a Z.ai coding-plan subscription (whose quota is on the Anthropic
  endpoint, not the pay-as-you-go OpenAI one), e.g. for continuous self-improvement runs. Converts Neko's
  OpenAI-shaped messages/tools to Anthropic blocks (system fold-up, tool_use / tool_result, image blocks,
  input_schema) and parses both non-streamed and SSE responses (text/thinking/tool deltas, usage). Set up a
  profile `{"provider":"anthropic","base_url":"https://api.z.ai/api/anthropic","model":"glm-4.6","api_key":"..."}`
  and run `neko run --profile zai ...` / `neko chat --profile zai`. Live-verified end to end (glm-4.6 drove a
  tool-calling agent run); conversions unit-tested.

- **`neko run --image <path>` — image→price in ONE automatic command** — attach image(s) to a one-shot run.
  Neko runs a **vision pre-pass** (a vision model reads the image into text) and then hands that text to the
  normal tool-using agent, which searches/prices it — so a text model that can't see and a vision endpoint
  that can't tool-call combine into one command. The vision model is `vision_model` config, defaulting to the
  verified `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` on an NVIDIA endpoint (a new `NekoConfig.withModel` clones
  the config at that model). Verified end to end: `neko run --image pack.jpg "tìm giá rẻ nhất VN"` -> the
  vision pass read "SanDisk Cruzer Blade 16GB", the agent then web-searched the CZ50 and priced it. If no
  vision model is available, the image run is a pure perception pass (no tools, since vision-only endpoints
  reject tool-calling).
- **Computer-use act→verify (deterministic) — the desktop analogue of "LLM extracts, code computes"** — a
  state-changing UIA action no longer trusts that it worked: `setvalue` reads the value back and asserts it
  landed (a read-only field is caught up front; rejected / reformatted / masked / truncated input becomes a
  "WARN MISMATCH", exit 1), and `toggle` asserts the state actually flipped. The model decides the action;
  code verifies it against the structure. `invoke` also self-verifies via a **UIA tree diff** — it snapshots
  the window's control tree + the top-level windows before/after and reports what appeared / went away / which
  new window opened (deterministic proof it did something, or a warning that it didn't); `click` still can't
  self-verify, so re-perceive after it. Live-tested on WPF windows (set+VERIFIED on a field, FAIL READ-ONLY on
  a locked one, `invoke` reporting the exact element that appeared).
- **Deterministic price-table layer (`price-table.ts`) — LLM extracts, code computes** — the professional,
  non-patchwork fix for a class of dogfood failures (gpt-oss read "31.990.000đ" as 31, reported a pricier
  source as "cheapest" while holding a cheaper one, summed wrong). Per the 2026 consensus on reliable
  extraction, the model now only transcribes prices VERBATIM and a deterministic script (`parseVnd` + sort +
  min/max/sum/median + outlier flags) does all the numbers — making the misparse / wrong-min / wrong-sum bug
  class *impossible*. Unit-tested (the script is deterministic, so it can be; the model can't). The
  procurement skill is reframed around it; the principle is documented in `docs/process/WEB.md` as the shape
  for any future numeric extraction.
- **Computer use** — a `computer-use` skill (code-first per CoAct-1, the GUI perception-action loop, hard
  guardrails). WEB control validated end-to-end through `@playwright/mcp` (DOM-driven, no vision needed) and
  a real VN procurement run. A Windows desktop **control primitive** `mouse.ps1` (pos/move/click) plus the
  Clicky-inspired `[POINT:x,y]` grounding path, so the screenshot -> vision-ground -> click loop is ready the
  moment a vision/GUI model is configured.
- **Desktop control with NO vision (UIA)** — `uia.ps1` drives Windows apps through the OS accessibility tree
  (the desktop DOM): a plain text model `list`s a window's controls (name + role + verb + exact OS coords),
  then acts BY NAME — `invoke` (InvokePattern: click without moving the cursor), `setvalue` (type without the
  keyboard), `toggle`, and `get` to verify — no vision, no GUI-trained model, no cursor hijack. SOTA-grade
  perf via a UIA CacheRequest (one bulk cross-process call; a naive tree walk times out on rich WinUI/WPF).
  Verified end-to-end on a real .NET window (`list` -> `setvalue` -> `invoke` -> screenshot confirmed). Raw-
  pixel vision is now only the LAST resort, for custom-drawn UIs with no accessibility tree.
- **Independent agent pointer (no mouse hijack)** — `inject.ps1` (tap/dbltap/stroke) acts via Windows TOUCH
  INJECTION, a SEPARATE pointer channel, so Neko clicks/drags/draws on the visible desktop WITHOUT moving the
  user's mouse (verified: drew in Paint with the real cursor parked, unmoved). Pairs with the overlay (the
  visible "instructor" triangle) for a true clicky-style cursor that actually acts. **Config-first:**
  `computer_use_input: "inject"` -> `NEKO_INPUT=inject` -> `mouse.ps1`'s click/stroke transparently route to
  the non-hijacking path (`"sendinput"` forces the legacy path); a new backend is a config value + a script.
  No driver, no admin, Win11-Home compatible. (Hidden/background or game control still needs VM isolation —
  documented honestly in the skill.)
- **Web reading via accessibility + tab presence** — `uia.ps1 read` dumps a page/doc as TEXT (so a text
  model summarizes a web page with no vision); Unicode `@<utf8-file>` targets (invoke-by-name survives the
  cp1252 console and is layout-independent). Launching Chrome with `--force-renderer-accessibility` exposes
  the logged-in page DOM to UIA — gpt-oss autonomously browsed + summarized a live feed and composed a post,
  reusing the login with no CDP and no credentials. The overlay now shows a **tab/window indicator** —
  frames + labels the exact window/tab Neko is driving ("NEKO dang dung tab nay: <title>"), driven by
  `neko_active_window.txt`.
- **Computer-use robustness — audit trail, intervention-resume, goal-loop** — every desktop action is appended
  timestamped to `%TEMP%\neko_actions.log` (override via `NEKO_ACTION_LOG`), so "what steps did you do?" is a
  `read` away. On a real (non-injected) user click the overlay yields and the helpers return `PAUSED`; the new
  `idle.ps1` blocks until the user has been idle a few seconds then clears the pause, so Neko can RE-PERCEIVE
  (re-screenshot / `uia.ps1 read`) and RE-PLAN from the new state — SOTA state-managed interruption / shared
  autonomy, "re-perceive don't blind-resume". And `runUntilDone` (`neko run --loop`) now re-inspects the ACTUAL
  state each pass before judging DONE (Reflexion/CRITIC/Chain-of-Verification) — the fix for tasks that quit
  early (the Paint test). SKILL.md documents all three.
- **First-class `computer` tool** — computer-use is now a native, gated agent tool, not just bash-ed scripts:
  `computer({action, window, name, value, x, y, points})` with `action` = list/read/get/invoke/setvalue/
  toggle/click/stroke/screenshot. It dispatches to the accessibility-tree scripts (Unicode names via an
  automatic temp UTF-8 `@file`), honours the presence/input config, and is gated like bash. The agent calls
  it structurally instead of constructing fragile shell strings. Verified live against a real Paint window.
- **`auto_loop` config (persist by default)** — set `"auto_loop": true` and `neko run` uses the closed loop
  (runUntilDone) by default, so you don't retype `--loop`; `--once` (alias `--no-loop`) forces a single shot.
- **`neko setup web` — one-command SOTA web stack** — stands up SearXNG in Docker (JSON API enabled, the bit
  that's off by default), verifies it, and wires `searxng_url` + the `@playwright/mcp` browser MCP (headed
  real-Chrome) into config — idempotent, key-safe (never touches `api_key`), with clear `[skip]` messages if
  Docker/bunx is missing. Sub-targets `setup searxng` / `setup browser`. Turns the manual setup that lifted
  Neko above a hand search (DuckDuckGo 18.3M → SearXNG 7.99M) into one command.
- **`neko bench lift` — harness-lift benchmark** — runs the same tasks twice, RAW (the model alone, no
  tools/loop, must emit file contents) vs +NEKO (tools + agentic loop), and reports the delta. Makes the
  thesis ("the harness turns a model into a capable agent") measurable instead of vibes. Honest finding: on
  tiny self-contained coding tasks a capable model (gpt-oss-120b) one-shots them, so the lift is ~0 there —
  the lift shows on tasks the raw model CANNOT do (a `run-to-know` task whose value needs executing code; and
  agentic/computer-use, where raw can't act at all — cf. the Paint house: raw scribbled+quit, +Neko drew a
  full house).
- **Deep research** — a `deep-research` skill (plan -> multi-source search -> read primaries -> cross-verify
  >=2 authoritative sources -> cited synthesis) and a strengthened always-on Accuracy section in the prompt.
- **tui-self-test** skill — verify the TUI render (ink-testing-library + a live screenshot loop) with the
  SendKeys focus-leak guardrail learned from dogfooding.

### Fixed
- **Path-escape guard now catches SYMLINKS, not just `../`** — `resolveInRoot` did lexical containment only, so a symlink INSIDE the root pointing OUTSIDE passed the check but actually escaped (read/write through it could touch files outside the project). It now also compares realpaths (resolving a new file's nearest existing parent), so a symlinked path that resolves outside the root is refused. Verified: reading through a junction escaping the root is refused, no leak. Low-risk on a local-first tool (you own the repo, write/bash are gated) but now closed.
- **Computer-use coordinate actions land on a scaled display (DPI fix)** — UIA reports element coordinates in
  PHYSICAL pixels, but the acting scripts were DPI-UNAWARE, so on a scaled display (e.g. 125%) Windows
  virtualized their click/tap coordinates and they landed ~1.25x off-target — every coordinate action quietly
  missed. CONFIRMED with a functional test (an unaware mouse-click at a checkbox's reported coords missed; a
  fully DPI-aware read+click toggled it). All five coordinate scripts (`uia`/`inject`/`mouse`/`overlay`/
  `screenshot`) now set `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`, so reads, actions, the cursor
  overlay, and the screenshot `scale` all share one physical-pixel space. (Touch still routes control clicks
  through `invoke`-by-name, not coordinates — injected touch doesn't promote to a control click.)
- **Atomic writes — a crash can no longer lose the session / API key / memory** — `saveSession` (per turn),
  the user config writer (holds the API key), and the NEKO.md memory note all did a plain `writeFileSync`,
  which truncates-then-writes; a kill/crash/concurrent-write in that window left an unparseable file that the
  loaders then silently dropped — i.e. the whole conversation or the saved key, gone. They now go through
  `shared/atomic.ts` (write a temp sibling, then atomic rename), so the target is always the old or the new
  bytes, never a truncation. Unit-tested incl. "a failed write leaves the original intact".
- **MCP: a hung server no longer blocks startup** — `connectAll` awaited each server's connect + `listTools`
  with no timeout, so one unresponsive stdio command / URL hung Neko's startup indefinitely (and stalled every
  server after it). Each connect is now bounded (15s) and skipped-with-error on timeout; interactive OAuth is
  exempt (user-paced).
- **`computer` tool: failures are visible, inputs are validated** — `runComputer` swallowed PowerShell
  spawn errors / timeouts into `"(no output)"`, so the agent couldn't tell a *failed* action from a silent
  one; and `click` coerced a missing/invalid coordinate to the string `"NaN"` and passed it to the injector.
  Now spawn errors, timeouts (the 90s hang), and non-zero exits are surfaced as real error observations, and
  `click`/`stroke` reject non-numeric coordinates up front (deterministic input validation, unit-tested) —
  the same "surface errors, validate in code" standard as the extraction layer.
- **A throwing tool no longer crashes the whole turn** — a model glitch (e.g. emitting `web_fetch` with no
  `url`) made an executor `throw`, which escaped the agent loop and killed the run (`neko: error: ...`). Tool
  execution now goes through `safeExecute`, so any throw becomes a recoverable error OBSERVATION fed back to
  the model (honouring the loop's "errors are fed back so the model adapts rather than crash" contract).
  Caught a real failure mid price-research; regression-tested.
- **Context-overflow crash** — one huge tool result (a heavy page's browser snapshot) could push the prompt
  past the context window, so the server returned a negative `max_tokens` and 400'd the turn. Each
  observation is now capped, and a long turn compresses its OLDEST observations in place (observation
  masking) before it would overflow. Regression-verified on the exact page that crashed (772k tokens, 0 crash).
- **Procurement price typing** — prices are captured per condition (new / used-trade-in / installment), each
  a labeled row, so a used/trade-in price is never reported as the new price.

### Changed
- **UI polish** (verified live) — diffs render Claude-style (line number first, red removals / green
  additions); the tool-result connector uses a glyph (`└`) that renders on every terminal font; the
  diff/write header colors its `+N` green and `-M` red.

## [0.4.0] — 2026-06-27

### Added
- **Mixture-of-Agents provider** (`provider: "moa"`, or `neko --profile moa`): diverse reference models
  analyze in parallel without tools (on an advisory-safe view of the conversation — no system prompt or
  tool payloads re-sent), then a strong aggregator synthesizes their advice and drives the tool loop.
  Clean-room from the MoA paper (arXiv 2406.04692) + Hermes Agent. Mixture token cost is accounted; a
  failing reference degrades gracefully. Opt-in quality mode (N+1 calls/turn). Independent benchmarks: it
  TIES strong single models on saturated tasks (no headroom) but EXCEEDS them where the single model is
  weak — false-premise robustness, 5/6 vs 4/6.

## [0.3.0] — 2026-06-27

### Added
- **Remote control, professional + cross-device.**
  - `/rc` HTTP control API gained SSE streaming, `GET /status`, `POST /interrupt`, `Authorization: Bearer`
    auth, a 1 MB body cap, request serialization, and a discovery file; optional `remote_bind` for a
    trusted private mesh (Tailscale).
  - `/relay` drives Neko from **any phone/browser with no open port** — the agent dials out and
    long-polls a relay you host (a Cloudflare Worker; `cloudflare/relay/`), with **end-to-end encryption**
    (zero-knowledge relay) and **QR pairing** printed in the terminal.
- **Self-improving memory** — learned `workflows` (AWM-style procedures) and an always-on `playbook`
  (ACE) alongside `memory` (facts) and authored `skills`.
- **Skills** — `procurement` (VN sourcing / purchasing officer) and `browser-visual-qa` (drive a page,
  capture, analyze frames with vision).
- **Tool-use parity with Claude Code** — `search` via ripgrep (with a built-in fallback) + glob/case/
  context; `bash` per-call `timeout` + `run_in_background`; `read_file` offset/limit + image/PDF reading;
  MCP **lazy** schema loading.
- **Self-update** — `neko update` downloads the latest release and replaces the binary in place, plus a
  daily-cached startup check.
- **Config-driven `effort_ceiling`** — maps a configured `reasoning_effort` (e.g. `max`) down to the
  endpoint's accepted ceiling proactively.

### Fixed
- Robustness: bounded live render and tool output (no UI freeze / OOM on big streams), interruptible
  `bash`, per-cwd git-branch caching.
- Windows installer survives the schannel certificate-revocation condition (`--ssl-no-revoke` + fallback).
- `reasoning_effort` gracefully clamps to the highest accepted tier instead of erroring.

## [0.2.0]

- Initial public binaries: streaming agent loop, safe/gated tools, permission modes, Ink TUI, sessions,
  MCP, config-first profiles, one-line install.

[0.3.0]: https://github.com/meiiie/neko-core/releases/tag/v0.3.0
[0.2.0]: https://github.com/meiiie/neko-core/releases/tag/v0.2.0
