# Queries

JOINs, subqueries, CTEs, window functions, EXPLAIN.

## Read the plan

`EXPLAIN (ANALYZE, BUFFERS)` shows what the DB actually did.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT u.email, count(*) AS n
FROM users u JOIN orders o ON o.user_id = u.id
WHERE u.active AND o.created_at > now() - interval '30 days'
GROUP BY u.email
HAVING count(*) > 5;
```

Red flags:
- `Seq Scan` on large tables where a filter expects few rows.
- Actual rows hugely diverge from the estimate (stats are stale → `ANALYZE`).
- `Hash Join` spilling to disk (`Disk: ...`).
- Nested Loop where Hash/Merge would be cheaper (low cardinality estimate misled the planner).

## Join types

| Join | Meaning |
|---|---|
| `INNER JOIN` | Rows where both sides match |
| `LEFT JOIN` | All left rows; NULLs for unmatched right |
| `RIGHT JOIN` | Rare; usually rewrite as LEFT with swapped sides |
| `FULL OUTER JOIN` | Both sides; NULLs where unmatched |
| `CROSS JOIN` | Cartesian product — use deliberately |
| `LATERAL` | Right side can reference left — per-row subquery |

## `EXISTS` vs. `IN` vs. `JOIN`

For "users who have at least one paid order":

```sql
-- ✅ Standard, optimizer handles well in modern DBs
SELECT u.* FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid');

-- Equivalent, often same plan
SELECT DISTINCT u.* FROM users u JOIN orders o ON o.user_id = u.id
WHERE o.status = 'paid';

-- Avoid — duplicates without DISTINCT; subtle
SELECT u.* FROM users u
WHERE u.id IN (SELECT o.user_id FROM orders o WHERE o.status = 'paid');
```

`EXISTS` is usually the clearest for "does any matching row exist". `JOIN + DISTINCT` can double-count on many-to-many relationships.

## CTEs (`WITH`)

Named subqueries for readability. In Postgres < 12, CTEs were optimization fences; 12+ inlines unless `MATERIALIZED` is specified.

```sql
WITH active_users AS (
    SELECT id FROM users WHERE active
),
recent_orders AS (
    SELECT user_id, sum(total_cents) AS total
    FROM orders
    WHERE created_at > now() - interval '30 days'
    GROUP BY user_id
)
SELECT u.id, r.total
FROM active_users u
JOIN recent_orders r ON r.user_id = u.id;
```

Recursive CTEs for trees:

```sql
WITH RECURSIVE subordinates AS (
    SELECT id, manager_id, 0 AS depth FROM employees WHERE id = ?
    UNION ALL
    SELECT e.id, e.manager_id, s.depth + 1
    FROM employees e JOIN subordinates s ON e.manager_id = s.id
)
SELECT * FROM subordinates;
```

## Window functions

Computations over rows without collapsing them.

```sql
-- Rank orders by total within each user
SELECT user_id, id, total_cents,
       row_number() OVER (PARTITION BY user_id ORDER BY total_cents DESC) AS rn
FROM orders;

-- Running total
SELECT created_at, total_cents,
       sum(total_cents) OVER (ORDER BY created_at) AS running_total
FROM orders;

-- Day-over-day
SELECT day, revenue,
       revenue - lag(revenue) OVER (ORDER BY day) AS delta
FROM daily_revenue;
```

Often replaces a self-join or a complex subquery.

## Aggregations

```sql
-- Count
SELECT count(*) FROM orders;            -- counts rows
SELECT count(email) FROM users;         -- counts non-NULL emails
SELECT count(DISTINCT user_id) FROM orders;

-- Conditional aggregates
SELECT
    count(*) FILTER (WHERE status = 'paid') AS paid,
    count(*) FILTER (WHERE status = 'pending') AS pending
FROM orders;

-- Array / string aggregation
SELECT user_id, string_agg(tag, ',' ORDER BY tag) FROM user_tags GROUP BY user_id;
SELECT user_id, array_agg(tag) FROM user_tags GROUP BY user_id;
```

`FILTER` is cleaner than `CASE WHEN ... ELSE NULL END` in an aggregate.

## Upsert

Insert-or-update in one statement, atomically.

```sql
-- Postgres
INSERT INTO users (id, email, name)
VALUES (?, ?, ?)
ON CONFLICT (email) DO UPDATE
SET name = EXCLUDED.name, updated_at = now();

