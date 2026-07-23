---
name: sql
description: Design schemas and write SQL that is correct, safe, and fast - modeling, queries, indexes, migrations, transactions.
match: (\bsql\b|postgres|postgresql|mysql|sqlite|mariadb|database schema|\bmigration|\bindex(es|ing)?\b|query optimi[sz]|join|\borm\b|prisma|drizzle|sqlalchemy|N\+1|foreign key|primary key)
---

# SQL — model it right, query it safely, make it fast

Use for anything with a relational database: designing the schema for an app (dashboards, auth, CRUD),
writing/optimizing queries, migrations, or fixing slow/incorrect data access. The goal is data that stays
correct under concurrency and queries that stay fast as rows grow.

## Model the schema first
- **One source of truth per fact.** Normalize to ~3NF by default (no duplicated data that can drift);
  denormalize deliberately, only for a measured read hotspot, and note why.
- **Right types, real constraints.** `NOT NULL` where a value is required; `UNIQUE` for natural keys;
  `CHECK` for invariants; `FOREIGN KEY` with an explicit `ON DELETE` (`CASCADE`/`RESTRICT`/`SET NULL`)
  chosen on purpose. Money = integer minor units or `NUMERIC`, never float. Timestamps = `timestamptz`
  (UTC). Enums for closed sets.
- **Keys**: a stable primary key (a surrogate `bigint`/`uuid` is fine; `uuid v7`/ULID sorts by time).
  Don't leak sequential ids if they're sensitive.
- **Auth tables** (a common app need): `users` (email `citext` UNIQUE, password *hash* only - never
  plaintext, use argon2/bcrypt at the app layer), sessions/tokens with an `expires_at`, roles/permissions
  as their own tables, not a magic string column.

## Write correct, safe queries
- **Parameterize EVERYTHING** — bind variables, never string-concatenate user input. This is the whole
  SQL-injection defense; there is no "trusted" interpolation. (Ties to `security.md`.)
- **Explicit columns**, not `SELECT *`, in app code (stable, less data, index-only scans possible).
- **Transactions** around multi-statement invariants (money, state changes); know your isolation level;
  keep them short. Use an idempotency key for at-least-once request paths.
- **Set-based, not row-by-row.** One query with a `JOIN`/`GROUP BY` beats a loop of queries. The #1 app
  perf bug is **N+1** (a query per row from an ORM) - eager-load / join / batch instead. Watch your ORM's
  generated SQL.

## Make it fast (indexes + reading plans)
- **Index what you filter, join, and sort on.** A composite index's column order matters (equality cols
  first, then range/sort). A foreign key needs its own index for fast joins + cascades.
- **Read the plan**: `EXPLAIN (ANALYZE, BUFFERS)`. A `Seq Scan` on a big filtered table = a missing
  index; look for the row-estimate vs actual gap. Don't guess - measure the slow query.
- Keep indexes lean (they cost writes); drop unused ones. Add partial/covering indexes for hot queries.
- Paginate with **keyset/seek** (`WHERE id > :last ORDER BY id LIMIT n`), not big `OFFSET`, on large sets.

## Migrations (evolve without breaking)
- Every schema change is a **versioned, reviewed migration** with a forward (and ideally a down) step,
  run in CI and prod the same way. Never hand-edit prod schema.
- **Expand -> migrate -> contract** for zero-downtime: add the new nullable column/table, backfill,
  switch the app, then drop the old - in separate deploys. Avoid a blocking lock on a big table (add
  indexes `CONCURRENTLY` on Postgres; add columns without a volatile default).

## Verify (the honest bar)
Run the query/migration against real (or realistic-seed) data and read the actual result + the plan -
not the ORM's promise. For a reported number, the value must come from a query you ran, not an estimate.
A migration "should apply" is not applied: run it up AND down on a copy before trusting it.
