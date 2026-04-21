# CI / CD

Pipelines, caching, parallelism, artifacts, gates.

## Pipeline stages — the standard shape

```
┌──────────┐ ┌───────┐ ┌──────┐ ┌──────┐ ┌──────────┐ ┌──────────┐
│ checkout │▶│ lint  │▶│ test │▶│ build│▶│ scan/sign│▶│  deploy  │
└──────────┘ └───────┘ └──────┘ └──────┘ └──────────┘ └──────────┘
                  │
                  └─► parallel jobs where possible
```

Order matters: cheap-and-fast first (lint, typecheck). Expensive and slow last (E2E, image build). Failing lint should fail the pipeline in under a minute.

## Keep CI fast

Target: **< 10 min end-to-end on a typical change**. Slow CI punishes every commit.

Levers:

- **Cache dependencies.** Lockfile as cache key. `actions/cache` / equivalent.
- **Parallelize independent jobs.** Lint + typecheck + unit tests can all run at once.
- **Shard tests.** A 10-minute test suite split into 4 shards = 2.5 min each.
- **Run integration / E2E on critical paths only**, or only on main.
- **Test only what changed** for monorepos. `nx affected`, `turbo run --filter`, `bazel query`.

## Cache keys

```yaml
# ✅ stable, invalidates only when deps change
key: "${{ runner.os }}-node-${{ hashFiles('package-lock.json') }}"

# ❌ too narrow — cache misses every run
key: "${{ runner.os }}-node-${{ github.sha }}"

# ❌ too broad — may return incompatible cache
key: "${{ runner.os }}-node"
```

Cache the right things:
- `node_modules` / `pip wheels` / `cargo target` / `gradle caches` — big wins.
- Build output (`.next`, `dist`) if subsequent jobs use it.
- Don't cache test reports or transient artifacts.

## Build artifacts, promote them

Build once. The same artifact flows dev → staging → prod.

```
PR:    build → test                (no artifact published)
main:  build → test → publish      (publish image:sha)
deploy dev:     pull image:sha → deploy
deploy staging: pull image:sha → deploy      (same image)
deploy prod:    pull image:sha → deploy      (same image)
```

Building again per environment re-runs tests and invites "it worked in staging" surprises when the new build differs (new dependency version, timestamp).

## Artifact tagging

```
image: myapp:sha-abc1234          # immutable, references a commit
image: myapp:v1.2.3               # semver release
image: myapp:main                 # mutable — latest main
image: myapp:latest               # mutable — last push to whatever
```

Deploy by immutable tag (`sha-abc1234` or `v1.2.3`). Mutable tags (`main`, `latest`) are convenient for humans but make rollbacks ambiguous.

## Gates and approvals

Autodeploy to dev. Require a check/approval for staging → prod (or for sensitive envs).

```
merge to main
  ▶ deploy dev (auto)
  ▶ deploy staging (auto, smoke tests)
  ▶ deploy prod (manual approval)
```

Manual gate is the pause for "should this actually ship now?" — release freeze, cross-team sync.

## Required status checks

On the PR branch, block merge unless:
- Lint / typecheck pass
- Unit tests pass
- Coverage above threshold (if enforced)
- Review approval received

Configure in the VCS (GitHub branch protection, GitLab push rules).

## Secrets in CI

- **Never** store secrets in CI config files or env files checked into the repo.
- CI platforms have secret stores (GitHub Secrets, GitLab Variables, environment-scoped).
- Scope per environment (`PROD_DB_URL`, not a shared one).
- Prefer short-lived credentials (OIDC) over long-lived keys.
  ```
  # GitHub Actions → AWS via OIDC, no AWS_ACCESS_KEY stored in GitHub
  permissions: { id-token: write }
  - uses: aws-actions/configure-aws-credentials@v4
    with: { role-to-assume: arn:aws:iam::...:role/github-prod }
  ```
- Mask secrets in logs (most CI tools do this automatically).

## Supply-chain security

- **Pin** third-party actions / images by SHA, not version tag.
  ```yaml
  uses: actions/checkout@11bd71901bbe5b1630ceea73d27796261f9...   # v4.0.0
  ```
  Tags are mutable; an attacker who takes over the repo can repoint a tag.
- **Dependency scanning**: Dependabot / Renovate for updates; Snyk / Trivy / Grype for vulnerabilities.
- **SBOM generation**: produce one per build, store it.
- **Image signing**: cosign + Sigstore; verify at deploy.

## Matrix builds

For multi-version / multi-OS testing:

```yaml
strategy:
  matrix:
    node: [18, 20, 22]
    os: [ubuntu-latest, macos-latest]
```

Keep matrices narrow — `3 × 2 = 6` jobs, not 30. CI-minutes add up.

## Flaky tests — triage immediately

One flaky test poisons the signal.

- Tag the test as flaky, move to a separate job, investigate within a week.
- A test that fails intermittently is ALWAYS a bug: race condition, shared state, timing assumption. Don't accept "just retry".
- Quarantine + retry is a short-term fix only. Delete the test rather than leave it quarantined forever.

## Pull-request vs. main pipelines

Different triggers, often different scopes:

| Trigger | Run |
|---|---|
| PR | Lint, typecheck, unit, key integration |
| PR (target main) | + E2E happy path |
| Merge to main | + build, publish artifact, deploy dev / staging |
| Tag / release | + prod deploy gate |
| Scheduled | + full E2E, perf tests, security scans |

Don't run everything on every PR. Keep PRs fast; save heavy tests for main.

## Monorepo considerations

- **Change-aware testing**: don't rebuild / test the whole monorepo if only one package changed.
- **Project graph tools**: Turborepo, Nx, Bazel, Pants.
- **Shared cache**: remote cache (Turbo Cloud, Nx Cloud, BuildBuddy) pays for itself on larger teams.

## Deploy previews

Ephemeral environments per PR:

```
PR #123 → https://pr-123.preview.myapp.com
```

Great for frontend, reasonable for APIs, expensive for heavy backends. Tear down on PR close.

Tools: Vercel / Netlify / Cloudflare for frontends; Render / Fly / Kubernetes preview envs / Garden / Uffizzi for full-stack.

## Concurrency control

Don't let two prod deploys race:

```yaml
concurrency:
  group: deploy-prod
  cancel-in-progress: false
```

For PR previews, cancel old runs when a new commit arrives:

```yaml
concurrency:
  group: pr-${{ github.ref }}
  cancel-in-progress: true
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `|| true` to hide test failures | Fix or delete the test |
| `:latest` tag in prod deploy manifest | Immutable tag |
| Deploying code untested in staging | Dev → staging → prod, same artifact |
| Secrets via commits / CI log | Secret store, masked |
| 40-minute CI runs on every PR | Split; run heavy tests on main |
| Tests that share mutable state | Isolate / reset per test |
| Action pinned by tag only | Pin by SHA |
| Deploying from a dev laptop | CI-only deploy path |
| No automated rollback plan | See `deploy.md` |
| Ignoring flaky tests | Quarantine + fix within a week; don't normalize |
