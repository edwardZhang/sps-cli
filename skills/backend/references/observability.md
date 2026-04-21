# Observability

Logs, metrics, traces, health. A request you can't trace is a bug you can't fix.

## The three pillars

| Signal | Answers | Cost | Cardinality |
|---|---|---|---|
| **Logs** | "What happened in this request?" | High (per-event) | Unlimited |
| **Metrics** | "How much, how often, how fast, across the fleet?" | Low (aggregated) | Bounded (labels explode) |
| **Traces** | "Where did time go in this distributed request?" | Medium (sampled) | Unlimited per trace |

Pick the right signal for the question. Metrics for dashboards, logs for forensics, traces for latency breakdowns.

## Structured logs — JSON, not prose

Human-readable strings are unqueryable. Every log line is a JSON object with a stable schema.

```json
{
  "ts": "2026-04-20T10:23:45.123Z",
  "level": "info",
  "service": "orders",
  "env": "prod",
  "request_id": "req_01HX...",
  "trace_id": "0af7651916cd43dd...",
  "user_id": "u_01HX...",
  "msg": "order created",
  "order_id": "ord_01HX...",
  "amount_cents": 2599,
  "duration_ms": 87
}
```

Rules:
- Always include `ts`, `level`, `service`, `env`.
- Always include a request/trace id so you can stitch a request together across services.
- Message is a short constant string — fixed values in `msg`, varying values in fields. `"order created"` not `"order ord_01HX created for $25.99"`.
- Never log secrets, tokens, passwords, full PII. Redact at the logger, not the call site.

## Log levels — use them honestly

| Level | Means | Typical rate |
|---|---|---|
| ERROR | Something broke; a human should look | Low |
| WARN | Unexpected, but handled (retry succeeded, fallback used) | Low |
| INFO | State changes worth knowing at normal volume | Medium |
| DEBUG | Details useful while investigating; off in prod | High (when on) |

Abused levels poison the signal. If everything is INFO, nothing is INFO.

## Correlation IDs

Every request gets a unique id at the edge; it propagates through every log line and outbound call.

```
incoming request → generate request_id (or accept from X-Request-ID)
                 → bind to logger context
                 → forward on outbound calls (X-Request-ID, traceparent)
```

Distributed tracing (OpenTelemetry) gives you `trace_id` + `span_id` for free. Log both when you have them.

## Metrics — RED + USE

Two checklists that cover almost everything.

### RED (per request-driven service)

- **R**ate — requests per second
- **E**rrors — failing requests per second (or error rate)
- **D**uration — latency distribution (p50 / p95 / p99)

### USE (per resource)

- **U**tilization — how busy is it? (CPU%, thread pool in use / max)
- **S**aturation — how much work is queued? (request queue depth)
- **E**rrors — how many operations failed?

Track these for every service and every critical dependency.

## Latency — measure distributions, not averages

Averages hide the worst cases. P95/P99 are where your users actually feel slowness.

```
# ✅
http_request_duration_seconds{route="/orders", method="POST"}
  → histogram with buckets (0.01, 0.05, 0.1, 0.5, 1, 5)
  → alert on p99 > 1s for 5 min

# ❌
avg_response_time = sum(durations) / count(durations)
  → a 10 s outlier buried in 999 fast ones looks fine
```

## Labels — finite cardinality

Every unique label combination creates a new metric series. High-cardinality labels (user id, request id, email) will blow up storage and cost.

| Label | OK? |
|---|---|
| route, method, status_code | Yes (small set) |
| region, pod_name, env | Yes |
| user_id, request_id, email, SKU | NO — use logs/traces for these |

## Tracing

A trace is a tree of spans representing one request's path through services. Each span has: operation name, start/end time, attributes, parent span.

Auto-instrument with OpenTelemetry. Add manual spans around:
- External HTTP calls (service, endpoint, status)
- DB queries (operation, table; never the full raw query — cardinality)
- Cache ops
- Queue enqueue / dequeue
- Expensive pure computations

Sampling: head-based (1–10% of requests fully traced) or tail-based (keep traces where something went wrong). Keep tracer overhead < 1% of request latency.

## SLOs — the contract

An SLO is a number + a window. "99.9% of /orders responses succeed within 500 ms, measured over 28 days."

Error budget = `1 − SLO`. Over 28 days, 99.9% allows ≈40 min of downtime. When you burn the budget, freeze risky changes and invest in reliability.

Don't set SLOs to what your service does today. Set them to what your users need.

## Alerts — page on symptoms, not causes

Alert on "users are affected" (SLO burn rate, error rate spike, latency breach). Don't alert on "CPU is at 80%" — that's often fine.

Every alert must be:
- **Actionable** — there is something the oncall can do right now
- **Unambiguous** — one cause for the page, not "anything could have fired this"
- **Documented** — link to a runbook from the alert body

If an alert fires and the oncall thinks "not my problem" or "auto-resolves in 5 min", it's a bad alert. Delete or tune it.

## Runbooks

One per alert. Structure:

```
# Alert: api-latency-p99-high

## What this means
p99 on /api/orders POST is > 1s for 5m.

## Immediate checks
1. Look at [dashboard-link]
2. Check for recent deploy: [deploys-link]
3. Check upstream health: [dep-status]

## Common causes
- DB slow query → check [slow-query-dashboard]
- Cache outage → check redis metrics
- Upstream payment provider → check provider status page

## Mitigation
- Roll back recent deploy if within 30 min window
- Failover to secondary region
- ...
```

## Health endpoints (minimal)

```
GET /health/live   → 200 if process can serve (don't check dependencies)
GET /health/ready  → 200 only if dependencies are reachable (DB, cache, queue)
```

Live failing → orchestrator restarts the pod.
Ready failing → orchestrator takes the pod out of the load balancer (but doesn't kill it).

Never put business logic in health checks. They should be cheap and boring.

## Anti-patterns

| Anti-pattern | Why |
|---|---|
| String-formatted logs (`"user X did Y at Z"`) | Unqueryable |
| Logging full request bodies | PII leak, storage blow-up |
| Alerting on CPU / disk without symptom link | Pager fatigue; noise |
| No request correlation id | Can't stitch a failure across services |
| Logging at DEBUG in prod | Drowns the signal; storage cost |
| `avg_latency` as the only latency metric | Hides the outliers that hurt users |
| `status:500` as the only error signal | 200 with `{error: ...}` bodies exist and hurt |
| Metrics labels with user id / email | Cardinality explosion |
| Tracing everything, sampling nothing | Cost blowup; latency overhead |
| Alerts without runbooks | Oncall guesses, takes too long |
