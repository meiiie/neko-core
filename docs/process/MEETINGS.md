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
