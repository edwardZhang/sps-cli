# Secrets

Storage, rotation, access, scanning. The part that goes wrong quietly.

## The rules

1. **Never in source control.** Ever. `.env` files stay in `.gitignore`; secrets come from a manager.
2. **One secret, one owner.** Scoped per service, per env. The "shared creds" bucket is a leak waiting.
3. **Rotate on schedule AND on compromise.** Short lifetime = small window of exposure.
4. **Least privilege.** A service key can read its own DB, not every DB.
5. **Audit every read.** You should be able to tell who accessed prod secret X yesterday.
6. **Encrypt at rest AND in transit.** Default in modern secret managers; verify.

## Where to store them

| Tool | For |
|---|---|
| **AWS Secrets Manager / Parameter Store** | AWS; IAM-integrated |
| **GCP Secret Manager** | GCP; IAM-integrated |
| **Azure Key Vault** | Azure; RBAC-integrated |
| **HashiCorp Vault** | Cloud-agnostic; dynamic secrets, rich ACLs |
| **1Password / Bitwarden** | Human-held secrets, small teams |
| **Kubernetes Secrets** | K8s-native, lightweight; encrypt etcd |
| **Sealed Secrets / SOPS** | Encrypt secrets that live in git (controller decrypts) |

Pick one canonical store per cloud estate. Sprawl breeds drift — the same secret in three places rotates in one.

## Access patterns

### At deploy

- CI has scoped permission to fetch the secrets its job needs (e.g., `DEPLOY_ROLE_PROD`).
- Terraform pulls via `data` sources at apply (not baked into `.tfvars`).
- Kubernetes: use the cloud provider's secret CSI driver or External Secrets Operator.

### At runtime

- Container pulls secrets from the manager on startup via the platform (IRSA on EKS, Workload Identity on GKE, IAM on Azure).
- Or mount as files; the app reads from `/secrets/db_url`.
- Never bake into the image.

### Locally

- Developers authenticate to the secret manager (SSO + session).
- CLI pulls secrets on demand: `op run --env-file .env.tpl -- npm start`.
- Don't ship shared `.env.dev` files on Slack.

## Rotation

For every secret, know:
- Who rotates (automated job, human?).
- How often (14 d? 90 d?).
- How do consumers pick up the new value without downtime?

Rotation patterns:

### Dual-secret window

1. Create secret v2 alongside v1.
2. Consumers accept both.
3. Update producers to use v2.
4. Disable v1 after grace period.

Zero downtime if all consumers support reading both.

### Break-glass

Some secrets (signing keys, root creds) rarely rotate. Document:
- Access procedure (break-glass requires 2-person approval).
- Rotation playbook.
- Who to notify.

## Dynamic secrets

The gold standard. Vault generates short-lived DB credentials on request; they expire in minutes / hours.

```
app → Vault: "give me DB creds for service X"
Vault → DB: CREATE USER temp_xyz WITH GRANT ...
Vault → app: { user: "temp_xyz", pass: "...", ttl: 1h }
# after 1h Vault revokes the user
```

A leaked cred is useless after an hour. Requires upfront setup; worth it for sensitive DBs.

## Pre-commit scanning

Catch secrets before they hit the repo.

- **gitleaks** / **detect-secrets** in pre-commit hook.
- **trufflehog** / **gitleaks** in CI, scanning history.
- If something lands by accident: rotate immediately, don't just `git revert`. History is forever.

```yaml
# pre-commit
- repo: https://github.com/gitleaks/gitleaks
  rev: v8.18.0
  hooks: [{ id: gitleaks }]
```

## Git history cleanup — last resort

If a secret is in the history:
1. **Rotate the secret immediately.** Treat as compromised.
2. Cleaning history (`git filter-repo`, BFG) is partial — anyone with the old clone still has it.
3. Force-push is disruptive; coordinate with team.
4. Document the incident.

Assume: if it was pushed, someone scraped it already.

## Encrypted configs in git (SOPS)

For teams that want encrypted secrets checked into the repo (mostly for smaller teams / K8s manifests):

```
config.yaml:         # SOPS-encrypted at rest
  db:
    url: ENC[AES256_GCM,data:abc123...]
```

SOPS uses a KMS key (AWS KMS, GCP KMS, age) to decrypt at runtime. Team members with access to the KMS key can decrypt.

Rules:
- Encrypt secret fields only (`sops.encrypted_regex: '^(password|token|url)$'`).
- Commit `.sops.yaml` describing the key.
- Revoke KMS key access when a team member leaves.

## Secret sprawl — audit

Once a quarter, audit:
- How many secrets exist?
- Who / what has access to each?
- When was each last rotated?
- Any that are unused (zero accesses in 90 d)?

Cleanup: revoke unused keys. Deleted secrets can't leak.

## Non-secret configs

Not everything is a secret. Feature flags, service endpoints, log levels are config — check them into code (env-specific files), don't put them in the secret manager.

Mixing bloats the secret manager and trains people to ignore the "secret" marker.

## Logging and secrets

- Redact at the logger — don't rely on calls to `log.info(token[:5] + '...')`.
- Structured loggers (Winston, Pino, Zap, slog) support redaction on field names.
- Test: grep logs for known secret prefixes. Zero hits.

## Cloud IAM vs. shared secrets

Prefer IAM / workload identity over shared long-lived API keys.

```
# ❌
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...

# ✅
# Pod assumes a role via IRSA/Workload Identity; temporary creds minted per request.
```

Same for DB access (RDS IAM auth), MQ (IAM policies), object storage. If the cloud supports workload identity, use it.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Secrets in `.env` committed to git | `.gitignore` + secret manager |
| Same API key used by every service | Scope per service |
| Rotating by "reminding the team once a year" | Automate or track with a rotation job |
| Logging tokens for debugging | Redact; use opaque IDs |
| Long-lived cloud API keys in CI | OIDC + short-lived role assumption |
| Shared "admin" DB user per team | Per-user creds (even for humans), audit log |
| Decrypting secrets to an env var only to forget | Let the app read from a file or secret mount |
| Secret "just this one time" pasted in a ticket | Rotate now; use a secure channel (short-lived link) |
| No alerts on secret access from unusual IPs / times | Enable Cloud audit logs + alert |
| Skipping pre-commit scanning "it slows me down" | It saves an incident |
