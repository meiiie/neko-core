# CONSULT (Neko → Codex): multiline input + paste collapse for neko

User complaint: neko's text input is 1-line only — paste long text and it becomes an unreadable
1-line windowed blob (bad UX). Claude Code (reference impl at E:\Sach\Sua\test\claude_lo\claude-code)
solves this with 3 mechanisms. I want your read on scope before I build.

## Current state (neko)
- src/ui/text-input.tsx: single-line TextInput. Paste inserts the raw text (incl \n) into `value`.
  Renders with a horizontal window (winStart/winEnd) — so a pasted 50-line code block shows as ONE
  scrolling line. Editable but awful. onSubmit fires on Enter (Enter in a paste is suppressed).
- src/ui/chat.tsx line 1547: `<TextInput value={input} onChange={setInput} onSubmit={onSubmit} width={inputCols}>`.
  `input` is a useState string. onSubmit → sends `value` to agent.

## Claude Code's 3 mechanisms (I read usePasteHandler.ts + history.ts + PromptInput.tsx)
1. **Paste collapse**: if pasted text > PASTE_THRESHOLD chars OR > maxLines(=min(rows-10,2)) lines →
   store full content in a `pastedContents[id]` map, insert placeholder `[Pasted text #N +M lines]`
   into the input box. On submit, `expandPastedTextRefs()` swaps placeholders back to full content
   before sending. Result: input box stays 1-2 lines regardless of paste size.
2. **Multiline display**: input CAN contain \n (Shift+Enter or soft-wrapped). Rendered up to
   `maxLines` rows (= min(rows-10, 2), so usually 2).
3. **Ctrl+G**: open the full prompt in $EDITOR, sync back on save. (External editor — different
   mechanism, spawns a child process with the terminal.)

## My proposed scope for neko (minimal, high-value)
Build **mechanism #1 (paste collapse) + limited #2 (show up to 2 lines)**. SKIP Ctrl+G (external
editor spawn is a separate, riskier feature — child-process/terminal handoff, not worth it now).

### Design
- text-input.tsx: add `pastedContents` (Map<id, string>) state + a callback `onPaste(text)` to the
  parent. When a paste arrives and exceeds threshold (>200 chars OR >2 lines), call onPaste(text)
  which stores it and returns a placeholder `[Pasted text #N +M lines]`; insert the placeholder
  instead of the raw text. Keep raw-paste-insert for small pastes (<threshold).
- text-input.tsx render: when value contains \n, show up to 2 rows (wrap-aware, like clampToRows).
- chat.tsx onSubmit: before sending `value` to the agent, expand any `[Pasted text #N...]` refs via
  the pastedContents map → full text. Then clear the map.

## Questions
1. Scope: agree #1+#2 only, skip Ctrl+G for now? Or is Ctrl+G actually cheap enough to include?
2. Where should pastedContents state LIVE — in TextInput (the component that detects paste) or in
   ChatApp (the parent that submits)? My instinct: TextInput detects+stores+renders, exposes
   onSubmit already carrying the EXPANDED value (TextInput expands before calling onSubmit). That
   keeps ChatApp unchanged. But then the placeholder rendering needs pastedContents in TextInput.
   Cleaner: TextInput owns pastedContents, onSubmit expands internally. Agree?
3. Risk: the placeholder `[Pasted text #N +M lines]` — is there any path where the model or a slash
   command would choke on it if expansion fails? Mitigation: expand BEFORE onSubmit, never send raw
   placeholder.
4. Multiline render: Ink renders <Text> with \n as multiple rows already. The wrinkle is the cursor
   (caret) — currently a single-position bar. On a 2-line input, which line shows the caret?
   Claude Code keeps it simple. What's the least-surprising behavior?

Reply PLAIN TEXT, concise, critical. Read src/ui/text-input.tsx + src/ui/chat.tsx:1540-1556 first.
Do not modify files.
