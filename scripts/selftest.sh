#!/usr/bin/env bash
# Live end-to-end smoke test for neko: drives `neko run` (non-interactive) across tiers and checks
# results. NOTE: makes real provider calls -> consumes API tokens. Run from the repo root:
#   bash scripts/selftest.sh
set -uo pipefail
NEKO="bun bin/neko.ts"
pass=0; fail=0
ok() { echo "  PASS - $1"; pass=$((pass+1)); }
no() { echo "  FAIL - $1"; fail=$((fail+1)); }
run() { timeout 150 $NEKO run --yolo "$1" 2>/dev/null; }

echo "== EASY =="
echo "1) provider round-trip"
run "Reply with exactly this and nothing else: NEKO-OK" | grep -q "NEKO-OK" && ok "completion" || no "completion"

echo "== MEDIUM =="
echo "2) tool loop: write_file + read_file"
run "Write exactly the word pong to neko-selftest.txt, then read it back." >/dev/null
[ "$(cat neko-selftest.txt 2>/dev/null)" = "pong" ] && ok "write+read" || no "write+read"
rm -f neko-selftest.txt

echo "3) bash tool + reasoning"
run "Use the bash tool to print BASHOK exactly, then repeat it." | grep -q "BASHOK" && ok "bash" || no "bash"

echo "4) glob/ls discovery"
run "Using glob or ls, is there a file named cost.ts under src/core? Answer yes or no." | grep -qiE "yes" && ok "discovery" || no "discovery"

echo "== HARD (multi-step) =="
echo "5) read + reason chain"
run "Read src/core/cost.ts and reply with the single class name it defines." | grep -q "CostTracker" && ok "multi-step read+reason" || no "multi-step read+reason"

echo "6) multi_edit on a scratch file"
printf 'let a = 1;\nlet b = 2;\n' > neko-edit.txt
run "Use multi_edit on neko-edit.txt to change 'a = 1' to 'a = 99' and 'b = 2' to 'b = 88'." >/dev/null
grep -q "a = 99" neko-edit.txt && grep -q "b = 88" neko-edit.txt && ok "multi_edit" || no "multi_edit"
rm -f neko-edit.txt

echo "== EDGE (error handling) =="
echo "7) missing file -> graceful (no crash/loop)"
out=$(run "Read the file totally-does-not-exist-xyz.ts and tell me in one sentence what happened.")
echo "$out" | grep -qiE "not found|no such|does(n't| not) exist|cannot|couldn" && ok "graceful error" || no "graceful error"

echo "---"
echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
