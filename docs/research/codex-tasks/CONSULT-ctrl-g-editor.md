# CONSULT (Neko → Codex): Ctrl+G external editor for neko — raw-mode/alt-screen handoff

User wants the Ctrl+G feature: "open the full prompt in $EDITOR, sync back on save" (Claude Code
has it via chat:externalEditor). I read claude-code's src/utils/promptEditor.ts — the core is
`editFileInEditor()`: write prompt to temp file, spawn `$EDITOR file` with `stdio:'inherit'`, read
the file back. The HARD part is the terminal handoff (their `inkInstance.enterAlternateScreen() /
pause() / suspendStdin()`). neko uses STOCK Ink (no custom instance), so I need your design review.

## neko's terminal model (read these)
- src/ui/altscreen.ts: `installAltScreenGuard(out, {mouse})` enters DEC 1049 alt-screen + mouse
  tracking, returns an idempotent `restore()` that leaves alt-screen + disables mouse, registered on
  exit/SIGINT/SIGTERM/uncaughtException.
- src/ui/chat.tsx runChat(): enters alt-screen via `installAltScreenGuard(process.stdout,
  {mouse:isMouseEnabled()})` BEFORE `render(<ChatApp .../>)`. Keeps `app` (Ink instance) + `preAltDispose`.
  Ink options: exitOnCtrlC:false, interactive:true, stdout wrapped for sync-output, maxFps from config.
- ChatApp is the React component. The Ctrl+G handler must live there (it owns the input state +
  the pastedContents Map added in the previous task). But `app` + `preAltDispose` only exist in
  runChat (the parent).
- Ink stock API on `app`: `.clear()`, `.unmount()`, `.waitUntilExit()`, `.rerender()`. NO
  pause/suspendStdin/enterAlternateScreen (those are claude-code's custom-fork extensions).

## My proposed handoff for Ctrl+G
The handler is a function `openExternalEditor(text): string` that ChatApp calls via a callback prop
threaded from runChat. Inside runChat it does:
1. write current input (already paste-expanded) to a temp file.
2. `app.unmount()` — stops Ink's render loop, so Ink stops writing frames / reading stdin.
3. `restore()` = preAltDispose() — leaves alt-screen (DEC 1049l) so the editor sees the normal
   terminal; disable mouse.
4. `spawnSync(editorCmd + ' "' + tempfile + '"', {stdio:'inherit'})` — editor runs in foreground,
   raw-mode is the EDITOR's responsibility now (Ink's setRawMode was undone by unmount? or do I need
   stdout.setRawMode(false) explicitly?).
5. read tempfile back, strip one trailing newline.
6. re-enter: `installAltScreenGuard(...)` again + `app = render(<ChatApp.../>)` again? OR can I
   `app.rerender()` after re-entering alt-screen? The concern: React state (all of ChatApp's refs,
   messages, queue) must SURVIVE — a full remount loses it. So rerender (same app) is strongly
   preferred over a fresh render.

## Questions (critical, reply plain text concise)
1. Does stock Ink's `app.unmount()` release raw mode (stdout.setRawMode(false)) so the editor can
   run? Or must I explicitly `process.stdin.setRawMode(false)` / `process.stdin.resume()` around the
   spawn? What's the minimal, correct sequence? (I cannot read Ink's source from here — tell me what
   you find in node_modules/ink or from knowledge.)
2. The re-entry: after `restore()` (leave alt-screen) and editor exits, I need to RE-enter alt-screen
   AND have Ink resume rendering the SAME app/state. Is `app.rerender()` enough, or does unmount
   permanently tear down? If unmount is destructive, what's the alternative — does Ink expose a
   "pause rendering" without unmount? (Stock Ink: I believe only unmount/clear/rerender/waitUntilExit.)
3. The DEC 1049 leave/re-enter cycle: claude-code avoids the cycle for GUI editors (code/subl open
   a window, no terminal handoff needed — just pause Ink + spawn). Should neko do the same fast-path
   for GUI editors (detect 'code'/'subl'/'code-insiders' → add -w/--wait, skip alt-screen swap)?
   Recommended editor detection: VISUAL > EDITOR env, else platform default (notepad on win? vim on
   unix?). Windows GUI: 'code -w' works; notepad blocks; what's least-surprising?
4. Risk on Windows specifically (our platform): ConPTY + alt-screen swap + spawnSync inherit — any
   known trap where the terminal stays in a bad state after the editor exits (cursor hidden, mouse
   stuck on, primary buffer corrupted)? How does claude-code's finally{} guarantee hold up?
5. Is there a simpler/safer scope I'm missing? E.g. — only support GUI editors first (skip the
   terminal-editor alt-screen swap entirely), ship Ctrl+G for VS Code / Sublime users (the majority),
   leave terminal-editor support for a follow-up. Trade-off?

Read src/ui/altscreen.ts + src/ui/chat.tsx (runChat, ~1655-1695) + src/ui/text-input.tsx first.
Do NOT modify files. Reply plain text, critical, concise.
