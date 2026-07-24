---
name: web-app
description: Build any real web frontend right - a website, landing/marketing page, portfolio, OR a full-stack app (dashboard/auth/CRUD/DB) - with a committed design system + full SEO.
match: (build|create|make|develop).{0,40}(web ?app|full[ -]?stack|dashboard|admin panel|saas|crud app|web platform|internal tool|web ?site|landing[ -]?page|marketing site|home ?page|portfolio site)|app with (a )?(login|auth|dashboard|database)|production app|full stack (app|application)
---

# Web-app engine — build a production full-stack app, done properly

Use when the user wants a REAL application to keep and run - "build an app with a dashboard and login",
a SaaS, an admin panel, an internal tool - not a timed hackathon demo. Same disciplines as
`hackathon-engine`, opposite optimization: here the goal is **correct, complete, maintainable, and
secure**, not "polished in 48h and cut everything unscored". Nothing ships on assumption.

## Scale to the actual deliverable
This skill spans a spectrum. A **static/marketing page** (a landing, a lab/org site, a portfolio — no data,
no auth) runs ONLY the design + copy + SEO + responsive steps (3, the frontend of 4, and 7) — do NOT
fabricate a database, backend, or auth it doesn't need. A **full data app** (dashboard, login, CRUD) runs
the whole flow. Either way: **commit to an aesthetic direction first** (`design-engine.md` Law 0 — honor the
user's house style if they have one) and **ship a complete SEO `<head>`** on any public page (`seo.md`).

## The mindset shift (vs hackathon-engine)
- **Completeness over a demo path.** Real auth, real data, edge cases, empty/error/loading states, input
  validation, permissions - the things a hackathon cuts, production needs.
- **Maintainable.** A schema and code the user can extend next month; typed boundaries; migrations, not
  hand-edits; tests that document behavior.
- **Correct + secure by default.** Every input validated, every endpoint authorized, every secret out of
  the repo. A production bug or leak is worse than a missing feature.
- Still lazy where it counts (ponytail): reach for the framework's built-ins, a boring proven stack, and
  the smallest design that meets the real requirements - just don't cut correctness or security.

## Flow (stop at the gates; the user approves direction, not every line)
1. **Understand & spec.** Pin the real requirements: who uses it, the core entities, the must-have flows,
   the non-functionals (auth model, scale, data sensitivity). Write a short spec with observable
   acceptance criteria. GATE: confirm scope + the data model before building.
2. **Architecture.** Choose the stack (a golden stack from `hackathon-engine/references/golden-stacks.md`
   tuned for production), the data store, the auth approach, the deploy target. Design the **data model
   first** with the `sql` skill (schema, keys, constraints, indexes, migrations).
3. **Design system.** Read `hackathon-engine/references/design-engine.md` (+ `motion.md`). **Commit to ONE
   aesthetic direction first (Law 0)** — if the user named a house style or reference ("like x.ai", "stoic /
   khắc kỷ đen lạnh"), that IS the direction, honor it exactly; else pick one deliberately and avoid the
   2026 AI-slop clusters. Then a real token system, accessible, both themes, derived on EVERY region incl.
   nav + footer. A dashboard is information design (scan + operate), a marketing page is persuasion - treat
   them differently. GATE: approve the visual direction.
4. **Build, vertical slice by slice.** One flow end to end (UI -> API -> DB -> back) before widening.
   - API/server: `hackathon-engine/references/backend.md` - contract-first, auth (JWT/session), validate
     every input, consistent errors, idempotency, rate-limit.
   - Data: the `sql` skill - correct schema, parameterized queries, no N+1, indexes, real migrations.
   - Frontend: the design system; real states (loading/empty/error), forms with validation + a11y.
   - Copy: the `clean-writing` skill - UI text a person recognizes, no slop.
   - Mobile/responsive: `hackathon-engine/references/mobile.md`.
5. **Test.** `hackathon-engine/references/testing-strategy.md`, but production-weighted: cover the core
   flows, the auth/permission paths, the money/state paths, and the nasty inputs - enough to trust
   changes, run in CI. TDD for bugfixes.
6. **Secure.** `hackathon-engine/references/security.md` - no secrets in the repo, HTTPS, authz on every
   private endpoint, validated inputs, least privilege, safe errors. Verify a control by trying to break it.
7. **Ship & observe.** `docker` skill + `hackathon-engine/references/devops.md` - containerize,
   build->test->deploy, migrations in the pipeline, rollback, structured logs + an error signal.
   For ANY public page, ship the complete SEO `<head>` from `references/seo.md` (title/description, canonical,
   robots, full Open Graph + Twitter, JSON-LD, favicon) — not optional, it's part of a real page.

## Research & staying current
For anything where the best approach or a library choice is uncertain or fast-moving, use the
`research-method` skill (primary sources, cross-verify, doubt the conclusion, keep a research ledger).
Don't build on a stale assumption.

## Verify (the honest bar - same as the whole toolkit)
Run it, exercise the real flows (auth in, create/read/update/delete, the permission boundaries), read
the actual result, and look at every screen from a fresh state - not "it should work". A green build
you didn't watch, an endpoint you didn't hit, a screen you didn't open is not evidence. Never say done
without it.
