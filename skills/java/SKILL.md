---
name: java
description: Java language skill — modern idioms (17+/21 LTS), records, streams, concurrency, testing. Pair with `backend` / `mobile` end skills and `coding-standards` for cross-language principles.
origin: original
---

# Java

Modern Java (17 LTS / 21 LTS+). Records, sealed types, switch patterns, virtual threads. **Language-focused**.

## When to load

- Project primary language is Java 17+ (LTS) or 21+ (virtual threads)
- Reviewing Java code
- Backend services (Spring Boot, Quarkus, Helidon, Micronaut)
- Android (where Kotlin isn't used)
- JVM interop with Kotlin / Scala

## Core principles

1. **Records for data.** Replace `@Data` Lombok classes and hand-written POJOs.
2. **Sealed types + pattern switch for sum types.** Replace visitor pattern and `instanceof` chains.
3. **`var` for locals only.** Never in method signatures / fields.
4. **`Optional<T>` for return values, never for fields or parameters.**
5. **Virtual threads (21+) for I/O-bound concurrency.** Replace manual thread pools and reactive chains where they exist only for thread efficiency.
6. **Unmodifiable collections by default.** `List.of(...)`, `Map.of(...)`, `Collectors.toUnmodifiableList()`.
7. **Checked exceptions for recoverable failures in libraries; runtime exceptions for programmer errors.** Don't catch-and-rethrow just to convert one kind.
8. **`NullPointerException` is a bug.** Don't normalize it with defensive `null` checks everywhere; design so the type system documents nullability.

## How to use references

| Reference | When to load |
|---|---|
| [`references/idioms.md`](references/idioms.md) | Records, sealed types, streams, `Optional`, collections, `var` |
| [`references/concurrency.md`](references/concurrency.md) | Virtual threads, `CompletableFuture`, `ExecutorService`, structured concurrency (preview) |
| [`references/testing.md`](references/testing.md) | JUnit 5, AssertJ, Mockito, Testcontainers |

## Forbidden patterns (auto-reject)

- Raw types (`List` without `<T>`)
- `Vector`, `Hashtable`, `Stack` (legacy, synchronized) — use modern collections
- `new Integer(...)` etc. — use `Integer.valueOf(...)`
- `null` return where `Optional<T>` would be expressive
- Catching `Exception` / `Throwable` broadly without re-throw
- `String.format` for log messages — use parameterized SLF4J (`logger.info("x={}", x)`)
- Mutable static fields for business data
- `Thread.sleep` in request handlers
- `checkedException.wrap(RuntimeException)` without cause chain
- Anonymous inner classes where a lambda works
- `Date` / `Calendar` / `SimpleDateFormat` — use `java.time.*` (since Java 8!)
