---
name: rust
description: Rust language skill — ownership, traits, errors, async, testing. Pair with end skills (`backend`, `devops`) and with `coding-standards` for cross-language principles.
origin: original
---

# Rust

Ownership, lifetimes, traits, errors, async. **Language-focused**. Architecture → end skills. General principles (TDD, naming, error strategy) → `coding-standards`.

## When to load

- Project primary language is Rust
- Reviewing Rust code
- Designing types, traits, error hierarchies
- Async with `tokio` / `async-std`

## Core principles

1. **Make invalid states unrepresentable.** Use the type system — enums, newtypes, bounds — before runtime checks.
2. **`Result` for expected failure, `panic!` only for bugs / invariant violations.**
3. **Prefer owned types at API boundaries; `&str` / `&[T]` inside.** Callers decide the allocation policy.
4. **Small traits, defined at the call site.** Don't pre-abstract.
5. **`#[must_use]` on types that ignore-means-bug** (`Result`, builders, guards).
6. **No `unwrap()` / `expect()` outside tests and `main`.** The compiler enforces error handling; don't opt out.
7. **`clippy::pedantic` in CI.** Treat warnings as errors.
8. **`cargo fmt` and `cargo clippy` — never argue style.**

## How to use references

| Reference | When to load |
|---|---|
| [`references/ownership.md`](references/ownership.md) | Borrowing, lifetimes, move vs. copy, `Rc`/`Arc`, interior mutability |
| [`references/errors.md`](references/errors.md) | `Result`, `?`, `thiserror`, `anyhow`, error enums, chaining |
| [`references/traits.md`](references/traits.md) | Traits, generics, `impl Trait`, associated types, trait objects |
| [`references/async.md`](references/async.md) | `async fn`, futures, `tokio`, cancellation, `select!`, pinning |
| [`references/testing.md`](references/testing.md) | `#[test]`, integration tests, `cargo test`, property testing |

## Forbidden patterns (auto-reject)

- `unwrap()` / `expect()` in non-test, non-`main` code without a comment explaining why it's unreachable
- `panic!` as control flow
- `unsafe` without a `// SAFETY:` comment listing every invariant the caller must uphold
- `.clone()` in a hot loop when a borrow would suffice
- `Rc<RefCell<T>>` without a thread-sharing story (single-threaded only; use `Arc<Mutex<T>>` if it crosses threads)
- Blocking calls inside an `async fn` (`std::thread::sleep`, `std::fs::*` in tokio)
- `#[allow(clippy::...)]` without a nearby comment justifying it
- Overlarge error enums (40+ variants); split by module
- Returning `Vec<String>` from a parse when `&str` views into the input would work
- Ignoring `#[must_use]` on `Result` (compiler warns; treat as error)
