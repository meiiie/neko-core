/**
 * External editor for the prompt (Ctrl+G). Opens the current input in `$EDITOR`/`$VISUAL`, reads
 * the saved file back, and returns the edited text. Mirrors Claude Code's promptEditor.ts but on
 * STOCK Ink: we use Ink's `useApp().suspendTerminal(cb)` to pause rendering + release raw mode /
 * bracketed-paste for the editor's lifetime, and we manually swap neko's OWN alt-screen + mouse
 * tracking around the editor (Ink doesn't know neko entered DEC 1049 itself — see altscreen.ts — so
 * `suspendTerminal` won't leave the alt-screen for us; we must).
 *
 * Paste interaction: placeholders like `[Pasted text #N]` are EXPANDED to full content before the
 * file is written (so the user edits real text), then any paste whose content survived the edit
 * unmodified is RE-COLLAPSED on the way back, keeping the input box compact.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { expandPlaceholders, recollapsePastedContent } from "../shared/paste-collapse.ts";

/** Resolve the editor command (VISUAL > EDITOR > platform default) into [cmd, ...args]. */
function resolveEditor(): { cmd: string; args: string[] } | null {
  const raw = process.env.VISUAL || process.env.EDITOR;
  if (raw && raw.trim()) {
    const parts = raw.split(/\s+/).filter(Boolean);
    return parts.length ? { cmd: parts[0], args: parts.slice(1) } : null;
  }
  // Platform default. notepad blocks on Windows; vi is the Unix convention.
  return process.platform === "win32" ? { cmd: "notepad", args: [] } : { cmd: "vi", args: [] };
}

/** Add a wait flag so GUI editors block until the window closes (the spawn must be synchronous). */
function withWaitFlag(cmd: string, args: string[]): { cmd: string; args: string[] } {
  const base = cmd.toLowerCase().replace(/\.exe$/i, "");
  // VS Code family: `code --wait`; Sublime: `subl --wait`. The user's own args come first so they
  // can override (e.g. EDITOR="code --new-window"). Don't add a duplicate wait flag.
  const needsWait = ["code", "code-insiders", "vscodium", "cursor"].includes(base) || base === "subl" || base === "sublime_text";
  const hasWait = args.some((a) => a === "-w" || a === "--wait");
  if (needsWait && !hasWait) return { cmd, args: [...args, "--wait"] };
  return { cmd, args };
}

export interface EditorResult {
  /** The edited text (expanded form), or null if the editor could not run / was cancelled. */
  content: string | null;
  /** A human-readable error, if any (editor exited non-zero, spawn failed). */
  error?: string;
}

/**
 * Open `currentValue` in the external editor. `deps` carries the callbacks neko wires from the
 * ChatApp/runChat layer: `suspend` = Ink's useApp().suspendTerminal; `leaveAltScreen` = the
 * disposer returned by installAltScreenGuard; `reenterAltScreen` = a fresh installAltScreenGuard
 * (mouse enabled iff it was before); `onDifferReset` = FrameDiffer.reset() so the first frame after
 * the editor is a full repaint (the editor dirtied the screen).
 *
 * Returns the EDITED text in EXPANDED form; the caller re-collapses placeholders into the input
 * box (handled here via recollapsePastedContent on the expanded value) — but we return the value to
 * put back into the box, NOT the value to send to the model. The box value keeps placeholders; the
 * pastedMap keeps the full content for later expansion on submit.
 */
export async function openExternalEditor(
  currentValue: string,
  pastedMap: Map<number, string>,
  deps: {
    suspend: (cb: () => Promise<void> | void) => Promise<void>;
    /** Leave the alt-screen + disable mouse. Returns true IFF an alt-screen was actually active
     *  (so the caller knows whether to re-enter one). Clears the owning ref (Codex review pt 2). */
    leaveAltScreen: () => boolean;
    /** Re-enter the alt-screen + re-arm mouse, returning the fresh disposer. Called only when
     *  leaveAltScreen returned true — never enters an alt-screen in inline mode (Codex review pt 1). */
    reenterAltScreen: () => void;
    onDifferReset?: () => void;
  },
): Promise<EditorResult> {
  const editor = resolveEditor();
  if (!editor) return { content: null, error: "No $EDITOR / $VISUAL set" };

  // Expand placeholders so the user edits the real pasted content, not the `[Pasted text #N]` token.
  const toEdit = expandPlaceholders(currentValue, pastedMap);

  const file = join(tmpdir(), `neko-prompt-${Date.now()}.md`);
  writeFileSync(file, toEdit, { encoding: "utf-8" });

  const { cmd, args } = withWaitFlag(editor.cmd, editor.args);
  const fullArgs = [...args, file];

  let editedContent: string | null = null;
  let error: string | undefined;

  // The editor runs INSIDE suspendTerminal's callback: Ink has paused rendering + released raw
  // mode + bracketed paste. We additionally swap neko's alt-screen + mouse (Ink doesn't own those)
  // so a terminal editor (vim/nano) sees a clean primary screen, and reinstall them in finally so
  // Ink's forced redraw on resume paints INTO the alt-screen again.
  await deps.suspend(async () => {
    // Leave first (DEC 1049l + disable mouse). Returns true IFF an alt-screen was active — only
    // then do we re-enter one in finally (inline mode must not enter a new alt-screen). The caller
    // (ChatApp) clears altDisposeRef here so the "currently active guard" invariant holds.
    const hadAltScreen = deps.leaveAltScreen();
    try {
      const res = spawnSync(cmd, fullArgs, { stdio: "inherit", shell: process.platform === "win32" });
      if (res.error) {
        error = `Editor failed: ${res.error.message}`;
      } else if (res.status !== 0 && res.status !== null) {
        error = `${cmd} exited with code ${res.status}`;
      } else {
        editedContent = readFileSync(file, { encoding: "utf-8" });
        // Editors commonly append one trailing newline; strip exactly one (preserve a deliberate
        // blank line = two newlines).
        if (editedContent.endsWith("\n") && !editedContent.endsWith("\n\n")) {
          editedContent = editedContent.slice(0, -1);
        }
      }
    } catch (err) {
      error = err instanceof Error ? `Editor failed: ${err.message}` : "Editor failed";
    } finally {
      // Re-enter the alt-screen + re-arm mouse BEFORE Ink resumes (endSuspend force-redraws).
      // Conditional: inline mode (no alt-screen) leaves the primary buffer as-is. The caller
      // reassigns its altDisposeRef to the fresh disposer returned inside reenterAltScreen.
      if (hadAltScreen) deps.reenterAltScreen();
      // Reset the differ BEFORE endSuspend's forced render reaches the stdout wrapper, so the first
      // post-editor frame is a full repaint (the editor dirtied the screen). Codex review pt 3.
      deps.onDifferReset?.();
    }
  });

  // Best-effort temp cleanup; never fatal.
  try { unlinkSync(file); } catch { /* already gone or never written */ }

  if (editedContent === null) return { content: null, error };

  // Re-collapse any paste the user did NOT edit (exact-match substrings). Edited pastes stay
  // expanded inline. The pastedMap is unchanged: a re-collapsed placeholder's id still resolves to
  // its content, and an edited paste that now differs from its stored content is simply dropped
  // from the map on the next gcPastes() (it no longer matches any placeholder).
  const collapsed = recollapsePastedContent(editedContent, pastedMap);
  return { content: collapsed };
}
