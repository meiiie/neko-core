---
name: web-app
description: Build a real production full-stack app (dashboard, auth, CRUD, data): spec, architecture, UI, API, DB, tests, ship.
match: (build|create|make|develop).{0,40}(web ?app|full[ -]?stack|dashboard|admin panel|saas|crud app|web platform|internal tool)|app with (a )?(login|auth|dashboard|database)|production app|full stack (app|application)
---

# Web-app engine — build a production full-stack app, done properly

Use when the user wants a REAL application to keep and run - "build an app with a dashboard and login",
a SaaS, an admin panel, an internal tool - not a timed hackathon demo. Same disciplines as
`hackathon-engine`, opposite optimization: here the goal is **correct, complete, maintainable, and
secure**, not "polished in 48h and cut everything unscored". Nothing ships on assumption.

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
3. **Design system.** Read `hackathon-engine/references/design-engine.md` (+ `motion.md`) - a real token
   system, accessible, both themes, no AI-slop. A dashboard is information design (scan + operate), a
   marketing page is persuasion - treat them differently. GATE: approve the visual direction.
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
   `references/seo.md` if it's a public marketing surface.

## Research & staying current
For anything where the best approach or a library choice is uncertain or fast-moving, use the
`research-method` skill (primary sources, cross-verify, doubt the conclusion, keep a research ledger).
Don't build on a stale assumption.

## Verify (the honest bar - same as the whole toolkit)
Run it, exercise the real flows (auth in, create/read/update/delete, the permission boundaries), read
the actual result, and look at every screen from a fresh state - not "it should work". A green build
you didn't watch, an endpoint you didn't hit, a screen you didn't open is not evidence. Never say done
without it.
