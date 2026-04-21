---
name: golang
description: Go language skill — idioms, errors, concurrency, testing. Pair with end skills (`backend`, `devops`) for architecture and with `coding-standards` for cross-language principles.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Go

Go is small on purpose. Few idioms, clear conventions, one canonical way to do most things. Fight the language less, follow its grain more.

## When to load

- Project primary language is Go
- Reviewing Go code
- Designing packages, interfaces, error types
- Concurrency with goroutines, channels, `context.Context`

## Core principles

1. **Clear over clever.** Short functions, short files, short package names.
2. **Return errors; never panic at API boundaries.** Panics are for unrecoverable bugs, not flow control.
3. **Accept interfaces, return structs.** The caller owns the abstraction.
4. **Interfaces live at the call site** (consumer-defined). Don't define an interface until you have two implementations or a test double.
5. **`context.Context` as the first parameter** on anything that does I/O or can be cancelled.
6. **Goroutines need a lifecycle.** Every `go f()` needs a story: how it stops, who waits, what happens on error.
7. **No hidden control flow.** No macros, no implicit constructors, no `this`. If it runs, it's in the code you see.
8. **Format with `gofmt`.** Style is not a discussion.

## How to use references

| Reference | When to load |
|---|---|
| [`references/idioms.md`](references/idioms.md) | Package layout, naming, zero values, struct embedding, slices vs. arrays |
| [`references/errors.md`](references/errors.md) | `error` interface, wrapping (`%w`), `errors.Is/As`, sentinel vs. typed errors |
| [`references/concurrency.md`](references/concurrency.md) | Goroutines, channels, `sync`, `context.Context`, cancellation, `errgroup` |
| [`references/testing.md`](references/testing.md) | `testing` package, table-driven tests, `t.Run`, `testify`, fuzzing, benchmarks |

## Forbidden patterns (auto-reject)

- `panic` outside of `init()` or truly unrecoverable state
- Ignoring errors with `_`, except in narrow documented cases
- Goroutines without a cancellation path / termination contract
- Blocking operations without `context.Context`
- Interface defined in the package that provides the implementation (should live at call site)
- `init()` doing I/O or mutating globals
- Returning named result parameters just to "save" a `return` statement
- Global mutable state for business data (singletons, package-level vars)
- Allocating in a hot loop when `sync.Pool` or preallocation would fix it
- Using `interface{}` / `any` when a concrete type is known
