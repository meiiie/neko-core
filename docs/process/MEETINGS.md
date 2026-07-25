# Local meeting companion

Neko Core v0.14 adds a consent-first meeting evidence path. It can listen to meeting audio already playing
on the user's computer, keep microphone and system audio in separate channels, transcribe locally, and help
produce timestamp-grounded minutes. It does **not** pretend to be a universal cloud bot or silently enter a
meeting.

## User path

Inside the TUI, open `/meeting`. The first screen gives one-click choices to:

- install the local balanced Vietnamese transcription pack and then start;
- record immediately and transcribe later;
- stop an active capture immediately;
- transcribe or read the latest meeting;
- inspect/remove the optional engine without deleting meeting evidence.

The equivalent non-TUI path is:

```bash
neko support meeting install          # balanced multilingual model (default)
neko support meeting install quick    # smaller/faster model
neko meeting start "Weekly product sync"
neko meeting list
neko meeting show latest
neko meeting transcribe latest vi
neko meeting delete <id> --force
```

`neko meeting start` stays alive for the recording. A local page opens, then the browser itself asks the user
which tab/window/screen to share. The user must enable **Share audio**, confirm recording rights/participant
consent, and press Start. The browser's own sharing indicator, the page's Stop button, Ctrl+C, and `/meeting
stop` in the original TUI are independent stop paths.

## Why local capture is the baseline

```
meeting app already playing on this computer
                 |
                 v
browser getDisplayMedia picker  <-- user chooses source every time
       | system audio                 | optional microphone
       +---------------+--------------+
                       v
           AudioWorklet PCM16 stereo
             ch 0 = mic / ch 1 = system
                       v
     authenticated 127.0.0.1 WebSocket (token in URL fragment)
                       v
       local WAV -> local ASR -> canonical timestamp JSON/Markdown
                       v
      bounded transcript pages -> cited decisions/action items
```

