#!/usr/bin/env bash
# Live end-to-end smoke test for neko: drives `neko run` (non-interactive) and checks results.
# NOTE: makes real provider calls -> consumes API tokens. Run from the repo root:
#   bash scripts/selftest.sh
set -uo pipefail
NEKO="bun bin/neko.ts"
pass=0; fail=0
ok()  { echo "  PASS - $1"; pass=$((pass+1)); }
no()  { echo "  FAIL - $1"; fail=$((fail+1)); }

echo "1) provider round-trip"
$NEKO run --yolo "Reply with exactly this and nothing else: NEKO-OK" 2>/dev/null | grep -q "NEKO-OK" && ok "completion" || no "completion"

echo "2) tool loop (write_file + read_file)"
$NEKO run --yolo "Write exactly the word pong to neko-selftest.txt, then read it back." >/dev/null 2>&1
[ "$(cat neko-selftest.txt 2>/dev/null)" = "pong" ] && ok "file written+read" || no "file written+read"
rm -f neko-selftest.txt

echo "3) bash tool + reasoning"
$NEKO run --yolo "Use the bash tool to print BASHOK exactly, then repeat it back." 2>/dev/null | grep -q "BASHOK" && ok "bash" || no "bash"

echo "4) read + comprehension"
$NEKO run --yolo "Read src/core/cost.ts and reply with the class name it defines, one word." 2>/dev/null | grep -q "CostTracker" && ok "read+comprehend" || no "read+comprehend"

echo "---"
echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
