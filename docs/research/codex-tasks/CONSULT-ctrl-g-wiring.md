# CONSULT (Neko → Codex): Ctrl+G alt-screen handoff wiring — review the SWAP contract

I built src/ui/external-editor.ts (openExternalEditor) on top of your earlier design. The util takes
`deps: { suspend, leaveAltScreen, reenterAltScreen, onDifferReset }`. The ChatApp layer must wire
these. The tricky part is the alt-screen SWAP lifecycle — please review for correctness, especially
on Windows/ConPTY (our platform).

## The wiring I plan in ChatApp (src/ui/chat.tsx)
ChatApp already has:
- `altDisposeRef = useRef(preAltDispose)` — the disposer from installAltScreenGuard, set at mount.
- `frameDiffer` prop (FrameDiffer instance) with a `.reset()` method.
- `const { suspendTerminal } = useApp();` (Ink 7.1.0 — confirmed exists).

The Ctrl+G handler (inside useInput, key.ctrl && input === "g"):
```
const result = await openExternalEditor(input, pastedContentsRef.current, {
  suspend: (cb) => suspendTerminal(cb),
  leaveAltScreen: () => altDisposeRef.current?.(),
  reenterAltScreen: () => {
    const fresh = installAltScreenGuard(process.stdout, { mouse: isMouseEnabled() });
    altDisposeRef.current = fresh;   // reassign so the next leave / final unmount tears down the NEW guard
    return fresh;
  },
  onDifferReset: () => frameDiffer?.reset(),
});
if (result.content !== null && result.content !== input) {
  setInput(result.content);   // re-collapsed placeholders are back in the box
}
```

## Questions
1. Is the alt-screen SWAP order correct? Sequence during the editor's run:
   a. suspendTerminal's beginSuspend() runs FIRST (Ink pauses render, releases raw mode).
   b. THEN my callback: leaveAltScreen() (DEC 1049l + disableMouse) → editor runs → reenterAltScreen()
      (DEC 1049h + enableMouse, fresh guard, altDisposeRef updated) → frameDiffer.reset().
   c. suspendTerminal's endSuspend() runs LAST (re-enters Ink's alt-screen IF it owns one — it
      doesn't here — and force-redraws).
   So the user sees: neko's alt-screen leaves → editor on primary → neko's alt-screen re-enters →
   Ink redraws INTO it. Correct? Any window where the screen is blank/garbage between b and c?
2. The reassign `altDisposeRef.current = fresh` inside reenterAltScreen — is this safe given React
   refs + async suspendTerminal callback? The ref is mutable; the value persists. The concern: if
   the FINAL unmount (component teardown) fires the OLD disposer (stale ref captured in a closure).
   I reassign before endSuspend, so any later teardown reads altDisposeRef.current = fresh. But are
   there closures that captured the old value? (e.g. the mount-effect's cleanup.) If so, the OLD
   guard's restore() runs but `restored` is already true from leaveAltScreen() — harmless double?
3. frameDiffer.reset() inside the suspend callback (before endSuspend's forced redraw) — is that the
   right time, or should it be AFTER endSuspend? The differ's `prev = null` makes the next
   process() a full repaint. endSuspend calls onRender which calls process. So reset before endSuspend
   seems right. But endSuspend also sets `this.lastOutput = ''` internally (Ink's own frame cache,
   separate from our differ). Confirm both need clearing.
4. Windows/ConPTY trap: spawnSync with shell:true + stdio:inherit — does the child's exit cleanly
   restore the cursor / leave the primary buffer intact? notepad.exe opens a window (no terminal
   handoff), so alt-screen leave/re-enter is wasted but harmless. `code --wait` likewise. The real
   test is `$EDITOR=vi` (terminal editor) — but on Windows that's rare. Is there a Windows-native
   terminal editor that would actually exercise the alt-screen swap? (vim under WSL/git-bash?)
5. Should Ctrl+G be DISABLED when `awaitingKey` (paste-API-key mode) or `busy`? My instinct: yes for
   awaitingKey (a secret prompt shouldn't dump to a temp file); for busy, allow it (queue editing).

Read src/ui/external-editor.ts + src/ui/altscreen.ts + src/ui/chat.tsx (runChat + the altDisposeRef
declaration + the mount effect) first. Reply PLAIN TEXT, critical, concise. Do NOT modify files.
