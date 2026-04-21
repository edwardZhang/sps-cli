---
name: kotlin
description: Kotlin language skill — idioms, null safety, coroutines, testing. Covers JVM backend and Android. Pair with `backend` / `mobile` end skills and `coding-standards` for cross-language principles.
origin: original
---

# Kotlin

Null safety, coroutines, expressive stdlib. Used for JVM backend (Ktor, Spring) and Android. **Language-focused**.

## When to load

- Project primary language is Kotlin (JVM / Android / Multiplatform)
- Reviewing Kotlin code
- Coroutines / Flow / async design
- Interop with Java (calling Java APIs, exposing Kotlin to Java)

## Core principles

1. **Nullability in the type system.** `String?` and `String` are different types; a `NullPointerException` in pure Kotlin code is almost always a mistake.
2. **`val` by default, `var` only when mutation is required.**
3. **Data classes for value objects.** `copy`, `equals`, `hashCode`, `toString` for free.
4. **Prefer expressions over statements.** `if`, `when`, `try` all return values.
5. **Sealed hierarchies over type codes.** Use `sealed class` / `sealed interface` + `when` with exhaustiveness.
6. **Coroutines for async.** Never `Thread.sleep` or `.get()` on a `Future` in a coroutine.
7. **No Java collections when Kotlin collections exist.** `List<T>` (Kotlin) is read-only; `MutableList<T>` is mutable.
8. **`let` / `run` / `apply` / `also` / `with` — know the difference, don't chain all five.**

## How to use references

| Reference | When to load |
|---|---|
| [`references/idioms.md`](references/idioms.md) | Data classes, sealed classes, scope functions, extension fns, null safety |
| [`references/coroutines.md`](references/coroutines.md) | `suspend`, `CoroutineScope`, structured concurrency, `Flow`, dispatchers |
| [`references/testing.md`](references/testing.md) | JUnit 5, Kotest, MockK, turbine for Flow |

## Forbidden patterns (auto-reject)

- `!!` (force-unwrap) without a comment justifying it's definitely non-null
- `lateinit var` for anything that isn't initialized by a framework (DI, test setup)
- `runBlocking` in library or backend request-path code
- `GlobalScope` — always use a structured `CoroutineScope`
- `Thread.sleep` inside a `suspend` function
- `println` for logging in production code
- Returning Kotlin `List<T>` from an API that Java callers will treat as mutable (or vice versa)
- `Object` singletons holding mutable state
- `runCatching { }.getOrNull()` swallowing errors silently
