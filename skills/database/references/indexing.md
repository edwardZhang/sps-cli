# Indexing

B-tree, partial, expression, multi-column, GIN/GiST, covering. Read `EXPLAIN`, don't guess.

## Why indexes matter

Without an index, the DB does a sequential scan — O(n) per query. With an index, it's O(log n). On a table of 50 million rows, that's the difference between 2 ms and 20 seconds.

The catch: indexes cost storage and slow writes. Every `INSERT` / `UPDATE` to an indexed column updates the index too. More indexes → more write amplification.

## Default: B-tree

The workhorse. Use for equality and range queries on ordered data.

```sql
CREATE INDEX ix_users_email ON users(email);

-- Helps:
SELECT * FROM users WHERE email = 'a@x.com';
SELECT * FROM users WHERE email BETWEEN 'a' AND 'c';
SELECT * FROM users ORDER BY email LIMIT 20;
```

## Multi-column indexes

Order matters. An index on `(a, b)` helps:

```sql
WHERE a = ? AND b = ?    -- yes
WHERE a = ?              -- yes (uses prefix)
WHERE b = ?              -- no (would need an index starting with b)
WHERE a = ? ORDER BY b   -- yes, range-limited
```

Rule: most-selective (highest-cardinality) column first, or the column used without the other.

Don't create `ix_a_b` AND `ix_a` AND `ix_a_b_c` — the broadest index already covers the narrower prefixes. Prune.

## Partial indexes

Index only the rows that matter for the hot query.

```sql
CREATE INDEX ix_orders_pending ON orders(created_at)
    WHERE status = 'pending';
```

Smaller index, faster. Ideal when the filtered subset is a small fraction of the table.

## Expression indexes

Index a computed value.

```sql
CREATE INDEX ix_users_email_lower ON users (LOWER(email));

-- Helps:
SELECT * FROM users WHERE LOWER(email) = 'a@x.com';
```

Useful for case-insensitive search, computed columns, JSON extraction:

```sql
CREATE INDEX ix_events_user ON events ((payload->>'user_id'));
```

## Covering / include columns

Include extra columns in the index so the DB doesn't need to visit the table.

```sql
CREATE INDEX ix_orders_user_created ON orders(user_id, created_at)
    INCLUDE (total_cents, status);

-- Index-only scan:
SELECT total_cents, status FROM orders
    WHERE user_id = ? ORDER BY created_at LIMIT 20;
```

The query is answered entirely from the index pages — big win on wide tables.

## Specialized indexes (Postgres examples; others vary)

| Type | Use |
|---|---|
| `GIN` | JSONB fields, arrays, full-text search |
| `GiST` | Ranges, geo, custom types |
| `BRIN` | Very large append-only tables (logs, time-series) |
| `Hash` | Equality on huge keys (Postgres 10+); B-tree usually wins |

Example — full text:

```sql
CREATE INDEX ix_articles_tsv ON articles
    USING GIN (to_tsvector('english', title || ' ' || body));
```

## When to add an index

Start with the query that's slow. Run `EXPLAIN (ANALYZE, BUFFERS)` on it.

```
Seq Scan on orders  (cost=0.00..25000.00 rows=1000 width=48)
  Filter: (status = 'pending')
  Rows Removed by Filter: 499000
```

`Seq Scan` on a filter that returned 1 / 500 rows is wasteful — add an index. After:

```
Index Scan using ix_orders_pending  (cost=0.42..8.44 rows=1)
```

Don't add indexes speculatively. Adding an index "in case someone queries by this" creates write cost for zero read benefit.

## When NOT to add an index

- Column is low-cardinality (`gender` with 3 values, `status` with 4 values on a 10-million table) — DB will prefer sequential scan. Exception: partial index on the rare value.
- Table is small (< ~10 000 rows). The optimizer picks seq scan anyway.
- Column is frequently updated and rarely queried. Write cost > read savings.
- Column is already covered by a broader index prefix.

## Check what's being used

Postgres:

```sql
SELECT indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC;
```

Indexes with `idx_scan = 0` for weeks are candidates for drop.

## Maintenance

- **Postgres**: `VACUUM ANALYZE` keeps statistics fresh. Autovacuum handles most cases; tune thresholds on write-heavy tables.
- **MySQL**: `ANALYZE TABLE` periodically.
- **Rebuilding** fragmented indexes: `REINDEX CONCURRENTLY` (Postgres 12+) — online rebuild.

## Index creation on live tables

Naive `CREATE INDEX` locks the table for writes. On a hot table, that stalls traffic.

```sql
-- ❌ on a hot table
CREATE INDEX ix_x ON big_table (y);

-- ✅
CREATE INDEX CONCURRENTLY ix_x ON big_table (y);
```

`CONCURRENTLY` (Postgres) doesn't block writes. Takes longer; retry on failure (partial indexes linger as `INVALID`).

MySQL 5.6+ supports online index creation for most storage engines; check the engine.

## JOIN indexes

For a query that joins `orders.user_id = users.id`, both sides need indexes on those columns. `users.id` is already the PK; `orders.user_id` needs its own index (declaring a FK does NOT auto-create the index in Postgres).

## ORDER BY + LIMIT

For paginated lists:

```sql
SELECT * FROM events
    WHERE tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 50;
```

Index: `(tenant_id, created_at DESC)`. With `LIMIT`, the DB reads from the index and stops at 50 — O(1) regardless of total rows.

## Covering index vs. cache

Sometimes the right answer is caching, not more indexes. If a query is inherently expensive (joins, aggregations), cache the result and invalidate on write. See `backend/references/caching.md`.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Index on every column "just in case" | Index for queries; drop unused |
| Single-column indexes where composite would serve | One good composite > three singles |
| Same leading column in many indexes | The broader index covers the narrower; prune |
| Function in WHERE without an expression index | Index the expression, or rewrite the query |
| `LIKE '%x%'` with hopes of index use | Only trailing wildcards use B-tree; use full-text for leading wildcard |
| Non-sargable queries: `WHERE DATE(col) = ?` | Use ranges: `col >= '2026-04-20' AND col < '2026-04-21'` |
| Indexing enum-like TEXT column with only 3 values on a hot write table | Partial index, or skip the index |
| Blocking `CREATE INDEX` on live prod | `CONCURRENTLY` / online |
| Forgetting to index foreign keys | Every FK column should be indexed for JOINs |
