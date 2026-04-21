# Caching

Rules, strategies, pitfalls. Cache-aside covers 90% of cases.

## Cache-aside (lazy loading)

Application checks cache first; on miss, loads from source and populates cache.

```
get(id):
    v = cache.get(key(id))
    if v is not None:
        return v                      # hit
    v = source.load(id)               # miss
    if v is not None:
        cache.set(key(id), v, ttl=5min)
    return v
```

Pros: simple; stale data only appears on cached keys; source is authoritative.
Cons: first reader after expiry pays full latency; risk of **cache stampede** when many readers miss together.

## Write-through

Application writes to cache AND source atomically (usually: write source first, then cache).

```
save(entity):
    source.save(entity)
    cache.set(key(entity.id), entity, ttl=5min)
```

Pros: cache is always fresh after a write.
Cons: writes are slower; if cache write fails, you have stale data (decide: rollback, or fire-and-forget with expiry).

## Write-behind (deferred)

Application writes to cache; a background job flushes to source later. Rare — only for very high write volume and tolerance for delayed durability. Almost always the wrong choice; you're trading data loss risk for write throughput.

## What to cache (and what NOT to)

**Cache-friendly**:
- Read-heavy, changes rarely (config, product catalog, user profile)
- Expensive to compute (rendered HTML, aggregations, vector search)
- Idempotent reads

**Avoid caching**:
- Per-user personalized data with high cardinality (cache hit rate too low)
- Rapidly changing data (reconciliation cost > cache benefit)
- Anything where staleness is a correctness bug (balances, seat availability)

## TTL strategy

Every cache entry must expire. No TTL = memory leak.

| Data type | Starting TTL |
|---|---|
| Static config | 1–24 h |
| User profile | 5–60 min |
| Hot aggregation | 10 s – 5 min |
| Computed render | minutes |
| Feature flag eval | 30–60 s |

Add a small random jitter (±10%) so entries don't all expire at the same instant → stampede.

## Invalidation

The second hardest problem in computing. Three approaches:

1. **TTL only** — simple; tolerate staleness up to TTL. Default choice.
2. **Explicit invalidation** — on write, delete the cache key. Works if your mutation paths are countable.
   ```
   save(user):
       db.update(user)
       cache.delete(key(user.id))
   ```
3. **Event-driven** — publish `UserUpdated`; subscribers invalidate their caches. Needed when many services cache the same entity.

Don't try to *update* the cache on write in complex systems — delete instead and let the next read repopulate. Updates race; deletes don't.

## Cache key design

Stable, explicit, version-prefixed.

```
# ✅
user:v2:{user_id}
product:v1:{sku}:detail
list:orders:v1:user={uid}:status=paid:cursor={c}

# ❌
u_123                  # ambiguous across services
users:123:details      # no version
${JSON.stringify(query)}  # fragile; order-dependent
```

Version prefix lets you deploy a new format without stampeding the old one; old keys simply age out.

## Stampede protection

When a hot key expires, many requests miss at once and pile onto the source. Two fixes:

### Single-flight / coalescing

In-process: at most one loader per key; concurrent callers wait for the same result.

```
load(key):
    with singleFlight(key):
        return source.load(key)
```

### Probabilistic early expiration (XFetch)

Before the TTL, some fraction of readers voluntarily refresh.

```
get(key):
    v, ttl_remaining = cache.get_with_ttl(key)
    if v is None or should_refresh_early(ttl_remaining):
        v = source.load(key)
        cache.set(key, v, ttl=5min)
    return v
```

## Negative caching

Cache misses are expensive if they happen constantly (e.g., 404 lookups). Cache the absence too, with a short TTL.

```
get(id):
    v = cache.get(key(id))
    if v is MISSING_SENTINEL:
        return None                 # known-not-found
    if v is not None:
        return v
    v = source.load(id)
    cache.set(key(id), v if v else MISSING_SENTINEL, ttl=30s)
    return v
```

Short TTL — don't cache `None` for hours; the item may just have been created.

## HTTP-level caching

For public GET endpoints, let the HTTP layer cache. Free, correctly implemented, respected by CDNs.

```
Cache-Control: public, max-age=300, s-maxage=600, stale-while-revalidate=60
ETag: "abc123"
```

- `max-age`: browser/client
- `s-maxage`: shared caches (CDN)
- `stale-while-revalidate`: serve stale while refreshing in the background
- `ETag` + `If-None-Match`: 304 responses save bandwidth

## Local (in-process) cache vs distributed

| | Local (in-process) | Distributed (Redis, Memcached) |
|---|---|---|
| Latency | Nanoseconds | ~1 ms |
| Consistency across instances | No — each pod has its own | Yes |
| Size | Limited to process memory | Limited to cluster |
| Eviction | LRU, LFU | LRU, LFU, TTL |
| Cost | Free | Infra + ops |
| Invalidation | Hard across pods | One call |

Use local for small hot data; distributed for shared state. Don't mix carelessly — a per-pod cache that's supposed to be consistent will drift.

## Anti-patterns

| Anti-pattern | Why bad |
|---|---|
| No TTL anywhere | Memory leak; stale data forever |
| Caching mutable objects by reference | Next reader mutates the cached copy |
| Caching per-user data with high cardinality | Low hit rate; wastes memory |
| Cache key includes a timestamp that changes every request | Every request is a miss |
| Serializing cache writes into the request path without timeout | Cache outage → requests hang |
| Reading cache without a fallback path | Cache is a dependency; treat it as optional |
| Storing secrets in shared cache | Secret sprawl across cluster |
