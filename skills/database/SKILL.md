---
name: database
description: Database end skill — schema design, indexing, queries, migrations, scaling. Engine-neutral (Postgres / MySQL / SQLite / NoSQL patterns). Pair with a language skill (`python`, `typescript`, `golang`), `backend` for where it fits, and `coding-standards`.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Database

Schema design, indexing, queries, migrations, scaling. **Engine-neutral**. For query-level performance inside a service, also see `backend/references/data-access.md`.

## When to load

- Designing or reviewing schema changes
- Writing migrations
- Diagnosing slow queries / choosing indexes
- Planning multi-tenant / sharding / read-replica topology
- Choosing between relational, document, key-value, time-series, graph

## Core principles

1. **Model the domain, not the queries.** Normalized schema first; denormalize when measurement shows it's needed.
2. **Every table has a primary key.** Every foreign key is declared, so integrity is enforced by the DB, not hoped for in app code.
3. **Constraints over application validation for invariants.** `NOT NULL`, `CHECK`, `UNIQUE`, `FOREIGN KEY` — let the DB refuse bad data.
4. **Indexes are a cost.** Every index slows writes and costs storage. Add them to answer real queries; drop them when the queries change.
5. **Migrations are additive first, destructive later.** Deploy the read; deploy the write; backfill; then remove the old path.
6. **Test migrations against production-scale data.** A migration that runs in 5 seconds on 1 000 rows can lock a table for 30 minutes on 100 million.
7. **Keep transactions short.** Long transactions hold locks that block everyone else.
8. **Pick the right tool.** Postgres gets you far — but not everything is a relational problem.

## How to use references

| Reference | When to load |
|---|---|
| [`references/schema.md`](references/schema.md) | Normalization, keys, constraints, types, partitioning, soft vs. hard delete |
| [`references/indexing.md`](references/indexing.md) | B-tree, partial, expression, multi-column, GIN / GiST, covering indexes |
| [`references/queries.md`](references/queries.md) | JOINs, subqueries, CTEs, window functions, EXPLAIN |
| [`references/migrations.md`](references/migrations.md) | Zero-downtime migrations, rename columns, schema evolution, backfills |
| [`references/scaling.md`](references/scaling.md) | Replication, sharding, caching, pooling, partitioning |
| [`references/nosql.md`](references/nosql.md) | Document, key-value, time-series, graph — when each fits |

## Forbidden patterns (auto-reject)

- Tables without a primary key
- Foreign keys without a declared reference (rely-on-app-code pattern)
- `NULL` meaning two different things (e.g. "unknown" vs "not applicable")
- Storing JSON blobs as the primary way to represent structured data (use columns for what you query)
- `SELECT *` in production application code
- Indexes added without a query that uses them
- Destructive migrations without a tested rollback plan
- Running `ALTER TABLE` on a large table during peak hours without locking analysis
- Business logic in stored procedures that the code doesn't see
- `TIMESTAMP` without timezone where the app runs in multiple regions
- Money stored as `FLOAT` / `DOUBLE` — use `DECIMAL` / cents-as-integer
