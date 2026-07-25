# Neko Meet — research memo, 2026-07-25

Research only. No implementation is proposed as accepted; every option below still needs the measured
gates in the final section. `MEETINGS.md` documents what v0.14 actually ships; this memo documents what
the July-2026 state of the art makes possible and what it does not.

## 1. The requested scenario, tested against the current build

Verbatim user request:

> "Xin chào neko hôm nay mình có cuộc họp vì vậy vào phòng 'abc' rồi lắng nghe ghi chú kỹ lưỡng giúp
> mình nhé cuối phiên họp thì thêm một bản tóm tắt giúp mình"

Decomposed into five obligations, checked against the code rather than the docs:

| # | Obligation | Status today | Evidence |
|---|---|---|---|
| 1 | Join a named room "abc" | **Not supported** | `meeting-tools.ts` exposes `start/stop/transcribe/inspect/delete`; `start` opens a local consent page plus the browser's `getDisplayMedia` picker. No room, URL, or vendor-join argument exists anywhere. |
| 2 | Listen continuously | Partially | Audio is captured to `audio.wav`; nothing interprets it while it runs. |
| 3 | Take detailed notes **during** the meeting | **Not supported** | `transcribeMeetingLocked` refuses unless state is `recorded`/`ready`: "meeting audio is not finalized yet". Transcription is one batch `whisper-cli -f audio.wav` pass. |
| 4 | Detect the end of the meeting | **Not supported** | Only a user/agent `stop` finalizes a capture. No silence, tab-close, or call-ended signal. |
| 5 | Produce a final summary | Possible, but manual | Requires stop → transcribe → paged `inspect read` → model summary. The skill enforces timestamp citations. |

Additional friction on this machine: `~/.neko-core/meeting-support/` is absent, so the first response
to that sentence is an install offer, not a meeting.

**Honest verdict: the sentence does not work today.** Neko would (correctly) refuse to claim it joined a
room, and the user would still have to pick a tab, enable Share audio, stop, transcribe, and ask for a
summary. Items 1, 3 and 4 are genuine missing capability, not configuration.

## 2. State of the art, July 2026

### 2.1 Streaming ASR — strong in English, thin in Vietnamese

Batch accuracy leaders on the Open ASR Leaderboard are clustered within roughly one WER point
(ARK-ASR-3B ~5.04%, Granite Speech 4.1 2B ~5.33%, Cohere Transcribe ~5.42%, Canary Qwen 2.5B ~5.63%,
Qwen3-ASR-1.7B ~5.76% across 52 languages), so accuracy is no longer the differentiator — throughput and
licence are ([2026 comparison](https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/)).

The streaming subset is much smaller, and this is where the Vietnamese problem appears:

