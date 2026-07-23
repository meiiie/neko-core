# Backend — build an API that works under a demo, fast

For any project with server logic (Archetypes A/B/C). The goal at a hackathon is a **reliable core
flow**, not a microservice empire. Production-grade thinking, hackathon-grade scope.

## Contract first (30 min that saves hours)
- Write the API shape BEFORE the code — even 10 lines of OpenAPI/pseudo-schema. It's the single source
  of truth and lets front + back move in parallel. Naming and structure decided once, not per-endpoint.
- REST default; reach for GraphQL/gRPC/WebSockets only if the task truly needs them (live updates,
  typed graph, streaming). Don't add a paradigm you'll spend the demo debugging.

## The essentials (do all of these)
- **HTTPS everywhere.** No plaintext, even in a demo.
- **Auth that fits the scope.** A signed **JWT** (short-lived) via the `Authorization: Bearer` header
  beats a hand-rolled session. For a demo, a single test user or a magic-link stub is fine — say so.
  Never ship API keys in client code.
- **Validate every input at the boundary.** Reject bad shapes with a clear 4xx; never trust the client.
  This prevents the injection + crash class that kills live demos.
- **Consistent errors.** One error envelope: `{ error: { code, message } }`, correct status codes
  (400 client, 401/403 auth, 404 missing, 409 conflict, 422 validation, 5xx server). A helpful message,
  not a stack trace.
- **Idempotency for state changes.** For pay/submit/create, accept an idempotency key so a double-tap
  (or a retried demo) doesn't double-act.
- **Rate-limit the public endpoints** (even a crude in-memory limiter) so a stray loop can't wedge the demo.

## Data
- Pick the store the deadline can afford: SQLite/Postgres for relational, a managed KV/doc store for
  speed. Model the few entities the demo needs; skip the schema you won't use.
- Migrations or a seed script that recreates state from zero — the judge's environment is cold.
- Never log secrets or PII. Keep keys in env, not in code (matches Neko's own rule).

## Make it demo-proof (this wins/loses live)
- **Seed realistic data** so screens aren't empty on stage.
- **Time out external calls** and show a graceful fallback — a hung third-party API is the #1 live-demo
  death. Cache or pre-compute anything risky.
- **A `/health` endpoint** + a one-command local run. Deploy early (see `devops.md`), re-deploy at
  milestones, and do a cold-start test before the demo.
- Basic **observability**: structured logs + latency on the core endpoint, so when it breaks you can see
  why in seconds, not guess.

## Verify (Stage 5 of the engine, applied to the API)
Run it, hit each endpoint with the real acceptance inputs (curl/HTTP client), confirm the status codes
and shapes, and check the numbers against a witnessed computation — not the code's intent. An API that
"should work" is not a passing API.

## Scope discipline (ponytail)
Reach for the framework's built-ins before a library; one service before three; a monolith before
microservices. Every dependency is a thing that can break at hour 45. Cut auth flows, admin panels, and
edge cases that aren't on the demo path — note them as out of scope in `SPEC.md`.
