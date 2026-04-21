# Deploy

Rolling, blue-green, canary, feature flags. Rollback plan always.

## Deploy ≠ release

- **Deploy**: new code is running on the infra.
- **Release**: new code is serving user traffic.

Decoupling them (deploy first, flag on later) is how you ship safely. The deploy can be tested under real load without user impact; the release is a quick toggle.

## Rolling update

Replace instances one / a few at a time. Default in Kubernetes, ECS, most orchestrators.

```
v1 v1 v1 v1      (4 pods)
v1 v1 v1 v2      (replace one)
v1 v1 v2 v2      (replace next)
...              (eventually all v2)
```

Parameters to tune:
- **maxSurge**: how many extra pods can exist during roll (e.g., +25%).
- **maxUnavailable**: how many pods can be missing (e.g., 0 for strict).
- **readinessProbe**: traffic waits until new pod reports ready.

Rollback: roll back to the previous replica set / task definition.

## Blue-green

Two full environments. Cut over all traffic at once.

```
blue (prod traffic) — current version
green (idle)        — new version, warmed up

Cut over: point load balancer to green.
Rollback: point back to blue (instant).
```

Pros: clean cutover, instant rollback.
Cons: 2× infra cost during the overlap window.

Use for:
- Critical releases where rolling drag-out is risky.
- DB schema changes that coexist with both versions.

## Canary

Send a small percentage of traffic to the new version; scale up if healthy, roll back if not.

```
100% v1
  5% v2, 95% v1   — watch metrics for 10 min
 25% v2, 75% v1   — watch
 50% v2, 50% v1
100% v2
```

Observation:
- Error rate on v2 vs. v1
- Latency p95/p99
- Business metrics (conversion, checkout success)
- Custom alarms (signup, payment)

Automated: Argo Rollouts, Flagger, AWS CodeDeploy canary. Manual also works — humans read dashboards and decide.

Rollback: pull the canary (route 100% back to v1).

## Progressive delivery

Canary + automated analysis. The rollout controller evaluates metrics at each step and promotes / rolls back automatically.

```yaml
# Argo Rollouts (sketch)
strategy:
  canary:
    steps:
      - setWeight: 10
      - pause: { duration: 5m }
      - analysis: { templates: [error-rate, latency-p95] }
      - setWeight: 50
      - analysis: [...]
      - setWeight: 100
```

The analysis step is a check against a metric threshold. Fail → auto-rollback.

## Feature flags

Ship code dark; flip for a percentage of users; roll back with a toggle.

```
if feature_enabled('new_checkout', user):
    new_checkout()
else:
    old_checkout()
```

Benefits:
- Deploy-release decoupling.
- A/B testing for correctness, not just design.
- Instant rollback without a redeploy.

Discipline:
- Every flag is temporary. Clean up after full rollout (or after hypothesis failure).
- Document owner + expiry for each flag. Stale flags accrete and become impossible to remove.
- Service (LaunchDarkly, ConfigCat, Unleash, Flagsmith, home-grown).

## Database migrations + deploys

See `database/migrations.md` — expand / contract is the safe dance. Key rules for deploy:

- **Migration BEFORE code that needs it.** Don't deploy v2 of the app before running its required migration.
- **No destructive migrations during peak hours.** Schedule windows; at least reduce blast radius.
- **New code tolerates old schema AND old code tolerates new schema** at the overlap.

## Preflight checks

Before actually rolling out:
- **Smoke test** against staging with the exact artifact going to prod.
- **Load test** for major changes (perf regressions hide in staging noise).
- **Dependency audit** (new CVE in the image?).
- **Release notes** drafted; rollback plan documented.

## During deploy

Monitor:
- **Deployment health**: readiness failures, crash loops.
- **Service health**: error rate, latency, saturation.
- **Downstream**: DB, cache, message broker metrics — did the new code change call patterns?
- **Business metrics**: signups / second, checkout completion.

Alerting during a deploy is different — some jitter is normal. Tighten post-deploy windows.

## Rollback

Every deploy plan includes: **how do we get back?**

```
If <condition>, roll back by <step 1>, <step 2>, ...
```

Common "conditions":
- Error rate > 2× baseline for 5 min
- Latency p99 > 2× baseline
- Business metric (signup, checkout) drops > 20%
- Manual oncall decision

Rollback command should be one thing — not a checklist. Automate it.

### What's rollback-safe?

| Change | Rollback |
|---|---|
| Code-only | Deploy previous artifact |
| Migration that's additive | Old code works; no DB action needed |
| Migration that removed a column | Restore from backup (painful) — avoid this in a rolled-back state |
| Feature flag on | Turn it off |
| Config change | Revert config |

Design changes so rolling back code is sufficient. That dictates the migration pattern (expand/contract).

## Shutdown gracefully

On `SIGTERM`:
1. Stop accepting new connections (readiness → unhealthy; LB removes pod).
2. Finish in-flight requests (with a grace period — 30 s typical).
3. Drain queues / finish current job.
4. Close DB / external connections.
5. Exit 0.

Without this, rolling updates drop requests and leave half-processed jobs.

Kubernetes: `terminationGracePeriodSeconds: 30` + a `preStop` hook + SIGTERM handling in app.

## Deploy cadence

- **Fast** (multiple / day, per team) — best for small changes, high automation, strong tests.
- **Batched** (weekly / fortnightly) — when risk of each release is high.

High-performing orgs deploy multiple times per day. The trick is making each deploy small.

## "Release" vs. "deploy" for mobile

Mobile can't feature-flag installed versions. But server-side flags can control behaviour of the installed app. Design APIs so server-side flags let you turn off client features without a new app version.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Deploying on Fridays without cause | Deploy midweek, quieter rollback |
| Rollback as "SSH in and run..." | Automated, one-command rollback |
| Waiting for the deploy to "look OK" by refreshing the app | Instrument; set specific metrics |
| Manual canary percentage math | Use the orchestrator's progressive rollout |
| Schema migration in the same step as code rollout | Pre-migrate; expand/contract |
| Long-lived feature flags | Set expiry; clean up |
| Sidecar fetching config at startup with no timeout | Fail fast; bounded retry |
| Skipping grace period on SIGTERM | Lose requests at every deploy |
| Deploys that don't produce an event in observability | Correlate spikes; deploys are first-class events |
