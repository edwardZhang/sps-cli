# Observability (Platform)

Log / metric / trace pipelines, alerting, on-call, runbooks. For app-level signal definition, see `backend/references/observability.md`; this file covers the platform plumbing.

## The stack

```
App  ──stdout──▶  Collector (fluent-bit, otel-collector, vector)
     ──metric──▶  Prometheus / Cloud Monitoring / Datadog / NewRelic
     ──trace───▶  OpenTelemetry Collector ──▶ Jaeger / Tempo / DD APM

Alerting: Prometheus Alertmanager / Grafana / PagerDuty / OpsGenie
```

Pick the right number of tools. Four different tools with overlapping coverage is a tax; one plus another specialist is usually enough.

## Logs

### Collection

- Container logs → stdout/stderr.
- Daemon on each node reads container logs (`fluent-bit`, `fluentd`, `vector`, cloud-native).
- Collector forwards to the backend (Elasticsearch, Loki, Datadog Logs, Cloud Logging).

Don't write logs to local files inside containers. Lost on pod restart; hard to collect.

### Format

JSON. Every line a structured event. See `backend/references/observability.md` for field names.

### Retention

Tier by age:
- **Hot**: 7–14 days, fast search.
- **Warm**: 30–90 days, slower but still searchable.
- **Archive**: 1+ year, S3 / cold storage, restore on demand.

Log volume grows with traffic; set retention per env (dev can be 3 days, prod 30). Otherwise, the bill does the planning for you.

### Sensitive data

Redact at source — the app's logger, not the collector. Once a secret hits the pipeline it's harder to control.

Check your logs periodically for leaked PII / tokens. Automated scanning rules (pattern matching JWT, credit card) in the pipeline.

## Metrics

### Collection

- **Pull** (Prometheus) — scraper hits app endpoints.
- **Push** (StatsD, OTLP) — app pushes to a gateway / collector.

Pull scales well at moderate cluster sizes, gets fiddly at huge scale. Push is simpler at scale but loses some visibility.

### Standards

OpenTelemetry (OTel) is becoming the de-facto standard for metric + trace instrumentation. Instrument once with OTel SDKs; switch backends by changing the collector config.

### Cardinality

Every unique combination of label values creates a new time series. High-cardinality labels (user_id, request_id) blow up storage and cost.

```
# ✅ bounded
http_requests_total{service="api", route="/orders", method="POST", status="200"}

# ❌ unbounded
http_requests_total{service="api", user_id="u_01HX..."}
```

The cloud will silently charge you for cardinality. Watch the count of series.

### Four golden signals (per service)

1. **Latency** — how long do requests take (p50/p95/p99)?
2. **Traffic** — how many requests per second?
3. **Errors** — rate of failed requests?
4. **Saturation** — how full is it? (CPU, queue depth, connection pool)

Dashboards start here. Drill into specifics from the starting point.

## Traces

OpenTelemetry instrumented endpoints + propagated context.

```
Request ─▶ Service A [span] ─▶ Service B [span] ─▶ DB [span]
```

Each span has timing, tags, events. Together they form the request timeline.

### Sampling

Head-based (per request, decide at ingress):
- 1–10% typical.
- Boost to 100% for errors.

Tail-based (sample after seeing the whole trace):
- Keep slow traces, error traces, unusual patterns.
- Needs a full collector layer (otel-collector).

Tracing overhead is real — don't trace 100% in prod without tail-based sampling.

## Dashboards

### Structure

One dashboard per service, standard layout:
- Overview: RED metrics (Rate, Errors, Duration).
- Saturation: CPU, memory, pool utilization.
- Dependencies: DB, cache, upstream services.
- Recent deploys marked as vertical annotations.

Links to runbook + logs + traces.

### Don't build 50 dashboards

Most go stale within weeks. Focus on a small set that matters:
- One per critical service.
- One per SLO.
- A few investigative templates ("compare p99 before/after a given deploy").

## Alerts

### Principles

- **Alert on symptoms, not causes.** "Users can't check out" beats "CPU is 80%".
- **Every alert is actionable** — there's a specific thing the oncall does.
- **Every alert has a runbook** linked in the alert body.
- **Every alert has an owner** — the team / service that owns the fix.

### Severity levels

- **P1 / SEV-1**: page the oncall; revenue / customer-facing impact.
- **P2 / SEV-2**: notify in team channel; degraded state.
- **P3 / SEV-3**: track as an issue; investigate next business day.

Only P1 should wake someone up. Too many P1s → pager fatigue → missed alerts.

### Tuning

- Alert fires → wasn't actionable → either tune the threshold or delete it.
- Alert fires at 3am and auto-resolves at 3:15am with no action → wasn't actionable.
- Alert with "click dashboard, maybe it's fine" → wasn't actionable.

Audit monthly.

## On-call

### Rotation

- Weekly rotation typical; one primary + one secondary.
- Handoff meeting: what's ongoing, what's worrying.
- On-call participants must have access: can deploy, rollback, scale.

### Triage flow

1. **Acknowledge** — clock is ticking on MTTR.
2. **Stop the bleeding** — rollback, scale up, disable a feature flag. Don't perfect-fix in the moment.
3. **Gather context** — what changed recently? dashboards, logs, traces.
4. **Escalate** — bring in the service owner if you're not them.
5. **Post-incident** — see below.

### Post-incident

Every P1 gets a postmortem. Blameless.

Template:
- **Summary** — one paragraph.
- **Impact** — who / how much / how long.
- **Timeline** — minute-by-minute of detection, response, resolution.
- **Root cause** — technical + process.
- **Action items** — specific, owned, dated.
- **Lessons** — what was surprising.

Track action items to completion. Unshipped postmortem actions are how the same incident happens twice.

## SLO / error budget

Set SLOs (service-level objectives) that match user expectations. Derive error budget.

```
SLO: 99.9% of /orders POST succeed in ≤ 500 ms
Budget: 0.1% × 30 days ≈ 43 min / month
```

Burn rate:
- Slow burn — spend budget over weeks (minor quality erosion).
- Fast burn — exhaust weekly budget in a day (real problem).

Alert on burn rate, not just on individual failures. "We're burning budget 10× too fast" is actionable.

## Health endpoints

```
/health/live   — process alive
/health/ready  — can serve traffic (DB reachable, cache reachable)
```

Container orchestrators use both:
- Live failing → restart the container.
- Ready failing → take out of load balancer, leave alive.

Never put business logic in health checks. Keep them cheap and boring.

## Cost visibility

Observability is expensive at scale. Monitor the bill:
- Logs ingested per service per day.
- Metric series count.
- Trace spans per second.

When one service exports 10× what others do — investigate. Usually debug logging left on, or a metric with a user-id label.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Logs written to files in containers | stdout |
| Alerts on infrastructure without symptom mapping | Alert on service impact |
| Dashboards nobody reads | Delete unused; focus on core ones |
| Runbook-less alerts | Every alert links a runbook |
| Tracing 100% in prod without sampling | Head or tail sampling |
| Metric labels on request IDs | Use logs/traces for high-cardinality |
| "I'll set up monitoring later" | Observability before launch |
| Alert channel drowning in noise | Audit and tune |
| No oncall → whoever's free panics | Formal rotation, documented escalation |
| Postmortems as blame sessions | Blameless format; focus on systems and actions |
