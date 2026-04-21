---
name: coding-standards
description: Cross-language engineering principles — TDD, naming, error strategy, code review, commits/PRs, clean code. Load alongside any language / end skill. Principles only; language-specific syntax lives in the language skill.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Coding Standards

Language- and stack-neutral engineering principles. Covers the "what" and "why"; language skills cover the "how".

## When to load

- Any coding task (load this + a language skill + an end skill)
- Code review
- Writing tests
- Opening a PR
- Deciding where error handling / retries / logging live

## Hierarchy of rules

1. **Correctness** — the code does what's intended
2. **Readability** — the next person (or you, six months later) can follow it
3. **Testability** — behavior is verifiable without the universe
4. **Simplicity** — least code and least abstraction that meet 1–3
5. **Performance** — only after 1–4 are met

In that order. A fast bug is worse than a slow correct answer.

## Core commitments

- **Tests first** for anything non-trivial. Write a failing test, make it pass, refactor.
- **Specific exceptions only.** Never `except:` bare. Never swallow without logging.
- **Name things for intent, not implementation.** `users_over_18` > `filtered_list_2`.
- **Small functions that do one thing.** If you can't say what it does in one sentence, split it.
- **No comments that restate the code.** Comments explain the *why*, never the *what*.
- **No speculative abstractions.** Two similar snippets: duplicate. Three: consider abstracting.
- **PRs under 400 lines of diff.** Anything larger, split.

## How to use references

| Reference | When to load |
|---|---|
| [`references/tdd.md`](references/tdd.md) | Starting a feature, writing tests, unclear what "done" means |
| [`references/naming.md`](references/naming.md) | Naming a function, variable, module, endpoint, feature flag |
| [`references/error-strategy.md`](references/error-strategy.md) | Deciding whether to raise, return a result, log, or swallow |
| [`references/code-review.md`](references/code-review.md) | Reviewing a PR (yours or someone else's) |
| [`references/commits-and-prs.md`](references/commits-and-prs.md) | Writing a commit message; opening / sizing a PR |
| [`references/clean-code.md`](references/clean-code.md) | Function shape, DRY vs WET, comments, dead code, magic numbers |

## Forbidden patterns (auto-reject)

- Commented-out code committed to main
- `TODO` without an owner or date
- Tests that don't actually assert anything
- Mutable global state for business logic
- Dead code kept "just in case"
- Magic numbers / strings without named constants
- Catch-all error handlers without re-raise or specific recovery
- Abstractions that have exactly one implementation
- PRs that mix a refactor with a feature change
