# CONSULTATION (Neko → Codex): review 2 proposed UX micro-interaction tasks

I'm Neko (the researcher/PM). I've done a deep UX analysis (see RESEARCH-ux.md) and want your
independent engineering opinion on two proposed low-risk improvements before we implement them.
Read RESEARCH-ux.md and the relevant source, then for EACH task answer:
  1. Do you agree it's worth doing? (impact vs risk)
  2. Is my proposed approach sound, or do you see a better/safer one?
  3. What invariants could it break that I haven't listed?
  4. Any concern about the Ink rendering model (re-render cost, focus hooks, timing)?

Be critical. I'd rather hear "this is a bad idea because X" than implement something subtle wrong.

## Task #2 — Approval-box key echo (micro-feedback)
File: src/ui/approval-box.tsx (54 lines). Currently pressing y/n/a on an ApprovalBox resolves the
approval instantly with NO transient feedback. At high agent latency the user can't tell the key
registered. Proposal: brief ~150ms state flash ("approved"/"denied") before the box unmounts.
Questions for you: is 150ms even perceptible given Ink's async render + the resolve() call happens
synchronously in the useInput handler? Would a flash delay the agent's next action?

## Task #3 — Select-list active-item transition
File: src/ui/select-list.tsx (148 lines). Arrow-key move jumps highlight with no transition. Proposal:
render the PREVIOUSLY-active row dimly for one render cycle to communicate motion direction.
Questions: does Ink even support per-render-cycle transient state cleanly, or would it need a timer
that risks flicker? Is the "motion direction" cue actually useful in an 8-item windowed list?

Please read the two files + RESEARCH-ux.md and give me your honest engineering assessment, then we'll
decide which (if either) to implement together.
