# NoSQL

Document, key-value, time-series, graph — when each fits.

## Picking the right engine

```
Pick by access pattern, not by popularity.
```

| Engine | Shape | Good for |
|---|---|---|
| **Postgres / MySQL** | Relational + JSON | Almost everything; strong default |
| **MongoDB / Couchbase** | Document | Shape varies per record; embed-heavy reads |
| **DynamoDB / Cassandra** | Key-value / wide column | Massive scale; predictable access patterns |
| **Redis** | Key-value (in-memory) | Cache, leaderboard, session, pub-sub |
| **ClickHouse / BigQuery / Redshift** | Columnar / OLAP | Analytics; big scans; aggregations |
| **TimescaleDB / InfluxDB** | Time-series | Metrics, events, sensor data |
| **Neo4j / DGraph** | Graph | Traversals (relationships matter more than rows) |
| **Elasticsearch / OpenSearch** | Inverted index | Full text, log search |

Rule: start with Postgres. Add a specialized store **when the access pattern justifies operational cost**. A lonely Elasticsearch cluster is a bug farm.

## Document stores (MongoDB, Couchbase)

Store JSON-ish documents. No joins; embed or reference.

```json
{
  "_id": "u_01H...",
  "email": "a@x.com",
  "orders": [
    { "id": "ord_01H...", "items": [...], "total_cents": 2599 }
  ]
}
```

### Embed vs. reference

- **Embed** what you always read together and that doesn't grow unboundedly.
- **Reference** what's read separately or grows.

Rules:
- One-to-few (user ↔ addresses) → embed.
- One-to-many (user ↔ orders, bounded) → embed with a soft limit.
- One-to-many unbounded (user ↔ events, could be millions) → reference.
- Many-to-many → reference on both sides.

### Indexes

Every MongoDB query benefits from an index; without, it scans the collection. Index on the field you query, and compound on `(filter, sort)`.

### Schema is still a thing

Schemaless doesn't mean unschematic. Use a library (Zod, Joi, Pydantic, Mongoose) to define the shape in code and validate at write time. Otherwise two weeks later you have five variants of the same "user" shape.

### Transactions

Modern MongoDB supports multi-document transactions. Use them when you need them; don't hand-roll two-phase commits in app code.

## Key-value (DynamoDB, Cassandra)

Scale: massive. Flexibility: low.

Access patterns **must** be known at design time. You design the key to match the queries, not the other way around.

### Single-table design (DynamoDB)

```
pk          sk              attrs
USER#u1     PROFILE         { name, email }
USER#u1     ORDER#o1        { total, status }
USER#u1     ORDER#o2        { total, status }
ORDER#o1    META            { user_id, items }
```

One table, careful composite keys. Supports:
- Get user profile: PK=USER#u1, SK=PROFILE
- List user orders: PK=USER#u1, SK begins_with ORDER#
- Get order: PK=ORDER#o1

Queries that don't fit the key structure need a global secondary index (expensive) or an adapter (client-side fan-out).

If access patterns aren't stable, use Postgres.

### Eventual consistency

Most KV stores offer strong consistency on single-key ops and eventual on cross-key. Design around it:
- Read-your-writes: query the primary (DynamoDB: `ConsistentRead=true`).
- Listing results may lag recent writes briefly.

## Redis

Primarily in-memory; data structures (strings, lists, sets, sorted sets, hashes, streams, geo).

### Patterns

- **Cache-aside** — most common.
- **Session store** — cookie → Redis key → session blob.
- **Rate limiter** — `INCR` with TTL on window keys.
- **Leaderboard** — sorted set (`ZADD` / `ZREVRANGE`).
- **Job queue** — lists (`LPUSH` / `BRPOP`) or Streams (better for ack-and-retry).
- **Pub/sub** — fan out events to subscribers.
- **Distributed lock** — Redlock or `SET NX PX`.

### Persistence

- **RDB** snapshots: point-in-time, fast recovery, up to minutes of data loss.
- **AOF** append-only log: near-zero loss, slower restart.
- **AOF + RDB** together: recommended.

Even "in-memory" Redis should have persistence. Otherwise a restart vacuums state.

### Memory limits

Set `maxmemory` + eviction policy (`allkeys-lru`, `volatile-ttl`). Otherwise Redis OOMs and crashes.

## Time-series (TimescaleDB, InfluxDB)

Purpose-built for write-heavy append-mostly workloads with time-range reads.

- High ingest rate (100K+ points / sec).
- Downsampling / rollups built in.
- Retention policies: drop data older than N.
- Optimized compression.

If your workload is "mostly append, rarely update, queried by time", this is the right tool. Forcing a generic DB to do it (insert rate, index bloat, storage cost) is misery.

TimescaleDB sits on top of Postgres — you get SQL, joins to normal tables, familiar ops.

## Graph databases (Neo4j, DGraph)

When the data is relationships and queries are traversals: "friends of friends with a common interest", "shortest path", "who did this user influence".

In a relational DB, that's a multi-step recursive CTE. In a graph DB, it's a one-liner in Cypher / GraphQL+ / Gremlin.

Cost: operational, learning curve, ecosystem. Use only when traversals dominate.

## Search (Elasticsearch / OpenSearch / Typesense / MeiliSearch)

Full-text with relevance, filters, aggregations. Postgres tsvector handles basic needs; search engines handle:

- Fuzzy matching, typo tolerance.
- Multi-language stemming.
- Custom relevance tuning (boosts per field).
- Faceted filtering with aggregates.
- Log / event search at scale.

**Never** use a search engine as the source of truth. Index from the authoritative DB; reindex is a feature, not a crisis.

## Analytics stores

OLAP vs. OLTP is the single biggest architectural fork.

- **OLTP** (Postgres, MySQL): many small reads/writes, low latency, strong consistency.
- **OLAP** (ClickHouse, BigQuery, Snowflake, Redshift, DuckDB): few big scans, column-oriented, optimized for aggregations.

Running analytics on the prod DB:
- OK for small teams, small data.
- Hits limits fast: locks the primary, slows the site, bursts workload.

Standard path:
1. Start with OLTP + read replica for reports.
2. Add a warehouse (BigQuery / Snowflake) when replica reads aren't enough.
3. Build an ELT pipeline (Fivetran, Airbyte, or home-grown) to move OLTP → warehouse.

## Polyglot persistence

Using 5 different stores because each is "best at one thing" sounds great, adds up in ops cost. Rule: every new store doubles what your oncall rotation needs to know.

Add stores sparingly. Prefer a generalist (Postgres) doing a specialist's job badly over two specialists that must be kept in sync.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| MongoDB for a heavily relational domain | Postgres |
| DynamoDB single-table design with unknown future queries | Postgres until you know what you're querying |
| Redis as the source of truth | Cache only; durable store behind it |
| Elasticsearch as primary data store | Secondary index; reindex from the primary |
| Graph DB because "everything is a graph" | Only if traversals dominate |
| Analytics on the OLTP primary | Replica → warehouse |
| One schemaless collection per "microservice" | Validate shape; otherwise chaos in six months |
| Eventual-consistency reads presented to the user as "final" | Surface "just a moment" UX; or read from primary |
| No persistence on Redis in production | Always configure AOF + RDB |
