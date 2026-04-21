# Data Access

Transactions, queries, migrations, connection pooling. Language-neutral patterns.

## N+1 queries — the universal killer

The single most common backend performance bug.

```
# ❌ N+1
orders = orderRepo.findAll()              # 1 query
for order in orders:
    order.user = userRepo.find(order.userId)   # N queries

# ✅ Batch fetch
orders = orderRepo.findAll()
userIds = unique(o.userId for o in orders)
users = userRepo.findByIds(userIds)        # 1 query
userMap = { u.id: u for u in users }
for o in orders:
    o.user = userMap[o.userId]

# ✅ Join (if the ORM supports eager loading)
orders = orderRepo.findAll(include=['user'])
```

Detect early: log every query in test mode; assert query count on hot paths.

## Select only what you need

Wide `SELECT *` costs bandwidth, memory, and breaks when the schema changes.

```
# ❌
SELECT * FROM users WHERE active = true

# ✅
SELECT id, email, name FROM users WHERE active = true
```

## Indexes

An index is a write-time tax for a read-time refund. Worth it on columns used in WHERE, JOIN, ORDER BY of hot queries.

```
# Common first indexes
CREATE INDEX idx_orders_user_id     ON orders(user_id);
CREATE INDEX idx_orders_status      ON orders(status) WHERE status = 'pending';  -- partial
CREATE INDEX idx_users_email_lower  ON users (LOWER(email));                      -- expression
```

Rules:
- Read the query plan. Don't guess.
- Composite index order matters: `(user_id, created_at)` helps `WHERE user_id = ? ORDER BY created_at`, not the reverse.
- Every index slows writes. More indexes ≠ faster system.

## Transactions

One business operation = one transaction. Cross the boundary at the use case, not inside a repository.

```
unitOfWork.begin()
try:
    order = orderRepo.save(newOrder)
    inventoryRepo.decrement(order.items)
    eventBus.publish(OrderPlaced(order.id))
    unitOfWork.commit()
except:
    unitOfWork.rollback()
    raise
```

Isolation levels:
- **READ COMMITTED**: default on most DBs, fine for most workloads
- **REPEATABLE READ**: if you read the same row twice within a transaction and want consistency
- **SERIALIZABLE**: correctness over throughput; expect retries

Keep transactions short. Long-running transactions hold locks and block everyone.

## Connection pooling

Every real backend uses a pool, not per-request connections. DBs limit max connections (Postgres default ~100); without pooling, a traffic spike exhausts the DB.

| Pool param | Starting value | Notes |
|---|---|---|
| min idle | 2–5 | Warm connections for low traffic |
| max size | (DB max ÷ replicas) − safety margin | e.g., 100 ÷ 4 = 25 per instance, then leave room |
| connection timeout | 2–5 s | Fail fast if pool is saturated |
| idle timeout | 30 s – 5 min | Recycle stale connections |
| max lifetime | 30 min | Force re-resolve DNS, rotate creds |

Serverless + traditional DB: use a pooler (PgBouncer, RDS Proxy) — each cold lambda can't open its own pool.

## Read replicas

Route reads to replicas, writes to primary. Beware of replication lag:

```
user.save(newEmail)            # primary
user = user.reload()           # replica — may still show old email
```

Common fix: stick to primary for N seconds after a write, or read-your-writes from primary only.

## Migrations

Every schema change is a migration file, checked in, applied in CI/CD, reversible where possible.

Rules:
- **Never edit a merged migration.** Write a new one.
- **Additive first, destructive later.** Add the new column → backfill → switch code → drop the old column (separate deploys).
- **Index creation on a hot table**: use `CREATE INDEX CONCURRENTLY` (Postgres) so you don't lock the table.
- **Default values**: adding a `NOT NULL` column with a default on a big table can rewrite the whole table. In Postgres 11+, adding `DEFAULT` is metadata-only; in older DBs, do `ADD NULLABLE → backfill → SET NOT NULL`.

## Soft deletes

Don't add `deleted_at` everywhere by default. It creates a silent contract that every query must filter. Use it when:
- You genuinely need to recover records, and
- You accept the cognitive tax on every query.

Prefer hard deletes + an `audit_log` / `events` table if you only need history.

## Bulk operations

One round-trip per row kills throughput. Use batch APIs.

```
# ❌
for row in 10_000_rows:
    db.insert(row)

# ✅
db.bulk_insert(10_000_rows)            # one statement
# or
db.copy_from(csv_buffer)               # Postgres COPY, fastest
```

On upserts, use the DB's native construct (`INSERT ... ON CONFLICT`, `MERGE`, `INSERT ... ON DUPLICATE KEY UPDATE`), not read-then-update in app code.

## Pagination queries

Offset pagination gets slow on large tables because the DB still walks the skipped rows.

```
# ❌ Slow on page 10 000
SELECT * FROM events ORDER BY id LIMIT 50 OFFSET 500000

# ✅ Keyset / cursor
SELECT * FROM events WHERE id > :last_id ORDER BY id LIMIT 50
```

Keyset pagination is O(log n); offset is O(offset + limit).

## NoSQL quick notes

- **Key-value (Redis, DynamoDB)**: design the key; scan queries are evil.
- **Document (Mongo)**: embed what you always read together; reference what you sometimes read separately.
- **Wide column (Cassandra, Bigtable)**: query patterns decide the schema, not the other way around.
- **Graph (Neo4j)**: use when the traversal depth would be painful in SQL.

Rule: pick the store that matches the access pattern. Don't use Mongo because "it's flexible"; flexibility defers modeling pain, it doesn't erase it.

## Anti-patterns

| Anti-pattern | Why bad | Fix |
|---|---|---|
| Queries in a loop | N+1; one slow endpoint tanks the DB | Batch / join / cache |
| No timeout on DB calls | A single slow query hangs threads / pool | Set statement timeout |
| `SELECT *` in hot code | Brittle, wasteful | List columns |
| Business logic in stored procedures "for speed" | Hard to test, version, review | Keep logic in code; use SQL for set operations |
| Multiple orthogonal indexes on the same table | Slow writes, bloated storage | Review `pg_stat_user_indexes`; drop unused |
| Editing an applied migration | Divergent envs | New migration |
| Schema changes without a rollback plan | Stuck deploys | Reversible migrations or documented forward-only fix |