| Model | Streaming | Languages | Vietnamese |
|---|---|---|---|
| Voxtral Mini 4B Realtime | yes, sub-500 ms | 13 | **no** ([model card](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602)) |
| Kyutai STT 2.6B | yes | 2 (EN/FR) | no |
| NVIDIA Nemotron Speech Streaming | yes, ~0.56 s algorithmic latency, ~8.20% streaming WER | English-focused | no |
| PhoWhisper large | no (batch) | Vietnamese | **best measured Vietnamese** ([paper](https://arxiv.org/abs/2406.02555), 844 h) |
| Meta Omnilingual ASR | no (batch) | 1,600+ | yes |
| Whisper large-v3 / whisper.cpp | no (batch) | 99 | yes |

**Finding 1 — the binding constraint.** As of 2026-07-25 there is no open streaming ASR model with
confirmed strong Vietnamese. Every model that does Vietnamese well is batch; every low-latency streaming
model omits Vietnamese. A Vietnamese live-notes feature therefore cannot be bought off the shelf.

**Finding 2 — the available local path.** whisper.cpp ships a `stream` example and, more usefully,
`whisper-cli --vad` with a Silero VAD model, which extracts detected speech segments before decoding.
Neko already downloads, digest-verifies, and version-probes `whisper-cli` (`whisper-bin-x64.zip`, release
v1.9.1, 2026-06-19). Rolling-window decoding over VAD-cut segments, using the binary already in the
supply chain, is the only Vietnamese-capable local live path that does not add a Python/GPU stack.

**Finding 3 — code-switching is a distinct axis.** Vietnamese technical meetings mix English terms
heavily; dedicated work exists on Vietnamese–English code-switching ASR
([TSPC](https://arxiv.org/pdf/2509.05983)). A Vietnamese WER number measured on read speech will
overstate real meeting quality.

### 2.2 Streaming diarization

NVIDIA's Streaming Sortformer does online diarization with an Arrival-Order Speaker Cache, frame-level
timestamps, and arrival-time ordering, tracking up to four concurrent speakers; it is optimised for
English and Mandarin and expects an NVIDIA GPU
([paper](https://arxiv.org/pdf/2507.18446), [Interspeech version](https://www.isca-archive.org/interspeech_2025/medennikov25_interspeech.pdf)).
`pyannote.audio` Community-1 remains the credible local alternative but needs Python/PyTorch, model
conditions, and a Hugging Face token.

Neko's current two-channel contract (microphone = local user, system = `Meeting audio`) is **not**
person-level diarization, and `MEETINGS.md` already says so. That honesty should survive any upgrade:
diarization must arrive as an optional adapter with DER/JER evidence, not as a default claim.

### 2.3 Joining a room — what actually changed since v0.14

| Platform | Status on 2026-07-25 | Consequence |
|---|---|---|
| **Zoom RTMS** | Self-service purchasing since May 2026; available to any developer with Developer Pack credits; delivers live audio/video/transcript **without a participant bot** ([docs](https://developers.zoom.us/docs/rtms/), [product](https://www.zoom.com/en/realtime-media-streams/)) | The one vendor path that is now genuinely open. This is new since `MEETINGS.md` was written. |
| **Google Meet Media API** | Still Developer Preview. The Cloud project, OAuth principal, **and every participant** must be enrolled; blocked by meeting encryption, watermarking, or an underage participant; the host can disable it mid-call; Google recommends the REST API when real-time media is unnecessary ([overview](https://developers.google.com/workspace/meet/media-api/guides/overview)) | Unusable as a default. The all-participant enrolment requirement alone rules out ordinary meetings. |
| **Microsoft Teams** | Real-time media bots exist but Microsoft does not recommend them for AI meeting intelligence, pointing to Graph transcripts or Copilot Studio; app registration and admin consent required ([guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)) | Post-hoc Graph transcript is the supported path; live media is not. |
| Third-party bot services (Recall.ai and similar) | Mature and easy | Ships meeting audio to a third-party cloud. Incompatible with Neko's local-first, sovereignty-first position; would be a product regression even though it is the shortest path. |

**Finding 4.** "Vào phòng abc" cannot be honoured generically in July 2026. It can be honoured for Zoom
via RTMS, approximated for Teams post-hoc, and not honoured for Google Meet. The local-audio path stays
the only universal one. The correct product behaviour is to *name the tier* rather than fail vaguely.

### 2.4 Notes during the meeting, and how to know they are trustworthy

- **When to write matters more than how.** Online meeting summarisation is under-studied; the key result
  is that **adaptive refresh policies beat fixed intervals**, and that intermediate summaries need their
  own latency and partial-quality metrics because users actually read them
  ([Policies and Evaluation for Online Meeting Summarization](https://arxiv.org/abs/2502.03111)).
- **Progressive note-taking works in production.** A deployed incremental-summarisation system that
  decides *when* to emit bullet notes cut case handling time ~3% versus bulk summarisation
  ([paper](https://arxiv.org/pdf/2510.06677)).
- **Summaries must be scored per claim, not holistically.** The cross-domain pipeline already cited in
  `MEETINGS.md` builds ground truth, then scores claim-grounded accuracy / completeness / coverage across
  114 meetings and three models; notably, accuracy differences between models were not statistically
  significant while retention metrics separated them clearly
  ([paper](https://arxiv.org/abs/2604.21345)). One holistic score would have hidden that.
- **Intermediate notes must be revisable.** Online summarisation explicitly requires updating earlier
  statements when later audio contradicts them — an append-only note stream is wrong by construction.

## 3. What "beating the July-2026 tier" would actually mean

The commodity product is a cloud bot that joins a link and emails a summary. Competing there is a losing,
undifferentiated race — and it contradicts the local-first premise. The defensible frontier is the
intersection nobody currently serves:

1. **Local Vietnamese live notes.** No open streaming model does Vietnamese; every cloud notetaker that
   does Vietnamese uploads the audio. A local rolling-window VAD + whisper.cpp path, measured on a real
   Vietnamese meeting corpus with code-switching, is a capability claim no competitor can copy without
   giving up either locality or Vietnamese quality.
2. **Notes that cite and revise.** Every live note carries the transcript segment range it came from, and
   a later note may supersede an earlier one with both versions preserved. That converts "AI notes" from
   an opaque artefact into reviewable evidence — the direction all three summarisation papers point.
3. **Named capability tiers instead of a vague bot promise.** Saying "I cannot join Google Meet because
   its media API requires every participant to be enrolled in a preview programme; I can capture this
   meeting's audio from your tab, or use Zoom RTMS if this is Zoom" is *more* useful than silently
   degrading, and is defensible against every vendor's terms.
4. **Evaluation as a shipped feature.** `neko meeting eval` already reports WER/CER/RTF. Extending it with
   online-summary latency, partial-summary quality, and claim-level accuracy/completeness/coverage would
   make Neko one of very few notetakers that publishes how it is wrong.

## 4. Design directions (not yet accepted)

Sketched for discussion; each needs its own evidence before any code.

- **A. Live transcript loop (the unlock for obligations 2 and 3).** Capture already streams PCM to disk.
  A bounded rolling window (order ~10–20 s, cut on Silero VAD boundaries) decoded by the existing verified
  `whisper-cli` yields segment-level text during the meeting. Open questions: real-time factor on a
  laptop CPU for the balanced model; window overlap versus duplicated words; whether the final full-file
  pass is still needed for canonical accuracy (likely yes — keep the WAV as truth and treat live output as
  provisional).
- **B. Adaptive note policy.** Emit a note on salience events (decision, action item, number/date, question,
  topic shift, disagreement) rather than on a timer, per 2502.03111. Notes cite segment ranges and may
  supersede earlier notes.
- **C. End-of-meeting detection.** Candidate signals: sustained VAD silence, the shared tab/window closing,
  the browser stream ending. Must be conservative and visible — a wrong "meeting ended" that keeps
  recording is a privacy failure, and a wrong stop loses evidence. Prefer proposing the stop over taking it.
- **D. Room tiering.** Keep local capture as tier 0. Zoom RTMS is the only new vendor tier worth
  evaluating; it requires credentials and a policy decision, and it must not become a silent cloud upload.
  Google Meet stays out until it leaves Developer Preview.
- **E. Diarization stays optional.** Only with DER/JER numbers, and never renaming the `Meeting audio`
  channel without evidence.

## 5. Gates before any of this is called done

Nothing above may be claimed without:

1. A frozen Vietnamese meeting corpus: multiple regions, code-switching, overlapping speech, noise, proper
   names and numbers. Read-speech WER does not qualify.
2. Published hardware, WER/CER, and real-time factor for the live path specifically — the live number will
   be worse than the batch number and must be reported separately.
3. Online-summary metrics from 2502.03111 (latency, partial-summary quality) and claim-level
   accuracy/completeness/coverage from 2604.21345, with the "not statistically significant" discipline that
   paper demonstrates.
4. Unchanged consent invariants: explicit user consent, a visible indicator, an always-available stop, local
   retention, and no silent vendor upload. A live-notes feature that weakens any of these is rejected
   regardless of its metrics.

## 6. Sources

- [Best Open Speech Recognition (ASR) Models in 2026](https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/) — 2026-07-23 landscape, WER/latency/licence table.
- [Voxtral Mini 4B Realtime model card](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602) — streaming, 13 languages, no Vietnamese.
- [PhoWhisper: Automatic Speech Recognition for Vietnamese](https://arxiv.org/abs/2406.02555) — 844 h, Vietnamese SOTA, batch.
- [TSPC: Vietnamese–English code-switching ASR](https://arxiv.org/pdf/2509.05983) — code-switching as a separate axis.
- [Streaming Sortformer](https://arxiv.org/pdf/2507.18446) — online diarization, speaker cache, 4 speakers, GPU.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — `stream` example, `--vad` with Silero, release v1.9.1.
- [Zoom Realtime Media Streams docs](https://developers.zoom.us/docs/rtms/) — live media without a participant bot.
- [Google Meet Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview) — Developer Preview, all-participant enrolment.
- [Teams real-time media guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts) — not recommended for meeting intelligence.
- [Policies and Evaluation for Online Meeting Summarization](https://arxiv.org/abs/2502.03111) — adaptive beats fixed; latency and partial-quality metrics.
- [Incremental Summarization via Progressive Note-Taking](https://arxiv.org/pdf/2510.06677) — deciding when to write; production result.
- [Evaluating AI Meeting Summaries with a Reusable Cross-Domain Pipeline](https://arxiv.org/abs/2604.21345) — claim-grounded accuracy/completeness/coverage.