This path works across meeting products because it captures an audio source the user can already hear; it does
not depend on a vendor's private protocol or account cookie. It also respects the browser's mandatory choice
and indicator. The W3C Screen Capture specification requires `getDisplayMedia` to prompt and let the user
choose on every call; the permission cannot be persisted as `granted`. Audio availability remains a browser/OS
decision, and audio-only `getDisplayMedia` is not allowed, so Neko requests a video track but never reads,
transmits, or stores a video frame. See the [W3C Screen Capture specification](https://www.w3.org/TR/screen-capture/).

“Any meeting platform” therefore means **a supported desktop browser/OS can share the audio currently playing
on this device**. It does not mean an unattended Neko attendee can enter every Zoom/Meet/Teams/Zalo room. Some
browser/OS/source combinations expose only tab audio or no audio; the consent page detects a missing audio track
and asks the user to choose again.

## Vendor-bot boundary

Provider-native meeting adapters remain separate future edges:

- Google Meet's real-time Media API is still Developer Preview. The Cloud project, OAuth principal, and all
  participants must be enrolled; scopes are restricted, the host controls access, and participants can stop it.
  Google recommends the REST API when real-time raw media is unnecessary. See the official
  [Meet Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview) and
  [get-started requirements](https://developers.google.com/workspace/meet/media-api/guides/get-started).
- Microsoft says Teams real-time media bots are not recommended for AI-agent meeting intelligence and points
  developers to Copilot Studio or Graph meeting transcripts. Teams media bots also require app registration,
  permissions, and administrative consent. See Microsoft's
  [real-time media guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)
  and [transcript API controls](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcript-api-access).

Those facts make a universal bot a poor zero-config baseline. A future `MeetingSource` adapter may use a
documented vendor transcript or media API for an authorized organization, but it must retain vendor consent,
provenance, and revocation rather than bypass them.

## Local transcription support

The optional Meeting Support Pack is an adapter, not a core dependency. On supported Windows/Linux targets it:

1. reads the current stable official `ggml-org/whisper.cpp` GitHub release;
2. requires GitHub's SHA-256 asset digest, exact host/path, bounded size, stable tag, safe archive paths, and a
   real binary version probe;
3. downloads either the balanced multilingual `small-q5_1` model (default) or quick `base-q5_1` model from the
   official `ggerganov/whisper.cpp` Hugging Face repository;
4. verifies fixed model byte counts and SHA-256 values, then installs atomically under
   `~/.neko-core/meeting-support`;
5. verifies the engine/model SHA-256 before first use and re-verifies whenever file size or modification time changes.

macOS currently reuses an explicit PATH/Homebrew `whisper.cpp` engine because the upstream release does not
publish the same standalone CLI asset; Neko can still install and verify its model. Unsupported platform/CPU
pairs fail with a precise message rather than guessing a binary.

Whisper is the portable baseline, not a permanent claim of best Vietnamese accuracy. Vietnamese upgrade
adapters should be accepted by measured corpus results. Relevant candidates include VinAI's PhoWhisper,
trained on 844 hours spanning diverse accents ([paper](https://arxiv.org/abs/2406.02555)), and NVIDIA's
Vietnamese Parakeet model ([model card](https://huggingface.co/nvidia/parakeet-ctc-0.6b-Vietnamese)). Their
larger Python/NeMo/GPU footprints are not silently added to the single Neko binary.

## Evidence and speaker truth

Each meeting lives under `~/.neko-core/meetings/<meeting-id>/`:

- `meeting.json` - state, consent timestamp, capture sources, duration, failures, ASR provenance;
- `audio.wav` - interleaved PCM16 evidence (microphone channel 0, system channel 1);
- `transcript.json` - canonical timestamped segments and source labels;
- `transcript.md` - human-readable timestamp citations.

The two-channel contract distinguishes the local user from all remote meeting audio. It is **not** person-level
diarization: several remote participants can share the system channel. Neko calls that source `Meeting audio`
and does not invent names. Optional diarization must remain a separate adapter and earn its claims with DER/JER
evaluation. `pyannote.audio` Community-1 is a credible local candidate but requires Python/PyTorch, ffmpeg,
accepting model conditions, and a Hugging Face token; NVIDIA Streaming Sortformer is another research route.
See the official [pyannote repository](https://github.com/pyannote/pyannote-audio) and
[NVIDIA NeMo diarization documentation](https://docs.nvidia.com/nemo/speech/nightly/asr/speaker_diarization/models.html).

The bundled `meeting-notes` skill requires every decision/action item to cite transcript timestamps. Missing
owners or due dates remain `not stated`; contradictions remain visible. A successful ASR process is evidence
that transcription ran, not proof that every word, name, number, negation, or speaker is correct.

## Provisional live transcript

When the Meeting Support Pack is installed, capture also runs a live loop so the agent can answer
"what has been said so far" without stopping the meeting. It reads windows out of the same growing PCM
file the capture already writes, wraps each window in a WAV header, and decodes it with the same
verified `whisper-cli` binary — no second engine, no second supply chain, no upload.

```
growing .capture.pcm ──► window (default 15 s, 2 s overlap) ──► verified whisper-cli ──► provisional segments
                                                                                          │
                            mcp__neko_meeting__inspect {"operation":"live"} ◄──────────────┘
```

The design is windowed rather than streaming for a measured reason: as of 2026-07 no open streaming ASR
model covers Vietnamese, while every model that does Vietnamese well is batch. See
`MEETINGS-RESEARCH-2026-07.md`.

Live output is **provisional by contract**: a window boundary can clip a word, and when decoding falls
behind the meeting the loop skips forward and reports `skippedMs` rather than drifting minutes late. One
unreadable window is recorded in `lastError` and stepped over instead of wedging the session. The
finalized WAV plus the existing single-pass transcription remains the canonical record, and the live
loop is strictly additive — a missing or failing engine never affects the recording.

Stabilization uses **LocalAgreement-2**, the published policy for turning Whisper into a streaming
system ([ufal/whisper_streaming](https://github.com/ufal/whisper_streaming),
[arXiv:2307.14743](https://arxiv.org/abs/2307.14743)): the decoder re-runs over the not-yet-committed
buffer, and only the longest prefix on which **two consecutive hypotheses agree** is emitted. The end of
any decoded window is the least reliable part — the model has no right-hand context there and guesses —
so committing a window immediately ships text that the next pass would contradict. An earlier
hand-rolled heuristic here did exactly that and permanently recorded a hallucinated "and thank you" on
real audio. Two safety valves force a commit without a second opinion: the final flush, where no further
audio is coming, and a full buffer, where waiting would grow the re-decoded region without bound.

Three further rules come from running the real engine over real speech rather than from unit fixtures:

- **Only whole segments are committed.** Word timings come from the decoder's segment, so committing a
  half-agreed segment advanced the buffer past words that were never emitted — real audio lost "Nam will
  own the database migration" that way.
- **The tail must be flushed at stop.** A meeting's closing seconds are shorter than a window, so they
  were never decoded live until `flush()` was added — the last sentence simply disappeared.
- **No progress means wait, not spin.** When nothing is confirmed the same audio would decode
  identically, so the loop returns and lets more of the meeting arrive to provide the second opinion.

Measured on this repository's Windows dev machine with the **quick** (`base-q5_1`) model over 22.5 s of
clean speech, real-time factor ran **0.93x–0.96x** with LocalAgreement (it re-decodes unconfirmed audio,
so it costs more than committing every window blind). Quick is therefore the right tier for the live
loop, and the larger balanced model belongs to the canonical post-meeting pass; that margin is also why
the skip-ahead backpressure exists rather than being theoretical.

The same 22.5 s clip, before and after the policy change, shows what it buys:

| | Ad-hoc window commits | LocalAgreement-2 |
|---|---|---|
| Hallucinated line (`and thank you`) | committed permanently | never emitted |
| Duplicated phrases | needed a prefix-trim hack | none |
| Lost speech | — | none (after whole-segment commits) |
| Segments for the same audio | 7 | 5 |

These numbers prove the plumbing keeps up and is stable, **not** Vietnamese accuracy — that still needs
the corpus described in `MEETINGS-RESEARCH-2026-07.md`.

## Presence and end-of-meeting

The consent page is Neko's on-screen presence for the whole meeting: elapsed time, a live dot,
microphone/meeting level meters, and — when the Support Pack is installed — the provisional transcript
as it is heard. It deliberately sits on the same surface that carries the browser's own mandatory
sharing indicator rather than becoming a separate always-on-top window, because the authoritative
recording indicator belongs to the platform. macOS keeps its microphone dot on the main display and
Chrome keeps its sharing bar; a third-party overlay that competed with those would weaken the exact
signal a user relies on. Neko adds information beside that indicator; it never substitutes for it.

Silence is measured from the PCM Neko already receives (sparse RMS per packet, no extra engine). After
a long quiet period Neko emits **one** notice and `inspect live` exposes `quietMs` plus an `endedHint`.

**Neko never stops a recording on that signal.** Turn-level endpointing is a sub-second decision, but a
meeting is not a turn: people mute, read, or wait for a latecomer. Guessing "ended" and stopping
destroys evidence the user cannot recover, while guessing the other way only costs disk — so the
asymmetry decides the design. The skill instructs the agent to report what it observed and ask. Speech
re-arms the proposal, so a long quiet stretch mid-meeting does not latch it off.

## Context and performance

Transcript reads are paginated at most 200 segments in the tool and 50 in the TUI. Long audio therefore does
not enter the model context wholesale. The canonical transcript remains on disk; the agent retrieves only the
evidence needed for the current summary/question. Capture streams to disk and AudioWorklet messages are batched,
so recording length does not create a growing in-memory audio buffer.

`neko meeting eval <reference-cases.json>` reports weighted WER, CER, real-time factor (RTF), and optional
mic/system channel-source accuracy from a user-supplied reference corpus. A case has this shape:

```json
[
  {
    "id": "vi-room-01",
    "reference": "chúng ta chốt thứ sáu",
    "hypothesis": "chúng ta chốt thứ sáu",
    "audioDurationMs": 4500,
    "processingMs": 900,
    "referenceSources": ["system"],
    "hypothesisSources": ["system"]
  }
]
```

Release smoke fixtures prove plumbing, not ASR quality. A SOTA claim requires a frozen, representative Vietnamese
meeting corpus (regions, code-switching, overlap, noise, proper names and numbers), published hardware, bootstrap
confidence intervals, WER/CER/RTF, diarization DER/JER when applicable, and claim-level summary/action-item
evaluation. The 2026 cross-domain meeting-summary work likewise argues for typed persisted artifacts and
claim-grounded error analysis rather than one opaque holistic score; see
[Evaluating AI Meeting Summaries with a Reusable Cross-Domain Pipeline](https://arxiv.org/abs/2604.21345).

## Threat model and retention

- Loopback binds only to `127.0.0.1`; WebSocket upgrade requires the exact local Origin plus a random token.
- The token starts in the URL fragment (not an HTTP request/referrer) and is removed from browser history after
  page load. CSP allows only the local script/worklet and local WebSocket.
- Pack downloads are HTTPS, host/path constrained, size bounded, digest verified, safely extracted, and installed
  atomically. No pipe-to-shell, administrator permission, global PATH mutation, or silent install is used.
- Capture is bounded to 1.5 GiB and packets to 256 KiB. Malformed or unauthenticated data is rejected.
- A per-meeting transcription lock blocks concurrent writers. If its owner process is gone, the next attempt
  recovers the manifest to a retryable recorded state; the WAV remains the canonical evidence.
- Emergency stop is safe/readily available. Start, transcription, and irreversible deletion stay gated.
- Removing the engine never deletes evidence. `neko meeting delete <id> --force` (or the TUI confirmation) deletes
  that meeting's audio, transcript, and metadata together.

Recording laws and organizational policies differ. Neko provides explicit consent controls and local retention,
but the user remains responsible for having authority and notifying participants.

## Clean-room reference and extension seams

Meetily was studied at pinned commit `0281737d87d26352fb0adc78c8c0975f691b23d1` in the untracked references
folder. Useful ideas were local mic/system capture, optional local ASR, durable meeting artifacts, and explicit
summarization. Neko did not copy Meetily code or embed its Tauri/Rust application. Meetily's public repository is
[Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily).

Future measured adapters fit at the edges without changing `core/agent.ts`:

- `MeetingSource`: browser display audio today; native WASAPI/ScreenCaptureKit/PipeWire or authorized vendor
  transcript/media APIs later;
- `MeetingTranscriber`: portable whisper.cpp today; Vietnamese/streaming engines later;
- `MeetingDiarizer`: absent by default until installed, licensed, and DER-tested;
- summary remains the normal provider/agent path over bounded canonical evidence.

This is the “infinite extension” rule in concrete form: a new source or engine is a replaceable adapter with its
own provenance and eval, not a special case in the agent loop.
