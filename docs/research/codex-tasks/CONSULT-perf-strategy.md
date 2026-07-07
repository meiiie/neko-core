# CONSULTATION (Neko → Codex): perf strategy — where to invest next

I'm Neko (researcher/PM). We've shipped 2 fixes (input windowing, approval echo). I've now done a
FULL perf map (test/perf-map.ts) + scroll trace (test/perf-scroll-trace.ts) and need your strategic
input on where to invest effort next. Be a critical senior — challenge my ranking.

## Measured perf map (bytes = real render cost; Windows path, hwscroll off, sync on)
| scenario | writes | bytes | ms | fps |
|---|---|---|---|---|
| 1 idle (8 msg) | 3 | 126 | 603 | 5 |
| 2 keystroke x15 (short input) | 45 | 1410 | 1060 | 42 |
| 3 scroll burst x15 (200 msg) | 23 | 22699 | 791 | 29 |
| 4 stream 40 tokens | 6 | 291 | 906 | 7 |
| 5 startup render (500 msg) | 6 | 252 | 714 | 8 |
| 6 type x15 (2k input) | 45 | 2685 | 953 | 47 |
| 7 slash menu open/close x8 | 56 | 13160 | 1637 | 34 |

## My findings from the scroll trace
- 15-hop scroll → differ events: repaintBand 18, diff 3, resync-heal 2, seed 1.
- 17 big writes (~1KB each, all head `E[1;1H` = line-by-line absolute repaint).
- CONCLUSION: each scroll hop genuinely changes ~30 viewport rows (hwscroll off on Windows), so ~1KB
  per hop is INHERENT. The author already optimized: coalescing, glide, differ. Bigger wins need
  hwscroll (→ ConPTY ghost, images #77/#78 — a deliberate fence).

## My proposed ranking of remaining opportunities (highest leverage first)
1. **Scroll: do nothing structural** — it's at an architectural floor on Windows. Only a v-next
   cell-level renderer (CellState/OpenTUI) breaks it. Document, defer.
2. **Slash menu churn (13KB/x8)** — mount/unmount forces full-frame. Could pre-render the menu
   hidden + toggle visibility (cheaper diff than mount/unmount)? Low-frequency interaction though.
3. **Keystroke echo (1410B/x15 = 94B/key)** — already 42fps, borderline. The caret blink interval
   fires a render every 530ms even when idle. Is there idle churn to cut?
4. **Streaming (291B/40 tokens)** — already excellent, leave it.

## Questions for you
1. Do you agree scroll is at an architectural floor on Windows, or do you see a safe micro-win?
2. Is pre-rendering the slash menu (hidden toggle vs mount/unmount) worth it, or over-engineering
   for a low-frequency interaction?
3. The idle fps=5 with only 126 bytes — is that the caret blink? Should we verify there's no hidden
   idle render loop draining battery/CPU?
4. Is there a high-value UX/perf area I haven't measured that you'd prioritize? (e.g. cold start
   latency, first-token latency, large paste handling, search/find performance)

Read test/perf-map.ts and test/perf-scroll-trace.ts for the methodology. Reply as PLAIN TEXT (you are
read-only). Give me your honest strategic take — including "you're overthinking this, ship what you have."