-- MySQL
INSERT INTO users (id, email, name)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE
    name = VALUES(name), updated_at = now();
```

Don't SELECT-then-INSERT-or-UPDATE in app code. Race condition → duplicate rows.

## Batch operations

Process many rows in one statement.

```sql
-- Bulk insert with VALUES
INSERT INTO events (id, payload) VALUES (?, ?), (?, ?), (?, ?), ...;

-- Bulk delete with IN
DELETE FROM stale_events WHERE id IN (?, ?, ?);

-- Update with CTE + JOIN
WITH bad_ids AS (SELECT id FROM events WHERE created_at < now() - interval '1 year')
DELETE FROM events USING bad_ids WHERE events.id = bad_ids.id;
```

## Pagination — keyset over offset

```sql
-- ❌ Slow on page 1000
SELECT * FROM events ORDER BY id LIMIT 50 OFFSET 50000;

-- ✅ Keyset pagination
SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 50;
```

Offset pagination's cost grows with offset. Keyset is O(log n) regardless.

For reverse / filtered queries, the cursor is a tuple: `(created_at, id)`.

```sql
SELECT * FROM events
WHERE (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

## `LIMIT` with `ORDER BY`

Always use `ORDER BY` when using `LIMIT`. Without it, the order is undefined — results can change between runs even on the same data.

## Avoid SELECT *

```sql
-- ❌ Sends every column over the wire; brittle when schema evolves
SELECT * FROM users WHERE id = ?;

-- ✅
SELECT id, email, active FROM users WHERE id = ?;
```

Explicit column lists:
- Ship less bandwidth.
- Enable covering indexes.
- Don't break when a column is added / renamed.

## Locking

Explicit locks for concurrency control:

```sql
-- Read the row, block concurrent writers
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
-- decide, modify
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

`FOR UPDATE SKIP LOCKED` — for job-queue workers to take different rows:

```sql
SELECT * FROM jobs WHERE status = 'ready'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

Advisory locks for non-row locking (Postgres):

```sql
SELECT pg_try_advisory_xact_lock(hashtext('reindex-job'));
```

Great for cross-process leader election / run-once jobs.

## Avoid N+1 at SQL level

```sql
-- ❌ In app code:
for order in orders:
    user = SELECT * FROM users WHERE id = order.user_id
-- N+1 queries

-- ✅ Single JOIN
SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id;

-- ✅ Or a single IN:
SELECT * FROM users WHERE id IN (?, ?, ?, ...);
```

## NULL semantics — three-valued logic

`NULL = NULL` is `UNKNOWN`, not `TRUE`. Catches people out:

```sql
SELECT * FROM users WHERE email = 'a@x.com' OR email != 'a@x.com';
-- Rows where email IS NULL are NOT returned (NULL doesn't match either)

-- To include NULL:
WHERE email = 'a@x.com' OR email IS NULL
```

Use `COALESCE(x, default)` when comparing nullable columns.

## String / date functions — DB-specific

Every engine has its own. Postgres examples:

```sql
date_trunc('day', created_at)               -- 2026-04-20 00:00:00
extract(epoch from (end_at - start_at))     -- seconds between
now() - interval '1 day'                     -- 24h ago
age(now(), created_at)                       -- human-friendly interval

lower(email), upper(email), length(text), substring(text, 1, 10)
split_part('a,b,c', ',', 2)                  -- 'b'
regexp_replace(s, '[0-9]+', '#', 'g')
```

Check the manual before inventing portable helpers.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `SELECT *` in app code | Name the columns |
| Queries built by string-concatenating user input | Parameterize |
| Offset pagination on large tables | Keyset |
| `WHERE function(col) = ?` without expression index | Rewrite or index |
| N+1 queries in app code | JOIN / IN / batch |
| Multiple round-trips where one query suffices | CTE / subquery |
| Guessing with ORDER BY RANDOM() on big tables | Pre-shuffle, reservoir sample, or `TABLESAMPLE` |
| SELECT-then-INSERT for upsert | Native `ON CONFLICT` / `MERGE` |
| Long transactions reading large data | Split, or use a cursor / pagination |
| `LIKE '%x%'` on a big table | Full-text index |
