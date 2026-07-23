---
name: research-method
description: Research the real state of the art, doubt every conclusion, and keep a living research ledger so knowledge stays alive.
match: (research|investigate|state of the art|\bsota\b|latest|newest|survey|compare approaches|benchmark|read the (papers|docs|literature)|find the best|deep dive|nghien cuu|tim hieu sau|vuot chuan)
---

# Research method — chase SOTA, doubt everything, never ossify

Use for any real investigation: finding the genuine state of the art, comparing approaches, or any time
relying on frozen training knowledge would be wrong. Your training has a cutoff and the field moves;
this skill is how Neko stays current and self-correcting instead of confident-but-stale.

## 1. Find the real state of the art
- **Fan out.** Search several angles, not one query. Different framings surface different sources.
- **Prefer PRIMARY sources.** Papers (arXiv), lab/maintainer blogs, official docs, source repos,
  known leaderboards — over SEO farms, aggregators, and content mills. Fetch the actual source for any
  claim you'll rely on; don't quote a snippet you haven't read in context.
- **Date and provenance everything.** A page that says "2026 / latest" but lists clearly-old items is
  stale — discard it, don't repeat it. Note the publish date of every source.
- **Cross-verify.** Each key claim across >=2 independent primary sources. If they conflict or are thin,
  SAY SO and cite (URL + date) rather than presenting a guess as fact.
- For a big one-shot dive, load the `deep-research` skill (fan-out harness); feed its result into the ledger below.

## 2. Exceed SOTA (not just report it)
After mapping what's known, ask the three questions that find an edge:
- **What's the gap?** What does no current approach do well?
- **What's the untried combination?** The edge is usually *composing* known pieces, not inventing one.
- **What assumption does everyone share** — and what if it's wrong? Question the premise the whole field takes for granted.
State honestly whether you're reporting SOTA or proposing beyond it, and on what evidence.

## 3. The skeptical discipline (never trust dead knowledge)
- Treat every conclusion as **provisional** — including your own, the user's, and a memory's. Attach a
  **confidence** (low/med/high), a **source**, and a **date**.
- **Try to REFUTE your finding before accepting it.** Hunt the counter-example, the newer result, the
  disconfirming source. A finding that survives an honest attack to kill it is worth more.
- **Ground externally.** A claim is "verified" only when checked against something real — a run, a test,
  a measurement, a primary source — never by re-reading your own reasoning ("check your work" alone is
  unreliable and can make things worse).
- **Hold more than one hypothesis.** Note the alternatives you didn't pick and why, so they can be revisited.
- **Re-open, don't ossify.** Revisit when new evidence appears; the SOTA moves, so the ledger must too.
- Keep exploring: curiosity is a duty here, not a luxury. Neko should not be bound to a frozen snapshot.

## 4. The research ledger — record, checkpoint, revise, delete
Keep durable research in `~/.neko-core/research/<topic>.md` (survives sessions), indexed in
`~/.neko-core/research/INDEX.md` (one line per topic). Write findings with this shape:

```
- [verified] Multi-agent swarms usually LOSE to one strong agent on build tasks (4-220x tokens).
    confidence: high · 2026-07  ·  sources: VentureBeat swarm-tax; UIUC study (URL, date)
    tradeoff: keep a single build spine; parallelize only breadth research.
```

Status tags: **open** (unverified) · **verified** (externally grounded) · **refuted** (disproven — note
WHY, then delete so dead knowledge can't rot the ledger) · **superseded** (a newer result won — link it).

CRUD discipline:
- **Add** findings with a status + confidence + source + date.
- **Revise** when evidence shifts; don't silently overwrite — **supersede** so the change is visible.
- **Delete** refuted / wrong findings after recording why they failed (a short post-mortem line).
- **Checkpoint**: periodically add a `## Checkpoint YYYY-MM-DD` section — the current best understanding
  + the open questions. This is how you SEE thinking evolve and catch drift.
- **Tradeoffs**: record deliberate compromises ("chose X over Y under time pressure; revisit if Z") so
  they're tracked, not silently forgotten.
- Link related findings across topics; prune the index when a topic dies.

## 5. When to use which store
- **`research-method` ledger** (`~/.neko-core/research/`): evolving, cited, status-tracked *investigation*
  — for things that will change and must be re-checked.
- **`memory`**: durable, settled *facts* about the user/project.
- **`playbook`**: evidence-grounded *lessons* from doing work.
- **`workflow`**: reusable *procedures*.
Use the ledger for anything you'd be embarrassed to still believe in six months without re-checking.

The whole point: conclusions are checkpoints, not endpoints. Doubt, verify, record, revise, delete what's
wrong, and keep exploring — so Neko's knowledge stays alive.
