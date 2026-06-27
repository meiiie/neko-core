---
name: deep-research
description: Deep, multi-source, fact-checked research — especially time-sensitive or factual questions (latest / current / best / newest / benchmark / price / who / when / so sánh / mới nhất / dữ liệu / nghiên cứu / tìm hiểu / đào sâu). Plan the question, search several sources, CROSS-VERIFY every claim against authoritative/primary sources, sanity-check recency, flag conflicts, and answer with citations. Use whenever accuracy matters more than speed.
---

# Skill: Deep research (verify before you answer)

Time-sensitive and factual questions are exactly where a model confidently states STALE or WRONG things —
trusting its training cutoff, or an SEO/aggregator page. Do not. Follow this pipeline; correctness over
speed.

## The pipeline

1. **Plan** — restate the question, then break it into 2-5 sub-questions / angles. For a multi-angle one,
   `todo_write` the angles so you cover them all.
2. **Search broadly** — `web_search` EACH angle. Don't stop at the first hit; gather several candidate
   sources per angle.
3. **Read the real sources** — `web_fetch` the actual pages (not just the snippet). For any number / fact,
   go to the PRIMARY source (official site, model card, the dataset/leaderboard itself), not a blog about it.
4. **VERIFY — the step that prevents wrong answers:**
   - **Cross-reference:** confirm each key fact across **>=2 independent** sources. One source = not verified yet.
   - **Source quality:** prefer **authoritative / primary** (official sites, model cards, standards bodies,
     well-known leaderboards) over SEO/aggregator/content-farm pages. Distrust auto-generated or list-bait pages.
   - **Recency + sanity:** check the date. For "latest / current / best", a source must be recent. SANITY-CHECK:
     if a "2026 newest" list includes something clearly old (e.g. a 2023-era model among "the newest"), the
     source is STALE — discard it, don't repeat it.
   - **Conflicts:** if sources disagree, say so and weigh by authority + recency; never silently pick one.
   - **Your training is NOT a source:** it has a cutoff. Do not fill gaps from memory. If you couldn't verify
     something, say you couldn't.
5. **Answer with citations** — give the answer, attach the **source URL + date** to each key claim, and flag
   anything uncertain or conflicting. Brief is fine: cited + correct beats long + confidently wrong.

## Honest output

- If reputable sources conflict or are thin, **SAY SO** ("sources disagree on X" / "couldn't verify Y")
  rather than guessing.
- State the **as-of date** for anything time-sensitive (prices, rankings, who holds an office, "the best/latest").
- A short, well-sourced "here's what I could verify, here's what I couldn't" beats a confident wrong table.
