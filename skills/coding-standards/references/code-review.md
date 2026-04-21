# Code Review

How to review. How to be reviewed. A checklist that works regardless of language.

## What review is for

In order of importance:

1. **Catching defects** — correctness bugs, security issues, data loss paths
2. **Sharing knowledge** — both directions; reviewer learns too
3. **Maintaining consistency** — convention drift, naming, layering
4. **Coaching** — especially for junior → senior flow
5. **Rubber-stamping** — never the goal, though sometimes the outcome

Review is NOT:
- A style argument you could have automated (use a formatter)
- A place to re-litigate architecture decisions already made
- An opportunity to impose personal preferences as requirements

## Reviewer checklist

Go through in this order. Don't start with nits.

### 1. Understand the change

- What problem does this solve? (Read the PR description; if it's empty, push back.)
- Is this the right fix, or is it treating a symptom?
- Is there a simpler approach that also works?

### 2. Correctness

- Does it handle the happy path?
- What about the edges: empty inputs, duplicates, concurrency, partial failures?
- What happens on error? Is the error propagation / handling at the right layer?
- Are there new race conditions? Deadlocks? Order-of-operations assumptions?

### 3. Security

- Any user input that isn't validated at the boundary?
- Any SQL / command / template construction from strings?
- Any auth/authz check missing? Any leak of existence / enumeration?
- Any new secret / credential in code or config?

### 4. Tests

- Is there a test for the change? (No test on non-trivial change = push back.)
- Does the test actually fail without the fix? (Reviewer can mentally check this.)
- Are edge cases tested, not just happy path?
- Any flaky patterns: sleeps, network calls, order dependencies?

### 5. Data and migrations

- Schema change: is it backward compatible with the running code during deploy?
- Backfill strategy: safe on large tables? rate-limited?
- Is this reversible? If not, is the forward-only plan documented?

### 6. Observability

- Does the new code log errors with enough context (request id, user id)?
- Are new metrics / dashboards needed? Alerts?
- Can an oncall diagnose a failure from what's logged?

### 7. Layering & design

- Does business logic stay out of adapters? Do adapters stay out of the domain?
- Any new leakage: framework types into domain, DB rows into API responses?
- Any abstraction that has exactly one implementation? (Likely premature.)

### 8. Style (last)

- Formatter run? Linter clean?
- Names clear?
- Any comments that should be removed / added?

If the formatter and linter disagree with the code, the PR shouldn't have reached human review.

## How to comment

Use a small vocabulary so the author knows what's blocking.

| Prefix | Meaning | Action |
|---|---|---|
| `Blocker:` | Must fix before merge | Don't approve |
| `Question:` | I don't understand; please explain | Ask |
| `Suggestion:` | Consider, non-blocking | Approve anyway |
| `Nit:` | Style / taste, truly optional | Approve |
| `Praise:` | This is good; say it | Approve (and mean it) |

If you only leave `Nit:` and `Suggestion:`, approve. Don't hold up a PR for taste.

## Good comments

```
Blocker: This will 500 when `user.roles` is empty (line 43 assumes at least one).
Can you add a test with an empty roles list?

Suggestion: Pull this 3-line parse block into a helper — it's duplicated in
handlers/orders.py too.

Question: Why are we retrying on 401? That looks like the credential is wrong,
not transient.

Nit: `usr` → `user`.
```

## Bad comments

```
"This is weird."                          ← not actionable
"Why would you do it this way?"           ← confrontational; say what you'd prefer
"I would have done X."                    ← if X is better, ask for X; otherwise irrelevant
"FYI, there's a library for this."        ← link, justify, or drop it
Long digressions about architecture       ← file a separate issue
```

## Reviewing size

| Diff size | Typical quality of review |
|---|---|
| < 100 lines | Thorough |
| 100–400 | Careful |
| 400–1000 | Skimmed; defects slip |
| > 1000 | Rubber stamp |

If the PR is > 400 lines and not refactor-only (e.g., rename), ask the author to split. Reviewers can't do their job on huge diffs.

## Review speed

- Aim to first-respond within one working day.
- Incremental responses are fine: "looking at it now, initial thoughts below".
- Blocking a PR for days with no reason is a failure mode.

## Being reviewed

Make the reviewer's job easy.

### The PR description

```
## What
One-line summary of the change.

## Why
Link to ticket / incident. Business / technical reason.

## How
Brief description of the approach and why this approach.

## Tests
What was added / run locally. Any manual verification.

## Risks / rollout
Feature flag? Migration? Rollback plan?
```

### Split your PRs

- **Refactor** (no behavior change) and **feature** (behavior change) in separate PRs.
- **Rename** PRs are mechanical — reviewer should only need to confirm "nothing else changed".
- **Dependency bumps** separate from feature work.

### Respond to all comments

- `Fixed.` (with the follow-up commit ref)
- `Good catch, added a test for that too.`
- `I see it differently — <reason>. Want to discuss on a call?`

Don't leave comments unanswered. "Ignored" on a review is how reviewers stop reviewing carefully.

### Don't take it personally

Code is being reviewed, not you. "This is wrong" is about the line, not your worth. If a comment does feel personal, ask the reviewer offline — don't escalate in the PR.

## Approving

- **Approve** when you'd be comfortable being paged at 3am because of this code.
- **Request changes** when there are blockers.
- **Comment** (neither approve nor block) when you've given feedback but someone more authoritative should approve.

Don't approve-and-block ("LGTM but…"). Decide.

## Anti-patterns

| Anti-pattern | Why |
|---|---|
| Review-bombing with 50 nits | Exhausts the author; misses the real issue |
| Approving without reading | Wastes the review; defects sneak through |
| Re-litigating the design at review time | Should have been a design doc earlier |
| "Can you just rewrite this?" | If true, say specifically why; offer an example |
| Ignoring your own review comments later | Inconsistent; erodes trust |
| Big PR → "looks good" after 5 min | Not an actual review |
| Review as gate without shared standards | Reviewer's mood decides the outcome |
