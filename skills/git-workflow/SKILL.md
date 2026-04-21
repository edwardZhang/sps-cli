---
name: git-workflow
description: Workflow skill — git hygiene beyond commit-message style. Branching, rebasing, conflict resolution, recovering from mistakes. For commit-message format and PR sizing, see `coding-standards/references/commits-and-prs.md`.
origin: original
---

# Git Workflow

Day-to-day git habits for keeping history useful and recovery cheap. For commit message style and PR sizing, load [`coding-standards/references/commits-and-prs.md`](../coding-standards/references/commits-and-prs.md).

## When to load

- Starting a new feature branch
- Reviewing how to structure a series of commits
- Resolving a merge / rebase conflict
- Recovering from a "bad git operation"
- Onboarding to a repo with a specific workflow (trunk-based, GitFlow, etc.)

## The posture

1. **Commits are communication.** The history is read by your future self and your teammates. Make it readable.
2. **Small, logical, atomic commits.** Each commit reverts cleanly. Each commit tells one story.
3. **Rebase your own branch; never shared branches.** History rewriting on public branches breaks everyone.
4. **Never `--force` without `--force-with-lease`.** The safer form checks no one else has pushed.
5. **Lost work is usually recoverable.** `git reflog` remembers.
6. **When in doubt, stash or branch before experimenting.** Cheap insurance.

## Workflow patterns

Pick one per project and stick to it.

### Trunk-based

Short-lived branches, merge to `main` at least daily. Best for CI-strong teams.

```
main ─────────────●──────●──────●──────●──────
                  ↑      ↑      ↑      ↑
                  feature branches, 1–3 days each
```

Pros: minimal merge pain, fast feedback, clear integration point.
Cons: needs strong CI and feature flags to ship incomplete work safely.

### Feature-branch + PR (pragmatic default)

Named branches per feature, merged via PR to `main`. Branches live days to a week.

```
main ─────●────────●────────●─────
           \      /  \      /
            feature1    feature2
```

Most teams. Rebase on `main` before merging to keep history linear.

### GitFlow

`develop`, `release/*`, `hotfix/*` alongside `main`. Heavier; fits products with long support branches.

```
main (release tags)
  │
  ├─ release/* (stabilization)
  │
  └─ develop
       ├─ feature/*
       └─ hotfix/* → main + develop
```

Use when you ship monthly / quarterly and have parallel release support. Overkill for most web apps.

## Branch naming

```
<type>/<short-slug>

feat/partial-shipments
fix/auth-alg-none
chore/bump-node-20
refactor/extract-validator
```

Include a ticket id if your team tracks: `fix/SEC-412-alg-none`.

Rules:
- Lowercase + hyphens.
- No personal names (`alice/wip`); one-off personal branches die without review.
- No `feature/` prefix — type is the prefix, and `feature/` duplicates.

## The commit loop

Good session flow:

1. `git status` before starting — clean? any leftover changes?
2. Make a change; run tests.
3. `git diff` — review before staging.
4. `git add -p` — stage in logical chunks, not everything blindly.
5. `git commit` — one logical change, good message.
6. Repeat.

`-p` (patch) mode is underrated. It lets you split "one big edit" into several commits.

## Rebase your own branch on `main`

Keeps a clean linear history and avoids dirty "Merge main into feature" commits.

```bash
git fetch origin
git rebase origin/main
# resolve conflicts if any
git push --force-with-lease
```

Never rebase a branch others are working on — they'll have conflicts and lose commits.

## Interactive rebase — clean up your history

Before opening a PR:

```bash
git rebase -i origin/main
```

Opens an editor listing your commits. Actions:

| Action | Effect |
|---|---|
| `pick` | Keep as-is |
| `reword` | Change the commit message |
| `edit` | Stop to amend the commit |
| `squash` | Combine with the previous commit; edit message |
| `fixup` | Combine with previous; keep previous message |
| `drop` | Delete |

Use to squash WIP commits, fix typos in messages, reorder logically. Don't use on already-pushed-to-shared branches.

## Handling conflicts

When rebase or merge hits a conflict:

```bash
# git marks conflict files; you edit and resolve
<<<<<<< HEAD
your code
=======
their code
>>>>>>> branch

# After editing:
git add <resolved-files>
git rebase --continue         # or git merge --continue

# To back out:
git rebase --abort
```

Rules:
- **Read both sides.** Don't just pick one wholesale.
- **Ensure tests pass after the resolution.** A bad merge compiles but breaks behaviour.
- **Commit the resolution as is.** Don't mix in other changes.

### `rerere` — reuse recorded resolutions

Turn on once, saves pain on repeated rebases:

```bash
git config --global rerere.enabled true
```

Git remembers how you resolved a given conflict; applies it automatically next time the same conflict appears.

