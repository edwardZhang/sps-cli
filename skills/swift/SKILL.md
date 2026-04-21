---
name: swift
description: Swift language skill — value types, optionals, async/await, testing. Primarily iOS / macOS / server-side Swift. Pair with `mobile` end skill and `coding-standards` for cross-language principles.
origin: original
---

# Swift

Value types, optionals, async/await, actors. Strong type system, ARC memory management.

## When to load

- Project is iOS / macOS / watchOS / tvOS / visionOS
- Server-side Swift (Vapor, Hummingbird)
- Swift Package Manager projects
- Interop with Objective-C or C

## Core principles

1. **Value types first.** `struct` and `enum` — safe by default, no shared mutation.
2. **Optionals are types, not null.** Unwrap with `if let`, `guard let`, `??`. Never `!` outside IBOutlets / truly-impossible cases.
3. **`let` by default, `var` only when mutating.**
4. **Throwing functions for expected failure.** `Result` for async results where throws is awkward.
5. **`async/await` for asynchronous code.** No raw callbacks in new code.
6. **Actors for mutable shared state across concurrent code.** Not `DispatchQueue.sync`.
7. **Protocols + extensions** for composable behaviour.
8. **Strong typing over stringly-typed APIs.** Enums with associated values beat dictionaries of magic keys.

## How to use references

| Reference | When to load |
|---|---|
| [`references/idioms.md`](references/idioms.md) | Value types, optionals, protocols, closures, `guard`, pattern matching |
| [`references/concurrency.md`](references/concurrency.md) | `async/await`, `Task`, actors, `@MainActor`, cancellation, `AsyncSequence` |
| [`references/testing.md`](references/testing.md) | XCTest, Swift Testing (Swift 6+), async tests, UI tests |

## Forbidden patterns (auto-reject)

- `!` force-unwrap except for IBOutlets or documented invariants
- `as!` force-cast without a test that proves the type is guaranteed
- `fatalError` outside of truly-unreachable code (use `preconditionFailure` + message at minimum)
- `DispatchQueue.main.sync` from a background queue (deadlock risk)
- `DispatchSemaphore` to bridge sync/async in production — use `await`
- Shared mutable state without an actor or a serial queue
- `Any` / `AnyObject` as an API type when concrete types would work
- String-matching on error messages
- Force unwrapping `try!` outside tests
- `print` for production logging (use `Logger` / `os_log`)
