# CONSULT (Neko → Codex): two real-user complaints — investigate with MEASURED data

## Problem 1: "neko uses 10-12% CPU, Claude Code only 0.2-2%"
I MEASURED (not guessed). The idle churn probe (test/perf-idle-churn.ts, mounts real ChatApp +
FrameDiffer in a virtual terminal, counts stdout writes over 3s of pure idle):
- 21 writes / 3s, ALL <=100 bytes (caret-blink size), 0 heavy writes
- 814 bytes total / 3s
- blink cadence ~143ms/write (530ms blink + BSU/ESU sync wrappers per write)

I then sampled the actual node process CPU with PowerShell Get-Process over a 7s idle window:
- CPU delta 0.41s / 7s = 5.8% of ONE core = 0.73% Task-Manager-style (machine has 8 logical cores)

So the render loop idle = ~0.7% TaskMgr. The 10-12% the user sees is NOT the render loop. My
hypotheses: (a) Task Manager showing PER-CORE % (10-12% of 1 core = ~1.5% of 8 = normal), (b) the
user measured while a turn was RUNNING (model streaming + tool exec + MCP), (c) a subprocess tree
(codex CLI / MCP servers) the user is attributing to neko.

Question: is there ANY periodic background work in neko I missed that could spike CPU while idle?
I checked: no setInterval polling (only event-driven timers: copyNote 2.5s, ctrlC reset 2s, resize
debounce 150ms, caret blink 530ms, elapsed 1s only-when-busy). detectRefreshRate cached weekly.
update check cached daily. frame-diff resyncTimer unref'd + Windows-only. Do you see anything else?
Or should I conclude the 10-12% is per-core / during-busy / subprocess-tree, not a leak?

## Problem 2: "caret is not flush to the char — it's pushed away by a gap, especially after LEFT arrow"
I MEASURED with ink-testing-library (real TextInput). Dumped the raw rendered frame:
- after typing "hello":         "hello CARET"
- after LEFT once:              "hell CARET o"
- after LEFT twice:             "hel CARET lo"
- after LEFT 3x:                "he CARET llo"

(where CARET = the bar glyph). So in the VIRTUAL terminal the caret is PERFECTLY flush (it hugs the
preceding char, sits before the next). The logic is correct. The user's complaint must be REAL-
terminal rendering of the glyph. The caret is U+258F (LEFT ONE EIGHTH BLOCK). My hypotheses:
(a) Windows Terminal / conhost renders U+258F with a different advance width or kerning than the
    font's other glyphs, creating a visible gap. Some fonts draw block-elements as monospace-aligned
    but the glyph itself has internal left-padding.
(b) A font WITHOUT U+258F falls back to a wider substitute glyph.

The comment in text-input.tsx explicitly chose U+258F over pipe "because a pipe is centred in its
cell so it reads as a gap after the text; the block hugs the LEFT edge". So this was a DELIBERATE
choice — but maybe the chosen font/terminal doesn't honor it.

Question: Is U+258F the right glyph for cross-terminal caret, or is there a more reliable one? What
does Claude Code actually use for its caret glyph (which codepoint)? Should I make the caret glyph
configurable / detect the terminal? Or is the real fix that the caret should OVERLAY (render the
char with inverted colors / underline) rather than INSERT a separate cell?

Read src/ui/text-input.tsx (the render section ~line 140-186) and the caret comment ~line 150-156.
Also check what glyph Claude Code uses in test/claude_lo/claude-code if present. Reply PLAIN TEXT,
critical, concise, with a concrete recommendation. Do NOT modify files.
