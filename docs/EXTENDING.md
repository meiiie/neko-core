# Extending Neko — domains are pluggable, the core stays general

Neko follows the SOTA agent-extensibility model (2026): a **thin, general core** plus **pluggable
capabilities**. You teach Neko a new domain (procurement, legal review, devops, ...) by *adding a
skill* — never by hard-coding the domain into the core. Neko knows the domain deeply when a task
needs it, and stays a general coding/agent tool the rest of the time.

This mirrors how Claude Code and Codex extend: **Skills** (domain expertise) + **MCP** (tools/hands)
+ **Plugins** (a bundle for distribution). See Anthropic's
[Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).

## How Neko's capability grows: the memory triad
Beyond pluggable skills, Neko gets more capable three complementary ways — all file-based, JIT-recalled
via an index injected each turn, no vector DB:

| Leg | Tool / dir | Holds | Authored by |
|---|---|---|---|
| **Facts** | `memory` · `~/.neko-core/memory/` | Durable facts/preferences | the agent, as it learns |
| **Skills** | `skill` · `skills/` | Domain expertise (procedures + tools) | a human, up front |
| **Workflows** | `workflow` · `~/.neko-core/workflows/` | Reusable PROCEDURES learned by doing | **the agent, from successful runs** |

The third leg is the self-improving one (AWM — Agent Workflow Memory): after a non-trivial task that
worked, the agent distills the steps/tools/gotchas into a workflow; a deterministic `matchWorkflow`
recalls it before a similar task. Measured value: on a task with a non-obvious rule, a learned workflow
took success from 0/3 to 3/3 (`test/workflow-value-eval.ts`). So Neko gets faster + more reliable over
time in *every* domain, not just where a human wrote a skill.

## The three layers

| Layer | What it is | In Neko |
|---|---|---|
| **Skill** | Domain *expertise* as instructions (a SKILL.md). Shapes how the agent reasons/acts — no code. | `skills/<name>/SKILL.md` (or `<name>.md`); loaded on demand. |
| **MCP** | The *hands*: external tools/data (a browser, a price API, a phone-call service). | `mcp` config — stdio/http/sse servers. See `docs/process/WEB.md`. |
| **Plugin** | A *bundle* of skills + MCP + recipes for one-step install. (Not a new capability — a delivery format.) | Future: ship a directory users drop in. |

## Skills: progressive disclosure (the key mechanism)

A skill costs almost nothing until it's used:

1. **Always in context (cheap):** every skill's `name` + one-line `description` is injected
   (`skillsContextBlock`, ~100 tokens each) so the model *knows the capability exists*.
2. **Loaded just-in-time:** when a task matches, the model calls the `skill` tool with the name; the
   full SKILL.md body comes back and the model follows it. The body never sits in context unused.

So you can install many domain skills without bloating context or turning Neko into a single-purpose
bot — only the relevant one loads, only when relevant.

### Where skills live (first match wins)
1. `~/.neko-core/skills/` — your personal skills.
2. `./.neko-core/skills/` — project-local skills (committed with a repo).
3. `<neko>/skills/` — **bundled** skills shipped with Neko (lowest priority; the two above override).

### SKILL.md format
```markdown
---
name: my-domain
description: One line — WHAT it does + WHEN to use it. This is the trigger the model matches on, so be concrete.
---

# Skill: <title>

<the workflow, rules, domain knowledge, tools to use, and output format. Keep it focused;
split into reference files and link them if it grows past a few hundred lines.>
```
Good descriptions are specific ("Mua sắm / tìm nguồn hàng tại VN ... khi cần tìm/so sánh/mua") — the
model picks a skill by its description, so vague ones never fire.

## Worked example: `procurement`

`skills/procurement/SKILL.md` turns Neko into a **Purchasing Officer** for Vietnam: given an item
list, it sources across VN platforms (Thế Giới Di Động / FPT / CellphoneS for official tech, Shopee /
TikTok Shop / Lazada / Tiki marketplaces, B2B/wholesale for bulk), compares price / stock / seller
trust / warranty / VAT / shipping-to-Bắc-Giang, and outputs a **purchase plan for a human to approve
and buy**. A hard rule in the skill: it **never places orders or pays** — the human owns the money.

The hands it uses: `web_search` + `web_fetch` today; a **browser MCP** (Playwright) for JS-heavy sites
(Shopee/Tiki) and, later, a **voice-call MCP** to phone vendors for stock/quotes (ask only, never buy).

A skill can ship more than a SKILL.md — the procurement skill bundles:
- **`scripts/`** — runnable helpers. `make-sheet.ts` turns a normalized offer table into a real `.xlsx`
  with clickable hyperlinks + auto-filter (zero-dependency, runs under `bun`). The `skill` tool surfaces
  the skill's own directory, so the body can invoke `bun "<skill files dir>/scripts/make-sheet.ts" ...`.
- **`evals/`** — a deterministic check (`run-evals.ts`): fixed input (no network), `--trials N` ->
  PASS/FLAKY/FAIL, so a domain's behavior (lowest/highest/sort/filter/export) is measurable + regression-proof.

This is the template for any domain: deep expertise in a SKILL.md, optional bundled scripts for the
mechanical parts, evals to keep it honest, general tools (or an MCP) for the hands, and human-in-the-loop
for anything irreversible.

## Worked example: `office-artifacts`

`skills/office-artifacts/SKILL.md` adds professional `.docx`, `.xlsx`, and `.pptx` work without turning
Neko's core into an Office implementation. `adapters/office-tools.ts` composes through the existing
`McpTools` port: inspection is safe; transactional batch edits and rendering are approval-gated. The optional
OfficeCLI engine is owner-aware and checksummed under `/support office`; Neko never silently downloads it,
hands it arbitrary shell authority, or treats a third-party resident process as trusted core code.

Its completion contract is deliberately stronger than "the command succeeded": preserve the source, inspect
stable targets, stage a derivative, batch related mutations with stop-on-error, close, validate before atomic
replacement, reopen from disk, read back every requested target, and render the affected pages/slides/ranges for
vision review. Formula-heavy workbooks require independent recalculation before numerical claims. This is the
same thin-core pattern as procurement, but it also demonstrates why structural and visual verification must
remain separate evidence channels.

## Add a new domain capability
1. **Write the skill.** `skills/<name>/SKILL.md` (bundled) or `~/.neko-core/skills/<name>.md` (personal).
   Frontmatter `name` + a concrete `description`; body = workflow + rules + tools + output format.
2. **Check it's discovered:** `neko skills` lists it; in chat the model sees it and calls `skill`.
3. **Wire tools if needed:** add an MCP server for any external capability (browser, API, telephony).
4. **Keep the human in control** for irreversible actions (spending, sending, deleting) — plan, don't execute.
5. **Test end-to-end:** give Neko a real task in the domain; confirm it auto-loads the skill and follows it.

## Why this design
- **Core stays small + general** — adding a domain doesn't touch `core/`; the architecture test stays green.
- **No context bloat** — progressive disclosure means N skills cost N descriptions, not N bodies.
- **Composable** — a task can pull several skills; skills + MCP + memory compound.
- **Distributable** — a domain is just files; bundle them as a plugin later with zero core changes.
