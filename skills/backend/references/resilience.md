# Resilience

Timeouts, retries, circuit breakers, idempotency, background jobs. Make failures cheap.

## Timeouts — every outbound call

No exceptions. A dependency that never answers will exhaust threads, sockets, and memory.

```
# Wrong: no timeout
response = http.get("https://upstream/api")

# Right: fail fast
response = http.get("https://upstream/api", timeout=2.0)
```

Timeout budget, layered:

```
client            10s
  └ gateway        8s
     └ service    5s
        └ dependency call  2s   ← must be smaller than parent budget
```

If the inner call's timeout ≥ the outer's, the outer never gets to return a clean 504 — it just hangs.

## Retries — only for safe, transient failures

**Retryable**:
- Network timeouts
- 5xx on GET/idempotent calls
- 429 (with `Retry-After`)
- Explicit DB "retry" errors (e.g., serialization failures)

**NOT retryable**:
- 4xx other than 429 (client bug; retry won't help)
- Any non-idempotent call without an `Idempotency-Key`
- "Connection reset" where the write may have landed

### Exponential backoff with jitter

Pure exponential backoff creates thundering herds when many clients fail together. Always add jitter.

```
attempt(n):
    base = 100ms
    max  = 10s
    sleep = min(max, base * 2^n) * random(0.5, 1.5)
```

Bound the total attempts and total time; don't let retries outlive the user's patience.

## Circuit breakers

When a dependency is sick, stop hammering it. Three states:

```
  CLOSED (normal)
    │  failures exceed threshold
    ▼
   OPEN (fail fast, short-circuit calls)
    │  after cool-down, try one request
    ▼
 HALF_OPEN ──success──► CLOSED
    │
    └─failure──────────► OPEN
```

Thresholds to tune: error rate (e.g., >50% of last 20 calls), minimum sample size, cool-down time, half-open probe count.

Open-circuit response: fall back to cache, degraded response, or fail fast with 503. Never silently return empty data.

## Idempotency

Any operation that might be retried must be safe to run twice.

### Idempotency keys

For non-GET HTTP writes, accept an `Idempotency-Key` header.

```
POST /payments
Idempotency-Key: 7a8b9c...

server:
  stored = store.get(key)
  if stored and stored.request_hash == hash(body):
      return stored.response
  if stored:
      return 409   # same key, different body → conflict
  response = execute()
  store.set(key, (hash(body), response), ttl=24h)
  return response
```

### Natural idempotency

Often better than keys: design the operation so repeats are harmless.

```
# Not idempotent
UPDATE balance SET amount = amount + 10 WHERE id = 1

# Idempotent — absorbs double-apply
INSERT INTO ledger (id, account, amount) VALUES (:tx_id, 1, 10)
ON CONFLICT (id) DO NOTHING
```

## Graceful degradation

When a non-critical dependency is down, return a usable response, not an error.

```
product = productRepo.get(id)
try:
    product.recommendations = recService.for(id, timeout=300ms)
except (Timeout, ServiceError):
    product.recommendations = []        # degrade, don't fail
return product
```

Decide up front which pieces are essential vs. nice-to-have. Never degrade silently on essentials (payments, auth).

## Background jobs

For anything not strictly needed in the request path: send, enqueue, return.

```
# Request path
handler(req):
    order = orderRepo.save(newOrder)
    queue.enqueue(SendOrderEmail(order.id))      # defer
    queue.enqueue(UpdateSearchIndex(order.id))
    return 201
```

Queue requirements:
- **Durable** — enqueue survives broker restart (disk, replicated)
- **At-least-once delivery** — so jobs must be idempotent
- **Dead-letter queue** — after N failures, park the message and alert
- **Visibility timeout** — consumer crashes → job requeues automatically

Common choices: Postgres-backed (pgboss, solid-queue), Redis (BullMQ, Sidekiq), managed (SQS, Cloud Tasks), streaming (Kafka).

## Scheduled jobs

Two traps:
1. **Lock per job** — multiple replicas must not run the same job twice. Use a DB advisory lock or a leader-election lib.
2. **Overlap** — if a job runs longer than its interval, the next tick starts before the previous ends. Decide: skip, queue, or overlap — explicitly.

Don't use `cron` on a single VM in production; it dies with the VM. Use a platform scheduler (Kubernetes CronJob, cloud scheduler) + idempotent job logic.

## Health checks

Two separate endpoints:

```
GET /health/live         # Am I running? (200 = process alive)
GET /health/ready        # Can I take traffic? (checks DB, cache, queue connectivity)
```

Orchestrators (K8s, load balancers) need both. `/ready` failing for 30s → take the pod out of rotation, don't kill it.

## Graceful shutdown

On SIGTERM:
1. Stop accepting new requests (`/ready` → 503).
2. Finish in-flight requests (with a hard deadline, e.g., 30 s).
3. Drain the job consumer.
4. Close DB pools and sockets.
5. Exit.

Without this, a deploy drops requests and leaves half-processed jobs.

## Bulkheads

Isolate failure domains so one tenant / feature can't drown the others.

- Separate thread pool / connection pool per downstream service
- Separate queue / worker group per job class
- Separate rate limit per tenant

One noisy neighbor should degrade its own lane, not everyone's.

## Timeouts for tasks, not just HTTP

DB query timeouts (`statement_timeout` in Postgres), job max runtime, lock wait timeout — all finite. Anything unbounded will eventually hang something.

## Anti-patterns

| Anti-pattern | Why |
|---|---|
| Infinite retries | One bad day becomes a queue explosion |
| Retries without backoff | Synchronized thundering herds |
| Retry on POST without idempotency key | Duplicate payments, double-sends |
| Shared retry budget across unrelated calls | One bad dep exhausts retries for healthy ones |
| Catching all exceptions to mask failures | Bugs silently go to prod |
| Fire-and-forget without a dead-letter queue | Failed jobs vanish with no alert |
| "Run every N seconds" cron on a single machine | Loses work on reboot |
| Waiting forever for a lock | Locks don't auto-expire unless you say so |
