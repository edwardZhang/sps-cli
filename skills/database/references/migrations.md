# Migrations

Zero-downtime changes. Every migration survives prod traffic.

## Rules

1. **Every schema change is a migration file.** Checked in, versioned, applied in CI/CD.
2. **Never edit a merged migration.** Write a new one.
3. **Additive first, destructive later.** Add → backfill → switch → remove.
4. **Test against production-scale data.** Time on staging ≠ time on prod.
5. **Every migration has a rollback story.** Either a reverse migration or a forward-only fix plan.

## Migration tools

| Tool | Works with |
|---|---|
| Flyway, Liquibase | Java / any SQL |
| Django migrations | Django |
| Alembic | Python / SQLAlchemy |
| Rails migrations | Rails |
| Prisma migrate | Node / TypeScript |
| Goose, Atlas | Go / any |
| Sqitch | Standalone, VCS-driven |
| Raw SQL + shell | Simple, works everywhere |

Pick one per project; don't mix. All of them do the same core thing: apply ordered SQL files once, track what's applied in a meta table.

## Additive vs. destructive

| Additive (safe) | Destructive (careful) |
|---|---|
| `CREATE TABLE` | `DROP TABLE` |
| `ADD COLUMN ... NULL` | `DROP COLUMN` |
| `CREATE INDEX CONCURRENTLY` | `ALTER COLUMN ... TYPE` (if rewrites table) |
| New `CHECK` (not validated yet) | `ALTER COLUMN ... NOT NULL` on a non-null column existing data |
| New FK (not validated yet) | Renames |

Pure additive migrations are (almost) always safe. Destructive ones need a phased plan.

## The expand / contract pattern

```
t0: schema A       app code A
t1: schema A + B   app code A        (expand: new schema coexists)
t2: schema A + B   app code B        (switch: app uses B)
t3: schema B       app code B        (contract: old schema removed)
```

Each step deployable independently. Rollback = go back one step.

### Example: rename a column

Don't just `ALTER TABLE users RENAME COLUMN email_address TO email`. Code that's still running reads from `email_address` and crashes.

```
Deploy 1: ADD COLUMN email TEXT;                    -- expand
Deploy 2: backfill: UPDATE users SET email = email_address WHERE email IS NULL;
Deploy 3: app reads/writes BOTH email and email_address (dual-write).
Deploy 4: app reads/writes email only.
Deploy 5: DROP COLUMN email_address;                 -- contract
```

Tedious but survives any restart sequence.

### Example: adding a NOT NULL column

```
Deploy 1: ADD COLUMN role TEXT DEFAULT 'user';       -- default avoids rewrite in Postgres 11+
Deploy 2: app writes role on all new rows.
Deploy 3: backfill rows with NULL role.
Deploy 4: ALTER COLUMN role SET NOT NULL.
Deploy 5: (optional) DROP DEFAULT if you don't want it anymore.
```

Don't do `ADD COLUMN NOT NULL DEFAULT ...` on a huge table in old DB versions — it rewrites the whole table.

## Index creation on live tables

```sql
-- ❌ locks the table
CREATE INDEX ix_users_email ON users(email);

-- ✅ online
CREATE INDEX CONCURRENTLY ix_users_email ON users(email);
```

`CONCURRENTLY` runs in its own transaction (no DDL bundled). Migration frameworks that wrap every migration in a transaction will reject this — check whether your tool supports "non-transactional migrations".

## Backfills

For large tables, don't backfill in one statement. Batch:

```sql
UPDATE users SET role = 'user'
WHERE id IN (
    SELECT id FROM users
    WHERE role IS NULL
    ORDER BY id
    LIMIT 10000
);
```

Loop until no rows updated. Sleep between batches to give replicas time to catch up.

Script it outside the migration framework so a slow backfill doesn't block a deploy. The schema change goes through the migration file; the backfill is a job.

## Rename a table

Similar expand/contract:

```
Deploy 1: CREATE TABLE new_name (... same schema ...);
Deploy 2: app writes to both (dual-write); or create a view / sync trigger.
Deploy 3: backfill historical rows.
Deploy 4: app reads/writes new_name only.
Deploy 5: DROP TABLE old_name.
```

Most teams avoid this unless strictly necessary.

## Change a column type

If the new type is a strict widening (`INT` → `BIGINT` in some DBs, `VARCHAR(50)` → `VARCHAR(100)`), the change is cheap and online.

If it rewrites (`TEXT` → `INT` with a cast), treat as destructive + expand/contract.

```
ALTER TABLE users ALTER COLUMN x TYPE BIGINT USING x::BIGINT;
-- Rewrites the column; blocks writes. On a big table, that hurts.
```

Alternative: add new column, backfill, switch app, drop old.

## Dropping columns / tables

1. App stops reading the column (deploy).
2. App stops writing the column (deploy).
3. Migration drops it.

Skipping 1 and 2 causes crashes when old app instances hit the dropped column during a rolling deploy.

## Migration performance

```sql
-- Before running in prod
EXPLAIN ANALYZE <the migration statement>
```

Or time it on a copy of prod. A migration that takes an hour of lock time is a migration that breaks the site.

Rule of thumb for Postgres:
- `CREATE TABLE`: instant.
- `ADD COLUMN` nullable (11+): instant (metadata only).
- `ADD COLUMN NOT NULL DEFAULT` (11+): instant.
- `ALTER COLUMN ... TYPE` that rewrites: `O(rows)`, blocks writes.
- `CREATE INDEX CONCURRENTLY`: online, takes time.
- Adding FK constraint `VALIDATED`: scans the full table. Create `NOT VALID` then `VALIDATE CONSTRAINT` to split the pain.

## Transactional DDL

Postgres wraps DDL in transactions. If something fails mid-way, the migration rolls back cleanly. Mix DDL + data: keep it short; long DDL transactions hold locks.

MySQL pre-8 didn't support transactional DDL — failed migrations left partial state. Recovery is manual.

## Rollback plans

Before deploying, write down:
- What's the rollback command?
- What if the migration has already partly run?
- What if the backfill ran but the schema change failed?

For irreversible migrations (dropping a column), rollback = restore from backup + re-apply changes after. State that explicitly; don't pretend it's reversible.

## Feature flags + schema

For risky schema changes, gate the new code path behind a flag:

```
if feature('new_schema_path'):
    use new table
else:
    use old table
```

Flip at will, revert instantly without a migration. Pair with expand/contract for best results.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Editing an applied migration | New migration |
| Dropping a column in the same deploy as code stops using it | Stage deploys |
| `ALTER TABLE ADD COLUMN NOT NULL DEFAULT 'x'` on a 100M-row table (old Postgres) | Split: ADD nullable → backfill → SET NOT NULL |
| No rollback plan | Document; even "forward-only" needs a plan |
| Running backfill in a single statement on a huge table | Batch + pause |
| Putting `CREATE INDEX` inside a long transaction | Use `CONCURRENTLY`, separate transaction |
| Dropping FKs "for performance" during a backfill | Disable constraints for the migration window deliberately |
| Untested migrations on prod-like data | Run against a snapshot before production |
| Migrations that depend on app code behaviour | Keep migrations self-contained in SQL |
