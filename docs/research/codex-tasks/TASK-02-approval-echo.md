# TASK-02: Approval-box key echo (micro-feedback) — Neko + Codex joint design

## Decision (after Neko+Codex consultation)
DO implement. Task #3 (select transition) SKIPPED — both reviewers agree marginal value, adds churn.
This task is the highest-leverage low-risk UX improvement remaining.

## The gap (measured/observed)
`src/ui/chat.tsx` line 885-904: pressing y/n/a on an ApprovalBox calls `approval.resolve()`
SYNCHRONOUSLY then `setApproval(null)`. The agent continues immediately; the box vanishes. At high
agent latency the screen looks frozen — the user can't tell the key registered. This is the #1
micro-interaction sin: a Rule with no Feedback.

## Design (joint — follows Codex's state-machine recommendation)
Add a committed-visual phase: pending → committed → unmount. The ApprovalBox shows a confirmation
state ("✓ approved" green / "✗ denied" red / "✓ always-{tool}" green) for ~140ms, THEN resolves.
This is below the 400ms sluggish threshold and in the optimal 100-300ms band. The delay is acceptable
because approval is a human checkpoint (the user already accepted a pause).

## HOW (precise)
In chat.tsx:
1. Add state `const [approvalFlash, setApprovalFlash] = useState<{kind: "ok"|"no"|"always"; tool: string} | null>(null)`.
2. In the approval key handler, instead of resolve-then-unmount:
   - Compute the flash kind from the key (y→ok, a→always, n/Esc→no).
   - Guard: if `approvalFlash` is already set, IGNORE the key (exactly-once — see invariants).
   - Set `setApprovalFlash({kind, tool: approval.toolName})`.
   - Schedule a `setTimeout` (~140ms) that: resolves approval with the right value, adds to
     `alwaysApproved` ONLY for kind==="always", handles exit_plan_mode mode transition BEFORE
     resolve(true), then `setApproval(null)` + `setApprovalFlash(null)`.
   - Keep a ref to the timer for cleanup.
3. Pass `approvalFlash` to `<ApprovalBox>` as a new optional prop `flash?: {kind, tool}`. When set,
   the box renders its header/state text in the confirmation style and ignores layout changes.
4. Cleanup: a `useEffect(() => () => clearTimeout(timerRef.current), [])` + clear on unmount.

## INVARIANTS — Codex + Neko joint list (ALL must hold)
1. **Exactly-once resolve**: pressing y/n/a/Esc during the ~140ms flash MUST NOT resolve twice. Gate
   the whole handler on `if (approvalFlash) return;`.
2. **`gateChain.current` queue stays serial** — do not change how the next approval in the chain is
   presented; the delay is purely visual, the chain advances only after resolve().
3. **Ctrl+C during flash**: today `Ctrl+C while busy` aborts. During the flash the approval is not yet
   resolved so the tool hasn't started — aborting is harmless. But to avoid surprise, IGNORE Ctrl+C
   abort during an active flash (let the flash finish, ~140ms). Keep the copy-selection Ctrl+C path.
4. **`alwaysApproved.add(toolName)`** happens ONLY in the committed timeout (kind==="always"), never
   at keypress time — so a double-press can't pre-grant.
5. **exit_plan_mode**: the mode transition (`registryRef.current!.mode = "accept-edits"; setMode(...)`)
   happens BEFORE `resolve(true)` inside the timeout, unchanged from today's ordering.
6. **ApprovalBox input stays in chat.tsx**: do NOT move key handling into the box (the comment at
   line 878-884 documents a real lost-key race from conditionally-mounted hooks). The box stays
   presentation-only.
7. Tests: `bun test test/chat-ui.test.tsx` + `bun test test/ux.test.tsx` + `bun run typecheck:stable`
   all PASS. Pay attention to any test that exercises approval timing.

## Files
- `src/ui/chat.tsx` — state machine + timer + guard.
- `src/ui/approval-box.tsx` — accept `flash` prop, render confirmation style.

## Do NOT
- Do not implement Task #3 (select transition) — skipped by joint decision.
- Do not change the approval key set (y/a/n/Esc) or which tools are gated.
- Do not add the confirmation as a transcript line (it's ephemeral, like the Ctrl+C hint).
- Do not touch FrameDiffer, sync-stdout, or any render pipeline.

## Verify yourself
```
bun test test/chat-ui.test.tsx
bun test test/ux.test.tsx
bun run typecheck:stable
```
Report: lines changed, test results, and how the exactly-once guard + Ctrl+C-during-flash are handled.
