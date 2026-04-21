---
name: devops
description: DevOps end skill — CI/CD, containers, infrastructure-as-code, secrets, observability. Tool-neutral (GitHub Actions / GitLab CI / Argo / Terraform patterns). Pair with `backend`, language skills, and `coding-standards`.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# DevOps

CI/CD, containers, infra-as-code, secrets, observability. **Tool-neutral** — patterns apply across GitHub Actions / GitLab CI / CircleCI, Terraform / Pulumi / CDK, Docker / OCI, Kubernetes / ECS / Cloud Run.

## When to load

- Setting up or reviewing CI/CD
- Containerization, image builds, multi-stage Dockerfiles
- Infrastructure-as-code changes (Terraform, Pulumi, CloudFormation, CDK)
- Secret management, rotation, access control
- Observability at the platform level (metrics / logs / traces collection, alerting)
- Deploy strategies (blue-green, canary, progressive delivery)

## Core principles

1. **Everything as code.** Infra, CI, secret policy, dashboards, alerts — in the repo, reviewed, versioned.
2. **Immutable artifacts.** The build produces one artifact (image, binary); the same artifact promotes through envs unchanged.
3. **Dev / staging / prod parity.** Same tooling, same topology, smaller. Differences are explicit (size, scaling, data), not accidental.
4. **Automate the path to prod.** Merges to main trigger deploy (with gates); humans click "promote", not "run these commands".
5. **Ephemeral infra, persistent data.** Nodes, pods, VMs — replaceable. Data — backed up, versioned, migrated.
6. **Least privilege by default.** CI, services, humans all get scoped credentials. Root access is an event, not a default.
7. **Fast feedback.** Build < 10 min on typical change, < 3 min on type/lint. Slow CI loses its purpose.
8. **Observability before features.** You can't fix what you can't see.

## How to use references

| Reference | When to load |
|---|---|
| [`references/ci-cd.md`](references/ci-cd.md) | Pipelines, caching, parallelism, artifacts, gates, promotion |
| [`references/containers.md`](references/containers.md) | Dockerfile, multi-stage, size, rootless, base images, image signing |
| [`references/iac.md`](references/iac.md) | Terraform / Pulumi / CDK — structure, state, modules, reviews |
| [`references/secrets.md`](references/secrets.md) | Secret managers, rotation, access control, pre-commit scanning |
| [`references/deploy.md`](references/deploy.md) | Rolling / blue-green / canary / feature flags, rollback |
| [`references/observability.md`](references/observability.md) | Log/metric/trace pipelines, alerting, on-call, runbooks |

## Forbidden patterns (auto-reject)

- Secrets in code / Dockerfile / CI config / `.env` in git
- CI pipelines that skip tests with `|| true` / `--continue-on-error`
- Pushing latest tag only (no immutable version for rollback)
- `curl | bash` from the internet in Dockerfile / install script without pinning
- Running containers as root without documented reason
- Terraform state on a local dev machine (no remote, no locking)
- Manual prod changes (clicking in a console) not followed by IaC update
- Deploy scripts that don't know how to roll back
- Alerts that wake someone up without a runbook
- Public S3 buckets / databases without explicit review
- `:latest` base image tags in prod builds
- Writing logs to the container filesystem (lost on restart)
