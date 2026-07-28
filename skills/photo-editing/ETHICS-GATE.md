## DOCUMENTARY ETHICS GATE

Run this gate before any edit when the image is news, documentary, evidence or contest work. Default to `documentary-common-strict`, the conservative intersection of AP and World Press Photo. A named publication/contest policy overrides only after its current primary rules are checked.

### Select a policy profile

- `documentary-common-strict`: block all generative AI creation, alteration and enhancement.
- `documentary-ap-2026`: AP baseline; generative AI may not create, alter or enhance news photography.
- `documentary-wpp-2026`: WPP Contest 2026 baseline; limited denoise/automatic adjustment/object selection that adds or removes no captured information must be escalated for human review, never auto-approved. AI upscaling/super-resolution remains blocked.

### Decision rules

Return exactly one of `ALLOW`, `BLOCK` or `ESCALATE` before invoking an editor.

`BLOCK` when any condition is true:

- Original camera file/provenance is missing or the requested profile rejects the capture mode.
- The operation adds, removes, rearranges, reverses or distorts scene content: generative fill, object removal/heal/clone except sensor dust or scan scratches, sky/background replacement, synthetic background blur, face/body reshaping, skin-mark removal, relighting that changes meaning, frame synthesis, face swap or multi-frame face substitution.
- The operation uses generative upscaling, sharpening or denoise under `common-strict`/`ap-2026`.
- The result is a composite, multiple exposure, stitched panorama or synthetic image presented as a documentary photograph.

`ALLOW` only when all conditions are true:

- Operation is limited to crop, grayscale, conventional exposure/WB/tone/color, minimally necessary local dodge/burn, sensor-dust removal or scan-scratch removal.
- Aligned original/edited comparison at 100%, difference view and histogram show no new/removed/obscured information and no material hue/scene change.
- The original remains immutable and the edit is fully reproducible from a saved recipe/command.

`ESCALATE` when an operation is not clearly on the allowlist, an AI model’s pixel-generation behavior is uncertain, WPP-limited AI enhancement is requested, or an edit could change meaning. There is no universal numeric EV/saturation/denoise threshold; do not invent one.

### Capture and caption gate

- For WPP 2026 smartphone submissions, standard shooting mode is required; HDR, Portrait mode, creative-lighting effects and panorama are ineligible. Preserve the unedited phone original plus at least three adjacent frames before and after the selected frame.
- Never stage or reenact an event. A directed portrait is allowed only when it is truthful and the pose/photographer influence is disclosed. AP likewise requires posed portraits to be identified in the caption.
- Caption must state who, what, where, when and why; disclose pose/reenactment, photographer influence, consent and any context needed to prevent a false reading.

### Audit record

Never overwrite the input. Record `decision`, `policy_profile`, `operation`, `reason`, `source_rule`, input/output SHA-256, capture metadata, tool/model/version, sidecar/recipe/command, operator, UTC timestamp, verification artifacts and caption/provenance note. If authenticity or compliance remains uncertain, fail closed and send the original plus audit bundle to a human photo editor.

Evidence basis (accessed 2026-07-29): World Press Photo 2026 Entry Rules and manipulation/verification/caption guidance (https://www.worldpressphoto.org/contest/entry-rules, https://www.worldpressphoto.org/contest/verification-process/what-counts-as-manipulation, https://www.worldpressphoto.org/contest/verification-process, https://www.worldpressphoto.org/contest/what-is-required-in-captions); AP Photo rules (n.d., https://www.ap.org/about/news-values-and-principles/telling-the-story/); AP AI update (2026-07-23, https://www.ap.org/the-definitive-source/announcements/ap-updates-newsroom-standards-for-artificial-intelligence/).
