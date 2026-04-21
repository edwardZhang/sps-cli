# Scaling

Replication, read replicas, sharding, partitioning, pooling.

## Scale vertical before horizontal

A single Postgres / MySQL instance on modern hardware handles a LOT:
- Postgres on a large machine: tens of thousands of QPS, terabytes of data.
- Most teams that "need" sharding actually have a missing index.

Scaling checklist before scaling out:
1. Are queries using indexes? (EXPLAIN)
2. Is the instance CPU- or I/O-bound? (top / iostat)
3. Connection pool configured? (see below)
4. Any long-held locks / long transactions?
5. Table bloat? (Postgres VACUUM health)

## Read replicas

Streaming replication (Postgres, MySQL) sends WAL / binlog to followers. Route reads to replicas, writes to primary.

```
app ──writes──▶ primary
  ──reads──▶ replica 1, replica 2, ...
```

Benefits:
- Horizontal read scaling.
- Failover target.
- Analytics offload.

Gotchas:
- **Replication lag**. Milliseconds usually, seconds under load. Reads immediately after a write may see stale data.
- **Read-your-writes**: route the current user's reads to primary for N seconds after they write, or always read from primary for critical paths.

## Connection pooling

Every real backend uses a pool. DBs limit max connections (Postgres default ~100); without pooling, a traffic spike hits the ceiling.

Pool parameters:

| Parameter | Starting value |
|---|---|
| min idle | 2–5 |
| max size | (DB max ÷ app replicas) − safety margin |
| connect timeout | 2–5 s |
| idle timeout | 30 s – 5 min |
| max lifetime | 30 min |

Serverless + traditional DB: use a pooler (PgBouncer, RDS Proxy, Supabase Pooler, Hyperdrive) — each cold lambda can't open its own pool.

PgBouncer modes:
- **Session pooling** — safest, but holds one backend connection per client session.
- **Transaction pooling** — best efficiency; some features (session-level variables, prepared statements in certain drivers) don't work.
- **Statement pooling** — rare; most strict restrictions.

## Partitioning

Split a large table into pieces based on a key (time, tenant, region). Each partition is its own physical table.

```sql
CREATE TABLE events (
    id UUID, tenant_id UUID, created_at TIMESTAMPTZ, payload JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_04 PARTITION OF events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
```

Benefits:
- Queries with `WHERE created_at BETWEEN ...` scan only the relevant partitions.
- Drop old data via `DROP PARTITION` (no delete scan, no VACUUM).
- Smaller indexes per partition.

Costs:
- Schema evolution is more work.
- Queries that don't include the partition key scan all partitions.
- Some ORMs / tools handle partitioning poorly.

Partition when:
- A single table is approaching 100M+ rows and queries typically touch a subset.
- You need to age out old data regularly.
- Insert rate is pushing one partition's size limits.

## Sharding

Distribute a dataset across multiple databases by a shard key.

```
tenant_id % N → which shard holds this tenant's data
```

Each shard is a self-contained DB. Cross-shard queries require the app to fan out and merge.

Before sharding, try:
- Vertical scale + read replicas.
- Partitioning.
- Service-level split (separate the auth DB from the orders DB).

When sharding is justified:
- Write throughput > what one instance can take.
- Data size > one instance's disk.
- Strong per-tenant isolation required.

Hard parts:
- **Cross-shard joins**: don't. Or use a small read replica that aggregates.
- **Cross-shard transactions**: don't. Use eventual consistency patterns.
- **Rebalancing**: moving data between shards is painful; pick a shard key that rarely grows imbalanced.

Managed services (Vitess, Citus, Spanner, CockroachDB, Yugabyte) do a lot of this for you. Self-building a sharding layer is a project unto itself.

## Caching layer

Offload read traffic from the DB.

| Layer | Cost | Gain |
|---|---|---|
| In-process cache | Free | Limited to pod memory |
| Redis / Memcached | Ops + infra | Cross-pod shared |
| CDN / HTTP cache | Free on public GETs | Offloads to edge |

Cache-aside is the default pattern. See `backend/references/caching.md`.

Guardrail: a cache layer is another thing to monitor. Measure its hit rate — a low hit rate means you're paying the complexity without the benefit.

## Write amplification

Every index is a write tax. A row written to a table with 5 indexes is actually 6 writes. Review indexes periodically:

```sql
-- Postgres: unused indexes in recent weeks
SELECT relname, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND indexrelname NOT LIKE 'pg_%'
ORDER BY pg_relation_size(indexrelid) DESC;
```

Drop what isn't used.

## Hot rows

A single row updated by many clients (a counter, a shared config, a leaderboard entry) becomes a contention point.

Mitigations:
- **Increment via atomic SQL**: `UPDATE stats SET count = count + 1 WHERE id = ?`.
- **Shard the counter**: N sub-counters, summed when read.
- **Move to a cache**: increment in Redis, flush periodically.
- **Denormalize**: pre-aggregate at write time into a stream that downstream consumers read.

## Archival

Active data and historical data usually have different access patterns. Move old data out of the hot path.

- **Partition by time** and drop old partitions.
- **Archive to a data warehouse** (Snowflake, BigQuery, Redshift, ClickHouse) for analytics.
- **Cold storage** (S3 + Athena / Parquet) for years-old data accessed rarely.

Keeps the hot DB small, fast, cheap.

## Replication topologies

- **Single primary, multiple replicas** — read scaling, simple.
- **Cascading replication** — replica of a replica, for geographic distribution.
- **Logical replication** (Postgres) — table-level; supports zero-downtime upgrades and data migration between major versions.
- **Multi-primary** — rare, complex, use managed services (Spanner, CockroachDB) that built for it.

Be skeptical of "multi-master" in traditional engines. Conflict resolution is user-facing work.

## Backups

- **Automated daily backups + point-in-time recovery** (PITR). Not optional.
- **Test restore** quarterly. A backup you've never restored is a hope, not a backup.
- **Off-region storage** for disaster recovery.
- **Encryption at rest**.

Many incidents are resolved by restoring a table / row from a backup. Make sure that's possible without a day of pain.

## Monitoring — the must-haves

- **Connection count** vs. max.
- **Replication lag** per replica.
- **Query p95 / p99 latency**.
- **Slow query log** (threshold: 500 ms+).
- **Lock waits and deadlocks**.
- **Cache hit ratio** (Postgres `pg_statio_*`, MySQL InnoDB buffer pool).
- **Disk space** and growth rate.
- **Autovacuum / maintenance activity** (Postgres).

Dashboards + alerts on all of the above.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Sharding before trying indexes / replicas / partitioning | Exhaust simpler options first |
| One connection per request without a pool | Use a pool; use a pooler for serverless |
| Read from a replica for "write-then-read" flows | Read from primary for stickiness window |
| No automated backups | Set up PITR yesterday |
| 50 indexes on a write-heavy table | Prune; serve reports from a replica / warehouse |
| Ignoring replication lag in the app | Observe and degrade |
| Cross-shard queries in the app | Architect around the shard key |
| Running the DB on the same host as the app | One process's CPU spike kills the DB |
| Unrestricted `pg_dump` over the wire during business hours | Replicate to a snapshot host and dump there |
