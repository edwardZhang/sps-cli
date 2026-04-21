# TDD — Test-Driven Development

The cycle that keeps behavior ahead of implementation. Language-neutral.

## The cycle

1. **RED** — write the smallest failing test for the next bit of behavior.
2. **GREEN** — write the minimum code that makes it pass. Ugly is fine.
3. **REFACTOR** — clean up while keeping all tests green.

Repeat. Each loop should take minutes, not hours.

```
┌─────────┐     ┌──────────┐     ┌──────────┐
│  RED    │────▶│  GREEN   │────▶│ REFACTOR │──┐
│ (fail)  │     │ (pass)   │     │ (still   │  │
└─────────┘     └──────────┘     │  pass)   │  │
     ▲                           └──────────┘  │
     └─────────────────────────────────────────┘
```

## Why bother

- **You write less code.** You only write what a test demands.
- **You design the interface first.** Tests force you to use your API before anyone else does.
- **Regressions get names.** Every bug fix starts with a failing test that reproduces it.
- **Coverage is real.** Not a number chased after the fact.

TDD isn't about testing. It's about designing by answering "how would I use this?" before you build it.

## When TDD shines

- New business logic with clear inputs/outputs
- Fixing a bug (always: reproduce with a test first, then fix)
- Pure functions, state machines, parsers
- Rules-heavy code (pricing, validation, authz)

## When TDD is awkward

- UI polish (use snapshot / visual tests instead)
- Exploratory spikes (throw the code away; tests would be premature)
- Integration against an unknown third-party API (explore, then test)
- Glue code with no logic (one thin integration test is enough)

Awkward ≠ exempt. You still verify. You just choose the right tool.

## Writing the first test

Think: what's the smallest visible behavior?

```
# Feature: "sum two numbers"

# RED (smallest failing test)
assert add(2, 3) == 5

# GREEN (smallest passing code)
def add(a, b):
    return a + b

# Now push the next edge case
assert add(-1, 1) == 0        # pass already — good
assert add(0.1, 0.2) == 0.3   # FAILS (float math) — now you've learned something real
```

If the first test passes without you writing code, either the feature exists, the test is vacuous, or you're testing the wrong thing. Stop and rethink.

## One assertion per behavior, not per test

A single test can have several assertions if they verify the same behavior from different angles:

```
# OK — all verifying "create returns a persisted user"
u = service.create(name="A", email="a@x.com")
assert u.id is not None
assert u.name == "A"
assert u.email == "a@x.com"
assert db.find(u.id) == u
```

Not OK:

```
# Two behaviors in one test
u = service.create(...)
assert u.id is not None          # behavior 1: create
service.delete(u.id)
assert db.find(u.id) is None     # behavior 2: delete  ← split
```

One test fails → one problem. Mixing behaviors makes failures ambiguous.

## Reproducing a bug

Every bug fix starts with a test that fails *because of the bug*.

```
# 1. Write the failing test (RED)
def test_negative_balance_rejected():
    with pytest.raises(ValidationError):
        account.withdraw(999_999)

# 2. Fix the code (GREEN)

# 3. Commit both in the same change
```

Without the test, the bug can silently come back. With it, the regression is guaranteed to be caught.

## What a good test looks like

| Property | Why |
|---|---|
| **Fast** | You run it often; slow tests get skipped |
| **Isolated** | No order dependency; no shared mutable state |
| **Repeatable** | Same result every run; no flakes |
| **Self-verifying** | Pass/fail is automatic, not a human reading output |
| **Named for behavior** | `test_rejects_empty_email`, not `test_1` |

Flaky tests are worse than missing tests — they train you to ignore red.

## Test pyramid

```
            ▲
            │      E2E              ← few, slow, high-value
            │    (5%)
            │  Integration          ← some, medium speed
            │    (20%)
            │  Unit                 ← many, fast
            │    (75%)
            ▼
```

Invert this (lots of E2E, no unit) and you get slow CI, brittle tests, and bugs that hide in the unit level. Unit tests are the backbone; E2E is the sanity check.

## Refactor only on green

Rule: never refactor with failing tests. You won't know whether the refactor broke something or the test was already broken.

Steps:
1. Get to green.
2. Commit.
3. Refactor.
4. Stay green.
5. Commit.

Small commits. Rollback is free.

## Coverage targets (sane defaults)

| Layer | Target |
|---|---|
| Pure / domain logic | ≥ 90% |
| Application / use cases | ≥ 80% |
| Adapters (DB, HTTP) | ≥ 60%; integration tests carry the rest |
| Glue (bootstrap, composition) | ≥ 0% — don't chase coverage here |

Coverage is a floor, not a ceiling. 100% coverage with weak assertions is still untested code.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Writing tests after the code "to hit coverage" | That's not TDD; and coverage isn't the goal |
| One mega-test per feature | Split by behavior |
| Testing mocks (the mock returns X, assert it returned X) | Test the thing, or delete the test |
| Asserting on implementation detail (private method called) | Assert on observable behavior |
| Tests that sleep to wait for async | Use deterministic scheduling / fake clocks |
| Disabling a failing test to unblock CI | Fix it or delete it. Disabled tests lie. |
| Fixture soup — hundreds of lines to set up a test | Your system is hard to use; that's the signal, not the fixture |
