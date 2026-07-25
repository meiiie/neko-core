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

**Finding 1 — CORRECTED on 2026-07-25 after measurement. The original claim was wrong.**

> ~~As of 2026-07-25 there is no open streaming ASR model with confirmed strong Vietnamese.~~

That conclusion came from surveying the models that appear on English-centric leaderboards. It missed
**NVIDIA Nemotron-3.5-ASR-streaming-0.6B** (released June 2026): a single 0.6B checkpoint covering 40+
locales **including `vi-VN`**, natively streaming with cache-aware chunking — it keeps a rolling cache of
past activations, so chunks never re-read overlapping audio and there is no stutter at chunk edges
([model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)). It runs on CPU through
[mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp), which publishes GGUF conversions and a
1.4 MB Windows binary.

See §2.6 for the head-to-head measurement on real Vietnamese speech. The corrected finding is that a
Vietnamese live-notes feature **can** be built on a streaming model today, and the windowed-Whisper path
is a fallback rather than the destination.

**Finding 2 — the available local path.** whisper.cpp ships a `stream` example and, more usefully,
`whisper-cli --vad` with a Silero VAD model, which extracts detected speech segments before decoding.
Neko already downloads, digest-verifies, and version-probes `whisper-cli` (`whisper-bin-x64.zip`, release
v1.9.1, 2026-06-19). Rolling-window decoding over VAD-cut segments, using the binary already in the
supply chain, is the only Vietnamese-capable local live path that does not add a Python/GPU stack.

**Finding 3 — code-switching is a distinct axis.** Vietnamese technical meetings mix English terms
heavily; dedicated work exists on Vietnamese–English code-switching ASR
([TSPC](https://arxiv.org/pdf/2509.05983)). A Vietnamese WER number measured on read speech will
overstate real meeting quality.

### 2.6 Measured: Nemotron 3.5 ASR vs Whisper on real Vietnamese speech (2026-07-25)

Run on this repository's Windows dev machine, CPU only. Audio was synthesized with Microsoft Vietnamese
neural voices (`vi-VN-HoaiMyNeural`, `vi-VN-NamMinhNeural`) and resampled to 16 kHz mono — clean speech,
so these numbers are a ceiling, not meeting-room conditions.

**Test 1 — plain Vietnamese meeting speech, 21 s, 60 words.**

| | Nemotron 3.5 ASR q5_k (748 MiB) | Whisper `base-q5_1` (57 MiB) |
|---|---|---|
| Word errors | **0** | ~11 (~18% WER) |
| Owner's name "Nam" | correct | "nằm" — the person is lost |
| Deadline "thứ tư" | correct | "thứ" — the deadline is lost |
| Other damage | — | họp→học, tuần→tường, dữ liệu→giữ liệu, rủi ro→rũi rò, thanh toán→thành toán, xác nhận→sát nhận |
| Real-time factor | **0.41x** | 0.51x |

Whisper `base` did not merely score worse: it destroyed **exactly the two facts a meeting summary must
carry** — who owns the action and when it is due. That is a correctness failure, not a fluency one, and
no amount of downstream summarization can recover it.

Nemotron's `--stream` mode produced identical text with `<vi-VN>` locale tags, confirming the
cache-aware streaming path works rather than only batch decoding.

**Test 2 — Vietnamese/English code-switched engineering speech, 17 s.** This is the realistic case for a
Vietnamese tech meeting, and it defeated **both** engines:

> Reference: "Team backend deploy lên staging chiều nay nhé. Nhớ chạy migration trước khi merge pull
> request. Nếu build fail thì rollback về commit cũ, đừng force push lên main."
>
> Nemotron (`vi-VN`): "Tim Bắc Ken Deploi lên Saging chiều nay nhé. Nhớ chạy migraine trước khi mét pung
> rít. Nếu Bill thì run bắt về con mích cũ, đừng phosphus lên mênh…"

`--lang auto` behaved the same; `--lang en-US` recovered some English terms ("Deploy", "Lathency") while
degrading the Vietnamese. Nemotron keeps the Vietnamese carrier sentence noticeably better than Whisper
does, but every English technical token is mangled by both.

**Conclusion.** Nemotron 3.5 ASR is decisively better for Vietnamese and should become the Vietnamese
path. Code-switching remains an open problem for both engines and must not be claimed as solved — it is
its own research axis ([TSPC](https://arxiv.org/pdf/2509.05983)) and the honest product behaviour is to
warn that English technical terms in a Vietnamese meeting will be unreliable.

### 2.7 Measured: what the swap actually cost and fixed (2026-07-26)

Whisper was removed, not kept as a fallback: two engines mean two supply chains, two digest sets, and a
silent quality cliff whenever the fallback fires. The port is `parakeet-cli transcribe --json`, whose
output is a **word list**, not lines — so segment shape became Neko's own deterministic computation
(break at the engine's locale marker, at a >=700 ms pause, after sentence-final punctuation, or at 12 s /
40 words), matching the standing rule that the model extracts and code computes.

Three defects only real audio exposed:

1. **`<unk>` leaked into the transcript.** The engine emits pseudo-tokens in the word list, and it glued
   one onto a real word — `hai<unk>` — so a whole-token filter was not enough. Every `<...>` run is now
   stripped from inside words; only the locale tag is honoured as a segment boundary.
2. **The live log jumped backwards in time.** Channels decode independently, so the microphone confirmed
   0:06 while the room audio was still at 0:05, and commit order printed them in that order. Committed
   segments are now held behind a watermark at the slowest channel's position.
3. **`overlapMs` was dead configuration.** LocalAgreement's re-decode of the uncommitted buffer *is* the
   overlap; the option had no reader. Removed rather than left as decoration.

**Channel attribution survived the swap.** whisper.cpp got mic/system separation free from `-di`;
parakeet takes mono only. The capture is therefore deinterleaved and each channel decoded on its own, in
both the canonical pass and the live loop, each with its own LocalAgreement state. Cost: a mic+system
meeting decodes twice; a system-only meeting still decodes once.

**Measured pacing** (Windows x64 CPU, 8 threads, `q5_k`, both channels, 5 s drain interval, 90 s of
continuous real speech): 21 windows, lag oscillating 8-20 s, ending at 9.8 s, `skippedMs` 0. The loop
keeps up. Per-invocation model load is ~0.6 s and decode is ~0.25x real time, so the residual lag is
LocalAgreement's second-pass cost, which is the point of it.

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

- **A0. Adopt Nemotron 3.5 ASR as the Vietnamese engine (now the highest-value change).** Measured in
  §2.6: zero word errors versus ~18% WER, and faster. It needs a second Support Pack tier — the
  parakeet.cpp binary plus a 748 MiB GGUF — carrying the same discipline the Whisper pack already has:
  pinned release asset, SHA-256 digest, bounded size, safe extraction, version probe, integrity
  re-verification. Its native cache-aware streaming would **replace** the windowed LocalAgreement loop
  for Vietnamese rather than sit on top of it; the Whisper path stays as the small-footprint fallback
  (57 MiB versus 748 MiB is a real choice for some users). Open questions before committing: quantization
  quality (q5_k was tested; q4_k halves the download), licence terms for redistribution, and behaviour on
  noisy multi-speaker audio rather than clean TTS.

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

- [NVIDIA Nemotron-3.5-ASR-streaming-0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) — 40+ locales incl. `vi-VN`, cache-aware streaming; the model that falsified this memo's original Finding 1.
- [mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp) — CPU inference plus GGUF conversions and prebuilt Windows/Linux/macOS binaries.
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
