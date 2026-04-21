# Schema

Normalization, keys, constraints, types.

## Start normalized

3rd Normal Form (3NF) is the sweet spot for most OLTP apps:
- Each table represents one concept.
- Every non-key column depends on the key, the whole key, and nothing but the key.
- No repeating groups (prefer child tables over `phone1 / phone2 / phone3`).

Denormalize later, with measurement, for reporting / read-heavy paths. Denormalized by default breeds data-consistency bugs.

## Primary keys

Every table has one. Options:

| Type | Pros | Cons |
|---|---|---|
| Auto-increment integer | Compact, fast, ordered | Leaks count; awkward in distributed systems |
| UUID v4 | Globally unique, generated anywhere | 16 bytes, random → index fragmentation |
| UUID v7 / ULID / KSUID | Time-ordered, unique, generated anywhere | Slightly newer; check lib support |
| Composite key | Natural uniqueness (e.g., `(order_id, line_no)`) | Join and FK complexity |

Recommendation: **UUID v7 / ULID** for new systems. Still sortable by time, no central generator needed, no count leakage. Store as `UUID` (Postgres) or `BINARY(16)` (MySQL) — don't use `VARCHAR(36)` (3× the storage).

## Foreign keys

Declare them:

```sql
CREATE TABLE orders (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`ON DELETE`:
- `RESTRICT` / `NO ACTION` — safe default; forces explicit cleanup.
- `CASCADE` — dangerous; one delete can wipe large subgraphs. Use carefully.
- `SET NULL` — when the relationship is optional.

Don't skip FKs "for performance". The integrity guarantee is worth a lot more than the microseconds.

## Constraints over application logic

Let the DB enforce invariants that must always hold.

```sql
-- Invariants
email      TEXT     NOT NULL UNIQUE,
age        INT      CHECK (age >= 0 AND age <= 150),
status     TEXT     NOT NULL CHECK (status IN ('pending','active','banned')),
balance    NUMERIC  NOT NULL CHECK (balance >= 0),

-- Uniqueness across multiple columns
CONSTRAINT uq_org_email UNIQUE (org_id, email)
```

Application validation is belt; DB constraints are suspenders. You want both.

## Column types

### Text

- `TEXT` in Postgres — no length limit, same storage as `VARCHAR`.
- `VARCHAR(n)` when the limit is a real business rule (e.g., phone max 20). `VARCHAR(255)` by habit is noise.
- `CHAR(n)` — almost never the right answer (pads with spaces).

### Numbers

- Integers: `INTEGER` (32-bit) or `BIGINT` (64-bit). Pick based on range.
- **Money**: `NUMERIC(12, 2)` or **cents as integer** — never `FLOAT` / `DOUBLE` (binary floats lose pennies).
- `REAL` / `DOUBLE PRECISION` only for scientific / measurement data where precision loss is OK.

### Time

- `TIMESTAMPTZ` (Postgres with timezone) or UTC `TIMESTAMP` — always store in UTC. Convert in the app.
- `DATE` for dates without time-of-day.
- Never store time as `TEXT` or milliseconds-since-epoch as `BIGINT` unless you genuinely need it for external APIs.

### Boolean

- `BOOLEAN` where supported.
- MySQL older versions: `TINYINT(1)` as a workaround.

### Enum-like

Three options:

| Approach | Pros | Cons |
|---|---|---|
| Native ENUM (Postgres, MySQL) | Type-checked at DB level | Hard to add values without ALTER |
| CHECK constraint with string | Easy to extend | String fragility |
| Lookup table + FK | Flexible, self-documenting | Join on common queries |

For small fixed sets (status = active / pending / banned), CHECK on a TEXT column is the pragmatic default.

### JSON

- `JSONB` (Postgres) — indexable, queryable.
- Use for schemaless attributes, user-defined fields, optional metadata.
- **Don't** use as the primary way to represent structured data. If you're going to query `raw->>'email'` everywhere, promote `email` to a column.

## Naming

Pick a convention, stay consistent.

- **Tables**: plural (`users`, `orders`) or singular (`user`, `order`). Most teams pick plural.
- **Columns**: `snake_case`. Match the language's ORM convention.
- **Primary key**: `id`.
- **Foreign keys**: `<table_singular>_id`. `user_id` references `users.id`.
- **Timestamps**: `created_at`, `updated_at`, `deleted_at`.
- **Booleans**: `is_active`, `has_verified_email`.
- **Indexes**: `ix_<table>_<columns>`. Unique: `uq_<table>_<columns>`.

## Timestamps on every table

```sql
created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

`updated_at` via trigger OR app responsibility. Auditing, debugging, backfills — all need these.

## Soft delete vs. hard delete

Default: **hard delete**. Reclaims space, simplifies queries, respects privacy requests.

Soft delete (`deleted_at TIMESTAMP NULL`) when:
- You need a recovery window.
- Historical referencing matters (keep the row for audit but hide from listings).

Trade-off: every query now filters `WHERE deleted_at IS NULL`. Forgetting is a bug class. Consider a `users_active` view for day-to-day use.

If you need audit history, an `events` / `audit_log` table is usually cleaner than soft-delete everywhere.

## Partitioning

For very large tables (hundreds of millions of rows), partition by time, tenant, or region. Postgres declarative partitioning:

```sql
CREATE TABLE events (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    payload JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_04 PARTITION OF events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
```

Benefits: small indexes per partition, easy to drop old data (`DROP PARTITION`), parallel queries.

Don't partition speculatively. The operational overhead is real.

## Multi-tenancy

Three shapes:

| Shape | Pros | Cons |
|---|---|---|
| Separate DBs per tenant | Full isolation, easy backup per tenant | Operational overhead at scale |
| Shared DB, separate schemas | Middle ground | Connection per schema can be clunky |
| Shared DB, shared schema + tenant_id column | Simplest, scales to many tenants | Every query MUST filter tenant_id |

Shared schema + `tenant_id`: enforce via row-level security (Postgres RLS) if available, or framework middleware that injects the filter. Forgetting is a catastrophic data leak.

## Referential design patterns

- **Associations**: join table `order_items (order_id, line_no, product_id, qty, price_cents)` with composite PK.
- **Hierarchies**: `parent_id` + recursive CTE, or `ltree` (Postgres), or nested sets (read-heavy).
- **Tags / many-to-many**: `post_tags (post_id, tag_id)`.
- **Audit**: separate `audit_logs` table with immutable rows.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Primary key = `VARCHAR(36)` UUID | Use native `UUID` / `BINARY(16)` |
| `VARCHAR(255)` reflex | Use `TEXT` or a justified length |
| One table "users_and_admins" with a role column and many nullable fields | Normalize or use type-specific tables |
| Store JSON with the same shape in every row | Promote to columns |
| Mutable history columns (`last_email_change_at`) spread across user table | Consider an audit log |
| Money as `FLOAT` | Never |
| `bool` stored as `Y/N` strings | Native `BOOLEAN` |
| Different timestamps in different timezones | UTC everywhere |
| `NULL` for "unknown" AND "not applicable" | Two different columns, or a CHECK'd enum |
| Massive tables with no partitioning plan | Partition or archive when they get big |
