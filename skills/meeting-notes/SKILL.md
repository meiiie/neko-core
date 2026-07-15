---
name: meeting-notes
description: Listen to, transcribe, summarize, and extract decisions/action items from local meetings; nghe, ghi am, chep loi, tom tat cuoc hop tieng Viet.
match: (?=[\s\S]*\b(?:meeting|call|standup|interview|webinar|teams|zoom|google meet|cuoc hop|hop online|phong van|hoi thao)\b)(?=[\s\S]*\b(?:listen|record|transcribe|transcript|minutes|notes|summary|summarize|action items|nghe|ghi am|chep loi|bien ban|ghi chu|tom tat|viec can lam)\b)
---

# Meeting notes

Use Neko's first-class meeting tools for consented local capture and timestamp-grounded notes. The v0.14 capture surface listens to audio that is already playing on this computer through the browser's native screen/tab picker. It is not an autonomous bot that joins every vendor's meeting room.

## Non-negotiable contract

1. Check `mcp__neko_meeting__inspect {"operation":"status"}` first. Explain the exact capture boundary before starting: the user chooses the source, enables Share audio, confirms they have the right and participant consent to record, and can stop at any time.
2. Never bypass the native browser permission picker, hide a recording indicator, or claim consent on the user's behalf. `mcp__neko_meeting__stop` is an emergency privacy control and may be called immediately.
3. Audio, transcript, and metadata stay under the user's local Neko home. Video is requested only because browsers require a display stream for system audio; Neko neither receives nor stores video frames.
4. Microphone and system audio are separate channels. The system channel may contain several remote people: label it `Meeting audio`, not an invented person's name. Do not claim speaker diarization, identity, or attendance unless independent evidence establishes it.
5. Do not silently install transcription software. If support is missing, offer the owner-aware `/support meeting` flow. The user may record now and transcribe later without losing the WAV.

## Workflow

### Capture

- Call `mcp__neko_meeting__start` once with a short title. Tell the user to select the intended tab/screen and enable Share audio.
- Do not repeatedly poll while a recording is active. Continue only when the user asks, the capture ends, or a bounded status check is useful.
- On any uncertainty about privacy, wrong source, or unexpected participant, stop first and clarify second.

### Transcribe

- Stop/finalize before transcription. Use language `vi` for a Vietnamese meeting, `en` for English, and `auto` only when genuinely mixed or unknown.
- Transcription is local ASR evidence, not ground truth. Preserve timestamps and uncertain wording. Do not “correct” names, numbers, owners, dates, or negation without evidence.
- Read long transcripts in pages of at most 50-100 segments. Keep only the relevant evidence in working context rather than injecting an entire long meeting at once.

### Produce grounded minutes

Every substantive claim must cite one or more transcript timestamps, for example `[00:12:08]`. Separate these sections:

1. **Executive summary** - concise, factual, and timestamp-cited.
2. **Decisions** - decision, scope, decision-maker if explicitly stated, and citation.
3. **Action items** - action, owner, due date, status, and citation. Write `not stated` instead of guessing an owner or deadline.
4. **Open questions / risks** - unresolved issue and evidence.
5. **Transcript caveats** - low-confidence audio, overlaps, missing intervals, language switches, or unverified names.

Contradictions remain contradictions: cite both positions rather than synthesizing a false agreement. A summary is complete only when every decision/action item is traceable to evidence and the user can reopen the canonical transcript.

## Delivery and retention

Report the meeting id, capture sources, duration, transcript language/model, and what was or was not verified. Never claim “all participants identified” from a two-channel capture. If the user asks to delete a meeting, use the gated delete tool only after confirming the exact id; deletion removes audio, transcript, and metadata irreversibly. Removing the Support Pack does not remove meeting evidence.
