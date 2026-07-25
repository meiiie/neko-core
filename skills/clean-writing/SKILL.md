---
name: clean-writing
description: Write or edit prose that doesn't read as AI slop - kill the tell-tale patterns; keep it plain, active, specific.
match: (write|rewrite|edit|polish|proofread|improve).{0,30}(copy|prose|blog|post|readme|docs|documentation|landing|headline|tagline|email|announcement|description)|remove ai slop|de-slop|no.?ai.?slop|sound less ai|less robotic|make it human
---

# Clean writing — kill the AI-slop tells

Use when producing or editing human-facing prose (landing copy, docs, READMEs, posts, emails,
announcements). Model prose gravitates to a recognizable set of tics; readers feel them even if they
can't name them. Remove them, then write plainly. This is the verbal counterpart to `design-engine`'s
visual anti-slop.

## The slop patterns to DELETE (with the fix)

| Tell | Example | Fix |
|---|---|---|
| Reflexive contrast | "It's not X. It's Y." · "not a feature, a bug" | State the point directly: "It's Y." Drop the strawman X. |
| Throat-clearing | "Here's the thing…" · "Let's be honest…" | Cut it. Start on the point. |
| Faux insight | "What nobody tells you…" · "The truth is…" | If it's true, just say it. |
| Colon reveal | "The best part: it learns." | "It learns." |
| Importance puffery | "marks a pivotal moment" · "a game-changer" | Say what it does. Let the reader judge importance. |
| Weasel attribution | "studies show" · "experts agree" | Name the source, or drop the claim. |
| Fake-strong verbs | "serves as a centralized hub for" | "is" / the plain verb. |
| Hollow stats | "100% effective" · "10x better" with no basis | Use a real, sourced number, or cut it. |
| Dramatic fragmentation | "That's it. That's the whole thing." | One sentence. Fragments for drama read as slop. |
| Negative listing | "Not X. Not Y. Just Z." | "Z." |
| Rule-of-three reflex | "fast, simple, and powerful" | Two honest adjectives beat three padded ones. |
| Hedge stacking | "It can help to potentially improve" | "It improves" (or say the honest uncertainty once). |
| Emoji section markers | "🚀 Features" | A heading. |

## Then write well (the fundamentals)
- **Lead with the point.** First sentence carries the message; don't warm up to it.
- **Active voice, concrete nouns.** "Neko runs the tests," not "the tests are run by the system."
- **Specific beats clever.** A real detail ("won't say done until `bun test` passes") outperforms a
  slogan. Name things the way the reader says them, not how the system is built.
- **One idea per sentence.** Short. Vary length so it isn't monotone, but default short.
- **Cut adjectives that don't earn their place.** "Powerful", "seamless", "robust", "elegant",
  "cutting-edge", "revolutionary" are usually filler — delete or replace with the concrete thing.
- **Voice test for copy:** "Would a real person on this team actually say this out loud?" If not, rewrite.
- **Numbers must be true.** Never invent a metric for punch. An unbacked stat is the loudest slop tell.

## Workflow
1. Read the draft. Mark every pattern from the table.
2. Rewrite each marked span with the fix — smallest change that removes the tell.
3. Pass for the fundamentals (lead-with-point, active, specific, honest numbers).
4. Read it aloud in your head. If a line sounds like marketing or a chatbot, it isn't done.

Keep the author's real voice and facts; you're removing tics, not flattening personality. When the
piece is deliberately playful, keep the play — just not the formulaic play.
