# Commits and Pull Requests

Small commits, small PRs, clear messages. The boring hygiene that pays off during incidents.

## One logical change per commit

A commit should be a coherent unit — reverting it should be safe, and the message should explain *why*.

```
# ✅ good commit progression
1. refactor: extract UserValidator from UserService (no behavior change)
2. test: add failing test for empty-email case
3. fix(user): reject empty email in validator
4. docs: note the new error response in the API doc

# ❌ "WIP", "fix stuff", "address review", "final changes final v2"
```

If you can't describe the commit in one clear sentence, split it.

## Commit messages — Conventional Commits

```
<type>(<scope>): <summary>

<body: why the change, not what>

<footer: tickets, breaking changes, co-authors>
```

### Types

| Type | Use for |
|---|---|
| `feat` | New user-visible feature |
| `fix` | Bug fix |
| `perf` | Performance improvement (behavior unchanged) |
| `refactor` | Code change with no behavior change |
| `docs` | Docs only |
| `test` | Tests only |
| `build` | Build system, deps, tooling |
| `ci` | CI config |
| `chore` | Housekeeping, version bumps |
| `style` | Formatting only |
| `revert` | Reverts a previous commit |

### Example

```
fix(auth): reject tokens with `alg: none`

A crafted JWT with `alg: none` bypassed signature verification on the
/admin endpoints because we used a default-permissive parser. This locks
the accepted algorithm set to HS256 and RS256 and rejects everything else
at parse time.

Refs: SEC-412
Co-Authored-By: Alice <alice@example.com>
```

Rules:
- **Summary line ≤ 72 chars**, imperative mood ("add", not "added").
- **Body wraps at 72**, separated from summary by blank line.
- Explain *why*; the diff already shows *what*.
- Reference tickets / incidents.

## Subject line quick rules

```
✅ feat(orders): support partial shipments
✅ fix(api): return 422 instead of 500 on malformed JSON
✅ perf(search): precompute embedding lookup table

❌ Updated file
❌ More changes
❌ Fix bug
❌ Small tweaks
❌ WIP
```

If you find yourself writing "and" in a commit message, you're committing two things. Split.

## Atomic commits = safe rollbacks

```
git revert <commit>           # cleanly reverses one logical change
```

If one commit touches migrations, feature code, and unrelated formatting, you can't revert safely. Splitting pays off the first time something goes wrong.

## PR size — keep it reviewable

| Diff size | What's reasonable |
|---|---|
| < 100 lines | Normal feature increment |
| 100–400 | Upper bound for typical work |
| 400+ | Only for: rename, generated code, new directory from a template |
| 1000+ | You're hiding a mistake |

Split by:
- Behavior change vs. refactor — separate PRs
- Independent feature pieces — stacked PRs
- Rename / formatting — always its own PR

Reviewers have finite attention. A 2000-line PR gets a rubber stamp, not a review.

## Branching

Pick one and stick to it.

- **Trunk-based** — short-lived branches, merge to main daily. Best for most teams.
- **GitFlow** — `develop` + `release/*` + `hotfix/*`. Heavier; makes sense for shipped products with long support branches.
- **Feature branches + PR to main** — pragmatic middle ground.

Whichever you pick, the rule holds: short-lived branches. Long-lived branches drift and merge pain compounds.

## Branch naming

```
<type>/<short-slug>

feat/partial-shipments
fix/auth-alg-none
chore/bump-node-20
refactor/extract-validator
```

Include a ticket id if your team tracks them: `fix/SEC-412-alg-none`.

## The PR description

A good PR description saves the reviewer 10 minutes.

```markdown
## What
Support partial shipments on orders.

## Why
Warehouse can't always fulfill the full order in one go; today they either
ship late or cancel. Closes ORDERS-187.

## How
- New `Shipment` aggregate, `Order.shipments: []Shipment`
- `POST /orders/:id/shipments` creates one
- Order status derives from shipment state (`partial` if any unshipped items)

## Tests
- Unit: shipment state transitions
- Integration: POST /shipments, GET /orders/:id reflects partial status
- Manual: verified on staging with 2-item order, shipped one item, refunded another

## Rollout
- Feature flag: `partial_shipments_enabled` (default off)
- Migration: adds `shipments` table; safe on empty + large tables (indexed)
- Rollback: disable flag; table can stay
```

If the team has a PR template, use it — even for "obvious" PRs. Reviewer context is never obvious to the reviewer.

## Rebase vs. merge

- **Rebase your feature branch on main** before opening a PR to get a clean linear history.
- **Squash on merge** to main if the PR has noisy intermediate commits; keep it unsquashed if the history is clean and meaningful.
- **Never rebase a branch other people are working on.** Force-push on a shared branch is how you make enemies.

## `.gitignore` — keep secrets and junk out

Default entries for any repo:

```
# dependencies
node_modules/
.venv/
target/

# env / secrets
.env
.env.local
*.pem
*.key

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store
Thumbs.db

# build
dist/
build/
*.pyc
```

Check before the first commit. Once a secret lands in git history, you must rotate it — `git rm` doesn't remove history.

## Commit discipline during review

If review asks for changes, commit the change, don't amend silently. The reviewer needs to see the delta.

```
# ✅
git commit -m "fix(auth): handle empty role list per review"
git push

# ❌
git commit --amend --no-edit
git push --force-with-lease      # reviewer's already-read diff is now lost
```

Squash at merge time if you want a clean final history.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `git add -A` with no check | Review with `git status` / `git diff --staged` first |
| Committing with `--no-verify` to skip hooks | Fix the hook failure; don't bypass |
| Force-push to a shared branch | Rebase your own branch only |
| 5000-line PR "final cleanup" | Split into: rename / format / real change |
| Empty PR description | Write what / why / how, even for small changes |
| "WIP" / "fix" commit messages that ship to main | Squash on merge if they're noise |
| Mixing a dependency bump with a feature | Separate PRs |
| Merging your own PR without review | Team agrees on when this is OK (e.g., docs only) |