## Force-push safely

Rebasing changes commit SHAs, requiring a force-push. Use `--force-with-lease`:

```bash
git push --force-with-lease
```

`--force` overwrites the remote without checking. If someone else pushed to your branch, you silently overwrite their work. `--force-with-lease` fails safely in that case.

Better alias:

```bash
git config --global alias.pf 'push --force-with-lease'
```

## Recovering lost work

Almost all "lost" git operations are recoverable via `reflog`.

```bash
git reflog                     # list of everything HEAD has pointed to
# HEAD@{0}: rebase: ...
# HEAD@{1}: rebase: ...
# HEAD@{2}: commit: "WIP"
git checkout HEAD@{2}          # go back to the state before you broke it
```

If your last commit was broken and you ran `git reset --hard`:

```bash
git reflog
git reset --hard HEAD@{1}      # restore
```

Works for ~90 days by default. The golden rule: **commit often. Committed work is almost never truly lost.**

## `stash` — quick save

Interrupting to switch branches?

```bash
git stash push -m "WIP: auth refactor"
git switch other-branch

# later
git switch original-branch
git stash pop                  # reapply and remove from stash
# or:
git stash apply stash@{0}       # reapply but keep in stash
git stash list
```

Stash names help when you accumulate several. Don't let stashes pile up — they're not backup.

## Cherry-pick

```bash
git cherry-pick <sha>
```

Copy a commit from another branch. Handy for:
- Backporting a fix to a release branch.
- Salvaging one commit from an abandoned branch.

Avoid using cherry-pick as a regular integration strategy; it creates duplicate work in the history.

## Worktrees — parallel branches

```bash
git worktree add ../myrepo-release release/v2
# work in both directories simultaneously
git worktree remove ../myrepo-release
```

One clone, multiple branches checked out in separate directories. Useful for long-running release branches, bisect, comparison.

## `bisect` — find the commit that broke things

```bash
git bisect start
git bisect bad                  # current is broken
git bisect good v1.2.0          # this tag was fine

# git checks out a commit in the middle; test it
git bisect good                 # or bisect bad
# repeat until git identifies the culprit
git bisect reset
```

`git bisect run ./test.sh` automates it — git runs your script at each step.

## `.gitignore` discipline

Keep it current. Default entries:

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

# IDE / OS
.idea/
.vscode/
*.swp
.DS_Store

# build
dist/
build/
*.pyc
```

If a file was committed by accident, ignoring it doesn't remove it — use `git rm --cached <file>` + commit.

## `.gitattributes` — normalize line endings

Avoid CRLF / LF chaos across Windows + Mac + Linux:

```
* text=auto eol=lf
*.sh text eol=lf
*.bat text eol=crlf
*.png binary
```

Commit it; once everyone has it, cross-OS diffs go quiet.

## Git hooks — local enforcement

- **pre-commit** — run linter / formatter / tests before a commit is allowed.
- **commit-msg** — enforce commit message format.
- **pre-push** — run tests before push.

Use a hook manager (`lefthook`, `husky`, `pre-commit`) so hooks are in the repo, shared with the team.

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    lint: { run: pnpm lint }
    format-check: { run: pnpm format:check }
```

Don't `--no-verify` your hooks. If a hook fails, fix the underlying issue.

## Recovery cheat-sheet

| "I accidentally..." | Fix |
|---|---|
| Committed to wrong branch | `git reset --soft HEAD~1`, switch branches, recommit |
| Deleted a branch | `git reflog` → find SHA → `git branch <name> <sha>` |
| Force-pushed over someone | Coordinate; `git reflog` on their machine can recover |
| Committed a secret | Rotate the secret immediately; history rewrite is secondary |
| Lost uncommitted changes | `git reflog` only helps if committed; stashes via `git stash list` |
| Merged wrong branch | `git reset --hard HEAD~1` (before push), or `git revert` (after push) |
| Detached HEAD | `git branch <newname>` before switching away |

## Forbidden patterns

- `git push --force` (without `--force-with-lease`)
- `--no-verify` to skip hooks because "they're annoying"
- 20+ `WIP` / `fix` commits pushed to main (squash them)
- Long-lived feature branches (weeks+) without merging / rebasing
- Editing `.gitignore` without committing the removals that `.gitignore` was meant to catch
- Rebasing a shared branch
- Committing secrets (even if planning to remove next commit)
- `git add -A` without review
- Keeping personal branches around in the remote for months
- Mixing rename + content change in one commit (hides the rename)

## Pair with

- [`coding-standards/references/commits-and-prs.md`](../coding-standards/references/commits-and-prs.md) — commit messages + PR sizing.
- [`devops/references/ci-cd.md`](../devops/references/ci-cd.md) — branch protection + CI triggers.
