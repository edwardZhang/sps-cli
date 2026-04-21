# Infrastructure-as-Code

Terraform, Pulumi, CDK, CloudFormation. Patterns, not syntax.

## Principles

1. **Code, not console.** Every production resource is declared in code. Console use is for exploration only, not for shipping.
2. **State is sacred.** Losing or corrupting state means reconstructing reality from the cloud. Store it remotely, lock it.
3. **Plan before apply.** `terraform plan` (or equivalent) is a read-only dry run. Diff it; understand it; only then apply.
4. **Modules for reuse, not for abstraction.** A module that no one else uses is just folders. Extract when you have two callers, not before.
5. **Environments as instances of a config.** Same code, different variables. Dev, staging, prod shouldn't fork into three different trees.
6. **Less is more.** The smallest resource set that meets requirements. Every extra resource is an extra blast radius.

## Tool choice

| Tool | Strengths |
|---|---|
| **Terraform / OpenTofu** | Multi-cloud, huge provider ecosystem, mature |
| **Pulumi** | Real programming language; complex logic feels natural |
| **AWS CDK** | AWS-native, TypeScript / Python, feels like SDK |
| **CloudFormation** | AWS-native, declarative, tight integration |
| **Ansible** | Imperative config mgmt (VMs), not declarative infra |
| **Kubernetes manifests / Helm / Kustomize** | K8s-specific |
| **Crossplane / KRO** | K8s-native for cloud infra |

Pick one IaC tool per cloud estate. Using three for one codebase creates state duplication and drift.

## State — remote, locked

Local state on a laptop is a failure mode waiting to happen. Remote backend + locking is non-negotiable for team work.

Terraform remote backends:
- **S3 + DynamoDB** (AWS) — classic, cheap.
- **Terraform Cloud / HCP Terraform** — managed, VCS integration.
- **GCS + lock** (GCP).
- **Azure Storage** (Azure).

Enable:
- Encryption at rest.
- Versioning (so a corrupt state can be rolled back).
- Restricted access (only CI + admins).

## One state file vs. many

Split state when:
- **Blast radius**: a typo in one part shouldn't risk another (separate "network" from "apps").
- **Apply time**: a 40-minute plan is painful; split so changes in one area only plan that area.
- **Permissions**: different teams own different pieces.

Typical split:
```
networking/     — VPCs, subnets, DNS
data/           — databases, caches, queues
platform/       — K8s clusters, service mesh
apps/service-a/
apps/service-b/
```

Cross-state references via remote state data sources:

```hcl
data "terraform_remote_state" "network" {
  backend = "s3"
  config  = { bucket = "...", key = "networking.tfstate", region = "..." }
}

resource "aws_instance" "app" {
  subnet_id = data.terraform_remote_state.network.outputs.subnet_id
}
```

## Modules

Reuse is an effect; don't modularize for the sake of it.

```
modules/
├── s3-bucket/       # simple, focused
├── rds-postgres/    # multiple call sites; worth the abstraction
└── vpc/             # canonical
```

Rules:
- Module inputs: the minimum variables that matter; sensible defaults for the rest.
- Module outputs: only what callers need.
- Version modules (git tag / registry version) if shared across repos.

Anti-pattern: "god module" with 50 inputs covering every hypothetical case. That's configuration disguised as code.

## Workspaces vs. env-specific folders

### Workspaces (Terraform)

Same code, different state per workspace.

```
terraform workspace new dev
terraform workspace new prod
```

OK for dev/prod parity when the topology is truly identical.

### Folder-per-env (often preferred)

```
environments/
├── dev/
│   └── main.tfvars
├── staging/
│   └── main.tfvars
└── prod/
    └── main.tfvars
```

Each env has its own state and vars file. Same underlying modules. Explicit, reviewable, allows env-specific overrides.

## Review flow

Every IaC change is a PR. `terraform plan` output in the PR description or CI comment. Reviewer reads the plan and the code.

Automate it:

```yaml
- run: terraform init
- run: terraform plan -out=plan.tfplan
- run: terraform show -no-color plan.tfplan > plan.txt
- uses: actions/github-script@v7
  with: { script: |
    const plan = fs.readFileSync('plan.txt', 'utf8');
    await github.rest.issues.createComment({ ..., body: '```\n' + plan + '\n```' });
  }
```

Prod apply gated behind approval:

```yaml
environment:
  name: prod
  url: https://...
```

## Drift

State says one thing; reality says another (someone clicked in the console, an external process modified a resource).

- `terraform plan` detects drift.
- Reconcile: revert console changes or adopt them into code.
- Policy: disable console write access for prod; force all changes through IaC.

Drift ignored becomes a permanent parallel state that diverges further every day.

## Secret handling in IaC

- Secrets don't live in `.tfvars` committed to git.
- Pull from secret manager at apply time (`data "aws_secretsmanager_secret_version"`).
- Output sensitive values with `sensitive = true` so they don't leak in logs.
- `.tfstate` itself contains sensitive values — protect the backend.

## Tagging strategy

Every cloud resource gets tags. Makes cost allocation, search, ownership unambiguous.

```hcl
default_tags = {
  environment = var.env
  service     = var.service
  owner_team  = var.team
  managed_by  = "terraform"
  repo        = "github.com/.../infra"
}
```

Enforce via policy (SCPs on AWS, Azure Policy, custom `terraform-compliance`).

## Avoid `count` / `for_each` on resources likely to change order

Terraform tracks resources by address. `aws_instance.web[0]` is not the same as `aws_instance.web[1]`. If you insert into the middle, everything after is "new".

Prefer `for_each` over `count` — keyed by a string, stable under insertion.

```hcl
# ❌ count — fragile if order changes
resource "aws_instance" "web" {
  count = length(var.regions)
  region = var.regions[count.index]
}

# ✅ for_each — keyed
resource "aws_instance" "web" {
  for_each = toset(var.regions)
  region   = each.value
}
```

## Lifecycle rules

```hcl
lifecycle {
  prevent_destroy = true     # guard prod databases, S3 buckets with data
  create_before_destroy = true  # zero-downtime replacement where possible
  ignore_changes = [tags["last_updated"]]  # don't churn on external tag writes
}
```

`prevent_destroy` on anything that would be irrecoverable to delete. Deliberate override needed to actually destroy.

## Blast radius

Running `terraform destroy` in the wrong directory has wiped real infrastructure. Mitigations:
- Separate folders per env with distinct state backends.
- Prod destroy requires a separate pipeline or a specific role.
- Critical resources have `prevent_destroy`.

## Policy as code

Test that the plan adheres to rules before apply.

- **OPA / Conftest** — general-purpose policy, plaintext rules.
- **Terraform Sentinel** (HCP Terraform) — policy as code.
- **Checkov, tfsec, terrascan** — pre-built security rules (public S3 buckets, encryption, etc.).

Typical guards:
- No public S3 buckets.
- No unencrypted RDS / EBS.
- No 0.0.0.0/0 ingress on non-frontend services.
- All resources have required tags.

## Rollback

IaC rollback = revert the commit + apply. It works when the infra change is self-contained.

It does NOT work for:
- Data migrations (schema changes, in-place transformations).
- Resources that were deleted with associated data.
- Stateful upgrades where the backing engine doesn't support downgrade.

For those, plan forward-only fixes.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Local state | Remote + locking |
| No module versioning for shared modules | Tag + version pin |
| Env-specific logic via `if env == "prod"` | Env-specific `.tfvars` / folder |
| Every change runs `apply` without review | PR + plan output |
| Sensitive outputs without `sensitive = true` | Mark them |
| Giant 5000-line main.tf | Split by resource group / module |
| `terraform taint` as a regular workflow | Fix the root cause; taint is a hack |
| `null_resource` + `local-exec` for everything | Find a proper provider |
| Hand-written policies enforced by discipline | Automate with OPA / tfsec |
| Cloud console changes that "just need to happen" | Update IaC; revert the console |
