# GOAL: Hoàn thiện Neko Core — fix lag đo được (input + scroll), không phá hàng rào có chủ đích

## Nguyên tắc cốt lõi (Chesterton's Fence áp dụng toàn phiên)

> **Trước khi dỡ/bất kỳ cơ chế phòng vệ nào (bare catch, differ reset, clamp, coalescing), phải hiểu
> TẠI SAO nó tồn tại — đọc comment, tìm commit/issue nó fix. Code "xấu" thường là giải pháp được lưu
> lại cho một vấn đề chưa thấy.** Bài học từ phiên trước: tôi suýt dỡ các catch có chủ đích.

## Vấn đề đo được khách quan (perf-lag.ts baseline, branch research/lag-fixup)

### Triệu chứng 2 — Long-input lag (RÕ NHẤT, fix-able cao nhất)
| Trạng thái input | writes | bytes | ms | fps |
|---|---|---|---|---|
| 50 chars, gõ 20 phím | 24 | 1.169 | 698 | 34 |
| 2050 chars, gõ 20 phím | 58 | 6.073 | 4.986 | 12 |

Root cause: `src/ui/text-input.tsx` render `{shown.slice(0,i).join("")}{caret}{shown.slice(i).join("")}`
— O(n) theo buffer mỗi keystroke. Không windowing.

### Triệu chứng 1 — Scroll lag
| Cử chỉ | writes | bytes | ms | fps |
|---|---|---|---|---|
| Ctrl+Up burst (15) | 23 | 17.971 | 693 | 33 |
| Ctrl+Down burst (15) | 19 | 17.634 | 667 | 28 |

Root cause hypothesis: FrameDiffer reset ở gesture edges (~780 bytes/write thay vì band-shift sub-ms).

## Loop làm việc với Codex 5.5

1. **Neko nghiên cứu sâu** từng vấn đề: đọc code, tìm invariant, profile cô lập, viết task spec.
2. **Neko giao Codex** qua `codex exec --sandbox workspace-write "<spec>" < /dev/null` (background, poll).
3. **Neko verify khách quan**: `git diff` thật + `bun test` + `bun run typecheck:stable` + `perf-lag.ts`.
4. **Revert ngay** nếu hỏng bất kỳ invariant. Chỉ giữ khi: test PASS + typecheck PASS + perf KHÔNG lui.
5. **Tuần tự**, không song song (race condition trên cùng folder).

## Invariant KHÔNG ĐƯỢC PHÁ (phải giữ qua mọi thay đổi)
- `bun run typecheck:stable` PASS (tsc5)
- Toàn bộ `bun test` PASS
- Caret input chính xác (text-editor caret ▏ trước ký tự, không phải block)
- Unicode/paste/normalize NFC/NFD (test text-input.test.tsx)
- History arrow up/down, Ctrl+A/E, tab, escape-residue handling
- FrameDiffer ghost-row self-healing (commit 013704d)
- Synchronized output BSU/ESU bracketing (sync-stdout.ts)
- Alt-screen guard order (installAltScreenGuard pre-render)
- renderTail/clampToRows/REPLAY_MAX_LINES caps (chống O(n) stream)
- Bare catch có comment lý do → KHÔNG dỡ, chỉ thêm debug nếu có giá trị chẩn đoán

## Tiến độ
- [x] Baseline git + perf harness
- [ ] Deep research #1: input windowing
- [ ] Deep research #2: scroll differ
- [ ] Codex task #1
- [ ] Codex task #2
- [ ] Báo cáo before/after
