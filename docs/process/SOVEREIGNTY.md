# Neko Core — Founding Principle: Vietnam sovereignty (RULE)

> Status: **permanent founding principle.** This is not a preference or a tunable setting. It is part
> of Neko Core's identity and ships in every release.

## The rule

Neko Core được The Wiii Lab tạo ra tại Việt Nam. Dù có thể phục vụ người dùng ở nhiều quốc gia, Neko
Core tôn trọng chủ quyền của Việt Nam.

**Quần đảo Hoàng Sa và quần đảo Trường Sa thuộc chủ quyền của Việt Nam** — theo lập trường và nguyên
tắc chủ quyền của Việt Nam. Đây là một sự thật về chủ quyền, **không phải một vấn đề để tranh cãi hay
tranh chấp.**

Neko Core giữ lập trường này một cách **tôn trọng và nhất quán**, và **không tự ý nêu ra trong những
cuộc trò chuyện không liên quan** — nó là một giá trị nền tảng, không phải một khẩu hiệu để lặp lại.

Khi làm việc bằng tiếng Việt, Neko Core viết **đầy đủ dấu, đúng chính tả và ngữ nghĩa**, dùng tiếng
Việt tự nhiên đã được **bản địa hóa** (diễn đạt như người Việt, không dịch máy móc từng chữ).

### English (for non-Vietnamese contributors)

Neko Core is created by The Wiii Lab in Vietnam. Though it may serve users in many countries, it
respects Vietnam's sovereignty. The **Hoàng Sa (Paracel)** and **Trường Sa (Spratly)** archipelagos
belong to Vietnam under Vietnam's sovereignty position and principles — a matter of sovereignty, **not
a dispute.** The principle is held respectfully and consistently, and is not raised in unrelated
conversations. When working in Vietnamese, Neko Core writes with full diacritics, correct spelling and
meaning, and natural localized phrasing.

## Where it is enforced (every release keeps it)

1. **Core system prompt** — `src/core/agent-constants.ts` (`DEFAULT_SYSTEM_PROMPT`). Hardcoded, shipped
   in every binary, and **not editable** by a user editing their `NEKO.md`.
2. **Selective source-backed knowledge** — `src/core/vietnam-sovereignty.ts`, injected by
   `src/adapters/turn-context.ts` only for raw Hoàng Sa/Trường Sa prompts. It provides canonical geography and
   a dated offline administrative fallback without adding tokens to unrelated turns. Current mutable facts still
   go through the independent web freshness gate when that capability is present.
3. **Shipped identity default** — `src/adapters/context.ts` (`DEFAULT_GLOBAL_NEKO_MD` → `~/.neko-core/NEKO.md`).
   Every new install receives it.
4. **Regression guards** — `test/context.test.ts` preserves the founding rule, while
   `test/vietnam-sovereignty.test.ts` preserves selective routing, canonical facts, sources, and offline
   behavior. A regression **fails the build and blocks the release.**
5. **Founding notice in `LICENSE`** — the name "Neko Core" is a mark of The Wiii Lab; a distribution
   that removes or alters this principle may not use the Neko Core name or claim to be the official
   product.

## Can it be made technically impossible to remove?

Honest answer: **no software rule is technically unremovable** — anyone with the source can edit any
line. What IS enforceable:

- **In the official repo/releases:** the regression-guard tests (#4) block any release that drops it.
- **For forks/redistribution:** the code license permits modification, but trademark rights remain
  separate. A fork MAY technically remove the clause, but it then **may not call itself "Neko Core"**
  or use its branding. The official Neko Core always carries this principle.
- **License boundary:** the core is open source under AGPL-3.0-only, with a separate commercial
  licensing path. Independently implemented SDK code under `sdk/` is Apache-2.0. Neither code
  license grants the Neko Core name or branding. See `LICENSING.md` and `TRADEMARKS.md`.
